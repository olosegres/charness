/**
 * @description When a process counts as gone (`checkIsProcessIdentityCurrent`). A process's sockets close only when its
 * LAST thread exits; a multi-threaded one (every Node process: the libuv pool) shows its thread-group leader as a zombie
 * (`Z`) before that. Taking `Z` for gone, the bot — and its tests — thought a process dead while its listening socket
 * still accepted connections, which it then reset: `sttSidecarOwner.test.ts` got `read ECONNRESET` instead of
 * `ECONNREFUSED` from a crashed sidecar under the parallel suite (measured: 35 of 40 exits under load passed through that
 * window, 34 of them with the port still open). A zombie is gone only once its whole thread group is: `Threads: 1`.
 *
 * Linux only (`/proc`); the decoy needs `python3` (in the product image).
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { checkIsProcessIdentityCurrent } from '../installManager';

const decoyPath = path.join(__dirname, 'fixtures', 'zombieLeaderDecoy.py');
const pollMs = 20;
const stateTimeoutMs = 10_000;

function readProcessState(pid: number): { state: string; threads: number } | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const threadsLine = fs.readFileSync(`/proc/${pid}/status`, 'utf8').split('\n').find((line) => line.startsWith('Threads:'));
    return { state: stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3), threads: Number.parseInt(threadsLine?.split(/\s+/)[1] ?? '0', 10) };
  } catch {
    return null;
  }
}

/** The start time `/proc` records for a pid, whatever its state — the identity the code under test compares against. */
function readStartToken(pid: number): string {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19];
}

async function waitFor(description: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + stateTimeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function checkIsPortAccepting(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

async function readFirstLine(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    child.stdout?.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8').trim()));
    child.once('error', reject);
  });
}

test('a process whose leader is a zombie while another thread still holds its socket is NOT gone', { skip: process.platform !== 'linux' }, async () => {
  const decoy = spawn('python3', ['-I', decoyPath], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const port = Number.parseInt(await readFirstLine(decoy), 10);
    assert.ok(decoy.pid, 'the decoy runs');
    const identity = { pid: decoy.pid, startToken: readStartToken(decoy.pid) };
    await waitFor('the decoy\'s leader to be a zombie with a thread left', () => {
      const current = decoy.pid ? readProcessState(decoy.pid) : null;
      return current?.state === 'Z' && current.threads > 1;
    });
    assert.equal(await checkIsPortAccepting(port), true, 'precondition: the socket still accepts connections');

    assert.equal(checkIsProcessIdentityCurrent(identity), true, 'its sockets are open: not gone');

    decoy.kill('SIGKILL');
    await waitFor('the decoy to be reaped', () => decoy.exitCode !== null || decoy.signalCode !== null);
    assert.equal(checkIsProcessIdentityCurrent(identity), false, 'gone once every thread has exited');
  } finally {
    if (decoy.exitCode === null && decoy.signalCode === null) decoy.kill('SIGKILL');
  }
});

test('a fully exited zombie (one thread, not yet reaped) is gone', { skip: process.platform !== 'linux' }, async () => {
  // A parent that never reaps its child keeps it a zombie with its thread group fully gone.
  const parent = spawn('python3', ['-I', '-c', 'import subprocess, time\np = subprocess.Popen(["true"])\nprint(p.pid, flush=True)\ntime.sleep(60)'], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const childPid = Number.parseInt(await readFirstLine(parent), 10);
    await waitFor('the child to be an unreaped zombie', () => {
      const current = readProcessState(childPid);
      return current?.state === 'Z' && current.threads === 1;
    });
    assert.equal(checkIsProcessIdentityCurrent({ pid: childPid, startToken: readStartToken(childPid) }), false);
  } finally {
    parent.kill('SIGKILL');
  }
});
