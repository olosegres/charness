import { buildPairedRunnerConfig, PairedRunnerSetupError } from '../remoteRun/pairedRunners';
import { ensureRemoteRunCacheDir, getRemoteRunCacheDir, joinShellWords, runSshCommand } from '../remoteRun/ssh';
import { removePairedRunner } from './hubPairing';
import type { HubContext } from './hubPaths';
import type { PairedRunner } from './hubRegistry';
import { cutRunnerLink, getRunnerLinkStatus } from './linkControl';

/**
 * @description Removing a runner from the hub, and ending the work the hub's agents left on it. Pueue outlives any link by design, so
 * cutting the link leaves their background jobs running on a machine that is no longer theirs. When the runner is ONLINE the hub says so
 * itself, over the link that is still open: it runs `pueue reset --force` there (the queue's private Pueue, found from the work dir the
 * runner reported). That is certain — unlike the runner's own inference from a refused key, which a hub with a locked home folder or a
 * wrong file mode produces too (see `runnerUtility/linkLoop.ts`) — and it works whatever the runner's version.
 */

const stopJobsTimeoutMs = 20 * 1000;

export interface RunnerRemovalDeps {
  isLinkOnline: (ctx: HubContext, runnerId: string) => Promise<boolean>;
  runSsh: typeof runSshCommand;
  cacheDir: string;
}

function createRemovalDeps(): RunnerRemovalDeps {
  return {
    isLinkOnline: async (ctx, runnerId) => (await getRunnerLinkStatus(ctx.dir, runnerId)).isOnline,
    runSsh: runSshCommand,
    cacheDir: getRemoteRunCacheDir(),
  };
}

/** @description Stop every job of an online runner's queue through its link. `false` when there was nothing to do or it did not work — the runner then falls back to what it can tell by itself. */
export async function stopRunnerJobsOverLink(ctx: HubContext, runner: PairedRunner, deps: RunnerRemovalDeps = createRemovalDeps()): Promise<boolean> {
  if (!(await deps.isLinkOnline(ctx, runner.id))) return false;
  try {
    const config = buildPairedRunnerConfig(runner, { hubDir: ctx.dir, nodePath: ctx.nodePath, cliPath: ctx.cliPath });
    if (config.pueue?.bin === undefined || config.pueue.config === undefined) return false;
    ensureRemoteRunCacheDir(deps.cacheDir);
    // No shared connection: this one call must not leave a master behind for the link that is about to be cut.
    const noMaster = { ...config, sshOptions: ['-o', 'ControlMaster=no', ...(config.sshOptions ?? [])] };
    const result = await deps.runSsh({ runner: noMaster, cacheDir: deps.cacheDir, remoteCommand: joinShellWords([config.pueue.bin, '--config', config.pueue.config, 'reset', '--force']), timeoutMs: stopJobsTimeoutMs });
    return result.exitCode === 0;
  } catch (error) {
    if (error instanceof PairedRunnerSetupError) return false;
    throw error;
  }
}

/**
 * @description Remove `nameOrId` from the registry (its key line goes with it), end the jobs on it through the still-open link, then cut the
 * link. `null` when no such runner is paired.
 */
export async function removeRunnerAndEndItsWork(ctx: HubContext, nameOrId: string, nowMs: number, deps?: RunnerRemovalDeps): Promise<PairedRunner | null> {
  const removed = await removePairedRunner(ctx, nameOrId, nowMs);
  if (removed === null) return null;
  await stopRunnerJobsOverLink(ctx, removed, deps);
  cutRunnerLink(ctx.dir, removed.id);
  return removed;
}
