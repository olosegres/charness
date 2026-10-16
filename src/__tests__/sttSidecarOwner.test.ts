/**
 * @description The local engine's lifecycle against REAL processes: a fake sidecar (a Node script that follows
 * the Python one's contract — ready file, record, token, port 0, owner watchdog, idle exit) hosted outside the
 * test's process tree exactly as in production. Covers spawn on demand, one shared spawn for concurrent voices,
 * adoption, idle exit and crash then respawn, config changes, a foreign owner, the spawn-storm guard, stop,
 * the owner dying (a decoy the test creates and SIGKILLs) and a reload handing the process to a new worker.
 */

import { test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { checkIsProcessIdentityCurrent, getProcessIdentity, signalExternallyHostedProcess, type ExternalProcessIdentity } from '../installManager';
import { getSttPaths } from '../stt/sttInstall';
import { createEmptySttConfig, defaultSttTimeout, type ResolvedSttEngine, type SttConfigFile } from '../stt/sttSettings';
import {
  checkIsSidecarRestartNeeded,
  createDefaultSttSidecarOwnerDeps,
  createSttSidecarOwner,
  fetchSttSidecarHealth,
  getSttSidecarConfigHash,
  getSttSidecarTranscriptionEndpoint,
  resolveSttOwnerContext,
  sttOwnerPidEnvName,
  sttOwnerStartTokenEnvName,
  sttSidecarTokenEnvName,
  type SttOwnerContext,
  type SttSidecarEndpoint,
  type SttSidecarOwnerDeps,
} from '../stt/sttSidecarOwner';
import { transcribeWithEngines } from '../stt/transcribeChain';

const fixturesDir = path.join(__dirname, 'fixtures');
const fakeSidecarPath = path.join(fixturesDir, 'fakeSttSidecar.cjs');
const ownerWorkerPath = path.join(fixturesDir, 'sttOwnerWorker.ts');
const defaultSettings = { idleMinutes: 15, workers: 4 };
const fiveMinutesMs = 5 * 60 * 1000;
const processGoneBudgetMs = 6_000;

let dataDir = '';
let clockOffsetMs = 0;
let fakeArgs: string[] = [];
let startCalls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
let startedIdentities: ExternalProcessIdentity[] = [];
let logLines: string[] = [];
const decoys: ChildProcess[] = [];

const testOwner: SttOwnerContext = (() => {
  const identity = getProcessIdentity(process.pid);
  if (!identity) throw new Error('cannot read the test process start token');
  return { pid: identity.pid, startToken: identity.startToken };
})();

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-owner-'));
  clockOffsetMs = 0;
  fakeArgs = [];
  startCalls = [];
  startedIdentities = [];
  logLines = [];
});

