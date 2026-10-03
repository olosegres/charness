/**
 * @description `postToSession` (Jira plan J5, D21): a conversation that keeps
 * one session for good (a Jira issue, D5) has its own session resumed BEFORE a
 * session is ensured, so a session that died between requests is not replaced
 * by a fresh one; without the step (the scheduler) the post is as before.
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
  it('resumes the conversation\'s own session first, then ensures one and forwards', async () => {
    const calls: string[] = [];
    const deps = createDeps(calls, {
      resumeSession: async (conversationKey) => {
        calls.push(`resume ${conversationKey}`);
      },
    });
    assert.deepEqual(await postToSession(deps, 'jira:PROJ:PROJ-1', 'the prompt', 'claude-json-stream'), { ok: true, isHeld: false });
    assert.deepEqual(calls, ['resume jira:PROJ:PROJ-1', 'ensure jira:PROJ:PROJ-1 claude-json-stream', 'forward jira:PROJ:PROJ-1 the prompt']);
  });

  it('without a resume step a session is ensured directly', async () => {
    const calls: string[] = [];
    assert.deepEqual(await postToSession(createDeps(calls), 'k', 'p'), { ok: true, isHeld: false });
    assert.deepEqual(calls, ['ensure k -', 'forward k p']);
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
      resumeSession: async () => {
        calls.push('resume');
      },
    });
    assert.deepEqual(await postToSession(deps, 'k', 'p', 'claude-json-stream'), { ok: true, isHeld: true });
    assert.deepEqual(calls, ['hold k p']);
  });

  it('R23: no wait armed — the post goes on as usual', async () => {
    const calls: string[] = [];
    const deps = createDeps(calls, { holdForLimitResume: () => false });
    assert.deepEqual(await postToSession(deps, 'k', 'p'), { ok: true, isHeld: false });
    assert.deepEqual(calls, ['ensure k -', 'forward k p']);
  });
});
