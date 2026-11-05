/**
 * @description The «transcribing…» note of a voice message, on fake timers: a text that arrives before the delay shows
 * nothing; a text that is late gets a note that is deleted the moment the text (or the failure) arrives; the races around the
 * send; and a port that throws never fails the voice. How `bot.ts` posts, tracks and deletes the message is checked by
 * `voiceProgressNoteE2e.test.ts` (the real voice path, a slow fake engine) and `sttVoiceWiring.test.ts`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceProgressNote, voiceProgressNoteDelayMs, type VoiceProgressNotePorts } from '../voiceProgressNote';

const testDelayMs = 3_000;
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
  deletedIds: number[];
  problems: string[];
}

function createHarness(overrides: Partial<VoiceProgressNotePorts> = {}): Harness {
  const harness: Harness = {
    posts: 0,
    deletedIds: [],
    problems: [],
    ports: {
      postNote: async () => {
        harness.posts += 1;
        return noteMessageId;
      },
      deleteNote: async (messageId) => { harness.deletedIds.push(messageId); },
      logProblem: (line) => { harness.problems.push(line); },
      ...overrides,
    },
  };
  return harness;
}

describe('the transcribing note of a voice message', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
  afterEach(() => mock.timers.reset());

  it('shows nothing when the text arrives before the delay (a warm engine)', async () => {
    const harness = createHarness();
    const note = createVoiceProgressNote(harness.ports, testDelayMs);

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
    const note = createVoiceProgressNote(harness.ports, testDelayMs);

    mock.timers.tick(testDelayMs - 1);
    await settlePromises();
    assert.equal(harness.posts, 0, 'still waiting at delay − 1 ms');

    mock.timers.tick(1);
    await settlePromises();
    assert.equal(harness.posts, 1, 'the note is up at the delay');
    assert.deepEqual(harness.deletedIds, [], 'and stays while the text is not here');

    mock.timers.tick(testDelayMs * 10);
    await settlePromises();
    assert.equal(harness.posts, 1, 'a long wait posts no second note');

    await note.finish();
    assert.deepEqual(harness.deletedIds, [noteMessageId], 'the text arrived: the note is deleted');
  });

  it('deletes the note when the voice fails, like when it succeeds: finish() is the one end of the wait', async () => {
    const harness = createHarness();
    const note = createVoiceProgressNote(harness.ports, testDelayMs);
    mock.timers.tick(testDelayMs);
    await settlePromises();

    // The job's transcription rejects; its error path ends the wait before the failure notice goes out.
    const failedTranscription = Promise.reject(new Error('the local engine exited before it was ready'));
    await failedTranscription.catch(() => note.finish());

    assert.deepEqual(harness.deletedIds, [noteMessageId]);
  });

  it('finish() twice deletes the note once', async () => {
    const harness = createHarness();
    const note = createVoiceProgressNote(harness.ports, testDelayMs);
    mock.timers.tick(testDelayMs);
    await settlePromises();

    await note.finish();
    await note.finish();

    assert.deepEqual(harness.deletedIds, [noteMessageId]);
  });

  it('a text that arrives while the note is being sent deletes it as soon as the send lands — once', async () => {
    const send = createDeferred<number | null>();
    const harness = createHarness({ postNote: async () => { harness.posts += 1; return send.promise; } });
    const note = createVoiceProgressNote(harness.ports, testDelayMs);
    mock.timers.tick(testDelayMs);
    await settlePromises();
    assert.equal(harness.posts, 1, 'the send is in flight');

    const finishing = note.finish();
    const finishingAgain = note.finish();
    await settlePromises();
    assert.deepEqual(harness.deletedIds, [], 'nothing to delete before the message exists');

    send.resolve(noteMessageId);
    await Promise.all([finishing, finishingAgain]);
    await settlePromises();

    assert.deepEqual(harness.deletedIds, [noteMessageId], 'the note that landed after the text is gone, and only one delete was sent');
  });

  it('a note that could not be sent leaves nothing to delete', async () => {
    const harness = createHarness({ postNote: async () => { harness.posts += 1; return null; } });
    const note = createVoiceProgressNote(harness.ports, testDelayMs);
    mock.timers.tick(testDelayMs);
    await settlePromises();

    await note.finish();

    assert.equal(harness.posts, 1);
    assert.deepEqual(harness.deletedIds, []);
    assert.deepEqual(harness.problems, [], 'the sender reports its own failure; this is no second problem');
  });

  it('a send that throws is logged and the voice goes on', async () => {
    const harness = createHarness({ postNote: async () => { throw new Error('socket hang up'); } });
    const note = createVoiceProgressNote(harness.ports, testDelayMs);
    mock.timers.tick(testDelayMs);
    await settlePromises();

    await assert.doesNotReject(note.finish());

    assert.deepEqual(harness.deletedIds, []);
    assert.equal(harness.problems.length, 1);
    assert.match(harness.problems[0], /could not post the transcribing note: socket hang up/);
  });

  it('a delete that throws is logged and finish() still resolves', async () => {
    const harness = createHarness({ deleteNote: async () => { throw new Error('socket hang up'); } });
    const note = createVoiceProgressNote(harness.ports, testDelayMs);
    mock.timers.tick(testDelayMs);
    await settlePromises();

    await assert.doesNotReject(note.finish());

    assert.equal(harness.problems.length, 1);
    assert.match(harness.problems[0], /could not delete the transcribing note: socket hang up/);
  });

  it('waits 3 seconds by default', async () => {
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
  });
});
