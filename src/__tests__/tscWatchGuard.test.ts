/**
 * @description The hot supervisor's guard over `tsc -w` (`cli/tscWatchGuard.ts`): TypeScript's watch mode learns of a changed
 * source only from file-system events, and a burst (a pull of dozens of commits, then `yarn install`) can overflow the inotify
 * queue and drop them — the watcher then keeps the old text of the files it missed while the worker runs the old build. The
 * guard compares what the watcher says with what is on disk. Load-bearing facts proven here:
 *   • the watcher's status is read off its own output, the last marker winning;
 *   • a compiled source is stale when its output is older (or missing) and it changed more than the grace ago — tests,
 *     declarations and the release tooling are never listed;
 *   • an idle watcher with "0 errors" and a stale source is restarted; with errors, a fresh one-shot compile is the referee —
 *     clean there restarts the watcher, broken there leaves it (and is not asked again until the stale set changes);
 *   • a watcher still compiling, or one that moved on during the referee compile, is never judged;
 *   • a tree the guard cannot cure is reported once and not restarted in a loop;
 *   • the supervisor's two windows come from the same `CHARNESS_TEST_TIMINGS` the bot validates, production otherwise.
 *
 * The real thing — a `tsc -w` that lost its events — is the hot update flow's last step (`selfUpdateHotE2e.test.ts`).
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createTscWatchGuard,
  getOutputPath,
  listStaleSources,
  readTscWatchGuardTimings,
  readWatcherStatus,
  runFreshTscCompile,
  tscWatchCheckIntervalMs,
  tscWatchRestartBudget,
  tscWatchRestartWindowMs,
  tscWatchStaleGraceMs,
  type StaleSource,
  type TscWatchGuardPorts,
  type WatcherStatus,
} from '../cli/tscWatchGuard';

const graceMs = 60_000;
const nowMs = 10_000_000;

describe('what the watcher says about itself', () => {
  const idleClean = 'Found 0 errors. Watching for file changes.';
  const unknown: WatcherStatus = { kind: 'unknown' };

  test('the markers of a start, a rebuild and a finished compile', () => {
    assert.deepEqual(readWatcherStatus('[9:08:43 PM] Starting compilation in watch mode...', unknown), { kind: 'compiling' });
    assert.deepEqual(readWatcherStatus('File change detected. Starting incremental compilation...', unknown), { kind: 'compiling' });
    assert.deepEqual(readWatcherStatus(idleClean, unknown), { kind: 'idle', errorCount: 0 });
    assert.deepEqual(readWatcherStatus('Found 12 errors. Watching for file changes.', unknown), { kind: 'idle', errorCount: 12 });
    assert.deepEqual(readWatcherStatus('Found 1 error. Watching for file changes.', unknown), { kind: 'idle', errorCount: 1 });
  });

  test('the last marker of a chunk wins, whichever kind it is; a chunk without a marker keeps the status', () => {
    assert.deepEqual(readWatcherStatus(`File change detected. Starting incremental compilation...\n${idleClean}`, unknown), { kind: 'idle', errorCount: 0 });
    assert.deepEqual(readWatcherStatus(`${idleClean}\nFile change detected. Starting incremental compilation...`, unknown), { kind: 'compiling' });
    const idle: WatcherStatus = { kind: 'idle', errorCount: 3 };
    assert.deepEqual(readWatcherStatus('src/a.ts(1,1): error TS2339: Property does not exist', idle), idle);
  });
});

describe('where a compiled source lands', () => {
  test('src/<path>.ts is dist/<path>.js', () => {
    assert.equal(getOutputPath('src/bot.ts'), 'dist/bot.js');
    assert.equal(getOutputPath('src/cli/hot.ts'), 'dist/cli/hot.js');
  });
});

describe('listStaleSources', () => {
  let root: string;

  /** Write `relativePath` and set its mtime to `mtimeMs`. */
  function writeFile(relativePath: string, mtimeMs: number): void {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'x');
    fs.utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000);
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-tscguard-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('a source newer than its output, or without one, is stale; one the output is as new as is not', () => {
    const oldMs = nowMs - 10 * graceMs;
    writeFile('src/emitted.ts', oldMs);
    writeFile('dist/emitted.js', oldMs + 1000);
    writeFile('src/cli/missed.ts', oldMs + 5000);
    writeFile('dist/cli/missed.js', oldMs);
    writeFile('src/never.ts', oldMs);
    const stale = listStaleSources(root, nowMs, graceMs);
    assert.deepEqual(stale.map((source) => source.sourcePath).sort(), ['src/cli/missed.ts', 'src/never.ts']);
    assert.deepEqual(stale.find((source) => source.sourcePath === 'src/never.ts'), { sourcePath: 'src/never.ts', sourceMtimeMs: oldMs, outputMtimeMs: null });
  });

  test('a change younger than the grace is not blamed — the watcher has had no time to emit it', () => {
    writeFile('src/fresh.ts', nowMs - graceMs + 1000);
    writeFile('dist/fresh.js', nowMs - 10 * graceMs);
    assert.deepEqual(listStaleSources(root, nowMs, graceMs), []);
    assert.equal(listStaleSources(root, nowMs + 2000, graceMs).length, 1, 'the same file once the grace has passed');
  });

  test('tests, the release tooling, declarations and other files the compiler writes nothing for are never listed', () => {
    const oldMs = nowMs - 10 * graceMs;
    for (const skipped of ['src/__tests__/a.test.ts', 'src/release/plan.ts', 'src/types/ambient.d.ts', 'src/notes.md', 'src/data.json']) writeFile(skipped, oldMs);
    assert.deepEqual(listStaleSources(root, nowMs, graceMs), []);
  });
});

