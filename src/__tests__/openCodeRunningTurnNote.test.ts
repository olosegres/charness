/**
 * @description `queueNoteIntoRunningTurn` on the OpenCode adapter (shared todo registry S4, D22): a note queued into a
 * BUSY turn posts `prompt_async` with the session's model and variant and resets nothing of the turn — the response
 * being streamed keeps its accumulator and stays one message —, counts as unconsumed input like any prompt, and is
 * refused (nothing posted, nothing aborted) while the turn waits out a provider retry, while the session is idle, and
 * when the server refuses it.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeAdapter } from '../adapters/openCodeAdapter';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { createOpenCodeSessionFixture, getOpenCodeSession } from './openCodeSessionFixture';

const key = makeTelegramKey(-1001111111111, 42);
const keyString = '-1001111111111:42';
const sessionId = 'ses_running';

function createAdapter(overrides: Parameters<typeof createOpenCodeSessionFixture>[0] = {}): {
  adapter: OpenCodeAdapter;
  requests: Array<{ method: string; path: string; body: Record<string, unknown> | undefined }>;
  setRequestFailure: (error: Error | null) => void;
} {
  const adapter = new OpenCodeAdapter();
  adapter['sessions'].set(keyString, createOpenCodeSessionFixture({
    key,
    sessionId,
    workDir: '/tmp/work',
    modelOverride: { providerID: 'example', modelID: 'model-one' },
    effortLevel: 'high',
    isBusy: true,
    ...overrides,
  }));
  const requests: Array<{ method: string; path: string; body: Record<string, unknown> | undefined }> = [];
  let requestFailure: Error | null = null;
  adapter['apiRequest'] = (async (method: string, path: string, body?: Record<string, unknown>) => {
    requests.push({ method, path, body });
    if (requestFailure) throw requestFailure;
  }) as OpenCodeAdapter['apiRequest'];
  return { adapter, requests, setRequestFailure: (error) => { requestFailure = error; } };
}

describe('a note into the running OpenCode turn', () => {
  it('posts prompt_async with the session\'s model and variant and resets nothing of the turn', async () => {
    const { adapter, requests } = createAdapter({ currentResponseText: 'Alpha part one. ', lastEmittedLength: 16 });
    assert.equal(await adapter.queueNoteIntoRunningTurn(key, 'board changed'), true);
    assert.deepEqual(requests, [{
      method: 'POST',
      path: `/session/${sessionId}/prompt_async`,
      body: { parts: [{ type: 'text', text: 'board changed' }], model: { modelID: 'model-one', providerID: 'example' }, variant: 'high' },
    }]);
    const session = getOpenCodeSession(adapter, keyString);
    assert.equal(session.currentResponseText, 'Alpha part one. ', 'the streamed response goes on');
    assert.equal(session.lastEmittedLength, 16, 'the next tail is a continuation');
    assert.equal(session.unconsumedInputCount, 1, 'counted until OpenCode shows it as a user message');
  });

  it('is refused while the turn waits out a provider retry: nothing posted, nothing aborted', async () => {
    const { adapter, requests } = createAdapter({ providerRetrySignature: 'retry-1' });
    assert.equal(await adapter.queueNoteIntoRunningTurn(key, 'board changed'), false);
    assert.deepEqual(requests, []);
  });

  it('is refused for an idle session, and a refused POST is not left counted', async () => {
    const idle = createAdapter({ isBusy: false });
    assert.equal(await idle.adapter.queueNoteIntoRunningTurn(key, 'board changed'), false);
    assert.deepEqual(idle.requests, []);
    const failing = createAdapter();
    failing.setRequestFailure(new Error('500'));
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      assert.equal(await failing.adapter.queueNoteIntoRunningTurn(key, 'board changed'), false);
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(getOpenCodeSession(failing.adapter, keyString).unconsumedInputCount, 0);
  });
});
