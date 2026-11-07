/**
 * @description `charness remote-run clean` through the real CLI entry (`runRemoteRunCli`) with a fake `ssh` on the PATH that records every remote command line and answers a canned text per runner: the copy of the
 * project this is run in (no word) or the named one is asked for on EVERY runner, in parallel; each runner has its line on stdout in the order of the catalog; the exit code is 125 only when a copy is still there
 * although it was asked to go (in use, would not go, timed out, failed) and 0 for «nothing to clean» and for a runner that could not be reached; a paired runner whose link is down, or whose Mac has the lid shut, is
 * not called at all. The script side of `clean` is proven against the real script in `remoteRunRunnerScriptDisk.test.ts`.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { cleanOnRunner } from '../remoteRun/commands';
import { markJobFetched } from '../remoteRun/jobFiles';
import { lidClosedReason } from '../remoteRun/runners';
import { runRemoteRunCli } from '../remoteRun/remoteRunCli';
import { RemoteRunError, RunnerUnreachableError } from '../remoteRun/remoteRunError';
import { prepareCallTimeoutMs, shortCallTimeoutMs, type RunnerClient } from '../remoteRun/runnerClient';
import type { SshRunResult } from '../remoteRun/ssh';
import type { CliIo } from '../remoteRun/output';
import { getProjectContext } from '../remoteRun/project';
import { resetPairedRunnersCache } from '../remoteRun/pairedRunners';
import { getRunnersConfigPath, resetRunnersConfigCache } from '../remoteRun/runnersConfig';
import { createHubContext, getRunnerLinkPaths } from '../runners/hubPaths';
import { writePairedFile } from '../runners/hubRegistry';
import { writeLidState, writeLinkState } from '../runners/linkControl';
import { createPairedRunnerFixture } from './remoteRunPairedKit';
import net from 'net';

let root = '';
let projectDir = '';
let previousPath: string | undefined;
const servers: net.Server[] = [];

/**
 * `ssh` that records the remote command (its last argument) and, for a `clean` call, prints the answer file named after the destination host (`answers/<host>`, in the runner\'s stand-in for the script);
 * `test -f` (is the script there?) succeeds. `answers/<host>.exit` makes the call exit with that status instead.
 */
