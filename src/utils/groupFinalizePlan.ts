/**
 * @description Pure decision for the GROUP output transport's `finalizeInFlight`
 * (S2): given the thread's coalesced output-queue state at a settle/teardown
 * boundary, decide whether there is an unsent remainder to force-deliver (so the
 * agent's final answer is never discarded) or the turn is already fully
 * delivered (a no-op — no duplicate post).
 *
 * Extracted from `bot.ts`'s `finalizeGroupOutput` so the "remainder vs no-op"
 * + importance decision is unit-testable without the Telegraf / queue
 * machinery. The bot-side function injects the send (`sendOutputImmediate`);
 * this owns the decision ({@link getGroupFinalizePlan}) and the order of the
 * drain ({@link landGroupOutput}: snapshot + null the buffer, wait for the flush
 * already sending, then send).
 *
 * The group queue already SEPARATES what landed from what is pending:
 * `lastMessageText` holds the last landed message and the pending segments hold the
 * coalesced-but-unsent remainder. So the "reconcile final accumulated vs last
 * landed" reduces to: send the pending segments, in order, if there are any. No text
 * diff is needed — the queue is the single source of the remainder.
 */

import type { PendingOutputBuffer, PendingOutputSegment } from '../connectors/telegram/outputFlushPlan';

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

/**
 * @name GroupFinalizeQueue
 * @description The part of `bot.ts`'s `OutputQueueState` the landing of a thread's output touches: the pending
 * segments, the debounce timer that would flush them later, and the flush that is sending right now.
 */
export interface GroupFinalizeQueue extends PendingOutputBuffer {
  /** The armed debounce timer that would flush the pending segments. `null` = none. */
  debounceTimer: NodeJS.Timeout | null;
  /** Settles when the flush sending right now has landed (or failed); `null` while none is. */
  flushSettled: Promise<void> | null;
}

/**
 * @description Record that a flush of `queue` is sending, so {@link landGroupOutput} can wait for it. Returns the
 * function that ends the record: call it when the flush is over, whatever its outcome.
 */
export function markFlushInFlight(queue: Pick<GroupFinalizeQueue, 'flushSettled'>): () => void {
  let settle = (): void => {};
  queue.flushSettled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return () => {
    queue.flushSettled = null;
    settle();
  };
}

/**
 * @description Land everything the thread's output queue still holds — the segments waiting for their debounce and the
 * flush already sending — so that whatever the caller posts next lands BELOW it. The answer of `answer_request` is
 * posted straight to the topic while the agent's streamed text waits out the per-topic debounce: without this the text
 * of the turn that led up to the answer would appear under the pinned answer.
 *
 * The pending segments are taken and the debounce timer cleared SYNCHRONOUSLY, before anything is awaited: a teardown
 * clears the queue right after it starts this, and would otherwise find the segments gone twice or not at all. A flush
 * already sending holds OLDER text than the segments taken, so its landing is awaited before they are sent — otherwise
 * the first of them could pass it while it still waits for its own send (it first deletes the status frame).
 * `sendSegment` sends one segment; it reports the text a 429 kept from landing, which ends the run: everything behind
 * it is dropped (the caller warns), as the teardown drain always treated it.
 */
export async function landGroupOutput(
  queue: GroupFinalizeQueue,
  sendSegment: (segment: PendingOutputSegment) => Promise<{ unsentRemainder: string | null }>,
): Promise<{ isRemainderDropped: boolean }> {
  const plan = getGroupFinalizePlan(queue);
  const flushInFlight = queue.flushSettled;
  if (plan.action === 'send') {
    // Snapshot is captured by the plan; empty the buffer SYNCHRONOUSLY before the await so the immediately-following
    // clear / a concurrent flush can't re-send it.
    queue.pendingSegments = [];
    if (queue.debounceTimer) {
      clearTimeout(queue.debounceTimer);
      queue.debounceTimer = null;
    }
  }
  await flushInFlight;
  // Fully delivered → no-op, no dupe.
  if (plan.action === 'noop') return { isRemainderDropped: false };
  for (const segment of plan.segments) {
    const { unsentRemainder } = await sendSegment(segment);
    if (unsentRemainder) return { isRemainderDropped: true };
  }
  return { isRemainderDropped: false };
}
