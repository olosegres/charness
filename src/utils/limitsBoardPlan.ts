/**
 * @description The `/limits` switch board in two pure pieces:
 *
 *   - the ROWS — one per signed-in Claude account (in `/accounts` order), then one per connected OpenCode provider (in
 *     catalog order), each labelled `[✓ ]<program> · <account or provider>` and nothing else: the buttons carry no usage,
 *     no reset and no model (the figures do not fit a phone's button). The `✓` marks the active row only — where the
 *     topic runs now, in General the default Claude account. A signed-out account is not listed.
 *   - the USAGE BLOCK of the message above them — `Usage (% used)` and one line per signed-in Claude account that has
 *     a figure or a limit, then per connected OpenCode provider that reports usage (the ChatGPT subscription), each
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
/** The ChatGPT subscription's name beside its provider id in the usage block: `openai (ChatGPT)`. */
const chatGptBrandName = 'ChatGPT';

export interface LimitsBoardRow {
  kind: 'claude' | 'opencode';
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

function buildRow(row: Omit<LimitsBoardRow, 'label'> & { program: string }): LimitsBoardRow {
  const { program, ...rest } = row;
  return { ...rest, label: `${row.isActive ? activeMark : ''}${program} · ${row.id}` };
}

/** @description The board's rows: signed-in Claude accounts, then connected OpenCode providers. */
export function buildLimitsBoardRows(input: LimitsBoardInput): LimitsBoardRow[] {
  const rows: LimitsBoardRow[] = [];
  const { current } = input;
  for (const profile of input.detection.claudeProfiles) {
    if (profile.loggedIn === false) continue;
    rows.push(buildRow({
      kind: 'claude',
      id: profile.name,
      program: input.words.claude,
      isActive: current?.backend === 'claude' && current.profile === profile.name,
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
 * @description The usage block of the `/limits` message: the heading and the entries — signed-in Claude accounts in
 * `/accounts` order, then connected OpenCode providers with a recorded usage in catalog order. An account never polled
 * and not limited, and a provider without usage, have no entry; with no entry at all there is no block (`''`, no heading).
 */
export function formatLimitsUsageBlock(input: LimitsUsageBlockInput): string {
  const entries: string[] = [];
  for (const profile of input.detection.claudeProfiles) {
    if (profile.loggedIn === false) continue;
    const entry = formatUsageEntry(profile.name, formatClaudeProfileUsageLines(profile, input.timezone, input.nowMs));
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
