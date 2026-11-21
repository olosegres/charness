/**
 * Lifecycle safety L3 of the accounts note: a note is part of the ONE prompt text the forward writes, so the json-stream adapter's
 * account of "input the CLI has not taken in yet" matches the echo of a note-bearing prompt like any other — also when the CLI drains
 * it together with a message queued behind it into ONE merged echo (its texts joined by a newline). Were the note a write of its own,
 * or a text the echo does not carry, an entry would stay "unconsumed" for good and hold the process "working" (the incident of
 * `claudeJsonStreamMergedInput.test.ts`): no idle compaction, no per-turn stop.
 *
 * The note is multi-line and holds a blank line before it, the shape a real carrier prompt has. The adapter's own seams are used as
 * in that test; no `claude` process is involved.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeJsonStreamAdapter, type StreamSession } from '../adapters/claudeJsonStreamAdapter';
import { keyToString, type SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { appendLimitNote } from '../limitNotes/noteText';
import { createStreamSessionFixture } from './claudeJsonStreamSessionFixture';

const key: SessionKey = makeTelegramKey(-1001111111111, 79);

const echoFrame = (text: string): string => JSON.stringify({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, isReplay: true }) + '\n';
const resultFrame = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }) + '\n';
const initFrame = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-note', model: 'fake-model' }) + '\n';
const idleStateFrame = JSON.stringify({ type: 'system', subtype: 'session_state_changed', state: 'idle' }) + '\n';

const note = [
  '[Accounts · 14:05] Next new Claude worker → work (soonest weekly reset): week 62 % used, resets in 1 d 19 h; 5 h 30 %.',
  'Then default (week 20 %, resets in 5 d).',
  'Call claude_profiles right before your next launch or resume — the pick moves as limits fill and reset. No reply is needed.',
].join('\n');
const todoLine = '[Todo] Your published todo list was last updated 70 min ago and you have worked since.';
/** What a carrier turn start writes: the person's words, the todo line, the note last — one text. */
const promptWithNote = appendLimitNote(`Check the build\n\n${todoLine}`, note);

let nowMs = 0;
const created: Array<{ adapter: ClaudeJsonStreamAdapter; session: StreamSession }> = [];

function createAdapter(): { adapter: ClaudeJsonStreamAdapter; session: StreamSession } {
  const adapter = new ClaudeJsonStreamAdapter({ lifecycle: 'idle', writeFifo: async () => {} });
  const session = createStreamSessionFixture({ key, pid: process.pid, sessionId: 'sess-note', lastTurnEndedAt: nowMs });
  adapter['sessions'].set(keyToString(key), session);
  created.push({ adapter, session });
  return { adapter, session };
}

beforeEach(() => {
  nowMs = 1_000_000;
  mock.method(Date, 'now', () => nowMs);
});

afterEach(() => {
  for (const { adapter, session } of created.splice(0)) adapter['clearTimers'](session);
  mock.restoreAll();
});

describe('a prompt that carries the accounts note, in the json-stream adapter\'s account of input the CLI has not taken in', () => {
  it('written alone, it is ONE unconsumed input whose text is the whole prompt, and its own echo takes it in', async () => {
    const { adapter, session } = createAdapter();
    await adapter.sendInputAndWait(key, promptWithNote);
    assert.deepEqual(session.unconsumedInputs.map((input) => input.text), [promptWithNote], 'the note is no write of its own');
    assert.equal(adapter.checkHasUnconsumedInput(key), true);
    adapter['onStdout'](session, echoFrame(promptWithNote));
    assert.deepEqual(session.unconsumedInputs, []);
    assert.equal(adapter.checkHasUnconsumedInput(key), false);
  });

  it('L3: followed by a message queued mid-turn and drained as ONE merged echo — nothing stays unconsumed, no signal lists input, the process may be stopped', async () => {
    const { adapter, session } = createAdapter();
    await adapter.sendInputAndWait(key, 'Write 40 short facts about the ocean, no tools.');
    adapter['onStdout'](session, echoFrame('Write 40 short facts about the ocean, no tools.'));
    // The carrier prompt and a second message are written while that turn streams: they wait for it to end and are taken in together.
    await adapter.sendInputAndWait(key, promptWithNote);
    await adapter.sendInputAndWait(key, 'and the word AAA');
    assert.equal(adapter.checkHasUnconsumedInput(key), true, 'precondition: both are queued');

    adapter['onStdout'](session, resultFrame + initFrame);
    adapter['onStdout'](session, echoFrame(`${promptWithNote}\nand the word AAA`));
    adapter['onStdout'](session, resultFrame + idleStateFrame);

    assert.deepEqual(session.unconsumedInputs, [], 'the one echo carried the note-bearing prompt whole, and the second message');
    assert.equal(adapter.getBackgroundWorkSignals(key).some((signal) => signal.kind === 'unconsumedInput'), false, 'no unconsumedInput working signal');
    assert.equal(adapter.checkIsWorking(key), false, 'nothing holds the process: the idle fire may compact and stop it');
  });

  it('a note-bearing prompt echoed ONE-by-one at a tool boundary is taken in by its own echo, leaving the next', async () => {
    const { adapter, session } = createAdapter();
    await adapter.sendInputAndWait(key, promptWithNote);
    await adapter.sendInputAndWait(key, 'next');
    adapter['onStdout'](session, echoFrame(promptWithNote));
    assert.deepEqual(session.unconsumedInputs.map((input) => input.text), ['next']);
  });

  it('the note adds NO working signal of its own while it waits: one input on its way is one, never two', async () => {
    const { adapter } = createAdapter();
    await adapter.sendInputAndWait(key, promptWithNote);
    assert.deepEqual(adapter.getBackgroundWorkSignals(key), [{ kind: 'unconsumedInput', count: 1 }]);
  });
});
