/**
 * @description Pure planning logic for flushing agent `output` to Telegram —
 * extracted from `bot.ts` so the streaming-append decision is unit-testable
 * without booting Telegraf.
 *
 * Live repro 2026-06-05: OpenCode emits a long reply
 * as incremental tails, and the bot edited the SAME message with only the
 * newest batch each flush — every edit replaced everything before it, so the
 * user could read only the last tail. The fix: a continuation tail is
 * appended to the text already rendered into the last message and the FULL
 * combined text is re-rendered (also re-pairing markdown tokens that straddle
 * two flushes), spilling into new messages when it outgrows the Telegram cap.
 */

import { splitMessage } from './messageSplit';
import { renderAgentHtml } from './renderAgentHtml';

/** Inject the real render into the splitter so chunks are sized by their
 *  rendered HTML length (escaping + tags inflate the source past Telegram's
 *  cap), keeping `messageSplit.ts` dependency-free. */
const measureRenderedLength = (chunk: string): number => renderAgentHtml(chunk).length;

export interface OutputFlushInput {
  /** The batch of output text to flush (already debounce-coalesced). */
  output: string;
  /** True when `output` continues the text already sent to `lastMessageId`. */
  isContinuation: boolean;
  /** Thread flag: next output must start a new message (user prompt, etc.). */
  needsNewMessage: boolean;
  /** Id of the last agent message in the thread, if editable. */
  lastMessageId: number | null;
  /** Source (pre-render) text currently shown in `lastMessageId`. */
  lastMessageText: string | null;
}

export interface OutputFlushPlan {
  /** Telegram-sized chunks covering the full (possibly combined) text. */
  chunks: string[];
  /**
   * True → `chunks[0]` re-edits `lastMessageId` in place (append semantics);
   * remaining chunks send as new messages. False → every chunk sends new.
   */
  shouldEditFirstChunk: boolean;
}

/**
 * @description Decide how a flush lands in Telegram. Append-edit is possible
 * only when the batch is a continuation AND the last message is still
 * editable (id + source text known, no forced break since).
 */
export function getOutputFlushPlan(input: OutputFlushInput): OutputFlushPlan {
  const canAppend =
    input.isContinuation &&
    !input.needsNewMessage &&
    input.lastMessageId !== null &&
    input.lastMessageText !== null;
  if (!canAppend) {
    return {
      chunks: splitMessage(input.output, undefined, measureRenderedLength),
      shouldEditFirstChunk: false,
    };
  }
  return {
    chunks: splitMessage(input.lastMessageText + input.output, undefined, measureRenderedLength),
    shouldEditFirstChunk: true,
  };
}

/**
 * @description The effective continuation flag the GROUP output path should use
 * for an incoming `output`, accounting for adapters that stream WITHOUT marking
 * continuations (the Claude scrape adapter).
 *
 * OpenCode marks every tail except a response's first with `meta.isContinuation`,
 * so the group edit-in-place path already knows which outputs extend the last
 * message; for it (`outputsDeltas === false`) the meta flag passes through
 * unchanged. The Claude scrape adapter emits each poll's prose delta with NO
 * meta even though every delta CONTINUES the same block — treating those as
 * non-continuations made `getOutputFlushPlan` start a new message per poll flush
 * (the one-message-per-scrape flood, and every re-flowed table width its own
 * message).
 *
 * For a delta-emitting adapter a poll delta is therefore a CONTINUATION (it
 * edits the growing message in place) UNLESS the pane had a real block boundary
 * before it — a blank-line paragraph break or a distinct block (a settled
 * table), both surfaced out-of-band as `startsNewParagraph`. At such a boundary
 * the delta starts a NEW message (the locked boundary rule: a new message begins
 * only at a paragraph/section, a distinct block, or a fresh turn — the last via
 * `needsNewMessage`, which `getOutputFlushPlan` already honours). Unlike the DM
 * cursor (one accumulating draft → everything is a continuation,
 * {@link getDmDraftContinuation}), group renders discrete messages, so a
 * paragraph/block boundary must break the message, not glue onto it.
 */
