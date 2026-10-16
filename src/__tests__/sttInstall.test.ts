/**
 * @description The installer of the local speech engine: how it picks the tool
 * (uv, else a python3 that can make a venv, else a named error), what counts as
 * "installed", how the install lock behaves, and the orchestration of a run —
 * driven with a fake command runner, so no network and no Python are needed.
 * The real install is proven by `live/sttGigaamLive.test.ts`.
 */

import { test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  formatDownloadDetail,
  gigaamModelApproxBytes,
  gigaamPinnedRequirements,
  gigaamScriptVersion,
  getLastSttInstallProgress,
  getSidecarScriptPath,
  getSttPaths,
  isGigaamInstalled,
  isGigaamInstalling,
  missingPythonToolError,
  planSttInstall,
  readSttInstallProgress,
  removeSttInstall,
  runSttCommand,
  runSttInstall,
  type SttCommandRunner,
  type SttInstallFacts,
  type SttInstallProgress,
} from '../stt/sttInstall';

let dataDir = '';

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-install-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const mebibyte = 1024 * 1024;

function createFacts(overrides: Partial<SttInstallFacts> = {}): SttInstallFacts {
  return { uvPath: null, python3: null, paths: getSttPaths(dataDir), ...overrides };
}

const goodPython3 = { path: '/usr/bin/python3', major: 3, minor: 12, hasVenvSupport: true };

test('the sidecar script and the installer agree on the script version', () => {
  const script = fs.readFileSync(getSidecarScriptPath(), 'utf8');
  assert.equal(/^SCRIPT_VERSION = "(.+)"$/m.exec(script)?.[1], gigaamScriptVersion);
});

test('plan: uv is preferred and needs no ensurepip — a venv for Python >= 3.10, then the pinned packages', () => {
  const paths = getSttPaths(dataDir);
  const plan = planSttInstall(createFacts({ uvPath: '/home/user/.local/bin/uv', python3: goodPython3 }));
  assert.ok(plan.ok);
  assert.equal(plan.tool, 'uv');
  assert.deepEqual(plan.commands, [
    { command: '/home/user/.local/bin/uv', args: ['venv', '--python', '>=3.10', paths.venvDir], phase: 'creatingEnvironment' },
    {
      command: '/home/user/.local/bin/uv',
      args: ['pip', 'install', '--python', paths.venvPython, ...gigaamPinnedRequirements],
      phase: 'installingPackages',
    },
  ]);
});

test('plan: uv alone is enough, even with no python3 on the box (this host has uv but a python3 without ensurepip)', () => {
  const noEnsurepip = { ...goodPython3, hasVenvSupport: false };
  assert.equal(planSttInstall(createFacts({ uvPath: '/bin/uv', python3: noEnsurepip })).ok, true);
  assert.equal(planSttInstall(createFacts({ uvPath: '/bin/uv' })).ok, true);
});

test('plan: without uv a python3 >= 3.10 that can make a venv installs through pip', () => {
  const paths = getSttPaths(dataDir);
  const plan = planSttInstall(createFacts({ python3: goodPython3 }));
  assert.ok(plan.ok);
  assert.equal(plan.tool, 'pip');
  assert.deepEqual(plan.commands, [
    { command: '/usr/bin/python3', args: ['-m', 'venv', paths.venvDir], phase: 'creatingEnvironment' },
    {
      command: paths.venvPython,
      args: ['-m', 'pip', 'install', '--no-cache-dir', ...gigaamPinnedRequirements],
      phase: 'installingPackages',
    },
  ]);
  assert.equal(planSttInstall(createFacts({ python3: { ...goodPython3, major: 4, minor: 0 } })).ok, true);
  assert.equal(planSttInstall(createFacts({ python3: { ...goodPython3, minor: 10 } })).ok, true);
});

test('plan: no uv and a python3 that is too old, cannot make a venv, or is missing → one error naming what to install', () => {
  for (const python3 of [{ ...goodPython3, minor: 9 }, { ...goodPython3, major: 2, minor: 7 }, { ...goodPython3, hasVenvSupport: false }, null]) {
    const plan = planSttInstall(createFacts({ python3 }));
    assert.deepEqual(plan, { ok: false, error: missingPythonToolError });
  }
  assert.match(missingPythonToolError, /uv/);
  assert.match(missingPythonToolError, /python3-venv/);
  assert.match(missingPythonToolError, /3\.10/);
});

