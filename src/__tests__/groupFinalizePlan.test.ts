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
 * Landing the output ahead of what is posted next (`landGroupOutput`, `flushNextPendingOutput`, `runInSendChain`): the text the
 * debounce still holds, a flush already sending and a landing already sending must all reach the topic BEFORE it — every send of
 * a topic's output runs one after the other, in the order it was started (the segments in order; an older send first; the 429
 * leftover of a flush ahead of what a landing took, and never mixed up with text written after it) — a 429 that stops a landing
 * puts what it could not send back for a retry, unless the queue was cleared meanwhile (a stop) — and the queue must be emptied
 * before anything is awaited, because a teardown clears it right after.
 */

import { describe, test, it, mock } from 'node:test';
import * as assert from 'node:assert/strict';
import { createGroupFinalizeQueue, flushNextPendingOutput, getGroupFinalizePlan, landGroupOutput, runInSendChain, type GroupFinalizeQueue } from '../utils/groupFinalizePlan';
import { clearThreadOutputQueues } from '../utils/clearThreadOutputQueues';
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

/** A queue as `bot.ts` keeps it, with the given pending segments and an armed debounce timer, if any. */
function createQueue(pendingSegments: PendingOutputSegment[], debounceTimer: NodeJS.Timeout | null = null): GroupFinalizeQueue {
  return { ...createGroupFinalizeQueue(), pendingSegments, debounceTimer };
}

/** A promise settled by hand, for a send the test holds open. */
function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

