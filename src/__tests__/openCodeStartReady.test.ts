/**
 * @description B18 — `/opencode` must reply "ready" the moment the session
 * exists, NOT after model resolution.
 *
 * Bug: `startSession` awaited `fetchModelInfo` (→ `GET /config`) BEFORE
 * `emit('started')`, which is what triggers the "OpenCode готов" reply. On a
 * server saturated by another topic's heavy work, `GET /config` stalled for
 * tens of seconds (capped by the 30 s request timeout), so the topic showed no
 * ready reply for minutes (live trace 15:02: POST /session succeeded, no ready
 * emit followed).
 *
 * Fix: emit `started` right after the session exists and SSE is wired, then
 * resolve the model afterwards. A hanging `GET /config` can no longer gate the
 * ready reply.
 *
 * Harness mirrors openCodeModelInfo.test.ts: real adapter, `apiRequest`
 * stubbed, `connectSse` stubbed to a no-op (no real SSE socket), module-level
 * install/server checks pass naturally in this env (opencode installed, server
 * up). Private members reached via runtime bracket access (tests are excluded
 * from tsconfig and run via tsx type-stripping, so this does not affect
 * `yarn typecheck`).
 */

import { describe, it } from 'node:test';
import { useStubbedOpenCodeServer } from './openCodeServerStub';
import assert from 'node:assert/strict';
import { OpenCodeAdapter } from '../adapters/openCodeAdapter';
import { keyToString, keysEqual, type SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';

const newSessionId = 'ses_start_ready';

/**
 * @description Build an adapter whose lifecycle dependencies are stubbed: POST
 * /session resolves immediately; GET /config behaviour is caller-controlled;
 * connectSse is a no-op (no real socket).
 */
function createStubbedAdapter(configHandler: () => Promise<unknown>): {
  adapter: OpenCodeAdapter;
  startedKeys: SessionKey[];
} {
  const adapter = new OpenCodeAdapter();

  adapter['apiRequest'] = async (method: string, urlPath: string) => {
    // Session create is now folder-scoped: `/session?directory=<workDir>`
    // (S1). Match the create regardless of the query so this harness keeps
    // resolving the new id; `/session/<id>/abort` etc. keep the path segment.
    if (method === 'POST' && (urlPath === '/session' || urlPath.startsWith('/session?'))) {
      return { id: newSessionId };
    }
    if (method === 'GET' && urlPath === '/config') {
      return configHandler();
    }
    return undefined;
  };
  // No real SSE socket in the test.
  adapter['connectSse'] = () => {};

  const startedKeys: SessionKey[] = [];
  adapter.on('started', (startedKey: SessionKey) => {
    startedKeys.push(startedKey);
  });

  return { adapter, startedKeys };
}

/** Wait until `predicate()` is true or a bounded number of macrotask turns
 * elapse — long enough for the start path's real awaits (server health check,
 * stubbed POST /session) to drain, short enough to fail fast. */
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let turn = 0; turn < 200; turn++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}


useStubbedOpenCodeServer();

