/**
 * @description The interrupt handling of `remote-run` that gets time to clean up (`remoteRun/interrupts.ts`): the first interrupt goes to the
 * command, a SECOND one ends the process at once with the code of the first — so a call that does not stop can never swallow Ctrl-C. The
 * policy is tested with a fake `exit`; the production wiring (`addInterruptHandlerWithHardStop`: real signals, `process.exit`) in a real process.
 * And `waitForChildEnd`: a call that is ended on purpose settles when its process has exited, whenever that was decided — also after the process
 * had exited by itself while a master connection kept its pipes.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { InterruptSignal } from '../remoteRun/exitCodes';
import { createHardStopHandler, waitForChildEnd } from '../remoteRun/interrupts';
import { killRecordedProcess, readRecordedPid } from './recordedProcess';

const repoRoot = path.resolve(__dirname, '..', '..');
const processBoundMs = 30_000;

describe('the hard stop of a second interrupt (policy)', () => {
  it('the first interrupt is the command\'s to handle; the second ends the process with the code of the FIRST, and so does every later one', () => {
    const interrupts: InterruptSignal[] = [];
    const exits: number[] = [];
    const handler = createHardStopHandler((signal) => interrupts.push(signal), (exitCode) => exits.push(exitCode));
    handler('SIGTERM');
    assert.deepEqual([interrupts, exits], [['SIGTERM'], []], 'the first one only reaches the command');
    handler('SIGINT');
    handler('SIGHUP');
    assert.deepEqual(interrupts, ['SIGTERM'], 'the command hears the first one only');
    assert.deepEqual(exits, [143, 143], 'SIGTERM was the first: its code, whatever came after');
  });

  it('each signal\'s own code when it is the first: 130 / 143 / 129', () => {
    for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const) {
      const exits: number[] = [];
      const handler = createHardStopHandler(() => undefined, (code) => exits.push(code));
      handler(signal);
      handler(signal);
      assert.deepEqual(exits, [exitCode], signal);
    }
  });
});

describe('the hard stop of a second interrupt (production wiring, real signals)', () => {
  /** A process that listens the way the wait does and whose «clean-up» never ends: it answers the first interrupt with a line and carries on. */
  const stuckCleanupScript = `
    const { addInterruptHandlerWithHardStop } = require('./src/remoteRun/interrupts');
    addInterruptHandlerWithHardStop((signal) => { process.stdout.write('first interrupt: ' + signal + ', not stopping\\n'); });
    process.stdout.write('ready\\n');
    setInterval(() => undefined, 1000);
  `;

  function startStuckProcess(): { child: ReturnType<typeof spawn>; output: () => string; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> } {
    const child = spawn(process.execPath, ['--import', 'tsx', '--eval', stuckCleanupScript], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { output += chunk; });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => { child.once('exit', (code, signal) => resolve({ code, signal })); });
    return { child, output: () => output, exited };
  }

  async function waitForOutput(getOutput: () => string, fragment: string): Promise<void> {
    const deadline = Date.now() + processBoundMs;
    while (!getOutput().includes(fragment) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(getOutput().includes(fragment), `«${fragment}» never came; the output: ${getOutput()}`);
  }

  for (const [first, second, exitCode] of [['SIGINT', 'SIGINT', 130], ['SIGTERM', 'SIGTERM', 143], ['SIGINT', 'SIGTERM', 130], ['SIGHUP', 'SIGINT', 129]] as const) {
    it(`${first}, then ${second}: the first leaves the stuck process running, the second ends it at once with ${exitCode} — a call that never ends cannot swallow Ctrl-C`, async () => {
      const stuck = startStuckProcess();
      try {
        await waitForOutput(stuck.output, 'ready');
        stuck.child.kill(first);
        await waitForOutput(stuck.output, `first interrupt: ${first}`);
        assert.equal(stuck.child.exitCode, null, 'one interrupt does not end a process whose clean-up has not finished');
        stuck.child.kill(second);
        const outcome = await Promise.race([stuck.exited, new Promise<'still running'>((resolve) => { setTimeout(() => resolve('still running'), processBoundMs); })]);
        assert.deepEqual(outcome, { code: exitCode, signal: null });
      } finally {
        stuck.child.kill('SIGKILL');
      }
    });
  }
});

describe('waitForChildEnd when a master holds the pipes of a client that has already exited', () => {
  const settleBoundMs = 5_000;
  const holdMs = 400;
  let directory = '';
  let masterPidFile = '';

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'child-end-'));
    masterPidFile = path.join(directory, 'master.pid');
  });
  afterEach(() => {
    killRecordedProcess(masterPidFile);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  /** A client that exits at once while its «master» — a sleeping grandchild that inherited the pipes — goes on holding them. */
  function startClientWhoseMasterHoldsThePipes(): ReturnType<typeof spawn> {
    return spawn('sh', ['-c', `sleep 120 & echo $! > "${masterPidFile}"; exit 0`], { stdio: ['ignore', 'pipe', 'pipe'] });
  }

  async function waitUntilClientExitedAndMasterRecorded(child: ReturnType<typeof spawn>): Promise<void> {
    const deadline = Date.now() + settleBoundMs;
    while ((child.exitCode === null || readRecordedPid(masterPidFile) === null) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(child.exitCode, 0, 'the client exited by itself');
    assert.notEqual(readRecordedPid(masterPidFile), null, 'the master recorded its pid');
  }

  const settlesWithin = (ended: Promise<number | null>, boundMs: number): Promise<number | null | 'pending'> =>
    Promise.race([ended, new Promise<'pending'>((resolve) => { setTimeout(() => resolve('pending'), boundMs); })]);

  it('a stop that is decided AFTER the exit ends the wait at once — the pipes are let go, `close` is not waited for', async () => {
    let isStopped = false;
    const child = startClientWhoseMasterHoldsThePipes();
    const ended = waitForChildEnd(child, () => isStopped);
    await waitUntilClientExitedAndMasterRecorded(child);
    assert.equal(await settlesWithin(ended, holdMs), 'pending', 'nobody stopped it: it waits for the master, as it should, so no output is lost');
    isStopped = true;
    assert.equal(await settlesWithin(ended, settleBoundMs), 0, 'stopped after the exit: it settles with the exit code of the client');
  });

  it('a stop that was already decided when the client exited ends it at once too (the case it was written for)', async () => {
    const child = spawn('sh', ['-c', `sleep 120 & echo $! > "${masterPidFile}"; exec sleep 120`], { stdio: ['ignore', 'pipe', 'pipe'] });
    const deadline = Date.now() + settleBoundMs;
    while (readRecordedPid(masterPidFile) === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    let isStopped = false;
    const ended = waitForChildEnd(child, () => isStopped);
    isStopped = true;
    child.kill('SIGKILL');
    assert.notEqual(await settlesWithin(ended, settleBoundMs), 'pending');
  });

  it('with no stop it still waits for `close`, and then settles with the exit code', async () => {
    const child = startClientWhoseMasterHoldsThePipes();
    const ended = waitForChildEnd(child, () => false);
    await waitUntilClientExitedAndMasterRecorded(child);
    assert.equal(await settlesWithin(ended, holdMs), 'pending');
    killRecordedProcess(masterPidFile);
    assert.equal(await settlesWithin(ended, settleBoundMs), 0);
  });
});
