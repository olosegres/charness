/**
 * @description Pure decision for the GROUP output transport's `finalizeInFlight`
 * (S2): given the thread's coalesced output-queue state at a settle/teardown
 * boundary, decide whether there is an unsent remainder to force-deliver (so the
 * agent's final answer is never discarded) or the turn is already fully
 * delivered (a no-op — no duplicate post).
 *
 * Extracted from `bot.ts`'s `finalizeGroupOutput` so the "remainder vs no-op"
 * + importance decision is unit-testable without the Telegraf / queue
 * machinery. The bot-side functions inject the send (`sendOutputImmediate`);
 * this owns the decision ({@link getGroupFinalizePlan}), the chain every send of a
 * topic's output runs in ({@link runInSendChain}), the debounce flush's body
 * ({@link flushNextPendingOutput}) and the order of the drain ({@link landGroupOutput}:
 * snapshot + null the buffer, then send in turn).
 *
 * The group queue already SEPARATES what landed from what is pending:
 * `lastMessageText` holds the last landed message and the pending segments hold the
 * coalesced-but-unsent remainder. So the "reconcile final accumulated vs last
 * landed" reduces to: send the pending segments, in order, if there are any. No text
 * diff is needed — the queue is the single source of the remainder.
 */

import { requeueUnsentRemainder, takePendingOutput, type PendingOutputBuffer, type PendingOutputSegment } from '../connectors/telegram/outputFlushPlan';

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
 * @description The part of `bot.ts`'s `OutputQueueState` the sending of a thread's output touches: the pending segments, the
 * debounce timer that would flush them later, the chain every send of this output runs in ({@link runInSendChain}) and the note
 * that a flush put a 429 leftover back.
 */
export interface GroupFinalizeQueue extends PendingOutputBuffer {
  /** The armed debounce timer that would flush the pending segments. `null` = none. */
  debounceTimer: NodeJS.Timeout | null;
  /** Settles when the last send started in the chain is over, however it ended; never rejects. */
  sendChainTail: Promise<void>;
  /**
   * A flush put the text a 429 kept from landing back at the front of the buffer, and nothing has sent it yet: it is OLDER than
   * what a landing that started meanwhile took, so that landing sends it first.
   */
  isRemainderRequeued: boolean;
}

/** @description An empty output queue of a thread: nothing pending, no timer, nothing sending. */
export function createGroupFinalizeQueue(): GroupFinalizeQueue {
  return { pendingSegments: [], debounceTimer: null, sendChainTail: Promise.resolve(), isRemainderRequeued: false };
}

/**
 * @description Run `send` after every send already started for this queue's output has ended — the debounce flush and the
 * landings alike — and before any started later: the order the text is posted in is the order the sends were started in, whatever
 * each takes and whichever of them was started by a tool call's status frame, an answer, or the debounce. Without the chain a
 * send that starts while another is still going out (it first deletes the status frame, and a long text goes out in several
 * messages) is passed by the later one. A failure reaches the caller of that send only: the chain goes on.
 */
export function runInSendChain<TResult>(queue: Pick<GroupFinalizeQueue, 'sendChainTail'>, send: () => Promise<TResult>): Promise<TResult> {
  const result = queue.sendChainTail.then(send);
  queue.sendChainTail = result.then(() => undefined, () => undefined);
  return result;
}

/**
 * @description The body of one debounce flush, to run in the chain: send the OLDEST pending segment.
 *
 * No silent drop: a chunk dropped on a 429 after the retry-after wait comes back as `unsentRemainder`. It is put BACK at the
 * FRONT of the buffer (it is older than anything that arrived during the await) so the re-trigger flush retries it — never
 * lost. Landed chunks are excluded by `getUnsentRemainder`, so this never re-sends what already reached Telegram. The remainder
 * restarts a fresh message (its predecessors landed / edited in place already), so it is NOT a continuation. The note on the
 * queue tells a landing that runs next that this text is older than what it took.
 */
export async function flushNextPendingOutput(
  queue: GroupFinalizeQueue,
  sendSegment: (segment: PendingOutputSegment) => Promise<{ unsentRemainder: string | null }>,
): Promise<void> {
  // This flush takes whatever is oldest, a leftover included: nothing is left over for a landing to send first.
  queue.isRemainderRequeued = false;
  const segment = takePendingOutput(queue);
  if (!segment) return;
  const { unsentRemainder } = await sendSegment(segment);
  if (unsentRemainder) {
    requeueUnsentRemainder(queue, unsentRemainder);
    queue.isRemainderRequeued = true;
  }
}

/**
 * @description Land everything the thread's output queue still holds — the segments waiting for their debounce, and every send
 * already going out — so that whatever the caller posts next lands BELOW it. The answer of `answer_request` and the messages of
 * `send_messages_to_user` are posted straight to the topic while the agent's streamed text waits out the per-topic debounce, or
 * is being landed for a tool call's status frame: without this the text of the turn that led up to them would appear under them.
 *
 * The pending segments are taken and the debounce timer cleared SYNCHRONOUSLY, before anything is awaited: a teardown clears
 * the queue right after it starts this, and would otherwise find the segments gone twice or not at all. Their sending, and the
 * return of this call, wait their turn in {@link runInSendChain}, so a flush or a landing already sending lands first. The 429
 * leftover such a flush put back is older than the segments taken: it goes out ahead of them.
 * `sendSegment` sends one segment; it reports the text a 429 kept from landing, which ends the run: everything behind it is
 * dropped (the caller warns), as the teardown drain always treated it.
 */
export function landGroupOutput(
  queue: GroupFinalizeQueue,
  sendSegment: (segment: PendingOutputSegment) => Promise<{ unsentRemainder: string | null }>,
): Promise<{ isRemainderDropped: boolean }> {
  const plan = getGroupFinalizePlan(queue);
  if (plan.action === 'send') {
    // Snapshot is captured by the plan; empty the buffer SYNCHRONOUSLY before the await so the immediately-following
    // clear / a concurrent flush can't re-send it.
    queue.pendingSegments = [];
    if (queue.debounceTimer) {
      clearTimeout(queue.debounceTimer);
      queue.debounceTimer = null;
    }
  }
  // Fully delivered → nothing taken: no-op, no dupe.
  const takenSegments = plan.action === 'send' ? plan.segments : [];
  return runInSendChain(queue, async () => {
    for (const segment of [...takeRequeuedRemainder(queue), ...takenSegments]) {
      const { unsentRemainder } = await sendSegment(segment);
      if (unsentRemainder) return { isRemainderDropped: true };
    }
    return { isRemainderDropped: false };
  });
}

/** @description The segments a flush that has just ended put back after a 429 (the whole buffer: the leftover is joined to what followed it), taken out for a landing. Empty when none did. */
function takeRequeuedRemainder(queue: GroupFinalizeQueue): PendingOutputSegment[] {
  if (!queue.isRemainderRequeued) return [];
  queue.isRemainderRequeued = false;
  const plan = getGroupFinalizePlan(queue);
  if (plan.action === 'noop') return [];
  queue.pendingSegments = [];
  if (queue.debounceTimer) {
    clearTimeout(queue.debounceTimer);
    queue.debounceTimer = null;
  }
  return plan.segments;
}