afterEach(async () => {
  for (const identity of startedIdentities) signalExternallyHostedProcess(identity, 'SIGKILL');
  for (const decoy of decoys.splice(0)) {
    if (decoy.pid && decoy.exitCode === null) decoy.kill('SIGKILL');
  }
  await sleep(50);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createDeps(overrides: Partial<SttSidecarOwnerDeps> = {}): SttSidecarOwnerDeps {
  const base = createDefaultSttSidecarOwnerDeps(() => dataDir);
  return {
    ...base,
    getOwnerContext: () => testOwner,
    getLaunch: () => ({ command: process.execPath, args: [fakeSidecarPath, ...fakeArgs] }),
    startProcess: async (command, args, env) => {
      startCalls.push({ command, args, env });
      const identity = await base.startProcess(command, args, env);
      startedIdentities.push(identity);
      return identity;
    },
    nowMs: () => Date.now() + clockOffsetMs,
    readyTimeoutMs: 10_000,
    log: (line) => logLines.push(line),
    ...overrides,
  };
}

function readRecord(): { pid: number; port: number; token: string; configHash: string; ownerPid: number; ownerStartToken: string; startToken: string } {
  return JSON.parse(fs.readFileSync(path.join(getSttPaths(dataDir).root, 'sidecar.json'), 'utf8'));
}

function getRecordPath(): string {
  return path.join(getSttPaths(dataDir).root, 'sidecar.json');
}

async function waitUntilGone(identity: ExternalProcessIdentity, budgetMs = processGoneBudgetMs): Promise<boolean> {
  const deadlineMs = Date.now() + budgetMs;
  while (checkIsProcessIdentityCurrent(identity)) {
    if (Date.now() > deadlineMs) return false;
    await sleep(50);
  }
  return true;
}

function getRecordedIdentity(): ExternalProcessIdentity {
  const record = readRecord();
  return { pid: record.pid, startToken: record.startToken };
}

/** A scripted second engine: a local server that always answers with `text`. */
async function startStubEngine(text: string): Promise<{ engine: ResolvedSttEngine; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('stub engine has no port');
  const engine: ResolvedSttEngine = {
    id: 'u1',
    kind: 'url',
    name: 'url:stub',
    timeout: defaultSttTimeout,
    getEndpoint: () => Promise.resolve({ url: `http://127.0.0.1:${address.port}/v1/audio/transcriptions`, model: 'stub' }),
  };
  return { engine, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

function writeAudioFile(): string {
  const audioPath = path.join(dataDir, 'voice.ogg');
  fs.writeFileSync(audioPath, 'fake-ogg-bytes');
  return audioPath;
}

test('spawn on demand: no record → the first ensure starts a process, reads its port from the ready file, records it and returns port + token', async () => {
  const owner = createSttSidecarOwner(createDeps());
  assert.equal(startCalls.length, 0, 'nothing starts by itself');

  const endpoint = await owner.ensure(defaultSettings);
  assert.equal(startCalls.length, 1);
  assert.ok(endpoint.port > 0 && endpoint.token.length >= 32);

  const record = readRecord();
  assert.equal(record.port, endpoint.port);
  assert.equal(record.token, endpoint.token);
  assert.equal(record.ownerPid, testOwner.pid);
  assert.equal(record.ownerStartToken, testOwner.startToken);
  assert.equal(record.configHash, getSttSidecarConfigHash(defaultSettings));
  assert.equal(fs.statSync(getRecordPath()).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(getSttPaths(dataDir).root).filter((name) => name.startsWith('ready-')), [], 'the ready file is removed');
  assert.ok(logLines.some((line) => /^\[STT\] sidecar started pid \d+ port \d+ in \d+ms \(workers 4\)$/.test(line)), logLines.join('\n'));
  assert.equal((await fetchSttSidecarHealth(endpoint.port, endpoint.token, 2000))?.status, 'ok');
  assert.equal(await fetchSttSidecarHealth(endpoint.port, 'wrong-token', 2000), null);
  await owner.stop();
});

test('the process gets its secrets through the env, never its arguments, and the model cache offline', async () => {
  const owner = createSttSidecarOwner(createDeps());
  const endpoint = await owner.ensure({ idleMinutes: 5, workers: 8, threads: 3 });
  const call = startCalls[0];
  assert.ok(!call.args.some((argument) => argument.includes(endpoint.token)), 'the token must not show in `ps`');
  assert.equal(call.env[sttSidecarTokenEnvName], endpoint.token);
  assert.equal(call.env.HF_HUB_OFFLINE, '1');
  assert.equal(call.env.HF_HOME, getSttPaths(dataDir).hfHome);
  const flag = (name: string): string => call.args[call.args.indexOf(name) + 1];
  assert.equal(flag('--idle-minutes'), '5');
  assert.equal(flag('--workers'), '8');
  assert.equal(flag('--threads'), '3');
  assert.equal(flag('--owner-pid'), testOwner.pid.toString());
  assert.equal(flag('--owner-start-token'), testOwner.startToken);
  assert.equal(flag('--record-file'), getRecordPath());
  await owner.stop();
});

test('concurrent voices share ONE start: three parallel ensures during a 500 ms start-up spawn one process', async () => {
  fakeArgs = ['--ready-delay-ms', '500'];
  const owner = createSttSidecarOwner(createDeps());
  const endpoints = await Promise.all([owner.ensure(defaultSettings), owner.ensure(defaultSettings), owner.ensure(defaultSettings)]);
  assert.equal(startCalls.length, 1);
  assert.deepEqual(endpoints[1], endpoints[0]);
  assert.deepEqual(endpoints[2], endpoints[0]);
  await owner.stop();
});

test('adopt: a live matching record is reused — no second process, the same pid', async () => {
  const owner = createSttSidecarOwner(createDeps());
  const first = await owner.ensure(defaultSettings);
  const pid = readRecord().pid;

  const second = await owner.ensure(defaultSettings);
  assert.deepEqual(second, first);
  assert.equal(startCalls.length, 1);
  assert.equal(readRecord().pid, pid);

  // A new owner OBJECT (a reloaded worker) over the same record adopts too.
  const reloaded = createSttSidecarOwner(createDeps());
  assert.deepEqual(await reloaded.ensure(defaultSettings), first);
  assert.equal(startCalls.length, 1);
  await owner.stop();
});

test('idle exit → respawn: the process leaves and deletes its own record; the next ensure starts a new one', async () => {
  fakeArgs = ['--idle-seconds', '1'];
  const owner = createSttSidecarOwner(createDeps());
  await owner.ensure(defaultSettings);
  const firstIdentity = getRecordedIdentity();

  assert.ok(await waitUntilGone(firstIdentity), 'the idle sidecar exits');
  assert.equal(fs.existsSync(getRecordPath()), false, 'and deletes the record it owns');
  assert.deepEqual(await owner.getStatus(), { state: 'notRunning' });

  fakeArgs = [];
  await owner.ensure(defaultSettings);
  assert.equal(startCalls.length, 2);
  assert.notEqual(readRecord().pid, firstIdentity.pid);
  await owner.stop();
});

test('crash → the voice in flight falls back to the next engine, and the NEXT ensure respawns', async () => {
  fakeArgs = ['--crash-after-ms', '300'];
  const stub = await startStubEngine('from the second engine');
  try {
    const owner = createSttSidecarOwner(createDeps());
    const staleEndpoint: SttSidecarEndpoint = await owner.ensure(defaultSettings);
    const crashedIdentity = getRecordedIdentity();
    assert.ok(await waitUntilGone(crashedIdentity), 'the fake crashes');
    assert.equal(fs.existsSync(getRecordPath()), true, 'a crash leaves the record behind');

    const fallbacks: Array<{ from: string; to: string; error: string }> = [];
    const localEngine: ResolvedSttEngine = {
      id: 'g',
      kind: 'gigaam',
      name: 'gigaam',
      timeout: defaultSttTimeout,
      getEndpoint: () => Promise.resolve(getSttSidecarTranscriptionEndpoint(staleEndpoint)),
    };
    const result = await transcribeWithEngines(writeAudioFile(), [localEngine, stub.engine], {
      language: null,
      onFallback: (info) => fallbacks.push(info),
    });
    assert.deepEqual(result, { ok: true, text: 'from the second engine', engine: 'url:stub' });
    assert.equal(fallbacks.length, 1);
    assert.match(fallbacks[0].error, /ECONNREFUSED/);

    fakeArgs = [];
    const fresh = await owner.ensure(defaultSettings);
    assert.equal(startCalls.length, 2, 'the next voice starts a fresh process');
    assert.notEqual(fresh.port, staleEndpoint.port);
    assert.notEqual(readRecord().pid, crashedIdentity.pid);
    await owner.stop();
  } finally {
    await stub.close();
  }
});

test('a start that exits before it is ready, and one that is never ready, both reject and clean up', async () => {
  const owner = createSttSidecarOwner(createDeps({
    // Lives long enough to be hosted, then dies without ever writing the ready file.
    getLaunch: () => ({ command: process.execPath, args: ['-e', 'setTimeout(() => process.exit(3), 600)', '--'] }),
  }));
  await assert.rejects(() => owner.ensure(defaultSettings), /exited before it was ready/);
  assert.equal(fs.existsSync(getRecordPath()), false);

  fakeArgs = ['--never-ready'];
  const slowOwner = createSttSidecarOwner(createDeps({ readyTimeoutMs: 400 }));
  const startedAt = Date.now();
  await assert.rejects(() => slowOwner.ensure(defaultSettings), /was not ready in/);
  assert.ok(Date.now() - startedAt < 5_000);
  assert.ok(await waitUntilGone(startedIdentities[1]), 'the stuck process is killed');
  assert.equal(fs.existsSync(getRecordPath()), false);
  assert.deepEqual(fs.readdirSync(getSttPaths(dataDir).root).filter((name) => name.startsWith('ready-')), []);
});

test('a start whose record cannot be written is stopped and reported — no unfindable process is left running', async () => {
  const paths = getSttPaths(dataDir);
  fs.mkdirSync(path.join(paths.root, `sidecar.json.${process.pid}.tmp`), { recursive: true }); // the record's temp file cannot be created
  const owner = createSttSidecarOwner(createDeps());
  await assert.rejects(() => owner.ensure(defaultSettings), /record could not be written/);
  assert.equal(startCalls.length, 1);
  assert.ok(await waitUntilGone(startedIdentities[0], 2_000), 'the process that started is stopped');
  assert.equal(fs.existsSync(getRecordPath()), false);
});

test('a settings change that the process was started with stops it; the next ensure starts with the new hash', async () => {
  const owner = createSttSidecarOwner(createDeps());
  const config: SttConfigFile = { ...createEmptySttConfig(), engines: [{ id: 'g', kind: 'gigaam' }] };
  const first = await owner.ensure(defaultSettings);
  const firstIdentity = getRecordedIdentity();

  const harmless: SttConfigFile = { ...config, language: 'ru' };
  await owner.applySettingsChange(config, harmless);
  assert.ok(checkIsProcessIdentityCurrent(firstIdentity), 'a bot-side change leaves the process alone');

  const moreWorkers: SttConfigFile = { ...config, gigaam: { ...config.gigaam, workers: 8 } };
  await owner.applySettingsChange(config, moreWorkers);
  assert.ok(await waitUntilGone(firstIdentity, 1_000), 'more workers → the process is stopped');
  assert.equal(fs.existsSync(getRecordPath()), false);
  assert.equal(startCalls.length, 1, 'applying a change never spawns');

  const second = await owner.ensure(moreWorkers.gigaam);
  assert.equal(startCalls.length, 2);
  assert.equal(readRecord().configHash, getSttSidecarConfigHash(moreWorkers.gigaam));
  assert.notEqual(second.port, first.port);
  await owner.stop();
});

test('without applySettingsChange the config hash alone replaces a process started with other knobs', async () => {
  const owner = createSttSidecarOwner(createDeps());
  await owner.ensure(defaultSettings);
  const firstIdentity = getRecordedIdentity();
  await owner.ensure({ idleMinutes: 15, workers: 2 });
  assert.equal(startCalls.length, 2);
  assert.ok(await waitUntilGone(firstIdentity, 1_000), 'the old one is stopped, not leaked');
  await owner.stop();
});

test('which changes need a stop: the engine disabled or removed, idle minutes, workers, threads — not language or keys', () => {
  const base: SttConfigFile = { ...createEmptySttConfig(), engines: [{ id: 'g', kind: 'gigaam' }, { id: 'q1', kind: 'groq', apiKey: 'a'.repeat(12) }] };
  assert.equal(checkIsSidecarRestartNeeded(base, { ...base, language: 'ru' }), false);
  assert.equal(checkIsSidecarRestartNeeded(base, { ...base, engines: [base.engines[0], { id: 'q1', kind: 'groq', apiKey: 'b'.repeat(12) }] }), false);
  assert.equal(checkIsSidecarRestartNeeded(base, { ...base, gigaam: { ...base.gigaam, threads: 2 } }), false, 'the explicit default threads is no change');
  assert.equal(checkIsSidecarRestartNeeded(base, { ...base, gigaam: { ...base.gigaam, idleMinutes: 5 } }), true);
  assert.equal(checkIsSidecarRestartNeeded(base, { ...base, gigaam: { ...base.gigaam, workers: 1 } }), true);
  assert.equal(checkIsSidecarRestartNeeded(base, { ...base, gigaam: { ...base.gigaam, threads: 4 } }), true);
  assert.equal(checkIsSidecarRestartNeeded(base, { ...base, engines: [{ id: 'g', kind: 'gigaam', isDisabled: true }, base.engines[1]] }), true);
  assert.equal(checkIsSidecarRestartNeeded(base, { ...base, engines: [base.engines[1]] }), true);
  assert.equal(checkIsSidecarRestartNeeded({ ...base, engines: [base.engines[1]] }, base), false, 'adding it starts nothing by itself');
});

test('the config hash tells the knobs apart and ignores nothing the process was started with', () => {
  const hash = getSttSidecarConfigHash;
  assert.equal(hash({ idleMinutes: 15, workers: 4 }), hash({ idleMinutes: 15, workers: 4, threads: 2 }));
  assert.notEqual(hash({ idleMinutes: 15, workers: 4 }), hash({ idleMinutes: 5, workers: 4 }));
  assert.notEqual(hash({ idleMinutes: 15, workers: 4 }), hash({ idleMinutes: 15, workers: 8 }));
  assert.notEqual(hash({ idleMinutes: 15, workers: 4 }), hash({ idleMinutes: 15, workers: 4, threads: 3 }));
  assert.match(hash({ idleMinutes: 15, workers: 4 }), /^[0-9a-f]{16}$/);
});

test('a record of another owner is replaced: its process is stopped and a new one starts under the current owner', async () => {
  const otherOwner: SttOwnerContext = { pid: testOwner.pid, startToken: `${testOwner.startToken}-other` };
  const previous = createSttSidecarOwner(createDeps({ getOwnerContext: () => otherOwner }));
  await previous.ensure(defaultSettings);
  const foreignIdentity = getRecordedIdentity();
  assert.equal(readRecord().ownerStartToken, otherOwner.startToken);

  const current = createSttSidecarOwner(createDeps());
  await current.ensure(defaultSettings);
  assert.equal(startCalls.length, 2);
  assert.ok(await waitUntilGone(foreignIdentity, 1_000), 'the foreign process does not linger');
  assert.equal(readRecord().ownerStartToken, testOwner.startToken);
  await current.stop();
});

test('boot cleanup: a dead process\'s record and the leftover ready files go; a live process of another owner is stopped; a live matching one stays', async () => {
  const paths = getSttPaths(dataDir);
  fs.mkdirSync(paths.root, { recursive: true });
  fs.writeFileSync(path.join(paths.root, 'ready-abc123.json'), '{}');
  fs.writeFileSync(path.join(paths.root, 'keep.txt'), 'x');
  fs.writeFileSync(getRecordPath(), JSON.stringify({
    pid: 2 ** 22 - 1, startToken: '1', port: 1, token: 't', configHash: 'h', ownerPid: testOwner.pid, ownerStartToken: testOwner.startToken, startedAt: 'now',
  }));
  const owner = createSttSidecarOwner(createDeps());
  await owner.cleanupAtBoot();
  assert.equal(fs.existsSync(getRecordPath()), false);
  assert.deepEqual(fs.readdirSync(paths.root).sort(), ['keep.txt']);
  assert.ok(logLines.some((line) => line.includes('is gone')));

  await owner.ensure(defaultSettings);
  const liveIdentity = getRecordedIdentity();
  await owner.cleanupAtBoot();
  assert.ok(checkIsProcessIdentityCurrent(liveIdentity), 'a live process of the current owner is left for adoption');
  assert.equal(fs.existsSync(getRecordPath()), true);

  const newOwner = createSttSidecarOwner(createDeps({ getOwnerContext: () => ({ pid: testOwner.pid, startToken: 'someone-else' }) }));
  await newOwner.cleanupAtBoot();
  assert.ok(await waitUntilGone(liveIdentity, 1_000), 'a live process of another owner is stopped');
  assert.equal(fs.existsSync(getRecordPath()), false);
});

test('boot cleanup with no owner context stops a live record too, and a garbage record is dropped', async () => {
  const owner = createSttSidecarOwner(createDeps());
  await owner.ensure(defaultSettings);
  const identity = getRecordedIdentity();
  await createSttSidecarOwner(createDeps({ getOwnerContext: () => null })).cleanupAtBoot();
  assert.ok(await waitUntilGone(identity, 1_000));

  fs.writeFileSync(getRecordPath(), 'not json');
  await owner.cleanupAtBoot();
  assert.equal(fs.existsSync(getRecordPath()), false);
});

test('spawn-storm guard: three failed starts mark the engine unhealthy for five minutes; a fourth ensure is refused without a spawn', async () => {
  fakeArgs = ['--never-ready'];
  const owner = createSttSidecarOwner(createDeps({ readyTimeoutMs: 300 }));
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.equal(owner.checkIsUnhealthy(), false, `before failure ${attempt}`);
    await assert.rejects(() => owner.ensure(defaultSettings), /was not ready in/);
  }
  assert.equal(owner.checkIsUnhealthy(), true);
  assert.equal(startCalls.length, 3);
  assert.ok(logLines.some((line) => /^\[STT\] gigaam marked unhealthy until \d\d:\d\d/.test(line)));
  const status = await owner.getStatus();
  assert.equal(status.state, 'unhealthy');

  const startedAt = Date.now();
  await assert.rejects(() => owner.ensure(defaultSettings), /gigaam is unhealthy until \d\d:\d\d/);
  assert.equal(startCalls.length, 3, 'no fourth spawn');
  assert.ok(Date.now() - startedAt < 200, 'refused at once');

  clockOffsetMs += fiveMinutesMs + 1_000;
  assert.equal(owner.checkIsUnhealthy(), false, 'five minutes later a spawn is allowed again');
  fakeArgs = [];
  await owner.ensure(defaultSettings);
  assert.equal(startCalls.length, 4);
  await owner.stop();
});

test('spawn-storm guard: "Try again now" lifts it, and a successful start resets the count of consecutive failures', async () => {
  fakeArgs = ['--never-ready'];
  const owner = createSttSidecarOwner(createDeps({ readyTimeoutMs: 300 }));
  for (let attempt = 0; attempt < 3; attempt++) await assert.rejects(() => owner.ensure(defaultSettings));
  assert.equal(owner.checkIsUnhealthy(), true);
  owner.resetSpawnGuard();
  assert.equal(owner.checkIsUnhealthy(), false);
  assert.notEqual((await owner.getStatus()).state, 'unhealthy');

  // two failures, a success, two more failures: never three IN A ROW
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(() => owner.ensure(defaultSettings));
  fakeArgs = [];
  await owner.ensure(defaultSettings);
  await owner.stop();
  fakeArgs = ['--never-ready'];
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(() => owner.ensure(defaultSettings));
  assert.equal(owner.checkIsUnhealthy(), false);
  await assert.rejects(() => owner.ensure(defaultSettings));
  assert.equal(owner.checkIsUnhealthy(), true, 'the third failure after the success trips it');
});

test('failures older than ten minutes do not count toward the storm', async () => {
  fakeArgs = ['--never-ready'];
  const owner = createSttSidecarOwner(createDeps({ readyTimeoutMs: 300 }));
  await assert.rejects(() => owner.ensure(defaultSettings));
  await assert.rejects(() => owner.ensure(defaultSettings));
  clockOffsetMs += 11 * 60 * 1000;
  await assert.rejects(() => owner.ensure(defaultSettings));
  assert.equal(owner.checkIsUnhealthy(), false);
});

test('stop: the process is gone and the record removed; stopping with nothing running is a no-op', async () => {
  const owner = createSttSidecarOwner(createDeps());
  await owner.stop();
  assert.equal(startCalls.length, 0);

  await owner.ensure(defaultSettings);
  const identity = getRecordedIdentity();
  assert.equal((await owner.getStatus()).state, 'running');
  await owner.stop();
  assert.equal(checkIsProcessIdentityCurrent(identity), false);
  assert.equal(fs.existsSync(getRecordPath()), false);
  assert.deepEqual(await owner.getStatus(), { state: 'notRunning' });
  await owner.stop();
});

test('stop is bounded: a process that ignores SIGTERM is killed within about three seconds', { timeout: 15_000 }, async () => {
  fakeArgs = ['--ignore-sigterm'];
  const owner = createSttSidecarOwner(createDeps());
  await owner.ensure(defaultSettings);
  const identity = getRecordedIdentity();
  const startedAt = Date.now();
  await owner.stop();
  const tookMs = Date.now() - startedAt;
  assert.equal(checkIsProcessIdentityCurrent(identity), false);
  assert.ok(tookMs >= 2_000 && tookMs < 4_500, `took ${tookMs} ms`);
});

test('no owner context → ensure refuses without starting anything; status reads the process, never a record alone', async () => {
  const owner = createSttSidecarOwner(createDeps({ getOwnerContext: () => null }));
  await assert.rejects(() => owner.ensure(defaultSettings), /no owner process/);
  assert.equal(startCalls.length, 0);
  assert.deepEqual(await owner.getStatus(), { state: 'notRunning' });
});

test('status: running reports the sidecar\'s busy count; a record whose process answers nothing is "not running"', async () => {
  const owner = createSttSidecarOwner(createDeps());
  await owner.ensure(defaultSettings);
  assert.deepEqual(await owner.getStatus(), { state: 'running', busyRequests: 0 });
  const record = readRecord();
  fs.writeFileSync(getRecordPath(), JSON.stringify({ ...record, token: 'a-token-the-process-does-not-know' }));
  assert.deepEqual(await owner.getStatus(), { state: 'notRunning' });
  fs.writeFileSync(getRecordPath(), JSON.stringify(record));
  await owner.stop();
});

test('owner context: a hot worker takes its supervisor\'s from the env, a plain bot is its own owner, anything else is none', () => {
  const hotEnv = { CHARNESS_HOT_RELOAD: '1', [sttOwnerPidEnvName]: '4242', [sttOwnerStartTokenEnvName]: '9000' };
  assert.deepEqual(resolveSttOwnerContext(hotEnv, 111, () => 'own'), { pid: 4242, startToken: '9000' });
  assert.equal(resolveSttOwnerContext({ CHARNESS_HOT_RELOAD: '1' }, 111, () => 'own'), null, 'a supervisor that predates the sidecar exports nothing');
  assert.equal(resolveSttOwnerContext({ ...hotEnv, [sttOwnerPidEnvName]: 'x' }, 111, () => 'own'), null);
  assert.equal(resolveSttOwnerContext({ ...hotEnv, [sttOwnerStartTokenEnvName]: '' }, 111, () => 'own'), null);
  assert.deepEqual(resolveSttOwnerContext({}, 111, () => 'own'), { pid: 111, startToken: 'own' });
  assert.equal(resolveSttOwnerContext({}, 111, () => null), null);
  assert.deepEqual(resolveSttOwnerContext({ [sttOwnerPidEnvName]: '4242', [sttOwnerStartTokenEnvName]: '9000' }, 111, () => 'own'), { pid: 111, startToken: 'own' }, 'a plain bot ignores a stray handshake');
});

/** Run the owner-worker fixture in its own process and read its one JSON line. */
function runOwnerWorker(owner: string, mode: 'ensure' | 'ensure-and-stay'): { child: ChildProcess; endpoint: Promise<SttSidecarEndpoint> } {
  const child = spawn(process.execPath, ['--import', 'tsx', ownerWorkerPath, dataDir, owner, mode], { stdio: ['ignore', 'pipe', 'pipe'] });
  decoys.push(child);
  const endpoint = new Promise<SttSidecarEndpoint>((resolve, reject) => {
    let output = '';
    let errors = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const line = output.split('\n').find((candidate) => candidate.startsWith('{'));
      if (line) resolve(JSON.parse(line));
    });
    child.stderr?.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
    child.once('exit', (code) => reject(new Error(`the owner worker exited (${code}) before it printed an endpoint: ${errors}`)));
  });
  return { child, endpoint };
}

test('owner death: SIGKILL of the owner (a decoy this test starts) takes the sidecar down within four seconds', { timeout: 60_000 }, async () => {
  const { child: decoy, endpoint } = runOwnerWorker('self', 'ensure-and-stay');
  const sidecarEndpoint = await endpoint;
  const identity = getRecordedIdentity();
  assert.ok(checkIsProcessIdentityCurrent(identity));
  assert.equal(readRecord().ownerPid, decoy.pid);
  assert.equal((await fetchSttSidecarHealth(sidecarEndpoint.port, sidecarEndpoint.token, 2000))?.status, 'ok');
  startedIdentities.push(identity);

  decoy.kill('SIGKILL');
  const killedAt = Date.now();
  assert.ok(await waitUntilGone(identity, 4_000), `the sidecar outlived its owner by ${Date.now() - killedAt} ms`);
  assert.equal(fs.existsSync(getRecordPath()), false, 'it removes its own record on the way out');
});

test('reload: a second worker process over the same record and owner adopts the first one\'s sidecar — same pid', { timeout: 60_000 }, async () => {
  const ownerArg = `${testOwner.pid}:${testOwner.startToken}`;
  const first = runOwnerWorker(ownerArg, 'ensure');
  const firstEndpoint = await first.endpoint;
  const identity = getRecordedIdentity();
  startedIdentities.push(identity);
  await new Promise((resolve) => first.child.once('exit', resolve));
  assert.ok(checkIsProcessIdentityCurrent(identity), 'the sidecar outlives the worker that started it');

  const second = runOwnerWorker(ownerArg, 'ensure');
  const secondEndpoint = await second.endpoint;
  await new Promise((resolve) => second.child.once('exit', resolve));
  assert.deepEqual(secondEndpoint, firstEndpoint, 'same port and token: nothing was spawned');
  assert.equal(readRecord().pid, identity.pid);
  assert.ok(checkIsProcessIdentityCurrent(identity));
});
