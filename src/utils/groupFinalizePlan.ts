/**
 * @description Pure decision for the GROUP output transport's `finalizeInFlight`
 * (S2): given the thread's coalesced output-queue state at a settle/teardown
 * boundary, decide whether there is an unsent remainder to force-deliver (so the
 * agent's final answer is never discarded) or the turn is already fully
 * delivered (a no-op — no duplicate post).
 *
 * Extracted from `bot.ts`'s `finalizeGroupOutput` so the "remainder vs no-op"
 * + importance decision is unit-testable without the Telegraf / queue
 * machinery. The bot-side function owns the imperative drain (snapshot + null
 * the buffer, then `sendOutputImmediate`); this owns only the decision.
 *
 * The group queue already SEPARATES what landed from what is pending:
 * `lastMessageText` holds the last landed message and the pending segments hold the
 * coalesced-but-unsent remainder. So the "reconcile final accumulated vs last
 * landed" reduces to: send the pending segments, in order, if there are any. No text
 * diff is needed — the queue is the single source of the remainder.
 */

import type { PendingOutputSegment } from '../connectors/telegram/outputFlushPlan';

/** The load-bearing fields of `bot.ts`'s `OutputQueueState` the decision needs. */
export interface GroupFinalizeInput {
  /** Coalesced, not-yet-sent agent output, oldest first. Empty = nothing pending. */
  pendingSegments: readonly PendingOutputSegment[];
}

/**
 * @description The finalize plan: either nothing to do (fully delivered), or the
 * exact remainder to send — segment by segment, each landing as it was queued.
 */
export type GroupFinalizePlan =
  | { action: 'noop' }
  | { action: 'send'; segments: PendingOutputSegment[] };

export function getGroupFinalizePlan(input: GroupFinalizeInput): GroupFinalizePlan {
  // A fully-delivered turn (no pending remainder) — and segments holding only
  // whitespace, which would earn a Telegram error and are not a real answer — is
  // a no-op, so a settle/teardown never double-posts.
  const segments = input.pendingSegments.filter((segment) => segment.output.trim() !== '');
  if (segments.length === 0) return { action: 'noop' };
  return { action: 'send', segments };
}
