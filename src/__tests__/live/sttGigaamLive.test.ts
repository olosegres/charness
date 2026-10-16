/**
 * @description The local GigaAM engine LIVE: the real installer into a scratch
 * data dir, then the REAL sidecar process (real model, real onnxruntime) driven
 * through the same client code a voice note uses. Skipped unless the inputs
 * below are set, so `yarn test` never installs 450 MB or loads a model.
 *
 *   STT_GIGAAM_LIVE_DATA_DIR      an EMPTY scratch dir (never an instance's DATA_DIR): the install goes
 *                                 to `<dir>/stt`; an already installed one is reused
 *   STT_GIGAAM_LIVE_AUDIO         a short Russian voice clip (OGG/Opus like Telegram's)
 *   STT_GIGAAM_LIVE_EXPECT        optional: comma-separated words the short clip must contain
 *   STT_GIGAAM_LIVE_LONG_AUDIO    optional: a ~5 minute clip — the chunking, the memory ceiling and the
 *                                 shortest-request-first proof run on it
 *
 * Run (the sidecar's owner is this test process; keep tmux out of it):
 *   env -u TMUX -u TMUX_PANE STT_GIGAAM_LIVE_DATA_DIR=... STT_GIGAAM_LIVE_AUDIO=... \
 *     node --import tsx --test --test-timeout=1800000 src/__tests__/live/sttGigaamLive.test.ts
 *
 * Cases: scratch install · the Python unit tests under the venv interpreter · cold start · (b) a request
 * without the token is refused · (c) health · (a) the short clip through `transcribeWithEngines` · (e) the long
 * clip's time and peak memory · (f) a short voice overtakes a queued long one · (h) two sidecars, two ports · (g) the
 * owner dying takes the sidecar down · (d) the idle exit deletes the record.
 */

import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { getSidecarScriptPath, getSttPaths, runSttInstall, type SttInstallProgress } from '../../stt/sttInstall';
import { defaultSttTimeout, type ResolvedSttEngine } from '../../stt/sttSettings';
import { transcribeWithEngines } from '../../stt/transcribeChain';
import { transcribeAudio } from '../../utils/transcribeAudio';

const dataDir = process.env.STT_GIGAAM_LIVE_DATA_DIR;
const shortAudio = process.env.STT_GIGAAM_LIVE_AUDIO;
const longAudio = process.env.STT_GIGAAM_LIVE_LONG_AUDIO;
const expectedWords = (process.env.STT_GIGAAM_LIVE_EXPECT ?? '').split(',').map((word) => word.trim().toLowerCase()).filter(Boolean);
const skipReason = dataDir && shortAudio ? undefined : 'set STT_GIGAAM_LIVE_DATA_DIR and STT_GIGAAM_LIVE_AUDIO to run';

const tokenEnvName = 'CHARNESS_STT_SIDECAR_TOKEN';
const workers = 4;
const threads = 2;
const readyTimeoutMs = 60_000;
const pollMs = 50;
const shortVoiceBudgetMs = 10_000;
const longVoiceBudgetMs = 30_000;
const longVoiceHardLimitMs = 85_000;
const peakMemoryLimitKb = 1024 * 1024;
/**
 * The short voice's wait must be well under what plain arrival order would cost it — waiting for ALL the long
 * voice's queued chunks, i.e. about the long reply's remaining time. A load-proof ratio instead of a fixed budget:
 * the same run takes 3.5–7 s on this box depending on what else it is doing.
 */
const maxShortWaitShareOfLongRemainder = 0.75;
/** The long request counts as queued once this many of its ~15 chunks still wait for a worker. */
const queuedChunksBeforeShortVoice = 6;
const queueWaitBudgetMs = 30_000;
const ownerDeathBudgetMs = 4_000;
const idleSeconds = 3;
const idleExitBudgetMs = 10_000;
const fallbackDurationSeconds = 20;

interface SidecarRecord {
  pid: number;
  startToken: string;
  port: number;
  token: string;
  configHash: string;
  ownerPid: number;
  ownerStartToken: string;
}

interface RunningSidecar {
  child: ChildProcess;
  pid: number;
  port: number;
  token: string;
  coldStartMs: number;
  recordFile: string;
  exited: Promise<number | null>;
}

const spawned: ChildProcess[] = [];
let scratchFiles = '';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getStartToken(pid: number): string {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19];
}

