/**
 * @description `postToSession` (Jira plan J5, D21): a session is ensured — the
 * ensure itself resumes a conversation's sleeping session (a Jira issue keeps
 * one for good, D5; a topic's sleeps after the idle stop, L-D4) — then the
 * prompt is forwarded; a usage-limit wait holds the prompt before either (R23).
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { postToSession, type PostToSessionDeps } from '../postToSession';

function createDeps(calls: string[], overrides: Partial<PostToSessionDeps> = {}): PostToSessionDeps {
  return {
    checkBusy: () => false,
    ensureSession: async (conversationKey, fallbackAdapterName) => {
      calls.push(`ensure ${conversationKey} ${fallbackAdapterName ?? '-'}`);
      return { ok: true };
    },
    forwardPrompt: async (conversationKey, text) => {
      calls.push(`forward ${conversationKey} ${text}`);
    },
    now: () => 0,
    sleep: async () => {},
    ...overrides,
  };
}

describe('postToSession', () => {
  it('ensures a session (with the caller\'s fallback adapter), then forwards — one session step, no separate resume', async () => {
    const calls: string[] = [];
    assert.deepEqual(await postToSession(createDeps(calls), 'jira:PROJ:PROJ-1', 'the prompt', 'claude-json-stream'), { ok: true, isHeld: false });
    assert.deepEqual(calls, ['ensure jira:PROJ:PROJ-1 claude-json-stream', 'forward jira:PROJ:PROJ-1 the prompt']);
    const bare: string[] = [];
    assert.deepEqual(await postToSession(createDeps(bare), 'k', 'p'), { ok: true, isHeld: false });
    assert.deepEqual(bare, ['ensure k -', 'forward k p']);
  });

  it('a session that cannot be ensured is never forwarded to', async () => {
    const calls: string[] = [];
    const deps = createDeps(calls, { ensureSession: async () => ({ ok: false, reason: 'start-failed' }) });
    assert.deepEqual(await postToSession(deps, 'k', 'p'), { ok: false, reason: 'start-failed' });
    assert.deepEqual(calls, []);
  });

  it('R23: during an armed usage-limit wait the prompt is held — no session resumed or started, nothing forwarded', async () => {
    const calls: string[] = [];
    const deps = createDeps(calls, {
      holdForLimitResume: (conversationKey, text) => {
        calls.push(`hold ${conversationKey} ${text}`);
        return true;
      },
    });
    assert.deepEqual(await postToSession(deps, 'k', 'p', 'claude-json-stream'), { ok: true, isHeld: true });
    assert.deepEqual(calls, ['hold k p']);
  });

  it('R23: a wait armed while the post waited for the busy turn holds the prompt — it is not forwarded into the limit', async () => {
    const calls: string[] = [];
    let isBusy = true;
    let isLimitWaitArmed = false;
    const deps = createDeps(calls, {
      checkBusy: () => isBusy,
      sleep: async () => {
        // The running turn hits the usage limit: the wait is armed and the turn goes idle.
        isLimitWaitArmed = true;
        isBusy = false;
      },
      holdForLimitResume: () => {
        calls.push(`hold? ${isLimitWaitArmed}`);
        return isLimitWaitArmed;
      },
    });
    assert.deepEqual(await postToSession(deps, 'k', 'p'), { ok: true, isHeld: true });
    assert.deepEqual(calls, ['hold? false', 'ensure k -', 'hold? true']);
  });

  it('R27: a hold gets the run as posted at once AND what it says when late; a forward only the former', async () => {
    const calls: string[] = [];
    let isLimitWaitArmed = true;
    const deps = createDeps(calls, {
      holdForLimitResume: (conversationKey, text, heldText) => {
        calls.push(`hold? ${text} | ${heldText ?? '-'}`);
        return isLimitWaitArmed;
      },
    });
    assert.deepEqual(await postToSession(deps, 'k', 'p', undefined, { heldText: 'p, was due at 09:00' }), { ok: true, isHeld: true });
    isLimitWaitArmed = false;
    assert.deepEqual(await postToSession(deps, 'k', 'p', undefined, { heldText: 'p, was due at 09:05' }), { ok: true, isHeld: false });
    assert.deepEqual(calls, [
      'hold? p | p, was due at 09:00',
      'hold? p | p, was due at 09:05',
      'ensure k -',
      'hold? p | p, was due at 09:05',
      'forward k p',
    ]);
  });

  it('R23: no wait armed — the post goes on as usual', async () => {
    const calls: string[] = [];
    const deps = createDeps(calls, { holdForLimitResume: () => false });
    assert.deepEqual(await postToSession(deps, 'k', 'p'), { ok: true, isHeld: false });
    assert.deepEqual(calls, ['ensure k -', 'forward k p']);
  });
});