describe('runFreshTscCompile — the referee', () => {
  const realTscBin = path.join(__dirname, '..', '..', 'node_modules', 'typescript', 'bin', 'tsc');
  let project: string;

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-tscfresh-'));
    fs.writeFileSync(path.join(project, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['*.ts'] }));
  });
  afterEach(() => {
    fs.rmSync(project, { recursive: true, force: true });
  });

  test('a tree that compiles is clean, one with a type error is not — and nothing is written either way', async () => {
    fs.writeFileSync(path.join(project, 'a.ts'), 'export const answer: number = 42;\n');
    assert.equal(await runFreshTscCompile(project, realTscBin), true);
    fs.writeFileSync(path.join(project, 'a.ts'), "export const answer: number = 'forty-two';\n");
    assert.equal(await runFreshTscCompile(project, realTscBin), false);
    assert.deepEqual(fs.readdirSync(project).sort(), ['a.ts', 'tsconfig.json']);
  });

  test('a compiler that cannot start, or runs past the timeout, is "not clean" — the watcher is then left alone', async () => {
    assert.equal(await runFreshTscCompile(project, path.join(project, 'missing-tsc')), false);
    const slowCompiler = path.join(project, 'slow-tsc.js');
    fs.writeFileSync(slowCompiler, 'setTimeout(() => process.exit(0), 60000);\n');
    assert.equal(await runFreshTscCompile(project, slowCompiler, 300), false);
  });
});

