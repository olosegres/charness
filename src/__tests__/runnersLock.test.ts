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
import { holderStaleAfterMs, withHubLock } from '../runners/hubLock';
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

  it('takes over a lock whose record is older than the stale limit even though its pid is alive (a hung holder)', async () => {
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(path.join(registryDir, 'lock.7'), JSON.stringify({ pid: process.pid, token: 'old', startedAtMs: Date.now() - holderStaleAfterMs - 1000, releasedAtMs: null }));
    assert.equal(await withHubLock(registryDir, () => 'taken'), 'taken');
    assert.deepEqual(fs.readdirSync(registryDir), ['lock.8']);
  });

  it('does not take over a lock that a live process holds', async () => {
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(path.join(registryDir, 'lock.3'), JSON.stringify({ pid: process.pid, token: 'live', startedAtMs: Date.now(), releasedAtMs: null }));
    let ran = false;
    const waiting = withHubLock(registryDir, () => { ran = true; });
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    assert.equal(ran, false);
    fs.rmSync(path.join(registryDir, 'lock.3'));
    await waiting;
    assert.equal(ran, true);
  });

  it('a lock file that does not read counts as a dead holder', async () => {
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(path.join(registryDir, 'lock.4'), 'garbage');
    assert.equal(await withHubLock(registryDir, () => 'ok'), 'ok');
  });

  it('the highest number decides, and a taker removes the lower files', async () => {
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(path.join(registryDir, 'lock.2'), JSON.stringify({ pid: process.pid, token: 'ghost', startedAtMs: 0, releasedAtMs: 1 }));
    fs.writeFileSync(path.join(registryDir, 'lock.5'), JSON.stringify({ pid: process.pid, token: 'top', startedAtMs: 0, releasedAtMs: 1 }));
    await withHubLock(registryDir, () => undefined);
    assert.deepEqual(fs.readdirSync(registryDir), ['lock.6']);
  });
});
