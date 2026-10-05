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

test('addPrompt reports first-of-window once, then false (ack only once)', () => {
  const buffer = new StartupPromptBuffer();
  buffer.markStarting(KEY_A);
  assert.equal(buffer.addPrompt(KEY_A, 'a'), true);
  assert.equal(buffer.addPrompt(KEY_A, 'b'), false);
  assert.equal(buffer.addPrompt(KEY_A, 'c'), false);
});

test('a fresh startup window acks again after a replay', async () => {
  const buffer = new StartupPromptBuffer();
  buffer.markStarting(KEY_A);
  assert.equal(buffer.addPrompt(KEY_A, 'a'), true);
  await replayTexts(buffer, KEY_A);

  buffer.markStarting(KEY_A);
  assert.equal(buffer.addPrompt(KEY_A, 'b'), true);
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
// the nudge reaches a session). `replayed` = handed to the session — a failed forward is logged and not retried,
// so it counts: nobody re-delivers it. `dropped` = it can never reach one.

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

test('a forward that throws is logged and does not stop the rest; its prompt still settles as replayed', async () => {
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
  assert.deepEqual(outcomes, ['replayed', 'replayed']);
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
