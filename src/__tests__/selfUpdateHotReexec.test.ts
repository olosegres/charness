/**
 * @description Subprocess coverage for the hot supervisor re-executing itself (`src/cli/hot.ts`): on `SIGUSR2` it stops its two
 * watchers, leaves the speech sidecar alone, and replaces itself with `process.execve` — the SAME pid — and the new image starts
 * the watchers again with the environment the supervisor was LAUNCHED with, so an edited `.env` is read afresh. A copy of the built
 * dist runs with fake `tsc` / `nodemon` children, as in `hotCli.test.ts`: no Telegram, no OpenCode, nothing of the live service.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkIsProcessIdentityCurrent, getProcessIdentity, startExternallyParentedProcess } from '../installManager';
import {
  getHotSupervisorRecordPath,
  getStaleSupervisorModules,
  readHotSupervisorRecord,
  requestSupervisorReexec,
  supervisorReexecSignal,
  type HotSupervisorRecord,
} from '../selfUpdate/hotSupervisor';

const waitStepMs = 25;
const waitTimeoutMs = 20_000;
const testTimeoutMs = 120_000;

interface HotLayout {
  root: string;
  projectRoot: string;
  launchRoot: string;
  dataDir: string;
  copiedDist: string;
  eventsPath: string;
}

function createLayout(): HotLayout {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-hot-reexec-'));
  const projectRoot = path.join(root, 'charness');
  const layout: HotLayout = {
    root,
    projectRoot,
    launchRoot: path.join(root, 'projects'),
    dataDir: path.join(root, 'data'),
    copiedDist: path.join(projectRoot, 'dist'),
    eventsPath: path.join(root, 'events.log'),
  };
  const binDirectory = path.join(projectRoot, 'node_modules', '.bin');
  fs.mkdirSync(binDirectory, { recursive: true });
  for (const directory of [layout.launchRoot, path.join(root, 'home'), path.join(root, 'empty-bin'), path.join(layout.dataDir, 'stt')]) fs.mkdirSync(directory, { recursive: true });
  fs.cpSync(path.resolve(__dirname, '..', '..', 'dist'), layout.copiedDist, { recursive: true });
  fs.copyFileSync(path.resolve(__dirname, '..', '..', 'package.json'), path.join(projectRoot, 'package.json'));
  // Fake watchers: each logs its start and the signal that ends it, and stays up until it gets that signal.
  fs.writeFileSync(
    path.join(binDirectory, 'tsc'),
    [
      "const fs = require('fs'); const path = require('path');",
      `const log = (line) => fs.appendFileSync(${JSON.stringify(layout.eventsPath)}, line + '\\n');`,
      "fs.writeFileSync(path.join(process.cwd(), 'dist', 'cli', 'botEntry.js'), '');",
      "log('tsc started');",
      "process.stdout.write('Found 0 errors. Watching for file changes.\\n');",
      'setInterval(() => {}, 1000);',
      "process.on('SIGTERM', () => { log('tsc SIGTERM'); process.exit(0); });",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(binDirectory, 'nodemon'),
    [
      "const fs = require('fs');",
      `const log = (line) => fs.appendFileSync(${JSON.stringify(layout.eventsPath)}, line + '\\n');`,
      "log('nodemon started ' + JSON.stringify({ loaded: process.env.LOADED_FROM_ENV_FILE ?? null, launch: process.env.LAUNCH_ONLY ?? null, workRoot: process.env.WORK_ROOT }));",
      'setInterval(() => {}, 1000);',
      "process.on('SIGINT', () => { log('nodemon SIGINT'); process.exit(0); });",
    ].join('\n'),
  );
  fs.writeFileSync(path.join(projectRoot, '.env'), 'LOADED_FROM_ENV_FILE=first\n');
  return layout;
}

function readEvents(layout: HotLayout): string[] {
  return fs.existsSync(layout.eventsPath) ? fs.readFileSync(layout.eventsPath, 'utf8').split('\n').filter((line) => line !== '') : [];
}

async function waitFor(description: string, check: () => boolean, getContext: () => string): Promise<void> {
  const deadline = Date.now() + waitTimeoutMs;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, waitStepMs));
  assert.ok(check(), `${description}\n${getContext()}`);
}

interface RunningSupervisor {
  child: ChildProcess;
  getOutput: () => string;
  exited: Promise<number | null>;
}

function startSupervisor(layout: HotLayout): RunningSupervisor {
  const child = spawn(process.execPath, [path.join(layout.copiedDist, 'cli.js'), 'hot'], {
    cwd: layout.launchRoot,
    env: {
      DATA_DIR: layout.dataDir,
      HOME: path.join(layout.root, 'home'),
      NODE_PATH: path.resolve(__dirname, '..', '..', 'node_modules'),
      PATH: path.join(layout.root, 'empty-bin'),
      LAUNCH_ONLY: 'from the launch environment',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  return { child, getOutput: () => output, exited: new Promise((resolve) => child.once('exit', (code) => resolve(code))) };
}

function signalWithRealDeps(record: HotSupervisorRecord): string {
  return requestSupervisorReexec(record, {
    getStartToken: (pid) => getProcessIdentity(pid)?.startToken ?? null,
    kill: (pid, signal) => process.kill(pid, signal),
  });
}

test('the supervisor re-executes itself on SIGUSR2: same pid, watchers restarted, sidecar untouched, launch environment re-read', { timeout: testTimeoutMs }, async () => {
  const layout = createLayout();
  const sttRoot = path.join(layout.dataDir, 'stt');
  const sidecarRecordPath = path.join(sttRoot, 'sidecar.json');
  let sidecarIdentity: { pid: number; startToken: string } | null = null;
  let supervisor: RunningSupervisor | null = null;
  try {
    // A live speech sidecar owned by the test process: only a supervisor SHUTDOWN would stop it, a re-exec must not.
    const ownerIdentity = getProcessIdentity(process.pid);
    assert.ok(ownerIdentity);
    sidecarIdentity = await startExternallyParentedProcess(
      process.execPath,
      [path.join(__dirname, 'fixtures', 'fakeSttSidecar.cjs'), '--ready-file', path.join(sttRoot, 'ready.json'), '--record-file', sidecarRecordPath, '--owner-pid', process.pid.toString(), '--owner-start-token', ownerIdentity.startToken, '--config-hash', 'reexec-test-hash'],
      { ...process.env, CHARNESS_STT_SIDECAR_TOKEN: 'reexec-test-token' },
    );
    await waitFor('the sidecar recorded itself', () => fs.existsSync(sidecarRecordPath), () => '');

    supervisor = startSupervisor(layout);
    const running = supervisor;
    const pid = running.child.pid;
    assert.ok(pid);
    await waitFor('the first nodemon start', () => readEvents(layout).some((line) => line.startsWith('nodemon started')), () => running.getOutput());
    assert.match(readEvents(layout).find((line) => line.startsWith('nodemon started')) ?? '', /"loaded":"first","launch":"from the launch environment"/);

    const firstRecord = readHotSupervisorRecord(layout.dataDir);
    assert.ok(firstRecord, 'the supervisor wrote its record');
    assert.equal(firstRecord.pid, pid);
    assert.equal(firstRecord.canReexec, true);
    assert.ok(firstRecord.modules.some((module) => module.path === 'cli/hot.js') && firstRecord.modules.some((module) => module.path === 'cli.js'));
    assert.deepEqual(getStaleSupervisorModules(firstRecord, layout.copiedDist), [], 'nothing changed yet');

    // An update changed a file the supervisor loaded, and a hand edit changed the .env.
    fs.appendFileSync(path.join(layout.copiedDist, 'cli', 'hot.js'), '\n// changed by the update\n');
    fs.writeFileSync(path.join(layout.projectRoot, '.env'), 'LOADED_FROM_ENV_FILE=second\n');
    assert.deepEqual(getStaleSupervisorModules(firstRecord, layout.copiedDist), ['cli/hot.js']);
    assert.equal(signalWithRealDeps(firstRecord), 'signaled');

    await waitFor('the second nodemon start', () => readEvents(layout).filter((line) => line.startsWith('nodemon started')).length === 2, () => `${readEvents(layout).join('\n')}\n${running.getOutput()}`);
    const events = readEvents(layout);
    assert.ok(events.includes('tsc SIGTERM'), 'tsc -w was stopped');
    assert.ok(events.includes('nodemon SIGINT'), 'nodemon was stopped gracefully');
    assert.ok(events.indexOf('nodemon SIGINT') < events.lastIndexOf(events.filter((line) => line.startsWith('nodemon started'))[1]), 'the watchers stopped before the new image started them again');
    assert.match(events.filter((line) => line.startsWith('nodemon started'))[1], /"loaded":"second","launch":"from the launch environment"/);
    assert.equal(running.child.exitCode, null, 'the supervisor never exited: same process');
    assert.equal(running.child.pid, pid);

    await waitFor('the new image\'s record', () => readHotSupervisorRecord(layout.dataDir)?.modules.find((module) => module.path === 'cli/hot.js')?.sha256 !== firstRecord.modules.find((module) => module.path === 'cli/hot.js')?.sha256, () => running.getOutput());
    const secondRecord = readHotSupervisorRecord(layout.dataDir);
    assert.ok(secondRecord);
    assert.deepEqual([secondRecord.pid, secondRecord.startToken], [firstRecord.pid, firstRecord.startToken], 'the same identity — a signal sent by an old worker still reaches it');
    assert.deepEqual(getStaleSupervisorModules(secondRecord, layout.copiedDist), []);
    assert.match(running.getOutput(), /re-executing the supervisor/);

    assert.ok(checkIsProcessIdentityCurrent(sidecarIdentity), 'a re-exec leaves the speech sidecar running');
    assert.ok(fs.existsSync(sidecarRecordPath));

    running.child.kill('SIGTERM');
    assert.equal(await running.exited, 0, running.getOutput());
    assert.equal(checkIsProcessIdentityCurrent(sidecarIdentity), false, 'a real shutdown still stops the sidecar');
  } finally {
    if (supervisor && supervisor.child.exitCode === null) supervisor.child.kill('SIGKILL');
    if (sidecarIdentity && checkIsProcessIdentityCurrent(sidecarIdentity)) process.kill(sidecarIdentity.pid, 'SIGKILL');
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
});

test('a supervisor whose new image could not start (dist/cli.js is gone) stays as it is: nothing is stopped', { timeout: testTimeoutMs }, async () => {
  const layout = createLayout();
  let supervisor: RunningSupervisor | null = null;
  try {
    supervisor = startSupervisor(layout);
    const running = supervisor;
    await waitFor('the first nodemon start', () => readEvents(layout).some((line) => line.startsWith('nodemon started')), () => running.getOutput());
    const record = readHotSupervisorRecord(layout.dataDir);
    assert.ok(record);
    fs.rmSync(path.join(layout.copiedDist, 'cli.js'));
    assert.equal(signalWithRealDeps(record), 'signaled');
    await waitFor('the refusal is logged', () => /not re-executing — .*cli\.js is gone/.test(running.getOutput()), () => running.getOutput());
    assert.equal(running.child.exitCode, null);
    assert.deepEqual(readEvents(layout).filter((line) => line.includes('SIG')), [], 'neither watcher was signalled');

    running.child.kill('SIGTERM');
    assert.equal(await running.exited, 0, running.getOutput());
  } finally {
    if (supervisor && supervisor.child.exitCode === null) supervisor.child.kill('SIGKILL');
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
});

test('the record names a supervisor that exists only while it runs: a stale pid is never signalled', async () => {
  const layout = createLayout();
  try {
    const stale: HotSupervisorRecord = { pid: 2 ** 22 - 1, startToken: 'nobody', canReexec: true, modules: [] };
    fs.writeFileSync(getHotSupervisorRecordPath(layout.dataDir), JSON.stringify(stale));
    assert.equal(signalWithRealDeps(stale), 'gone');
    const own = getProcessIdentity(process.pid);
    assert.ok(own);
    assert.equal(signalWithRealDeps({ ...stale, pid: process.pid, startToken: `${own.startToken}-reused` }), 'differentProcess');
    assert.equal(supervisorReexecSignal, 'SIGUSR2');
  } finally {
    fs.rmSync(layout.root, { recursive: true, force: true });
  }
});
