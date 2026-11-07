/**
 * @description `runnerUtility/isolatedCommand.ts`: how the admin pairing line's root step runs everything that is the runner account's. The
 * account runs the agents' code, so what it can change must not get the admin's terminal: a child here has a session of its own (no controlling
 * terminal to open), no standard input, and its output reaches the operator only through the root step, with the control characters stripped.
 * Each guarantee is checked against `execFile` (`runCommand`), which gives none of them — a test that passed for both would hold nothing.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from '../selfUpdate/commandRunner';
import { runCommandIsolated, type IsolatedCommandRunner } from '../runnerUtility/isolatedCommand';

const generousTimeoutMs = 20_000;
/**
 * The deadline of a test whose child is a NODE program that must have started the sleeper — and written its pid — before the deadline passes: the child's own start-up is
 * seconds on a loaded machine, and a deadline of half a second fired before the sleeper existed (the pid file was not there to read). Long enough for any start-up, short
 * enough to wait for in a test.
 */
const deadlineAfterNodeStartsMs = 6_000;
const pollIntervalMs = 25;
/** How long a test waits for something to HAPPEN (a node child to start, a file to appear): a wait for an event, not an assertion about speed, so as generous as a signalled process's exit below — a node program starts in seconds on a loaded machine. */
const pollDeadlineMs = 30_000;
/** How long a killed process may take to be gone: on a box with a load average of 40 a signalled process waits seconds for its turn to die. */
const processExitDeadlineMs = 30_000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function waitFor(check: () => boolean, what: string | (() => string), deadlineMs: number = pollDeadlineMs): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${typeof what === 'string' ? what : what()}`);
    await wait(pollIntervalMs);
  }
}

/** What `ps` says of `pid`, for a failure's message. */
function describeProcess(pid: number): string {
  return spawnSync('ps', ['-o', 'pid,ppid,pgid,stat,etime,args', '-p', pid.toString()], { encoding: 'utf8' }).stdout.trim();
}

/** Is `pid` running? A zombie — dead, its parent gone, and no init yet to collect it — is not: `kill(pid, 0)` still finds one, `ps` says `Z`. */
function checkIsProcessAlive(pid: number): boolean {
  const listing = spawnSync('ps', ['-o', 'stat=', '-p', pid.toString()], { encoding: 'utf8' });
  const state = listing.stdout.trim();
  return state !== '' && !state.startsWith('Z');
}

/** What a child looks like from inside: who leads its group (`ps`), what its standard input is, and whether it can open a controlling terminal. */
const describeSelfScript = [
  'const { spawnSync } = require("child_process"); const fs = require("fs");',
  'const group = spawnSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).stdout.trim();',
  'const stdin = fs.fstatSync(0);',
  'const devNull = fs.statSync("/dev/null");',
  'let terminal = "opened"; try { fs.closeSync(fs.openSync("/dev/tty", "r")); } catch (error) { terminal = error.code; }',
  'console.log(JSON.stringify({ pid: process.pid, groupLeader: Number(group), isStdinDevNull: stdin.isCharacterDevice() && stdin.rdev === devNull.rdev, isStdinPipe: stdin.isFIFO() || stdin.isSocket(), terminal }));',
].join('\n');

interface SelfDescription {
  pid: number;
  groupLeader: number;
  isStdinDevNull: boolean;
  isStdinPipe: boolean;
  terminal: string;
}

describe('a command run isolated', () => {
  it('is the leader of a session and group of its own, has /dev/null as its standard input and can open no terminal — where a plain `execFile` child has a pipe for input and shares the caller\'s group', async () => {
    const isolated = await runCommandIsolated(process.execPath, ['-e', describeSelfScript], { timeoutMs: generousTimeoutMs });
    assert.equal(isolated.ok, true, isolated.stderr);
    const inside: SelfDescription = JSON.parse(isolated.stdout);
    assert.equal(inside.groupLeader, inside.pid, 'the child leads its own group: `setsid` made it the head of a new session, which has no controlling terminal');
    assert.equal(inside.isStdinDevNull, true, 'no standard input');
    assert.notEqual(inside.terminal, 'opened', `/dev/tty is not for it: ${inside.terminal}`);

    const plain = await runCommand(process.execPath, ['-e', describeSelfScript], { timeoutMs: generousTimeoutMs });
    const sharing: SelfDescription = JSON.parse(plain.stdout);
    assert.notEqual(sharing.groupLeader, sharing.pid, 'control: a plain execFile child stays in the caller\'s group (and terminal session)');
    assert.equal(sharing.isStdinPipe, true, 'control: and holds a pipe for input');
    assert.equal(sharing.isStdinDevNull, false);
  });

  it('strips the control characters of the output before anyone sees it — in the result, and in what is relayed as it arrives, for both streams — and keeps the text', async () => {
    const script = 'process.stdout.write("out\\u001b[31mred\\u001b[0m\\rback\\u0007\\n"); process.stderr.write("err\\u001b]0;x\\u0007\\u202etxt\\n");';
    const relayed: Array<[string, 'stdout' | 'stderr']> = [];
    const result = await runCommandIsolated(process.execPath, ['-e', script], { timeoutMs: generousTimeoutMs, onOutput: (text, stream) => { relayed.push([text, stream]); } });
    assert.equal(result.ok, true);
    assert.equal(result.stdout, 'out[31mred[0mback\n');
    assert.equal(result.stderr, 'err]0;xtxt\n');
    assert.equal(relayed.filter(([, stream]) => stream === 'stdout').map(([text]) => text).join(''), result.stdout);
    assert.equal(relayed.filter(([, stream]) => stream === 'stderr').map(([text]) => text).join(''), result.stderr);
    for (const [text] of relayed) assert.doesNotMatch(text, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202e]/u, JSON.stringify(text));
  });

  it('reports a failing exit code, with the output it printed', async () => {
    const result = await runCommandIsolated('sh', ['-c', 'echo said; echo oops >&2; exit 7'], { timeoutMs: generousTimeoutMs });
    assert.deepEqual([result.ok, result.exitCode, result.stdout, result.stderr, result.isTimedOut], [false, 7, 'said\n', 'oops\n', false]);
  });

  it('reports a program that cannot start without throwing', async () => {
    const result = await runCommandIsolated('/nonexistent/program', [], { timeoutMs: generousTimeoutMs });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, null);
    assert.match(result.stderr, /ENOENT/);
  });

  it('kills the whole group when the deadline passes — the child and what it started — and says it timed out', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-'));
    try {
      const pidFile = path.join(folder, 'grandchild.pid');
      const result = await runCommandIsolated('sh', ['-c', `sleep 60 & echo $! > "${pidFile}"; wait`], { timeoutMs: 1_500 });
      assert.equal(result.isTimedOut, true);
      assert.equal(result.ok, false);
      const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
      await waitFor(() => !checkIsProcessAlive(grandchild), () => `the grandchild to be killed with the group (${describeProcess(grandchild)})`, processExitDeadlineMs);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  it('passes an interrupt on to the child\'s group and then dies of it itself: Ctrl-C reaches the foreground group, no longer the child\'s, and must not leave a root-run step working on', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-'));
    try {
      const pidFile = path.join(folder, 'child.pid');
      const programPath = path.resolve(__dirname, '..', 'runnerUtility', 'isolatedCommand.ts');
      const driver = [
        `const { runCommandIsolated } = require(${JSON.stringify(programPath)});`,
        `runCommandIsolated('sh', ['-c', 'sleep 60 & echo $! > "${pidFile}"; wait'], { timeoutMs: 60000 }).then(() => { process.stdout.write('survived\\n'); });`,
      ].join('\n');
      const driverProcess = spawn(process.execPath, ['--import', 'tsx', '-e', driver], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      driverProcess.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => { driverProcess.once('exit', (code, signal) => resolve({ code, signal })); });
      await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '', 'the child to start');
      const sleeper = Number(fs.readFileSync(pidFile, 'utf8'));
      driverProcess.kill('SIGTERM');
      const outcome = await exited;
      assert.equal(outcome.signal, 'SIGTERM', `the driver dies of the signal (${JSON.stringify(outcome)})`);
      assert.equal(stdout, '', 'and does not carry on');
      await waitFor(() => !checkIsProcessAlive(sleeper), () => `the child's group to be stopped (${describeProcess(sleeper)})`, processExitDeadlineMs);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe('a descendant that leaves the group and keeps the output open', () => {
  /**
   * A child program (node) that starts `sleep 60` in a SESSION OF ITS OWN (`detached`), handing it the output pipes, records its pid, and then runs
   * `body` — what a launcher the agents rewrote could do: the deadline's kill of the child's group misses the sleeper, and `close` waits for it.
   */
  function createLaunchedChild(pidFile: string, body: string): string[] {
    const script = [
      'const { spawn } = require("child_process"); const fs = require("fs");',
      'const sleeper = spawn("sleep", ["60"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });',
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(sleeper.pid)); sleeper.unref();`,
      body,
    ].join('\n');
    return ['-e', script];
  }

  function readSleeper(pidFile: string): number {
    return Number(fs.readFileSync(pidFile, 'utf8'));
  }

  async function withFolder(run: (folder: string, killSleeper: () => void) => Promise<void>): Promise<void> {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-'));
    const killSleeper = (): void => {
      try {
        process.kill(readSleeper(path.join(folder, 'sleeper.pid')), 'SIGKILL');
      } catch {
        // Never started, or gone.
      }
    };
    try {
      await run(folder, killSleeper);
    } finally {
      killSleeper();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  }

  it('still ends at the deadline — isTimedOut, not ok — within a short grace, though the output never closes; the sleeper that left the group is not the runner\'s to kill', async () => {
    await withFolder(async (folder) => {
      const pidFile = path.join(folder, 'sleeper.pid');
      const startedAtMs = Date.now();
      const result = await runCommandIsolated(process.execPath, createLaunchedChild(pidFile, 'setInterval(() => {}, 1000);'), { timeoutMs: deadlineAfterNodeStartsMs });
      assert.equal(result.isTimedOut, true);
      assert.equal(result.ok, false);
      assert.ok(Date.now() - startedAtMs < 15_000, `ended in ${Date.now() - startedAtMs} ms`);
      assert.equal(checkIsProcessAlive(readSleeper(pidFile)), true, 'control: the sleeper has its own session, so the group\'s kill missed it — and it held the output open');
    });
  });

  it('ends a step whose child exited long ago — with what it printed and its exit status — instead of waiting for the sleeper to let go of the output', async () => {
    await withFolder(async (folder) => {
      const pidFile = path.join(folder, 'sleeper.pid');
      const startedAtMs = Date.now();
      const result = await runCommandIsolated(process.execPath, createLaunchedChild(pidFile, 'process.stdout.write("done\\n"); process.exit(0);'), { timeoutMs: generousTimeoutMs * 3 });
      assert.deepEqual([result.ok, result.exitCode, result.stdout, result.isTimedOut], [true, 0, 'done\n', false]);
      assert.ok(Date.now() - startedAtMs < 20_000, `ended in ${Date.now() - startedAtMs} ms, not at the 60 s of the sleeper`);
    });
  });

  /** A driver process that runs `command` through the runner (the way the root step does), prints `survived` if the step ever ends, and is signalled from here. */
  function startDriver(command: string, args: string[]): { process: ChildProcess; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; output: () => string } {
    const programPath = path.resolve(__dirname, '..', 'runnerUtility', 'isolatedCommand.ts');
    const script = [
      `const { runCommandIsolated } = require(${JSON.stringify(programPath)});`,
      `runCommandIsolated(${JSON.stringify(command)}, ${JSON.stringify(args)}, { timeoutMs: 120000 }).then(() => { process.stdout.write('survived\\n'); });`,
    ].join('\n');
    const driver = spawn(process.execPath, ['--import', 'tsx', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    driver.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => { driver.once('exit', (code, signal) => resolve({ code, signal })); });
    return { process: driver, exited, output: () => output };
  }

  it('an interrupt ends the step and the program — the sleeper holds the output, and the signal, taken over, is not left passed on to a group that is gone — within a short grace', async () => {
    await withFolder(async (folder) => {
      const pidFile = path.join(folder, 'sleeper.pid');
      const driver = startDriver(process.execPath, createLaunchedChild(pidFile, 'setInterval(() => {}, 1000);'));
      await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '', 'the child to start');
      const signalledAtMs = Date.now();
      driver.process.kill('SIGTERM');
      const outcome = await driver.exited;
      assert.equal(outcome.signal, 'SIGTERM', `the driver dies of the signal (${JSON.stringify(outcome)})`);
      assert.equal(driver.output(), '', 'and does not carry on');
      assert.ok(Date.now() - signalledAtMs < 20_000, `ended in ${Date.now() - signalledAtMs} ms`);
    });
  });

  it('a child that ignores the signal is left alone for the first one and killed outright at the SECOND — the step ends at once and the program dies of the signal', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-'));
    try {
      const pidFile = path.join(folder, 'stubborn.pid');
      const driver = startDriver('sh', ['-c', `trap "" TERM; echo $$ > "${pidFile}"; while :; do sleep 1; done`]);
      await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '', 'the stubborn child to start');
      const stubborn = Number(fs.readFileSync(pidFile, 'utf8'));
      driver.process.kill('SIGTERM');
      await wait(700);
      assert.equal(checkIsProcessAlive(stubborn), true, 'the first signal was ignored by the child');
      assert.equal(driver.process.exitCode === null && driver.process.signalCode === null, true, 'and the program is still waiting for it');
      driver.process.kill('SIGTERM');
      const outcome = await driver.exited;
      assert.equal(outcome.signal, 'SIGTERM', `the second signal ends the program (${JSON.stringify(outcome)})`);
      await waitFor(() => !checkIsProcessAlive(stubborn), () => `the stubborn child to be killed (${describeProcess(stubborn)})`, processExitDeadlineMs);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe('what the runner type promises', () => {
  it('is usable where a plain command runner is expected (a step that does not relay output passes no sink)', async () => {
    const runner: IsolatedCommandRunner = runCommandIsolated;
    const result = await runner('sh', ['-c', 'echo fine'], { timeoutMs: generousTimeoutMs });
    assert.equal(result.stdout, 'fine\n');
    assert.equal(spawnSync('ps', ['-o', 'pid=', '-p', String(process.pid)]).status, 0, 'the `ps` the group checks rely on exists here');
  });
});

describe('the order of the runner\'s start', () => {
  it('a stop signal that arrives the instant the child exists is passed on to its group — the handlers are in place BEFORE the spawn, so the signal never takes the default action and leaves the child\'s own session working (a race that a starved machine shows)', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-'));
    try {
      const pidFile = path.join(folder, 'sleeper.pid');
      const programPath = path.resolve(__dirname, '..', 'runnerUtility', 'isolatedCommand.ts');
      // `spawn` is wrapped so that the signal comes between the fork and whatever the runner does next — the window a starved machine opens by itself.
      const script = [
        'const childProcess = require("child_process"); const fs = require("fs");',
        'const realSpawn = childProcess.spawn;',
        `childProcess.spawn = (...spawnArguments) => { const child = realSpawn(...spawnArguments); fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); process.kill(process.pid, "SIGTERM"); return child; };`,
        `const { runCommandIsolated } = require(${JSON.stringify(programPath)});`,
        'runCommandIsolated("sleep", ["300"], { timeoutMs: 120000 }).then(() => { process.stdout.write("survived\\n"); });',
      ].join('\n');
      const driver = spawn(process.execPath, ['--import', 'tsx', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      driver.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
      const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => { driver.once('exit', (code, signal) => resolve({ code, signal })); });
      await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '', 'the sleeper\'s pid to be written');
      const sleeper = Number(fs.readFileSync(pidFile, 'utf8'));
      try {
        assert.equal(outcome.signal, 'SIGTERM', `the program ends of the signal, once the step is over (${JSON.stringify(outcome)})`);
        assert.equal(output, '', 'and does not carry on');
        await waitFor(() => !checkIsProcessAlive(sleeper), () => `the child to be ended by the passed-on signal (${describeProcess(sleeper)})`, processExitDeadlineMs);
      } finally {
        try {
          process.kill(-sleeper, 'SIGKILL');
        } catch {
          // Already gone — the result this test wants.
        }
      }
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});