test('installed: needs the marker of THIS script version and pins, and the venv interpreter', () => {
  const paths = getSttPaths(dataDir);
  assert.equal(isGigaamInstalled(dataDir), false, 'nothing yet');

  fs.mkdirSync(path.dirname(paths.venvPython), { recursive: true });
  const writeMarker = (overrides: object): void =>
    fs.writeFileSync(
      paths.markerFile,
      JSON.stringify({ scriptVersion: gigaamScriptVersion, pins: gigaamPinnedRequirements, installedAt: '2026-10-16T00:00:00.000Z', ...overrides }),
    );
  writeMarker({});
  assert.equal(isGigaamInstalled(dataDir), false, 'a marker without an interpreter is a half-removed install');

  fs.writeFileSync(paths.venvPython, '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(isGigaamInstalled(dataDir), true);

  writeMarker({ scriptVersion: `${gigaamScriptVersion}-old` });
  assert.equal(isGigaamInstalled(dataDir), false, 'a venv built for another script version');
  writeMarker({ pins: ['onnx-asr==0.1.0'] });
  assert.equal(isGigaamInstalled(dataDir), false, 'a venv built from other pins');
  fs.writeFileSync(paths.markerFile, 'not json');
  assert.equal(isGigaamInstalled(dataDir), false);
});

test('installing: a lock owned by a live process counts, a stale or dead-owner one does not', () => {
  const paths = getSttPaths(dataDir);
  assert.equal(isGigaamInstalling(dataDir), false);

  fs.mkdirSync(paths.lockDir, { recursive: true });
  assert.equal(isGigaamInstalling(dataDir), true, 'a fresh lock with no owner file yet is held');

  fs.writeFileSync(path.join(paths.lockDir, 'owner'), `${process.pid}\n`);
  assert.equal(isGigaamInstalling(dataDir), true);

  fs.writeFileSync(path.join(paths.lockDir, 'owner'), `${2 ** 22 - 1}\n`);
  assert.equal(isGigaamInstalling(dataDir), false, 'the owner is dead');

  fs.writeFileSync(path.join(paths.lockDir, 'owner'), `${process.pid}\n`);
  const thirtyOneMinutesMs = 31 * 60 * 1000;
  assert.equal(isGigaamInstalling(dataDir, Date.now() + thirtyOneMinutesMs), false, 'an old lock is stale even if its owner lives');
});

test('progress lines: the last complete JSON line wins, a torn last line is skipped', () => {
  assert.equal(getLastSttInstallProgress(''), null);
  assert.equal(getLastSttInstallProgress('garbage\n'), null);
  const lines = [
    { phase: 'installingPackages', detail: '', bytesDownloaded: 0 },
    { phase: 'downloadingModel', detail: '120/216 MB', bytesDownloaded: 120 * mebibyte },
  ].map((line) => JSON.stringify(line));
  assert.deepEqual(getLastSttInstallProgress(`${lines.join('\n')}\n`), {
    phase: 'downloadingModel',
    detail: '120/216 MB',
    bytesDownloaded: 120 * mebibyte,
    error: undefined,
    logTail: undefined,
  });
  assert.equal(getLastSttInstallProgress(`${lines.join('\n')}\n{"phase":"checki`)?.phase, 'downloadingModel');
});

test('download detail: whole megabytes of the approximate total, never past it', () => {
  assert.equal(formatDownloadDetail(0), '0/216 MB');
  assert.equal(formatDownloadDetail(120 * mebibyte + 5), '120/216 MB');
  assert.equal(formatDownloadDetail(gigaamModelApproxBytes * 2), '216/216 MB');
});

/** A runner that plays the venv/pip/check commands against the real file system. */
function createFakeRunner(calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }>, overrides: { failStep?: string; checkStdout?: string; checkExit?: number; onCheck?: () => Promise<void> } = {}): SttCommandRunner {
  const paths = getSttPaths(dataDir);
  return async (command, args, { env, logFile }) => {
    calls.push({ command, args, env });
    fs.appendFileSync(logFile, `ran ${path.basename(command)} ${args[0]}\n`);
    const step = command === paths.venvPython && args.includes('--check') ? 'check' : args[0];
    if (overrides.failStep === step) {
      fs.appendFileSync(logFile, `boom in ${step}\n`);
      return { exitCode: 1, stdout: '' };
    }
    if (step === 'venv') {
      fs.mkdirSync(path.dirname(paths.venvPython), { recursive: true });
      fs.writeFileSync(paths.venvPython, '#!/bin/sh\n', { mode: 0o755 });
    }
    if (step === 'check') {
      await overrides.onCheck?.();
      return { exitCode: overrides.checkExit ?? 0, stdout: overrides.checkStdout ?? 'noise from onnx\n{"ok": true}\n' };
    }
    return { exitCode: 0, stdout: '' };
  };
}

