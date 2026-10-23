/**
 * @description The pure decisions of the release's test gate (`src/release/testGate.ts`): what the Tests workflow's runs of one exact
 * commit say, what each release entry does about it, and whether the release commit is the tested one plus its version bump.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  decideTestGate,
  decideTestGateThroughParent,
  getReleaseDeltaProblems,
  getTestGateVerdict,
  type TestGateVerdict,
  type WorkflowRun,
} from '../release/testGate';

const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const otherSha = 'ffffffffffffffffffffffffffffffffffffffff';
let runCounter = 0;

function createRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  runCounter += 1;
  return {
    id: runCounter,
    head_sha: sha,
    status: 'completed',
    conclusion: 'success',
    created_at: `2026-10-23T10:${runCounter.toString().padStart(2, '0')}:00Z`,
    html_url: `https://github.example/runs/${runCounter}`,
    ...overrides,
  };
}

describe('getTestGateVerdict', () => {
  test('a green run of the commit passes', () => {
    const verdict = getTestGateVerdict([createRun()], sha);
    assert.equal(verdict.state, 'passed');
    assert.match(verdict.reason, /the Tests run for a1b2c3d passed \(https:\/\/github\.example\/runs\/\d+\)/);
  });

  test('no run at all, or runs of other commits only, is none', () => {
    assert.equal(getTestGateVerdict([], sha).state, 'none');
    const verdict = getTestGateVerdict([createRun({ head_sha: otherSha })], sha);
    assert.equal(verdict.state, 'none');
    assert.match(verdict.reason, /has no run for a1b2c3d/);
  });

  test('a failed run names its conclusion; a cancelled or timed-out one is not a pass either', () => {
    for (const conclusion of ['failure', 'cancelled', 'timed_out', 'startup_failure', 'neutral', 'skipped']) {
      const verdict = getTestGateVerdict([createRun({ conclusion })], sha);
      assert.equal(verdict.state, 'failed', conclusion);
      assert.match(verdict.reason, new RegExp(`did not pass: ${conclusion}`));
    }
    assert.equal(getTestGateVerdict([createRun({ conclusion: null })], sha).state, 'failed');
  });

  test('a queued or running run is running, whatever its (absent) conclusion', () => {
    for (const status of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) {
      const verdict = getTestGateVerdict([createRun({ status, conclusion: null })], sha);
      assert.equal(verdict.state, 'running', status);
    }
    assert.match(getTestGateVerdict([createRun({ status: 'in_progress', conclusion: null })], sha).reason, /still in progress/);
  });

  test('the newest run of the commit decides: a red rerun after a green one is red, a green one after a red one is green', () => {
    const green = createRun({ created_at: '2026-10-23T09:00:00Z' });
    const red = createRun({ conclusion: 'failure', created_at: '2026-10-23T09:30:00Z' });
    assert.equal(getTestGateVerdict([green, red], sha).state, 'failed');
    assert.equal(getTestGateVerdict([red, green], sha).state, 'failed');
    const laterGreen = createRun({ created_at: '2026-10-23T10:00:00Z' });
    assert.equal(getTestGateVerdict([red, green, laterGreen], sha).state, 'passed');
  });

  test('runs of other commits never count', () => {
    const foreignRed = createRun({ head_sha: otherSha, conclusion: 'failure', created_at: '2026-10-23T11:00:00Z' });
    assert.equal(getTestGateVerdict([createRun({ created_at: '2026-10-23T09:00:00Z' }), foreignRed], sha).state, 'passed');
  });
});

describe('decideTestGate', () => {
  const passed: TestGateVerdict = { state: 'passed', reason: 'the Tests run for a1b2c3d passed (url)' };
  const none: TestGateVerdict = { state: 'none', reason: 'the Tests workflow has no run for a1b2c3d' };
  const failed: TestGateVerdict = { state: 'failed', reason: 'the Tests run for a1b2c3d did not pass: failure (url)' };
  const running: TestGateVerdict = { state: 'running', reason: 'the Tests run for a1b2c3d is still in progress (url)' };

  test('passed → go on without running the suite again, for every entry', () => {
    for (const event of ['schedule', 'workflow_dispatch', 'push']) {
      const decision = decideTestGate(passed, event);
      assert.deepEqual([decision.proceed, decision.runSuite, decision.isRefusal], [true, false, false], event);
    }
    assert.match(decideTestGate(passed, 'schedule').message, /does not run the suite again/);
  });

  test('no run at all (a dispatch before CI ran) → go on and run the suite here', () => {
    const decision = decideTestGate(none, 'workflow_dispatch');
    assert.deepEqual([decision.proceed, decision.runSuite, decision.isRefusal], [true, true, false]);
    assert.match(decision.message, /runs the suite itself/);
  });

  test('the daily run skips a red head: no release that day, green, with the reason', () => {
    const decision = decideTestGate(failed, 'schedule');
    assert.deepEqual([decision.proceed, decision.runSuite, decision.isRefusal], [false, false, false]);
    assert.match(decision.message, /^No release today: the Tests run for a1b2c3d did not pass: failure/);
    assert.match(decision.message, /The next daily run tries again\.$/);
  });

  test('the daily run skips a head whose tests are still running, the same way', () => {
    const decision = decideTestGate(running, 'schedule');
    assert.deepEqual([decision.proceed, decision.isRefusal], [false, false]);
    assert.match(decision.message, /^No release today: .*still in progress/);
  });

  test('a manual dispatch or a hand-pushed tag REFUSES a red or running commit, saying what to do', () => {
    for (const event of ['workflow_dispatch', 'push']) {
      const redDecision = decideTestGate(failed, event);
      assert.deepEqual([redDecision.proceed, redDecision.runSuite, redDecision.isRefusal], [false, false, true], event);
      assert.match(redDecision.message, /^Refusing to release: .*did not pass: failure.*; fix the tests/);
      const runningDecision = decideTestGate(running, event);
      assert.equal(runningDecision.isRefusal, true, event);
      assert.match(runningDecision.message, /wait for it to finish, then run the release again\.$/);
    }
  });
});

describe('decideTestGateThroughParent', () => {
  const passedParent: TestGateVerdict = { state: 'passed', reason: 'the Tests run for a1b2c3d passed (url)' };

  test('a green parent and a tag that is only a version bump: go on without waiting for the tag\'s own run and without the suite', () => {
    const decision = decideTestGateThroughParent(passedParent, []);
    assert.deepEqual([decision?.proceed, decision?.runSuite, decision?.isRefusal], [true, false, false]);
    assert.match(decision?.message ?? '', /^the Tests run for a1b2c3d passed \(url\), and the tagged commit differs from it only in the version and the CHANGELOG/);
  });

  test('a tag that carries more than the version bump does not ride on its parent: the tagged commit\'s own run decides', () => {
    assert.equal(decideTestGateThroughParent(passedParent, ['src/bot.ts differs from the tested commit']), null);
  });

  test('a parent that is not green — red, still running, never run — is no basis either', () => {
    for (const state of ['failed', 'running', 'none'] as const) {
      assert.equal(decideTestGateThroughParent({ state, reason: 'x' }, []), null, state);
    }
  });
});

describe('getReleaseDeltaProblems', () => {
  const versionBump = [
    'diff --git a/package.json b/package.json',
    'index 1111111..2222222 100644',
    '--- a/package.json',
    '+++ b/package.json',
    '@@ -3 +3 @@',
    '-  "version": "3.3.2",',
    '+  "version": "3.4.0",',
  ].join('\n');

  test('only the version line of package.json and the CHANGELOG differ → no problem', () => {
    assert.deepEqual(getReleaseDeltaProblems({ changedPaths: ['CHANGELOG.md', 'package.json'], manifestDiff: versionBump }), []);
    assert.deepEqual(getReleaseDeltaProblems({ changedPaths: ['CHANGELOG.md'], manifestDiff: '' }), []);
    assert.deepEqual(getReleaseDeltaProblems({ changedPaths: [], manifestDiff: '' }), []);
  });

  test('any other path is named', () => {
    assert.deepEqual(getReleaseDeltaProblems({ changedPaths: ['CHANGELOG.md', 'package.json', 'src/bot.ts', 'yarn.lock'], manifestDiff: versionBump }), [
      'src/bot.ts differs from the tested commit',
      'yarn.lock differs from the tested commit',
    ]);
  });

  test('package.json changed beyond its version line is refused: a dependency line, a second change, a removed line', () => {
    const withDependency = `${versionBump}\n+    "left-pad": "^1.0.0",`;
    const dependencyOnly = ['--- a/package.json', '+++ b/package.json', '@@ -9 +9 @@', '-    "left": "^1.0.0",', '+    "left": "^2.0.0",'].join('\n');
    const versionRemovedOnly = ['--- a/package.json', '+++ b/package.json', '@@ -3 +0,0 @@', '-  "version": "3.3.2",'].join('\n');
    for (const manifestDiff of [withDependency, dependencyOnly, versionRemovedOnly]) {
      assert.deepEqual(getReleaseDeltaProblems({ changedPaths: ['package.json'], manifestDiff }), ['package.json differs from the tested commit in more than its "version" line']);
    }
  });

  test('a version line "changed" to the same version, or to something that is not X.Y.Z, is not a bump', () => {
    const same = versionBump.replace('3.4.0', '3.3.2');
    const notSemver = versionBump.replace('3.4.0', '3.4.0-evil');
    for (const manifestDiff of [same, notSemver]) {
      assert.equal(getReleaseDeltaProblems({ changedPaths: ['package.json'], manifestDiff }).length, 1);
    }
  });
});
