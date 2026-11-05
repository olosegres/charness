/**
 * @description The local engine's lifecycle against REAL processes: a fake sidecar (a Node script that follows
 * the Python one's contract — ready file, record, token, port 0, owner watchdog, idle exit) hosted outside the
 * test's process tree exactly as in production. Covers spawn on demand, one shared spawn for concurrent voices,
 * adoption, idle exit and crash then respawn, config changes, a foreign owner, the spawn-storm guard, stop,
 * the owner dying (a decoy the test creates and SIGKILLs) and a reload handing the process to a new worker.
 *
 * The last block runs the same owner over a FAKE world — no processes, a clock that only the owner's own sleeps advance — to
 * pin how long a start is waited for: a model that loads for tens of seconds on a busy box is waited for, a dead process
 * fails at once, a wedged one at the ceiling counted from its own start.
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
import { transcribeWithEngines, warmUpFirstEngine } from '../stt/transcribeChain';

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

/** A start that never gets ready fails fast; a start that must succeed gets the time a loaded box needs to spawn a process. */
const neverReadyCeilingMs = 300;
const startedCeilingMs = 10_000;

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
    startCeilingMs: startedCeilingMs,
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
  const slowOwner = createSttSidecarOwner(createDeps({ startCeilingMs: 400 }));
  const startedAt = Date.now();
  await assert.rejects(() => slowOwner.ensure(defaultSettings), /still loading its model after/);
  assert.ok(Date.now() - startedAt < 5_000);
  assert.ok(await waitUntilGone(startedIdentities[1]), 'the stuck process is killed');
  assert.equal(fs.existsSync(getRecordPath()), false);
  assert.deepEqual(fs.readdirSync(getSttPaths(dataDir).root).filter((name) => name.startsWith('ready-')), []);
});

test('a sidecar that cannot record itself exits before any ready file, which is a failed start; one that says "ready" without a record is stopped', async () => {
  fakeArgs = ['--fail-to-record'];
  const owner = createSttSidecarOwner(createDeps());
  await assert.rejects(() => owner.ensure(defaultSettings), /exited before it was ready/);
  assert.equal(fs.existsSync(getRecordPath()), false);

  fakeArgs = ['--skip-record'];
  await assert.rejects(() => owner.ensure(defaultSettings), /did not record itself/);
  assert.ok(await waitUntilGone(startedIdentities[1], 2_000), 'a process nobody can find again is stopped, not left idling');
});

test('the sidecar records itself: its own pid and start token, the token it was given, the config hash and the owner it was started for', async () => {
  const owner = createSttSidecarOwner(createDeps());
  const endpoint = await owner.ensure(defaultSettings);
  const record = readRecord();
  assert.equal(record.pid, startedIdentities[0].pid);
  assert.equal(record.startToken, startedIdentities[0].startToken);
  assert.equal(record.token, endpoint.token);
  assert.equal(record.configHash, getSttSidecarConfigHash(defaultSettings));
  assert.equal(record.ownerPid, testOwner.pid);
  assert.equal(record.ownerStartToken, testOwner.startToken);
  const flag = (name: string): string => startCalls[0].args[startCalls[0].args.indexOf(name) + 1];
  assert.equal(flag('--config-hash'), record.configHash, 'the bot hands the hash over; the sidecar records it as it is');
  await owner.stop();
});

test('a busy sidecar that answers /health late is adopted, not killed and replaced', async () => {
  fakeArgs = ['--health-delay-ms', '700'];
  const owner = createSttSidecarOwner(createDeps({ adoptHealthTimeoutsMs: [150, 3_000] }));
  const first = await owner.ensure(defaultSettings);
  const identity = getRecordedIdentity();

  const second = await owner.ensure(defaultSettings);
  assert.deepEqual(second, first);
  assert.equal(startCalls.length, 1, 'no second process: the late answer was waited for');
  assert.ok(checkIsProcessIdentityCurrent(identity));
  await owner.stop();
});

test('a live matching sidecar that answers nothing is used anyway twice, and replaced only when it stays silent a third time', async () => {
  fakeArgs = ['--health-hang'];
  const owner = createSttSidecarOwner(createDeps({ adoptHealthTimeoutsMs: [100, 200] }));
  const first = await owner.ensure(defaultSettings);
  const wedged = getRecordedIdentity();

  assert.deepEqual(await owner.ensure(defaultSettings), first, 'silent once: still used');
  assert.deepEqual(await owner.ensure(defaultSettings), first, 'silent twice: still used');
  assert.equal(startCalls.length, 1);
  assert.ok(logLines.some((line) => line.includes('did not answer /health (1/3); using it anyway')));
  assert.ok(checkIsProcessIdentityCurrent(wedged), 'nothing was killed');

  fakeArgs = [];
  const replacement = await owner.ensure(defaultSettings);
  assert.equal(startCalls.length, 2, 'the third silence replaces it');
  assert.notEqual(replacement.port, first.port);
  assert.ok(await waitUntilGone(wedged, 4_000), 'the wedged one is stopped, not leaked');
  assert.ok(logLines.some((line) => line.includes('stayed silent 3 times in a row; replacing it')));
  await owner.stop();
});