describe('OpenCode startSession ready reply (B18)', () => {
  it('emits "started" even when GET /config never resolves (hanging server)', async () => {
    // GET /config returns a promise that never settles. The old code awaited it
    // BEFORE emit('started'), so the ready reply never fired. With the fix
    // `started` precedes that await — we must NOT await startSession to
    // completion (it stays pending on /config by design), just confirm the
    // ready signal arrived.
    const { adapter, startedKeys } = createStubbedAdapter(() => new Promise<unknown>(() => {}));
    const hangKey: SessionKey = makeTelegramKey(-100999222, 1);

    void adapter.startSession(hangKey, '/tmp/work');
    await waitFor(() => startedKeys.length > 0);

    assert.equal(startedKeys.length, 1, 'ready (started) must fire despite the hanging /config');
  });

  it('emits "started" before fetchModelInfo resolves (readiness precedes model)', async () => {
    const events: string[] = [];
    let resolveConfig: (value: unknown) => void = () => {};
    const configReady = new Promise<unknown>((resolve) => {
      resolveConfig = resolve;
    });

    const { adapter } = createStubbedAdapter(() => configReady);
    const orderKey: SessionKey = makeTelegramKey(-100999222, 2);
    adapter.on('started', () => events.push('started'));

    const startPromise = adapter.startSession(orderKey, '/tmp/work');

    // `started` fires before the awaited fetchModelInfo, while /config is still
    // pending — so no model is resolved yet.
    await waitFor(() => events.includes('started'));
    assert.deepEqual(events, ['started'], 'started must be emitted before the model is resolved');
    assert.equal(
      adapter.getCurrentModel(orderKey),
      null,
      'no model is known while /config is still pending',
    );

    // Now let /config resolve — the label lands on the session (silently), so
    // the bot's ready notice can name it.
    resolveConfig({ defaultModel: { providerID: 'anthropic', modelID: 'claude-opus-4-8' } });
    await startPromise;

    assert.equal(
      adapter.getCurrentModel(orderKey),
      'anthropic/claude-opus-4-8',
      'model resolution still runs after readiness',
    );
  });

  /**
   * @description A fresh start must post exactly ONE message to the topic — the
   * bot's `agent.ready` notice, which already carries `🧠 Model: <label>`.
   *
   * Bug (live trace 2026-09-14, `/new` in a bound topic): `startSession` called
   * `fetchModelInfo(key)` with the default `emitOutput=true`, so the adapter
   * ALSO emitted a bare `Model: anthropic/claude-opus-5` output line ~2 s after
   * the ready notice — a second, redundant message on every start.
   *
   * Fix: the start path resolves the model SILENTLY (as `resumeSession` already
   * did). This pins the absence of the emit while proving resolution still ran.
   */
  it('does NOT emit a standalone "Model:" line on a fresh start (ready notice already names it)', async () => {
    const { adapter } = createStubbedAdapter(async () =>
      ({ defaultModel: { providerID: 'anthropic', modelID: 'claude-opus-4-8' } }),
    );
    const silentKey: SessionKey = makeTelegramKey(-100999222, 3);

    const outputs: string[] = [];
    adapter.on('output', (_key: SessionKey, text: string) => outputs.push(text));

    await adapter.startSession(silentKey, '/tmp/work');

    assert.deepEqual(outputs, [], 'a fresh start must emit no output of its own');
    assert.equal(
      adapter.getCurrentModel(silentKey),
      'anthropic/claude-opus-4-8',
      'the model is still resolved — only the announcement is dropped',
    );
  });
});

describe('OpenCode single-owner prevention (B20 root cause)', () => {
  it('detaches a thread already bound to the same server session when another adopts it', async () => {
    // Thread A is already live on session ses_start_ready. Thread B starts and
    // POST /session hands back the SAME id (the corruption that delivered one
    // answer to two topics). A must be detached so only one thread owns it.
    const { adapter } = createStubbedAdapter(async () =>
      ({ defaultModel: { providerID: 'anthropic', modelID: 'claude-opus-4-8' } }),
    );
    const threadA: SessionKey = makeTelegramKey(-100999333, 10);
    const threadB: SessionKey = makeTelegramKey(-100999333, 11);

    // Inject thread A holding the shared id.
    adapter['sessions'].set(keyToString(threadA), {
      key: threadA,
      sessionId: newSessionId,
      workDir: '/tmp/work',
      isActive: true,
      currentResponseText: '',
      lastEmittedLength: 0,
      outputTimer: null,
      isModelInfoShown: true,
      modelOverride: null,
      currentModelLabel: null,
      partTypes: new Map(),
      statusDebounceTimer: null,
      pendingStatus: null,
      pendingQuestion: null,
      effortLevel: null,
      isBusy: false,
      isCompacting: false,
      busyChildSessionIds: new Set(),
      sseController: null,
      reconnectTimer: null,
      sseStallTimer: null,
    });

    const stoppedKeys: SessionKey[] = [];
    adapter.on('stopped', (k: SessionKey) => stoppedKeys.push(k));

    await adapter.startSession(threadB, '/tmp/work');

    // A is detached (stopped emitted, removed); B owns the session.
    assert.ok(
      stoppedKeys.some((k) => keysEqual(k, threadA)),
      'the stale duplicate owner (thread A) must be detached',
    );
    assert.equal(adapter['sessions'].has(keyToString(threadA)), false, 'thread A removed from the session map');
    assert.equal(adapter['sessions'].get(keyToString(threadB)).sessionId, newSessionId, 'thread B owns the session');
  });
});
