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
  type CheckRunResult,
} from '../scheduler/checkRun';
import { checkIsPidAlive } from '../utils/jsonStreamHost';
import {
  getWorkerWatchEnd,
  workerWatchArmedFileName,
  workerWatchCheckCommand,
  workerWatchExitCode,
  workerWatchSilenceMinutes,
  workerWatchUnreportedMinutes,
} from '../scheduler/workerWatch';
import { spawn } from 'child_process';

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

/** How long ago a stalled worker's run dir last changed: past the recipe's 45-minute window. */
const stalledRunDirAgeMs = 50 * 60_000;
/** How long ago a long run's watch was armed: past the recipe's 150-minute window. */
const unreportedWatchAgeMs = 160 * 60_000;
const checkTimeoutMs = 10_000;

test('the worker watch recipe: silent while the worker lives and writes; fails when it stalls or exits — where kill -0 alone stays silent', async () => {
  await withTempDir(async (dir) => {
    // A space in the run dir's path: unquoted, `find` would read two folders and the check would fire at once.
    const runDir = path.join(dir, 'worker run');
    fs.mkdirSync(runDir);
    const eventsFile = path.join(runDir, 'events.jsonl');
    fs.writeFileSync(eventsFile, '{}\n');
    // What the skill tells the orchestrator to do right before it arms the check: the third signal counts from this file.
    const armedFile = path.join(runDir, workerWatchArmedFileName);
    fs.writeFileSync(armedFile, '');
    const worker = spawn('sleep', ['30'], { stdio: 'ignore' });
    const workerPid = worker.pid ?? 0;
    assert.ok(workerPid > 0);
    const watch = (command: string) => runCheckCommand({ command, cwd: dir, timeoutMs: checkTimeoutMs, env: process.env });
    const recipe = workerWatchCheckCommand.replaceAll('<pid>', workerPid.toString()).replaceAll('<run-dir>', runDir);
    try {
      const writing = await watch(recipe);
      assert.equal(writing.exitCode, 0, `a live worker that writes passes: ${writing.output}`);

      const stalledAt = new Date(Date.now() - stalledRunDirAgeMs);
      // The marker lives in the run dir, so a fresh one counts as a change there: it ages with the rest.
      for (const entry of [eventsFile, armedFile, runDir]) fs.utimesSync(entry, stalledAt, stalledAt);
      const stalled = await watch(recipe);
      assert.equal(stalled.exitCode, 2, 'a live worker whose run dir stopped changing fails');
      assert.match(stalled.output, /no change for 45 min/);
      assert.equal(getWorkerWatchEnd(stalled), 'silent', 'the bot reads the recipe\'s own exit code back');
      const livenessOnly = await watch(`kill -0 ${workerPid}`);
      assert.equal(livenessOnly.exitCode, 0, 'the liveness-only check stays green on the same hung worker');

      // A worker that keeps writing, armed 2 h 40 min ago: only the third signal is left to fail.
      const writingAgain = new Date();
      fs.utimesSync(eventsFile, writingAgain, writingAgain);
      const armedLongAgo = new Date(Date.now() - unreportedWatchAgeMs);
      fs.utimesSync(armedFile, armedLongAgo, armedLongAgo);
      const unreported = await watch(recipe);
      assert.equal(unreported.exitCode, 3, 'a live worker that writes, armed over 2 h 30 min ago, fails the third test');
      assert.match(unreported.output, /watch-armed: older than 2 h 30 min\n$/);
      assert.equal(getWorkerWatchEnd(unreported), 'unreported');
      assert.equal((await watch(`kill -0 ${workerPid}`)).exitCode, 0, 'the liveness-only check stays green on this one too');

      // The agent looked and found the worker fine: `touch` restarts the clock, and the SAME check passes again at its next run.
      fs.utimesSync(armedFile, writingAgain, writingAgain);
      assert.equal((await watch(recipe)).exitCode, 0, 'a touched marker makes the same recipe pass: no new check is needed');

      // Fail closed, with a code of its own: a run dir without the marker (the `touch` was forgotten, or a resumed worker's
      // run dir that never had one) fails at the first run — never silently skips the test, and never reads as 2 h 30 min.
      fs.rmSync(armedFile);
      const unmarked = await watch(recipe);
      assert.equal(unmarked.exitCode, workerWatchExitCode.markerMissing, 'no marker: its own exit code');
      assert.match(unmarked.output, /watch-armed: missing, touch it when you arm the watch/);
      assert.equal(getWorkerWatchEnd(unmarked), null, 'the topic must not say «running 2 h 30 min without a report» for a worker that may have started minutes ago');
      fs.writeFileSync(armedFile, '');
      assert.equal((await watch(recipe)).exitCode, 0, 'the `touch` the output asks for makes the check pass again');
      fs.rmSync(armedFile);

      // The order of the signals: a quiet run dir is reported before an old marker, a gone process before both.
      for (const entry of [eventsFile, runDir]) fs.utimesSync(entry, stalledAt, stalledAt);
      assert.equal((await watch(recipe)).exitCode, 2, 'silent AND unmarked: the silence is the more specific signal');
    } finally {
      worker.kill('SIGKILL');
    }
    await new Promise((resolve) => worker.once('exit', resolve));
    const exited = await watch(recipe);
    assert.equal(exited.exitCode, 1, 'an exited worker fails — also the "worker finished" signal, ahead of the two other signals (silent and unmarked here)');
    assert.match(exited.output, new RegExp(`worker ${workerPid} exited`));
    assert.equal(getWorkerWatchEnd(exited), 'finished');
  });
});

