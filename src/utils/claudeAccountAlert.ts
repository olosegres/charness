/**
 * @description The operator's alert about the Claude accounts (`utils/claudeAuthRefusal.ts`): an account that stopped being
 * usable because of its sign-in — signed out by its status check, or refused by the CLI on a turn (signed out, a login
 * expired or revoked, its organization turned Claude subscription use off, a bare 401 / 403) — and the moment no account
 * is usable at all, told ONCE per change: what broke (which account, the CLI's own words), what the bot did (the
 * conversations moved to another account, or they wait) and what the operator must do (sign it in again, and how). An
 * account that is usable again gets one line. The bot posts it in General (Telegram) and on the Jira operator issue
 * (`connectors/jira/operatorIssue.ts`). An account that is SIGNED OUT is also told to the operator in a private message of its
 * own with a button that starts its sign-in ({@link listClaudeAccountSignOutNames}, {@link renderClaudeAccountSignOutDm}): General is
 * muted for the operator, a private message is not.
 *
 * What was told is kept in `state.json` (`claudeAccountAlerts`), so a restart — hot mode restarts on every code change — never
 * tells it again. An account seen for the first time is told only when it matters: refused on a turn, or the account new
 * conversations start on (General's pick, else `default`); a folder adopted before its sign-in finished is not. An account usable
 * again only because a status check ended its bare 401 / 403 refusal had no sign-in: it leaves the told accounts quietly, with no
 * «signed in again» (a repeat of that refusal is held until a new login, `utils/claudeAuthRefusal.ts`).
 *
 * Pure: the bot passes the states, the details and the account new conversations go to; the texts come from the active
 * locale (`accounts.alert.*`, `accounts.refusal.*`) and name each account by its display name (`utils/claudeProfileLabels.ts`) — the
 * record and the button keep its id.
 */

import { t } from '../i18n';
import { buildAccountSignInCallback } from './claudeAccountPickerPlan';
import { getClaudeProfileLabel } from './claudeProfileLabels';
import type { ClaudeProfileUsability } from './claudeAuthRefusal';

/** What the operator was told of the accounts, as `state.json` keeps it. */
export interface ClaudeAccountAlertState {
  /** Every account's state as last seen (an account gone from the profiles is dropped). */
  known: Record<string, ClaudeProfileUsability>;
  /** The accounts the operator was told cannot work, until one is usable again. */
  alerted: string[];
  /** The pinned alert in General, unpinned once no told account is left unusable; absent = none pinned. */
  pinnedMessageId?: number;
  /**
   * The private sign-out message of each told account that has one (its id in the operator's private chat), until the account is usable
   * again and the message is turned into «signed in again» — see {@link ClaudeAccountAlert.backMessageIds}; absent = none kept.
   */
  signOutMessageIds?: Record<string, number>;
}

/** One account that stopped being usable: its state and the CLI's own words of the refusal (`null` for a status check). */
export interface ClaudeAccountLoss {
  name: string;
  usability: Exclude<ClaudeProfileUsability, 'usable'>;
  detail: string | null;
}

/** What one change of the accounts tells the operator. */
export interface ClaudeAccountAlert {
  lost: ClaudeAccountLoss[];
  /** Told accounts usable again. */
  back: string[];
  /** Where conversations go now (a new one, or one leaving a lost account); `null` = no account is usable. */
  instead: string | null;
  /**
   * The private sign-out message (its id) of each account in {@link back} that had one: the bot turns it into «signed in again» and
   * drops its button. Absent = none.
   */
  backMessageIds?: Record<string, number>;
}

/**
 * @description The alert of this round (`null` = nothing to tell) and the state to keep. `current` is every account's state now,
 * `details` the CLI's words of a refusal by account, `defaultProfile` the account new conversations start on, `instead` where they
 * go now. A lost account: usable before and not now — or, seen for the first time, refused on a turn or `defaultProfile`. An account
 * that is not usable stays told until it is usable again; a change from one unusable state to another tells nothing new. A told
 * account usable again gets its line — unless it is in `backByStatusCheck` (no sign-in happened): then it only leaves the told ones.
 */
