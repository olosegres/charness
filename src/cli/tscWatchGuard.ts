import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { checkIsEmittedSource } from '../selfUpdate/emittedSource';

/**
 * @description The hot supervisor's check that its `tsc -w` is not blind. TypeScript's watch mode learns that a source
 * changed ONLY from file-system events, and Node reads them through one inotify queue (16384 events by default): a burst —
 * a pull of dozens of commits followed by `yarn install` while the compiler is busy — overflows it and the events are
 * dropped without a word. The watcher then keeps the old text of the files it missed: it reports errors where an old
 * definition meets new callers, or reports a clean build that emitted nothing, `touch tsconfig.json` re-reads none of the
 * files (measured), and only a new `tsc -w` is right again — while the worker keeps running the old build and nobody is told.
 *
 * The guard compares what the watcher says with what is on disk: a compiled source NEWER than its output, a minute after the
 * change, while the watcher is idle. With "0 errors" that is a missed change and the watcher is restarted. With errors it
 * may just be a broken edit, so a one-shot compile of the same tree decides: clean there means the watcher is wrong. Pure
 * decisions and the file scan live here; the supervisor (`hot.ts`) wires the process side and loads nothing else for it.
 */

/** How often the supervisor compares the watcher with the tree (production). */
export const tscWatchCheckIntervalMs = 30 * 1000;
/** How long a source may stay newer than its output before the watcher is blamed (production): far above a compile's debounce. */
export const tscWatchStaleGraceMs = 60 * 1000;
/** The watcher restarts at most this many times within {@link tscWatchRestartWindowMs}: a tree the guard cannot cure is reported, not looped on. */
export const tscWatchRestartBudget = 3;
export const tscWatchRestartWindowMs = 60 * 60 * 1000;
/** A one-shot compile that runs longer is given up on (production tree: about 30 s). */
export const tscFreshCompileTimeoutMs = 5 * 60 * 1000;

/** The test-only timing seam's variable (`testTimingsEnvName` in `testTimings.ts`, which this module must not import — see {@link readTscWatchGuardTimings}). */
const testTimingsVariableName = 'CHARNESS_TEST_TIMINGS';
const sourceDirectoryName = 'src';
const outputDirectoryName = 'dist';
const sourceExtension = '.ts';
const outputExtension = '.js';
const maxExamplesInReason = 3;
/** The tail of tsc's output kept between chunks so a marker split across two reads is still found. */
const outputTailLength = 200;

const compilingMarker = /Starting compilation in watch mode|File change detected\. Starting incremental compilation/g;
const idleMarker = /Found (\d+) errors?\. Watching for file changes\./g;

/** What the watcher last said about itself. */
export type WatcherStatus = { kind: 'unknown' } | { kind: 'compiling' } | { kind: 'idle'; errorCount: number };

/**
 * @description The watcher's status after a chunk of its output: the LAST marker in `text` wins (a chunk may hold a whole
 * rebuild), none leaves `previous`.
 */
export function readWatcherStatus(text: string, previous: WatcherStatus): WatcherStatus {
  let status = previous;
  let statusIndex = -1;
  for (const match of text.matchAll(compilingMarker)) {
    if (match.index >= statusIndex) {
      status = { kind: 'compiling' };
      statusIndex = match.index;
    }
  }
  for (const match of text.matchAll(idleMarker)) {
    if (match.index >= statusIndex) {
      status = { kind: 'idle', errorCount: Number(match[1]) };
      statusIndex = match.index;
    }
  }
  return status;
}

/** A compiled source the watcher has not turned into its output. */
export interface StaleSource {
  /** Relative to the checkout, forward slashes (`src/bot.ts`). */
  sourcePath: string;
  sourceMtimeMs: number;
  /** `null`: the output does not exist. */
  outputMtimeMs: number | null;
}

/** The file-system calls the scan needs. */
export interface StaleScanFs {
  readDirectory: (directory: string) => fs.Dirent[];
  getModifiedMs: (filePath: string) => number | null;
}

const defaultStaleScanFs: StaleScanFs = {
  readDirectory: (directory) => fs.readdirSync(directory, { withFileTypes: true }),
  getModifiedMs: (filePath) => {
    try {
      return fs.statSync(filePath).mtimeMs;
    } catch {
      return null;
    }
  },
};

/** `src/cli/hot.ts` → `dist/cli/hot.js` (the tsconfig's `rootDir` / `outDir`). */
export function getOutputPath(sourcePath: string): string {
  const withoutRoot = sourcePath.slice(`${sourceDirectoryName}/`.length, -sourceExtension.length);
  return `${outputDirectoryName}/${withoutRoot}${outputExtension}`;
}

