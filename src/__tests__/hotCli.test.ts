/**
 * @description Subprocess integration coverage for the compiled hot supervisor.
 *
 * A temporary copy of dist uses deterministic fake tsc/nodemon children, so the
 * test exercises the real runHot wiring without touching Telegram, OpenCode, or
 * the running development service.
 *
 * Test case: N/A - Charness has no Jira tracker.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'child_process';
import * as net from 'net';
import { setTimeout as sleep } from 'node:timers/promises';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { checkIsProcessIdentityCurrent, getProcessIdentity, startExternallyParentedProcess } from '../installManager';

const subprocessTimeoutMs = 10_000;

/** What a child process wrote to stdout and stderr, in the order it arrived, with waits on it that resolve on the data, not on a clock. */
interface OutputWatch {
  getText: () => string;
  /** Resolves once `text` occurs `occurrences` times in the output. */
  waitFor: (text: string, occurrences?: number) => Promise<void>;
}

function countOccurrences(text: string, part: string): number {
  return text.split(part).length - 1;
}

/** Fails with the output so far when `promise` does not settle in {@link subprocessTimeoutMs}: a hang guard, never a deadline the scenario depends on. */
async function withinBound<Value>(promise: Promise<Value>, what: string, watch: OutputWatch): Promise<Value> {
  const bound = new AbortController();
  try {
    return await Promise.race([
      promise,
      sleep(subprocessTimeoutMs, undefined, { signal: bound.signal }).then(() => { throw new Error(`${what} did not happen; the output so far:\n${watch.getText()}`); }),
    ]);
  } finally {
    bound.abort();
  }
}

