/**
 * @description A Telegram topic's group-mode output backlog (`utils/groupOutputBacklog.ts`): one ordered backlog, one send loop,
 * and the waits of the posts that must come after the text. The cases are the sequences a real topic meets, alone and
 * together — a landing for an answer while the debounce holds text, two landings at once, a 429 leftover, a stop, a send
 * that throws — each asserting the exact order of the sends and when each wait ends.
 *
 * Load-bearing per `rules/tests.md`: every case reads the order of the sends a fake `sendSegment` records, the moment a
 * landing resolves against them, and what is left queued.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it, mock } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  createGroupOutputBacklog,
  drainGroupOutput,
  landGroupOutput,
  startFinalGroupOutputAttempt,
  type GroupOutputBacklog,
  type GroupOutputDrainDeps,
} from '../utils/groupOutputBacklog';
import { addPendingOutput, getNewestPendingSeq, type PendingOutputSegment } from '../connectors/telegram/outputFlushPlan';

/** A batch of streamed text, queued the way `queueOutput` queues it (no new-message mark). */
function queueText(backlog: GroupOutputBacklog, output: string): void {
  addPendingOutput(backlog, { needsNewMessage: false }, { output, isContinuation: false, startsNewParagraph: false });
}

/** A batch that opens a message of its own (a turn boundary was marked before it): always a segment of its own. */
function queueNewMessageText(backlog: GroupOutputBacklog, output: string): void {
  addPendingOutput(backlog, { needsNewMessage: true }, { output, isContinuation: false, startsNewParagraph: false });
}

/** A promise settled by hand, for a send the test holds open. */
function createGate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

