/**
 * @description What an account billed to API credits (`utils/claudeProfiles.ts`, `billing: 'api'`) has spent through
 * the bot, from the `total_cost_usd` of Claude's stream `result` frames (the json-stream backend; the tmux backend
 * reports no figure).
 *
 * That figure is the CONVERSATION's running cost, not the turn's: Claude Code writes it into the transcript and
 * restores it on `--resume`, so a resumed process starts from the conversation's last total, and a subscription turn
 * of the same conversation counts in it too (a notional figure). The turn's spend is therefore the DELTA against the
 * last total the bot saw for that conversation (a per-topic baseline it keeps for every account), and only a turn on
 * an API account adds to that account's spend. With no baseline for the conversation, a NEW conversation started
 * from zero — the whole total is the turn's; a resumed one began at a total the bot never saw, so that turn only sets
 * the baseline (an undercount of one turn, never a doubled figure).
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
 * @description The spend of the turn whose `result` reported `totalCostUsd` for `sessionId` (see the module): the
 * delta against the baseline of the same conversation — a total BELOW it means the CLI counted from zero again (a
 * process that did not restore it), so the total is the turn's; without a baseline, the whole total for a new
 * conversation, `null` (unknown) for a resumed one.
 */
export function computeClaudeTurnCostUsd(input: {
  previous: ClaudeCostBaseline | undefined;
  sessionId: string;
  totalCostUsd: number;
  isNewConversation: boolean;
}): number | null {
  const { previous, totalCostUsd } = input;
  if (previous && previous.sessionId === input.sessionId) {
    const delta = totalCostUsd - previous.totalCostUsd;
    return delta >= 0 ? delta : totalCostUsd;
  }
  return input.isNewConversation ? totalCostUsd : null;
}

/** What one turn's cost report does to the account it ran on. */
export interface ClaudeTurnCostOutcome {
  /** What to add to the account's spend: the turn's cost on an account billed to API credits; `null` for nothing. */
  spendUsd: number | null;
  /** The turn went through on an API account marked out of credits: the balance is back, the mark ends. */
  isCreditMarkCleared: boolean;
}

/**
 * @description The effect of a turn's cost on its account: only an account billed to API credits has spend (a
 * subscription's figure is notional), and only a positive, known cost adds to it; a turn on it that did not end on an
 * error proves its credits are back.
 */
export function getClaudeTurnCostOutcome(input: {
  billing: ClaudeProfileBilling | null;
  isCreditExhausted: boolean;
  isError: boolean;
  turnCostUsd: number | null;
}): ClaudeTurnCostOutcome {
  if (input.billing !== 'api') return { spendUsd: null, isCreditMarkCleared: false };
  return {
    spendUsd: input.turnCostUsd !== null && input.turnCostUsd > 0 ? input.turnCostUsd : null,
    isCreditMarkCleared: input.isCreditExhausted && !input.isError,
  };
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
