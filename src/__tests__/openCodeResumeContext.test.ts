/**
 * @description Resume context block must be posted ONLY on the explicit user
 * resume (`/sessions` pick) — never on the silent resume paths.
 *
 * Bug (user-caught live, 2026-06-04): the "↩️ Resumed — last N messages"
 * block was emitted unconditionally inside `resumeSessionInner`, which also
 * runs on `reattachExistingSessions` (EVERY bot restart, i.e. every hot
 * rebuild) and on opencode crash-recovery — so every rebuild spammed every
 * active topic with a context block.
 *
 * Fix: `ResumeSessionOptions.isWithRecentContext`, set only by the bot's
 * explicit-resume call site (`resumeSessionByIndex`).
 *
 * These tests drive the real `resumeSessionInner` with the harness style of
 * `openCodeCrashResume.test.ts` (stubbed server over fetch, OPENCODE_BIN
 * short-circuit, private members via bracket access). Load-bearing: the
 * default (silent) resume must hydrate runtime context without posting a
 * history block, and the explicit resume must still emit the rendered block.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeAdapter, openCodeRuntimeContextHydrationConcurrency } from '../adapters/openCodeAdapter';
import { keyToString, type SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { useStubbedOpenCodeServer, type JsonValue } from './openCodeServerStub';

const key: SessionKey = makeTelegramKey(-100778, 8);
const sessionId = 'ses_resume_ctx_8';
const workDir = '/tmp/work-resume-ctx';
const contextHeaderMark = '↩️';

const openCodeServer = useStubbedOpenCodeServer();

/**
 * @description The server side of a resume of `sessionId`: the session exists, no
 * question is pending, aborts succeed; `readHistory` answers the message-history read.
 */
function answerResumeApi(readHistory: (urlPath: string) => JsonValue | Promise<JsonValue>): void {
  openCodeServer.answerApiWith(({ method, urlPath }) => {
    if (method === 'GET' && urlPath === `/session/${sessionId}`) return { id: sessionId };
    if (method === 'GET' && urlPath === `/session/${sessionId}/message`) return readHistory(urlPath);
    if (method === 'GET' && urlPath.startsWith('/question?')) return [];
    if (urlPath.endsWith('/abort')) return undefined;
    throw new Error(`unexpected API request in test: ${method} ${urlPath}`);
  });
}

function createAdapter(): {
  adapter: OpenCodeAdapter;
  outputs: string[];
  messageHistoryRequests: string[];
} {
  const adapter = new OpenCodeAdapter();

  const messageHistoryRequests: string[] = [];
  answerResumeApi((urlPath) => {
    messageHistoryRequests.push(urlPath);
    return [
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'how do I deploy?' }] },
      {
        info: {
          id: 'msg_context',
          sessionID: sessionId,
          role: 'assistant',
          providerID: 'historical-provider',
          modelID: 'historical-model',
          tokens: { input: 120, cache: { read: 30, write: 5 } },
        },
        parts: [{ type: 'text', text: 'run the deploy script' }],
      },
    ];
  });

  // Keep resume off the real network: no SSE stream, no /config model lookup.
  adapter['connectSse'] = (() => {}) as OpenCodeAdapter['connectSse'];
  adapter['fetchModelInfo'] = (async () => {}) as OpenCodeAdapter['fetchModelInfo'];

  const outputs: string[] = [];
  adapter.on('output', (_key: SessionKey, text: string) => {
    outputs.push(text);
  });
  return { adapter, outputs, messageHistoryRequests };
}

