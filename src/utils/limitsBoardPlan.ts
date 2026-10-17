/**
 * @description The rows of the `/limits` switch board — one per signed-in Claude account (in `/accounts` order), then
 * one per connected OpenCode provider (in catalog order) — and the ONE place their label is built:
 * `[✓ ]<program> · <account or provider>[ · <model>][ — <status>]`.
 *
 *   - the model is shown on the active row only (where the topic runs now);
 *   - the status is, in this order of precedence, `⛔ until <time>` while the account / provider is limited (the reset
 *     shows only here), else `5h x% · week y%` when its usage is known, else nothing; usage that is out of date keeps
 *     its numbers with a trailing `⚠️` and marks the row stale;
 *   - model-specific windows (Fable) are not on the label; a signed-out account is not listed.
 *
 * Pure: the clock, the zone, the localised program names and the state's figures come from the caller, so every rule
 * is unit-tested. The screen is `connectors/telegram/commands/limitsBoard.ts`.
 */

import { t } from '../i18n';
import {
  formatClaudeUsageResetAt,
  getClaudeUsageBucket,
  type ClaudeUsageSnapshot,
} from './claudeUsage';
import {
  getFallbackEntryAvailability,
  listOpenCodeProviders,
  parseOpenCodeModelLabel,
  type FallbackChainEntry,
  type FallbackDetection,
} from './fallbackChain';
import type { OpenCodeProviderUsageRecord } from './openCodeUsage';

const activeMark = '✓ ';
const staleMark = ' ⚠️';
const missingWindow = '—';

export interface LimitsBoardRow {
  kind: 'claude' | 'opencode';
  /** The Claude account's name, or the OpenCode provider's id — what a tap acts on. */
  id: string;
  label: string;
  /** The topic runs on this account / provider (in General: this is the default Claude account). */
  isActive: boolean;
  /** The usage on the label is out of date (the label ends with `⚠️`). */
  isStale: boolean;
}

export interface LimitsBoardInput {
  detection: FallbackDetection;
  /** What the poller recorded per OpenCode provider (`state.json` `openCodeProviderUsage`). */
  openCodeProviderUsage: Readonly<Record<string, OpenCodeProviderUsageRecord>>;
  /** Where the topic runs; in General the default Claude account (no model); `null` for no agent / an unknown OpenCode model. */
  current: FallbackChainEntry | null;
  nowMs: number;
  /** The instance zone the reset instants are shown in. */
  timezone: string;
  /** The localised program names (`Claude` / `OpenCode`). */
  words: { claude: string; openCode: string };
}

/** `5h 5% · week 78%` for a snapshot that has at least one of the two shared windows; `null` otherwise. */
function formatUsageStatus(usage: ClaudeUsageSnapshot | undefined): string | null {
  if (!usage) return null;
  const session = getClaudeUsageBucket(usage, 'session');
  const weekly = getClaudeUsageBucket(usage, 'weekly_all');
  if (session === null && weekly === null) return null;
  const read = (bucket: { percent: number } | null): string => (bucket === null ? missingWindow : `${bucket.percent}%`);
  return t('limits.rowUsage', { session: read(session), weekly: read(weekly) });
}

interface RowFacts {
  kind: LimitsBoardRow['kind'];
  id: string;
  program: string;
  isActive: boolean;
  model: string | null;
  /** The instant the account / provider is limited until, when it is limited now. */
  limitedUntil: string | null;
  usage: ClaudeUsageSnapshot | undefined;
}

function buildRow(facts: RowFacts, input: LimitsBoardInput): LimitsBoardRow {
  let status: string | null = null;
  let isStale = false;
  if (facts.limitedUntil !== null) {
    status = t('limits.rowLimited', { time: formatClaudeUsageResetAt(facts.limitedUntil, input.timezone, input.nowMs) });
  } else {
    const usageStatus = formatUsageStatus(facts.usage);
    if (usageStatus !== null) {
      isStale = facts.usage?.isStale === true;
      status = isStale ? `${usageStatus}${staleMark}` : usageStatus;
    }
  }
  const model = facts.isActive && facts.model !== null ? ` · ${facts.model}` : '';
  const label = `${facts.isActive ? activeMark : ''}${facts.program} · ${facts.id}${model}${status === null ? '' : ` — ${status}`}`;
  return { kind: facts.kind, id: facts.id, label, isActive: facts.isActive, isStale };
}

/** The earliest limit mark still ahead among the provider's models; `null` when none is. */
function findProviderLimitedUntil(providerId: string, input: LimitsBoardInput): string | null {
  let earliest: number | null = null;
  for (const label of input.detection.openCodeModels) {
    if (parseOpenCodeModelLabel(label)?.providerId !== providerId) continue;
    const mark = input.detection.openCodeLimits[label];
    const markMs = mark === undefined ? Number.NaN : Date.parse(mark);
    if (Number.isFinite(markMs) && markMs > input.nowMs && (earliest === null || markMs < earliest)) earliest = markMs;
  }
  return earliest === null ? null : new Date(earliest).toISOString();
}

/** @description The board's rows: signed-in Claude accounts, then connected OpenCode providers. */
export function buildLimitsBoardRows(input: LimitsBoardInput): LimitsBoardRow[] {
  const rows: LimitsBoardRow[] = [];
  const { current } = input;
  for (const profile of input.detection.claudeProfiles) {
    if (profile.loggedIn === false) continue;
    const availability = getFallbackEntryAvailability({ backend: 'claude', profile: profile.name, model: null }, input.detection, input.nowMs);
    const isLimited = availability.status === 'limited' && Date.parse(availability.until) > input.nowMs;
    const isActive = current?.backend === 'claude' && current.profile === profile.name;
    rows.push(buildRow({
      kind: 'claude',
      id: profile.name,
      program: input.words.claude,
      isActive,
      model: current?.backend === 'claude' ? current.model : null,
      limitedUntil: isLimited && availability.status === 'limited' ? availability.until : null,
      usage: profile.usage,
    }, input));
  }
  for (const providerId of listOpenCodeProviders(input.detection.openCodeModels)) {
    const isActive = current?.backend === 'opencode' && current.providerId === providerId;
    rows.push(buildRow({
      kind: 'opencode',
      id: providerId,
      program: input.words.openCode,
      isActive,
      model: current?.backend === 'opencode' ? current.modelId : null,
      limitedUntil: findProviderLimitedUntil(providerId, input),
      usage: input.openCodeProviderUsage[providerId]?.usage,
    }, input));
  }
  return rows;
}