test('the worker watch recipe names its exit codes and its window from the constants the bot reads them back with', () => {
  assert.ok(workerWatchCheckCommand.includes(`exit ${workerWatchExitCode.processGone};`));
  assert.ok(workerWatchCheckCommand.includes(`exit ${workerWatchExitCode.runDirSilent};`));
  assert.ok(workerWatchCheckCommand.includes(`exit ${workerWatchExitCode.unreported};`));
  assert.ok(workerWatchCheckCommand.includes(`exit ${workerWatchExitCode.markerMissing};`));
  assert.ok(workerWatchCheckCommand.indexOf(`exit ${workerWatchExitCode.markerMissing};`) < workerWatchCheckCommand.indexOf(`exit ${workerWatchExitCode.unreported};`), 'the missing marker is judged before its age');
  assert.ok(workerWatchCheckCommand.includes(`-mmin -${workerWatchSilenceMinutes} `));
  assert.ok(workerWatchCheckCommand.includes(`no change for ${workerWatchSilenceMinutes} min`));
  assert.ok(workerWatchCheckCommand.includes(`find "<run-dir>/${workerWatchArmedFileName}" -mmin -${workerWatchUnreportedMinutes} `), 'the third test reads the marker\'s age, not ps');
  assert.ok(!workerWatchCheckCommand.includes('etimes'), 'a macOS ps may lack etimes');
  assert.equal(workerWatchUnreportedMinutes, 150, 'the window the topic sentence and the skill call 2 h 30 min');
});

test('getWorkerWatchEnd: only a run that exited by itself with one of the recipe\'s three codes is a worker end', () => {
  const run = (overrides: Partial<CheckRunResult>): CheckRunResult => ({ exitCode: 0, signal: null, isTimedOut: false, output: '', ...overrides });
  assert.equal(getWorkerWatchEnd(run({ exitCode: workerWatchExitCode.processGone })), 'finished');
  assert.equal(getWorkerWatchEnd(run({ exitCode: workerWatchExitCode.runDirSilent })), 'silent');
  assert.equal(getWorkerWatchEnd(run({ exitCode: workerWatchExitCode.unreported })), 'unreported');
  assert.equal(getWorkerWatchEnd(run({ exitCode: workerWatchExitCode.markerMissing })), null, 'a missing marker says nothing about the worker');
  assert.equal(getWorkerWatchEnd(run({ exitCode: 5 })), null, 'another code is some other check');
  assert.equal(getWorkerWatchEnd(run({ exitCode: 0 })), null, 'a pass is not an end');
  assert.equal(getWorkerWatchEnd(run({ exitCode: workerWatchExitCode.processGone, isTimedOut: true })), null, 'a timed-out run says nothing about the worker');
  assert.equal(getWorkerWatchEnd(run({ exitCode: workerWatchExitCode.unreported, isTimedOut: true })), null, 'nor does a timed-out run with the third code');
  assert.equal(getWorkerWatchEnd(run({ exitCode: null, signal: 'SIGKILL' })), null);
  assert.equal(getWorkerWatchEnd(run({ exitCode: null, startError: 'spawn /bin/sh ENOENT' })), null);
});
