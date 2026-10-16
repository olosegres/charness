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
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { checkIsProcessIdentityCurrent, getProcessIdentity, startExternallyParentedProcess } from '../installManager';

const subprocessTimeoutMs = 10_000;

test('hot supervisor waits for a clean compile, starts nodemon once, and propagates WORK_ROOT', () => {
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
        "const path = require('path');",
        "process.stdout.write('Found 1 error. Watching for file cha');",
        "setTimeout(() => process.stdout.write('nges.\\n'), 20);",
        "setTimeout(() => process.stdout.write('Found 0 errors. Watching for file cha'), 60);",
        "setTimeout(() => process.stdout.write('nges.\\n'), 80);",
        'setTimeout(() => {',
        "  fs.writeFileSync(path.join(process.cwd(), 'dist', 'cli', 'botEntry.js'), '');",
        "  process.stdout.write('Found 0 errors. Watching for file cha');",
        '}, 120);',
        "setTimeout(() => process.stdout.write('nges.\\n'), 140);",
        'setInterval(() => {}, 1000);',
        "process.on('SIGTERM', () => process.exit(0));",
      ].join('\n'),
    );
    fs.writeFileSync(
      fakeNodemonPath,
      [
        "process.stdout.write('FAKE_NODEMON_STARTED WORK_ROOT=' + process.env.WORK_ROOT + '\\n');",
        'process.exit(0);',
      ].join('\n'),
    );

    const result = spawnSync(process.execPath, [path.join(copiedDist, 'cli.js'), 'hot'], {
      cwd: launchRoot,
      env: {
        DATA_DIR: path.join(temporaryRoot, 'data'),
        HOME: homeDirectory,
        NODE_PATH: path.resolve(__dirname, '..', '..', 'node_modules'),
        PATH: emptyBinDirectory,
      },
      encoding: 'utf8',
      timeout: subprocessTimeoutMs,
    });
    const output = result.stdout + result.stderr;
    const failedCompileIndex = output.indexOf('Found 1 error. Watching for file changes.');
    const cleanCompileIndex = output.indexOf('Found 0 errors. Watching for file changes.');
    const recoveredCompileIndex = output.indexOf(
      'Found 0 errors. Watching for file changes.',
      cleanCompileIndex + 1,
    );
    const nodemonStartIndex = output.indexOf('FAKE_NODEMON_STARTED');

    assert.equal(result.signal, null);
    assert.equal(result.status, 1, 'a clean unexpected nodemon exit must fail the wrapper');
    assert.ok(failedCompileIndex >= 0);
    assert.ok(cleanCompileIndex > failedCompileIndex);
    assert.ok(recoveredCompileIndex > cleanCompileIndex);
    assert.ok(nodemonStartIndex > recoveredCompileIndex);
    assert.match(output, /compile has TypeScript errors; nodemon is waiting for a clean build/);
    assert.match(output, /clean compile produced no dist worker entry/);
    assert.match(output, new RegExp(`FAKE_NODEMON_STARTED WORK_ROOT=${launchRoot}`));
    assert.equal(output.match(/FAKE_NODEMON_STARTED/g)?.length, 1);
  } finally {
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

    // A live sidecar the way an earlier worker would have left it, with its record. The test process is its
    // owner, so only the supervisor's shutdown can end it.
    const ownerIdentity = getProcessIdentity(process.pid);
    assert.ok(ownerIdentity);
    sidecarIdentity = await startExternallyParentedProcess(
      process.execPath,
      [fakeSidecarPath, '--ready-file', path.join(sttRoot, 'ready.json'), '--record-file', recordPath, '--owner-pid', process.pid.toString(), '--owner-start-token', ownerIdentity.startToken],
      { ...process.env, CHARNESS_STT_SIDECAR_TOKEN: 'hot-test-token' },
    );
    fs.writeFileSync(recordPath, JSON.stringify({
      ...sidecarIdentity, port: 1, token: 'hot-test-token', configHash: 'h', ownerPid: process.pid, ownerStartToken: ownerIdentity.startToken, startedAt: 'now',
    }));

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