function createUvFacts(paths: ReturnType<typeof getSttPaths>): SttInstallFacts {
  return { uvPath: '/fake/uv', python3: null, paths };
}

test('run: venv → packages → model check, then the marker; progress goes to the callback and the file', async () => {
  const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const reports: SttInstallProgress[] = [];
  const result = await runSttInstall(dataDir, {
    runCommand: createFakeRunner(calls),
    detectFacts: createUvFacts,
    env: { PATH: '/bin', HF_HUB_OFFLINE: '1' },
    onProgress: (progress) => reports.push(progress),
    downloadPollIntervalMs: 10_000,
  });
  assert.deepEqual(result, { ok: true, wasAlreadyInstalled: false });

  const paths = getSttPaths(dataDir);
  assert.deepEqual(calls.map((call) => path.basename(call.command) + ' ' + call.args[0]), ['uv venv', 'uv pip', 'python -I']);
  assert.deepEqual(calls[2].args, ['-I', getSidecarScriptPath(), '--check']);
  assert.equal(calls[2].env.HF_HOME, paths.hfHome, 'the model lands in the private cache');
  assert.equal(calls[2].env.UV_CACHE_DIR, paths.uvCacheDir);
  assert.equal(calls[2].env.HF_HUB_OFFLINE, undefined, 'the fetch needs the network');

  assert.deepEqual(reports.map((report) => report.phase), ['creatingEnvironment', 'installingPackages', 'downloadingModel', 'done']);
  assert.equal(isGigaamInstalled(dataDir), true);
  assert.equal(JSON.parse(fs.readFileSync(paths.markerFile, 'utf8')).scriptVersion, gigaamScriptVersion);
  assert.equal(readSttInstallProgress(dataDir)?.phase, 'done', 'the progress file ends with done');
  assert.equal(fs.existsSync(paths.lockDir), false, 'the lock is released');
});

test('run: idempotent — a current install runs nothing, force rebuilds it', async () => {
  const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const options = { runCommand: createFakeRunner(calls), detectFacts: createUvFacts, env: {}, downloadPollIntervalMs: 10_000 };
  await runSttInstall(dataDir, options);
  const callsAfterFirst = calls.length;

  const again = await runSttInstall(dataDir, options);
  assert.deepEqual(again, { ok: true, wasAlreadyInstalled: true });
  assert.equal(calls.length, callsAfterFirst);
  assert.equal(readSttInstallProgress(dataDir)?.phase, 'done', 'even a no-op run leaves a done line for its reader');

  const forced = await runSttInstall(dataDir, { ...options, force: true });
  assert.deepEqual(forced, { ok: true, wasAlreadyInstalled: false });
  assert.equal(calls.length, callsAfterFirst * 2);
});

test('run: a failing step returns its log tail, reports failed, writes no marker and frees the lock', async () => {
  const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const reports: SttInstallProgress[] = [];
  const result = await runSttInstall(dataDir, {
    runCommand: createFakeRunner(calls, { failStep: 'pip' }),
    detectFacts: createUvFacts,
    env: {},
    onProgress: (progress) => reports.push(progress),
  });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reason === 'failed');
  assert.match(!result.ok ? result.error : '', /uv pip failed \(exit 1\)/);
  assert.ok(!result.ok && result.logTail.includes('boom in pip'));
  assert.equal(calls.length, 2, 'nothing runs after the failure');
  assert.equal(reports.at(-1)?.phase, 'failed');
  assert.ok(reports.at(-1)?.logTail?.includes('boom in pip'));
  const paths = getSttPaths(dataDir);
  assert.equal(fs.existsSync(paths.markerFile), false);
  assert.equal(fs.existsSync(paths.lockDir), false);
  assert.equal(isGigaamInstalled(dataDir), false);
});