/**
 * @description The compiled sources under `projectRoot/src` whose output is older than they are (or missing) and which changed
 * more than `graceMs` before `nowMs` — the ones a watcher that is up to date has long since emitted. A file the compiler skips
 * (tests, the release tooling, declarations) is never listed.
 */
export function listStaleSources(projectRoot: string, nowMs: number, graceMs: number, scanFs: StaleScanFs = defaultStaleScanFs): StaleSource[] {
  const stale: StaleSource[] = [];
  const visit = (relativeDirectory: string): void => {
    for (const entry of scanFs.readDirectory(path.join(projectRoot, relativeDirectory))) {
      const relativePath = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) {
        visit(relativePath);
        continue;
      }
      if (!checkIsEmittedSource(relativePath)) continue;
      const sourceMtimeMs = scanFs.getModifiedMs(path.join(projectRoot, relativePath));
      if (sourceMtimeMs === null || nowMs - sourceMtimeMs < graceMs) continue;
      const outputMtimeMs = scanFs.getModifiedMs(path.join(projectRoot, getOutputPath(relativePath)));
      if (outputMtimeMs === null || outputMtimeMs < sourceMtimeMs) stale.push({ sourcePath: relativePath, sourceMtimeMs, outputMtimeMs });
    }
  };
  visit(sourceDirectoryName);
  return stale;
}

/**
 * @description Compile the project once with a fresh TypeScript program and write nothing (`tsc --noEmit`): `true` when it is
 * clean. The guard's referee when the watcher reports errors — a watcher that missed file events is wrong, a fresh program
 * reads every file again. A compile that fails to run or outlives `timeoutMs` is "not clean": the watcher is left as it is.
 */
export function runFreshTscCompile(projectRoot: string, tscBin: string, timeoutMs: number = tscFreshCompileTimeoutMs): Promise<boolean> {
  return new Promise((resolve) => {
    const compile = spawn(process.execPath, [tscBin, '--noEmit'], { cwd: projectRoot, stdio: 'ignore' });
    const timeout = setTimeout(() => compile.kill('SIGKILL'), timeoutMs);
    compile.on('error', () => {
      clearTimeout(timeout);
      resolve(false);
    });
    compile.on('exit', (code) => {
      clearTimeout(timeout);
      resolve(code === 0);
    });
  });
}

/** The ports the guard drives; the supervisor gives the real ones, a test fakes them. */
export interface TscWatchGuardPorts {
  getNowMs: () => number;
  listStaleSources: (graceMs: number) => StaleSource[];
  /** Compile the tree once with a fresh program, writing nothing; `true` when it compiles clean. */
  runFreshCompile: () => Promise<boolean>;
  /** Stop the watcher and start a new one (a fresh program reads every file again). */
  restartWatcher: () => void;
  log: (message: string) => void;
}

export interface TscWatchGuardOptions {
  checkIntervalMs: number;
  staleGraceMs: number;
}

export interface TscWatchGuard {
  /** Feed the watcher's stdout. */
  noteOutput: (text: string) => void;
  /** One comparison of the watcher with the tree; resolves when it is done (a test calls it directly). */
  check: () => Promise<void>;
  start: () => void;
  stop: () => void;
}

function formatStaleReason(stale: readonly StaleSource[]): string {
  const examples = stale.slice(0, maxExamplesInReason).map((source) => source.sourcePath).join(', ');
  return `${stale.length} compiled source(s) newer than their output (${examples}${stale.length > maxExamplesInReason ? ', …' : ''})`;
}

