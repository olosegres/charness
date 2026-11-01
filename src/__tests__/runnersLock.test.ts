/**
 * @description `runners/hubLock.ts`: mutual exclusion between SEPARATE PROCESSES — the sshd-started gates, the bot and the CLI all take
 * this lock. Workers start together on a barrier and contend; a marker file that only the holder may create and a read-modify-write
 * counter show an overlap or a lost update. The reclaim case kills a holder with SIGKILL and releases many contenders at once onto its
 * dead lock — every one of them sees the same dead owner, the case a «delete the stale file» takeover gets wrong.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getProcessStartKey, withHubLock } from '../runners/hubLock';
import { waitUntil } from './runnersTestKit';

const workerPath = path.join(__dirname, 'runnersLockWorker.ts');
const repoRoot = path.resolve(__dirname, '..', '..');
const workerCount = 6;
const iterationsPerWorker = 15;
const workerTimeoutMs = 60_000;

let root = '';
let registryDir = '';
let sharedDir = '';
const children: ChildProcess[] = [];

interface WorkerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

function startWorker(args: string[]): { child: ChildProcess; exited: Promise<WorkerExit> } {
  const child = spawn(process.execPath, ['--import', 'tsx', workerPath, ...args], { cwd: repoRoot, stdio: ['ignore', 'ignore', 'pipe'] });
  children.push(child);
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
  const exited = new Promise<WorkerExit>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal, stderr })));
  return { child, exited };
}

async function contend(workers: number, iterations: number): Promise<void> {
  const running = Array.from({ length: workers }, (_unused, index) => startWorker(['contend', registryDir, sharedDir, index.toString(), iterations.toString()]));
  await waitUntil(() => Array.from({ length: workers }, (_unused, index) => fs.existsSync(path.join(sharedDir, `ready.${index}`))).every(Boolean), 'every worker to be ready', workerTimeoutMs);
  fs.writeFileSync(path.join(sharedDir, 'go'), '');
  const exits = await Promise.race([
    Promise.all(running.map((worker) => worker.exited)),
    new Promise<never>((_resolve, reject) => { setTimeout(() => reject(new Error('the workers did not finish')), workerTimeoutMs); }),
  ]);
  for (const exit of exits) assert.equal(exit.code, 0, exit.stderr);
}

function readViolations(): string {
  const violationsPath = path.join(sharedDir, 'violations.log');
  return fs.existsSync(violationsPath) ? fs.readFileSync(violationsPath, 'utf8') : '';
}

describe('registry lock between processes', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-'));
    registryDir = path.join(root, 'r');
    sharedDir = path.join(root, 's');
    fs.mkdirSync(sharedDir);
  });
  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('lets one process at a time into the critical section, with no lost update', async () => {
    await contend(workerCount, iterationsPerWorker);
    assert.equal(readViolations(), '');
    assert.equal(Number(fs.readFileSync(path.join(sharedDir, 'counter'), 'utf8')), workerCount * iterationsPerWorker);
  });

  it('a holder killed inside the section is reclaimed by contenders that all see the same dead owner — still one at a time', async () => {
    const dying = startWorker(['die-holding', registryDir, sharedDir]);
    const exit = await dying.exited;
    assert.equal(exit.signal, 'SIGKILL');
    assert.ok(fs.existsSync(path.join(sharedDir, 'holding')));
    assert.ok(fs.readdirSync(registryDir).some((name) => /^lock\.\d+$/.test(name)), 'the dead holder left its lock behind');

    await contend(workerCount, iterationsPerWorker);
    assert.equal(readViolations(), '');
    assert.equal(Number(fs.readFileSync(path.join(sharedDir, 'counter'), 'utf8')), workerCount * iterationsPerWorker);
  });
});

describe('a holder that is alive keeps the lock', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-'));
    registryDir = path.join(root, 'r');
    sharedDir = path.join(root, 's');
    fs.mkdirSync(sharedDir);
  });
  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('a holder suspended inside its critical section is not overtaken: the contender waits, and the two sections never overlap', async () => {
    const holder = startWorker(['hold-stopped', registryDir, sharedDir]);
    await waitUntil(() => fs.existsSync(path.join(sharedDir, 'holding')), 'the holder to be inside its section', workerTimeoutMs);
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    const contender = startWorker(['contend', registryDir, sharedDir, '0', '1']);
    await waitUntil(() => fs.existsSync(path.join(sharedDir, 'ready.0')), 'the contender to be ready', workerTimeoutMs);
    fs.writeFileSync(path.join(sharedDir, 'go'), '');

    let contenderExited = false;
    void contender.exited.then(() => { contenderExited = true; });
    await new Promise((resolve) => { setTimeout(resolve, 2000); });
    assert.equal(contenderExited, false, 'the contender is still waiting for the stopped holder');
    assert.equal(fs.existsSync(path.join(sharedDir, 'counter')), false, 'nobody has entered a section yet');
    assert.equal(readViolations(), '');

    const holderPid = holder.child.pid;
    if (holderPid === undefined) throw new Error('the holder has no pid');
    process.kill(holderPid, 'SIGCONT');
    const [holderExit, contenderExit] = await Promise.all([holder.exited, contender.exited]);
    assert.equal(holderExit.code, 0, holderExit.stderr);
    assert.equal(contenderExit.code, 0, contenderExit.stderr);
    assert.ok(fs.existsSync(path.join(sharedDir, 'resumed')));
    assert.equal(readViolations(), '', 'the resumed holder finished its section before the contender entered');
    assert.equal(Number(fs.readFileSync(path.join(sharedDir, 'counter'), 'utf8')), 2, 'neither update was lost');
  });
});

describe('registry lock inside one process', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-'));
    registryDir = path.join(root, 'r');
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('a released lock leaves one marker file, and the next holder numbers after it', async () => {
    await withHubLock(registryDir, () => undefined);
    assert.deepEqual(fs.readdirSync(registryDir), ['lock.1']);
    await withHubLock(registryDir, () => undefined);
    assert.deepEqual(fs.readdirSync(registryDir), ['lock.2']);
  });

  it('a critical section that throws still releases the lock', async () => {
    await assert.rejects(withHubLock(registryDir, () => { throw new Error('boom'); }), /boom/);
    assert.equal(await withHubLock(registryDir, () => 'free'), 'free');
  });

  it('waits for a holder in the same process and runs the sections one after the other', async () => {
    const order: string[] = [];
    await Promise.all(['a', 'b', 'c'].map((name) => withHubLock(registryDir, async () => {
      order.push(`${name}-in`);
      await new Promise((resolve) => { setTimeout(resolve, 30); });
      order.push(`${name}-out`);
    })));
    for (let index = 0; index < order.length; index += 2) assert.equal(order[index].replace('-in', ''), order[index + 1].replace('-out', ''));
  });

  it('does not take over a lock that a live process holds, however long it has held it', async () => {
    fs.mkdirSync(registryDir, { recursive: true });
    const aDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    fs.writeFileSync(path.join(registryDir, 'lock.3'), JSON.stringify({ pid: process.pid, token: 'live', startedAtMs: aDayAgo, startKey: getProcessStartKey(process.pid), releasedAtMs: null }));
    let ran = false;
    const waiting = withHubLock(registryDir, () => { ran = true; });
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    assert.equal(ran, false);
    fs.rmSync(path.join(registryDir, 'lock.3'));
    await waiting;
    assert.equal(ran, true);
  });

  it('a pid that now belongs to another process (it started at another time) is not the holder: the lock is taken over', async () => {
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(path.join(registryDir, 'lock.2'), JSON.stringify({ pid: process.pid, token: 'reused', startedAtMs: Date.now(), startKey: 'a start time that is not this process\'s', releasedAtMs: null }));
    assert.equal(await withHubLock(registryDir, () => 'taken'), 'taken');
  });

  it('a lock file that does not read counts as a dead holder', async () => {
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(path.join(registryDir, 'lock.4'), 'garbage');
    assert.equal(await withHubLock(registryDir, () => 'ok'), 'ok');
  });

  it('the highest number decides, and a taker removes the lower files', async () => {
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(path.join(registryDir, 'lock.2'), JSON.stringify({ pid: process.pid, token: 'ghost', startedAtMs: 0, startKey: null, releasedAtMs: 1 }));
    fs.writeFileSync(path.join(registryDir, 'lock.5'), JSON.stringify({ pid: process.pid, token: 'top', startedAtMs: 0, startKey: null, releasedAtMs: 1 }));
    await withHubLock(registryDir, () => undefined);
    assert.deepEqual(fs.readdirSync(registryDir), ['lock.6']);
  });
});
