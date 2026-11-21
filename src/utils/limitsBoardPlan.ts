/**
 * @description The `/limits` switch board in two pure pieces:
 *
 *   - the ROWS — one per Claude account (in `/accounts` order), then one per connected OpenCode provider (in
 *     catalog order), each labelled `[✓ ]<program> · <account or provider>` and nothing else: the buttons carry no usage,
 *     no reset and no model (the figures do not fit a phone's button) — only an account billed to API credits ends in
 *     ` 💳` (a tap on it spends money). The `✓` marks the active row only — where the
 *     topic runs now, in General the default Claude account. A SIGNED-OUT account stays on the board as a row that is no
 *     switch target — `🔑 <program> · <account>`: a tap signs it in again (the 🔑 of `/accounts`), it never moves a topic.
 *   - the USAGE BLOCK of the message above them — `Usage (% used)` and one line per signed-in Claude account that has
 *     a figure or a limit (an account billed to API credits always: `console — 💳 API · pay per use`), `<name> — 🔑 sign-in
 *     expired` for a signed-out one, then per
 *     connected OpenCode provider that reports usage (the ChatGPT subscription), each
 *     `<name> — <first usage line>` in exactly the wording `/accounts` prints under a row
 *     (`formatClaudeProfileUsageLines`, the one renderer both screens share).
 *
 * Pure: the clock, the zone, the localised program names and the state's figures come from the caller, so every rule
 * is unit-tested. The screen is `connectors/telegram/commands/limitsBoard.ts`.
 */

import { t } from '../i18n';
import { formatClaudeProfileUsageLines } from './claudeProfileUsageLines';
import {
  getRunningModelOfProvider,
  listOpenCodeProviders,
  type FallbackChainEntry,
  type FallbackDetection,
} from './fallbackChain';
import { chatGptProviderId, type OpenCodeProviderUsageRecord } from './openCodeUsage';

const activeMark = '✓ ';
/** Before the label of a signed-out account's row: its tap signs the account in again, like the 🔑 of `/accounts`. */
const signInMark = '🔑 ';
/** The ChatGPT subscription's name beside its provider id in the usage block: `openai (ChatGPT)`. */
const chatGptBrandName = 'ChatGPT';

export interface LimitsBoardRow {
  /** `claudeSignedOut`: a Claude account that is not signed in — its tap starts the sign-in, it is never a switch target. */
  kind: 'claude' | 'claudeSignedOut' | 'opencode';
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
  const mark = row.kind === 'claudeSignedOut' ? signInMark : row.isActive ? activeMark : '';
  return { ...rest, label: `${mark}${program} · ${row.id}${isMetered ? meteredMark : ''}` };
}

/** @description The board's rows: the Claude accounts (a signed-out one as a sign-in row), then connected OpenCode providers. */
export function buildLimitsBoardRows(input: LimitsBoardInput): LimitsBoardRow[] {
  const rows: LimitsBoardRow[] = [];
  const { current } = input;
  for (const profile of input.detection.claudeProfiles) {
    if (profile.loggedIn === false) {
      rows.push(buildRow({ kind: 'claudeSignedOut', id: profile.name, program: input.words.claude, isActive: false }));
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
 * `/accounts` order (a signed-out one says so, `<name> — 🔑 sign-in expired`, whatever it was last polled at), then connected
 * OpenCode providers with a recorded usage in catalog order. A signed-in account never polled
 * and not limited, and a provider without usage, have no entry; with no entry at all there is no block (`''`, no heading).
 */
export function formatLimitsUsageBlock(input: LimitsUsageBlockInput): string {
  const entries: string[] = [];
  for (const profile of input.detection.claudeProfiles) {
    if (profile.loggedIn === false) {
      entries.push(`${profile.name} — ${t('limits.signedOutMark')}`);
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