test('a dead process, another owner and another config are still replaced at once — only silence is forgiven', async () => {
  fakeArgs = ['--health-hang'];
  const owner = createSttSidecarOwner(createDeps({ adoptHealthTimeoutsMs: [100, 200] }));
  await owner.ensure(defaultSettings);
  const silent = getRecordedIdentity();
  fakeArgs = [];
  await owner.ensure({ idleMinutes: 15, workers: 2 });
  assert.equal(startCalls.length, 2, 'a changed config does not wait for the silent one');
  assert.ok(await waitUntilGone(silent, 4_000));
  await owner.stop();
});

test('status: a live sidecar too busy to answer /health is "running" with no count, not "not running"', async () => {
  fakeArgs = ['--health-hang'];
  const owner = createSttSidecarOwner(createDeps());
  await owner.ensure(defaultSettings);
  assert.deepEqual(await owner.getStatus(), { state: 'running' });
  await owner.stop();
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

/** A second, REAL owner: a live process the test started, so a sidecar owned by it keeps running (its owner watchdog finds the owner alive). */
function startOtherOwner(): SttOwnerContext {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  decoys.push(child);
  const identity = child.pid === undefined ? null : getProcessIdentity(child.pid);
  if (!identity) throw new Error('cannot read the second owner\'s start token');
  return { pid: identity.pid, startToken: identity.startToken };
}

test('a record of another owner is replaced: its process is stopped and a new one starts under the current owner', async () => {
  // Not the test process with a forged start token: that sidecar's watchdog would find its owner "gone" within
  // 100 ms and end itself, racing the very start this test makes (a slow box lost the race before the record was read).
  const otherOwner = startOtherOwner();
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
  const deps = createDeps({ startCeilingMs: neverReadyCeilingMs });
  const owner = createSttSidecarOwner(deps);
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.equal(owner.checkIsUnhealthy(), false, `before failure ${attempt}`);
    await assert.rejects(() => owner.ensure(defaultSettings), /still loading its model after/);
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
  deps.startCeilingMs = startedCeilingMs;
  await owner.ensure(defaultSettings);
  assert.equal(startCalls.length, 4);
  await owner.stop();
});

test('spawn-storm guard: "Try again now" lifts it, and a successful start resets the count of consecutive failures', async () => {
  fakeArgs = ['--never-ready'];
  const deps = createDeps({ startCeilingMs: neverReadyCeilingMs });
  const owner = createSttSidecarOwner(deps);
  for (let attempt = 0; attempt < 3; attempt++) await assert.rejects(() => owner.ensure(defaultSettings));
  assert.equal(owner.checkIsUnhealthy(), true);
  owner.resetSpawnGuard();
  assert.equal(owner.checkIsUnhealthy(), false);
  assert.notEqual((await owner.getStatus()).state, 'unhealthy');

  // two failures, a success, two more failures: never three IN A ROW
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(() => owner.ensure(defaultSettings));
  fakeArgs = [];
  deps.startCeilingMs = startedCeilingMs;
  await owner.ensure(defaultSettings);
  await owner.stop();
  fakeArgs = ['--never-ready'];
  deps.startCeilingMs = neverReadyCeilingMs;
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(() => owner.ensure(defaultSettings));
  assert.equal(owner.checkIsUnhealthy(), false);
  await assert.rejects(() => owner.ensure(defaultSettings));
  assert.equal(owner.checkIsUnhealthy(), true, 'the third failure after the success trips it');
});

test('failures older than ten minutes do not count toward the storm', async () => {
  fakeArgs = ['--never-ready'];
  const owner = createSttSidecarOwner(createDeps({ startCeilingMs: neverReadyCeilingMs }));
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

test('status: running reports the sidecar\'s busy count; a record the process does not answer for is "running" without a count', async () => {
  const owner = createSttSidecarOwner(createDeps());
  await owner.ensure(defaultSettings);
  assert.deepEqual(await owner.getStatus(), { state: 'running', busyRequests: 0 });
  const record = readRecord();
  fs.writeFileSync(getRecordPath(), JSON.stringify({ ...record, token: 'a-token-the-process-does-not-know' }));
  assert.deepEqual(await owner.getStatus(), { state: 'running' }, 'alive but not answering: busy, not gone');
  fs.writeFileSync(getRecordPath(), JSON.stringify(record));
  await owner.stop();
  assert.deepEqual(await owner.getStatus(), { state: 'notRunning' });
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

/** Run the owner-worker fixture in its own process: `spawned` is the sidecar pid it announces, `endpoint` its answer. */
function runOwnerWorker(
  owner: string,
  mode: 'ensure' | 'ensure-and-stay',
  fakeArgs: string[] = [],
): { child: ChildProcess; endpoint: Promise<SttSidecarEndpoint>; spawned: Promise<number>; hasSpawned: () => boolean } {
  const child = spawn(process.execPath, ['--import', 'tsx', ownerWorkerPath, dataDir, owner, mode, JSON.stringify(fakeArgs)], { stdio: ['ignore', 'pipe', 'pipe'] });
  decoys.push(child);
  let announceSpawn: (pid: number) => void = () => {};
  let hasSpawnedProcess = false;
  const spawned = new Promise<number>((resolve) => { announceSpawn = (pid) => { hasSpawnedProcess = true; resolve(pid); }; });
  const endpoint = new Promise<SttSidecarEndpoint>((resolve, reject) => {
    let output = '';
    let errors = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const spawnedLine = output.split('\n').find((candidate) => candidate.startsWith('SPAWNED '));
      if (spawnedLine) announceSpawn(Number(spawnedLine.slice('SPAWNED '.length)));
      const endpointLine = output.split('\n').find((candidate) => candidate.startsWith('ENDPOINT '));
      if (endpointLine) resolve(JSON.parse(endpointLine.slice('ENDPOINT '.length)));
    });
    child.stderr?.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
    child.once('exit', (code) => reject(new Error(`the owner worker exited (${code}) before it printed an endpoint: ${errors}`)));
  });
  endpoint.catch(() => {}); // a worker killed on purpose rejects; the test that kills it does not read it
  return { child, endpoint, spawned, hasSpawned: () => hasSpawnedProcess };
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

test('a worker replaced while its sidecar is still LOADING its model leaves a process the next worker waits for and ADOPTS — no orphan, no second sidecar', { timeout: 60_000 }, async () => {
  const ownerArg = `${testOwner.pid}:${testOwner.startToken}`;
  const first = runOwnerWorker(ownerArg, 'ensure', ['--ready-delay-ms', '1500']);
  const sidecarPid = await first.spawned;
  await getCharnessWait(() => fs.existsSync(getRecordPath()), 10_000, 'the sidecar to claim its record');
  assert.equal(readRecord().pid, sidecarPid);
  assert.equal(readRecord().port, 0, 'claimed, but nothing listens yet: the model is still loading');
  startedIdentities.push({ pid: sidecarPid, startToken: readRecord().startToken });
  first.child.kill('SIGKILL'); // the hot reload: the worker is gone before the sidecar listens

  const second = runOwnerWorker(ownerArg, 'ensure'); // a voice reaches the new worker inside the loading window
  const endpoint = await second.endpoint;
  const record = readRecord();
  assert.notEqual(record.port, 0, 'the record was completed with the port');
  assert.deepEqual(endpoint, { port: record.port, token: record.token }, 'adopted from the record the sidecar wrote');
  assert.equal(record.pid, sidecarPid);
  assert.equal(second.hasSpawned(), false, 'the new worker started nothing');
  assert.ok(checkIsProcessIdentityCurrent({ pid: sidecarPid, startToken: record.startToken }));
});

/** A sidecar the test starts the way an EARLIER worker would have: same owner and config, a token of its own. */
async function startEarlierSidecar(extraArgs: string[], token = 'earlier-token'): Promise<ExternalProcessIdentity> {
  const paths = getSttPaths(dataDir);
  fs.mkdirSync(paths.root, { recursive: true });
  const identity = await createDefaultSttSidecarOwnerDeps(() => dataDir).startProcess(
    process.execPath,
    [
      fakeSidecarPath,
      '--ready-file', path.join(paths.root, `ready-earlier-${Date.now()}.json`),
      '--record-file', getRecordPath(),
      '--owner-pid', testOwner.pid.toString(),
      '--owner-start-token', testOwner.startToken,
      '--config-hash', getSttSidecarConfigHash(defaultSettings),
      '--workers', defaultSettings.workers.toString(),
      ...extraArgs,
    ],
    { PATH: process.env.PATH ?? '', [sttSidecarTokenEnvName]: token },
  );
  startedIdentities.push(identity);
  return identity;
}

test('a voice that asks while the sidecar loads its model waits for the port instead of starting a second sidecar; /stt does not call it running yet', async () => {
  const earlier = await startEarlierSidecar(['--ready-delay-ms', '1200']);
  await getCharnessWait(() => fs.existsSync(getRecordPath()), 10_000, 'the earlier sidecar to claim its record');
  assert.equal(readRecord().port, 0);

  const owner = createSttSidecarOwner(createDeps());
  assert.deepEqual(await owner.getStatus(), { state: 'notRunning' }, 'nothing listens yet');
  const endpoint = await owner.ensure(defaultSettings);
  assert.equal(startCalls.length, 0, 'no second process');
  assert.deepEqual(endpoint, { port: readRecord().port, token: 'earlier-token' });
  assert.equal(readRecord().pid, earlier.pid);
  assert.ok(logLines.some((line) => line.includes('is still loading the model')), logLines.join('\n'));
  assert.equal((await owner.getStatus()).state, 'running');
  await owner.stop();
});

test('two starts at once: the later one finds the record claimed, leaves, and its ensure uses the earlier sidecar — not a failure, however often it happens', { timeout: 60_000 }, async () => {
  const owner = createSttSidecarOwner(createDeps());
  for (let round = 1; round <= 3; round++) {
    // OUR spawn claims only after the earlier start holds the record — gated on a file, not a delay: under a loaded
    // suite the earlier one's start alone outlasted a 500 ms delay, ours claimed first and won (a fine outcome, but
    // not the one this test is about).
    const claimGate = path.join(dataDir, `claim-gate-${round}`);
    fakeArgs = ['--claim-after-file', claimGate];
    const identitiesBefore = startedIdentities.length;
    const ensuring = owner.ensure(defaultSettings);
    await getCharnessWait(() => startedIdentities.length > identitiesBefore, 10_000, 'our spawn');
    const ours = startedIdentities[identitiesBefore];
    const earlier = await startEarlierSidecar(['--ready-delay-ms', '900'], `earlier-token-${round}`);
    await getCharnessWait(() => fs.existsSync(getRecordPath()) && readRecord().pid === earlier.pid, 10_000, 'the earlier start to claim the record');
    fs.writeFileSync(claimGate, '');

    const endpoint = await ensuring;
    assert.equal(endpoint.token, `earlier-token-${round}`, 'the earlier start won');
    assert.equal(readRecord().pid, earlier.pid);
    assert.ok(await waitUntilGone(ours, 3_000), 'our own start left');
    assert.ok(checkIsProcessIdentityCurrent(earlier), 'and the earlier one keeps running');
    assert.equal(owner.checkIsUnhealthy(), false, `round ${round}: a lost claim is not a failed start`);
    await owner.stop();
  }
  assert.ok(logLines.some((line) => line.includes('found another start already running')), logLines.join('\n'));
  assert.equal(fs.existsSync(getRecordPath()), false);
});

test('a start that claimed the record and never listens fails the voice at its ceiling — stopped, no respawn in the same request; the next voice starts afresh. One that dies during the wait is replaced at once', { timeout: 60_000 }, async () => {
  const wedged = await startEarlierSidecar(['--never-ready']);
  await getCharnessWait(() => fs.existsSync(getRecordPath()), 10_000, 'the wedged sidecar to claim its record');
  const owner = createSttSidecarOwner(createDeps({ startCeilingMs: neverReadyCeilingMs }));
  await assert.rejects(() => owner.ensure(defaultSettings), /still loading its model after/);
  assert.equal(startCalls.length, 0, 'one deadline per request: nothing was started for the same voice');
  assert.ok(await waitUntilGone(wedged, 3_000), 'the wedged one was stopped');
  assert.equal(fs.existsSync(getRecordPath()), false);
  assert.ok(logLines.some((line) => line.includes('has been loading the model for more than')), logLines.join('\n'));

  const next = createSttSidecarOwner(createDeps({ startCeilingMs: startedCeilingMs }));
  const endpoint = await next.ensure(defaultSettings);
  assert.equal(startCalls.length, 1, 'the next voice starts a fresh one');
  assert.equal(readRecord().port, endpoint.port);
  await next.stop();

  const dying = await startEarlierSidecar(['--never-ready']);
  await getCharnessWait(() => fs.existsSync(getRecordPath()), 10_000, 'the dying sidecar to claim its record');
  const patientOwner = createSttSidecarOwner(createDeps());
  const ensuring = patientOwner.ensure(defaultSettings);
  await sleep(300);
  signalExternallyHostedProcess(dying, 'SIGKILL');
  const replacement = await ensuring;
  assert.equal(startCalls.length, 2, 'a start that died while we waited is replaced, not waited for');
  assert.equal(readRecord().port, replacement.port);
  await patientOwner.stop();
});

// ── how long a start is waited for (a fake world: no processes, a clock the owner's own sleeps advance) ─────────────────

const fakeLoadNeverMs = Number.POSITIVE_INFINITY;
const fakeDefaultLoadMs = 2_000;
const fakeFirstPid = 4_000;
const fakePortBase = 40_000;
const fakeCeilingMs = 120_000;
const fakeEpochMs = Date.UTC(2026, 10, 5, 9, 48, 0);

interface FakeLoadingSidecar {
  pid: number;
  startToken: string;
  token: string;
  recordFile: string;
  readyFile: string | null;
  configHash: string;
  startedAt: string;
  readyAtMs: number;
}

/**
 * The owner over a world of its own: a sidecar "lives" as long as the test says (`killAll`), claims the record when it is
 * started and completes it (and writes its ready file) `loadMs` of fake time later. Time passes only inside the owner's
 * `sleep`, so a two-minute wait takes no wall time and every deadline is exact.
 */
function createFakeWorld(overrides: Partial<SttSidecarOwnerDeps> = {}) {
  let nowMs = fakeEpochMs;
  let nextPid = fakeFirstPid;
  let spawnCount = 0;
  const alive = new Set<number>();
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const loading: FakeLoadingSidecar[] = [];
  const scheduled: Array<{ atMs: number; action: () => void }> = [];
  const worldLogLines: string[] = [];
  const state = { loadMsOfNextStart: fakeDefaultLoadMs };
  let holdAtMs: number | null = null;
  let holdUntilReleased: Promise<void> = Promise.resolve();

  function writeRecord(sidecar: FakeLoadingSidecar, port: number): void {
    fs.writeFileSync(sidecar.recordFile, JSON.stringify({
      pid: sidecar.pid,
      startToken: sidecar.startToken,
      port,
      token: sidecar.token,
      configHash: sidecar.configHash,
      ownerPid: testOwner.pid,
      ownerStartToken: testOwner.startToken,
      startedAt: sidecar.startedAt,
    }));
  }

  function startSidecar(sidecar: Omit<FakeLoadingSidecar, 'pid' | 'startToken' | 'startedAt'>, startedAgoMs: number, startedAt?: string): FakeLoadingSidecar {
    const pid = nextPid++;
    const started: FakeLoadingSidecar = { ...sidecar, pid, startToken: `fake-start-${pid}`, startedAt: startedAt ?? new Date(nowMs - startedAgoMs).toISOString() };
    alive.add(pid);
    fs.mkdirSync(path.dirname(started.recordFile), { recursive: true });
    writeRecord(started, 0); // claimed before the model loads, like the real one
    loading.push(started);
    return started;
  }

  function runDue(): void {
    for (const entry of scheduled.filter((candidate) => candidate.atMs <= nowMs)) {
      scheduled.splice(scheduled.indexOf(entry), 1);
      entry.action();
    }
    for (const sidecar of loading.filter((candidate) => candidate.readyAtMs <= nowMs)) {
      loading.splice(loading.indexOf(sidecar), 1);
      if (!alive.has(sidecar.pid)) continue;
      const port = fakePortBase + sidecar.pid;
      writeRecord(sidecar, port);
      if (sidecar.readyFile) fs.writeFileSync(sidecar.readyFile, JSON.stringify({ pid: sidecar.pid, port, version: 'fake' }));
    }
  }

  const base = createDefaultSttSidecarOwnerDeps(() => dataDir);
  const deps: SttSidecarOwnerDeps = {
    ...base,
    getOwnerContext: () => testOwner,
    getLaunch: () => ({ command: 'fake-sidecar', args: [] }),
    getBaseEnv: () => ({}),
    startProcess: async (_command, args, env) => {
      spawnCount++;
      const flag = (name: string): string => args[args.indexOf(name) + 1];
      const started = startSidecar({
        token: env[sttSidecarTokenEnvName] ?? '',
        recordFile: flag('--record-file'),
        readyFile: flag('--ready-file'),
        configHash: flag('--config-hash'),
        readyAtMs: nowMs + state.loadMsOfNextStart,
      }, 0);
      return { pid: started.pid, startToken: started.startToken };
    },
    checkIsIdentityCurrent: (identity) => alive.has(identity.pid),
    signalProcess: (identity, signal) => {
      signals.push({ pid: identity.pid, signal });
      alive.delete(identity.pid);
      return true;
    },
    fetchHealth: async () => ({ status: 'ok', busyRequests: 0 }),
    nowMs: () => nowMs,
    sleep: async (ms) => {
      nowMs += ms;
      runDue();
      // Yield to the event loop: a wait that never ends (a regression) must be cut by the runner's timeout, not spin forever.
      await new Promise<void>((resolve) => setImmediate(resolve));
      // A start HELD at a moment of its load: the owner's wait stops there until the test lets it go (wall time passes).
      if (holdAtMs !== null && nowMs >= holdAtMs) await holdUntilReleased;
    },
    startCeilingMs: fakeCeilingMs,
    log: (line) => worldLogLines.push(line),
    ...overrides,
  };

  return {
    deps,
    state,
    signals,
    logLines: worldLogLines,
    getSpawnCount: () => spawnCount,
    getElapsedMs: () => nowMs - fakeEpochMs,
    getAliveCount: () => alive.size,
    /** Run `action` when `afterMs` of fake time have passed (inside the owner's next sleep). */
    schedule: (afterMs: number, action: () => void) => { scheduled.push({ atMs: nowMs + afterMs, action }); },
    killAll: () => alive.clear(),
    /** The owner's sleeps stop once `afterMs` of fake time have passed, until `release()` — the start is alive and loading meanwhile. */
    hold: (afterMs: number): { release: () => void } => {
      holdAtMs = nowMs + afterMs;
      let release: () => void = () => {};
      holdUntilReleased = new Promise<void>((resolve) => { release = resolve; });
      return { release: () => { holdAtMs = null; release(); } };
    },
    /**
     * A sidecar an EARLIER worker started: recorded as loading, `startedAgoMs` ago (or with the given `startedAt` text),
     * ready `loadMs` from now.
     */
    addEarlierSidecar: (loadMs: number, startedAgoMs = 0, startedAt?: string): FakeLoadingSidecar => startSidecar({
      token: 'earlier-token',
      recordFile: getRecordPath(),
      readyFile: null,
      configHash: getSttSidecarConfigHash(defaultSettings),
      readyAtMs: nowMs + loadMs,
    }, startedAgoMs, startedAt),
  };
}

function createLocalEngine(owner: ReturnType<typeof createSttSidecarOwner>, onAsk: () => void = () => {}): ResolvedSttEngine {
  return {
    id: 'g',
    kind: 'gigaam',
    name: 'gigaam',
    timeout: defaultSttTimeout,
    getEndpoint: async (request) => {
      onAsk();
      return getSttSidecarTranscriptionEndpoint(await owner.ensure(defaultSettings, request));
    },
  };
}

test('a model that loads for 45 s on a busy box is waited for: one process, nothing killed, no failure, and the slow load is logged once', async () => {
  const world = createFakeWorld();
  world.state.loadMsOfNextStart = 45_000;
  const owner = createSttSidecarOwner(world.deps);

  const endpoint = await owner.ensure(defaultSettings);

  assert.equal(world.getSpawnCount(), 1);
  assert.deepEqual(world.signals, [], 'a process that is still loading is never stopped');
  assert.equal(owner.checkIsUnhealthy(), false);
  assert.ok(endpoint.port > 0 && endpoint.token.length >= 32);
  assert.deepEqual(endpoint, { port: readRecord().port, token: readRecord().token });
  assert.ok(world.getElapsedMs() >= 45_000 && world.getElapsedMs() < 46_000, `waited ${world.getElapsedMs()} ms`);
  const slowLines = world.logLines.filter((line) => line.includes('is still loading its model after'));
  assert.equal(slowLines.length, 1, world.logLines.join('\n'));
  assert.match(slowLines[0], /after 15 s; waiting for it \(up to 120 s\)/);
  assert.ok(world.logLines.some((line) => /^\[STT\] sidecar started pid \d+ port \d+ in 45\d{3}ms/.test(line)), world.logLines.join('\n'));
});

test('a voice that arrives while the sidecar still loads shares that start — no second process, the same endpoint, however late it comes', async () => {
  const world = createFakeWorld();
  world.state.loadMsOfNextStart = 70_000;
  const owner = createSttSidecarOwner(world.deps);
  const latecomers: Array<Promise<SttSidecarEndpoint>> = [];
  world.schedule(25_000, () => { latecomers.push(owner.ensure(defaultSettings)); });
  world.schedule(60_000, () => { latecomers.push(owner.ensure(defaultSettings)); });

  const first = await owner.ensure(defaultSettings);

  assert.equal(latecomers.length, 2);
  for (const latecomer of latecomers) assert.deepEqual(await latecomer, first);
  assert.equal(world.getSpawnCount(), 1);
  assert.deepEqual(world.signals, []);
});

test('a warm-up and the voice\'s own request are ONE ask: the model is loaded once, and the voice gets what the warm-up got', async () => {
  const world = createFakeWorld();
  world.state.loadMsOfNextStart = 30_000;
  const owner = createSttSidecarOwner(world.deps);
  const asked: string[] = [];
  const engine = createLocalEngine(owner, () => asked.push('ask'));

  const warmed = warmUpFirstEngine([engine], () => {});
  assert.ok(warmed);
  // The voice's job gets there while the model still loads; nothing listens on the fake port, so what it does with the
  // endpoint is not the point — how often the engine was asked is.
  await transcribeWithEngines(writeAudioFile(), [engine], { language: null, warmedEndpoint: warmed, retryDelaysMs: [] });

  assert.deepEqual(asked, ['ask'], 'the engine was asked once for this voice');
  assert.equal(world.getSpawnCount(), 1);
  assert.equal((await warmed.endpoint).url, `http://127.0.0.1:${readRecord().port}/v1/audio/transcriptions`, 'and the voice used the warm-up\'s endpoint');
});

test('a warm-up never judges a silent sidecar: no /health, nothing counted toward the silence limit, no replacement — only the voices\' own asks do', async () => {
  let healthCalls = 0;
  const world = createFakeWorld({ fetchHealth: async () => { healthCalls++; return null; } });
  const busy = world.addEarlierSidecar(0); // alive and listening, but busy with a long recognition: it never answers /health in time
  await world.deps.sleep(0); // its load completes: the record now names a listening port
  const owner = createSttSidecarOwner(world.deps);

  // Five voices of one topic arrive behind that recognition: five warm-ups.
  for (let arrival = 1; arrival <= 5; arrival++) {
    const endpoint = await owner.ensure(defaultSettings, { isWarmUp: true });
    assert.deepEqual(endpoint, { port: readRecord().port, token: 'earlier-token' }, `warm-up ${arrival} takes the live sidecar as it is`);
  }
  assert.equal(healthCalls, 0, 'a warm-up asks nothing of a listening sidecar');
  assert.equal(world.signals.length, 0, 'and stops nothing');
  assert.equal(world.getSpawnCount(), 0);

  // The voices\' own asks keep the rule the silence limit exists for: used anyway twice, replaced when it stays silent a third time.
  await owner.ensure(defaultSettings);
  await owner.ensure(defaultSettings);
  assert.equal(world.signals.length, 0, 'the warm-ups did not count: two silent asks of voices still spare it');
  await owner.ensure(defaultSettings);
  assert.ok(world.signals.some((entry) => entry.pid === busy.pid), 'the third silent ask of a voice replaces it');
  assert.equal(world.getSpawnCount(), 1);
});

test('a warm-up still does its work on a cold or loading engine: it starts one, or waits for the one that is loading', async () => {
  const cold = createFakeWorld();
  const coldOwner = createSttSidecarOwner(cold.deps);
  const started = await coldOwner.ensure(defaultSettings, { isWarmUp: true });
  assert.equal(cold.getSpawnCount(), 1);
  assert.equal(started.port, readRecord().port);

  fs.rmSync(getRecordPath(), { force: true });
  const loading = createFakeWorld();
  loading.addEarlierSidecar(20_000);
  const loadingOwner = createSttSidecarOwner(loading.deps);
  const waited = await loadingOwner.ensure(defaultSettings, { isWarmUp: true });
  assert.equal(loading.getSpawnCount(), 0, 'it did not start a second one');
  assert.deepEqual(waited, { port: readRecord().port, token: 'earlier-token' });
  assert.ok(loading.getElapsedMs() >= 20_000);
});

test('a start that FAILS FAST is one failed start per voice, not two: the guard trips on the third voice, not the second', async () => {
  let starts = 0;
  const world = createFakeWorld({ startProcess: async () => { starts++; throw new Error('spawn ENOENT'); } });
  const owner = createSttSidecarOwner(world.deps);
  const engine = createLocalEngine(owner);

  for (const voice of [1, 2, 3]) {
    const warmed = warmUpFirstEngine([engine], () => {});
    await sleep(0); // the warm-up has already failed when this voice's job gets to the engine
    const result = await transcribeWithEngines(writeAudioFile(), [engine], { language: null, warmedEndpoint: warmed });
    assert.deepEqual(result, { ok: false, error: 'the local engine could not be started: spawn ENOENT', engine: 'gigaam' });
    assert.equal(starts, voice, `voice ${voice}: one start attempt, however fast it failed`);
    assert.equal(owner.checkIsUnhealthy(), voice === 3, `voice ${voice}`);
  }
});

test('a voice whose first engine is still starting after its budget moves on to the next engine — and the start GOES ON: it is alive, and the next voice joins it', async () => {
  const world = createFakeWorld();
  world.state.loadMsOfNextStart = 40_000;
  const hold = world.hold(10_000);
  const owner = createSttSidecarOwner(world.deps);
  const stub = await startStubEngine('from the hosted engine');
  try {
    const fallbacks: Array<{ from: string; to: string; error: string }> = [];
    const result = await transcribeWithEngines(writeAudioFile(), [createLocalEngine(owner), stub.engine], {
      language: null,
      nonLastEngineStartBudgetMs: 50,
      onFallback: (info) => fallbacks.push(info),
    });

    assert.deepEqual(result, { ok: true, text: 'from the hosted engine', engine: 'url:stub' });
    assert.equal(fallbacks.length, 1);
    assert.match(fallbacks[0].error, /^gigaam was still starting after \d+ s/);
    assert.equal(world.getAliveCount(), 1, 'the loading process was not stopped');
    assert.deepEqual(world.signals, []);

    const nextVoice = createLocalEngine(owner).getEndpoint(); // the next voice, while the load is still going
    hold.release();
    const endpoint = await nextVoice;
    assert.equal(world.getSpawnCount(), 1, 'it joined the same start');
    assert.equal(endpoint.url, `http://127.0.0.1:${readRecord().port}/v1/audio/transcriptions`);
    assert.deepEqual(world.signals, []);
  } finally {
    hold.release();
    await stub.close();
  }
});

test('a reloaded worker finds the loading sidecar in its record and waits for it — no second process', async () => {
  const world = createFakeWorld();
  world.addEarlierSidecar(50_000, 30_000);
  const owner = createSttSidecarOwner(world.deps);

  const endpoint = await owner.ensure(defaultSettings);

  assert.equal(world.getSpawnCount(), 0, 'the new worker started nothing');
  assert.deepEqual(world.signals, []);
  assert.deepEqual(endpoint, { port: readRecord().port, token: 'earlier-token' });
  assert.ok(world.logLines.some((line) => line.includes('is still loading the model; waiting for it')), world.logLines.join('\n'));
  assert.ok(world.getElapsedMs() >= 50_000 && world.getElapsedMs() < 51_000, `waited ${world.getElapsedMs()} ms`);
});

test('ONE deadline per request: a loading process this request adopted hits the ceiling counted from ITS start — the voice fails with the ceiling text and nothing is respawned for it', async () => {
  const world = createFakeWorld();
  const wedged = world.addEarlierSidecar(fakeLoadNeverMs, 100_000);
  const owner = createSttSidecarOwner(world.deps);

  await assert.rejects(() => owner.ensure(defaultSettings), /^Error: the local engine was still loading its model after 120 s \(see sidecar\.log\)$/);

  assert.ok(world.getElapsedMs() >= 20_000 && world.getElapsedMs() < 21_000, `waited ${world.getElapsedMs()} ms (the 20 s the process had left, not a fresh 120)`);
  assert.equal(world.getSpawnCount(), 0, 'no respawn within the same request');
  assert.ok(world.signals.some((entry) => entry.pid === wedged.pid), 'the wedged one was stopped');
  assert.equal(fs.existsSync(getRecordPath()), false);
  assert.ok(world.logLines.some((line) => line.includes('has been loading the model for more than 120 s; stopping it')), world.logLines.join('\n'));

  const endpoint = await owner.ensure(defaultSettings); // the NEXT voice starts afresh
  assert.equal(world.getSpawnCount(), 1);
  assert.equal(readRecord().port, endpoint.port);
});

test('a start killed at its ceiling by an adopting request counts toward the spawn-storm guard, like one killed by the spawning request', async () => {
  const world = createFakeWorld();
  const owner = createSttSidecarOwner(world.deps);
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.equal(owner.checkIsUnhealthy(), false, `before kill ${attempt}`);
    world.addEarlierSidecar(fakeLoadNeverMs, fakeCeilingMs + 1_000); // already past its ceiling when found
    await assert.rejects(() => owner.ensure(defaultSettings), /still loading its model after 120 s/);
  }
  assert.equal(owner.checkIsUnhealthy(), true);
  assert.equal(world.getSpawnCount(), 0);
  assert.ok(world.logLines.some((line) => /^\[STT\] gigaam marked unhealthy until/.test(line)), world.logLines.join('\n'));
});

test('a start stamp that lies in the FUTURE or cannot be read counts as "now": the loading process is waited for a full ceiling from now — not forever, not zero', async () => {
  for (const [description, startedAgoMs, startedAt] of [
    ['a start stamp an hour in the future', -60 * 60 * 1000, undefined],
    ['a start stamp that is not a date', 0, 'not-a-date'],
  ] as const) {
    const world = createFakeWorld();
    world.addEarlierSidecar(fakeLoadNeverMs, startedAgoMs, startedAt);
    const owner = createSttSidecarOwner(world.deps);

    await assert.rejects(() => owner.ensure(defaultSettings), /still loading its model after 120 s/, description);

    assert.ok(world.getElapsedMs() >= fakeCeilingMs && world.getElapsedMs() < fakeCeilingMs + 1_000, `${description}: waited ${world.getElapsedMs()} ms`);
    assert.equal(world.getSpawnCount(), 0, description);
  }
});

test('a process that dies while it loads fails the voice at once — not at the ceiling — and cleans up', async () => {
  const world = createFakeWorld();
  world.state.loadMsOfNextStart = fakeLoadNeverMs;
  world.schedule(3_000, world.killAll);
  const owner = createSttSidecarOwner(world.deps);

  await assert.rejects(() => owner.ensure(defaultSettings), /exited before it was ready/);

  assert.ok(world.getElapsedMs() < 4_000, `failed after ${world.getElapsedMs()} ms`);
  assert.equal(fs.existsSync(getRecordPath()), false, 'the claimed record is dropped');
  assert.equal(world.getSpawnCount(), 1);
});

test('a start still loading at the ceiling is stopped and the voice is told so: the failure names the 120 s and the cause', async () => {
  const world = createFakeWorld();
  world.state.loadMsOfNextStart = fakeLoadNeverMs;
  const owner = createSttSidecarOwner(world.deps);

  const result = await transcribeWithEngines(writeAudioFile(), [createLocalEngine(owner)], { language: null });

  assert.deepEqual(result, { ok: false, error: 'the local engine was still loading its model after 120 s (see sidecar.log)', engine: 'gigaam' });
  assert.ok(world.getElapsedMs() >= fakeCeilingMs && world.getElapsedMs() < fakeCeilingMs + 1_000, `gave up after ${world.getElapsedMs()} ms`);
  assert.equal(world.getAliveCount(), 0, 'the wedged process is stopped');
  assert.equal(fs.existsSync(getRecordPath()), false);
  assert.deepEqual(fs.readdirSync(getSttPaths(dataDir).root).filter((name) => name.startsWith('ready-')), []);
  assert.equal(owner.checkIsUnhealthy(), false, 'one failed start is not a storm');
});

async function getCharnessWait(check: () => boolean, timeoutMs: number, description: string): Promise<void> {
  const deadlineMs = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadlineMs) throw new Error(`timed out waiting for ${description}`);
    await sleep(50);
  }
}
