/**
 * @description The operator's alert about the Claude accounts (`utils/claudeAuthRefusal.ts`): an account that stopped being
 * usable because of its sign-in — signed out by its status check, or refused by the CLI on a turn (signed out, a login
 * expired or revoked, its organization turned Claude subscription use off, a bare 401 / 403) — and the moment no account
 * is usable at all, told ONCE per change: what broke (which account, the CLI's own words), what the bot did (the
 * conversations moved to another account, or they wait) and what the operator must do (sign it in again, and how). An
 * account that is usable again gets one line. The bot posts it in General (Telegram) and on the Jira operator issue
 * (`connectors/jira/operatorIssue.ts`).
 *
 * What was told is kept in `state.json` (`claudeAccountAlerts`), so a restart — hot mode restarts on every code change — never
 * tells it again. An account seen for the first time is told only when it matters: refused on a turn, or the account new
 * conversations start on (General's pick, else `default`); a folder adopted before its sign-in finished is not.
 *
 * Pure: the bot passes the states, the details and the account new conversations go to; the texts come from the active
 * locale (`accounts.alert.*`, `accounts.refusal.*`).
 */

import { t } from '../i18n';
import type { ClaudeProfileUsability } from './claudeAuthRefusal';

/** What the operator was told of the accounts, as `state.json` keeps it. */
export interface ClaudeAccountAlertState {
  /** Every account's state as last seen (an account gone from the profiles is dropped). */
  known: Record<string, ClaudeProfileUsability>;
  /** The accounts the operator was told cannot work, until one is usable again. */
  alerted: string[];
  /** The pinned alert in General, unpinned once no told account is left unusable; absent = none pinned. */
  pinnedMessageId?: number;
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
}

/**
 * @description The alert of this round (`null` = nothing to tell) and the state to keep. `current` is every account's state now,
 * `details` the CLI's words of a refusal by account, `defaultProfile` the account new conversations start on, `instead` where they
 * go now. A lost account: usable before and not now — or, seen for the first time, refused on a turn or `defaultProfile`. An account
 * that is not usable stays told until it is usable again; a change from one unusable state to another tells nothing new.
 */
export function planClaudeAccountAlert(input: {
  previous: ClaudeAccountAlertState | undefined;
  current: ReadonlyMap<string, ClaudeProfileUsability>;
  details: ReadonlyMap<string, string>;
  defaultProfile: string;
  instead: string | null;
}): { alert: ClaudeAccountAlert | null; next: ClaudeAccountAlertState } {
  const previousKnown = input.previous?.known ?? {};
  const alerted = new Set((input.previous?.alerted ?? []).filter((name) => input.current.has(name)));
  const lost: ClaudeAccountLoss[] = [];
  const back: string[] = [];
  for (const [name, usability] of input.current) {
    const before = Object.hasOwn(previousKnown, name) ? previousKnown[name] : undefined;
    if (usability === 'usable') {
      if (alerted.delete(name)) back.push(name);
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
  const next: ClaudeAccountAlertState = {
    known: Object.fromEntries(input.current),
    alerted: [...alerted],
    ...(input.previous?.pinnedMessageId !== undefined ? { pinnedMessageId: input.previous.pinnedMessageId } : {}),
  };
  const alert = lost.length === 0 && back.length === 0 ? null : { lost, back, instead: input.instead };
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
 * @description The alert in the active locale. `getSignInHow` says how to sign an account in where this text is read
 * (`/accounts login work` in Telegram, `CLAUDE_CONFIG_DIR=… claude auth login` on the host). A lost account gets its sentence,
 * the CLI's words when there are any and what to do; then one line on where the conversations went; an account usable again
 * one line.
 */
export function renderClaudeAccountAlert(alert: ClaudeAccountAlert, getSignInHow: (name: string) => string): string {
  const paragraphs: string[] = [];
  for (const loss of alert.lost) {
    const lines = [t('accounts.alert.title', { name: loss.name, reason: formatClaudeAccountRefusal(loss.usability) })];
    if (loss.detail !== null) lines.push(t('accounts.alert.cliSaid', { detail: loss.detail }));
    const how = getSignInHow(loss.name);
    lines.push(loss.usability === 'orgDisabled' ? t('accounts.alert.fixOrg', { how }) : t('accounts.alert.fixSignIn', { how }));
    paragraphs.push(lines.join('\n'));
  }
  if (alert.lost.length > 0) {
    paragraphs.push(alert.instead === null ? t('accounts.alert.noneUsable') : t('accounts.alert.movedTo', { to: alert.instead }));
  }
  for (const name of alert.back) paragraphs.push(t('accounts.alert.back', { name }));
  return paragraphs.join('\n\n');
}
