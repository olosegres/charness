/**
 * @description The fake `claude`'s hook runner (`jiraE2e/fakeHookRunner.ts`): a hook that prints is read whole, and a hook
 * that hangs — its `node` child held in the foreground, or left behind holding the output pipe after the shell exits — is cut
 * off at its deadline: its whole process group is killed and the promise settles at once, with nothing.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, test } from 'node:test';
import * as assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { runHookCommand } from './jiraE2e/fakeHookRunner';
import { checkIsPidAlive } from '../utils/jsonStreamHost';
import { shellSingleQuote } from '../utils/tmuxExec';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-hook-runner-'));
/** The pids of the children this test started: killed in `after` should one have survived (never anyone else's). */
const startedPids: number[] = [];
after(() => {
  for (const pid of startedPids) {
    if (checkIsPidAlive(pid)) process.kill(pid, 'SIGKILL');
  }
  fs.rmSync(root, { recursive: true, force: true });
});

const hangTimeoutMs = 500;
/** How long a cut-off hook may take on top of its deadline: the kill and the settle are immediate. */
const settleMarginMs = 2000;

/** A `node` that writes its pid to `pidFile` and then never ends, holding the stdout it inherited. */
function buildHangingNodeCommand(pidFile: string): string {
  const script = 'require("fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);';
  return `${shellSingleQuote(process.execPath)} -e ${shellSingleQuote(script)} ${shellSingleQuote(pidFile)}`;
}

async function waitForPidFile(pidFile: string): Promise<number> {
  for (let attempt = 0; attempt < 50 && !fs.existsSync(pidFile); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  startedPids.push(pid);
  return pid;
}

async function waitUntilGone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 50 && checkIsPidAlive(pid); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  return !checkIsPidAlive(pid);
}

test('runHookCommand: a hook that prints is read whole, with its input on stdin', async () => {
  assert.equal(await runHookCommand('cat; printf done', '{"source":"compact"}', 10_000), '{"source":"compact"}done');
});

test('runHookCommand: a hook whose node child hangs in the foreground is cut off at its deadline — the child killed, nothing printed', async () => {
  const pidFile = path.join(root, 'foreground.pid');
  const startedAt = Date.now();
  const output = await runHookCommand(`printf partial; ${buildHangingNodeCommand(pidFile)}; exit 0`, '', hangTimeoutMs);
  assert.ok(Date.now() - startedAt < hangTimeoutMs + settleMarginMs, `it settled at the deadline: ${Date.now() - startedAt} ms`);
  assert.equal(output, '', 'what a cut-off hook printed is discarded');
  assert.equal(await waitUntilGone(await waitForPidFile(pidFile)), true, 'the hanging node is killed with its group');
});

test('runHookCommand: a hook whose shell exits while a node it started still holds the output pipe settles at the deadline all the same', async () => {
  const pidFile = path.join(root, 'background.pid');
  const startedAt = Date.now();
  const output = await runHookCommand(`${buildHangingNodeCommand(pidFile)} & exit 0`, '', hangTimeoutMs);
  assert.ok(Date.now() - startedAt < hangTimeoutMs + settleMarginMs, `it settled at the deadline, not when the pipe closes: ${Date.now() - startedAt} ms`);
  assert.equal(output, '');
  assert.equal(await waitUntilGone(await waitForPidFile(pidFile)), true, 'the node left behind is killed with the group');
});