function getPeakMemoryKb(pid: number): number {
  const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  return Number(/^VmHWM:\s+(\d+) kB/m.exec(status)?.[1] ?? '0');
}

async function startSidecar(options: { ownerPid: number; idleSecondsForTest?: number }): Promise<RunningSidecar> {
  const paths = getSttPaths(dataDir ?? '');
  const label = `${Date.now()}-${spawned.length}`;
  const readyFile = path.join(scratchFiles, `ready-${label}.json`);
  const recordFile = path.join(scratchFiles, `record-${label}.json`);
  const token = `live-token-${label}`;
  const args = [
    '-I', getSidecarScriptPath(),
    '--ready-file', readyFile,
    '--record-file', recordFile,
    '--log-file', path.join(scratchFiles, `sidecar-${label}.log`),
    '--workers', String(workers),
    '--threads', String(threads),
    '--owner-pid', String(options.ownerPid),
    '--owner-start-token', getStartToken(options.ownerPid),
    '--config-hash', 'live-test-hash',
    ...(options.idleSecondsForTest !== undefined ? ['--idle-seconds', String(options.idleSecondsForTest)] : []),
  ];
  const startedAt = Date.now();
  const child = spawn(paths.venvPython, args, {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, [tokenEnvName]: token, HF_HOME: paths.hfHome, HF_HUB_OFFLINE: '1' },
    stdio: 'ignore',
  });
  spawned.push(child);
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  let isExited = false;
  void exited.then(() => { isExited = true; });
  while (!fs.existsSync(readyFile)) {
    assert.ok(!isExited, 'the sidecar exited before it was ready');
    assert.ok(Date.now() - startedAt < readyTimeoutMs, 'the sidecar was not ready in time');
    await sleep(pollMs);
  }
  const ready: { pid: number; port: number } = JSON.parse(fs.readFileSync(readyFile, 'utf8'));
  assert.equal(ready.pid, child.pid);
  // The sidecar recorded ITSELF before the ready file: that record is what a bot worker adopts it from.
  const record: SidecarRecord = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  assert.deepEqual(
    { pid: record.pid, startToken: record.startToken, port: record.port, token: record.token, configHash: record.configHash, ownerPid: record.ownerPid, ownerStartToken: record.ownerStartToken },
    { pid: ready.pid, startToken: getStartToken(ready.pid), port: ready.port, token, configHash: 'live-test-hash', ownerPid: options.ownerPid, ownerStartToken: getStartToken(options.ownerPid) },
  );
  assert.equal(fs.statSync(recordFile).mode & 0o777, 0o600, 'the record holds the token: owner only');
  return { child, pid: ready.pid, port: ready.port, token, coldStartMs: Date.now() - startedAt, recordFile, exited };
}

function createEngine(sidecar: RunningSidecar): ResolvedSttEngine {
  return {
    id: 'g',
    kind: 'gigaam',
    name: 'gigaam',
    timeout: defaultSttTimeout,
    getEndpoint: () => Promise.resolve({ url: `http://127.0.0.1:${sidecar.port}/v1/audio/transcriptions`, apiKey: sidecar.token, model: 'gigaam' }),
  };
}

function getAudioSeconds(audioPath: string): number {
  const paths = getSttPaths(dataDir ?? '');
  const probe = spawnSync(paths.venvPython, ['-I', '-c', 'import sys, soundfile; print(soundfile.info(sys.argv[1]).duration)', audioPath], { encoding: 'utf8' });
  const seconds = Number(probe.stdout.trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds : fallbackDurationSeconds;
}

function sendRaw(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: '/v1/audio/transcriptions', method: 'POST', headers }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on('error', reject);
    request.end();
  });
}

interface SidecarHealth {
  status: string;
  workers: number;
  pid: number;
  busyRequests: number;
  queuedChunks: number;
}

function getHealth(port: number, token: string): Promise<SidecarHealth> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/health', headers: { Authorization: `Bearer ${token}` } }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { body += chunk; });
      response.on('end', () => resolve(JSON.parse(body)));
    }).on('error', reject);
  });
}

