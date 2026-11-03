/**
 * @description The interrupt handling of `remote-run` that gets time to clean up (`remoteRun/interrupts.ts`): the first interrupt goes to the
 * command, a SECOND one ends the process at once with the code of the first — so a call that does not stop can never swallow Ctrl-C. The
 * policy is tested with a fake `exit`; the production wiring (`addInterruptHandlerWithHardStop`: real signals, `process.exit`) in a real process.
 * A closed stdout (`remote-run … | head`) is an interrupt of its own — SIGPIPE, 141 — raised by `createProcessIo` from the EPIPE of the write, in a
 * real process on a real pipe. And `waitForChildEnd`: a call that is ended on purpose settles when its process has exited, whenever that was decided — also after the process
 * had exited by itself while a master connection kept its pipes.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { interruptSignals, planInterrupt, remoteRunExitCodes, type InterruptSignal } from '../remoteRun/exitCodes';
import { describeInterruptCause } from '../remoteRun/foreground';
import { addInterruptHandler, createHardStopHandler, raiseStdoutClosed, waitForChildEnd } from '../remoteRun/interrupts';
import { watchClosedOutput } from '../remoteRun/output';
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

  it('each signal\'s own code when it is the first: 130 / 143 / 129 / 141 (a closed stdout)', () => {
    for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129], ['SIGPIPE', 141]] as const) {
      const exits: number[] = [];
      const handler = createHardStopHandler(() => undefined, (code) => exits.push(code));
      handler(signal);
      handler(signal);
      assert.deepEqual(exits, [exitCode], signal);
    }
  });
});

describe('a closed stdout is an interrupt: SIGPIPE, 141', () => {
  it('the signals listened for are the three of the user\'s; SIGPIPE ends the run with the shell\'s code 141', () => {
    assert.deepEqual([...interruptSignals], ['SIGINT', 'SIGTERM', 'SIGHUP']);
    assert.equal(planInterrupt('SIGPIPE').exitCode, 141);
    assert.equal(remoteRunExitCodes.brokenPipe, 141);
  });

  it('a closed stdout reaches every handler as SIGPIPE, a removed handler no more — and the real SIGPIPE is never listened for (Node would stop ignoring it)', () => {
    const received: InterruptSignal[] = [];
    const removeHandler = addInterruptHandler((signal) => received.push(signal));
    assert.equal(process.listenerCount('SIGPIPE'), 0);
    raiseStdoutClosed();
    process.emit('SIGHUP', 'SIGHUP');
    removeHandler();
    raiseStdoutClosed();
    process.emit('SIGHUP', 'SIGHUP');
    assert.deepEqual(received, ['SIGPIPE', 'SIGHUP']);
    assert.equal(process.listenerCount('SIGPIPE'), 0);
  });

  it('the first EPIPE of a stream is reported once and later writes are dropped; any other stream error is not swallowed', () => {
    const stream = new EventEmitter();
    let reports = 0;
    const watch = watchClosedOutput(stream, () => { reports += 1; });
    assert.equal(watch.getIsClosed(), false);
    stream.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    stream.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    assert.deepEqual([reports, watch.getIsClosed()], [1, true]);
    const other = Object.assign(new Error('disk on fire'), { code: 'EIO' });
    assert.throws(() => stream.emit('error', other), /disk on fire/);
    assert.equal(reports, 1);
  });

  it('a user\'s signal says «interrupted»; a closed stdout says why the job was stopped and how to read a part of a long output', () => {
    assert.equal(describeInterruptCause('SIGINT', 'job box1-abc234', 'box1', '`logs`'), 'interrupted — job box1-abc234 was stopped on box1');
    const closed = describeInterruptCause('SIGPIPE', 'job box1-abc234', 'box1', '`charness remote-run logs box1-abc234 --tail <lines>`');
    assert.match(closed, /^stdout was closed \(what reads it, a pipe into `head` for one, is gone\) — job box1-abc234 was stopped on box1; /);
    assert.match(closed, /--bg and use `charness remote-run logs box1-abc234 --tail <lines>`$/);
  });

  /**
   * The production wiring in a real process on a real pipe: `createProcessIo` + the interrupt handler a run that owns a job registers. The
   * parent closes its end of the child's stdout the way `head` does after its lines; the child's next write meets the closed pipe.
   */
  it('a real process whose stdout reader goes away gets SIGPIPE through the interrupt handler instead of crashing on the EPIPE', async () => {
    const script = `
      const { createProcessIo } = require('./src/remoteRun/output');
      const { addInterruptHandler } = require('./src/remoteRun/interrupts');
      const io = createProcessIo();
      addInterruptHandler((signal) => { io.stderr('interrupt: ' + signal + '\\n'); setTimeout(() => process.exit(141), 50); });
      io.stderr('ready\\n');
      setInterval(() => io.stdout('line\\n'), 20);
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--eval', script], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => { child.once('exit', (code, signal) => resolve({ code, signal })); });
    try {
      const deadline = Date.now() + processBoundMs;
      while (!stderr.includes('ready') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(stderr.includes('ready'), `the process never came up; stderr: ${stderr}`);
      child.stdout?.destroy();
      const outcome = await Promise.race([exited, new Promise<'still running'>((resolve) => { setTimeout(() => resolve('still running'), processBoundMs); })]);
      assert.deepEqual(outcome, { code: 141, signal: null }, stderr);
      assert.equal(stderr.match(/interrupt: SIGPIPE/g)?.length, 1, `the interrupt arrives once, however many writes follow; stderr: ${stderr}`);
      assert.doesNotMatch(stderr, /EPIPE|Unhandled 'error'/);
    } finally {
      child.kill('SIGKILL');
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
