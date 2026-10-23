/**
 * @description What an account billed to API credits (`utils/claudeProfiles.ts`, `billing: 'api'`) has spent through
 * the bot, from the `total_cost_usd` of Claude's stream `result` frames (the json-stream backend; the tmux backend
 * reports no figure).
 *
 * That figure is the CONVERSATION's running cost, not the turn's: Claude Code writes it into the transcript when its
 * process exits and restores it on `--resume`, so a resumed process starts from the conversation's last saved total,
 * and a subscription turn of the same conversation counts in it too (a notional figure). The turn's spend is therefore
 * a DELTA, and only a turn on an API account adds to that account's spend. The first turn of a process the bot
 * started is measured against the total that process restored (the adapter reads it from the transcript before the
 * launch: `0` for a new conversation) — never against the last total the bot saw, which a turn the bot did not see
 * (the tmux backend's, which reports none) or a process that died without its exit flush (the next one restores an
 * OLDER total) makes wrong. Every later turn is measured against the last total the bot saw for that conversation (a
 * per-topic baseline it keeps for every account, persisted, so an adopted process after a restart goes on from it).
 *
 * It is what the bot OBSERVED, not the organization's balance: reading that needs an Admin API key.
 *
 * Pure: the clock and the zone come from the caller.
 */

import type { ClaudeProfileBilling } from './claudeProfiles';

/** The last `total_cost_usd` the bot saw for a topic's conversation (`state.json` `claudeCostBaselines`). */
export interface ClaudeCostBaseline {
  sessionId: string;
  totalCostUsd: number;
}

/** An API account's spend through the bot (`ClaudeProfileRecord.apiSpend`). */
export interface ClaudeApiSpend {
  totalUsd: number;
  /** ISO instant of the first turn counted. */
  since: string;
  lastTurnUsd: number;
  /** ISO instant of the last turn counted. */
  lastTurnAt: string;
}

/**
 * @description The spend of the turn whose `result` reported `totalCostUsd` for `sessionId` (see the module). The first
 * turn of a process the bot started (`startCostUsd` known) counts from the total that process restored; any other turn
 * is the delta against the baseline of the same conversation, `null` (unknown) without one. A total BELOW the figure it
 * is measured against means the CLI counted from zero (it restored nothing), so the total is the turn's.
 */
export function computeClaudeTurnCostUsd(input: {
  previous: ClaudeCostBaseline | undefined;
  sessionId: string;
  totalCostUsd: number;
  startCostUsd: number | null;
}): number | null {
  const { previous, totalCostUsd } = input;
  const measuredFromUsd = input.startCostUsd ?? (previous?.sessionId === input.sessionId ? previous.totalCostUsd : null);
  if (measuredFromUsd === null) return null;
  const delta = totalCostUsd - measuredFromUsd;
  return delta >= 0 ? delta : totalCostUsd;
}

/** What one turn's cost report does to the account it ran on. */
export interface ClaudeTurnCostOutcome {
  /** What to add to the account's spend: the turn's cost on an account billed to API credits; `null` for nothing. */
  spendUsd: number | null;
  /** A billed turn went through on an API account marked out of credits: the balance is back, the mark ends. */
  isCreditMarkCleared: boolean;
}

/**
 * @description The effect of a turn's cost on its account: only an account billed to API credits has spend (a
 * subscription's figure is notional), and only a positive, known cost adds to it. Only a turn on it that did not end on
 * an error AND was billed proves its credits are back — a result that made no request (a compaction with nothing to
 * compact, a local command) costs nothing and proves nothing.
 */
export function getClaudeTurnCostOutcome(input: {
  billing: ClaudeProfileBilling | null;
  isCreditExhausted: boolean;
  isError: boolean;
  turnCostUsd: number | null;
}): ClaudeTurnCostOutcome {
  if (input.billing !== 'api') return { spendUsd: null, isCreditMarkCleared: false };
  const spendUsd = input.turnCostUsd !== null && input.turnCostUsd > 0 ? input.turnCostUsd : null;
  return { spendUsd, isCreditMarkCleared: input.isCreditExhausted && !input.isError && spendUsd !== null };
}

/** The account's spend after a turn that cost `turnCostUsd` at `atIso` (the first counted turn opens `since`). */
export function addClaudeApiSpend(previous: ClaudeApiSpend | undefined, turnCostUsd: number, atIso: string): ClaudeApiSpend {
  return {
    totalUsd: (previous?.totalUsd ?? 0) + turnCostUsd,
    since: previous?.since ?? atIso,
    lastTurnUsd: turnCostUsd,
    lastTurnAt: atIso,
  };
}

/** Below a cent a figure reads as `<$0.01` rather than a misleading `$0.00`. */
const smallestShownUsd = 0.01;

/** `$12.34`; `<$0.01` for a positive amount under a cent; `$0.00` for none. */
export function formatUsd(amount: number): string {
  if (amount > 0 && amount < smallestShownUsd) return `<$${smallestShownUsd.toFixed(2)}`;
  return `$${amount.toFixed(2)}`;
}

/** The day a spend is counted since, in the instance zone: `23.10` (the year when it is not this one: `23.10.2025`). */
export function formatSpendSinceDay(sinceIso: string, timezone: string, nowMs: number): string {
  const at = Date.parse(sinceIso);
  if (Number.isNaN(at)) return '?';
  const read = (options: Intl.DateTimeFormatOptions, instant: number): string =>
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone, ...options }).format(instant);
  const day = `${read({ day: '2-digit' }, at)}.${read({ month: '2-digit' }, at)}`;
  const year = read({ year: 'numeric' }, at);
  return year === read({ year: 'numeric' }, nowMs) ? day : `${day}.${year}`;
}
