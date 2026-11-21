/**
 * @description The `/limits` switch board in two pure pieces:
 *
 *   - the ROWS — one per Claude account (in `/accounts` order), then one per connected OpenCode provider (in
 *     catalog order), each labelled `[✓ ]<program> · <account or provider>` and nothing else: the buttons carry no usage,
 *     no reset and no model (the figures do not fit a phone's button) — only an account billed to API credits ends in
 *     ` 💳` (a tap on it spends money). The `✓` marks the active row only — where the
 *     topic runs now, in General the default Claude account. An account that CANNOT WORK and that a sign-in mends (signed out, its
 *     login expired, refused by the API) stays on the board as a row that is no switch target — `🔑 <program> · <account>`: a tap
 *     signs it in again (the 🔑 of `/accounts`), it never moves a topic; one its organization turned off has no row (a sign-in does not mend it).
 *   - the USAGE BLOCK of the message above them — `Usage (% used)` and one line per signed-in Claude account that has
 *     a figure or a limit (an account billed to API credits always: `console — 💳 API · pay per use`), a line by WHY for one that cannot
 *     work — `<name> — 🔑 not signed in`, `🔑 sign-in expired`, `🔑 refused by the API (401/403)`, `🚫 its organization turned it off` —, then per
 *     connected OpenCode provider that reports usage (the ChatGPT subscription), each
 *     `<name> — <first usage line>` in exactly the wording `/accounts` prints under a row
 *     (`formatClaudeProfileUsageLines`, the one renderer both screens share).
 *
 * Pure: the clock, the zone, the localised program names and the state's figures come from the caller, so every rule
 * is unit-tested. The screen is `connectors/telegram/commands/limitsBoard.ts`.
 */

import { t } from '../i18n';
import { checkIsClaudeUsabilityMendedBySignIn, getClaudeProfileUsability, type ClaudeProfileUsability } from './claudeAuthRefusal';
import { formatClaudeProfileUsageLines } from './claudeProfileUsageLines';
import {
  getRunningModelOfProvider,
  listOpenCodeProviders,
  type FallbackChainEntry,
  type FallbackDetection,
} from './fallbackChain';
import { chatGptProviderId, type OpenCodeProviderUsageRecord } from './openCodeUsage';

const activeMark = '✓ ';
/** Before the label of an account's sign-in row, and before the words of an account a sign-in mends: its tap signs the account in again, like the 🔑 of `/accounts`. */
const signInMark = '🔑 ';
/** Before the words of an account no sign-in mends (its organization turned Claude subscription use off). */
const blockedMark = '🚫 ';
/** The words after an unusable account's name in the usage block, by why it cannot work (`account.row.loggedOut` is `/accounts`' own «not signed in»). */
const unusableMarkKeys: Readonly<Record<Exclude<ClaudeProfileUsability, 'usable'>, string>> = {
  notSignedIn: 'account.row.loggedOut',
  signedOut: 'limits.signedOutMark',
  rejected: 'limits.rejectedMark',
  orgDisabled: 'limits.orgDisabledMark',
};

/** `<mark> <why>` — what the usage block says of an account that cannot work. */
function formatUnusableMark(usability: Exclude<ClaudeProfileUsability, 'usable'>): string {
  return `${checkIsClaudeUsabilityMendedBySignIn(usability) ? signInMark : blockedMark}${t(unusableMarkKeys[usability])}`;
}
/** The ChatGPT subscription's name beside its provider id in the usage block: `openai (ChatGPT)`. */
const chatGptBrandName = 'ChatGPT';

export interface LimitsBoardRow {
  /** `claudeSignIn`: a Claude account that cannot work and that a sign-in mends — its tap starts the sign-in, it is never a switch target. */
  kind: 'claude' | 'claudeSignIn' | 'opencode';
  /** The Claude account's name, or the OpenCode provider's id — what a tap acts on. */
  id: string;
  label: string;
  /** The topic runs on this account / provider (in General: this is the default Claude account). */
  isActive: boolean;
}

export interface LimitsBoardInput {
  detection: FallbackDetection;
  /** Where the topic runs; in General the default Claude account (no model); `null` for no agent / an unknown OpenCode model. */
  current: FallbackChainEntry | null;
  /** The localised program names (`Claude` / `OpenCode`). */
  words: { claude: string; openCode: string };
}

/** The mark after an account billed to API credits: every request on it costs money. */
const meteredMark = ' 💳';

