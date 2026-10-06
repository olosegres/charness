/**
 * @description Integration test for the wedged-turn notice wired into the REAL
 * OpenCode SSE path. Drives synthesized `/global/event` envelopes through
 * `routeSseData` (the same entry the live reader uses) and captures `output`
 * events off the adapter EventEmitter.
 *
 * Bug (live 2026-08-15/16, the my-news digest schedule): a bloated session
 * accepted every prompt (HTTP 204) but its agent loop exited immediately —
 * `session.idle` arrived with zero assistant activity, so the topic looked
 * silently hung. The fix arms a per-prompt flag (`awaitingTurnResponse`) and,
 * when idle brings no activity, emits a `noResponse` event so the bot can
 * auto-recover (fresh session + replay).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeAdapter, type OpenCodeSession } from '../adapters/openCodeAdapter';
import { keyToString, type SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { useStubbedOpenCodeServer } from './openCodeServerStub';
import { createOpenCodeSessionFixture, getOpenCodeSession } from './openCodeSessionFixture';

const openCodeServer = useStubbedOpenCodeServer();

const ownSessionId = 'ses_own';
const key: SessionKey = makeTelegramKey(-100123, 42);
const workDir = '/tmp/work';

/**
 * Build a live session mirroring the fields the idle path reads. `overrides`
 * tune the wedge preconditions (a just-sent prompt = awaiting + no activity).
 */
function createAdapterWithSession(overrides: Partial<OpenCodeSession>): {
  adapter: OpenCodeAdapter;
  noResponseKeys: SessionKey[];
} {
  const adapter = new OpenCodeAdapter();
  adapter['sessions'].set(keyToString(key), createOpenCodeSessionFixture({
    key,
    sessionId: ownSessionId,
    workDir,
    isModelInfoShown: true,
    currentModelLabel: 'anthropic/claude',
    isBusy: true,
    ...overrides,
  }));

  const noResponseKeys: SessionKey[] = [];
  adapter.on('noResponse', (k: SessionKey) => {
    noResponseKeys.push(k);
  });
  return { adapter, noResponseKeys };
}

function globalEnvelope(type: string, properties: Record<string, unknown>): string {
  return JSON.stringify({ directory: workDir, project: 'proj', payload: { type, properties } });
}

function feedSessionIdle(adapter: OpenCodeAdapter): void {
  adapter['routeSseData'](globalEnvelope('session.idle', { sessionID: ownSessionId }));
}

function feedTextDelta(adapter: OpenCodeAdapter, delta: string): void {
  adapter['routeSseData'](
    globalEnvelope('message.part.delta', {
      sessionID: ownSessionId, messageID: 'msg_1', partID: 'prt_1', field: 'text', delta,
    }),
  );
}

/** Feed an assistant `message.updated` — the ONLY signal that marks turn
 * activity (a user prompt's own echoed parts must NOT count). */
function feedAssistantMessage(adapter: OpenCodeAdapter): void {
  adapter['routeSseData'](
    globalEnvelope('message.updated', {
      info: { id: 'msg_asst_1', sessionID: ownSessionId, role: 'assistant' },
    }),
  );
}

describe('OpenCode wedged-turn noResponse event', () => {
  it('prompt awaited, idle with NO activity → emits noResponse once', () => {
    const { adapter, noResponseKeys } = createAdapterWithSession({
      awaitingTurnResponse: true,
      sawTurnActivity: false,
    });

    feedSessionIdle(adapter);

    assert.equal(noResponseKeys.length, 1);
    assert.deepEqual(noResponseKeys[0], key);
    // Resolved: the pending flag is cleared so a later idle cannot re-fire.
    assert.equal(getOpenCodeSession(adapter, keyToString(key)).awaitingTurnResponse, false);

    feedSessionIdle(adapter);
    assert.equal(noResponseKeys.length, 1, 'a second idle must not re-emit noResponse');
  });

  it('a RESUMED (reattached) session still fires — its idle retry state reads as "no retry" (guard-bug regression)', async () => {
    // The resume path builds its own session and never sees a provider retry; the
    // wedge guard must read that as "no retry" so the wedge is NOT silently
    // suppressed (live miss 2026-08-16). Driven through the real resume path so the
    // session is the one a reattach actually produces.
    const adapter = new OpenCodeAdapter();
    openCodeServer.answerApiWith(({ method, urlPath }) => {
      if (method === 'GET' && urlPath === `/session/${ownSessionId}`) return { id: ownSessionId };
      if (method === 'GET' && urlPath === `/session/${ownSessionId}/message`) return [];
      if (method === 'GET' && urlPath.startsWith('/question?')) return [];
      if (method === 'POST' && urlPath === `/session/${ownSessionId}/prompt_async`) return undefined;
      throw new Error(`unexpected API request in test: ${method} ${urlPath}`);
    });
    adapter['connectSse'] = () => {};
    adapter['fetchModelInfo'] = async () => {};
    const noResponseKeys: SessionKey[] = [];
    adapter.on('noResponse', (k: SessionKey) => {
      noResponseKeys.push(k);
    });
    await adapter['resumeSessionInner'](key, workDir, ownSessionId);

    adapter.sendInput(key, 'continue');
    feedSessionIdle(adapter);

    assert.equal(noResponseKeys.length, 1);
  });

  it('a turn that produced assistant activity → idle emits NO noResponse', () => {
    const { adapter, noResponseKeys } = createAdapterWithSession({
      awaitingTurnResponse: true,
      sawTurnActivity: false,
    });

    // An assistant message arrives → the turn genuinely started.
    feedAssistantMessage(adapter);
    assert.equal(
      getOpenCodeSession(adapter, keyToString(key)).sawTurnActivity,
      true,
      'an assistant message must mark turn activity',
    );

    feedSessionIdle(adapter);
    assert.equal(noResponseKeys.length, 0, 'a healthy turn must never fire noResponse');
  });

  it('the user prompt echo (a text part, NOT an assistant message) does NOT mask a wedge', () => {
    // Regression: prompt_async emits message.part events for the USER prompt;
    // counting those as activity masked the wedge (live 2026-08-16).
    const { adapter, noResponseKeys } = createAdapterWithSession({
      awaitingTurnResponse: true,
      sawTurnActivity: false,
    });

    feedTextDelta(adapter, '[Scheduled run] Дайджест'); // the echoed user prompt
    assert.equal(
      getOpenCodeSession(adapter, keyToString(key)).sawTurnActivity,
      false,
      'a user-prompt text part must NOT mark turn activity',
    );

    feedSessionIdle(adapter);
    assert.equal(noResponseKeys.length, 1, 'the wedge must still fire despite the prompt echo');
  });

  it('idle with no pending prompt (resume / spurious idle) → NO noResponse', () => {
    const { adapter, noResponseKeys } = createAdapterWithSession({
      awaitingTurnResponse: false,
      sawTurnActivity: false,
    });

    feedSessionIdle(adapter);
    assert.equal(noResponseKeys.length, 0);
  });

  it('a compaction cycle idling with no text → NO noResponse', () => {
    const { adapter, noResponseKeys } = createAdapterWithSession({
      awaitingTurnResponse: true,
      sawTurnActivity: false,
      isCompacting: true,
    });

    feedSessionIdle(adapter);
    assert.equal(noResponseKeys.length, 0);
  });
});
