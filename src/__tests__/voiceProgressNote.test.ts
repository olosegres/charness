/**
 * @description The «transcribing…» note of a voice message, on fake timers: a text that arrives before the delay shows
 * nothing; a text that is late gets a note that is deleted the moment the text (or the failure) arrives; a cleanup that stalls
 * never holds the answer back for more than its budget and ends by itself later; the races around the send; the shutdown of the
 * bot, which stops notes that have not posted yet and cleans the ones that have; and a port that throws never fails the voice.
 * Exact thresholds live HERE — the flow (`voiceProgressNoteE2e.test.ts`) drives the real voice path with gates and checks the
 * order of events by timestamps taken where they happen. How `bot.ts` posts, tracks and deletes the message is checked by the
 * flow and by `sttVoiceWiring.test.ts`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  createVoiceProgressNote,
  createVoiceProgressNoteRegistry,
  voiceProgressNoteCleanupBudgetMs,
  voiceProgressNoteDelayMs,
  type VoiceProgressNotePorts,
} from '../voiceProgressNote';

const testDelayMs = 3_000;
const testBudgetMs = 1_000;
const testOptions = { delayMs: testDelayMs, cleanupBudgetMs: testBudgetMs };
const noteMessageId = 4242;

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve: (value: Value) => void;
}

function createDeferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

/** Let every promise continuation that is already due run (the timers are faked, `setImmediate` is not). */
async function settlePromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

interface Harness {
  ports: VoiceProgressNotePorts;
  posts: number;
  signals: AbortSignal[];
  remembered: number[];
  deletedIds: number[];
  problems: string[];
}

function createHarness(overrides: Partial<VoiceProgressNotePorts> = {}): Harness {
  const harness: Harness = {
    posts: 0,
    signals: [],
    remembered: [],
    deletedIds: [],
    problems: [],
    ports: {
      postNote: async (signal) => {
        harness.posts += 1;
        harness.signals.push(signal);
        return noteMessageId;
      },
      rememberNote: (messageId) => { harness.remembered.push(messageId); },
      deleteNote: async (messageId) => { harness.deletedIds.push(messageId); },
      logProblem: (line) => { harness.problems.push(line); },
      ...overrides,
    },
  };
  return harness;
}

/** Whether `pending` has settled, without waiting for it. */
async function checkIsSettled(pending: Promise<unknown>): Promise<boolean> {
  let isSettled = false;
  void pending.then(() => { isSettled = true; });
  await settlePromises();
  return isSettled;
}