export function getGroupDeltaContinuation(
  metaIsContinuation: boolean,
  outputsDeltas: boolean,
  startsNewParagraph: boolean,
): boolean {
  if (!outputsDeltas) return metaIsContinuation;
  return !startsNewParagraph;
}

/**
 * @description Coalesce a new output batch into the pending (not yet flushed)
 * buffer. Continuation tails concatenate as-is — they may be cut mid-word, a
 * `\n` would split the word across lines. DISTINCT standalone outputs join with
 * a single `\n` by default, UPGRADED to a BLANK LINE (`\n\n`) only when
 * `startsNewParagraph` is set — the Claude scrape adapter reports out-of-band
 * (`OutboundHints.startsNewParagraph`) when the pane had a real paragraph
 * break before the chunk, so multi-paragraph answers keep their structure while
 * a single wrapped paragraph spanning two polls is NOT split by a blank.
 */
export function appendPendingOutput(
  pending: string | null,
  output: string,
  isContinuation: boolean,
  startsNewParagraph = false,
): string {
  if (!pending) return output;
  if (isContinuation) return pending + output;
  return startsNewParagraph ? `${pending}\n\n${output}` : `${pending}\n${output}`;
}

/**
 * @name PendingOutputSegment
 * @description A run of agent text waiting for its flush that belongs to ONE side of a turn boundary: batches queued with
 * no boundary marked between them are coalesced into one segment, and a boundary marked after a segment started ends it.
 */
export interface PendingOutputSegment {
  output: string;
  /** Whether the FIRST batch in `output` continues the last sent message. */
  isContinuation: boolean;
  /** Whether the first batch opens a message of its own: a turn boundary was marked before it was queued. */
  startsNewMessage: boolean;
}

/**
 * @name PendingOutputBuffer
 * @description The thread's ONE ordered backlog of unsent agent text, oldest segment first: `bot.ts`'s `OutputQueueState` carries
 * it and the helpers below keep it consistent. Every segment has a number, in the order it was queued: the oldest pending one
 * is `firstSeq`, the next `firstSeq + 1`, and so on. Taking the oldest out moves `firstSeq` on; a 429 leftover put back at the
 * head takes its number back. A landing waits for a number to settle (`utils/groupOutputBacklog.ts`): it SEALS the segments
 * up to `sealedThroughSeq`, so text queued after it never joins text it waits for.
 */
export interface PendingOutputBuffer {
  pendingSegments: PendingOutputSegment[];
  /** The number of `pendingSegments[0]`; one past the newest segment ever queued while nothing is pending. */
  firstSeq: number;
  /** Segments numbered up to here take no more text: a batch queued after them starts a segment of its own. */
  sealedThroughSeq: number;
}

/** @description The thread's mark that the next output opens a new message (a prompt forwarded, a session started, a question posted, a status frame shown). */
export interface NewMessageMark {
  needsNewMessage: boolean;
}

/**
 * @description Whether a turn's end marks that the NEXT text opens a message of its own. A prompt forwarded before its predecessor
 * turn ended sets the mark too early: the predecessor's closing text (its last deltas, read after the forward) spends it, and the new
 * turn's first text - a delta continuation - would be appended to those closing words («…(answer, turn 1).Working on …» in one
 * message). The adapter knows where a turn ends: input still on its way at that moment is the next turn's, so the mark is set again,
 * after the closing text was queued and before the next turn's text is. Only for an adapter whose output is deltas (the transport
 * synthesises its continuations); one that marks them itself needs no such guess.
 */
export function checkShouldMarkNewMessageAfterTurnEnd(input: { outputsDeltas: boolean; hasInputOnItsWay: boolean }): boolean {
  return input.outputsDeltas && input.hasInputOnItsWay;
}

/** @description The number of the newest segment queued so far (pending, or already taken out to be sent). */
export function getNewestPendingSeq(buffer: PendingOutputBuffer): number {
  return buffer.firstSeq + buffer.pendingSegments.length - 1;
}