function buildRow(row: Omit<LimitsBoardRow, 'label'> & { program: string; isMetered?: boolean }): LimitsBoardRow {
  const { program, isMetered, ...rest } = row;
  const mark = row.kind === 'claudeSignIn' ? signInMark : row.isActive ? activeMark : '';
  return { ...rest, label: `${mark}${program} · ${row.id}${isMetered ? meteredMark : ''}` };
}

/**
 * @description The board's rows: the Claude accounts — one that cannot work as a sign-in row where a sign-in mends it (signed out, expired,
 * refused by the API), and none where it does not (its organization turned Claude subscription use off: the usage block says so) —, then
 * connected OpenCode providers.
 */
export function buildLimitsBoardRows(input: LimitsBoardInput): LimitsBoardRow[] {
  const rows: LimitsBoardRow[] = [];
  const { current } = input;
  for (const profile of input.detection.claudeProfiles) {
    const usability = getClaudeProfileUsability(profile);
    if (usability !== 'usable') {
      if (checkIsClaudeUsabilityMendedBySignIn(usability)) rows.push(buildRow({ kind: 'claudeSignIn', id: profile.name, program: input.words.claude, isActive: false }));
      continue;
    }
    rows.push(buildRow({
      kind: 'claude',
      id: profile.name,
      program: input.words.claude,
      isActive: current?.backend === 'claude' && current.profile === profile.name,
      isMetered: profile.billing === 'api',
    }));
  }
  for (const providerId of listOpenCodeProviders(input.detection.openCodeModels)) {
    rows.push(buildRow({
      kind: 'opencode',
      id: providerId,
      program: input.words.openCode,
      isActive: getRunningModelOfProvider(current, providerId) !== null,
    }));
  }
  return rows;
}

export interface LimitsUsageBlockInput {
  detection: FallbackDetection;
  /** What the poller recorded per OpenCode provider (`state.json` `openCodeProviderUsage`). */
  openCodeProviderUsage: Readonly<Record<string, OpenCodeProviderUsageRecord>>;
  nowMs: number;
  /** The instance zone the reset instants are shown in. */
  timezone: string;
}

/**
 * One usage line group: `<name> — <first line>` and the lines that hang under it (the limit mark after the windows), the
 * way `/accounts` words them. `null` when the source has nothing to show (never polled and not limited).
 */
function formatUsageEntry(name: string, usageLines: readonly string[]): string | null {
  const [first, ...rest] = usageLines;
  if (first === undefined) return null;
  return [`${name} — ${first.trimStart()}`, ...rest].join('\n');
}

/** The provider's name in the usage block: the ChatGPT subscription carries its brand, any other provider its id. */
function formatUsageProviderName(providerId: string): string {
  return providerId === chatGptProviderId ? `${providerId} (${chatGptBrandName})` : providerId;
}

/**
 * @description The usage block of the `/limits` message: the heading and the entries — Claude accounts in
 * `/accounts` order (one that cannot work says why, `<name> — 🔑 sign-in expired`, whatever it was last polled at), then connected
 * OpenCode providers with a recorded usage in catalog order. A signed-in account never polled
 * and not limited, and a provider without usage, have no entry; with no entry at all there is no block (`''`, no heading).
 */
export function formatLimitsUsageBlock(input: LimitsUsageBlockInput): string {
  const entries: string[] = [];
  for (const profile of input.detection.claudeProfiles) {
    const usability = getClaudeProfileUsability(profile);
    if (usability !== 'usable') {
      entries.push(`${profile.name} — ${formatUnusableMark(usability)}`);
      continue;
    }
    const usageLines = formatClaudeProfileUsageLines(profile, input.timezone, input.nowMs);
    // An account billed to API credits has no windows: its entry says how it pays, the used-up mark hangs under it.
    const entry = formatUsageEntry(profile.name, profile.billing === 'api' ? [t('account.kind.api'), ...usageLines] : usageLines);
    if (entry !== null) entries.push(entry);
  }
  for (const providerId of listOpenCodeProviders(input.detection.openCodeModels)) {
    const usage = input.openCodeProviderUsage[providerId]?.usage;
    if (usage === undefined) continue;
    const entry = formatUsageEntry(formatUsageProviderName(providerId), formatClaudeProfileUsageLines({ usage }, input.timezone, input.nowMs));
    if (entry !== null) entries.push(entry);
  }
  return entries.length === 0 ? '' : [t('limits.usageHeading'), ...entries].join('\n');
}