test('run: the failure tail splits progress-bar redraws into lines and caps their length', async () => {
  const paths = getSttPaths(dataDir);
  const runner: SttCommandRunner = async (_command, args, { logFile }) => {
    if (args[0] === 'pip') {
      fs.appendFileSync(logFile, `Fetching 0%\rFetching 50%\rFetching 100%\n${'x'.repeat(5000)}\n`);
      return { exitCode: 1, stdout: '' };
    }
    return { exitCode: 0, stdout: '' };
  };
  const result = await runSttInstall(dataDir, { runCommand: runner, detectFacts: createUvFacts, env: {} });
  assert.ok(!result.ok);
  assert.ok(result.logTail.includes('Fetching 50%'));
  assert.ok(result.logTail.every((line) => line.length <= 300));
  assert.ok(result.logTail.length <= 20);
  assert.equal(fs.existsSync(paths.markerFile), false);
});

test('run: a model check that reports ok:false (or exits non-zero) fails the install with its reason', async () => {
  const result = await runSttInstall(dataDir, {
    runCommand: createFakeRunner([], { checkStdout: '{"ok": false, "error": "RuntimeError: libsndfile cannot read OGG/Opus"}\n', checkExit: 1 }),
    detectFacts: createUvFacts,
    env: {},
    downloadPollIntervalMs: 10_000,
  });
  assert.ok(!result.ok);
  assert.match(result.error, /the model check failed: RuntimeError: libsndfile cannot read OGG\/Opus/);
  assert.equal(isGigaamInstalled(dataDir), false);

  const silent = await runSttInstall(dataDir, {
    runCommand: createFakeRunner([], { checkStdout: 'no json at all\n', checkExit: 0 }),
    detectFacts: createUvFacts,
    env: {},
    downloadPollIntervalMs: 10_000,
  });
  assert.ok(!silent.ok, 'an exit 0 without a report is not a pass');
});

test('run: no usable tool fails with the named error before anything is created', async () => {
  const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const result = await runSttInstall(dataDir, {
    runCommand: createFakeRunner(calls),
    detectFacts: (paths) => ({ uvPath: null, python3: null, paths }),
    env: {},
  });
  assert.ok(!result.ok && result.error === missingPythonToolError);
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(getSttPaths(dataDir).lockDir), false);
});

test('run: while another live install holds the lock this one stands aside and leaves its progress alone', async () => {
  const paths = getSttPaths(dataDir);
  fs.mkdirSync(paths.lockDir, { recursive: true });
  fs.writeFileSync(path.join(paths.lockDir, 'owner'), `${process.pid}\n`);
  fs.writeFileSync(paths.progressFile, '{"phase":"installingPackages","detail":"","bytesDownloaded":0}\n');
  const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const result = await runSttInstall(dataDir, { runCommand: createFakeRunner(calls), detectFacts: createUvFacts, env: {} });
  assert.deepEqual(result, { ok: false, reason: 'locked', error: 'another install is already running', logTail: [] });
  assert.equal(calls.length, 0);
  assert.equal(readSttInstallProgress(dataDir)?.phase, 'installingPackages');
  assert.equal(fs.existsSync(paths.lockDir), true, 'the other job keeps its lock');
});

test('run: a lock left by a dead process is replaced', async () => {
  const paths = getSttPaths(dataDir);
  fs.mkdirSync(paths.lockDir, { recursive: true });
  fs.writeFileSync(path.join(paths.lockDir, 'owner'), `${2 ** 22 - 1}\n`);
  const result = await runSttInstall(dataDir, {
    runCommand: createFakeRunner([]),
    detectFacts: createUvFacts,
    env: {},
    downloadPollIntervalMs: 10_000,
  });
  assert.deepEqual(result, { ok: true, wasAlreadyInstalled: false });
});

