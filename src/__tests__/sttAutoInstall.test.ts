/**
 * @description The install job manager: it launches the detached job (or attaches to a running one), forwards
 * every progress report, ends on the job's own `done` / `failed` line, never retries, and notices a job that
 * vanished. The logic runs on in-memory dependencies; one case drives a REAL detached process through the
 * production process host.
 */

import { test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { signalExternallyHostedProcess, startExternallyParentedProcess, type ExternalProcessIdentity } from '../installManager';
import { getSttPaths, isGigaamInstalling, type SttInstallProgress } from '../stt/sttInstall';
import {
  createDefaultSttInstallJobDeps,
  createSttInstallJobManager,
  getSttInstallEntryPath,
  type SttInstallJobDeps,
} from '../stt/sttAutoInstall';

const fakeEntryPath = path.join(__dirname, 'fixtures', 'fakeSttInstallEntry.cjs');

let dataDir = '';
const launchedIdentities: ExternalProcessIdentity[] = [];

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-auto-install-'));
});

afterEach(() => {
  for (const identity of launchedIdentities.splice(0)) signalExternallyHostedProcess(identity, 'SIGKILL');
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const downloading: SttInstallProgress = { phase: 'downloadingModel', detail: '50/216 MB', bytesDownloaded: 50 };
const done: SttInstallProgress = { phase: 'done', detail: '', bytesDownloaded: 216 };

/** In-memory dependencies: `progressScript` is what each poll reads; `isInstalling` is read as a flag. */
function createFakeDeps(progressScript: Array<SttInstallProgress | null>, overrides: Partial<SttInstallJobDeps> = {}) {
  const calls = { launched: [] as string[][], cleared: 0, logs: [] as string[] };
  let pollIndex = 0;
  const state = { isInstalling: false, isLaunchedAlive: true };
  const deps: SttInstallJobDeps = {
    launchEntry: async (extraArgs) => {
      calls.launched.push(extraArgs);
      state.isInstalling = true;
      return { pid: 1, startToken: 't' };
    },
    checkIsLaunchedAlive: () => state.isLaunchedAlive,
    checkIsInstalling: () => state.isInstalling,
    readProgress: () => {
      const progress = progressScript[Math.min(pollIndex, progressScript.length - 1)] ?? null;
      pollIndex++;
      // A finished job has released its lock.
      if (progress && (progress.phase === 'done' || progress.phase === 'failed')) state.isInstalling = false;
      return progress;
    },
    clearProgress: () => { calls.cleared++; },
    sleep: async () => {},
    pollIntervalMs: 0,
    log: (line) => calls.logs.push(line),
    ...overrides,
  };
  return { deps, calls, state };
}

test('start launches the job once, forwards every report in order and resolves with the final one', async () => {
  const { deps, calls } = createFakeDeps([
    { phase: 'creatingEnvironment', detail: '', bytesDownloaded: 0 },
    downloading,
    done,
  ]);
  const reports: SttInstallProgress[] = [];
  const result = await createSttInstallJobManager(deps).start({ reportTo: (progress) => { reports.push(progress); } });
  assert.deepEqual(result, done);
  assert.deepEqual(reports.map((report) => report.phase), ['creatingEnvironment', 'downloadingModel', 'done']);
  assert.deepEqual(calls.launched, [[]]);
  assert.equal(calls.cleared, 1, 'the previous run\'s progress is cleared before the job starts');
});

test('success spawns nothing else: the engine starts with the next voice, not with the install', async () => {
  const { deps, calls } = createFakeDeps([done]);
  await createSttInstallJobManager(deps).start({ reportTo: () => {} });
  assert.equal(calls.launched.length, 1, 'only the install job was launched');
});

test('force is passed to the job', async () => {
  const { deps, calls } = createFakeDeps([done]);
  await createSttInstallJobManager(deps).start({ reportTo: () => {}, force: true });
  assert.deepEqual(calls.launched, [['--force']]);
});

test('a second start while one runs attaches to it — one launch, both reporters hear the end', async () => {
  const gate: { release: () => void } = { release: () => {} };
  const waitForRelease = new Promise<void>((resolve) => { gate.release = resolve; });
  let polls = 0;
  const { deps, calls } = createFakeDeps([downloading, done], {
    sleep: async () => { if (polls++ === 0) await waitForRelease; },
  });
  const manager = createSttInstallJobManager(deps);
  const heardByFirst: string[] = [];
  const heardBySecond: string[] = [];
  const first = manager.start({ reportTo: (progress) => { heardByFirst.push(progress.phase); } });
  const second = manager.start({ reportTo: (progress) => { heardBySecond.push(progress.phase); } });
  gate.release();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepEqual(firstResult, done);
  assert.strictEqual(secondResult, firstResult);
  assert.equal(calls.launched.length, 1);
  assert.deepEqual(heardByFirst, heardBySecond);
  assert.equal(heardBySecond.at(-1), 'done');
});

test('after the job ends, the next start launches a fresh one', async () => {
  const { deps, calls } = createFakeDeps([done]);
  const manager = createSttInstallJobManager(deps);
  await manager.start({ reportTo: () => {} });
  await manager.start({ reportTo: () => {} });
  assert.equal(calls.launched.length, 2);
});

test('a failure is reported once with the error and the log tail, and the job is not relaunched', async () => {
  const failed: SttInstallProgress = { phase: 'failed', detail: '', bytesDownloaded: 0, error: 'the model check failed', logTail: ['boom'] };
  const { deps, calls } = createFakeDeps([downloading, failed]);
  const reports: SttInstallProgress[] = [];
  const result = await createSttInstallJobManager(deps).start({ reportTo: (progress) => { reports.push(progress); } });
  assert.deepEqual(result, failed);
  assert.deepEqual(reports.at(-1)?.logTail, ['boom']);
  assert.equal(calls.launched.length, 1, 'no retry loop');
});

test('re-attach after a reload: a job already running is not launched again, only polled', async () => {
  const { deps, calls, state } = createFakeDeps([downloading, done]);
  state.isInstalling = true;
  const reports: string[] = [];
  const result = await createSttInstallJobManager(deps).start({ reportTo: (progress) => { reports.push(progress.phase); } });
  assert.deepEqual(result, done);
  assert.deepEqual(calls.launched, []);
  assert.equal(calls.cleared, 0, 'the running job\'s progress is left alone');
  assert.deepEqual(reports, ['downloadingModel', 'done']);
});

test('a job that vanishes without a result is reported as failed — also when it wrote its last line just before leaving', async () => {
  const lost = createFakeDeps([downloading], {});
  lost.state.isInstalling = true;
  lost.deps.launchEntry = async () => ({ pid: 1, startToken: 't' });
  let polls = 0;
  lost.deps.checkIsInstalling = () => polls++ < 2;
  lost.deps.checkIsLaunchedAlive = () => false;
  const reports: SttInstallProgress[] = [];
  const result = await createSttInstallJobManager(lost.deps).start({ reportTo: (progress) => { reports.push(progress); } });
  assert.equal(result.phase, 'failed');
  assert.match(result.error ?? '', /ended without a result/);
  assert.equal(reports.at(-1)?.phase, 'failed');

  // The terminal line lands between the poll and the liveness check.
  let reads = 0;
  const lateLine = createFakeDeps([], {
    readProgress: () => (reads++ < 1 ? downloading : done),
    checkIsInstalling: () => false,
    checkIsLaunchedAlive: () => false,
  });
  assert.deepEqual(await createSttInstallJobManager(lateLine.deps).start({ reportTo: () => {} }), done);
});

test('a launch that fails is a failed report, not a hang', async () => {
  const { deps } = createFakeDeps([], {
    launchEntry: async () => { throw new Error('spawn ENOENT'); },
  });
  const reports: SttInstallProgress[] = [];
  const result = await createSttInstallJobManager(deps).start({ reportTo: (progress) => { reports.push(progress); } });
  assert.equal(result.phase, 'failed');
  assert.match(result.error ?? '', /could not be started: spawn ENOENT/);
  assert.deepEqual(reports, [result]);
});

test('a reporter that throws never stops the job or the other reporters', async () => {
  const { deps, calls } = createFakeDeps([downloading, done]);
  const manager = createSttInstallJobManager(deps);
  const heard: string[] = [];
  const result = manager.start({ reportTo: () => { throw new Error('telegram is down'); } });
  void manager.start({ reportTo: (progress) => { heard.push(progress.phase); } });
  assert.deepEqual(await result, done);
  assert.deepEqual(heard, ['downloadingModel', 'done']);
  assert.ok(calls.logs.some((line) => line.includes('install report failed: telegram is down')));
});

test('production wiring: a real detached job is launched, followed through its progress file and ends on done', { timeout: 30_000 }, async () => {
  const productionDeps = createDefaultSttInstallJobDeps(() => dataDir);
  const deps: SttInstallJobDeps = {
    ...productionDeps,
    launchEntry: async () => {
      const identity = await startExternallyParentedProcess(process.execPath, [fakeEntryPath, dataDir, 'done', '--step-ms', '150'], process.env);
      launchedIdentities.push(identity);
      return identity;
    },
    pollIntervalMs: 60,
    log: () => {},
  };
  const reports: SttInstallProgress[] = [];
  const result = await createSttInstallJobManager(deps).start({ reportTo: (progress) => { reports.push(progress); } });
  assert.equal(result.phase, 'done');
  assert.deepEqual([...new Set(reports.map((report) => report.phase))], ['creatingEnvironment', 'installingPackages', 'downloadingModel', 'done']);
  assert.equal(fs.readFileSync(getSttPaths(dataDir).progressFile, 'utf8').trim().split('\n').length, 4, 'the job\'s own lines are what was followed');
});

test('production wiring: a real job that dies without a result is a failed report; one that fails keeps its tail', { timeout: 30_000 }, async () => {
  const run = async (outcome: string): Promise<SttInstallProgress> => {
    // The previous fake releases its lock a moment after its last line; a start in that gap would attach to it.
    const deadlineMs = Date.now() + 5_000;
    while (isGigaamInstalling(dataDir) && Date.now() < deadlineMs) await new Promise((resolve) => setTimeout(resolve, 20));
    const deps: SttInstallJobDeps = {
      ...createDefaultSttInstallJobDeps(() => dataDir),
      launchEntry: async () => {
        const identity = await startExternallyParentedProcess(process.execPath, [fakeEntryPath, dataDir, outcome, '--step-ms', '100'], process.env);
        launchedIdentities.push(identity);
        return identity;
      },
      pollIntervalMs: 60,
      log: () => {},
    };
    return createSttInstallJobManager(deps).start({ reportTo: () => {} });
  };
  const failed = await run('failed');
  assert.equal(failed.phase, 'failed');
  assert.deepEqual(failed.logTail, ['line one', 'line two']);

  const vanished = await run('vanish');
  assert.equal(vanished.phase, 'failed');
  assert.match(vanished.error ?? '', /ended without a result/);
});

test('the entry path resolves to the compiled job beside the module, or the build output from sources', () => {
  const entryPath = getSttInstallEntryPath();
  assert.ok(entryPath.endsWith(path.join('stt', 'sttInstallEntry.js')), entryPath);
});