export function createTscWatchGuard(ports: TscWatchGuardPorts, options: TscWatchGuardOptions): TscWatchGuard {
  let status: WatcherStatus = { kind: 'unknown' };
  let outputTail = '';
  let timer: NodeJS.Timeout | null = null;
  let isChecking = false;
  /** The stale set a fresh compile already found genuinely broken: not compiled again until it changes. */
  let confirmedBrokenSignature: string | null = null;
  let restartTimesMs: number[] = [];
  let isBudgetReported = false;
  /** The stale set the last restart was for, and a stale set a restart did not cure (the watcher cannot emit it): not restarted for again. */
  let restartedForSignature: string | null = null;
  let uncuredSignature: string | null = null;

  /** Restart the watcher unless the hour's budget is spent; whether it did. */
  const restartWatcher = (reason: string): boolean => {
    const nowMs = ports.getNowMs();
    restartTimesMs = restartTimesMs.filter((restartMs) => nowMs - restartMs < tscWatchRestartWindowMs);
    if (restartTimesMs.length >= tscWatchRestartBudget) {
      if (!isBudgetReported) {
        isBudgetReported = true;
        ports.log(`charness hot: the TypeScript watcher is out of step with the sources (${reason}) but was already restarted ${restartTimesMs.length} times in the last hour — leaving it as it is\n`);
      }
      return false;
    }
    restartTimesMs.push(nowMs);
    isBudgetReported = false;
    ports.log(`charness hot: the TypeScript watcher missed a source change (${reason}) — restarting it\n`);
    status = { kind: 'unknown' };
    outputTail = '';
    confirmedBrokenSignature = null;
    ports.restartWatcher();
    return true;
  };

  const check = async (): Promise<void> => {
    if (isChecking || status.kind !== 'idle') return;
    isChecking = true;
    try {
      const stale = ports.listStaleSources(options.staleGraceMs);
      if (stale.length === 0) {
        confirmedBrokenSignature = null;
        restartedForSignature = null;
        uncuredSignature = null;
        return;
      }
      const reason = formatStaleReason(stale);
      const staleSignature = stale.map((source) => `${source.sourcePath}@${source.sourceMtimeMs}`).join(',');
      if (staleSignature === uncuredSignature) return;
      if (staleSignature === restartedForSignature) {
        // A fresh watcher compiled the whole tree and these sources are STILL newer than their output: it cannot emit them (a
        // modification time in the future, a path tsconfig excludes that the stale scan does not know) — restarting again is a loop.
        uncuredSignature = staleSignature;
        ports.log(`charness hot: ${reason} after the TypeScript watcher was restarted for exactly these — it cannot emit them; not restarting it for this again\n`);
        return;
      }
      const reportedErrors = status.errorCount;
      if (reportedErrors === 0) {
        if (restartWatcher(`${reason}, yet it reports 0 errors`)) restartedForSignature = staleSignature;
        return;
      }
      const signature = `${reportedErrors}|${staleSignature}`;
      if (signature === confirmedBrokenSignature) return;
      const isCleanOnFreshCompile = await ports.runFreshCompile();
      // The watcher moved on while the compile ran (an edit, a rebuild): the next tick judges the new state.
      if (status.kind !== 'idle' || status.errorCount !== reportedErrors) return;
      if (isCleanOnFreshCompile) {
        if (restartWatcher(`${reason}; it reports ${reportedErrors} errors, a fresh compile of the same tree finds none`)) restartedForSignature = staleSignature;
      } else {
        confirmedBrokenSignature = signature;
      }
    } finally {
      isChecking = false;
    }
  };

  return {
    noteOutput: (text) => {
      const inspected = outputTail + text;
      status = readWatcherStatus(inspected, status);
      outputTail = inspected.slice(-outputTailLength);
    },
    check,
    start: () => {
      if (timer !== null) return;
      timer = setInterval(() => {
        check().catch((error) => ports.log(`charness hot: the TypeScript watcher check failed: ${error instanceof Error ? error.message : error}\n`));
      }, options.checkIntervalMs);
      timer.unref();
    },
    stop: () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}

/** The two guard windows a flow may shorten through `CHARNESS_TEST_TIMINGS` (`testTimings.ts` validates the whole JSON in the worker). */
type TscWatchGuardTimingOverrides = Partial<Record<'tscWatchCheckIntervalMs' | 'tscWatchStaleGraceMs', number>>;

/**
 * @description The two windows the supervisor's guard runs with: production, or shortened by a flow through
 * `CHARNESS_TEST_TIMINGS`. The supervisor does not load `testTimings.ts` (it pulls half the bot in, and every module the
 * supervisor loads is one whose change asks it to re-execute): it reads just these two keys, and a value that is not a whole
 * number of ms within the production window is ignored — the worker's boot is what refuses it by name.
 */
export function readTscWatchGuardTimings(env: NodeJS.ProcessEnv): TscWatchGuardOptions {
  const productionTimings: TscWatchGuardOptions = { checkIntervalMs: tscWatchCheckIntervalMs, staleGraceMs: tscWatchStaleGraceMs };
  const rawTestTimings = env[testTimingsVariableName];
  if (rawTestTimings === undefined || rawTestTimings.trim() === '') return productionTimings;
  let overrides: TscWatchGuardTimingOverrides | null;
  try {
    overrides = JSON.parse(rawTestTimings);
  } catch {
    return productionTimings;
  }
  if (overrides === null || typeof overrides !== 'object') return productionTimings;
  const pick = (overrideMs: number | undefined, productionMs: number): number =>
    overrideMs !== undefined && Number.isInteger(overrideMs) && overrideMs > 0 && overrideMs <= productionMs ? overrideMs : productionMs;
  return {
    checkIntervalMs: pick(overrides.tscWatchCheckIntervalMs, tscWatchCheckIntervalMs),
    staleGraceMs: pick(overrides.tscWatchStaleGraceMs, tscWatchStaleGraceMs),
  };
}