describe('the local GigaAM engine (live)', { skip: skipReason }, () => {
  let mainSidecar: RunningSidecar;

  before(() => {
    scratchFiles = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-live-'));
  });

  after(() => {
    for (const child of spawned) {
      if (child.exitCode === null && child.pid) {
        try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
    fs.rmSync(scratchFiles, { recursive: true, force: true });
  });

  test('scratch install: venv, pinned packages and the model into an empty data dir', { timeout: 20 * 60 * 1000 }, async () => {
    const reports: SttInstallProgress[] = [];
    const startedAt = Date.now();
    const result = await runSttInstall(dataDir ?? '', { onProgress: (progress) => reports.push(progress) });
    assert.ok(result.ok, result.ok ? '' : `${result.error}\n${result.logTail.join('\n')}`);
    console.log(`[live] install: ${result.wasAlreadyInstalled ? 'already installed' : `${((Date.now() - startedAt) / 1000).toFixed(0)}s`}; phases: ${[...new Set(reports.map((report) => report.phase))].join(' → ')}`);
    assert.ok(fs.existsSync(getSttPaths(dataDir ?? '').venvPython));
  });

  test('(i) the Python unit tests pass under the venv interpreter', () => {
    const result = spawnSync(getSttPaths(dataDir ?? '').venvPython, ['-I', '-B', path.join(path.dirname(getSidecarScriptPath()), 'test_gigaam_sidecar.py')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  });

  test('cold start: the model loads, the port is chosen by the OS and the ready file appears', { timeout: readyTimeoutMs + 5_000 }, async () => {
    mainSidecar = await startSidecar({ ownerPid: process.pid });
    console.log(`[live] cold start (spawn → ready file): ${mainSidecar.coldStartMs} ms, port ${mainSidecar.port}`);
    assert.ok(mainSidecar.port > 0);
  });

  test('(b) a request without the token — or with a wrong one — is refused with 401', async () => {
    assert.equal(await sendRaw(mainSidecar.port, {}), 401);
    assert.equal(await sendRaw(mainSidecar.port, { Authorization: 'Bearer wrong' }), 401);
  });

  test('(c) health reports ok, the worker count and the sidecar\'s own pid', async () => {
    const health = await getHealth(mainSidecar.port, mainSidecar.token);
    assert.equal(health.status, 'ok');
    assert.equal(health.workers, workers);
    assert.equal(health.pid, mainSidecar.pid);
  });

  test('(a) the short clip through transcribeWithEngines: the expected words, within the short-voice budget', { timeout: 60_000 }, async () => {
    const startedAt = Date.now();
    const result = await transcribeWithEngines(shortAudio ?? '', [createEngine(mainSidecar)], {
      durationSeconds: getAudioSeconds(shortAudio ?? ''),
      language: 'ru',
    });
    const elapsedMs = Date.now() - startedAt;
    console.log(`[live] short clip: ${elapsedMs} ms → ${result.ok ? result.text : result.error}`);
    assert.ok(result.ok, result.ok ? '' : result.error);
    assert.equal(result.engine, 'gigaam');
    const text = result.text.toLowerCase();
    for (const word of expectedWords) assert.ok(text.includes(word), `expected "${word}" in "${text}"`);
    assert.ok(elapsedMs < shortVoiceBudgetMs, `took ${elapsedMs} ms`);
  });

  test('(e) the long clip: chunked and recognised within the budget, peak memory under 1 GB', { skip: longAudio ? undefined : 'STT_GIGAAM_LIVE_LONG_AUDIO is not set', timeout: longVoiceHardLimitMs + 30_000 }, async () => {
    const seconds = getAudioSeconds(longAudio ?? '');
    const startedAt = Date.now();
    const result = await transcribeWithEngines(longAudio ?? '', [createEngine(mainSidecar)], { durationSeconds: seconds, language: null });
    const elapsedMs = Date.now() - startedAt;
    const peakKb = getPeakMemoryKb(mainSidecar.pid);
    console.log(`[live] long clip (${seconds.toFixed(0)}s of audio): ${elapsedMs} ms, ${result.ok ? result.text.length : 0} chars, peak RSS ${(peakKb / 1024).toFixed(0)} MB`);
    assert.ok(result.ok && result.text.length > 0, result.ok ? 'empty text' : result.error);
    assert.ok(elapsedMs <= longVoiceBudgetMs, `took ${elapsedMs} ms, the budget is ${longVoiceBudgetMs} ms`);
    assert.ok(peakKb <= peakMemoryLimitKb, `peak ${peakKb} kB`);
  });

  test('(f) priority: a short voice sent while a long voice is queued is answered first', { skip: longAudio ? undefined : 'STT_GIGAAM_LIVE_LONG_AUDIO is not set', timeout: longVoiceHardLimitMs + 30_000 }, async () => {
    const endpoint = { url: `http://127.0.0.1:${mainSidecar.port}/v1/audio/transcriptions`, apiKey: mainSidecar.token, model: 'gigaam' };
    const options = { timeoutMs: longVoiceHardLimitMs, retryDelaysMs: [] };
    const startedAt = Date.now();
    const longReply = transcribeAudio(longAudio ?? '', endpoint, options).then((result) => ({ result, atMs: Date.now() - startedAt }));
    // Send the short voice only once the long one's chunks are queued: a short request that arrives while the long
    // upload is still being decoded would go first even in plain arrival order, and prove nothing.
    while ((await getHealth(mainSidecar.port, mainSidecar.token)).queuedChunks < queuedChunksBeforeShortVoice) {
      assert.ok(Date.now() - startedAt < queueWaitBudgetMs, 'the long request never queued its chunks');
      await sleep(pollMs);
    }
    const shortSentAt = Date.now() - startedAt;
    const shortReply = transcribeAudio(shortAudio ?? '', endpoint, options).then((result) => ({ result, atMs: Date.now() - startedAt }));
    const [long, short] = await Promise.all([longReply, shortReply]);
    console.log(`[live] priority: short answered at ${short.atMs} ms (sent at ${shortSentAt}), long at ${long.atMs} ms`);
    assert.ok(long.result.ok && short.result.ok);
    assert.ok(short.atMs < long.atMs, 'the short voice must be answered before the long one');
    const shortWaitMs = short.atMs - shortSentAt;
    const longRemainderMs = long.atMs - shortSentAt;
    assert.ok(
      shortWaitMs < longRemainderMs * maxShortWaitShareOfLongRemainder,
      `the short voice waited ${shortWaitMs} ms of the long one's ${longRemainderMs} ms remainder`,
    );
  });

  test('(h) two sidecars at once listen on different OS-chosen ports', { timeout: readyTimeoutMs + 5_000 }, async () => {
    const second = await startSidecar({ ownerPid: process.pid });
    try {
      console.log(`[live] two sidecars: ports ${mainSidecar.port} and ${second.port}`);
      assert.notEqual(second.port, mainSidecar.port);
      assert.notEqual(second.pid, mainSidecar.pid);
      assert.equal((await getHealth(second.port, second.token)).pid, second.pid);
    } finally {
      second.child.kill('SIGTERM');
      assert.equal(await second.exited, 0, 'SIGTERM is a clean exit');
    }
  });

  test('(g) owner death: SIGKILL of a decoy owner takes the sidecar down within seconds', { timeout: readyTimeoutMs + 20_000 }, async () => {
    const decoy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    spawned.push(decoy);
    assert.ok(decoy.pid);
    const sidecar = await startSidecar({ ownerPid: decoy.pid });
    decoy.kill('SIGKILL');
    const killedAt = Date.now();
    const exitCode = await Promise.race([sidecar.exited, sleep(ownerDeathBudgetMs * 2).then(() => 'timeout' as const)]);
    const goneAfterMs = Date.now() - killedAt;
    console.log(`[live] owner death → sidecar gone after ${goneAfterMs} ms`);
    assert.equal(exitCode, 0);
    assert.ok(goneAfterMs <= ownerDeathBudgetMs, `took ${goneAfterMs} ms`);
    assert.equal(fs.existsSync(sidecar.recordFile), false, 'its own record is removed');
  });

  test('(d) idle exit: with --idle-seconds the sidecar leaves by itself and deletes its record', { timeout: readyTimeoutMs + 30_000 }, async () => {
    const sidecar = await startSidecar({ ownerPid: process.pid, idleSecondsForTest: idleSeconds });
    const startedAt = Date.now();
    const exitCode = await Promise.race([sidecar.exited, sleep(idleExitBudgetMs * 2).then(() => 'timeout' as const)]);
    const leftAfterMs = Date.now() - startedAt;
    console.log(`[live] idle exit after ${leftAfterMs} ms`);
    assert.equal(exitCode, 0);
    assert.ok(leftAfterMs <= idleExitBudgetMs, `took ${leftAfterMs} ms`);
    assert.equal(fs.existsSync(sidecar.recordFile), false, 'the record is deleted');
  });
});