describe('the transcribing note of a voice message', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
  afterEach(() => mock.timers.reset());

  it('shows nothing when the text arrives before the delay (a warm engine)', async () => {
    const harness = createHarness();
    const note = createVoiceProgressNote(harness.ports, testOptions);

    mock.timers.tick(testDelayMs - 1);
    await settlePromises();
    await note.finish();
    mock.timers.tick(testDelayMs * 2);
    await settlePromises();

    assert.equal(harness.posts, 0, 'no note, not even after the delay has passed: finish() cancelled it');
    assert.deepEqual(harness.deletedIds, [], 'and nothing to delete');
  });

  it('posts the note once the delay is over — not a millisecond earlier — and deletes it when the text arrives', async () => {
    const harness = createHarness();
    const note = createVoiceProgressNote(harness.ports, testOptions);

    mock.timers.tick(testDelayMs - 1);
    await settlePromises();
    assert.equal(harness.posts, 0, 'still waiting at delay − 1 ms');

    mock.timers.tick(1);
    await settlePromises();
    assert.equal(harness.posts, 1, 'the note is up at the delay');
    assert.deepEqual(harness.remembered, [noteMessageId], 'and remembered for a restart to clean up');
    assert.deepEqual(harness.deletedIds, [], 'it stays while the text is not here');

    mock.timers.tick(testDelayMs * 10);
    await settlePromises();
    assert.equal(harness.posts, 1, 'a long wait posts no second note');

    await note.finish();
    assert.deepEqual(harness.deletedIds, [noteMessageId], 'the text arrived: the note is deleted');
  });

  it('deletes the note when the voice fails, like when it succeeds: finish() is the one end of the wait', async () => {
    const harness = createHarness();
    const note = createVoiceProgressNote(harness.ports, testOptions);
    mock.timers.tick(testDelayMs);
    await settlePromises();

    // The job's transcription rejects; its error path ends the wait before the failure notice goes out.
    const failedTranscription = Promise.reject(new Error('the local engine exited before it was ready'));
    await failedTranscription.catch(() => note.finish());

    assert.deepEqual(harness.deletedIds, [noteMessageId]);
  });

  it('finish() twice deletes the note once', async () => {
    const harness = createHarness();
    const note = createVoiceProgressNote(harness.ports, testOptions);
    mock.timers.tick(testDelayMs);
    await settlePromises();

    await note.finish();
    await note.finish();

    assert.deepEqual(harness.deletedIds, [noteMessageId]);
  });

  it('finish() resolves only after the delete is done — the answer that follows it comes after the note is gone', async () => {
    const deletion = createDeferred<void>();
    const harness = createHarness({ deleteNote: async (messageId) => { harness.deletedIds.push(messageId); await deletion.promise; } });
    const note = createVoiceProgressNote(harness.ports, testOptions);
    mock.timers.tick(testDelayMs);
    await settlePromises();

    const finishing = note.finish();
    assert.equal(await checkIsSettled(finishing), false, 'the delete is still going: the answer must wait');
    deletion.resolve();
    await finishing;

    assert.deepEqual(harness.deletedIds, [noteMessageId]);
  });

  describe('a cleanup that stalls', () => {
    it('a delete that hangs holds the answer back for the budget, not longer, and finishes in the background', async () => {
      const deletion = createDeferred<void>();
      let isDeleted = false;
      const harness = createHarness({ deleteNote: async () => { await deletion.promise; isDeleted = true; } });
      const note = createVoiceProgressNote(harness.ports, testOptions);
      mock.timers.tick(testDelayMs);
      await settlePromises();

      const finishing = note.finish();
      mock.timers.tick(testBudgetMs - 1);
      assert.equal(await checkIsSettled(finishing), false, 'one millisecond short of the budget the answer still waits');
      mock.timers.tick(1);
      assert.equal(await checkIsSettled(finishing), true, 'at the budget the answer goes on');
      assert.equal(isDeleted, false, 'the delete is still hanging');

      deletion.resolve();
      await settlePromises();
      assert.equal(isDeleted, true, 'and it ended on its own later');
    });

    it('a send in flight is waited for within the budget: the note that lands is deleted, never remembered as live', async () => {
      const send = createDeferred<number | null>();
      const harness = createHarness({ postNote: async () => { harness.posts += 1; return send.promise; } });
      const note = createVoiceProgressNote(harness.ports, testOptions);
      mock.timers.tick(testDelayMs);
      await settlePromises();
      assert.equal(harness.posts, 1, 'the send is in flight');

      const finishing = note.finish();
      const finishingAgain = note.finish();
      assert.equal(await checkIsSettled(finishing), false, 'nothing to delete yet, and the answer waits for the send');
      assert.deepEqual(harness.deletedIds, []);

      send.resolve(noteMessageId);
      await Promise.all([finishing, finishingAgain]);

      assert.deepEqual(harness.deletedIds, [noteMessageId], 'deleted once, when it landed');
      assert.deepEqual(harness.remembered, [], 'a note nobody wants any more is not registered for a restart');
    });

    it('a send that hangs past the budget lets the answer go, and the note that lands late is still deleted, never remembered', async () => {
      const send = createDeferred<number | null>();
      const harness = createHarness({ postNote: async () => { harness.posts += 1; return send.promise; } });
      const note = createVoiceProgressNote(harness.ports, testOptions);
      mock.timers.tick(testDelayMs);
      await settlePromises();

      const finishing = note.finish();
      mock.timers.tick(testBudgetMs);
      assert.equal(await checkIsSettled(finishing), true, 'the answer is not held by a cosmetic send');
      assert.deepEqual(harness.deletedIds, []);

      send.resolve(noteMessageId);
      await settlePromises();

      assert.deepEqual(harness.deletedIds, [noteMessageId], 'the late note is gone as soon as it lands');
      assert.deepEqual(harness.remembered, []);
    });

    it('finish() cancels a send that has not started yet and says nothing about the cancelled send', async () => {
      // A send waiting out a 429 rejects when its signal aborts, like `withRateLimitRetry` does.
      const harness = createHarness({
        postNote: (signal) => new Promise<number | null>((_resolve, reject) => {
          harness.posts += 1;
          harness.signals.push(signal);
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
      });
      const note = createVoiceProgressNote(harness.ports, testOptions);
      mock.timers.tick(testDelayMs);
      await settlePromises();
      assert.equal(harness.signals[0].aborted, false, 'the send waits');

      await note.finish();

      assert.equal(harness.signals[0].aborted, true, 'the wait is cancelled, so it does not outlive the answer');
      assert.deepEqual(harness.problems, [], 'a cancelled send is not a problem');
      assert.deepEqual(harness.deletedIds, []);
      assert.deepEqual(harness.remembered, []);
    });
  });

  it('a note that could not be sent leaves nothing to delete', async () => {
    const harness = createHarness({ postNote: async () => { harness.posts += 1; return null; } });
    const note = createVoiceProgressNote(harness.ports, testOptions);
    mock.timers.tick(testDelayMs);
    await settlePromises();

    await note.finish();

    assert.equal(harness.posts, 1);
    assert.deepEqual(harness.deletedIds, []);
    assert.deepEqual(harness.remembered, []);
    assert.deepEqual(harness.problems, [], 'the sender reports its own failure; this is no second problem');
  });

  it('a send that throws is logged and the voice goes on', async () => {
    const harness = createHarness({ postNote: async () => { throw new Error('socket hang up'); } });
    const note = createVoiceProgressNote(harness.ports, testOptions);
    mock.timers.tick(testDelayMs);
    await settlePromises();

    await assert.doesNotReject(note.finish());

    assert.deepEqual(harness.deletedIds, []);
    assert.equal(harness.problems.length, 1);
    assert.match(harness.problems[0], /could not post the transcribing note: socket hang up/);
  });

  it('a delete that throws is logged and finish() still resolves', async () => {
    const harness = createHarness({ deleteNote: async () => { throw new Error('socket hang up'); } });
    const note = createVoiceProgressNote(harness.ports, testOptions);
    mock.timers.tick(testDelayMs);
    await settlePromises();

    await assert.doesNotReject(note.finish());

    assert.equal(harness.problems.length, 1);
    assert.match(harness.problems[0], /could not delete the transcribing note: socket hang up/);
  });

  it('a remember that throws is logged, and the note is still deleted by finish()', async () => {
    const harness = createHarness({ rememberNote: () => { throw new Error('state is locked'); } });
    const note = createVoiceProgressNote(harness.ports, testOptions);
    mock.timers.tick(testDelayMs);
    await settlePromises();

    await assert.doesNotReject(note.finish());

    assert.deepEqual(harness.deletedIds, [noteMessageId]);
    assert.equal(harness.problems.length, 1);
    assert.match(harness.problems[0], /could not remember the transcribing note: state is locked/);
  });

  it('waits 3 seconds by default, and the cleanup budget is shorter than the delay', async () => {
    const harness = createHarness();
    const note = createVoiceProgressNote(harness.ports);

    mock.timers.tick(voiceProgressNoteDelayMs - 1);
    await settlePromises();
    assert.equal(harness.posts, 0);
    mock.timers.tick(1);
    await settlePromises();
    assert.equal(harness.posts, 1);
    await note.finish();

    assert.equal(voiceProgressNoteDelayMs, 3_000);
    assert.ok(voiceProgressNoteCleanupBudgetMs < voiceProgressNoteDelayMs, 'a stalled cleanup holds the answer for less than the wait that earned the note');
  });
});

describe('the notes of a bot that shuts down', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
  afterEach(() => mock.timers.reset());

  it('a shutdown before the delay stops the note: it never posts, even if the process lives on', async () => {
    const registry = createVoiceProgressNoteRegistry(testOptions);
    const harness = createHarness();
    registry.start(harness.ports);

    mock.timers.tick(testDelayMs - 1);
    await registry.shutDown();
    mock.timers.tick(testDelayMs * 2);
    await settlePromises();

    assert.equal(harness.posts, 0, 'the timer is cleared by the shutdown, not left to fire after the sweep');
    assert.deepEqual(harness.deletedIds, []);
  });

  it('the stopping part of the shutdown is synchronous, so a sync shutdown step can run it', async () => {
    const registry = createVoiceProgressNoteRegistry(testOptions);
    const harness = createHarness();
    registry.start(harness.ports);

    const shuttingDown = registry.shutDown();
    mock.timers.tick(testDelayMs);
    await settlePromises();

    assert.equal(harness.posts, 0, 'stopped before the call returned');
    await shuttingDown;
  });

  it('a shutdown while the note is being sent waits for the send and deletes what lands, never remembering it', async () => {
    const send = createDeferred<number | null>();
    const registry = createVoiceProgressNoteRegistry(testOptions);
    const harness = createHarness({ postNote: async () => { harness.posts += 1; return send.promise; } });
    registry.start(harness.ports);
    mock.timers.tick(testDelayMs);
    await settlePromises();

    const shuttingDown = registry.shutDown();
    assert.equal(await checkIsSettled(shuttingDown), false, 'the shutdown waits for the send in flight');
    send.resolve(noteMessageId);
    await shuttingDown;

    assert.deepEqual(harness.deletedIds, [noteMessageId], 'the note that landed after the shutdown began is deleted');
    assert.deepEqual(harness.remembered, [], 'and was never registered as live');
  });

  it('a shutdown does not wait on a send for longer than the budget, and the late landing is still deleted', async () => {
    const send = createDeferred<number | null>();
    const registry = createVoiceProgressNoteRegistry(testOptions);
    const harness = createHarness({ postNote: async () => { harness.posts += 1; return send.promise; } });
    registry.start(harness.ports);
    mock.timers.tick(testDelayMs);
    await settlePromises();

    const shuttingDown = registry.shutDown();
    mock.timers.tick(testBudgetMs);
    assert.equal(await checkIsSettled(shuttingDown), true, 'bounded: a hung send cannot hold the shutdown');
    send.resolve(noteMessageId);
    await settlePromises();

    assert.deepEqual(harness.deletedIds, [noteMessageId]);
    assert.deepEqual(harness.remembered, []);
  });

  it('a shutdown deletes a note that is on screen', async () => {
    const registry = createVoiceProgressNoteRegistry(testOptions);
    const harness = createHarness();
    registry.start(harness.ports);
    mock.timers.tick(testDelayMs);
    await settlePromises();
    assert.deepEqual(harness.remembered, [noteMessageId]);

    await registry.shutDown();

    assert.deepEqual(harness.deletedIds, [noteMessageId]);
  });

  it('a voice that arrives after the shutdown began gets an inert note', async () => {
    const registry = createVoiceProgressNoteRegistry(testOptions);
    await registry.shutDown();
    const harness = createHarness();

    const note = registry.start(harness.ports);
    mock.timers.tick(testDelayMs * 2);
    await settlePromises();
    await note.finish();

    assert.equal(harness.posts, 0, 'a note armed during the drain of the last updates would fire after the sweep');
  });

  it('shutDown() is idempotent, and a note that finished earlier is not touched again', async () => {
    const registry = createVoiceProgressNoteRegistry(testOptions);
    const harness = createHarness();
    const note = registry.start(harness.ports);
    mock.timers.tick(testDelayMs);
    await settlePromises();
    await note.finish();
    assert.deepEqual(harness.deletedIds, [noteMessageId]);

    const first = registry.shutDown();
    const second = registry.shutDown();
    await Promise.all([first, second]);

    assert.equal(first, second, 'one shutdown');
    assert.deepEqual(harness.deletedIds, [noteMessageId], 'the finished note left the registry: no second delete');
  });
});
