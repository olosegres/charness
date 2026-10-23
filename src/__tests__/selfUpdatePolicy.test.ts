/**
 * @description Coverage for `src/selfUpdate/updatePolicy.ts` — what the update engine does about what it saw: the npm hold,
 * never a downgrade / prerelease / deprecated version, the Node-engine refusal, a major only offered, the checkout rules
 * (migration guide = its "major", a failed commit not retried) and the idle verdict. Each row is a VERIFICATION row of the
 * auto-update plan that is decided in code.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { npmHoldMs, quietPeriodMs } from '../selfUpdate/constants';
import {
  decideGitUpdate,
  decideNpmUpdate,
  getIdleVerdict,
  type GitCheck,
  type GitPolicyInput,
  type IdleInput,
  type NpmPolicyInput,
} from '../selfUpdate/updatePolicy';

const now = 1_800_000_000_000;

function npmInput(overrides: Partial<NpmPolicyInput> = {}): NpmPolicyInput {
  return {
    runningVersion: '3.4.0',
    runningNode: '22.23.3',
    latest: { version: '3.5.0', engines: '>=22.12', isDeprecated: false },
    firstSeenAt: now - npmHoldMs - 1,
    now,
    mode: 'on',
    failedTargets: [],
    canInstall: true,
    isUserRequested: false,
    ...overrides,
  };
}

describe('npm', () => {
  test('first seen now: nothing installs before the 4 h hold ends — it names when', () => {
    assert.deepEqual(decideNpmUpdate(npmInput({ firstSeenAt: undefined })), { action: 'waitHold', until: now + npmHoldMs });
    assert.deepEqual(decideNpmUpdate(npmInput({ firstSeenAt: now - npmHoldMs + 1 })), { action: 'waitHold', until: now + 1 });
  });

  test('hold over, a patch or minor above the running one → install', () => {
    assert.deepEqual(decideNpmUpdate(npmInput()), { action: 'install' });
    assert.deepEqual(decideNpmUpdate(npmInput({ latest: { version: '3.4.1', engines: null, isDeprecated: false } })), { action: 'install' });
    assert.deepEqual(decideNpmUpdate(npmInput({ firstSeenAt: now - npmHoldMs })), { action: 'install' });
  });

  test('«Update now» skips the hold and installs a version still held', () => {
    assert.deepEqual(decideNpmUpdate(npmInput({ firstSeenAt: undefined, isUserRequested: true })), { action: 'install' });
  });

  test('never a downgrade, the running version again, or a prerelease', () => {
    for (const version of ['3.4.0', '3.3.9', '2.9.0', '3.6.0-rc.1', 'latest']) {
      assert.deepEqual(decideNpmUpdate(npmInput({ latest: { version, engines: null, isDeprecated: false } })), { action: 'none' }, version);
    }
  });

  test('a deprecated version is skipped, also when it was deprecated during the hold, also on request', () => {
    const deprecated = { version: '3.5.0', engines: null, isDeprecated: true };
    assert.deepEqual(decideNpmUpdate(npmInput({ latest: deprecated })), { action: 'none' });
    assert.deepEqual(decideNpmUpdate(npmInput({ latest: deprecated, firstSeenAt: undefined })), { action: 'none' });
    assert.deepEqual(decideNpmUpdate(npmInput({ latest: deprecated, isUserRequested: true })), { action: 'none' });
  });

  test('a major is only offered, after the hold; «Update now» installs it', () => {
    const major = { version: '4.0.0', engines: null, isDeprecated: false };
    assert.deepEqual(decideNpmUpdate(npmInput({ latest: major })), { action: 'offerMajor' });
    assert.deepEqual(decideNpmUpdate(npmInput({ latest: major, mode: 'notify' })), { action: 'offerMajor' });
    assert.equal(decideNpmUpdate(npmInput({ latest: major, firstSeenAt: undefined })).action, 'waitHold');
    assert.deepEqual(decideNpmUpdate(npmInput({ latest: major, isUserRequested: true })), { action: 'install' });
  });

  test('a version whose engines.node the running Node does not satisfy is not installed — it says what it needs', () => {
    const needsNewer = { version: '3.5.0', engines: '>=24', isDeprecated: false };
    assert.deepEqual(decideNpmUpdate(npmInput({ latest: needsNewer })), { action: 'needsNode', required: '>=24' });
    assert.equal(decideNpmUpdate(npmInput({ latest: needsNewer, firstSeenAt: undefined })).action, 'waitHold', 'the notice waits for the hold too');
    assert.deepEqual(decideNpmUpdate(npmInput({ latest: needsNewer, isUserRequested: true })), { action: 'needsNode', required: '>=24' });
  });

  test('an engines range that cannot be read does not refuse the version', () => {
    assert.deepEqual(decideNpmUpdate(npmInput({ latest: { version: '3.5.0', engines: 'lts/*', isDeprecated: false } })), { action: 'install' });
  });

  test('notify mode, and an install that can only notify, never install', () => {
    assert.deepEqual(decideNpmUpdate(npmInput({ mode: 'notify' })), { action: 'notify' });
    assert.deepEqual(decideNpmUpdate(npmInput({ canInstall: false })), { action: 'notify' });
    assert.deepEqual(decideNpmUpdate(npmInput({ mode: 'notify', firstSeenAt: undefined })).action, 'waitHold', 'the notice waits for the hold too');
  });

  test('off does nothing by itself; a manual request still works', () => {
    assert.deepEqual(decideNpmUpdate(npmInput({ mode: 'off' })), { action: 'none' });
    assert.deepEqual(decideNpmUpdate(npmInput({ mode: 'off', isUserRequested: true })), { action: 'install' });
  });

  test('a failed version is not retried by itself — a newer one is, and a tap retries it', () => {
    assert.deepEqual(decideNpmUpdate(npmInput({ failedTargets: ['3.5.0'] })), { action: 'none' });
    assert.deepEqual(decideNpmUpdate(npmInput({ failedTargets: ['3.5.0'], latest: { version: '3.5.1', engines: null, isDeprecated: false } })), { action: 'install' });
    assert.deepEqual(decideNpmUpdate(npmInput({ failedTargets: ['3.5.0'], isUserRequested: true })), { action: 'install' });
  });
});

describe('git checkout', () => {
  const behind: GitCheck = { status: 'behind', reason: null, from: 'a1b2c3d', to: 'd4e5f6a', behind: 12, migrationGuides: [] };

  function gitInput(overrides: Partial<GitPolicyInput> = {}): GitPolicyInput {
    return { check: behind, mode: 'on', failedTargets: [], canInstall: true, isUserRequested: false, ...overrides };
  }

  test('behind its upstream, no hold → install', () => {
    assert.deepEqual(decideGitUpdate(gitInput()), { action: 'install' });
  });

  test('up to date → nothing', () => {
    assert.deepEqual(decideGitUpdate(gitInput({ check: { ...behind, status: 'upToDate', behind: 0, to: behind.from } })), { action: 'none' });
  });

  test('a checkout the script leaves alone is skipped with its reason — also under off', () => {
    for (const reason of ['dirty', 'diverged', 'noUpstream', 'inProgress', 'fetchFailed'] as const) {
      const check: GitCheck = { ...behind, status: 'skip', reason };
      assert.deepEqual(decideGitUpdate(gitInput({ check })), { action: 'skipped', reason });
      assert.deepEqual(decideGitUpdate(gitInput({ check, mode: 'off' })), { action: 'skipped', reason });
    }
  });

  test('a range that adds a MIGRATION_*.md is not merged by itself — it is offered', () => {
    const check: GitCheck = { ...behind, migrationGuides: ['MIGRATION_3_TO_4.md'] };
    assert.deepEqual(decideGitUpdate(gitInput({ check })), { action: 'offerBreaking', migrationGuides: ['MIGRATION_3_TO_4.md'] });
    assert.deepEqual(decideGitUpdate(gitInput({ check, mode: 'notify' })), { action: 'offerBreaking', migrationGuides: ['MIGRATION_3_TO_4.md'] });
    assert.deepEqual(decideGitUpdate(gitInput({ check, isUserRequested: true })), { action: 'install' });
  });

  test('a target commit whose install failed is not retried until upstream moves; a tap retries it', () => {
    assert.deepEqual(decideGitUpdate(gitInput({ failedTargets: ['d4e5f6a'] })), { action: 'none' });
    assert.deepEqual(decideGitUpdate(gitInput({ failedTargets: ['0000000'] })), { action: 'install' });
    assert.deepEqual(decideGitUpdate(gitInput({ failedTargets: ['d4e5f6a'], isUserRequested: true })), { action: 'install' });
  });

  test('notify, off and a checkout that can only notify', () => {
    assert.deepEqual(decideGitUpdate(gitInput({ mode: 'notify' })), { action: 'notify' });
    assert.deepEqual(decideGitUpdate(gitInput({ canInstall: false })), { action: 'notify' });
    assert.deepEqual(decideGitUpdate(gitInput({ mode: 'off' })), { action: 'none' });
    assert.deepEqual(decideGitUpdate(gitInput({ mode: 'off', isUserRequested: true })), { action: 'install' });
  });
});

describe('the idle verdict', () => {
  function idleInput(overrides: Partial<IdleInput> = {}): IdleInput {
    return {
      isAnyAgentWorking: false,
      hasUnconsumedInput: false,
      hasBufferedStartupPrompt: false,
      isSignInRunning: false,
      isWizardOpen: false,
      lastHumanMessageAt: now - quietPeriodMs,
      now,
      quietMs: quietPeriodMs,
      isUserRequested: false,
      ...overrides,
    };
  }

  test('nothing working, nothing waiting, 10 quiet minutes → idle; no message at all since the start counts as quiet', () => {
    assert.deepEqual(getIdleVerdict(idleInput()), { isIdle: true });
    assert.deepEqual(getIdleVerdict(idleInput({ lastHumanMessageAt: null })), { isIdle: true });
  });

  test('each blocker names itself', () => {
    assert.deepEqual(getIdleVerdict(idleInput({ isAnyAgentWorking: true })), { isIdle: false, reason: 'working' });
    assert.deepEqual(getIdleVerdict(idleInput({ hasUnconsumedInput: true })), { isIdle: false, reason: 'unconsumedInput' });
    assert.deepEqual(getIdleVerdict(idleInput({ hasBufferedStartupPrompt: true })), { isIdle: false, reason: 'startupBuffer' });
    assert.deepEqual(getIdleVerdict(idleInput({ isSignInRunning: true })), { isIdle: false, reason: 'signIn' });
    assert.deepEqual(getIdleVerdict(idleInput({ isWizardOpen: true })), { isIdle: false, reason: 'wizard' });
    assert.deepEqual(getIdleVerdict(idleInput({ lastHumanMessageAt: now - quietPeriodMs + 1 })), { isIdle: false, reason: 'recentMessage' });
  });

  test('«Update now» skips the quiet rule only: it still waits for work and sign-ins', () => {
    assert.deepEqual(getIdleVerdict(idleInput({ lastHumanMessageAt: now - 1, isUserRequested: true })), { isIdle: true });
    assert.deepEqual(getIdleVerdict(idleInput({ isAnyAgentWorking: true, isUserRequested: true })), { isIdle: false, reason: 'working' });
    assert.deepEqual(getIdleVerdict(idleInput({ isSignInRunning: true, isUserRequested: true })), { isIdle: false, reason: 'signIn' });
  });
});
