/**
 * @description The sweep of the runner flow's test layout (`remoteRunE2e/remoteRunFlowSweep.ts` and its detached reaper): the guard
 * that stops a killed or timed-out flow from leaving sshd, Pueue's daemon, runner scripts and decoys running for good. Proven against
 * DECOYS the test starts itself — a process with its working directory in the layout, one that only names the layout on its command line,
 * and a bystander that is neither — never against the real thing:
 *   • the sweep ends exactly the layout's processes and removes its folder;
 *   • a layout whose owner is alive is left alone, one whose owner is gone (or never wrote an owner file and is old) is swept;
 *   • a layout that is brand new and has no owner file yet is left alone: it is being built;
 *   • the DETACHED reaper, started in its own session, sweeps a layout whose owner died, with nothing else of this process alive.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkIsProcessRunning } from './e2e/isolatedCharness';
import {
  flowOwnerFileName,
  ownerlessLayoutGraceMs,
  reapDeadFlowLayouts,
  sweepFlowLayout,
  writeFlowLayoutOwner,
} from './remoteRunE2e/remoteRunFlowSweep';

const layoutNamePrefix = 'crr-sweeptest-';
const reaperPath = path.join(__dirname, 'remoteRunE2e', 'remoteRunFlowReaper.ts');
const tsxLoaderPath = path.join(path.resolve(__dirname, '..', '..'), 'node_modules', 'tsx', 'dist', 'loader.mjs');
const longSleepSeconds = '300';
const goneTimeoutMs = 15_000;
const pollMs = 100;

let parentDirectory = '';
const started: ChildProcess[] = [];

function createLayout(name: string): string {
  const root = path.join(parentDirectory, `${layoutNamePrefix}${name}`);
  fs.mkdirSync(path.join(root, 'tree'), { recursive: true });
  return root;
}

/** A process with its working directory in `cwd` that names nothing of the layout on its command line. */
function startCwdDecoy(cwd: string): ChildProcess {
  const child = spawn('sleep', [longSleepSeconds], { cwd, stdio: 'ignore' });
  started.push(child);
  return child;
}

