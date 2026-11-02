/**
 * @description The interrupt handling of the REAL `charness remote-run` entry (`runRemoteRunCli`, its production wiring and nothing replaced):
 * while the command chooses a runner, a first interrupt ends its work and the command with 130, and a SECOND one ends the process at once
 * (`process.exit`, which the test stubs so the run can be followed to its end) — so a call that does not stop can never swallow Ctrl-C.
 * It fails when the command line's wait is wired to a plain interrupt handler (`addInterruptHandler`) instead of the one with the hard stop.
 *
 * The interrupts are the process's own `SIGINT` event fired twice by the test, not signals sent from outside: a stuck call that would make
 * a real second signal matter cannot be made on demand (an ssh client is always ended by SIGKILL), and the real signals of the hard stop
 * are in `remoteRunInterrupts.test.ts`. A test file's process has no `SIGINT` listener of its own.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CliIo } from '../remoteRun/output';
import { runRemoteRunCli } from '../remoteRun/remoteRunCli';
import { getRunnersConfigPath } from '../remoteRun/runnersConfig';
import { killRecordedProcess, readRecordedPid } from './recordedProcess';

const decoyLifetimeSec = 120;
const eventBoundMs = 30_000;

let root = '';
let originalPath: string | undefined;
let sshPidFile = '';
let stderr = '';

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-interrupt-'));
  sshPidFile = path.join(root, 'ssh.pid');
  stderr = '';
  const homeDir = path.join(root, 'home');
  fs.mkdirSync(path.join(homeDir, '.config', 'charness'), { recursive: true });
  fs.writeFileSync(getRunnersConfigPath(homeDir), JSON.stringify({ runners: [{ name: 'box1', ssh: 'runner@runner.example', workDir: '/home/runner/charness-runner' }] }));
  fs.mkdirSync(path.join(root, 'cache'));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  git(project, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(project, 'a.txt'), 'a\n');
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', 'init');
  // An `ssh` that never answers: the probe the command starts is held where it is until the command stops it.
  const decoyDir = path.join(root, 'bin');
  fs.mkdirSync(decoyDir);
  fs.writeFileSync(path.join(decoyDir, 'ssh'), `#!/bin/sh\necho $$ > "${sshPidFile}"\nexec sleep ${decoyLifetimeSec}\n`, { mode: 0o755 });
  originalPath = process.env.PATH;
  process.env.PATH = `${decoyDir}:${originalPath}`;
});
afterEach(() => {
  process.env.PATH = originalPath;
  killRecordedProcess(sshPidFile);
  fs.rmSync(root, { recursive: true, force: true });
});

function createIo(): CliIo {
  return {
    stdout: () => undefined,
    stderr: (text) => { stderr += text; },
    cwd: path.join(root, 'project'),
    env: { XDG_CACHE_HOME: path.join(root, 'cache') },
    homeDir: path.join(root, 'home'),
  };
}

async function waitForProbeHeld(): Promise<void> {
  const deadline = Date.now() + eventBoundMs;
  while (readRecordedPid(sshPidFile) === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.notEqual(readRecordedPid(sshPidFile), null, 'the probe reached the stand-in ssh and is held');
}

describe('remote-run in this process, interrupted while it chooses a runner', () => {
  it('one interrupt ends the probe and the command with 130 and the message — the process is not ended from outside', async () => {
    const exit = mock.method(process, 'exit', () => undefined as never);
    try {
      const finished = runRemoteRunCli(['echo', 'x'], createIo());
      await waitForProbeHeld();
      process.emit('SIGINT', 'SIGINT');
      assert.equal(await finished, 130);
      assert.match(stderr, /interrupted while looking for a runner/);
      assert.equal(exit.mock.callCount(), 0, 'one interrupt never ends the process by itself');
    } finally {
      exit.mock.restore();
    }
  });

  it('a SECOND interrupt, while the first one is still being cleaned up, ends the process at once with 130 — the CLI\'s wait is wired to the hard stop', async () => {
    const exit = mock.method(process, 'exit', () => undefined as never);
    try {
      const finished = runRemoteRunCli(['echo', 'x'], createIo());
      await waitForProbeHeld();
      process.emit('SIGINT', 'SIGINT');
      process.emit('SIGINT', 'SIGINT');
      assert.deepEqual(exit.mock.calls.map((call) => call.arguments[0]), [130], 'the second interrupt ended the process, with the code of the first');
      assert.equal(await finished, 130, 'and the command itself, which the stub let run on, ended the way one interrupt ends it');
    } finally {
      exit.mock.restore();
    }
  });

  it('the listening is gone when the command has ended: a later interrupt reaches nobody', async () => {
    const exit = mock.method(process, 'exit', () => undefined as never);
    try {
      const finished = runRemoteRunCli(['echo', 'x'], createIo());
      await waitForProbeHeld();
      process.emit('SIGINT', 'SIGINT');
      await finished;
      assert.equal(process.listenerCount('SIGINT'), 0);
    } finally {
      exit.mock.restore();
    }
  });
});