function installFakeSsh(): void {
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir);
  fs.mkdirSync(path.join(root, 'answers'));
  const script = `#!/bin/bash
last="\${@: -1}"
host="\${@: -2:1}"
host="\${host#*@}"
echo "$host $last" >> "${path.join(root, 'ssh-calls.log')}"
case "$last" in
  *" clean "*)
    if [ -f "${path.join(root, 'answers')}/$host.exit" ]; then echo "remote-run-runner: it broke" >&2; exit "$(cat "${path.join(root, 'answers')}/$host.exit")"; fi
    [ -f "${path.join(root, 'answers')}/$host" ] && cat "${path.join(root, 'answers')}/$host"
    ;;
esac
exit 0
`;
  fs.writeFileSync(path.join(binDir, 'ssh'), script, { mode: 0o755 });
  previousPath = process.env.PATH;
  process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`;
}

function answer(host: string, text: string): void {
  fs.writeFileSync(path.join(root, 'answers', host), text);
}

function readCalls(): string[] {
  const log = path.join(root, 'ssh-calls.log');
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter((line) => line !== '') : [];
}

function writeRunners(names: string[]): void {
  const filePath = getRunnersConfigPath(root);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ runners: names.map((name) => ({ name, ssh: `user@${name}.example`, workDir: '/w' })) }));
}

function createIo(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text), cwd: projectDir, env: { PATH: process.env.PATH, XDG_CACHE_HOME: path.join(root, 'cache') }, homeDir: root }, out, err };
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remote-run-clean-')));
  projectDir = path.join(root, 'myapp');
  fs.mkdirSync(projectDir);
  execFileSync('git', ['-C', projectDir, 'init', '-q', '-b', 'main']);
  resetRunnersConfigCache();
  resetPairedRunnersCache();
  installFakeSsh();
});
afterEach(async () => {
  if (previousPath !== undefined) process.env.PATH = previousPath;
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); })));
  fs.rmSync(root, { recursive: true, force: true });
});

describe('remote-run clean', () => {
  it('names the project copy of the folder it is run in (no word) on EVERY runner and prints one line per runner, in the catalog\'s order, with what each freed', async () => {
    writeRunners(['box1', 'box2']);
    const { slug } = getProjectContext(projectDir);
    answer('box1.example', `removed=${slug} freed_kb=${41 * 1024 * 1024} why=clean\n`);
    answer('box2.example', `absent=${slug}\n`);
    const { io, out, err } = createIo();
    assert.equal(await runRemoteRunCli(['clean'], io), 0);
    assert.deepEqual(out.join('').split('\n').filter((line) => line !== ''), [`box1: removed the project copy ${slug} (freed 41 GB)`, `box2: no copy of ${slug} (nothing to clean)`]);
    assert.match(err.join(''), new RegExp(`^remote-run: cleaning ${slug} on box1, box2 \\(removing a big copy can take minutes\\)`));
    const cleanCalls = readCalls().filter((call) => call.includes(' clean '));
    assert.equal(cleanCalls.length, 2);
    for (const call of cleanCalls) assert.match(call, new RegExp(`bash /w/bin/runner-[0-9a-f]{8}\\.sh clean /w ${slug}$`));
  });

  it('a named copy is cleaned as named, from any folder — the folder\'s own project is not asked for', async () => {
    writeRunners(['box1']);
    const outside = path.join(root, 'not-a-project');
    fs.mkdirSync(outside);
    answer('box1.example', 'removed=other-0123456789 freed_kb=1048576 why=clean\n');
    const { io, out } = createIo();
    io.cwd = outside;
    assert.equal(await runRemoteRunCli(['clean', 'other-0123456789'], io), 0);
    assert.equal(out.join(''), 'box1: removed the project copy other-0123456789 (freed 1 GB)\n');
    assert.ok(readCalls().some((call) => call.endsWith(' clean /w other-0123456789')));
  });

  it('no word outside a git project says so before any runner is called', async () => {
    writeRunners(['box1']);
    const outside = path.join(root, 'not-a-project');
    fs.mkdirSync(outside);
    const { io, err } = createIo();
    io.cwd = outside;
    assert.equal(await runRemoteRunCli(['clean'], io), 125);
    assert.match(err.join(''), /is not inside a git working tree/);
    assert.deepEqual(readCalls(), []);
  });

  it('a copy that is still there although it was asked to go fails the command (125) — in use, would not go — and says which job to wait for; the other runner is still cleaned', async () => {
    writeRunners(['box1', 'box2', 'box3']);
    const { slug } = getProjectContext(projectDir);
    answer('box1.example', `busy=${slug} kind=running job=box1-abc234\n`);
    answer('box2.example', `removed=${slug} freed_kb=2097152 why=clean\n`);
    answer('box3.example', `stuck=${slug}\n`);
    const { io, out } = createIo();
    assert.equal(await runRemoteRunCli(['clean'], io), 125);
    assert.deepEqual(out.join('').split('\n').filter((line) => line !== ''), [
      'box1: NOT cleaned — box1-abc234 is running in it — `charness remote-run wait box1-abc234` (or `kill box1-abc234`), then clean again',
      `box2: removed the project copy ${slug} (freed 2 GB)`,
      `box3: NOT cleaned completely — the copy ${slug} would not go (read-only or in use); clean again later`,
    ]);
  });

  it('a runner that breaks is a failure with the runner\'s own words; one that cannot be reached is NOT (a sleeping Mac must not fail the closing of a task) — it says its copy stays', async () => {
    writeRunners(['box1']);
    const { slug } = getProjectContext(projectDir);
    fs.writeFileSync(path.join(root, 'answers', 'box1.example.exit'), '125');
    let { io, out } = createIo();
    assert.equal(await runRemoteRunCli(['clean'], io), 125);
    assert.equal(out.join(''), 'box1: NOT cleaned — it broke\n');

    // A paired runner nobody listens for: offline without any ssh call.
    fs.rmSync(path.join(root, 'answers', 'box1.example.exit'));
    fs.rmSync(getRunnersConfigPath(root));
    resetRunnersConfigCache();
    resetPairedRunnersCache();
    const hubDir = createHubContext({ homeDir: root }).dir;
    writePairedFile(hubDir, { rev: 1, runners: [createPairedRunnerFixture({ name: 'mac' })] });
    const callsBefore = readCalls().length;
    ({ io, out } = createIo());
    assert.equal(await runRemoteRunCli(['clean'], io), 0);
    assert.equal(out.join(''), `mac: not reached (the runner is not connected) — its copy of ${slug}, if any, stays; clean again when it is back\n`);
    assert.equal(readCalls().length, callsBefore, 'it was not called');
  });

  it('a runner that drops while it removes (ssh ends with 255: a plain-ssh Mac that fell asleep) is «not reached», not a failure — the removal goes on as far as it can, and the line says to clean again', async () => {
    writeRunners(['box1']);
    const { slug } = getProjectContext(projectDir);
    fs.writeFileSync(path.join(root, 'answers', 'box1.example.exit'), '255');
    const { io, out } = createIo();
    assert.equal(await runRemoteRunCli(['clean'], io), 0);
    assert.match(out.join(''), new RegExp(`^box1: not reached \\(.+\\) — its copy of ${slug}, if any, stays; clean again when it is back\n$`));
  });

  it('a paired Mac with its lid shut is not called either — the call may hang as it falls asleep', async () => {
    const runner = createPairedRunnerFixture({ name: 'mac' });
    const hubDir = createHubContext({ homeDir: root }).dir;
    writePairedFile(hubDir, { rev: 1, runners: [runner] });
    const paths = getRunnerLinkPaths(hubDir, runner.id);
    fs.mkdirSync(path.dirname(paths.socket), { recursive: true });
    const server = net.createServer((connection) => connection.destroy());
    servers.push(server);
    await new Promise<void>((resolve) => { server.listen(paths.socket, resolve); });
    const nowMs = Date.now();
    writeLinkState(hubDir, runner.id, { pid: process.pid, sinceMs: nowMs - 1000, lastBeatMs: nowMs, endedAtMs: null });
    writeLidState(hubDir, runner.id, { isClosed: true, reportedAtMs: nowMs });
    const { io, out } = createIo();
    assert.equal(await runRemoteRunCli(['clean', 'myapp-0123456789'], io), 0);
    assert.match(out.join(''), /^mac: not reached \(its Mac has the lid closed\)/);
    assert.equal(lidClosedReason, 'its Mac has the lid closed', 'the one wording, shared with the probe\'s gate');
    assert.deepEqual(readCalls(), []);
  });

  it('the usage names the command and what refuses it', async () => {
    const { io, out } = createIo();
    assert.equal(await runRemoteRunCli(['--help'], io), 0);
    const usage = out.join('');
    assert.match(usage, /charness remote-run clean \[<slug>\]/);
    assert.match(usage, /Refused \(exit 125\) while a job of it runs or waits, an exec runs in it or a job is being submitted/);
  });
});

describe('cleanOnRunner: what the call to one runner turns into', () => {
  const slug = 'myapp-0123456789';

  /** A runner client whose `clean` call answers `result` (and records its arguments) and whose script check is `ensureScript`. */
  function createClient(result: SshRunResult, ensureScript: () => Promise<void> = async () => undefined): { client: RunnerClient; calls: Array<{ subcommand: string; args: readonly string[]; timeoutMs: number | undefined }> } {
    const calls: Array<{ subcommand: string; args: readonly string[]; timeoutMs: number | undefined }> = [];
    const refuse = (): never => { throw new Error('not used'); };
    const client: RunnerClient = {
      runner: { name: 'box1', ssh: 'user@box1.example', workDir: '/w' },
      cacheDir: path.join(root, 'cache'),
      rsyncSshCommand: 'ssh',
      ensureScript,
      getAbsoluteWorkDir: refuse,
      call: async (subcommand, args, options) => { calls.push({ subcommand, args, timeoutMs: options?.timeoutMs }); return result; },
      callOrThrow: refuse,
      stream: refuse,
    };
    return { client, calls };
  }
  const answered = (stdout: string, overrides: Partial<SshRunResult> = {}): SshRunResult => ({ exitCode: 0, stdout, stderr: '', isTimedOut: false, ...overrides });

  it('asks for `clean <slug>` with the long timeout of a removal of tens of GB, and reads the answer', async () => {
    const { client, calls } = createClient(answered(`removed=${slug} freed_kb=1048576 why=clean\n`));
    assert.deepEqual(await cleanOnRunner(client, slug), { kind: 'removed', freedMb: 1024 });
    assert.deepEqual(calls, [{ subcommand: 'clean', args: [slug], timeoutMs: prepareCallTimeoutMs }]);
    assert.ok(prepareCallTimeoutMs >= 10 * 60 * 1000);
  });

  it('a call that ran out of its time is «timed out» with the minutes — the runner carries on, so the caller is told to clean again, not that the runner failed', async () => {
    const { client } = createClient(answered('', { exitCode: null, isTimedOut: true }));
    assert.deepEqual(await cleanOnRunner(client, slug), { kind: 'timedOut', timeoutMinutes: prepareCallTimeoutMs / 60_000 });
  });

  it('a connection that is lost during the call (ssh\'s own 255, or a killed ssh) is «unreachable» with the ssh reason; the script\'s own 125 is still a failure', async () => {
    const lost = await cleanOnRunner(createClient(answered('', { exitCode: 255, stderr: 'client_loop: send disconnect: Broken pipe\n' })).client, slug);
    assert.deepEqual(lost, { kind: 'unreachable', reason: 'client_loop: send disconnect: Broken pipe' });
    const killed = await cleanOnRunner(createClient(answered('', { exitCode: null, stderr: '' })).client, slug);
    assert.equal(killed.kind, 'unreachable');
    assert.equal((await cleanOnRunner(createClient(answered('', { exitCode: 125, stderr: 'remote-run-runner: boom\n' })).client, slug)).kind, 'failed');
  });

  it('a script that fails says its own last words (or the ssh failure when it said none)', async () => {
    assert.deepEqual(await cleanOnRunner(createClient(answered('', { exitCode: 125, stderr: 'remote-run-runner: bad name: x\n' })).client, slug), { kind: 'failed', message: 'bad name: x' });
    const silent = await cleanOnRunner(createClient(answered('', { exitCode: 3, stderr: '' })).client, slug);
    assert.equal(silent.kind, 'failed');
  });

  it('a runner that cannot be reached when its script is looked for is «unreachable» with the reason — and is not called; any other failure there is a failure', async () => {
    const unreachable = createClient(answered(''), async () => { throw new RunnerUnreachableError('box1', 'ssh: connection timed out'); });
    assert.deepEqual(await cleanOnRunner(unreachable.client, slug), { kind: 'unreachable', reason: 'ssh: connection timed out' });
    assert.deepEqual(unreachable.calls, []);
    const broken = createClient(answered(''), async () => { throw new RemoteRunError('could not put the runner script on "box1"'); });
    assert.deepEqual(await cleanOnRunner(broken.client, slug), { kind: 'failed', message: 'could not put the runner script on "box1"' });
  });
});

describe('markJobFetched: the sign to the runner that a job\'s results are with whoever submitted it', () => {
  it('asks the runner script for `fetched - <job>` (found from the job id alone) with an ordinary call timeout', async () => {
    const calls: Array<{ subcommand: string; args: readonly string[]; timeoutMs: number | undefined }> = [];
    const refuse = (): never => { throw new Error('not used'); };
    const client: RunnerClient = {
      runner: { name: 'box1', ssh: 'user@box1.example', workDir: '/w' },
      cacheDir: path.join(root, 'cache'),
      rsyncSshCommand: 'ssh',
      ensureScript: async () => undefined,
      getAbsoluteWorkDir: refuse,
      call: async (subcommand, args, options) => { calls.push({ subcommand, args, timeoutMs: options?.timeoutMs }); return { exitCode: 0, stdout: '', stderr: '', isTimedOut: false }; },
      callOrThrow: refuse,
      stream: refuse,
    };
    await markJobFetched(client, 'box1-abc234');
    assert.deepEqual(calls, [{ subcommand: 'fetched', args: ['-', 'box1-abc234'], timeoutMs: shortCallTimeoutMs }]);
  });

  it('a call that fails is no failure of the command that fetched the files: the copy then simply stays protected for an hour', async () => {
    const refuse = (): never => { throw new Error('not used'); };
    const client: RunnerClient = {
      runner: { name: 'box1', ssh: 'user@box1.example', workDir: '/w' },
      cacheDir: path.join(root, 'cache'),
      rsyncSshCommand: 'ssh',
      ensureScript: async () => undefined,
      getAbsoluteWorkDir: refuse,
      call: async () => { throw new Error('the connection dropped'); },
      callOrThrow: refuse,
      stream: refuse,
    };
    await assert.doesNotReject(markJobFetched(client, 'box1-abc234'));
  });
});
