/**
 * @description The pure decision behind `ensureAgentSession` (plan
 * 2026-10-04-claude-process-lifecycle, L-D4): live / starting → ready; a sleeping
 * conversation (persisted id for its adapter) → RESUME, never a fresh start; a
 * released one → start, or nothing for a resume-only caller; a failed resume →
 * fresh start unless resume-only.
 *
 * Load-bearing: the resume must win over a start whenever an id of the SAME
 * backend family is persisted (an id of another family is never resumed on the
 * wrong backend), and resume-only must never yield `start`.
 *
 * Test case: N/A — TelegramCode has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getEnsureSessionPlan,
  getPersistedSessionIdForAdapter,
  getResumeFailureAction,
  type EnsureSessionPlanInput,
} from '../utils/ensureSessionPlan';

const sleeping: EnsureSessionPlanInput = {
  isActive: false,
  isStarting: false,
  hasBinding: true,
  adapterName: 'claude-json-stream',
  isClaudeBackend: true,
  persistedIds: { claudeSessionId: 'sess-1' },
  isResumeOnly: false,
};

describe('getEnsureSessionPlan', () => {
  it('a live session, or a start under way, is ready — nothing is resumed or started', () => {
    assert.deepEqual(getEnsureSessionPlan({ ...sleeping, isActive: true }), { kind: 'ready' });
    assert.deepEqual(getEnsureSessionPlan({ ...sleeping, isStarting: true }), { kind: 'ready' });
  });

  it('no binding → unbound; no adapter → noAdapter (before any id is looked at)', () => {
    assert.deepEqual(getEnsureSessionPlan({ ...sleeping, hasBinding: false }), { kind: 'unbound' });
    assert.deepEqual(getEnsureSessionPlan({ ...sleeping, adapterName: null, isClaudeBackend: false }), { kind: 'noAdapter' });
  });

  it('a sleeping conversation is RESUMED by its id, on either Claude backend and on OpenCode', () => {
    assert.deepEqual(getEnsureSessionPlan(sleeping), { kind: 'resume', adapterName: 'claude-json-stream', sessionId: 'sess-1' });
    assert.deepEqual(getEnsureSessionPlan({ ...sleeping, adapterName: 'claude' }), { kind: 'resume', adapterName: 'claude', sessionId: 'sess-1' });
    assert.deepEqual(
      getEnsureSessionPlan({ ...sleeping, adapterName: 'opencode', isClaudeBackend: false, persistedIds: { opencodeSessionId: 'oc-1' } }),
      { kind: 'resume', adapterName: 'opencode', sessionId: 'oc-1' },
    );
  });

  it('a released conversation (no id) starts fresh — unless the caller is resume-only', () => {
    assert.deepEqual(getEnsureSessionPlan({ ...sleeping, persistedIds: null }), { kind: 'start', adapterName: 'claude-json-stream' });
    assert.deepEqual(getEnsureSessionPlan({ ...sleeping, persistedIds: {} }), { kind: 'start', adapterName: 'claude-json-stream' });
    assert.deepEqual(getEnsureSessionPlan({ ...sleeping, persistedIds: null, isResumeOnly: true }), { kind: 'nothingToResume' });
  });

  it('an id of another backend family is not a sleeping session for this adapter', () => {
    assert.deepEqual(
      getEnsureSessionPlan({ ...sleeping, adapterName: 'opencode', isClaudeBackend: false, persistedIds: { claudeSessionId: 'sess-1' } }),
      { kind: 'start', adapterName: 'opencode' },
    );
    assert.deepEqual(
      getEnsureSessionPlan({ ...sleeping, adapterName: 'terminal', isClaudeBackend: false, persistedIds: { claudeSessionId: 'sess-1', opencodeSessionId: 'oc-1' } }),
      { kind: 'start', adapterName: 'terminal' },
    );
  });
});

describe('getPersistedSessionIdForAdapter', () => {
  it('maps the family: Claude id for either Claude backend, OpenCode id for opencode, none otherwise', () => {
    const ids = { claudeSessionId: 'c', opencodeSessionId: 'o' };
    assert.equal(getPersistedSessionIdForAdapter(ids, 'claude', true), 'c');
    assert.equal(getPersistedSessionIdForAdapter(ids, 'claude-json-stream', true), 'c');
    assert.equal(getPersistedSessionIdForAdapter(ids, 'opencode', false), 'o');
    assert.equal(getPersistedSessionIdForAdapter(ids, 'terminal', false), null);
    assert.equal(getPersistedSessionIdForAdapter(null, 'claude', true), null);
  });
});

describe('getResumeFailureAction', () => {
  it('a failed resume starts fresh, except for a resume-only caller', () => {
    assert.equal(getResumeFailureAction(false), 'startFresh');
    assert.equal(getResumeFailureAction(true), 'fail');
  });
});
