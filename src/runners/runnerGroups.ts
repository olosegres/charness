import { buildPairedRunnerConfig } from '../remoteRun/pairedRunners';
import { createRunnerClient, type RunnerClient } from '../remoteRun/runnerClient';
import { RunnerUnreachableError } from '../remoteRun/remoteRunError';
import { ensureRemoteRunCacheDir } from '../remoteRun/ssh';
import { formatGroupLimits, type RunnerConfig } from '../remoteRun/runnersConfig';
import type { HubContext } from './hubPaths';
import type { PairedRunner } from './hubRegistry';
import { getRunnerLinkStatus } from './linkControl';

/**
 * @description Tell a paired runner NOW how many jobs it may run at once (`runner.sh apply-groups`: Pueue's `parallel`), instead of leaving it to the next
 * job's `prepare`. Best effort, and the outcome is said: `applied`; `offline` (the link is down — the number is in the registry and the next job's `prepare`
 * sets it); `failed` (the runner answered with an error, or its paths cannot be put on an ssh command line). Pueue's limit only gates STARTS: a lowered one
 * stops no job that runs.
 */

/** @name RunnerGroupsOutcome @description What became of the call: told, not reachable, or refused. */
export type RunnerGroupsOutcome = 'applied' | 'offline' | 'failed';

export interface RunnerGroupsDeps {
  isLinkOnline: (ctx: HubContext, runnerId: string) => Promise<boolean>;
  createClient: (config: RunnerConfig, cacheDir: string) => Pick<RunnerClient, 'ensureScript' | 'call'>;
  log: (line: string) => void;
}

/** A tap in `/runners` waits for the answer: the whole exchange (script check, call) is bounded by this, and a runner that is slower is told the number applies at its next job. */
export const runnerGroupsDeadlineMs = 10 * 1000;

const defaultDeps: RunnerGroupsDeps = {
  isLinkOnline: async (ctx, runnerId) => (await getRunnerLinkStatus(ctx.dir, runnerId)).isOnline,
  createClient: (config, cacheDir) => createRunnerClient(config, cacheDir),
  log: (line) => { console.error(line); },
};

/** @description Apply the groups of `runner` (as the registry has them now) on the machine. Never throws. */
export async function applyRunnerGroups(ctx: HubContext, runner: PairedRunner, cacheDir: string, deps: RunnerGroupsDeps = defaultDeps, deadlineMs: number = runnerGroupsDeadlineMs): Promise<RunnerGroupsOutcome> {
  try {
    if (!(await deps.isLinkOnline(ctx, runner.id))) return 'offline';
    const config = buildPairedRunnerConfig(runner, { hubDir: ctx.dir, nodePath: ctx.nodePath, cliPath: ctx.cliPath });
    ensureRemoteRunCacheDir(cacheDir);
    const client = deps.createClient(config, cacheDir);
    const signal = AbortSignal.timeout(deadlineMs);
    await client.ensureScript(signal);
    const result = await client.call('apply-groups', [formatGroupLimits(config.groups)], { signal, timeoutMs: deadlineMs });
    if (result.exitCode === 0) return 'applied';
    deps.log(`runners: the jobs-at-once limit of "${runner.name}" was not applied (${result.isTimedOut ? 'no answer in time' : `exit ${result.exitCode ?? 'none'}`}${result.stderr.trim() === '' ? '' : `: ${result.stderr.trim().split('\n').pop()}`})`);
    return 'failed';
  } catch (error) {
    if (error instanceof RunnerUnreachableError) return 'offline';
    deps.log(`runners: the jobs-at-once limit of "${runner.name}" was not applied (${error instanceof Error ? error.message : 'unknown error'})`);
    return 'failed';
  }
}
