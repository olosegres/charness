/**
 * @description `runner.sh apply-groups <work> <name=parallel,…>`: the Pueue steps of `prepare` and nothing else — the daemon is there, each group exists and has
 * its parallel limit — so a changed «jobs at once» takes effect when the operator sets it, not at the next job's `prepare`. Driven against a Pueue stand-in
 * that records its arguments (the real Pueue is exercised by the lifecycle flow, `remoteRunLifecycleE2e.test.ts`).
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { scriptPath } from './remoteRunRunnerScriptKit';

/** Records every call; `parallel` fails for the group named in FAKE_FAIL_GROUP. */
const fakePueue = `#!/bin/bash
echo "$*" >> "$FAKE_PUEUE_LOG"
if [ "$1" = parallel ] && [ "$3" = "\${FAKE_FAIL_GROUP:-}" ]; then exit 1; fi
exit 0
`;

let root = '';
let workDir = '';
let logFile = '';

function runApplyGroups(groups: string | null, env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string; calls: string[] } {
  const binDir = path.join(root, 'bin');
  const result = spawnSync('bash', [scriptPath, 'apply-groups', workDir, ...(groups === null ? [] : [groups])], {
    encoding: 'utf8',
    env: { ...process.env, PUEUE_BIN: path.join(binDir, 'pueue'), FAKE_PUEUE_LOG: logFile, ...env },
    timeout: 60_000,
  });
  const calls = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter((line) => line !== '') : [];
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-groups-')));
  workDir = path.join(root, 'work');
  logFile = path.join(root, 'pueue.log');
  fs.mkdirSync(path.join(root, 'bin'));
  fs.writeFileSync(path.join(root, 'bin', 'pueue'), fakePueue, { mode: 0o755 });
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('runner.sh apply-groups', () => {
  it('checks the daemon and sets each group\'s parallel limit, adding a group that is not the default one before its limit', () => {
    const result = runApplyGroups('default=2,emulator=1');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, ['status', 'parallel -g default 2', 'group add emulator', 'parallel -g emulator 1']);
  });

  it('is what a paired runner is sent: the default group alone', () => {
    const result = runApplyGroups('default=4');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, ['status', 'parallel -g default 4']);
  });

  it('creates the work folder when it is not there yet, and touches nothing else in it (no job folder, no project copy)', () => {
    runApplyGroups('default=1');
    assert.deepEqual(fs.readdirSync(workDir), []);
  });

  it('with no groups it only checks the daemon', () => {
    for (const groups of [null, '']) {
      fs.rmSync(logFile, { force: true });
      const result = runApplyGroups(groups);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.calls, ['status']);
    }
  });

  it('says so, and exits non-zero, when Pueue refuses a limit — after having tried every group', () => {
    const result = runApplyGroups('default=2,emulator=1', { FAKE_FAIL_GROUP: 'default' });
    assert.equal(result.status, 125);
    assert.match(result.stderr, /Pueue refused a parallel limit/);
    assert.deepEqual(result.calls, ['status', 'parallel -g default 2', 'group add emulator', 'parallel -g emulator 1']);
  });

  it('`prepare` goes on when a limit is refused, as it always did (the job is still prepared; the refusal is only `apply-groups`\'s to report)', () => {
    const result = spawnSync('bash', [scriptPath, 'prepare', workDir, 'app-abc1234567', 'box1-aaaaaa', 'default=2'], {
      encoding: 'utf8',
      env: { ...process.env, PUEUE_BIN: path.join(root, 'bin', 'pueue'), FAKE_PUEUE_LOG: logFile, FAKE_FAIL_GROUP: 'default' },
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^work=/m);
  });
});
