import * as fs from 'fs';
import * as path from 'path';
import {
  checkIsProcessIdentityCurrent,
  startExternallyParentedProcess,
  type ExternalProcessIdentity,
} from '../installManager';
import { getSttChildEnv } from './sttChildEnv';
import {
  getSttPaths,
  isGigaamInstalling,
  readSttInstallProgress,
  type SttInstallProgress,
} from './sttInstall';

/**
 * @description The install job manager, shared by the boot auto-install and the `/stt` "Enable local
 * recognition" button. The install itself (`runSttInstall`) runs in a DETACHED process
 * (`sttInstallEntry`, hosted outside the bot's process tree) so a hot reload in the middle of a 400 MB
 * download never kills it; this module launches it, or attaches to one that is already running, and polls the
 * progress file the job writes, handing every report to the caller.
 *
 * - **One job at a time**, in this process (a second `start` attaches its reporter to the running one) and on
 *   disk (the job's own lock directory): a start finding the lock held attaches instead of launching.
 * - **A reloaded worker re-attaches**: the same call, with the job already running.
 * - **No retry loop.** On success nothing is spawned (the next voice starts the engine); on failure the error
 *   and the log tail are reported once, and the operator decides.
 */

const pollIntervalMs = 3_000;
const entryFileName = 'sttInstallEntry.js';
const forceFlag = '--force';
/** What a job that left nothing readable behind is reported as. */
export const installJobEndedWithoutResultError = 'the install job ended without a result (see install.log)';

/** Gets every progress report of a job, the final one included; an error in it never stops the job. */
export type SttInstallReporter = (progress: SttInstallProgress) => void | Promise<void>;

export interface SttInstallJobOptions {
  reportTo: SttInstallReporter;
  /** Rebuild even a current install. */
  force?: boolean;
}

export interface SttInstallJobDeps {
  /** Start the detached install job. */
  launchEntry: (extraArgs: string[]) => Promise<ExternalProcessIdentity>;
  checkIsLaunchedAlive: (identity: ExternalProcessIdentity) => boolean;
  /** An install lock is held by a live process. */
  checkIsInstalling: () => boolean;
  readProgress: () => SttInstallProgress | null;
  /** Forget the previous run's progress, so its terminal line is never mistaken for this run's. */
  clearProgress: () => void;
  sleep: (ms: number) => Promise<void>;
  pollIntervalMs: number;
  log: (line: string) => void;
}

export interface SttInstallJobManager {
  /** Launch the install or attach to the running one; resolves with the final report (`done` or `failed`). */
  start: (options: SttInstallJobOptions) => Promise<SttInstallProgress>;
}

function checkIsTerminal(progress: SttInstallProgress | null): progress is SttInstallProgress {
  return progress !== null && (progress.phase === 'done' || progress.phase === 'failed');
}

export function createFailedInstallProgress(error: string): SttInstallProgress {
  return { phase: 'failed', detail: '', bytesDownloaded: 0, error, logTail: [] };
}

/**
 * @description The compiled entry next to this module (`dist/stt/sttInstallEntry.js`); from sources run through
 * `tsx` there is no `.js` beside the `.ts`, so the build output under the package root is used.
 */
export function getSttInstallEntryPath(): string {
  const moduleDir = fs.realpathSync(__dirname);
  const sibling = path.join(moduleDir, entryFileName);
  return fs.existsSync(sibling) ? sibling : path.join(moduleDir, '..', '..', 'dist', 'stt', entryFileName);
}

/** @description The production dependencies; the data dir is read when used (a cold start may move the default one). */
export function createDefaultSttInstallJobDeps(getDataDir: () => string): SttInstallJobDeps {
  return {
    launchEntry: (extraArgs) =>
      startExternallyParentedProcess(process.execPath, [getSttInstallEntryPath(), getDataDir(), ...extraArgs], getSttChildEnv()),
    checkIsLaunchedAlive: checkIsProcessIdentityCurrent,
    checkIsInstalling: () => isGigaamInstalling(getDataDir()),
    readProgress: () => readSttInstallProgress(getDataDir()),
    clearProgress: () => fs.rmSync(getSttPaths(getDataDir()).progressFile, { force: true }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    pollIntervalMs,
    log: (line) => console.log(line),
  };
}

/** @description The install job manager over its dependencies. */
export function createSttInstallJobManager(deps: SttInstallJobDeps): SttInstallJobManager {
  let running: { reporters: Set<SttInstallReporter>; done: Promise<SttInstallProgress> } | null = null;

  async function notify(reporters: ReadonlySet<SttInstallReporter>, progress: SttInstallProgress): Promise<void> {
    // async wrapper: a reporter that throws synchronously must reject its own promise, not escape the map
    const outcomes = await Promise.allSettled([...reporters].map(async (report) => report(progress)));
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') deps.log(`[STT] install report failed: ${outcome.reason instanceof Error ? outcome.reason.message : 'unknown error'}`);
    }
  }

  async function runJob(reporters: ReadonlySet<SttInstallReporter>, force: boolean): Promise<SttInstallProgress> {
    let launched: ExternalProcessIdentity | null = null;
    if (deps.checkIsInstalling()) {
      deps.log('[STT] install: attaching to the running job');
    } else {
      deps.clearProgress();
      try {
        launched = await deps.launchEntry(force ? [forceFlag] : []);
      } catch (error) {
        const failed = createFailedInstallProgress(`the install job could not be started: ${error instanceof Error ? error.message : 'unknown error'}`);
        await notify(reporters, failed);
        return failed;
      }
    }
    for (;;) {
      await deps.sleep(deps.pollIntervalMs);
      const progress = deps.readProgress();
      if (progress) {
        await notify(reporters, progress);
        if (checkIsTerminal(progress)) return progress;
      }
      const isJobGone = !deps.checkIsInstalling() && (launched === null || !deps.checkIsLaunchedAlive(launched));
      if (!isJobGone) continue;
      // The job may have written its last line just before it left: read once more before calling it lost.
      const last = deps.readProgress();
      if (checkIsTerminal(last)) {
        await notify(reporters, last);
        return last;
      }
      const failed = createFailedInstallProgress(installJobEndedWithoutResultError);
      await notify(reporters, failed);
      return failed;
    }
  }

  return {
    start({ reportTo, force = false }) {
      if (running) {
        running.reporters.add(reportTo);
        return running.done;
      }
      const reporters = new Set<SttInstallReporter>([reportTo]);
      const job = { reporters, done: runJob(reporters, force) };
      running = job;
      void job.done.finally(() => {
        if (running === job) running = null;
      });
      return job.done;
    },
  };
}
