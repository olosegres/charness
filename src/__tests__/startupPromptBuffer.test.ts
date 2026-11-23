/**
 * @description Plan §2026-05-30 tg-startup-prompt-buffer — prompts typed while
 * an agent session is booting must be (a) recognised as "buffer, don't drop",
 * (b) replayed in arrival order once ready, and (c) discarded on a failed
 * start. These load-bearing assertions guard the actual user-visible promise:
 * "I won't have to retype the message I sent during startup."
 */

import { mock, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { StartupPromptBuffer, type BufferedPromptOutcome } from '../startupPromptBuffer';

const KEY_A = '100:1';
const KEY_B = '100:2';

/** Close the window the way a successful start does, and return what reached the session, in order. */
async function replayTexts(buffer: StartupPromptBuffer, threadId: string): Promise<string[]> {
  const forwarded: string[] = [];
  await buffer.replayPrompts(threadId, { isSessionActive: true, forward: async (text) => { forwarded.push(text); } });
  return forwarded;
}

test('not starting by default → text is not buffered', () => {
  const buffer = new StartupPromptBuffer();
  assert.equal(buffer.checkIsStarting(KEY_A), false);
});

test('markStarting opens the window; replay closes it', async () => {
  const buffer = new StartupPromptBuffer();
  buffer.markStarting(KEY_A);
  assert.equal(buffer.checkIsStarting(KEY_A), true);
  await replayTexts(buffer, KEY_A);
  assert.equal(buffer.checkIsStarting(KEY_A), false);
});

test('prompts replay in FIFO arrival order', async () => {
  const buffer = new StartupPromptBuffer();
  buffer.markStarting(KEY_A);
  buffer.addPrompt(KEY_A, 'first');
  buffer.addPrompt(KEY_A, 'second');
  buffer.addPrompt(KEY_A, 'third');
  assert.deepEqual(await replayTexts(buffer, KEY_A), ['first', 'second', 'third']);
});

test('replay clears the buffer — a second replay yields nothing (no double-send)', async () => {
  const buffer = new StartupPromptBuffer();
  buffer.markStarting(KEY_A);
  buffer.addPrompt(KEY_A, 'only');
  assert.deepEqual(await replayTexts(buffer, KEY_A), ['only']);
  assert.deepEqual(await replayTexts(buffer, KEY_A), []);
});

test('addPrompt reports first-of-window once, then added (ack only once)', () => {
  const buffer = new StartupPromptBuffer();
  buffer.markStarting(KEY_A);
  assert.equal(buffer.addPrompt(KEY_A, 'a'), 'firstInWindow');
  assert.equal(buffer.addPrompt(KEY_A, 'b'), 'added');
  assert.equal(buffer.addPrompt(KEY_A, 'c'), 'added');
});

test('a fresh startup window acks again after a replay', async () => {
  const buffer = new StartupPromptBuffer();
  buffer.markStarting(KEY_A);
  assert.equal(buffer.addPrompt(KEY_A, 'a'), 'firstInWindow');
  await replayTexts(buffer, KEY_A);

  buffer.markStarting(KEY_A);
  assert.equal(buffer.addPrompt(KEY_A, 'b'), 'firstInWindow');
});

test('a closed window refuses a prompt: nothing is kept that no replay would take (review 18 #1)', async () => {
  const buffer = new StartupPromptBuffer();
  const outcomes: BufferedPromptOutcome[] = [];
  assert.equal(buffer.addPrompt(KEY_A, 'no window was ever open', (outcome) => outcomes.push(outcome)), 'refused');

  // A stop's window: it closed (the process is gone) and looked once for what it holds — a prompt added now would wait for good.
  buffer.markStarting(KEY_A);
  buffer.closeWindow(KEY_A);
  assert.equal(buffer.addPrompt(KEY_A, 'after the stop ended', (outcome) => outcomes.push(outcome)), 'refused');
  // A start's window: its replay took the buffer.
  buffer.markStarting(KEY_B);
  await replayTexts(buffer, KEY_B);
  assert.equal(buffer.addPrompt(KEY_B, 'after the replay took the buffer'), 'refused');

  assert.equal(buffer.checkHasPrompts(KEY_A), false);
  assert.equal(buffer.checkHasPrompts(KEY_B), false);
  assert.equal(buffer.checkIsAnyPending(), false, 'nothing held in memory: a self-update is not refused for a prompt nobody will replay');
  assert.deepEqual(outcomes, [], 'a refused prompt was never buffered: no wait to settle');
  // The next window takes prompts again.
  buffer.markStarting(KEY_A);
  assert.equal(buffer.addPrompt(KEY_A, 'in the next window'), 'firstInWindow');
});

test('discard drops buffered prompts and closes the window (failed start)', async () => {
  const buffer = new StartupPromptBuffer();
  buffer.markStarting(KEY_A);
  buffer.addPrompt(KEY_A, 'lost');
  buffer.discardPrompts(KEY_A);
  assert.equal(buffer.checkIsStarting(KEY_A), false);
  assert.deepEqual(await replayTexts(buffer, KEY_A), []);
});

test('threads are isolated — one thread\'s buffer never leaks into another', async () => {
  const buffer = new StartupPromptBuffer();
  buffer.markStarting(KEY_A);
  buffer.markStarting(KEY_B);
  buffer.addPrompt(KEY_A, 'a-only');
  buffer.addPrompt(KEY_B, 'b-only');

  assert.deepEqual(await replayTexts(buffer, KEY_A), ['a-only']);
  // B untouched by A's replay.
  assert.equal(buffer.checkIsStarting(KEY_B), true);
  assert.deepEqual(await replayTexts(buffer, KEY_B), ['b-only']);
});

// A prompt may ask to hear how its wait ended (the API-error retry's nudge: its saved record means "armed" until
// the nudge reaches a session; a tracker's post, which must not count an undelivered prompt as delivered). `replayed`
// = handed to the session. `dropped` = it never reached the agent: no session, or a forward that threw.

test('a settle callback hears `replayed` once the prompt has been forwarded — each prompt its own, in order', async () => {
  const buffer = new StartupPromptBuffer();
  const log: string[] = [];
  buffer.markStarting(KEY_A);
  buffer.addPrompt(KEY_A, 'first', (outcome) => log.push(`settled first ${outcome}`));
  buffer.addPrompt(KEY_A, 'plain');
  buffer.addPrompt(KEY_A, 'third', (outcome) => log.push(`settled third ${outcome}`));

  await buffer.replayPrompts(KEY_A, { isSessionActive: true, forward: async (text) => { log.push(`forward ${text}`); } });

  assert.deepEqual(log, ['forward first', 'settled first replayed', 'forward plain', 'forward third', 'settled third replayed'], 'after its own forward, never before');
});

test('a forward that throws (its write into the agent failed) is logged and does not stop the rest; its prompt settles as DROPPED — never counted as delivered', async () => {
  const buffer = new StartupPromptBuffer();
  const outcomes: BufferedPromptOutcome[] = [];
  const forwarded: string[] = [];
  buffer.markStarting(KEY_A);
  buffer.addPrompt(KEY_A, 'breaks', (outcome) => outcomes.push(outcome));
  buffer.addPrompt(KEY_A, 'fine', (outcome) => outcomes.push(outcome));
  const logged = mock.method(console, 'error', () => {});
  try {
    await buffer.replayPrompts(KEY_A, {
      isSessionActive: true,
      forward: async (text) => {
        if (text === 'breaks') throw new Error('adapter went away');
        forwarded.push(text);
      },
    });
    assert.equal(logged.mock.calls.length, 1);
  } finally {
    logged.mock.restore();
  }
  assert.deepEqual(forwarded, ['fine']);
  assert.deepEqual(outcomes, ['dropped', 'replayed']);
});

test('replay into a session that is not active forwards nothing and settles every prompt as dropped', async () => {
  const buffer = new StartupPromptBuffer();
  const outcomes: BufferedPromptOutcome[] = [];
  const forwarded: string[] = [];
  buffer.markStarting(KEY_A);
  buffer.addPrompt(KEY_A, 'a', (outcome) => outcomes.push(outcome));
  buffer.addPrompt(KEY_A, 'b', (outcome) => outcomes.push(outcome));

  await buffer.replayPrompts(KEY_A, { isSessionActive: false, forward: async (text) => { forwarded.push(text); } });

  assert.deepEqual(forwarded, []);
  assert.deepEqual(outcomes, ['dropped', 'dropped']);
  assert.equal(buffer.checkIsStarting(KEY_A), false, 'the window is closed either way');
});

test('discard (a failed start) settles every prompt as dropped', () => {
  const buffer = new StartupPromptBuffer();
  const outcomes: BufferedPromptOutcome[] = [];
  buffer.markStarting(KEY_A);
  buffer.addPrompt(KEY_A, 'a', (outcome) => outcomes.push(outcome));
  buffer.addPrompt(KEY_A, 'plain');
  buffer.addPrompt(KEY_A, 'b', (outcome) => outcomes.push(outcome));

  buffer.discardPrompts(KEY_A);

  assert.deepEqual(outcomes, ['dropped', 'dropped']);
});

test('a prompt settles exactly once: a second replay or discard has nothing left to tell', async () => {
  const buffer = new StartupPromptBuffer();
  const outcomes: BufferedPromptOutcome[] = [];
  buffer.markStarting(KEY_A);
  buffer.addPrompt(KEY_A, 'once', (outcome) => outcomes.push(outcome));

  await replayTexts(buffer, KEY_A);
  await replayTexts(buffer, KEY_A);
  buffer.discardPrompts(KEY_A);

  assert.deepEqual(outcomes, ['replayed']);
});

test('settle callbacks are per thread — A\'s replay never settles B\'s prompt', async () => {
  const buffer = new StartupPromptBuffer();
  const outcomes: string[] = [];
  buffer.markStarting(KEY_A);
  buffer.markStarting(KEY_B);
  buffer.addPrompt(KEY_A, 'a', () => outcomes.push('a'));
  buffer.addPrompt(KEY_B, 'b', () => outcomes.push('b'));

  await replayTexts(buffer, KEY_A);

  assert.deepEqual(outcomes, ['a']);
});

test('a settle callback that throws is logged and never breaks the replay or the discard', async () => {
  const buffer = new StartupPromptBuffer();
  const forwarded: string[] = [];
  const logged = mock.method(console, 'error', () => {});
  try {
    buffer.markStarting(KEY_A);
    buffer.addPrompt(KEY_A, 'first', () => { throw new Error('bad callback'); });
    buffer.addPrompt(KEY_A, 'second');
    await buffer.replayPrompts(KEY_A, { isSessionActive: true, forward: async (text) => { forwarded.push(text); } });

    buffer.markStarting(KEY_B);
    buffer.addPrompt(KEY_B, 'x', () => { throw new Error('bad callback'); });
    assert.doesNotThrow(() => buffer.discardPrompts(KEY_B));
    assert.equal(logged.mock.calls.length, 2);
  } finally {
    logged.mock.restore();
  }
  assert.deepEqual(forwarded, ['first', 'second']);
});

test('L3: closing the window keeps its prompts for the next window — the idle stop holds a prompt, the resume replays it', async () => {
  const buffer = new StartupPromptBuffer();
  buffer.markStarting('t');
  assert.equal(buffer.checkHasPrompts('t'), false);
  buffer.addPrompt('t', 'arrived while the process stopped');
  assert.equal(buffer.checkHasPrompts('t'), true);

  buffer.closeWindow('t');
  assert.equal(buffer.checkIsStarting('t'), false, 'the stop\'s window is closed');
  assert.equal(buffer.checkHasPrompts('t'), true, 'the prompt was NOT dropped with it');

  // The resume opens its own window and replays what the stop held.
  buffer.markStarting('t');
  const forwarded: string[] = [];
  await buffer.replayPrompts('t', { isSessionActive: true, forward: async (text) => { forwarded.push(text); } });
  assert.deepEqual(forwarded, ['arrived while the process stopped']);
  assert.equal(buffer.checkHasPrompts('t'), false);
});

test('checkIsAnyPending: a thread mid-startup, or any prompt still waiting, makes the buffer pending for the whole bot', async () => {
  const buffer = new StartupPromptBuffer();
  assert.equal(buffer.checkIsAnyPending(), false);
  buffer.markStarting(KEY_A);
  assert.equal(buffer.checkIsAnyPending(), true, 'a session is booting');
  buffer.addPrompt(KEY_A, 'held');
  buffer.closeWindow(KEY_A);
  assert.equal(buffer.checkIsAnyPending(), true, 'the window closed but a prompt is still held for the next one');
  await replayTexts(buffer, KEY_A);
  assert.equal(buffer.checkIsAnyPending(), false, 'replayed: nothing left in memory');
  buffer.markStarting(KEY_B);
  buffer.discardPrompts(KEY_B);
  buffer.closeWindow(KEY_B);
  assert.equal(buffer.checkIsAnyPending(), false);
});

test('a prompt buffered as a person\'s own is replayed as one, a bot-made one as not: the replay knows whether to wait for its write', async () => {
  const buffer = new StartupPromptBuffer();
  const forwarded: Array<[string, boolean]> = [];
  buffer.markStarting(KEY_A);
  buffer.addPrompt(KEY_A, 'typed', undefined, { isPersonInput: true });
  buffer.addPrompt(KEY_A, 'a wake-up');
  await buffer.replayPrompts(KEY_A, { isSessionActive: true, forward: async (text, options) => { forwarded.push([text, options.isPersonInput === true]); } });
  assert.deepEqual(forwarded, [['typed', true], ['a wake-up', false]]);
});

test('a prompt buffered as a carrier of the accounts note replays as one (its note is attached at the replay, with the figures of that moment); every other prompt does not', async () => {
  const buffer = new StartupPromptBuffer();
  const forwarded: Array<[string, boolean, boolean]> = [];
  buffer.markStarting(KEY_A);
  buffer.addPrompt(KEY_A, 'typed', undefined, { isPersonInput: true, isAccountsNoteCarrier: true });
  buffer.addPrompt(KEY_A, 'a nudge');
  buffer.addPrompt(KEY_A, 'a scheduled run', undefined, { isAccountsNoteCarrier: true });
  await buffer.replayPrompts(KEY_A, { isSessionActive: true, forward: async (text, options) => { forwarded.push([text, options.isPersonInput === true, options.isAccountsNoteCarrier === true]); } });
  assert.deepEqual(forwarded, [['typed', true, true], ['a nudge', false, false], ['a scheduled run', false, true]]);
});

test('the replay is still the start for the turn probe: «replaying» holds during every forward and the after-step, and ends after them — also when a forward throws; a prompt arriving meanwhile is not buffered again (review 15 #1)', async () => {
  const buffer = new StartupPromptBuffer();
  const seen: Array<[string, boolean, boolean]> = [];
  buffer.markStarting(KEY_A);
  buffer.addPrompt(KEY_A, 'first');
  buffer.addPrompt(KEY_A, 'breaks');
  assert.equal(buffer.checkIsReplaying(KEY_A), false, 'not before the replay');
  const errorMock = mock.method(console, 'error', () => {});
  try {
    await buffer.replayPrompts(KEY_A, {
      isSessionActive: true,
      forward: async (text) => {
        seen.push([text, buffer.checkIsReplaying(KEY_A), buffer.checkIsStarting(KEY_A)]);
        if (text === 'breaks') throw new Error('write failed');
      },
      afterReplay: async () => { seen.push(['after', buffer.checkIsReplaying(KEY_A), buffer.checkIsStarting(KEY_A)]); },
    });
  } finally {
    errorMock.mock.restore();
  }
  assert.deepEqual(seen, [['first', true, false], ['breaks', true, false], ['after', true, false]], 'replaying, and the window already closed: a new prompt is forwarded, not buffered');
  assert.equal(buffer.checkIsReplaying(KEY_A), false, 'over once the last forward and the after-step are done');
  assert.equal(buffer.checkIsReplaying(KEY_B), false, 'another thread is never replaying');

  // A forward that throws out of the after-step still ends the replay.
  buffer.markStarting(KEY_A);
  buffer.addPrompt(KEY_A, 'one');
  await assert.rejects(buffer.replayPrompts(KEY_A, { isSessionActive: true, forward: async () => {}, afterReplay: async () => { throw new Error('held prompts failed'); } }));
  assert.equal(buffer.checkIsReplaying(KEY_A), false);
  // No session: nothing replays, nothing is left marked.
  buffer.markStarting(KEY_A);
  buffer.addPrompt(KEY_A, 'lost', () => {});
  await buffer.replayPrompts(KEY_A, { isSessionActive: false, forward: async () => {}, afterReplay: async () => { seen.push(['after-inactive', true, true]); } });
  assert.equal(buffer.checkIsReplaying(KEY_A), false);
  assert.ok(!seen.some(([text]) => text === 'after-inactive'), 'the after-step runs only into a live session');
});