function createOutputWatch(child: ChildProcess): OutputWatch {
  let text = '';
  const waiters: Array<{ part: string; occurrences: number; resolve: () => void }> = [];
  const append = (chunk: Buffer): void => {
    text += chunk.toString();
    for (const waiter of waiters) if (countOccurrences(text, waiter.part) >= waiter.occurrences) waiter.resolve();
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  const watch: OutputWatch = {
    getText: () => text,
    waitFor: (part, occurrences = 1) => withinBound(
      countOccurrences(text, part) >= occurrences ? Promise.resolve() : new Promise<void>((resolve) => { waiters.push({ part, occurrences, resolve }); }),
      `${JSON.stringify(part)} (x${occurrences}) in the output`,
      watch,
    ),
  };
  return watch;
}

test('hot supervisor waits for a clean compile, starts nodemon once, and propagates WORK_ROOT', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-hot-e2e-'));
  const projectRoot = path.join(temporaryRoot, 'telegram-code');
  const launchRoot = path.join(temporaryRoot, 'projects');
  const homeDirectory = path.join(temporaryRoot, 'home');
  const emptyBinDirectory = path.join(temporaryRoot, 'empty-bin');
  const localBinDirectory = path.join(projectRoot, 'node_modules', '.bin');
  const sourceDist = path.resolve(__dirname, '..', '..', 'dist');
  const copiedDist = path.join(projectRoot, 'dist');
  const copiedBotEntry = path.join(copiedDist, 'cli', 'botEntry.js');
  const fakeTscPath = path.join(localBinDirectory, 'tsc');
  const fakeNodemonPath = path.join(localBinDirectory, 'nodemon');
  // The fake `tsc -w` writes what the test tells it to, when it tells it: the supervisor's reading of the output is the thing
  // under test, and a fake that wrote on its own timetable would race the supervisor's scheduling (a supervisor that gets the
  // CPU late reads several pieces at once, and the «clean compile, no worker entry yet» moment never happens).
  const controlServer = net.createServer();
  let supervisor: ChildProcess | null = null;
  let fakeTsc: net.Socket | null = null;

  try {
    fs.mkdirSync(localBinDirectory, { recursive: true });
    fs.mkdirSync(launchRoot, { recursive: true });
    fs.mkdirSync(homeDirectory, { recursive: true });
    fs.mkdirSync(emptyBinDirectory, { recursive: true });
    fs.cpSync(sourceDist, copiedDist, { recursive: true });
    fs.rmSync(copiedBotEntry, { force: true });

    fs.writeFileSync(
      fakeTscPath,
      [
        "const fs = require('fs');",
        "const net = require('net');",
        "const socket = net.connect(Number(process.env.FAKE_TSC_CONTROL_PORT), '127.0.0.1');",
        "socket.setEncoding('utf8');",
        "let pending = '';",
        "socket.on('data', (chunk) => {",
        '  pending += chunk;',
        '  for (let newline = pending.indexOf("\\n"); newline >= 0; newline = pending.indexOf("\\n")) {',
        '    const command = JSON.parse(pending.slice(0, newline));',
        '    pending = pending.slice(newline + 1);',
        "    if (command.writeFile) fs.writeFileSync(command.writeFile, '');",
        '    if (command.stdout) process.stdout.write(command.stdout);',
        '  }',
        '});',
        "process.on('SIGTERM', () => process.exit(0));",
        // Never outlive the test that drives it, whatever way that ended.
        "socket.on('close', () => process.exit(0));",
      ].join('\n'),
    );
    fs.writeFileSync(
      fakeNodemonPath,
      [
        "process.stdout.write('FAKE_NODEMON_STARTED WORK_ROOT=' + process.env.WORK_ROOT + '\\n');",
        'process.exit(0);',
      ].join('\n'),
    );

    const fakeTscConnection = new Promise<net.Socket>((resolve) => controlServer.once('connection', resolve));
    await new Promise<void>((resolve) => controlServer.listen(0, '127.0.0.1', resolve));
    const controlAddress = controlServer.address();
    assert.ok(controlAddress && typeof controlAddress === 'object', 'the control server has a port');

    supervisor = spawn(process.execPath, [path.join(copiedDist, 'cli.js'), 'hot'], {
      cwd: launchRoot,
      env: {
        DATA_DIR: path.join(temporaryRoot, 'data'),
        HOME: homeDirectory,
        NODE_PATH: path.resolve(__dirname, '..', '..', 'node_modules'),
        PATH: emptyBinDirectory,
        FAKE_TSC_CONTROL_PORT: controlAddress.port.toString(),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const supervisorOutput = createOutputWatch(supervisor);
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      supervisor?.once('exit', (code, signal) => resolve({ code, signal }));
    });
    const connectedFakeTsc = await withinBound(fakeTscConnection, 'the fake tsc connecting to the test', supervisorOutput);
    fakeTsc = connectedFakeTsc;
    const release = (command: { stdout?: string; writeFile?: string }): void => { connectedFakeTsc.write(`${JSON.stringify(command)}\n`); };
    const failingMarkerStart = 'Found 1 error. Watching for file cha';
    const cleanMarkerStart = 'Found 0 errors. Watching for file cha';
    const markerEnd = 'nges.\n';

    // Each piece is released only once the supervisor has reacted to the one before: it echoes a chunk first thing, and says
    // what it made of a completed compile on stderr.
    release({ stdout: failingMarkerStart });
    await supervisorOutput.waitFor(failingMarkerStart);
    release({ stdout: markerEnd });
    await supervisorOutput.waitFor('compile has TypeScript errors; nodemon is waiting for a clean build');
    release({ stdout: cleanMarkerStart });
    await supervisorOutput.waitFor(cleanMarkerStart);
    release({ stdout: markerEnd });
    await supervisorOutput.waitFor('clean compile produced no dist worker entry');
    release({ writeFile: copiedBotEntry, stdout: cleanMarkerStart });
    await supervisorOutput.waitFor(cleanMarkerStart, 2);
    release({ stdout: markerEnd });
    await supervisorOutput.waitFor('FAKE_NODEMON_STARTED');
    const result = await withinBound(exited, 'the supervisor exiting after its nodemon did', supervisorOutput);

    const output = supervisorOutput.getText();
    const failedCompileIndex = output.indexOf('Found 1 error. Watching for file changes.');
    const cleanCompileIndex = output.indexOf('Found 0 errors. Watching for file changes.');
    const recoveredCompileIndex = output.indexOf(
      'Found 0 errors. Watching for file changes.',
      cleanCompileIndex + 1,
    );
    const nodemonStartIndex = output.indexOf('FAKE_NODEMON_STARTED');

    assert.equal(result.signal, null);
    assert.equal(result.code, 1, 'a clean unexpected nodemon exit must fail the wrapper');
    assert.ok(failedCompileIndex >= 0);
    assert.ok(cleanCompileIndex > failedCompileIndex);
    assert.ok(recoveredCompileIndex > cleanCompileIndex);
    assert.ok(nodemonStartIndex > recoveredCompileIndex);
    assert.ok(output.indexOf('compile has TypeScript errors') > failedCompileIndex);
    assert.ok(output.indexOf('clean compile produced no dist worker entry') > cleanCompileIndex, 'the missing worker entry was noticed after the first clean compile…');
    assert.ok(output.indexOf('clean compile produced no dist worker entry') < recoveredCompileIndex, '…and before the recovered one');
    assert.match(output, new RegExp(`FAKE_NODEMON_STARTED WORK_ROOT=${launchRoot}`));
    assert.equal(output.match(/FAKE_NODEMON_STARTED/g)?.length, 1);
  } finally {
    // A failed wait leaves the supervisor and its fake tsc running: stop them, so the test process can end.
    fakeTsc?.destroy();
    if (supervisor && supervisor.exitCode === null && supervisor.signalCode === null) {
      const stopped = new Promise<void>((resolve) => { supervisor?.once('exit', () => resolve()); });
      supervisor.kill('SIGTERM');
      await Promise.race([stopped, sleep(subprocessTimeoutMs)]);
      if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill('SIGKILL');
    }
    controlServer.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('nodemon config launches the dedicated internal worker entry', () => {
  const nodemonConfigSource = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'nodemon.json'),
    'utf8',
  );
  assert.match(nodemonConfigSource, /"exec"\s*:\s*"node dist\/cli\/botEntry\.js"/);
  assert.doesNotMatch(nodemonConfigSource, /dist\/cli\.js bot/);
});

test('hot supervisor hands its worker the speech-engine owner env, and stops the recorded sidecar when it shuts down', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-hot-stt-'));
  const projectRoot = path.join(temporaryRoot, 'telegram-code');
  const launchRoot = path.join(temporaryRoot, 'projects');
  const homeDirectory = path.join(temporaryRoot, 'home');
  const dataDir = path.join(temporaryRoot, 'data');
  const emptyBinDirectory = path.join(temporaryRoot, 'empty-bin');
  const localBinDirectory = path.join(projectRoot, 'node_modules', '.bin');
  const copiedDist = path.join(projectRoot, 'dist');
  const fakeSidecarPath = path.join(__dirname, 'fixtures', 'fakeSttSidecar.cjs');
  const sttRoot = path.join(dataDir, 'stt');
  const recordPath = path.join(sttRoot, 'sidecar.json');
  let sidecarIdentity: { pid: number; startToken: string } | null = null;

  try {
    fs.mkdirSync(localBinDirectory, { recursive: true });
    fs.mkdirSync(launchRoot, { recursive: true });
    fs.mkdirSync(homeDirectory, { recursive: true });
    fs.mkdirSync(emptyBinDirectory, { recursive: true });
    fs.mkdirSync(sttRoot, { recursive: true });
    fs.cpSync(path.resolve(__dirname, '..', '..', 'dist'), copiedDist, { recursive: true });
    fs.writeFileSync(
      path.join(localBinDirectory, 'tsc'),
      [
        "const fs = require('fs');",
        "const path = require('path');",
        "fs.writeFileSync(path.join(process.cwd(), 'dist', 'cli', 'botEntry.js'), '');",
        "process.stdout.write('Found 0 errors. Watching for file changes.\\n');",
        'setInterval(() => {}, 1000);',
        "process.on('SIGTERM', () => process.exit(0));",
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(localBinDirectory, 'nodemon'),
      [
        "process.stdout.write('FAKE_NODEMON_STARTED OWNER_PID=' + process.env.CHARNESS_STT_OWNER_PID + ' OWNER_TOKEN=' + process.env.CHARNESS_STT_OWNER_START_TOKEN + '\\n');",
        'setInterval(() => {}, 1000);',
        "process.on('SIGINT', () => process.exit(0));",
      ].join('\n'),
    );

    // A live sidecar the way an earlier worker would have left it: it records itself (the contract). The test
    // process is its owner, so only the supervisor's shutdown can end it.
    const ownerIdentity = getProcessIdentity(process.pid);
    assert.ok(ownerIdentity);
    sidecarIdentity = await startExternallyParentedProcess(
      process.execPath,
      [fakeSidecarPath, '--ready-file', path.join(sttRoot, 'ready.json'), '--record-file', recordPath, '--owner-pid', process.pid.toString(), '--owner-start-token', ownerIdentity.startToken, '--config-hash', 'hot-test-hash'],
      { ...process.env, CHARNESS_STT_SIDECAR_TOKEN: 'hot-test-token' },
    );
    const recordDeadlineMs = Date.now() + subprocessTimeoutMs;
    while (!fs.existsSync(recordPath) && Date.now() < recordDeadlineMs) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(fs.existsSync(recordPath), 'the sidecar recorded itself');

    const supervisor = spawn(process.execPath, [path.join(copiedDist, 'cli.js'), 'hot'], {
      cwd: launchRoot,
      env: { DATA_DIR: dataDir, HOME: homeDirectory, NODE_PATH: path.resolve(__dirname, '..', '..', 'node_modules'), PATH: emptyBinDirectory },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    supervisor.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    supervisor.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    const exited = new Promise<number | null>((resolve) => supervisor.once('exit', (code) => resolve(code)));

    const deadlineMs = Date.now() + subprocessTimeoutMs;
    while (!output.includes('FAKE_NODEMON_STARTED') && Date.now() < deadlineMs) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(supervisor.pid && output.includes('FAKE_NODEMON_STARTED'), output);
    const supervisorIdentity = getProcessIdentity(supervisor.pid);
    assert.ok(supervisorIdentity);
    assert.match(output, new RegExp(`FAKE_NODEMON_STARTED OWNER_PID=${supervisor.pid} OWNER_TOKEN=${supervisorIdentity.startToken}`));
    assert.ok(checkIsProcessIdentityCurrent(sidecarIdentity), 'the worker starting does not touch a sidecar');

    supervisor.kill('SIGTERM');
    assert.equal(await exited, 0, output);
    assert.equal(checkIsProcessIdentityCurrent(sidecarIdentity), false, 'the supervisor\'s shutdown stopped the recorded sidecar');
    assert.equal(fs.existsSync(recordPath), false, 'and removed its record');
  } finally {
    if (sidecarIdentity && checkIsProcessIdentityCurrent(sidecarIdentity)) process.kill(sidecarIdentity.pid, 'SIGKILL');
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
