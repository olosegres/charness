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
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from '../selfUpdate/commandRunner';
import { runCommandIsolated, stripControlCharacters, type IsolatedCommandRunner } from '../runnerUtility/isolatedCommand';

const generousTimeoutMs = 20_000;
const pollIntervalMs = 25;
const pollDeadlineMs = 5_000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + pollDeadlineMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await wait(pollIntervalMs);
  }
}

function checkIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

describe('stripControlCharacters', () => {
  it('removes everything a terminal could act on or that could disguise a line — escapes, carriage returns, bells, NUL, DEL, C1 controls, bidirectional overrides, line separators — and keeps text, newlines and tabs', () => {
    const hostile = 'ok\u001b[2J\u001b]0;fake title\u0007 line\r\nnext\tcolumn\u0000\u007f\u009b31m \u202eevil\u2066\u2069\u200e\u200f\u2028\u2029 done — «ünï» 日本';
    assert.equal(stripControlCharacters(hostile), 'ok[2J]0;fake title line\nnext\tcolumn31m evil done — «ünï» 日本');
  });

  it('leaves plain text alone', () => {
    const plain = 'charness-runner: pairing with the hub\nInstalled two services: a (the link) and b.\n';
    assert.equal(stripControlCharacters(plain), plain);
  });
});

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
      const result = await runCommandIsolated('sh', ['-c', `sleep 60 & echo $! > "${pidFile}"; wait`], { timeoutMs: 400 });
      assert.equal(result.isTimedOut, true);
      assert.equal(result.ok, false);
      const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
      await waitFor(() => !checkIsProcessAlive(grandchild), 'the grandchild to be killed with the group');
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
      await waitFor(() => !checkIsProcessAlive(sleeper), 'the child\'s group to be stopped');
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
