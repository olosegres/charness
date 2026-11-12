/**
 * @description The json-stream adapter's `flushPendingOutput`: the text the agent streamed just before it called
 * `answer_request` is either still in `stdout.jsonl` (the tail poll lags the process) or in the adapter's own 350 ms batch
 * window, so the bot — which lands its output queue before it posts the answer — asks the adapter to emit that text NOW.
 * The flush must read the tail, emit exactly the unsent tail (never the text twice, with the batch timer disarmed), leave
 * the turn running (it is not a final flush) and be a no-op without a pending tail or a session. The batch window runs on
 * mock timers; the tail is a real `stdout.jsonl` in a temp dir.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClaudeJsonStreamAdapter, type StreamSession } from '../adapters/claudeJsonStreamAdapter';
import type { OutboundHints } from '../platform/outbound';
import { keyToString, type SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { getJsonStreamSessionPaths } from '../utils/jsonStreamHost';
import { createStreamSessionFixture } from './claudeJsonStreamSessionFixture';

const key: SessionKey = makeTelegramKey(-100999444, 42);
/** The adapter's batch window, with a margin: a tick past it fires any timer the flush left armed. */
const batchWindowWithMarginMs = 350 + 50;

/** A text delta as the CLI streams it (the stream-json line the tail poll reads). */
function buildTextDeltaLine(text: string): string {
  return JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } }) + '\n';
}

function createAdapterWithSession(dir: string): { adapter: ClaudeJsonStreamAdapter; session: StreamSession; outputs: Array<{ text: string; meta?: OutboundHints }> } {
  const adapter = new ClaudeJsonStreamAdapter();
  const session = createStreamSessionFixture({ key, sessionId: 'sess-flush', paths: getJsonStreamSessionPaths(dir) });
  adapter['sessions'].set(keyToString(key), session);
  const outputs: Array<{ text: string; meta?: OutboundHints }> = [];
  adapter.on('output', (_key: SessionKey, text: string, meta?: OutboundHints) => outputs.push({ text, ...(meta === undefined ? {} : { meta }) }));
  return { adapter, session, outputs };
}

describe('claude-json-stream flushPendingOutput', () => {
  let dir: string;

  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout'] });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstream-flush-'));
  });
  afterEach(() => {
    mock.timers.reset();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('emits the text still in the batch window at once — as a non-final output — and disarms the window, so the text goes out once', () => {
    const { adapter, session, outputs } = createAdapterWithSession(dir);
    adapter['appendAnswerDelta'](session, 'Let me answer that. ');
    assert.equal(outputs.length, 0, 'the text waits in the batch window');

    adapter.flushPendingOutput(key);

    assert.deepEqual(outputs, [{ text: 'Let me answer that. ', meta: {} }]);
    assert.equal(session.outputTimer, null, 'the window is disarmed');
    mock.timers.tick(batchWindowWithMarginMs);
    assert.equal(outputs.length, 1, 'the cleared window does not emit the text a second time');
  });

  it('a delta after the flush emits only its own tail when the window ends', () => {
    const { adapter, session, outputs } = createAdapterWithSession(dir);
    adapter['appendAnswerDelta'](session, 'Before the answer. ');
    adapter.flushPendingOutput(key);

    adapter['appendAnswerDelta'](session, 'After it.');
    mock.timers.tick(batchWindowWithMarginMs);

    assert.deepEqual(outputs.map((output) => output.text), ['Before the answer. ', 'After it.']);
  });

  it('reads the text the process wrote since the last poll, then emits it: a tool call right behind the text does not overtake it', () => {
    const { adapter, session, outputs } = createAdapterWithSession(dir);
    fs.writeFileSync(session.paths.stdoutFile, buildTextDeltaLine('Written, not polled yet.'));
    assert.equal(outputs.length, 0, 'the poll has not read the line');

    adapter.flushPendingOutput(key);

    assert.deepEqual(outputs.map((output) => output.text), ['Written, not polled yet.']);
    mock.timers.tick(batchWindowWithMarginMs);
    assert.equal(outputs.length, 1, 'the text goes out once');
  });

  it('with no text pending, or no session, it emits nothing', () => {
    const { adapter, session, outputs } = createAdapterWithSession(dir);
    adapter.flushPendingOutput(key);
    adapter['appendAnswerDelta'](session, 'Sent already.');
    adapter.flushPendingOutput(key);
    adapter.flushPendingOutput(key);
    adapter.flushPendingOutput(makeTelegramKey(-100999444, 43));

    assert.deepEqual(outputs.map((output) => output.text), ['Sent already.']);
  });
});
