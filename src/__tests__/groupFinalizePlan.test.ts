/**
 * @description S2 — pure decision behind the GROUP output transport's
 * `finalizeInFlight` reconcile (`utils/groupFinalizePlan`). At a settle/teardown
 * boundary the bot must force-deliver the coalesced-but-unsent remainder (so the
 * agent's final answer is never discarded) but must NOT double-post a turn that
 * already fully landed.
 *
 * Load-bearing per `rules/tests.md`: the assertions prove the remainder
 * semantics (what text is sent, and its continuation flag), not just "no crash".
 * The group queue already separates landed (`lastMessageText`) from pending
 * (the pending segments), so the remainder IS the pending segments — these tests pin that a
 * pending buffer drains exactly once, segment by segment as it was queued, and a delivered turn is a no-op.
 *
 * Landing the output ahead of an answer (`landGroupOutput`, `markFlushInFlight`): the text the debounce still holds, and a flush
 * already sending, must reach the topic BEFORE whatever the caller posts next — the segments sent in order, the older flush
 * first — and the queue must be emptied before anything is awaited, because a teardown clears it right after.
 */

import { describe, test, it, mock } from 'node:test';
import * as assert from 'node:assert/strict';
import { getGroupFinalizePlan, landGroupOutput, markFlushInFlight, type GroupFinalizeQueue } from '../utils/groupFinalizePlan';
import type { PendingOutputSegment } from '../connectors/telegram/outputFlushPlan';

function createSegment(output: string, flags: Partial<Omit<PendingOutputSegment, 'output'>> = {}): PendingOutputSegment {
  return { output, isContinuation: false, startsNewMessage: false, ...flags };
}

test('fully-delivered turn (no pending remainder) → noop, no duplicate post', () => {
  assert.deepEqual(getGroupFinalizePlan({ pendingSegments: [] }), { action: 'noop' });
});

test('segments holding only whitespace → noop (a blank send would only earn a Telegram error)', () => {
  assert.deepEqual(getGroupFinalizePlan({ pendingSegments: [createSegment('   \n\t')] }), { action: 'noop' });
});

test('a turn whose last landed text lags → finalize sends exactly the pending remainder', () => {
  const segment = createSegment('the tail that never flushed', { isContinuation: true });
  assert.deepEqual(getGroupFinalizePlan({ pendingSegments: [segment] }), { action: 'send', segments: [segment] });
});

test('a fresh (non-continuation) remainder finalizes as a new message', () => {
  const segment = createSegment('the settled final answer');
  assert.deepEqual(getGroupFinalizePlan({ pendingSegments: [segment] }), { action: 'send', segments: [segment] });
});

test('text queued on both sides of a turn boundary drains as two segments, in order, each with its own mark', () => {
  const beforeBoundary = createSegment('the previous turn\'s tail', { isContinuation: true });
  const afterBoundary = createSegment('the next turn\'s first text', { isContinuation: true, startsNewMessage: true });
  assert.deepEqual(
    getGroupFinalizePlan({ pendingSegments: [beforeBoundary, createSegment('  '), afterBoundary] }),
    { action: 'send', segments: [beforeBoundary, afterBoundary] },
  );
});

/** A queue as `bot.ts` keeps it: pending segments, an armed debounce timer and no flush sending. */
function createQueue(pendingSegments: PendingOutputSegment[], debounceTimer: NodeJS.Timeout | null = null): GroupFinalizeQueue {
  return { pendingSegments, debounceTimer, flushSettled: null };
}

/** A promise settled by hand, for a flush the test holds open. */
function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

describe('landGroupOutput', () => {
  it('sends the pending segments in order and reports nothing dropped', async () => {
    const first = createSegment('the first text');
    const second = createSegment('the next turn\'s text', { isContinuation: true, startsNewMessage: true });
    const queue = createQueue([first, second]);
    const sent: PendingOutputSegment[] = [];

    const outcome = await landGroupOutput(queue, async (segment) => { sent.push(segment); return { unsentRemainder: null }; });

    assert.deepEqual(sent, [first, second]);
    assert.deepEqual(outcome, { isRemainderDropped: false });
    assert.deepEqual(queue.pendingSegments, []);
  });

  it('empties the queue and clears the debounce timer BEFORE the first await, so a teardown that clears right after finds nothing', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let isDebounceFired = false;
      const queue = createQueue([createSegment('held by the debounce')], setTimeout(() => { isDebounceFired = true; }, 3000));
      const sendGate = createDeferred();
      const sent: string[] = [];

      const landing = landGroupOutput(queue, async (segment) => {
        await sendGate.promise;
        sent.push(segment.output);
        return { unsentRemainder: null };
      });

      // The caller's own turn has not yielded yet: the state is already taken.
      assert.deepEqual(queue.pendingSegments, []);
      assert.equal(queue.debounceTimer, null);
      mock.timers.tick(3000);
      assert.equal(isDebounceFired, false, 'the cleared debounce timer never fires');
      sendGate.resolve();
      await landing;
      assert.deepEqual(sent, ['held by the debounce']);
    } finally {
      mock.timers.reset();
    }
  });

  it('waits for the flush that is already sending before it sends its segments: the older text lands first', async () => {
    const queue = createQueue([createSegment('queued while the flush was sending')]);
    const endFlush = markFlushInFlight(queue);
    const events: string[] = [];

    const landing = landGroupOutput(queue, async (segment) => { events.push(`sent: ${segment.output}`); return { unsentRemainder: null }; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(events.length, 0, 'nothing is sent while the older flush is still sending');

    events.push('the older flush landed');
    endFlush();
    await landing;
    assert.deepEqual(events, ['the older flush landed', 'sent: queued while the flush was sending']);
  });

  it('with nothing pending it still waits for the flush that is sending: the text that flush took must land above what follows', async () => {
    const queue = createQueue([]);
    const endFlush = markFlushInFlight(queue);
    let isLanded = false;

    const landing = landGroupOutput(queue, async () => { assert.fail('there is nothing to send'); }).then(() => { isLanded = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(isLanded, false, 'the landing is not over while the flush is sending');

    endFlush();
    await landing;
    assert.equal(isLanded, true);
  });

  it('with nothing pending and no flush sending it returns at once and sends nothing', async () => {
    const queue = createQueue([createSegment('  ')]);

    assert.deepEqual(await landGroupOutput(queue, async () => { assert.fail('a blank segment is never sent'); }), { isRemainderDropped: false });
  });

  it('a segment a 429 kept from landing ends the run: everything behind it is dropped and the caller is told', async () => {
    const queue = createQueue([createSegment('landed'), createSegment('dropped by a 429'), createSegment('behind the dropped one')]);
    const attempted: string[] = [];

    const outcome = await landGroupOutput(queue, async (segment) => {
      attempted.push(segment.output);
      return { unsentRemainder: segment.output === 'dropped by a 429' ? segment.output : null };
    });

    assert.deepEqual(attempted, ['landed', 'dropped by a 429']);
    assert.deepEqual(outcome, { isRemainderDropped: true });
  });
});

describe('markFlushInFlight', () => {
  it('holds a promise while the flush sends and clears it, resolved, when the flush ends', async () => {
    const queue = createQueue([]);
    assert.equal(queue.flushSettled, null);

    const endFlush = markFlushInFlight(queue);
    const settled = queue.flushSettled;
    assert.ok(settled, 'a flush is recorded as sending');

    endFlush();
    assert.equal(queue.flushSettled, null);
    await settled;
  });
});