/**
 * @description Queue one batch of agent output. Without a mark set it joins the newest segment (or starts the first one). With
 * the mark set it starts a segment of its own and spends the mark — also when an earlier segment is still waiting: that
 * text belongs to the turn before the boundary, so it flushes where it was going (as a continuation of the message it
 * extends) and the batch after the boundary opens a new message. A SEALED newest segment (a landing waits for it) takes no
 * more text either: the batch starts a segment of its own, as a continuation when it is one — so it extends the message
 * the sealed text lands in, as it would after any flush.
 *
 * The mark belongs to the first text queued AFTER it, not to whichever send completes next: a send already under way when the
 * boundary was marked (the previous turn's text on a slow Bot API round trip) would otherwise spend it, and the new turn's
 * first text would be appended by edit to the previous turn's message.
 */
export function addPendingOutput(
  buffer: PendingOutputBuffer,
  mark: NewMessageMark,
  batch: { output: string; isContinuation: boolean; startsNewParagraph: boolean },
): void {
  if (batch.output === '') return;
  const newest = buffer.pendingSegments.at(-1);
  if (newest && !mark.needsNewMessage && getNewestPendingSeq(buffer) > buffer.sealedThroughSeq) {
    newest.output = appendPendingOutput(newest.output, batch.output, batch.isContinuation, batch.startsNewParagraph);
    return;
  }
  buffer.pendingSegments.push({ output: batch.output, isContinuation: batch.isContinuation, startsNewMessage: mark.needsNewMessage });
  mark.needsNewMessage = false;
}

/** @description Whether anything waits to be sent. */
export function checkHasPendingOutput(buffer: PendingOutputBuffer): boolean {
  return buffer.pendingSegments.length > 0;
}

/** @description Take the oldest segment out to send it, with its number. `null` when nothing is pending. */
export function takePendingOutput(buffer: PendingOutputBuffer): { segment: PendingOutputSegment; seq: number } | null {
  const segment = buffer.pendingSegments.shift();
  if (!segment) return null;
  const seq = buffer.firstSeq;
  buffer.firstSeq += 1;
  return { segment, seq };
}

/**
 * @description Put the text a send could not land (see {@link getUnsentRemainder}) back at the HEAD of the backlog, under the
 * number of the segment it came from: it is older than everything still pending, and nothing was taken out since that segment
 * (one send at a time). It restarts a fresh message (its predecessors landed or were edited in place already), so it is not a
 * continuation, and it stays a segment of its own — never mixed with the newer text behind it.
 */
export function requeueUnsentRemainder(buffer: PendingOutputBuffer, unsentRemainder: string): void {
  buffer.pendingSegments.unshift({ output: unsentRemainder, isContinuation: false, startsNewMessage: false });
  buffer.firstSeq -= 1;
}

/** Separator used to re-join un-sent chunks before re-enqueueing them (S2). The
 *  planner re-splits the rejoined text next flush, so a blank line keeps the
 *  chunk boundary readable without gluing two messages together. */
const unsentRemainderSeparator = '\n\n';

/**
 * @description Compute the text that must be RE-ENQUEUED after a flush where one
 * or more chunks failed to send (live incident 2026-06-11, plan
 * `2026-06-11-claude-wide-table-content-loss` S2: `replyChunkWithFallback`
 * returns `null` when a chunk is dropped on a 429 after the rate-limit queue
 * gives up; the buffer was already cleared, so the chunk was permanently lost).
 *
 * `sentCount` is the number of chunks that landed, counting from the FRONT of
 * `chunks` (sends are in order, so a failure stops the run and everything from
 * the first failure onward is un-sent). Returns the rejoined un-sent remainder,
 * or `null` when everything landed. Idempotent: re-flushing the remainder never
 * re-sends a landed chunk because those are excluded here. Pure + exported for
 * unit tests.
 */
export function getUnsentRemainder(chunks: string[], sentCount: number): string | null {
  if (sentCount >= chunks.length) return null;
  const remainder = chunks.slice(sentCount);
  if (remainder.length === 0) return null;
  return remainder.join(unsentRemainderSeparator);
}
