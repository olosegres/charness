/**
 * @description Streaming-append flush planning (Bug A — overwrite).
 *
 * Bug: OpenCode streams a long reply as incremental tails; the bot edited the
 * SAME Telegram message with ONLY the newest tail each flush, so every edit
 * replaced everything before it and the user could read only the last tail.
 *
 * Fix: a continuation tail is APPENDED to the text already rendered into the
 * last message and the FULL combined text is re-chunked; only when the batch
 * is a real continuation AND the last message is still editable does the first
 * chunk re-edit in place.
 *
 * Load-bearing intent (per `.claude/rules/tests.md`): assert the combined text
 * actually covers `lastMessageText + output` (not just "no crash"), that a
 * mid-word continuation tail joins SEAMLESSLY (no inserted whitespace), and
 * that any blocker (fresh output / forced new message / missing id or text)
 * sends fresh instead of clobbering the previous message.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addPendingOutput,
  checkHasPendingOutput,
  getOutputFlushPlan,
  appendPendingOutput,
  getUnsentRemainder,
  getGroupDeltaContinuation,
  requeueUnsentRemainder,
  takePendingOutput,
  type NewMessageMark,
  type PendingOutputBuffer,
  type PendingOutputSegment,
} from '../connectors/telegram/outputFlushPlan';
import { MAX_MESSAGE_LEN, splitMessage } from '../connectors/telegram/messageSplit';

describe('getOutputFlushPlan', () => {
  it('fresh output (not a continuation) → no edit, chunks = splitMessage(output)', () => {
    const plan = getOutputFlushPlan({
      output: 'A brand new answer.',
      isContinuation: false,
      needsNewMessage: false,
      lastMessageId: 123,
      lastMessageText: 'previous message',
    });
    assert.equal(plan.shouldEditFirstChunk, false);
    assert.deepEqual(plan.chunks, splitMessage('A brand new answer.'));
    // The previous message text must NOT be part of the plan for a fresh output.
    assert.ok(!plan.chunks[0].includes('previous message'));
  });

  it('continuation with an editable last message → edit first chunk; combined text covers lastMessageText + output', () => {
    const plan = getOutputFlushPlan({
      output: ' and the tail.',
      isContinuation: true,
      needsNewMessage: false,
      lastMessageId: 55,
      lastMessageText: 'The head',
    });
    assert.equal(plan.shouldEditFirstChunk, true);
    // Combined, in order, no separator inserted between base and tail.
    assert.equal(plan.chunks.join(''), 'The head and the tail.');
    assert.equal(plan.chunks[0], 'The head and the tail.');
  });

  it('continuation but needsNewMessage forces a break → fresh send, no edit', () => {
    const plan = getOutputFlushPlan({
      output: 'tail',
      isContinuation: true,
      needsNewMessage: true,
      lastMessageId: 55,
      lastMessageText: 'head',
    });
    assert.equal(plan.shouldEditFirstChunk, false);
    assert.deepEqual(plan.chunks, ['tail']);
    assert.ok(!plan.chunks[0].includes('head'));
  });

  it('continuation but no last message id → fresh send, no edit', () => {
    const plan = getOutputFlushPlan({
      output: 'tail',
      isContinuation: true,
      needsNewMessage: false,
      lastMessageId: null,
      lastMessageText: 'head',
    });
    assert.equal(plan.shouldEditFirstChunk, false);
    assert.deepEqual(plan.chunks, ['tail']);
  });

  it('continuation but no last message text → fresh send, no edit', () => {
    const plan = getOutputFlushPlan({
      output: 'tail',
      isContinuation: true,
      needsNewMessage: false,
      lastMessageId: 55,
      lastMessageText: null,
    });
    assert.equal(plan.shouldEditFirstChunk, false);
    assert.deepEqual(plan.chunks, ['tail']);
  });

  it('combined text over the Telegram cap → multiple chunks: first edits, the rest send new', () => {
    // No newlines, so splitMessage cuts at exactly MAX_MESSAGE_LEN.
    const base = 'b'.repeat(3000);
    const tail = 't'.repeat(2000);
    const plan = getOutputFlushPlan({
      output: tail,
      isContinuation: true,
      needsNewMessage: false,
      lastMessageId: 55,
      lastMessageText: base,
    });
    assert.equal(plan.shouldEditFirstChunk, true);
    assert.ok(plan.chunks.length >= 2, 'combined 5000 chars must span multiple chunks');
    // No chunk exceeds the cap.
    for (const chunk of plan.chunks) {
      assert.ok(chunk.length <= MAX_MESSAGE_LEN, `chunk length ${chunk.length} <= ${MAX_MESSAGE_LEN}`);
    }
    // The full combined text is preserved across chunks (each char once).
    assert.equal(plan.chunks.join('').length, base.length + tail.length);
    assert.equal(plan.chunks.join(''), base + tail);
  });
});

describe('appendPendingOutput', () => {
  it('null pending → returns output unchanged (continuation + paragraph flags ignored)', () => {
    assert.equal(appendPendingOutput(null, 'hello', true), 'hello');
    assert.equal(appendPendingOutput(null, 'hello', false), 'hello');
    // Even with the paragraph flag set, an empty buffer yields the output
    // verbatim — a fresh message must never start with a separator.
    assert.equal(appendPendingOutput(null, 'hello', false, true), 'hello');
  });

  it('continuation → raw concat, NO separator: a mid-word tail joins seamlessly', () => {
    // The streamed tail was cut mid-word ("import" + "ant"); a '\n' here would
    // corrupt the word, so continuation must concatenate raw. The paragraph flag
    // never upgrades a continuation join.
    assert.equal(appendPendingOutput('import', 'ant feature', true), 'important feature');
    assert.equal(appendPendingOutput('import', 'ant feature', true, true), 'important feature');
  });

  it('non-continuation WITHOUT the paragraph flag → joins with a single \\n', () => {
    // Default standalone coalescing: a single newline, NOT a blank line. The
    // blank is reserved for chunks the pane actually separated with one.
    assert.equal(appendPendingOutput('first', 'second', false), 'first\nsecond');
  });

  it('non-continuation WITH the paragraph flag → joins with a blank line \\n\\n', () => {
    // Claude reported a real paragraph break before this chunk → rebuild the
    // blank-line separator so paragraphs stay paragraphs.
    assert.equal(
      appendPendingOutput('first paragraph', 'second paragraph', false, true),
      'first paragraph\n\nsecond paragraph',
    );
  });
});

describe('getUnsentRemainder (S2 — no silent drop on send failure)', () => {
  it('all chunks landed → null (nothing to re-enqueue)', () => {
    assert.equal(getUnsentRemainder(['a', 'b', 'c'], 3), null);
    // Defensive: a sentCount past the end is still "all sent".
    assert.equal(getUnsentRemainder(['a'], 5), null);
  });

  it('a chunk dropped on a 429 → the un-sent remainder is returned (no loss)', () => {
    // Sends are in order; chunk index 1 failed, so chunks[1..] are un-sent.
    assert.equal(getUnsentRemainder(['a', 'b', 'c'], 1), 'b\n\nc');
  });

  it('the FIRST chunk failed → the whole batch is the remainder', () => {
    assert.equal(getUnsentRemainder(['only'], 0), 'only');
    assert.equal(getUnsentRemainder(['a', 'b'], 0), 'a\n\nb');
  });

  it('landed chunks are NOT part of the remainder (idempotent on re-flush)', () => {
    // Flush 1: chunks [a,b,c]; only "a" landed (b dropped on 429). The remainder
    // must exclude "a" so the retry never re-sends it.
    const remainder = getUnsentRemainder(['a', 'b', 'c'], 1);
    assert.equal(remainder, 'b\n\nc');
    assert.ok(!remainder!.includes('a'), 'a already landed — must not be re-sent');

    // Flush 2 re-splits the remainder; assume both land this time → no further
    // remainder, i.e. the buffer is finally empty (no infinite re-send loop).
    const reChunks = splitMessage(remainder!);
    assert.equal(getUnsentRemainder(reChunks, reChunks.length), null);
  });

  it('models the processOutputQueue re-enqueue: dropped text is retained, then sent once', () => {
    // Simulate the coalescer with a batch the planner splits into 3 chunks (use
    // explicit chunks so the model does not depend on the Telegram cap math).
    // Flush 1 lands chunk 0, then chunk 1 is dropped on a 429 → the loop stops.
    let pendingOutput: string | null = null;
    const landed: string[] = [];

    const chunks1 = ['chunk A', 'chunk B', 'chunk C'];
    pendingOutput = null; // bot.ts clears the buffer before sending
    const sentCount1 = 1; // chunk 0 landed; chunk 1 (B) dropped on 429
    landed.push(...chunks1.slice(0, sentCount1));
    const remainder1 = getUnsentRemainder(chunks1, sentCount1);
    // Re-enqueue at the FRONT (nothing else arrived during the await here).
    if (remainder1) pendingOutput = remainder1;
    assert.equal(pendingOutput, 'chunk B\n\nchunk C', 'dropped text must be retained');
    assert.ok(!pendingOutput!.includes('chunk A'), 'the landed chunk must NOT be retained');

    // Flush 2: the remainder splits back to chunks and all land this time.
    const chunks2 = ['chunk B', 'chunk C'];
    const sentCount2 = chunks2.length;
    landed.push(...chunks2.slice(0, sentCount2));
    const remainder2 = getUnsentRemainder(chunks2, sentCount2);
    assert.equal(remainder2, null, 'after a successful retry nothing remains');

    // The full original content survived exactly once each across both flushes.
    assert.deepEqual(landed, ['chunk A', 'chunk B', 'chunk C']);
  });
});

describe('getGroupDeltaContinuation (S3 — Claude edit-in-place in group mode)', () => {
  it('a continuation-marking adapter (OpenCode, outputsDeltas false) passes the meta flag through', () => {
    // OpenCode is authoritative; startsNewParagraph is irrelevant (it never sets it).
    assert.equal(getGroupDeltaContinuation(true, false, false), true);
    assert.equal(getGroupDeltaContinuation(false, false, false), false);
    assert.equal(getGroupDeltaContinuation(true, false, true), true);
  });

  it('a delta adapter (Claude) treats a poll delta as a CONTINUATION → edits in place', () => {
    // The core fix: a mid-block prose delta (no paragraph break, no meta) must
    // continue the growing message instead of spawning a new one per flush.
    assert.equal(getGroupDeltaContinuation(false, true, false), true);
  });

  it('a delta adapter starts a NEW message at a paragraph/block boundary (startsNewParagraph)', () => {
    // The boundary rule: a blank-line paragraph break or a distinct block (a
    // settled table emits with startsNewParagraph) is NOT a continuation → new
    // message, so blocks never glue and a re-flowed table stays its own message.
    assert.equal(getGroupDeltaContinuation(false, true, true), false);
  });
});

function createEmptyBuffer(): PendingOutputBuffer {
  return { pendingSegments: [] };
}

const midReplyBatch = { isContinuation: true, startsNewParagraph: false };

/** What `sendOutputImmediate` decides for a taken segment, against the message the topic ended on. */
function planTakenSegment(segment: PendingOutputSegment, lastMessage: { id: number | null; text: string | null }): { isEditInPlace: boolean; chunks: string[] } {
  const plan = getOutputFlushPlan({
    output: segment.output,
    isContinuation: segment.isContinuation,
    needsNewMessage: segment.startsNewMessage,
    lastMessageId: lastMessage.id,
    lastMessageText: lastMessage.text,
  });
  return { isEditInPlace: plan.shouldEditFirstChunk, chunks: plan.chunks };
}