/** Let every promise reaction already queued run. */
function settleReactions(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Drain deps that record what was sent and what happened, in one ordered event list. `remainders` maps a text to what a 429
 * keeps of it (its first send only); `gates` hold the send of a text until opened; `throwing` texts make the send throw.
 */
function createRecorder(options: { remainders?: Record<string, string>; gates?: Record<string, Promise<void>>; throwing?: string[]; refused?: string[] } = {}) {
  const events: string[] = [];
  const remainders = { ...options.remainders };
  let stallCount = 0;
  const deps: GroupOutputDrainDeps = {
    sendSegment: async (segment: PendingOutputSegment) => {
      events.push(`send ${segment.output}`);
      const gate = options.gates?.[segment.output];
      if (gate) await gate;
      if (options.throwing?.includes(segment.output)) throw new Error(`the send of ${segment.output} threw`);
      if (options.refused?.includes(segment.output)) {
        events.push(`refused ${segment.output}`);
        return { unsentRemainder: segment.output, isRetryable: false };
      }
      const remainder = remainders[segment.output];
      if (remainder !== undefined) {
        delete remainders[segment.output];
        events.push(`429 keeps ${remainder}`);
        return { unsentRemainder: remainder, isRetryable: true };
      }
      return { unsentRemainder: null };
    },
    onStalled: () => {
      stallCount += 1;
      events.push('stalled');
    },
    onDropped: (_segment, unsentRemainder, reason) => { events.push(reason === 'refused' ? `dropped as refused ${unsentRemainder}` : `dropped ${unsentRemainder}`); },
    onSendError: (error) => { events.push(`error ${error.message}`); },
  };
  return { deps, events, getStallCount: () => stallCount };
}

/** The retry the bot arms on a stall: send everything queued so far. */
function retry(backlog: GroupOutputBacklog, deps: GroupOutputDrainDeps): void {
  drainGroupOutput(backlog, getNewestPendingSeq(backlog), deps);
}

describe('landGroupOutput', () => {
  it('sends what the debounce holds, in order, and resolves once it has landed', async () => {
    const backlog = createGroupOutputBacklog();
    queueText(backlog, 'first');
    queueNewMessageText(backlog, 'second');
    const recorder = createRecorder();

    await landGroupOutput(backlog, recorder.deps);

    assert.deepEqual(recorder.events, ['send first', 'send second']);
    assert.deepEqual(backlog.pendingSegments, []);
    assert.equal(backlog.isDraining, false);
  });

  it('clears the debounce timer: the text it waited for is sent now', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let isDebounceFired = false;
      const backlog = createGroupOutputBacklog();
      queueText(backlog, 'held by the debounce');
      backlog.debounceTimer = setTimeout(() => { isDebounceFired = true; }, 3000);
      const recorder = createRecorder();

      const landing = landGroupOutput(backlog, recorder.deps);
      assert.equal(backlog.debounceTimer, null);
      mock.timers.tick(3000);
      await landing;

      assert.equal(isDebounceFired, false);
      assert.deepEqual(recorder.events, ['send held by the debounce']);
    } finally {
      mock.timers.reset();
    }
  });

  it('with nothing queued it still waits for the segment being sent: its text must land above what follows', async () => {
    const backlog = createGroupOutputBacklog();
    queueText(backlog, 'being sent');
    const gate = createGate();
    const recorder = createRecorder({ gates: { 'being sent': gate.promise } });
    retry(backlog, recorder.deps);
    let isLanded = false;

    const landing = landGroupOutput(backlog, recorder.deps).then(() => { isLanded = true; });
    await settleReactions();
    assert.equal(isLanded, false, 'not over while that send is going out');

    gate.open();
    await landing;
    assert.equal(isLanded, true);
    assert.deepEqual(recorder.events, ['send being sent'], 'sent once');
  });

  it('two landings at once: one send at a time, in order, and each resolves once ITS text has landed', async () => {
    const backlog = createGroupOutputBacklog();
    queueText(backlog, 'A');
    const gate = createGate();
    const recorder = createRecorder({ gates: { A: gate.promise } });
    const order: string[] = [];

    const first = landGroupOutput(backlog, recorder.deps).then(() => { order.push('first landing over'); });
    queueText(backlog, 'B');
    const second = landGroupOutput(backlog, recorder.deps).then(() => { order.push('second landing over'); });
    await settleReactions();
    assert.deepEqual(recorder.events, ['send A'], 'B waits for A');

    gate.open();
    await Promise.all([first, second]);
    assert.deepEqual(recorder.events, ['send A', 'send B'], 'B, queued after the first landing sealed A, is a segment of its own');
    assert.deepEqual(order, ['first landing over', 'second landing over']);
  });

  it('two landings and a 429 (the reviewer\'s sequence): the leftover goes out first, then B, then C — and each answer only after its text', async () => {
    // L1 takes [A, B]; A is being sent; C arrives and L2 waits for it; A's send returns a leftover A′.
    const backlog = createGroupOutputBacklog();
    queueText(backlog, 'A');
    queueNewMessageText(backlog, 'B');
    const gate = createGate();
    const recorder = createRecorder({ gates: { A: gate.promise }, remainders: { A: 'A-prime' } });
    const first = landGroupOutput(backlog, recorder.deps).then(() => { recorder.events.push('answer of the first landing'); });
    queueNewMessageText(backlog, 'C');
    const second = landGroupOutput(backlog, recorder.deps).then(() => { recorder.events.push('answer of the second landing'); });

    gate.open();
    await settleReactions();
    assert.deepEqual(recorder.events, ['send A', '429 keeps A-prime', 'stalled'], 'the loop stops at the 429; nothing passes the leftover');
    assert.deepEqual(backlog.pendingSegments.map((segment) => segment.output), ['A-prime', 'B', 'C'], 'the leftover is at the head, ahead of all later text');

    retry(backlog, recorder.deps);
    await Promise.all([first, second]);
    const sends = recorder.events.filter((event) => event.startsWith('send '));
    assert.deepEqual(sends, ['send A', 'send A-prime', 'send B', 'send C']);
    // Each answer only after ITS text: C was queued after the first landing sealed its text, so it is not the first answer's.
    const indexOf = (event: string): number => recorder.events.indexOf(event);
    assert.ok(indexOf('answer of the first landing') > indexOf('send B'), recorder.events.join(' | '));
    assert.ok(indexOf('answer of the second landing') > indexOf('send C'), recorder.events.join(' | '));
  });

  it('text queued after a landing sealed its segment is not sent by it: it waits for its own debounce', async () => {
    const backlog = createGroupOutputBacklog();
    queueText(backlog, 'before the answer');
    const gate = createGate();
    const recorder = createRecorder({ gates: { 'before the answer': gate.promise } });

    const landing = landGroupOutput(backlog, recorder.deps);
    queueText(backlog, 'after the answer');
    gate.open();
    await landing;
    await settleReactions();

    assert.deepEqual(recorder.events, ['send before the answer']);
    assert.deepEqual(backlog.pendingSegments.map((segment) => segment.output), ['after the answer'], 'a segment of its own, still queued');
  });

  it('a send that throws counts as sent: logged, never sent again, and the landing still ends', async () => {
    const backlog = createGroupOutputBacklog();
    queueText(backlog, 'X');
    queueNewMessageText(backlog, 'Y');
    const recorder = createRecorder({ throwing: ['X'] });

    await landGroupOutput(backlog, recorder.deps);

    assert.deepEqual(recorder.events, ['send X', 'error the send of X threw', 'send Y']);
  });

  it('a blank segment settles without a send', async () => {
    const backlog = createGroupOutputBacklog();
    queueText(backlog, '   ');
    const recorder = createRecorder();

    await landGroupOutput(backlog, recorder.deps);

    assert.deepEqual(recorder.events, []);
  });
});

