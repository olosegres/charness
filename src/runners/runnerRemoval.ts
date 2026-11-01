import { buildPairedRunnerConfig } from '../remoteRun/pairedRunners';
import { ensureRemoteRunCacheDir, getRemoteRunCacheDir, joinShellWords, runSshCommand } from '../remoteRun/ssh';
import { findPairedRunner, removePairedRunner, setPairedRunnerPaused } from './hubPairing';
import type { HubContext } from './hubPaths';
import { readPairedFile, type PairedRunner } from './hubRegistry';
import { cutRunnerLink, getRunnerLinkStatus } from './linkControl';

/**
 * @description Removing a runner from the hub, and ending the work the hub's agents left on it. Pueue outlives any link by design, so
 * cutting the link leaves their background jobs running on a machine that is no longer theirs. When the runner is ONLINE the hub says so
 * itself, over the link that is still open: it runs `pueue reset --force` there (the queue's private Pueue, found from the work dir the
 * runner reported). That is certain — unlike the runner's own inference from a refused key, which a hub with a locked home folder or a
 * wrong file mode produces too (see `runnerUtility/linkLoop.ts`) — and it works whatever the runner's version.
 *
 * The ORDER matters: the gate ends a link as soon as its runner has left `paired.json`, which would cut the reset off half-way, so the
 * runner is paused (no new job is sent to it meanwhile) and its jobs are stopped while it is still paired; only then it is removed and
 * its link cut.
 */

const stopJobsTimeoutMs = 20 * 1000;

/** What became of the jobs on the removed runner: ended through the link; could not be ended from here; or the runner was offline. */
export type RunnerJobsStop = 'stopped' | 'failed' | 'offline';

export interface RunnerRemovalDeps {
  isLinkOnline: (ctx: HubContext, runnerId: string) => Promise<boolean>;
  runSsh: typeof runSshCommand;
  cacheDir: string;
  log: (line: string) => void;
}

function createRemovalDeps(): RunnerRemovalDeps {
  return {
    isLinkOnline: async (ctx, runnerId) => (await getRunnerLinkStatus(ctx.dir, runnerId)).isOnline,
    runSsh: runSshCommand,
    cacheDir: getRemoteRunCacheDir(),
    log: (line) => { console.error(line); },
  };
}

/** Is the runner's link up? `null` when that could not be read (logged): a runner nobody can tell about is not «offline». */
async function checkIsLinkOnline(ctx: HubContext, runner: PairedRunner, deps: RunnerRemovalDeps): Promise<boolean | null> {
  try {
    return await deps.isLinkOnline(ctx, runner.id);
  } catch (error) {
    deps.log(`runners: could not tell whether "${runner.name}" is online (${error instanceof Error ? error.message : 'unknown error'}); its jobs are not stopped from here`);
    return null;
  }
}

/** Reset the queue of a runner whose link is up. Never throws: a failure is logged and told as `failed`. */
async function resetQueueOverLink(ctx: HubContext, runner: PairedRunner, deps: RunnerRemovalDeps): Promise<'stopped' | 'failed'> {
  try {
    const config = buildPairedRunnerConfig(runner, { hubDir: ctx.dir, nodePath: ctx.nodePath, cliPath: ctx.cliPath });
    if (config.pueue?.bin === undefined || config.pueue.config === undefined) {
      deps.log(`runners: cannot stop the jobs of "${runner.name}" from here: its work folder does not follow the runner utility's layout`);
      return 'failed';
    }
    ensureRemoteRunCacheDir(deps.cacheDir);
    // No shared connection: this one call must not leave a master behind for the link that is about to be cut.
    const noMaster = { ...config, sshOptions: ['-o', 'ControlMaster=no', ...(config.sshOptions ?? [])] };
    const result = await deps.runSsh({ runner: noMaster, cacheDir: deps.cacheDir, remoteCommand: joinShellWords([config.pueue.bin, '--config', config.pueue.config, 'reset', '--force']), timeoutMs: stopJobsTimeoutMs });
    if (result.exitCode === 0) return 'stopped';
    deps.log(`runners: the jobs of "${runner.name}" were not stopped (${result.isTimedOut ? 'no answer in time' : `exit ${result.exitCode ?? 'none'}`})`);
    return 'failed';
  } catch (error) {
    deps.log(`runners: could not stop the jobs of "${runner.name}" (${error instanceof Error ? error.message : 'unknown error'})`);
    return 'failed';
  }
}

/** @description Stop every job of an online runner's queue through its link. Never throws: a failure is logged and told as `failed` — the runner then falls back to what it can tell by itself. */
export async function stopRunnerJobsOverLink(ctx: HubContext, runner: PairedRunner, deps: RunnerRemovalDeps = createRemovalDeps()): Promise<RunnerJobsStop> {
  const isOnline = await checkIsLinkOnline(ctx, runner, deps);
  if (isOnline === null) return 'failed';
  return isOnline ? resetQueueOverLink(ctx, runner, deps) : 'offline';
}

/**
 * @description Remove `nameOrId`: while it is still paired, pause it and stop its jobs through the link (when it is online); then drop it
 * from the registry (its key line goes with it) and cut the link. `null` when no such runner is paired. A registry that cannot be
 * written stops the call before the link is touched.
 */
export async function removeRunnerAndEndItsWork(ctx: HubContext, nameOrId: string, nowMs: number, deps?: RunnerRemovalDeps): Promise<{ runner: PairedRunner; jobs: RunnerJobsStop } | null> {
  const resolvedDeps = deps ?? createRemovalDeps();
  const found = findPairedRunner(readPairedFile(ctx.dir).runners, nameOrId);
  if (found === undefined) return null;
  const isOnline = await checkIsLinkOnline(ctx, found, resolvedDeps);
  let jobs: RunnerJobsStop = isOnline === null ? 'failed' : 'offline';
  if (isOnline === true) {
    // No agent is sent to it from now on; the reset below takes seconds.
    await setPairedRunnerPaused(ctx, found.id, true).catch((error) => { resolvedDeps.log(`runners: could not pause "${found.name}" before stopping its jobs (${error instanceof Error ? error.message : 'unknown error'})`); });
    jobs = await resetQueueOverLink(ctx, found, resolvedDeps);
  }
  const removed = await removePairedRunner(ctx, found.id, nowMs);
  cutRunnerLink(ctx.dir, found.id);
  return removed === null ? null : { runner: removed, jobs };
}
