/**
 * @description `remoteRun/remoteRunCli.ts` in-process, with its io injected: the usage and the exit codes of a bad command line (2, with
 * the reason and the usage), of `help` (0, stdout) and of no arguments at all (2, stderr); and what a missing, invalid or empty
 * `runners.json` says (125, naming the file and its fields, never a value). Nothing here reaches a runner: the commands that do are the
 * flows `remoteRunE2e.test.ts` and `remoteRunLifecycleE2e.test.ts`.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createProcessIo, readCurrentRunners, remoteRunUsage, runRemoteRunCli } from '../remoteRun/remoteRunCli';
import type { CliIo } from '../remoteRun/output';
import { getRunnersConfigPath, resetRunnersConfigCache } from '../remoteRun/runnersConfig';

let homeDir = '';

function createTestIo(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text), cwd: homeDir, env: { PATH: process.env.PATH, XDG_CACHE_HOME: path.join(homeDir, 'cache') }, homeDir },
    out,
    err,
  };
}

function writeRunnersFile(content: string): void {
  const filePath = getRunnersConfigPath(homeDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

describe('runRemoteRunCli', () => {
  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-run-cli-'));
    resetRunnersConfigCache();
  });
  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it('`--help` and `help` print the usage on stdout and exit 0', async () => {
    for (const word of ['--help', '-h', 'help']) {
      const { io, out, err } = createTestIo();
      assert.equal(await runRemoteRunCli([word], io), 0);
      assert.equal(out.join(''), remoteRunUsage);
      assert.deepEqual(err, []);
    }
  });

  it('no arguments at all is a usage mistake: the usage on stderr, exit 2', async () => {
    const { io, out, err } = createTestIo();
    assert.equal(await runRemoteRunCli([], io), 2);
    assert.deepEqual(out, []);
    assert.equal(err.join(''), remoteRunUsage);
  });

  it('a bad command line says why, then the usage, and exits 2 — before any runner is looked at', async () => {
    const { io, err } = createTestIo();
    assert.equal(await runRemoteRunCli(['--nope', 'echo', 'x'], io), 2);
    const text = err.join('');
    assert.match(text, /^remote-run: unknown option: --nope/);
    assert.ok(text.endsWith(remoteRunUsage));
    assert.equal(fs.existsSync(getRunnersConfigPath(homeDir)), false);
  });

  it('the usage names every command and the exit codes', () => {
    for (const word of ['runners', 'ls [--all]', 'status <id>', 'logs <id>', 'wait <id>', 'kill <id>', 'fetch <id>', 'exec', '--bg', '--needs', '--timeout', '--with-git', 'docs/remote-run.md']) {
      assert.ok(remoteRunUsage.includes(word), word);
    }
    assert.match(remoteRunUsage, /125 remote-run failed, 124 timeout, 130\/143\/129 interrupted/);
  });

  it('the usage tells an agent how a job lives beside others: the three variables of a step, that `exec` has none, and what never to do to the others (`simctl … all`, `killall Simulator`, killing by port) - and where the rest is', () => {
    const section = remoteRunUsage.slice(remoteRunUsage.indexOf('Jobs beside each other:'), remoteRunUsage.indexOf('Exit codes:'));
    assert.ok(section.length > 0, 'a section of its own, before the exit codes');
    for (const word of ['REMOTE_RUN_PORT_BASE', 'TMPDIR', 'REMOTE_RUN_IOS_SIMULATOR_UDID', '`exec` has none of them', 'xcrun simctl shutdown|erase|delete all', 'never \`booted\`', 'killall Simulator', 'by its pid', 'docs/remote-run.md, «Jobs beside each other»', 'jobs-at-once']) {
      assert.ok(section.includes(word), word);
    }
  });

  it('the usage says an iOS build or a Simulator test always carries --needs ios (an always-on Mac refuses it without a login session, and runs it there with one)', () => {
    assert.match(remoteRunUsage, /An iOS build or a Simulator test always carries --needs ios: an\s+always-on Mac runs such a job in its login session and refuses it with the reason when there is none/);
  });

  it('without a runners.json: exit 125, naming where the file belongs', async () => {
    const { io, err } = createTestIo();
    assert.equal(await runRemoteRunCli(['runners'], io), 125);
    assert.equal(err.join(''), `remote-run: no runners are set up: ${getRunnersConfigPath(homeDir)} does not exist and none is paired (docs/remote-run.md explains how to add one; \`charness runners pair\` pairs one)\n`);
  });

  it('an empty list: exit 125 saying so', async () => {
    writeRunnersFile(JSON.stringify({ runners: [] }));
    const { io, err } = createTestIo();
    assert.equal(await runRemoteRunCli(['runners'], io), 125);
    assert.match(err.join(''), /lists no runners/);
  });

  it('an invalid file: exit 125 with every error naming its field and no value', async () => {
    writeRunnersFile(JSON.stringify({ runners: [{ name: 'Bad Name', ssh: 'user@secret-host.example', workDir: 'relative' }] }));
    const { io, err } = createTestIo();
    assert.equal(await runRemoteRunCli(['runners'], io), 125);
    const text = err.join('');
    assert.match(text, /runners\.json runners\.0\.name:/);
    assert.match(text, /runners\.json runners\.0\.workDir:/);
    assert.ok(!text.includes('secret-host.example'), 'a value of the file is not echoed');
  });
});

describe('the runners a look in the middle of a command reads', () => {
  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-run-cli-'));
    resetRunnersConfigCache();
  });
  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it('a runners.json that is half-way through an edit does not end a wait: the list that last loaded is used, and the fixed file is read at once', () => {
    writeRunnersFile(JSON.stringify({ runners: [{ name: 'box1', ssh: 'runner@runner.example', workDir: '/w' }] }));
    assert.deepEqual(readCurrentRunners(homeDir).runners.map((runner) => runner.name), ['box1']);
    writeRunnersFile('{ "runners": [');
    assert.deepEqual(readCurrentRunners(homeDir).runners.map((runner) => runner.name), ['box1'], 'broken for the moment: the last good list');
    writeRunnersFile(JSON.stringify({ runners: [{ name: 'box2', ssh: 'runner@runner.example', workDir: '/w' }] }));
    assert.deepEqual(readCurrentRunners(homeDir).runners.map((runner) => runner.name), ['box2']);
  });

  it('with nothing ever loaded a broken file still stops the caller with its errors', () => {
    writeRunnersFile(JSON.stringify({ runners: [{ name: 'Bad Name', ssh: 'x', workDir: 'relative' }] }));
    assert.throws(() => readCurrentRunners(homeDir), /runners\.json runners\.0\.name:/);
  });
});

describe('createProcessIo', () => {
  it('is the real process: its cwd, environment and home', () => {
    const io = createProcessIo();
    assert.equal(io.cwd, process.cwd());
    assert.equal(io.env, process.env);
    assert.equal(io.homeDir, os.homedir());
  });
});