test('run: the model download is reported as it grows, and flips to checking once the files are all in', async () => {
  const paths = getSttPaths(dataDir);
  const reports: SttInstallProgress[] = [];
  const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  await runSttInstall(dataDir, {
    runCommand: createFakeRunner([], {
      onCheck: async () => {
        fs.mkdirSync(path.join(paths.hfHome, 'hub'), { recursive: true });
        fs.writeFileSync(path.join(paths.hfHome, 'hub', 'part.incomplete'), Buffer.alloc(50 * mebibyte));
        await pause(120);
        fs.writeFileSync(path.join(paths.hfHome, 'hub', 'rest.onnx'), Buffer.alloc(gigaamModelApproxBytes));
        await pause(120);
      },
    }),
    detectFacts: createUvFacts,
    env: {},
    onProgress: (progress) => reports.push(progress),
    downloadPollIntervalMs: 20,
  });
  const downloading = reports.filter((report) => report.phase === 'downloadingModel' && report.bytesDownloaded >= 50 * mebibyte);
  assert.ok(downloading.length > 0, 'the growing cache is reported');
  assert.equal(downloading[0].detail, '50/216 MB');
  const checking = reports.find((report) => report.phase === 'checking');
  assert.ok(checking && checking.bytesDownloaded >= gigaamModelApproxBytes, 'once everything is in, the rest is the check');
});

test('remove: deletes the venv, model cache and markers, but refuses while an install runs', () => {
  const paths = getSttPaths(dataDir);
  for (const target of [paths.venvDir, paths.hfHome, paths.uvCacheDir]) fs.mkdirSync(path.join(target, 'x'), { recursive: true });
  fs.writeFileSync(paths.markerFile, '{}');
  fs.writeFileSync(paths.installLog, 'log');
  fs.writeFileSync(path.join(paths.root, 'sidecar.json'), '{}');

  fs.mkdirSync(paths.lockDir);
  fs.writeFileSync(path.join(paths.lockDir, 'owner'), `${process.pid}\n`);
  assert.equal(removeSttInstall(dataDir), false);
  assert.equal(fs.existsSync(paths.venvDir), true, 'nothing is touched while an install runs');

  fs.rmSync(paths.lockDir, { recursive: true });
  assert.equal(removeSttInstall(dataDir), true);
  assert.deepEqual(fs.readdirSync(paths.root), ['sidecar.json'], 'the sidecar record is the owner module\'s, not the installer\'s');
});

test('the command runner captures stdout, appends both streams to the log and reports the exit code', async () => {
  const logFile = path.join(dataDir, 'run.log');
  const ok = await runSttCommand(process.execPath, ['-e', 'console.log("line one"); console.error("a warning"); console.log("{\\"ok\\": true}")'], {
    env: process.env,
    logFile,
    timeoutMs: 10_000,
  });
  assert.deepEqual(ok, { exitCode: 0, stdout: 'line one\n{"ok": true}\n' });
  const log = fs.readFileSync(logFile, 'utf8');
  assert.match(log, /\$ .*node.* -e /);
  assert.match(log, /line one/);
  assert.match(log, /a warning/);

  const failed = await runSttCommand(process.execPath, ['-e', 'process.exit(3)'], { env: process.env, logFile, timeoutMs: 10_000 });
  assert.equal(failed.exitCode, 3);
});

test('the command runner reports a missing binary as no exit code, with the reason in the log', async () => {
  const logFile = path.join(dataDir, 'run.log');
  const result = await runSttCommand(path.join(dataDir, 'no-such-binary'), [], { env: process.env, logFile, timeoutMs: 10_000 });
  assert.equal(result.exitCode, null);
  assert.match(fs.readFileSync(logFile, 'utf8'), /spawn failed: .*ENOENT/);
});

test('the command runner kills a step that outlives its timeout', { timeout: 10_000 }, async () => {
  const result = await runSttCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    env: process.env,
    logFile: path.join(dataDir, 'run.log'),
    timeoutMs: 200,
  });
  assert.equal(result.exitCode, null, 'killed by the signal, so no exit code');
});
