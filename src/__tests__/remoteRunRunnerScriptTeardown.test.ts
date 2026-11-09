/**
 * @description What a test of `remoteRun/runner.sh` must do before it removes its work dir (`stopDetachedRuns`, `removeTestRoot` of the kit): the script DETACHES some of its work — a refused `prepare` starts `measure-copies`, a `prepare` the
 * sweep of idle copies, a probe of a view the prune — so that the ssh call that started it returns, and that work writes into a copy's folder (`size-kb`) for as long as its walk lasts. A teardown that removes the tree meanwhile met a file
 * that appeared between its listing of a folder and its `rmdir`: `ENOTEMPTY`, a failed `afterEach` hook, on a loaded GitHub runner. Here the walk is made slow on purpose (a `du` that sleeps), so the race is not a matter of luck.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { removeTestRoot, scriptPath, startStrangerProcess, stopDetachedRuns, stopRunnerStandIns, writeFile } from './remoteRunRunnerScriptKit';

const duDelaySeconds = 0.6;

let root = '';
let workDir = '';
let binDir = '';

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teardown-')));
  workDir = path.join(root, 'work');
  binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir);
  // A `du` that takes its time: the walk of a copy of tens of GB.
  fs.writeFileSync(path.join(binDir, 'du'), `#!/bin/bash\nsleep ${duDelaySeconds}\nexec ${spawnSync('which', ['du'], { encoding: 'utf8' }).stdout.trim()} "$@"\n`, { mode: 0o755 });
  for (const copy of ['one-aaaaaaaaaa', 'two-bbbbbbbbbb']) {
    writeFile(path.join(workDir, 'p', copy), 'tree/file.txt');
    writeFile(path.join(workDir, 'p', copy), 'used', '');
  }
});
afterEach(() => {
  stopRunnerStandIns();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Start `measure-copies` the way the script's `start_detached_run` does for `prepare`: detached (output and input away, so the call that started it returns), its pid in `<work>/tmp/measure-copies.pid`. */
function startMeasuring(): number {
  const detach = 'mkdir -p "$2/tmp"; ( nice -n 19 bash "$1" measure-copies "$2" > /dev/null 2>&1 < /dev/null & echo "$!" > "$2/tmp/measure-copies.pid" )';
  const started = spawnSync('bash', ['-c', detach, 'detach', scriptPath, workDir], { env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` }, encoding: 'utf8' });
  assert.equal(started.status, 0, started.stderr);
  return Number.parseInt(fs.readFileSync(path.join(workDir, 'tmp', 'measure-copies.pid'), 'utf8').trim(), 10);
}

function checkIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('the teardown of a test of the runner script', () => {
  it('`stopDetachedRuns` waits for what the script detached: the walk is still going when the call that started it has returned, and over when the helper returns — with its figures written', () => {
    const pid = startMeasuring();
    assert.ok(checkIsAlive(pid), 'the detached run outlives the call that started it');
    assert.equal(fs.existsSync(path.join(workDir, 'p', 'one-aaaaaaaaaa', 'size-kb')), false, 'and has not written yet');
    stopDetachedRuns(root);
    assert.equal(checkIsAlive(pid), false, 'it is over');
    for (const copy of ['one-aaaaaaaaaa', 'two-bbbbbbbbbb']) assert.equal(fs.existsSync(path.join(workDir, 'p', copy, 'size-kb')), true, `${copy} was measured: it was waited for, not cut off`);
  });

  it('`removeTestRoot` removes the tree although a detached run is walking it: no ENOTEMPTY, nothing is written after it', () => {
    const pid = startMeasuring();
    removeTestRoot(root);
    assert.equal(fs.existsSync(root), false);
    assert.equal(checkIsAlive(pid), false);
  });

  it('a pid file whose number now belongs to another process (it outlived its run, and a reboot or a busy pid table gave the number away) is neither waited for nor killed', () => {
    const strangerPid = startStrangerProcess();
    writeFile(workDir, 'tmp/measure-copies.pid', `${strangerPid}\n`);
    const startedAt = Date.now();
    stopDetachedRuns(root);
    assert.ok(Date.now() - startedAt < 3000, 'it did not wait for a process that is not ours');
    assert.ok(checkIsAlive(strangerPid), 'and left it alone');
  });

  it('a root with nothing detached, or a pid file with no number in it, is no trouble', () => {
    stopDetachedRuns(root);
    writeFile(workDir, 'tmp/sweep-tmpdirs.pid', 'not a number\n');
    stopDetachedRuns(root);
    removeTestRoot(root);
    assert.equal(fs.existsSync(root), false);
  });
});