describe('addPendingOutput / takePendingOutput (the new-message mark belongs to the text queued after it)', () => {
  it('without a mark, batches coalesce into one segment that continues the last message; the first batch decides how it lands', () => {
    const buffer = createEmptyBuffer();
    const mark: NewMessageMark = { needsNewMessage: false };
    addPendingOutput(buffer, mark, { output: 'first ', ...midReplyBatch });
    addPendingOutput(buffer, mark, { output: 'second', isContinuation: false, startsNewParagraph: false });
    assert.deepEqual(buffer.pendingSegments, [{ output: 'first \nsecond', isContinuation: true, startsNewMessage: false }]);
  });

  it('the first segment takes the mark and spends it', () => {
    const buffer = createEmptyBuffer();
    const mark: NewMessageMark = { needsNewMessage: true };
    addPendingOutput(buffer, mark, { output: 'first ', ...midReplyBatch });
    assert.deepEqual(buffer.pendingSegments, [{ output: 'first ', isContinuation: true, startsNewMessage: true }]);
    assert.equal(mark.needsNewMessage, false, 'the mark is spent by the text that took it');
    addPendingOutput(buffer, mark, { output: 'more', ...midReplyBatch });
    assert.equal(buffer.pendingSegments.length, 1, 'later batches of the same turn only append');
    assert.equal(buffer.pendingSegments[0].output, 'first more');
  });

  it('a boundary marked while earlier text is still waiting splits it: the earlier text keeps its place, the new text opens a new message', () => {
    // A mid-reply tail waits out the debounce; the user\'s next prompt is forwarded (the mark is set); the agent\'s next text
    // arrives before the tail flushed. One buffer would edit both into the previous message, ABOVE the prompt.
    const buffer = createEmptyBuffer();
    const mark: NewMessageMark = { needsNewMessage: false };
    addPendingOutput(buffer, mark, { output: 'the end of the previous reply', ...midReplyBatch });
    mark.needsNewMessage = true;
    addPendingOutput(buffer, mark, { output: 'the answer to the prompt', ...midReplyBatch });
    assert.equal(mark.needsNewMessage, false, 'the text after the boundary took the mark');
    assert.deepEqual(buffer.pendingSegments, [
      { output: 'the end of the previous reply', isContinuation: true, startsNewMessage: false },
      { output: 'the answer to the prompt', isContinuation: true, startsNewMessage: true },
    ]);

    const lastMessage = { id: 41, text: 'the previous reply, so far' };
    const first = takePendingOutput(buffer);
    assert.ok(first);
    assert.equal(planTakenSegment(first, lastMessage).isEditInPlace, true, 'the tail still extends the message it belongs to');
    const second = takePendingOutput(buffer);
    assert.ok(second);
    assert.equal(planTakenSegment(second, { id: 41, text: 'the previous reply, so far the end of the previous reply' }).isEditInPlace, false, 'the new turn\'s text is a message of its own');
    assert.equal(takePendingOutput(buffer), null);
  });

  it('a mark spent by a status frame splits the same way (text, tool call, text)', () => {
    const buffer = createEmptyBuffer();
    const mark: NewMessageMark = { needsNewMessage: false };
    addPendingOutput(buffer, mark, { output: 'text before the tool call', ...midReplyBatch });
    mark.needsNewMessage = true; // a status frame was on screen when the next output arrived
    addPendingOutput(buffer, mark, { output: 'text after it', ...midReplyBatch });
    assert.deepEqual(buffer.pendingSegments.map((segment) => segment.startsNewMessage), [false, true]);
  });

  it('a boundary marked while the previous turn\'s text is being sent: the new turn\'s first text still opens a message of its own, whenever the earlier send completes', () => {
    // The CI failure of the usage-limit flow, state by state: the interrupted turn\'s text is taken for a flush that is slow
    // to finish, the work continues (a prompt is forwarded: the boundary is marked), the resumed turn\'s text is queued ...
    const thread = { needsNewMessage: false, lastMessageId: 75 as number | null, lastMessageText: 'Working on LIM-7.' as string | null };
    const buffer = createEmptyBuffer();
    addPendingOutput(buffer, thread, { output: 'Working on LIM-7.', ...midReplyBatch });
    const interrupted = takePendingOutput(buffer);
    assert.ok(interrupted);
    thread.needsNewMessage = true;
    addPendingOutput(buffer, thread, { output: 'Working on LIM-7.', ...midReplyBatch });
    // ... and only now does the earlier send end: it lands and moves the last-message cursor, but it never touches the mark.
    const resumed = takePendingOutput(buffer);
    assert.ok(resumed);
    const plan = planTakenSegment(resumed, { id: thread.lastMessageId, text: thread.lastMessageText });
    assert.equal(plan.isEditInPlace, false, 'a new message, not an edit of the interrupted turn\'s');
    assert.deepEqual(plan.chunks, ['Working on LIM-7.']);
  });

  it('empty output queues nothing and spends no mark', () => {
    const buffer = createEmptyBuffer();
    const mark: NewMessageMark = { needsNewMessage: true };
    addPendingOutput(buffer, mark, { output: '', ...midReplyBatch });
    assert.equal(checkHasPendingOutput(buffer), false);
    assert.equal(mark.needsNewMessage, true);
  });

  it('take hands over the oldest segment with its flags; nothing pending → null', () => {
    const buffer = createEmptyBuffer();
    assert.equal(takePendingOutput(buffer), null);
    addPendingOutput(buffer, { needsNewMessage: true }, { output: 'answer', isContinuation: false, startsNewParagraph: false });
    assert.equal(checkHasPendingOutput(buffer), true);
    assert.deepEqual(takePendingOutput(buffer), { output: 'answer', isContinuation: false, startsNewMessage: true });
    assert.equal(checkHasPendingOutput(buffer), false);
    assert.equal(takePendingOutput(buffer), null);
  });

  it('an unsent remainder goes back to the front as a fresh message and joins the next segment; a segment after a boundary stays apart', () => {
    const alone = createEmptyBuffer();
    requeueUnsentRemainder(alone, 'the part that hit a 429');
    assert.deepEqual(alone.pendingSegments, [{ output: 'the part that hit a 429', isContinuation: false, startsNewMessage: false }]);

    const queuedMeanwhile = createEmptyBuffer();
    addPendingOutput(queuedMeanwhile, { needsNewMessage: false }, { output: 'newer', ...midReplyBatch });
    requeueUnsentRemainder(queuedMeanwhile, 'older');
    assert.deepEqual(queuedMeanwhile.pendingSegments, [{ output: 'older\nnewer', isContinuation: false, startsNewMessage: false }]);

    const behindBoundary = createEmptyBuffer();
    addPendingOutput(behindBoundary, { needsNewMessage: true }, { output: 'the next turn', ...midReplyBatch });
    requeueUnsentRemainder(behindBoundary, 'the previous turn\'s part');
    assert.deepEqual(behindBoundary.pendingSegments, [
      { output: 'the previous turn\'s part', isContinuation: false, startsNewMessage: false },
      { output: 'the next turn', isContinuation: true, startsNewMessage: true },
    ]);
  });
});
