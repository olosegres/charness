/**
 * @description The json-stream adapter's answer cursor (`currentResponseText` / `emittedLength`) belongs to the turn that streams the text: a turn's `result` settles against the cursor of THAT turn, wherever the
 * next prompt was written.
 *
 * Live seam (a Telegram flow on a loaded runner): the operator's next message was written to the CLI's stdin while the previous turn's `result` frame was still unread (the tail is polled, 300 ms to 1.5 s). The
 * write reset the cursor, so the late `result` was settled against an EMPTY cursor: its under-delivery backstop emitted the previous turn's whole closing text as the start of the new turn's, and the new turn's
 * first text was appended to it («Fake final answer … (answer, turn 1).Working on …» in one message).
 *
 * Load-bearing intent:
 *   - a prompt written while a turn runs leaves its cursor alone: the unread `result` emits only the text the turn had not emitted yet, once, before the new turn's text, which goes out on its own;
 *   - a prompt written while no turn runs (idle, or after an interrupt that left no `result`) starts from an empty cursor, so the new turn's own backstop works on its own text;
 *   - a turn's end leaves the cursor empty.
 *
 * Frames are the shapes of the CLI's stream-json; the FIFO write is the adapter's test seam, no `claude` process is involved.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import { ClaudeJsonStreamAdapter, streamOutputBatchMs, type StreamSession } from '../adapters/claudeJsonStreamAdapter';
import { keyToString, type SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { createStreamSessionFixture } from './claudeJsonStreamSessionFixture';

const key: SessionKey = makeTelegramKey(-100999555, 81);
/** The adapter's answer batch window, with a margin: a tick past it emits a text the window still holds. */
const batchWindowWithMarginMs = streamOutputBatchMs + 50;

const initFrame = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-cursor', model: 'fake-model' }) + '\n';
const echoFrame = (text: string): string => JSON.stringify({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, isReplay: true }) + '\n';
const textDeltaFrame = (text: string): string => JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } }) + '\n';
const resultFrame = (text: string): string => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text }) + '\n';

const created: Array<{ adapter: ClaudeJsonStreamAdapter; session: StreamSession }> = [];

function createAdapter(): { adapter: ClaudeJsonStreamAdapter; session: StreamSession; outputs: string[] } {
  const adapter = new ClaudeJsonStreamAdapter({ lifecycle: 'idle', writeFifo: async () => {} });
  const session = createStreamSessionFixture({ key, pid: process.pid, sessionId: 'sess-cursor' });
  adapter['sessions'].set(keyToString(key), session);
  created.push({ adapter, session });
  const outputs: string[] = [];
  adapter.on('output', (_key: SessionKey, text: string) => outputs.push(text));
  return { adapter, session, outputs };
}

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout'] });
});

afterEach(() => {
  for (const { adapter, session } of created.splice(0)) adapter['clearTimers'](session);
  mock.timers.reset();
});

describe('json-stream adapter — the answer cursor belongs to the turn that streams the text', () => {
  it('REGRESSION: a prompt written before the previous turn\'s `result` was read does not take that turn\'s cursor: the result emits only its missing tail, once, and the new turn\'s text goes out on its own', async () => {
    const { adapter, session, outputs } = createAdapter();
    await adapter.sendInputAndWait(key, 'first');
    adapter['onStdout'](session, initFrame + echoFrame('first') + textDeltaFrame('The ans'));
    mock.timers.tick(batchWindowWithMarginMs);
    assert.deepEqual(outputs, ['The ans'], 'precondition: the turn emitted part of its answer');

    // The operator's next message is written while the turn's `result` (with the whole answer) sits unread in the log.
    await adapter.sendInputAndWait(key, 'second');
    adapter['onStdout'](session, resultFrame('The answer is 42.') + initFrame + echoFrame('second') + textDeltaFrame('Next.') + resultFrame('Next.'));
    mock.timers.tick(batchWindowWithMarginMs);

    assert.deepEqual(outputs, ['The ans', 'wer is 42.', 'Next.']);
  });

  it('a prompt written while no turn runs starts from an empty cursor: after an interrupt that left no `result`, the new turn\'s backstop works on its own text', async () => {
    const { adapter, session, outputs } = createAdapter();
    await adapter.sendInputAndWait(key, 'first');
    adapter['onStdout'](session, initFrame + echoFrame('first') + textDeltaFrame('Partial'));
    mock.timers.tick(batchWindowWithMarginMs);
    adapter.sendEscape(key);
    assert.equal(adapter.checkIsWorking(key), false, 'precondition: the interrupt ended the turn for the bot, with no `result`');

    await adapter.sendInputAndWait(key, 'again');
    assert.equal(session.currentResponseText, '', 'the new turn starts from an empty cursor');
    adapter['onStdout'](session, initFrame + echoFrame('again') + textDeltaFrame('Fre') + resultFrame('Fresh'));

    assert.deepEqual(outputs, ['Partial', 'Fresh'], 'the second turn\'s text is completed from its own `result`, nothing of the first one is in it');
  });

  it('a turn\'s end leaves the cursor empty, so the next turn\'s text starts a tail of its own', async () => {
    const { adapter, session, outputs } = createAdapter();
    await adapter.sendInputAndWait(key, 'first');
    adapter['onStdout'](session, initFrame + echoFrame('first') + textDeltaFrame('Hel') + resultFrame('Hello'));
    assert.deepEqual(outputs, ['Hello']);
    assert.deepEqual([session.currentResponseText, session.emittedLength], ['', 0]);

    await adapter.sendInputAndWait(key, 'second');
    adapter['onStdout'](session, initFrame + echoFrame('second') + textDeltaFrame('Wor') + resultFrame('World'));
    assert.deepEqual(outputs, ['Hello', 'World']);
  });
});
