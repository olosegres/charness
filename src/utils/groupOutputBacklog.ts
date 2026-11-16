/**
 * @description A Telegram topic's group-mode output: ONE ordered backlog of the agent's unsent text, one loop that sends it
 * from the head, and the waits of the posts that must come after it. `bot.ts` owns the queue state and injects the send; this
 * module owns the order. What it keeps, whatever overlaps (two landings, a 429, a stop, a send that hangs):
 *
 *  1. Every piece of text is queued once, in the order the agent produced it, and leaves the backlog only to be sent, from the
 *     head, one send at a time ({@link drainGroupOutput}).
 *  2. A piece is sent at most once. A 429 (or a failure of the network) that kept part of it from landing puts that part back
 *     at the HEAD (it is older than everything still queued) for the retry; a refusal for good (a closed topic, another 4xx)
 *     drops it, logged — a retry would fail the same way and hold all newer text behind it for ever; a send whose outcome is
 *     unknown (the Bot API did not answer within its deadline, `rateLimiter.ts`) counts as sent and is never sent again — the
 *     send reports it as landed.
 *  3. A post that must come after the text — an answer, the messages of `send_messages_to_user`, a question, a tool status
 *     frame — waits until every piece queued before it has settled: landed, dropped by a stop, or of unknown outcome
 *     ({@link landGroupOutput}). It does not capture text: it marks a number and waits for it, so two landings, a 429 leftover
 *     and a stop never hold separate slices that could be sent out of order.
 *  4. A stop gives every piece queued so far ONE final attempt: a 429 then drops the rest of that piece, logged
 *     ({@link startFinalGroupOutputAttempt}). Nothing is dropped up front.
 *  5. Nothing waits for ever: every send is bounded by its Bot API deadline, and the callers bound their waits
 *     (`streamedOutputLanding.ts`).
 */

import { getNewestPendingSeq, requeueUnsentRemainder, takePendingOutput, type PendingOutputBuffer, type PendingOutputSegment } from '../connectors/telegram/outputFlushPlan';

/**
 * @name GroupOutputBacklog
 * @description The part of `bot.ts`'s `OutputQueueState` the sending of a topic's output touches.
 */
export interface GroupOutputBacklog extends PendingOutputBuffer {
  /** The armed debounce timer that would send the still-growing newest segment later. `null` = none. */
  debounceTimer: NodeJS.Timeout | null;
  /** The send loop is running: it picks up whatever a landing or a flush asks for while it sends. */
  isDraining: boolean;
  /** Every segment numbered up to here has settled: landed, dropped by a stop, or of unknown outcome. */
  settledSeq: number;
  /** Segments numbered up to here get one final attempt (a stop): a 429 drops them instead of putting them back. */
  finalAttemptThroughSeq: number;
  /** The posts waiting for a number to settle, in no particular order. */
  settleWaiters: GroupOutputSettleWaiter[];
}

/** A post waiting until every segment numbered up to `seq` has settled. */
interface GroupOutputSettleWaiter {
  seq: number;
  resolve: () => void;
}

/**
 * @description What one send of a segment left: nothing (all of it landed, or its outcome is unknown), or the text it could not
 * land and whether trying it again may help — a 429 or a network failure, as opposed to a refusal for good.
 */
export type GroupOutputSendResult = { unsentRemainder: null } | { unsentRemainder: string; isRetryable: boolean };

/** Why the send loop dropped text: a stop's final attempt failed, or Telegram refused it for good. */
export type GroupOutputDropReason = 'finalAttempt' | 'refused';

/** @description What the send loop needs from the bot: the send itself and what to do when it cannot go on. */
export interface GroupOutputDrainDeps {
  sendSegment: (segment: PendingOutputSegment) => Promise<GroupOutputSendResult>;
  /** A retryable failure put text back at the head and the loop stopped: arm the retry. */
  onStalled: () => void;
  /** `unsentRemainder` of `segment` is dropped, for `reason`. */
  onDropped: (segment: PendingOutputSegment, unsentRemainder: string, reason: GroupOutputDropReason) => void;
  /** A send threw instead of resolving: the segment counts as sent (never sent again) and the loop goes on. */
  onSendError: (error: Error) => void;
}

/** @description An empty backlog: nothing queued, nothing sending, nothing waiting. Segments are numbered from 1. */
export function createGroupOutputBacklog(): GroupOutputBacklog {
  return { pendingSegments: [], firstSeq: 1, sealedThroughSeq: 0, debounceTimer: null, isDraining: false, settledSeq: 0, finalAttemptThroughSeq: 0, settleWaiters: [] };
}

