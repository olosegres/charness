/**
 * @description Coverage for the watchdog check runner (`scheduler/checkRun.ts`):
 * the command runs through a real `/bin/sh` in the given folder, a timeout stops
 * the whole process group (a background child included), the output keeps its
 * tail, and the alert decision fires only on the passing → failing edge.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  buildCheckEnv,
  buildCheckFailurePrompt,
  checkIsCheckPassing,
  checkOutputMaxChars,
  describeCheckFailure,
  getCheckAlertDecision,
  getOutputTail,
  runCheckCommand,
} from '../scheduler/checkRun';
import { checkIsPidAlive } from '../utils/jsonStreamHost';

/**
 * How long a process that has already closed its output may still be visible to
 * `kill(pid, 0)`: the kernel finishes its teardown and the orphan reaper collects
 * it in milliseconds, while a process the group signal missed stays for its full
 * `sleep 30`. Generous so a loaded machine cannot make the two look alike.
 */
const processGoneWaitMs = 5000;
const processGonePollMs = 10;

function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'check-run-')));
  return run(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

/**
 * Whether `pid` disappears within {@link processGoneWaitMs}. A single
 * `kill(pid, 0)` is not enough: the runner resolves once every holder of the
 * shell's output pipe closed it, and a child closes its pipe INSIDE its exit path,
 * before the kernel has finished tearing it down and the reaper has collected it —
 * under load that window is wide enough for one probe to still see the process.
 */
async function waitUntilProcessGone(pid: number): Promise<boolean> {
  const deadline = Date.now() + processGoneWaitMs;
  while (checkIsPidAlive(pid)) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, processGonePollMs));
  }
  return true;
}

test('runCheckCommand: exit 0 in the given folder passes', async () => {
  await withTempDir(async (dir) => {
    const result = await runCheckCommand({ command: 'pwd', cwd: dir, timeoutMs: 10_000, env: process.env });
    assert.equal(result.exitCode, 0);
    assert.equal(result.output, `${dir}\n`);
    assert.equal(checkIsCheckPassing(result), true);
  });
});

test('runCheckCommand: a non-zero exit fails and keeps stdout and stderr', async () => {
  await withTempDir(async (dir) => {
    const result = await runCheckCommand({
      command: 'echo out; echo err >&2; exit 3',
      cwd: dir,
      timeoutMs: 10_000,
      env: process.env,
    });
    assert.equal(result.exitCode, 3);
    assert.match(result.output, /out/);
    assert.match(result.output, /err/);
    assert.equal(checkIsCheckPassing(result), false);
    assert.equal(describeCheckFailure(result, 60), 'exit 3');
  });
});

test('runCheckCommand: a timeout stops the whole process group, background children too', async () => {
  await withTempDir(async (dir) => {
    const pidFile = path.join(dir, 'bg.pid');
    const startedAt = Date.now();
    const result = await runCheckCommand({
      command: `sleep 30 & echo $! > ${pidFile}; sleep 30`,
      cwd: dir,
      timeoutMs: 300,
      env: process.env,
    });
    assert.ok(Date.now() - startedAt < 4000, 'SIGTERM ended it without waiting for the kill grace');
    assert.equal(result.isTimedOut, true);
    assert.equal(checkIsCheckPassing(result), false);
    assert.equal(describeCheckFailure(result, 1), 'timeout 1s');
    const backgroundPid = Number(fs.readFileSync(pidFile, 'utf-8'));
    assert.equal(await waitUntilProcessGone(backgroundPid), true, 'the background sleep was stopped with the group');
  });
});

test('runCheckCommand: a missing folder resolves with startError instead of rejecting', async () => {
  const result = await runCheckCommand({
    command: 'true',
    cwd: path.join(os.tmpdir(), 'check-run-missing-folder-x'),
    timeoutMs: 10_000,
    env: process.env,
  });
  assert.equal(result.exitCode, null);
  assert.ok(result.startError, 'the spawn error is reported');
  assert.equal(checkIsCheckPassing(result), false);
  assert.match(describeCheckFailure(result, 60), /^error: /);
});

test('runCheckCommand: a flood of output keeps only its tail', async () => {
  await withTempDir(async (dir) => {
    const result = await runCheckCommand({
      command: `head -c 20000 /dev/zero | tr '\\0' a; echo END`,
      cwd: dir,
      timeoutMs: 10_000,
      env: process.env,
    });
    assert.equal(result.output.length, checkOutputMaxChars);
    assert.ok(result.output.startsWith('…'));
    assert.ok(result.output.endsWith('END\n'));
  });
});

test('getOutputTail: short text is untouched, long text keeps its end', () => {
  assert.equal(getOutputTail('abc', 5), 'abc');
  assert.equal(getOutputTail('abcdefgh', 5), '…efgh');
});

test('buildCheckEnv: the bot token never reaches a check (its output is posted to the topic)', () => {
  const env = buildCheckEnv({ TELEGRAM_BOT_TOKEN: 'secret', PATH: '/usr/bin' });
  assert.deepEqual(env, { PATH: '/usr/bin' });
});

test('getCheckAlertDecision: alert only on the passing → failing edge, one line on recovery', () => {
  assert.equal(getCheckAlertDecision({ isPassing: true, wasFailing: false }), 'quiet');
  assert.equal(getCheckAlertDecision({ isPassing: false, wasFailing: false }), 'alert');
  assert.equal(getCheckAlertDecision({ isPassing: false, wasFailing: true }), 'quiet');
  assert.equal(getCheckAlertDecision({ isPassing: true, wasFailing: true }), 'recovered');
});

test('buildCheckFailurePrompt: marker first, failure details, the job prompt last', () => {
  const prompt = buildCheckFailurePrompt({
    name: 'Disk',
    command: 'df -h /',
    failure: 'exit 1',
    output: '  \n',
    prompt: 'Free some space.',
  });
  assert.ok(prompt.startsWith('[Scheduled check "Disk" failed]\n'));
  assert.match(prompt, /Command \(run by the bot in this folder\): df -h \//);
  assert.match(prompt, /\(no output\)/);
  assert.ok(prompt.endsWith('\nFree some space.'));
});