describe('drainGroupOutput (the debounce flush and its retry)', () => {
  it('a flush asked for while the loop sends only moves its target on: one send at a time, in order', async () => {
    const backlog = createGroupOutputBacklog();
    queueText(backlog, 'A');
    const gate = createGate();
    const recorder = createRecorder({ gates: { A: gate.promise } });
    retry(backlog, recorder.deps);
    queueNewMessageText(backlog, 'B');
    retry(backlog, recorder.deps);
    await settleReactions();
    assert.deepEqual(recorder.events, ['send A']);

    gate.open();
    await landGroupOutput(backlog, recorder.deps);
    assert.deepEqual(recorder.events, ['send A', 'send B']);
  });

  it('a 429 puts the leftover back at the head, under its own number, and stops the loop until the retry', async () => {
    const backlog = createGroupOutputBacklog();
    queueText(backlog, 'A');
    queueNewMessageText(backlog, 'B');
    const recorder = createRecorder({ remainders: { A: 'A-prime' } });

    retry(backlog, recorder.deps);
    await settleReactions();

    assert.equal(recorder.getStallCount(), 1);
    assert.deepEqual(backlog.pendingSegments.map((segment) => segment.output), ['A-prime', 'B']);
    assert.equal(backlog.settledSeq, 0, 'A has not landed yet');
    retry(backlog, recorder.deps);
    await landGroupOutput(backlog, recorder.deps);
    assert.deepEqual(recorder.events, ['send A', '429 keeps A-prime', 'stalled', 'send A-prime', 'send B']);
  });
});

describe('a send Telegram refused for good (a closed topic, a 4xx that is not a 429)', () => {
  it('is dropped with its own reason — not put back, not retried — and the loop goes on with the next text', async () => {
    const backlog = createGroupOutputBacklog();
    queueText(backlog, 'A');
    queueNewMessageText(backlog, 'B');
    const recorder = createRecorder({ refused: ['A'] });

    await landGroupOutput(backlog, recorder.deps);

    assert.deepEqual(recorder.events, ['send A', 'refused A', 'dropped as refused A', 'send B']);
    assert.equal(recorder.getStallCount(), 0, 'no retry armed');
    assert.deepEqual(backlog.pendingSegments, []);
  });
});

describe('startFinalGroupOutputAttempt (a stop)', () => {
  it('a leftover a stalled flush put back gets its final attempt — the teardown sequence: land, final attempt, then the clear of the status frame', async () => {
    const backlog = createGroupOutputBacklog();
    queueText(backlog, 'A');
    const recorder = createRecorder({ remainders: { A: 'A-prime' } });
    retry(backlog, recorder.deps);
    await settleReactions();
    assert.deepEqual(backlog.pendingSegments.map((segment) => segment.output), ['A-prime'], 'precondition: the leftover waits for its retry');

    const finalAttempt = startFinalGroupOutputAttempt(backlog, recorder.deps);
    const landing = landGroupOutput(backlog, recorder.deps);
    await Promise.all([finalAttempt, landing]);

    assert.deepEqual(recorder.events, ['send A', '429 keeps A-prime', 'stalled', 'send A-prime'], 'the leftover went out once more');
    assert.deepEqual(backlog.pendingSegments, []);
  });

  it('a 429 on the final attempt drops what is left of that text and goes on with the next: nothing is retried after the stop', async () => {
    const backlog = createGroupOutputBacklog();
    queueText(backlog, 'A');
    queueNewMessageText(backlog, 'B');
    const recorder = createRecorder({ remainders: { A: 'A-prime' } });

    await startFinalGroupOutputAttempt(backlog, recorder.deps);

    assert.deepEqual(recorder.events, ['send A', '429 keeps A-prime', 'dropped A-prime', 'send B']);
    assert.equal(recorder.getStallCount(), 0);
    assert.deepEqual(backlog.pendingSegments, []);
  });

  it('a stop while a landing waits behind a send under way: the send that 429s is dropped, both waits end', async () => {
    const backlog = createGroupOutputBacklog();
    queueText(backlog, 'A');
    const gate = createGate();
    const recorder = createRecorder({ gates: { A: gate.promise }, remainders: { A: 'A-prime' } });
    const landing = landGroupOutput(backlog, recorder.deps);

    const finalAttempt = startFinalGroupOutputAttempt(backlog, recorder.deps);
    gate.open();
    await Promise.all([landing, finalAttempt]);

    assert.deepEqual(recorder.events, ['send A', '429 keeps A-prime', 'dropped A-prime']);
  });

  it('text queued after the stop is the next session\'s: a 429 on it is retried as usual', async () => {
    const backlog = createGroupOutputBacklog();
    queueText(backlog, 'old session');
    const recorder = createRecorder({ remainders: { 'new session': 'new-prime' } });
    await startFinalGroupOutputAttempt(backlog, recorder.deps);
    queueNewMessageText(backlog, 'new session');

    retry(backlog, recorder.deps);
    await settleReactions();

    assert.deepEqual(recorder.events, ['send old session', 'send new session', '429 keeps new-prime', 'stalled']);
    assert.deepEqual(backlog.pendingSegments.map((segment) => segment.output), ['new-prime']);
  });
});