/**
 * @description Send the backlog from the head through segment `throughSeq` (sealing everything up to it, so no later text joins
 * it). One loop per backlog: a call while it runs only moves its target on, and the loop sends what was asked for in order.
 * The loop stops at the target, when the backlog is empty, or when a 429 put text back at the head (`onStalled`).
 */
export function drainGroupOutput(backlog: GroupOutputBacklog, throughSeq: number, deps: GroupOutputDrainDeps): void {
  backlog.sealedThroughSeq = Math.max(backlog.sealedThroughSeq, throughSeq);
  if (backlog.isDraining) return;
  backlog.isDraining = true;
  void runDrainLoop(backlog, deps);
}

/**
 * @description Land everything queued so far before the caller posts what must come after it: seal the newest segment, send the
 * backlog through it now (the debounce no longer waits for it) and resolve once every segment up to it has settled — also
 * one already being sent. Nothing is captured: a 429 leftover goes back to the head, a stop settles what it drops, and a
 * landing that started later waits for a later number, so the order of the text never depends on which landing sends it.
 */
export function landGroupOutput(backlog: GroupOutputBacklog, deps: GroupOutputDrainDeps): Promise<void> {
  const throughSeq = getNewestPendingSeq(backlog);
  clearDebounceTimer(backlog);
  drainGroupOutput(backlog, throughSeq, deps);
  return waitForGroupOutputSettled(backlog, throughSeq);
}

/**
 * @description A stop: give every segment queued so far one final attempt, in order, after the send under way. A 429 on that
 * attempt drops what is left of the segment (`onDropped`) instead of putting it back, so nothing is retried after the stop.
 * Resolves once they have all settled. Text queued after the call is the next session's and is sent as usual.
 */
export function startFinalGroupOutputAttempt(backlog: GroupOutputBacklog, deps: GroupOutputDrainDeps): Promise<void> {
  const throughSeq = getNewestPendingSeq(backlog);
  backlog.finalAttemptThroughSeq = Math.max(backlog.finalAttemptThroughSeq, throughSeq);
  return landGroupOutput(backlog, deps);
}

/** @description Resolve once every segment numbered up to `seq` has settled (at once when they all have). */
export function waitForGroupOutputSettled(backlog: GroupOutputBacklog, seq: number): Promise<void> {
  if (backlog.settledSeq >= seq) return Promise.resolve();
  return new Promise<void>((resolve) => {
    backlog.settleWaiters.push({ seq, resolve });
  });
}

function clearDebounceTimer(backlog: GroupOutputBacklog): void {
  if (!backlog.debounceTimer) return;
  clearTimeout(backlog.debounceTimer);
  backlog.debounceTimer = null;
}

/**
 * The send loop. `isDraining` is cleared in the SAME synchronous step as the check that found nothing more to send, so a call
 * of {@link drainGroupOutput} can never land between the two and be left unserved.
 */
async function runDrainLoop(backlog: GroupOutputBacklog, deps: GroupOutputDrainDeps): Promise<void> {
  try {
    while (backlog.pendingSegments.length > 0 && backlog.firstSeq <= backlog.sealedThroughSeq) {
      const taken = takePendingOutput(backlog);
      if (!taken) return;
      const result = await sendSegmentOnce(taken.segment, deps);
      if (result.unsentRemainder !== null) {
        if (!result.isRetryable) {
          deps.onDropped(taken.segment, result.unsentRemainder, 'refused');
        } else if (taken.seq > backlog.finalAttemptThroughSeq) {
          requeueUnsentRemainder(backlog, result.unsentRemainder);
          deps.onStalled();
          return;
        } else {
          deps.onDropped(taken.segment, result.unsentRemainder, 'finalAttempt');
        }
      }
      settleGroupOutputThrough(backlog, taken.seq);
    }
  } finally {
    backlog.isDraining = false;
  }
}

/** A blank segment would only earn a Telegram error and is no text: it settles without a send. */
async function sendSegmentOnce(segment: PendingOutputSegment, deps: GroupOutputDrainDeps): Promise<GroupOutputSendResult> {
  if (segment.output.trim() === '') return { unsentRemainder: null };
  try {
    return await deps.sendSegment(segment);
  } catch (error) {
    deps.onSendError(error instanceof Error ? error : new Error(String(error)));
    return { unsentRemainder: null };
  }
}

function settleGroupOutputThrough(backlog: GroupOutputBacklog, seq: number): void {
  backlog.settledSeq = Math.max(backlog.settledSeq, seq);
  const settled = backlog.settleWaiters.filter((waiter) => waiter.seq <= backlog.settledSeq);
  if (settled.length === 0) return;
  backlog.settleWaiters = backlog.settleWaiters.filter((waiter) => waiter.seq > backlog.settledSeq);
  for (const waiter of settled) waiter.resolve();
}