describe('OpenCode resume context block gating', () => {
  it('silent resume (re-attach / crash-recovery — no options) hydrates context but emits NO context block', async () => {
    const { adapter, outputs, messageHistoryRequests } = createAdapter();

    await adapter['resumeSessionInner'](key, workDir, sessionId);

    const session = adapter['sessions'].get(keyToString(key));
    assert.ok(session, 'session must be resumed');
    assert.equal(session.isActive, true, 'resumed session must be active');

    // Load-bearing for the user-reported spam: the fallback read stays silent.
    const contextBlocks = outputs.filter((text) => text.includes(contextHeaderMark));
    assert.deepEqual(contextBlocks, [], `silent resume must not post the context block, got: ${JSON.stringify(outputs)}`);
    assert.deepEqual(messageHistoryRequests, [`/session/${sessionId}/message`], 'silent resume must read history for runtime context');
    assert.deepEqual(session.latestParentRuntimeContext, {
      messageId: 'msg_context',
      model: { providerID: 'historical-provider', modelID: 'historical-model' },
      contextUsedTokens: 155,
    });
  });

  it('explicit resume (isWithRecentContext) posts the rendered last-N block', async () => {
    const { adapter, outputs, messageHistoryRequests } = createAdapter();

    await adapter['resumeSessionInner'](key, workDir, sessionId, { isWithRecentContext: true });

    assert.deepEqual(messageHistoryRequests, [
      `/session/${sessionId}/message`,
      `/session/${sessionId}/message`,
    ], 'explicit resume reads history for hydration and its visible context block');
    const contextBlocks = outputs.filter((text) => text.includes(contextHeaderMark));
    assert.equal(contextBlocks.length, 1, `explicit resume must post exactly one context block, got: ${JSON.stringify(outputs)}`);
    assert.ok(contextBlocks[0].includes('how do I deploy?'), 'block must contain the user turn');
    assert.ok(contextBlocks[0].includes('run the deploy script'), 'block must contain the assistant turn');
  });

  it('does not wait for history hydration and retains its observed model over a pending override', async () => {
    const { adapter, outputs, messageHistoryRequests } = createAdapter();
    let resolveHistory: (records: JsonValue) => void = () => {};
    const history = new Promise<JsonValue>((resolve) => {
      resolveHistory = resolve;
    });
    answerResumeApi((urlPath) => {
      messageHistoryRequests.push(urlPath);
      return history;
    });

    const startedKeys: SessionKey[] = [];
    adapter.on('started', (startedKey: SessionKey) => startedKeys.push(startedKey));
    await adapter['resumeSessionInner'](key, workDir, sessionId);

    assert.deepEqual(startedKeys, [key], 'resume must become ready while the read-only hydration request is pending');
    assert.deepEqual(outputs, [], 'hydration must not emit resume text');
    assert.deepEqual(messageHistoryRequests, [`/session/${sessionId}/message`]);

    const session = adapter['sessions'].get(keyToString(key));
    assert.ok(session, 'session must remain active while hydration is pending');
    session.modelOverride = { providerID: 'pending-provider', modelID: 'pending-model' };

    resolveHistory([
      {
        info: {
          id: 'msg_history',
          sessionID: sessionId,
          role: 'assistant',
          providerID: 'historical-provider',
          modelID: 'historical-model',
          tokens: { input: 100, cache: { read: 20, write: 5 } },
        },
      },
    ]);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(session.latestParentRuntimeContext, {
      messageId: 'msg_history',
      model: { providerID: 'historical-provider', modelID: 'historical-model' },
      contextUsedTokens: 125,
    });
  });

  it('allows historical hydration after partial or malformed parent assistant SSE updates', async () => {
    const { adapter } = createAdapter();
    let resolveHistory: (records: JsonValue) => void = () => {};
    const history = new Promise<JsonValue>((resolve) => {
      resolveHistory = resolve;
    });
    answerResumeApi(() => history);

    await adapter['resumeSessionInner'](key, workDir, sessionId);
    const session = adapter['sessions'].get(keyToString(key));
    assert.ok(session, 'session must remain active while hydration is pending');

    adapter['handleMessageUpdate'](key, {
      info: {
        id: 'msg_partial',
        sessionID: sessionId,
        role: 'assistant',
        providerID: 'partial-provider',
        modelID: 'partial-model',
      },
    });
    adapter['handleMessageUpdate'](key, {
      info: {
        id: 'msg_malformed',
        sessionID: sessionId,
        role: 'assistant',
        providerID: 'malformed-provider',
        modelID: 'malformed-model',
        tokens: { input: 100, cache: { read: 'invalid' } },
      },
    });
    resolveHistory([
      {
        info: {
          id: 'msg_history',
          sessionID: sessionId,
          role: 'assistant',
          providerID: 'historical-provider',
          modelID: 'historical-model',
          tokens: { input: 100, cache: { read: 20, write: 5 } },
        },
      },
    ]);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(session.latestParentRuntimeContext, {
      messageId: 'msg_history',
      model: { providerID: 'historical-provider', modelID: 'historical-model' },
      contextUsedTokens: 125,
    });
  });

  it('keeps a complete live parent assistant runtime tuple over older history', async () => {
    const { adapter } = createAdapter();
    let resolveHistory: (records: JsonValue) => void = () => {};
    const history = new Promise<JsonValue>((resolve) => {
      resolveHistory = resolve;
    });
    answerResumeApi(() => history);

    await adapter['resumeSessionInner'](key, workDir, sessionId);
    const session = adapter['sessions'].get(keyToString(key));
    assert.ok(session, 'session must remain active while hydration is pending');

    adapter['handleMessageUpdate'](key, {
      info: {
        id: 'msg_live',
        sessionID: sessionId,
        role: 'assistant',
        providerID: 'live-provider',
        modelID: 'live-model',
        tokens: { input: 200, cache: { read: 40, write: 10 } },
      },
    });
    resolveHistory([
      {
        info: {
          id: 'msg_history',
          sessionID: sessionId,
          role: 'assistant',
          providerID: 'historical-provider',
          modelID: 'historical-model',
          tokens: { input: 100, cache: { read: 20, write: 5 } },
        },
      },
    ]);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(session.latestParentRuntimeContext, {
      messageId: 'msg_live',
      model: { providerID: 'live-provider', modelID: 'live-model' },
      contextUsedTokens: 250,
    });
  });

  it('blocks stale history after a complete aborted provider-retry SSE update', async () => {
    const { adapter } = createAdapter();
    let resolveHistory: (records: JsonValue) => void = () => {};
    const history = new Promise<JsonValue>((resolve) => {
      resolveHistory = resolve;
    });
    answerResumeApi(() => history);

    await adapter['resumeSessionInner'](key, workDir, sessionId);
    const session = adapter['sessions'].get(keyToString(key));
    assert.ok(session, 'session must remain active while hydration is pending');
    session.isAwaitingModelAfterProviderRetryAbort = true;

    adapter['handleMessageUpdate'](key, {
      info: {
        id: 'msg_aborted',
        sessionID: sessionId,
        role: 'assistant',
        providerID: 'aborted-provider',
        modelID: 'aborted-model',
        tokens: { input: 200, cache: { read: 40, write: 10 } },
        error: 'Aborted',
      },
    });
    resolveHistory([
      {
        info: {
          id: 'msg_history',
          sessionID: sessionId,
          role: 'assistant',
          providerID: 'historical-provider',
          modelID: 'historical-model',
          tokens: { input: 100, cache: { read: 20, write: 5 } },
        },
      },
    ]);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(session.latestParentRuntimeContext, null);
  });

  it('blocks stale history after an incomplete aborted provider-retry SSE update', async () => {
    const { adapter } = createAdapter();
    let resolveHistory: (records: JsonValue) => void = () => {};
    const history = new Promise<JsonValue>((resolve) => {
      resolveHistory = resolve;
    });
    answerResumeApi(() => history);

    await adapter['resumeSessionInner'](key, workDir, sessionId);
    const session = adapter['sessions'].get(keyToString(key));
    assert.ok(session, 'session must remain active while hydration is pending');
    session.isAwaitingModelAfterProviderRetryAbort = true;

    adapter['handleMessageUpdate'](key, {
      info: { sessionID: sessionId, role: 'assistant', error: 'Aborted' },
    });
    resolveHistory([
      {
        info: {
          id: 'msg_history',
          sessionID: sessionId,
          role: 'assistant',
          providerID: 'historical-provider',
          modelID: 'historical-model',
          tokens: { input: 100, cache: { read: 20, write: 5 } },
        },
      },
    ]);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(session.latestParentRuntimeContext, null);
  });

  it('limits concurrent silent-resume context hydration reads', async () => {
    const adapter = new OpenCodeAdapter();
    const sessionIds = Array.from(
      { length: openCodeRuntimeContextHydrationConcurrency + 1 },
      (_value, index) => `ses_resume_hydration_${index}`,
    );
    const pendingHistoryReads: (() => void)[] = [];
    let activeHistoryReads = 0;
    let maxActiveHistoryReads = 0;
    openCodeServer.answerApiWith(async ({ method, urlPath }) => {
      const sessionIdFromPath = sessionIds.find((candidate) => urlPath === `/session/${candidate}`);
      if (method === 'GET' && sessionIdFromPath) return { id: sessionIdFromPath };
      if (method === 'GET' && urlPath.includes('/message')) {
        activeHistoryReads += 1;
        maxActiveHistoryReads = Math.max(maxActiveHistoryReads, activeHistoryReads);
        return await new Promise<JsonValue>((resolve) => {
          pendingHistoryReads.push(() => {
            activeHistoryReads -= 1;
            resolve([]);
          });
        });
      }
      if (method === 'GET' && urlPath.startsWith('/question?')) return [];
      throw new Error(`unexpected API request in test: ${method} ${urlPath}`);
    });
    adapter['connectSse'] = (() => {}) as OpenCodeAdapter['connectSse'];
    adapter['fetchModelInfo'] = (async () => {}) as OpenCodeAdapter['fetchModelInfo'];

    await Promise.all(sessionIds.map((sessionId, index) => adapter['resumeSessionInner'](
      makeTelegramKey(-100778, 100 + index),
      workDir,
      sessionId,
    )));
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(maxActiveHistoryReads, openCodeRuntimeContextHydrationConcurrency);
    assert.equal(pendingHistoryReads.length, openCodeRuntimeContextHydrationConcurrency);

    const initialResolvers = pendingHistoryReads.splice(0);
    for (const resolveHistory of initialResolvers) resolveHistory();
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(maxActiveHistoryReads, openCodeRuntimeContextHydrationConcurrency);
    assert.equal(pendingHistoryReads.length, 1, 'the queued session starts only after a slot is released');
    for (const resolveHistory of pendingHistoryReads.splice(0)) resolveHistory();
  });

  it('keeps a queued session\'s live context instead of reading stale history after a slot opens', async () => {
    const adapter = new OpenCodeAdapter();
    const sessionIds = Array.from(
      { length: openCodeRuntimeContextHydrationConcurrency + 1 },
      (_value, index) => `ses_queued_hydration_${index}`,
    );
    const pendingHistoryReads: (() => void)[] = [];
    const messageHistoryRequests: string[] = [];
    openCodeServer.answerApiWith(async ({ method, urlPath }) => {
      const sessionIdFromPath = sessionIds.find((candidate) => urlPath === `/session/${candidate}`);
      if (method === 'GET' && sessionIdFromPath) return { id: sessionIdFromPath };
      if (method === 'GET' && urlPath.includes('/message')) {
        messageHistoryRequests.push(urlPath);
        return await new Promise<JsonValue>((resolve) => {
          pendingHistoryReads.push(() => resolve([]));
        });
      }
      if (method === 'GET' && urlPath.startsWith('/question?')) return [];
      throw new Error(`unexpected API request in test: ${method} ${urlPath}`);
    });
    adapter['connectSse'] = (() => {}) as OpenCodeAdapter['connectSse'];
    adapter['fetchModelInfo'] = (async () => {}) as OpenCodeAdapter['fetchModelInfo'];

    await Promise.all(sessionIds.map((currentSessionId, index) => adapter['resumeSessionInner'](
      makeTelegramKey(-100778, 200 + index),
      workDir,
      currentSessionId,
    )));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const queuedKey = makeTelegramKey(-100778, 200 + openCodeRuntimeContextHydrationConcurrency);
    const queuedSessionId = sessionIds[openCodeRuntimeContextHydrationConcurrency];
    const queuedSession = adapter['sessions'].get(keyToString(queuedKey));
    assert.ok(queuedSession, 'the queued session must already be active');
    adapter['handleMessageUpdate'](queuedKey, {
      info: {
        id: 'msg_live_queued',
        sessionID: queuedSessionId,
        role: 'assistant',
        providerID: 'live-provider',
        modelID: 'live-model',
        tokens: { input: 250, cache: { read: 50, write: 25 } },
      },
    });

    for (const resolveHistory of pendingHistoryReads.splice(0)) resolveHistory();
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(
      messageHistoryRequests.includes(`/session/${queuedSessionId}/message`),
      false,
      'a queued hydration with live SSE data must skip its stale history read',
    );
    assert.deepEqual(queuedSession.latestParentRuntimeContext, {
      messageId: 'msg_live_queued',
      model: { providerID: 'live-provider', modelID: 'live-model' },
      contextUsedTokens: 325,
    });
  });
});
