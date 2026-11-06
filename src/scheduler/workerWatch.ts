import type { CheckRunResult } from './checkRun';

/**
 * @description The one recipe for watching a detached worker (an agent process an orchestrating agent launched) with a
 * bot check (`schedule_create` + `checkCommand`). The bot's own texts (`mcpSurface.ts`: the Telegram instructions and
 * the `schedule_create` description) and the `charness-manager` skill (`agent-plugin/`, verbatim —
 * `agentPluginSkills.test.ts` holds them equal) all name these. Kept apart from the MCP surface so a test's fake agent
 * can arm the real recipe without loading the server.
 */

/** Minutes without any change in the run directory after which the recipe calls a worker hung. */
export const workerWatchSilenceMinutes = 45;

/**
 * The exit codes the recipe's `checkCommand` ends with. The bot reads them back (`getWorkerWatchEnd`) to say in the topic
 * whether the worker finished or went silent, so the command below and the reader share these.
 */
export const workerWatchExitCode = { processGone: 1, runDirSilent: 2 } as const;

/**
 * The `checkCommand` that watches a detached worker (an agent process an orchestrating agent launched), with `<pid>`
 * and `<run-dir>` for the agent to fill in. It fails on EITHER signal: the worker's process is gone, or nothing in its
 * run directory changed for {@link workerWatchSilenceMinutes} minutes. A check of `kill -0 <pid>` alone stays green
 * while a worker hangs — the reason this recipe exists. The run dir is quoted: a path with a space would otherwise read
 * as two folders and fire at once as "no change". The `charness-manager` skill (`agent-plugin/`) carries it verbatim (a
 * unit test holds them equal).
 */
export const workerWatchCheckCommand =
  `kill -0 <pid> 2>/dev/null || { echo "worker <pid> exited"; exit ${workerWatchExitCode.processGone}; }; [ -n "$(find "<run-dir>" -mmin -${workerWatchSilenceMinutes} -print -quit)" ] || { echo "<run-dir>: no change for ${workerWatchSilenceMinutes} min"; exit ${workerWatchExitCode.runDirSilent}; }`;
/**
 * How often a worker watch runs: a hang or an exit is noticed within five minutes. The status line rides the passing runs
 * (`workerWatchStatusArguments`), so a slower tick would stretch its 15-minute rhythm (a 10-minute tick posts every 20).
 */
export const workerWatchCheckCron = '*/5 * * * *';
/** Minutes between the bot's status lines of a worker watch (the recipe passes it, whatever the default is). */
export const workerWatchStatusEveryMinutes = 15;
/**
 * The arguments that make the BOT post a silent status line into the topic every 15 minutes while the worker lives
 * (`scheduler/checkStatus.ts`): no agent wake, no tokens, so a topic whose agent is idle, compacting or stopped never looks
 * frozen. `<run-dir>` is the worker's run directory, where its `events*.jsonl` log is. An agent never arms a status
 * schedule of its own.
 */
export const workerWatchStatusArguments = `statusWorkerRunDir: "<run-dir>", statusEveryMinutes: ${workerWatchStatusEveryMinutes}`;

/** How a worker watch ended: the worker's process is gone, or its run directory went quiet. */
export type WorkerWatchEnd = 'finished' | 'silent';

/**
 * @description Which of the recipe's two signals a failed run was, or `null` when it was neither (a timeout, a signal, a
 * start error, any other exit code — a watch the agent armed with a command of its own). Only a run that exited by itself
 * counts: a timed-out run's exit code says nothing about the worker.
 */
export function getWorkerWatchEnd(result: CheckRunResult): WorkerWatchEnd | null {
  if (result.isTimedOut || result.startError !== undefined) return null;
  if (result.exitCode === workerWatchExitCode.processGone) return 'finished';
  if (result.exitCode === workerWatchExitCode.runDirSilent) return 'silent';
  return null;
}