describe('the guard', () => {
  const staleSource: StaleSource = { sourcePath: 'src/bot.ts', sourceMtimeMs: 1000, outputMtimeMs: 500 };
  const idleClean = 'Found 0 errors. Watching for file changes.\n';
  const idleBroken = 'Found 12 errors. Watching for file changes.\n';
  const compilingText = 'File change detected. Starting incremental compilation...\n';

  let stale: StaleSource[];
  let freshCompileResults: boolean[];
  let freshCompiles: number;
  let restarts: number;
  let logs: string[];
  let clockMs: number;

  function createPorts(overrides: Partial<TscWatchGuardPorts> = {}): TscWatchGuardPorts {
    return {
      getNowMs: () => clockMs,
      listStaleSources: () => stale,
      runFreshCompile: async () => {
        freshCompiles += 1;
        return freshCompileResults.shift() ?? true;
      },
      restartWatcher: () => { restarts += 1; },
      log: (message) => { logs.push(message); },
      ...overrides,
    };
  }

  function createGuard(overrides: Partial<TscWatchGuardPorts> = {}) {
    return createTscWatchGuard(createPorts(overrides), { checkIntervalMs: 1000, staleGraceMs: graceMs });
  }

  beforeEach(() => {
    stale = [];
    freshCompileResults = [];
    freshCompiles = 0;
    restarts = 0;
    logs = [];
    clockMs = nowMs;
  });

  test('an idle watcher reporting 0 errors while a source is newer than its output is restarted, and the log says why', async () => {
    const guard = createGuard();
    guard.noteOutput(idleClean);
    stale = [staleSource];
    await guard.check();
    assert.equal(restarts, 1);
    assert.equal(freshCompiles, 0, 'no referee needed: a clean watcher with a source it never emitted is wrong');
    assert.match(logs.join(''), /missed a source change \(1 compiled source\(s\) newer than their output \(src\/bot\.ts\), yet it reports 0 errors\) — restarting it/);
  });

  test('nothing stale: nothing happens; a watcher still compiling or never heard from is not judged', async () => {
    const guard = createGuard();
    guard.noteOutput(idleClean);
    await guard.check();
    assert.equal(restarts, 0);

    stale = [staleSource];
    const compiling = createGuard();
    compiling.noteOutput(compilingText);
    await compiling.check();
    const silent = createGuard();
    await silent.check();
    assert.equal(restarts, 0);
  });

  test('a restarted watcher is not judged again until it says something new', async () => {
    const guard = createGuard();
    guard.noteOutput(idleClean);
    stale = [staleSource];
    await guard.check();
    await guard.check();
    assert.equal(restarts, 1, 'the second look finds a watcher that has not reported yet');
    guard.noteOutput(idleClean);
    await guard.check();
    assert.equal(restarts, 2, 'it reported clean and the source is still stale');
  });

  test('errors with a stale source: a fresh compile decides — clean there restarts the watcher', async () => {
    const guard = createGuard();
    guard.noteOutput(idleBroken);
    stale = [staleSource];
    freshCompileResults = [true];
    await guard.check();
    assert.equal(freshCompiles, 1);
    assert.equal(restarts, 1);
    assert.match(logs.join(''), /it reports 12 errors, a fresh compile of the same tree finds none/);
  });

  test('errors a fresh compile confirms are genuine leave the watcher alone and are not compiled again until the stale set changes', async () => {
    const guard = createGuard();
    guard.noteOutput(idleBroken);
    stale = [staleSource];
    freshCompileResults = [false, false];
    await guard.check();
    await guard.check();
    assert.equal(freshCompiles, 1, 'the same broken state costs one compile');
    assert.equal(restarts, 0);

    stale = [{ ...staleSource, sourceMtimeMs: 2000 }];
    await guard.check();
    assert.equal(freshCompiles, 2, 'another edit is another state');
    assert.equal(restarts, 0);
  });

  test('a watcher that moved on while the fresh compile ran is not restarted on that compile\'s word', async () => {
    let guard = createGuard();
    guard.noteOutput(idleBroken);
    stale = [staleSource];
    guard = createGuard({
      runFreshCompile: async () => {
        guard.noteOutput(compilingText); // an edit arrived: the watcher is compiling again
        return true;
      },
    });
    guard.noteOutput(idleBroken);
    await guard.check();
    assert.equal(restarts, 0);
  });

  test('overlapping checks do not start two referee compiles', async () => {
    let finishCompile: (isClean: boolean) => void = () => {};
    const guard = createGuard({
      runFreshCompile: () => new Promise<boolean>((resolve) => {
        freshCompiles += 1;
        finishCompile = resolve;
      }),
    });
    guard.noteOutput(idleBroken);
    stale = [staleSource];
    const first = guard.check();
    await guard.check();
    assert.equal(freshCompiles, 1);
    finishCompile(true);
    await first;
    assert.equal(restarts, 1);
  });

  test('a tree the guard cannot cure is restarted a few times and then reported once, not looped on', async () => {
    const guard = createGuard();
    stale = [staleSource];
    for (let attempt = 0; attempt < tscWatchRestartBudget + 2; attempt += 1) {
      guard.noteOutput(idleClean);
      await guard.check();
    }
    assert.equal(restarts, tscWatchRestartBudget);
    assert.equal(logs.filter((line) => line.includes('already restarted')).length, 1, 'said once');

    clockMs += tscWatchRestartWindowMs + 1;
    guard.noteOutput(idleClean);
    await guard.check();
    assert.equal(restarts, tscWatchRestartBudget + 1, 'an hour later the budget is back');
  });

  describe('the check timer', () => {
    afterEach(() => mock.timers.reset());

    test('start() runs the check every interval until stop(); a check that throws is logged, never an unhandled rejection', async () => {
      mock.timers.enable({ apis: ['setInterval'] });
      let listings = 0;
      const guard = createGuard({
        listStaleSources: () => {
          listings += 1;
          throw new Error('src is being rewritten');
        },
      });
      guard.noteOutput(idleClean);
      guard.start();
      guard.start(); // a second start is no second timer
      mock.timers.tick(3000);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(listings, 3);
      assert.match(logs.join(''), /the TypeScript watcher check failed: src is being rewritten/);
      guard.stop();
      mock.timers.tick(3000);
      assert.equal(listings, 3, 'stopped');
    });
  });
});

describe('the supervisor\'s two windows', () => {
  test('production without the seam, with a blank one or with a broken one', () => {
    const production = { checkIntervalMs: tscWatchCheckIntervalMs, staleGraceMs: tscWatchStaleGraceMs };
    assert.deepEqual(readTscWatchGuardTimings({}), production);
    assert.deepEqual(readTscWatchGuardTimings({ CHARNESS_TEST_TIMINGS: '  ' }), production);
    assert.deepEqual(readTscWatchGuardTimings({ CHARNESS_TEST_TIMINGS: '{not json' }), production);
    assert.deepEqual(readTscWatchGuardTimings({ CHARNESS_TEST_TIMINGS: 'null' }), production);
  });

  test('a flow\'s override shortens a window; a value that would lengthen it or is not a whole positive number is ignored', () => {
    assert.deepEqual(readTscWatchGuardTimings({ CHARNESS_TEST_TIMINGS: JSON.stringify({ tscWatchCheckIntervalMs: 500, tscWatchStaleGraceMs: 2000, telegramSendIntervalMs: 200 }) }), { checkIntervalMs: 500, staleGraceMs: 2000 });
    const ignored = { tscWatchCheckIntervalMs: tscWatchCheckIntervalMs + 1, tscWatchStaleGraceMs: -5 };
    assert.deepEqual(readTscWatchGuardTimings({ CHARNESS_TEST_TIMINGS: JSON.stringify(ignored) }), { checkIntervalMs: tscWatchCheckIntervalMs, staleGraceMs: tscWatchStaleGraceMs });
    assert.deepEqual(readTscWatchGuardTimings({ CHARNESS_TEST_TIMINGS: JSON.stringify({ tscWatchCheckIntervalMs: 1.5, tscWatchStaleGraceMs: '5' }) }), { checkIntervalMs: tscWatchCheckIntervalMs, staleGraceMs: tscWatchStaleGraceMs });
  });
});