export function planClaudeAccountAlert(input: {
  previous: ClaudeAccountAlertState | undefined;
  current: ReadonlyMap<string, ClaudeProfileUsability>;
  details: ReadonlyMap<string, string>;
  defaultProfile: string;
  instead: string | null;
  backByStatusCheck?: ReadonlySet<string>;
}): { alert: ClaudeAccountAlert | null; next: ClaudeAccountAlertState } {
  const previousKnown = input.previous?.known ?? {};
  const previousMessageIds = input.previous?.signOutMessageIds ?? {};
  const alerted = new Set((input.previous?.alerted ?? []).filter((name) => input.current.has(name)));
  const lost: ClaudeAccountLoss[] = [];
  const back: string[] = [];
  for (const [name, usability] of input.current) {
    const before = Object.hasOwn(previousKnown, name) ? previousKnown[name] : undefined;
    if (usability === 'usable') {
      if (alerted.delete(name) && input.backByStatusCheck?.has(name) !== true) back.push(name);
      continue;
    }
    if (alerted.has(name)) continue;
    const isFirstSight = before === undefined;
    const isRefusedOnTurn = usability !== 'notSignedIn';
    if (before === 'usable' || (isFirstSight && (isRefusedOnTurn || name === input.defaultProfile))) {
      lost.push({ name, usability, detail: input.details.get(name) ?? null });
      alerted.add(name);
    }
  }
  // A private message is kept while its account stays told; one whose account is usable again goes to the alert, to be turned into «signed in again».
  const keptMessageIds = Object.fromEntries(Object.entries(previousMessageIds).filter(([name]) => alerted.has(name)));
  const backMessageIds = Object.fromEntries(back.flatMap((name) => (Object.hasOwn(previousMessageIds, name) ? [[name, previousMessageIds[name]]] : [])));
  const next: ClaudeAccountAlertState = {
    known: Object.fromEntries(input.current),
    alerted: [...alerted],
    ...(input.previous?.pinnedMessageId !== undefined ? { pinnedMessageId: input.previous.pinnedMessageId } : {}),
    ...(Object.keys(keptMessageIds).length > 0 ? { signOutMessageIds: keptMessageIds } : {}),
  };
  const alert = lost.length === 0 && back.length === 0
    ? null
    : { lost, back, instead: input.instead, ...(Object.keys(backMessageIds).length > 0 ? { backMessageIds } : {}) };
  return { alert, next };
}

/** How long the CLI's words of a refusal may be in an alert: one line, the start of it. */
export const claudeAccountAlertDetailMaxChars = 200;

/** @description The CLI's words of a refusal as an alert quotes them: one line, at most {@link claudeAccountAlertDetailMaxChars}. */
export function getClaudeAccountAlertDetail(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= claudeAccountAlertDetailMaxChars ? line : `${line.slice(0, claudeAccountAlertDetailMaxChars - 1)}…`;
}

/** @description Why an account cannot work, as a clause after its name (`is signed out: its sign-in expired or was revoked`). */
export function formatClaudeAccountRefusal(usability: Exclude<ClaudeProfileUsability, 'usable'>): string {
  return t(`accounts.refusal.${usability}`);
}

/**
 * @description The alert in the active locale. `getSignInHow` says how to sign an account in (given its id) where this text is read
 * (`/accounts login Work` — its display name — in Telegram, `CLAUDE_CONFIG_DIR=… claude auth login` on the host). A lost account gets its sentence,
 * the CLI's words when there are any and what to do; then one line on where the conversations went — and, when
 * `options.closedPrivateChatBot` names the bot (the operator's private chat refused the private message about a signed-out account:
 * they never opened it), one line asking them to open a private chat with it and press Start; an account usable again one line.
 */
export function renderClaudeAccountAlert(
  alert: ClaudeAccountAlert,
  getSignInHow: (name: string) => string,
  options: { closedPrivateChatBot?: string } = {},
): string {
  const paragraphs: string[] = [];
  for (const loss of alert.lost) {
    const lines = [t('accounts.alert.title', { name: getClaudeProfileLabel(loss.name), reason: formatClaudeAccountRefusal(loss.usability) })];
    if (loss.detail !== null) lines.push(t('accounts.alert.cliSaid', { detail: loss.detail }));
    const how = getSignInHow(loss.name);
    lines.push(loss.usability === 'orgDisabled' ? t('accounts.alert.fixOrg', { how }) : t('accounts.alert.fixSignIn', { how }));
    paragraphs.push(lines.join('\n'));
  }
  if (alert.lost.length > 0) {
    paragraphs.push(alert.instead === null ? t('accounts.alert.noneUsable') : t('accounts.alert.movedTo', { to: getClaudeProfileLabel(alert.instead) }));
  }
  if (options.closedPrivateChatBot !== undefined && listClaudeAccountSignOutNames(alert).length > 0) {
    paragraphs.push(t('accounts.alert.openPrivateChat', { bot: options.closedPrivateChatBot }));
  }
  for (const name of alert.back) paragraphs.push(t('accounts.alert.back', { name: getClaudeProfileLabel(name) }));
  return paragraphs.join('\n\n');
}

/**
 * @description The accounts of this alert that are SIGNED OUT (`signedOut`: the CLI refused its login on a turn; `notSignedIn`: its status
 * check finds none) — the ones the operator also gets a private message about, once per sign-out: the alert itself is told once per
 * change ({@link planClaudeAccountAlert}), so this list is as well. A refusal a sign-in does not mend (`orgDisabled`: its organization
 * turned the use off) and a bare 401 / 403 (`rejected`) stay in General only.
 */
export function listClaudeAccountSignOutNames(alert: ClaudeAccountAlert): string[] {
  return alert.lost.filter((loss) => loss.usability === 'signedOut' || loss.usability === 'notSignedIn').map((loss) => loss.name);
}

/** The operator's private message about one signed-out account: the line, and the button that starts its sign-in (`acct_signin_<name>`). */
export interface ClaudeAccountSignOutDm {
  text: string;
  buttonLabel: string;
  callbackData: string;
}

/** @description The private message about the signed-out account `name`, in the active locale. */
export function renderClaudeAccountSignOutDm(name: string): ClaudeAccountSignOutDm {
  return {
    text: t('accounts.signOutDm.text', { name: getClaudeProfileLabel(name) }),
    buttonLabel: t('accounts.signOutDm.button'),
    callbackData: buildAccountSignInCallback(name),
  };
}