/** A process that only NAMES the layout on its command line (an operand node ignores), from a directory outside it — and stays alive until swept. */
function startNamedDecoy(root: string): ChildProcess {
  const decoy = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${longSleepSeconds}000)`, '--', root], { cwd: os.tmpdir(), stdio: 'ignore' });
  started.push(decoy);
  return decoy;
}

async function waitUntilGone(child: ChildProcess): Promise<boolean> {
  const deadline = Date.now() + goneTimeoutMs;
  while (Date.now() < deadline) {
    if (child.pid === undefined || !checkIsProcessRunning(child.pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return false;
}

function writeDeadOwner(root: string): void {
  // A pid that ran and ended: its start time cannot match any running process.
  const ended = spawnSync('true');
  fs.writeFileSync(path.join(root, flowOwnerFileName), JSON.stringify({ pid: ended.pid, startTicks: 1 }));
}

describe('the runner flow layout sweep', () => {
  beforeEach(() => {
    parentDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-sweep-'));
  });
  afterEach(() => {
    for (const child of started.splice(0)) child.kill('SIGKILL');
    fs.rmSync(parentDirectory, { recursive: true, force: true });
  });

  it('ends the processes of the layout — by working directory and by command line — and removes the folder; a bystander is untouched', async () => {
    const root = createLayout('sweep');
    const inside = startCwdDecoy(path.join(root, 'tree'));
    const named = startNamedDecoy(root);
    const bystander = startCwdDecoy(parentDirectory);
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const decoy of [inside, named]) assert.equal(decoy.pid !== undefined && checkIsProcessRunning(decoy.pid), true, 'the decoys run before the sweep (else "gone" proves nothing)');
    sweepFlowLayout(root);
    assert.equal(await waitUntilGone(inside), true, 'the decoy with its cwd in the layout is gone');
    assert.equal(await waitUntilGone(named), true, 'the decoy that names the layout is gone');
    assert.equal(fs.existsSync(root), false);
    assert.equal(bystander.pid !== undefined && checkIsProcessRunning(bystander.pid), true, 'a process that is not the layout\'s is untouched');
  });

  it('a sweep with removeFiles:false keeps the folder for a look', () => {
    const root = createLayout('keep');
    sweepFlowLayout(root, { removeFiles: false });
    assert.equal(fs.existsSync(root), true);
  });

  it('reaps the layouts whose owner is gone and keeps the one whose owner is alive', async () => {
    const dead = createLayout('dead');
    writeDeadOwner(dead);
    const deadDecoy = startCwdDecoy(path.join(dead, 'tree'));
    const alive = createLayout('alive');
    writeFlowLayoutOwner(alive);
    const aliveDecoy = startCwdDecoy(path.join(alive, 'tree'));
    const reaped = reapDeadFlowLayouts(parentDirectory, layoutNamePrefix);
    assert.deepEqual(reaped, [dead]);
    assert.equal(await waitUntilGone(deadDecoy), true);
    assert.equal(fs.existsSync(dead), false);
    assert.equal(fs.existsSync(alive), true, 'the layout of a live owner stays');
    assert.equal(aliveDecoy.pid !== undefined && checkIsProcessRunning(aliveDecoy.pid), true);
  });

  it('an owner pid that was reused by another process (its start time differs) counts as gone', () => {
    const reused = createLayout('reused');
    fs.writeFileSync(path.join(reused, flowOwnerFileName), JSON.stringify({ pid: process.pid, startTicks: 1 }));
    assert.deepEqual(reapDeadFlowLayouts(parentDirectory, layoutNamePrefix), [reused]);
  });

  it('a folder without an owner file is left alone while it is brand new and swept once it is old', () => {
    const fresh = createLayout('fresh');
    assert.deepEqual(reapDeadFlowLayouts(parentDirectory, layoutNamePrefix), [], 'being built: not swept');
    const old = new Date(Date.now() - ownerlessLayoutGraceMs - 1000);
    fs.utimesSync(fresh, old, old);
    assert.deepEqual(reapDeadFlowLayouts(parentDirectory, layoutNamePrefix), [fresh]);
  });

  it('a layout of another account is left alone — however dead its owner looks — and the reap goes on to this account\'s own', async () => {
    // The other account's folder is private to it: its owner file cannot be read from here and removing the folder fails with EACCES,
    // which used to end the whole flow's setup. Another account is simulated by asking the reap to run as a different uid.
    const foreign = createLayout('foreign');
    writeDeadOwner(foreign);
    const foreignDecoy = startCwdDecoy(path.join(foreign, 'tree'));
    const ownUid = os.userInfo().uid;
    assert.deepEqual(reapDeadFlowLayouts(parentDirectory, layoutNamePrefix, ownUid + 1), [], 'nothing of this uid\'s is owned by the "other" account');
    assert.equal(fs.existsSync(foreign), true, 'the foreign folder stays');
    assert.equal(foreignDecoy.pid !== undefined && checkIsProcessRunning(foreignDecoy.pid), true, 'and so does what runs in it');
    assert.deepEqual(reapDeadFlowLayouts(parentDirectory, layoutNamePrefix, ownUid), [foreign], 'the same folder IS reaped by its own account');
    assert.equal(await waitUntilGone(foreignDecoy), true);
  });

  it('only folders with the layout prefix are looked at', () => {
    const foreign = path.join(parentDirectory, 'someone-elses-folder');
    fs.mkdirSync(foreign);
    const old = new Date(Date.now() - ownerlessLayoutGraceMs - 1000);
    fs.utimesSync(foreign, old, old);
    assert.deepEqual(reapDeadFlowLayouts(parentDirectory, layoutNamePrefix), []);
    assert.equal(fs.existsSync(foreign), true);
  });

  it('the detached reaper, in a session of its own, sweeps a layout whose owner died — nothing else of this process is involved', async () => {
    const root = createLayout('detached');
    writeDeadOwner(root);
    const decoy = startCwdDecoy(path.join(root, 'tree'));
    const reaper = spawn(process.execPath, ['--import', pathToFileURL(tsxLoaderPath).href, reaperPath, root], {
      detached: true,
      stdio: 'ignore',
      env: { HOME: process.env.HOME ?? '', PATH: process.env.PATH ?? '' },
    });
    reaper.unref();
    started.push(reaper);
    assert.equal(await waitUntilGone(decoy), true, 'the decoy was ended by the reaper');
    const deadline = Date.now() + goneTimeoutMs;
    while (fs.existsSync(root) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, pollMs));
    assert.equal(fs.existsSync(root), false, 'and the folder removed');
  });

  it('the detached reaper leaves a layout whose owner is alive alone', async () => {
    const root = createLayout('detached-alive');
    writeFlowLayoutOwner(root);
    const decoy = startCwdDecoy(path.join(root, 'tree'));
    const reaper = spawn(process.execPath, ['--import', pathToFileURL(tsxLoaderPath).href, reaperPath, root], {
      detached: true,
      stdio: 'ignore',
      env: { HOME: process.env.HOME ?? '', PATH: process.env.PATH ?? '' },
    });
    reaper.unref();
    started.push(reaper);
    // Several of its polls (1 s each), well past its start-up.
    await new Promise((resolve) => setTimeout(resolve, 5000));
    assert.equal(decoy.pid !== undefined && checkIsProcessRunning(decoy.pid), true);
    assert.equal(fs.existsSync(root), true);
  });
});