/** Let every promise reaction already queued run. */
function settleReactions(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

describe('runInSendChain', () => {
  it('runs the sends one after the other, in the order they were asked for, whatever each takes', async () => {
    const queue = createQueue([]);
    const firstGate = createDeferred();
    const events: string[] = [];

    const first = runInSendChain(queue, async () => { events.push('first starts'); await firstGate.promise; events.push('first ends'); });
    const second = runInSendChain(queue, async () => { events.push('second starts'); events.push('second ends'); });
    await settleReactions();
    assert.deepEqual(events, ['first starts'], 'the second waits for the first');

    firstGate.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(events, ['first starts', 'first ends', 'second starts', 'second ends']);
  });

  it('a send that fails reaches only its own caller: the sends behind it still run', async () => {
    const queue = createQueue([]);
    const failed = runInSendChain(queue, async () => { throw new Error('the send path is down'); });
    const later = runInSendChain(queue, async () => 'ran');

    await assert.rejects(failed, /the send path is down/);
    assert.equal(await later, 'ran');
  });
});

describe('landGroupOutput', () => {
  it('sends the pending segments in order and reports them landed', async () => {
    const first = createSegment('the first text');
    const second = createSegment('the next turn\'s text', { isContinuation: true, startsNewMessage: true });
    const queue = createQueue([first, second]);
    const sent: PendingOutputSegment[] = [];

    const outcome = await landGroupOutput(queue, async (segment) => { sent.push(segment); return { unsentRemainder: null }; });

    assert.deepEqual(sent, [first, second]);
    assert.equal(outcome, 'landed');
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
    const queue = createQueue([createSegment('the debounce flush\'s text'), createSegment('queued while it was sending', { startsNewMessage: true })]);
    const flushGate = createDeferred();
    const events: string[] = [];
    const flush = runInSendChain(queue, () => flushNextPendingOutput(queue, async (segment) => {
      events.push(`flush sends: ${segment.output}`);
      await flushGate.promise;
      return { unsentRemainder: null };
    }));
    await settleReactions();

    const landing = landGroupOutput(queue, async (segment) => { events.push(`landing sends: ${segment.output}`); return { unsentRemainder: null }; });
    await settleReactions();
    assert.deepEqual(events, ['flush sends: the debounce flush\'s text'], 'nothing is sent while the older flush is still sending');

    flushGate.resolve();
    await Promise.all([flush, landing]);
    assert.deepEqual(events, ['flush sends: the debounce flush\'s text', 'landing sends: queued while it was sending']);
  });

  it('with nothing pending it still waits for a send that is going out: the text it carries must land above what follows', async () => {
    const queue = createQueue([]);
    const sendGate = createDeferred();
    const earlierSend = runInSendChain(queue, () => sendGate.promise);
    let isLanded = false;

    const landing = landGroupOutput(queue, async () => { assert.fail('there is nothing to send'); }).then(() => { isLanded = true; });
    await settleReactions();
    assert.equal(isLanded, false, 'the landing is not over while that send is going out');

    sendGate.resolve();
    await Promise.all([earlierSend, landing]);
    assert.equal(isLanded, true);
  });

  it('two landings at once are one after the other: the second does not end — nor start sending — before the first one\'s sends have landed', async () => {
    // A tool call's status frame lands the text, and the tool's own request lands what the adapter had not emitted yet: both
    // are landings, and the answer behind the second one must not pass the first one's still-sending segments.
    const queue = createQueue([createSegment('the text the status frame lands')]);
    const firstGate = createDeferred();
    const events: string[] = [];
    const firstLanding = landGroupOutput(queue, async (segment) => {
      events.push(`first sends: ${segment.output}`);
      await firstGate.promise;
      events.push('first sent');
      return { unsentRemainder: null };
    });
    queue.pendingSegments.push(createSegment('the text the request lands', { startsNewMessage: true }));
    const secondLanding = landGroupOutput(queue, async (segment) => { events.push(`second sends: ${segment.output}`); return { unsentRemainder: null }; }).then(() => { events.push('second ended'); });
    await settleReactions();
    assert.deepEqual(events, ['first sends: the text the status frame lands'], 'the second landing waits for the first');

    firstGate.resolve();
    await Promise.all([firstLanding, secondLanding]);
    assert.deepEqual(events, ['first sends: the text the status frame lands', 'first sent', 'second sends: the text the request lands', 'second ended']);
  });

  it('a debounce flush that starts while a landing is sending waits for it: the landing\'s text is older', async () => {
    const queue = createQueue([createSegment('taken by the landing')]);
    const landingGate = createDeferred();
    const events: string[] = [];
    const landing = landGroupOutput(queue, async (segment) => { events.push(`landing sends: ${segment.output}`); await landingGate.promise; return { unsentRemainder: null }; });
    queue.pendingSegments.push(createSegment('queued after the landing took its text', { startsNewMessage: true }));

    const flush = runInSendChain(queue, () => flushNextPendingOutput(queue, async (segment) => { events.push(`flush sends: ${segment.output}`); return { unsentRemainder: null }; }));
    await settleReactions();
    assert.deepEqual(events, ['landing sends: taken by the landing']);

    landingGate.resolve();
    await Promise.all([landing, flush]);
    assert.deepEqual(events, ['landing sends: taken by the landing', 'flush sends: queued after the landing took its text']);
  });

  it('the 429 leftover of the flush it waited for goes out FIRST, and text written after the landing took its own stays pending, in order', async () => {
    // Flush F is sending A and hits a 429; the landing L takes B and waits behind it; the agent writes C meanwhile.
    const queue = createQueue([createSegment('A'), createSegment('B', { startsNewMessage: true })]);
    const flushGate = createDeferred();
    const sentTexts: string[] = [];
    const flush = runInSendChain(queue, () => flushNextPendingOutput(queue, async () => {
      await flushGate.promise;
      return { unsentRemainder: 'A-prime' };
    }));
    await settleReactions();
    const landing = landGroupOutput(queue, async (segment) => { sentTexts.push(segment.output); return { unsentRemainder: null }; });
    queue.pendingSegments.push(createSegment('C', { startsNewMessage: true }));

    flushGate.resolve();
    await Promise.all([flush, landing]);

    assert.deepEqual(sentTexts, ['A-prime', 'B'], 'the leftover, then what the landing took — not C, which is newer than B');
    assert.deepEqual(queue.pendingSegments.map((segment) => segment.output), ['C']);
    assert.equal(queue.requeuedRemainder, null);
  });

  it('a segment a 429 kept from landing is put back for the retry — its text at the head, the segments behind it after it, before newer text', async () => {
    const queue = createQueue([createSegment('landed'), createSegment('hit by a 429'), createSegment('behind it', { startsNewMessage: true })]);
    const attempted: string[] = [];
    const landing = landGroupOutput(queue, async (segment) => {
      attempted.push(segment.output);
      return { unsentRemainder: segment.output === 'hit by a 429' ? 'the part a 429 kept back' : null };
    });
    queue.pendingSegments.push(createSegment('newer', { startsNewMessage: true }));

    const outcome = await landing;

    assert.deepEqual(attempted, ['landed', 'hit by a 429'], 'the run ends at the failure');
    assert.equal(outcome, 'restoredForRetry');
    assert.equal(queue.requeuedRemainder, 'the part a 429 kept back');
    assert.deepEqual(queue.pendingSegments.map((segment) => segment.output), ['behind it', 'newer']);
  });

  it('a segment a 429 kept from landing is dropped when the queue was cleared meanwhile: a stop leaves nothing to post after it', async () => {
    const queue = createQueue([createSegment('hit by a 429'), createSegment('behind it')]);

    const outcome = await landGroupOutput(queue, async () => {
      clearThreadOutputQueues(queue, undefined);
      return { unsentRemainder: 'the part a 429 kept back' };
    });

    assert.equal(outcome, 'dropped');
    assert.equal(queue.requeuedRemainder, null);
    assert.deepEqual(queue.pendingSegments, []);
  });

  it('with only blank segments pending it sends nothing and returns at once', async () => {
    const queue = createQueue([createSegment('  ')]);

    assert.equal(await landGroupOutput(queue, async () => { assert.fail('a blank segment is never sent'); }), 'landed');
  });
});

describe('flushNextPendingOutput', () => {
  it('sends the oldest segment only and leaves the rest for the next flush', async () => {
    const oldest = createSegment('the oldest');
    const next = createSegment('the next', { startsNewMessage: true });
    const queue = createQueue([oldest, next]);
    const sent: PendingOutputSegment[] = [];

    await flushNextPendingOutput(queue, async (segment) => { sent.push(segment); return { unsentRemainder: null }; });

    assert.deepEqual(sent, [oldest]);
    assert.deepEqual(queue.pendingSegments, [next]);
  });

  it('with nothing pending it sends nothing', async () => {
    await flushNextPendingOutput(createQueue([]), async () => { assert.fail('there is nothing to send'); });
  });

  it('keeps the text a 429 kept from landing apart from the pending segments, for the next flush or landing to send first', async () => {
    const queue = createQueue([createSegment('the flush\'s text'), createSegment('queued behind it', { startsNewMessage: true })]);

    await flushNextPendingOutput(queue, async () => ({ unsentRemainder: 'the kept part' }));

    assert.equal(queue.requeuedRemainder, 'the kept part');
    assert.deepEqual(queue.pendingSegments.map((segment) => segment.output), ['queued behind it']);
  });

  it('the next flush sends the leftover first, and not twice', async () => {
    const queue = createQueue([createSegment('the next turn\'s text', { startsNewMessage: true })]);
    queue.requeuedRemainder = 'the kept part';
    const sent: string[] = [];

    await flushNextPendingOutput(queue, async (segment) => { sent.push(segment.output); return { unsentRemainder: null }; });
    await flushNextPendingOutput(queue, async (segment) => { sent.push(segment.output); return { unsentRemainder: null }; });

    assert.deepEqual(sent, ['the kept part', 'the next turn\'s text']);
    assert.equal(queue.requeuedRemainder, null);
  });
});
