import * as fs from 'fs';
import * as path from 'path';
import { writeTextFileAtomically } from '../configDirFile';
import { runCommand, type CommandRunner } from '../selfUpdate/commandRunner';
import type { RunnerHomePaths } from './runnerHome';

/**
 * @description The runner's private Pueue: its config under `~/.charness-runner/pueue/` (own directories and unix socket — never the
 * account's default Pueue), and a daemon that is started if it is not running. Pueue is a service of its own: stopping or restarting the
 * link never touches the queue or a running job.
 */

const probeTimeoutMs = 5000;
const daemonStartTimeoutMs = 15 * 1000;
const configMode = 0o600;
const pueueWaitPollMs = 500;

export function renderPueueConfig(paths: RunnerHomePaths): string {
  const runtimeDir = path.join(paths.pueueDir, 'run');
  return [
    'shared:',
    `  pueue_directory: ${path.join(paths.pueueDir, 'data')}`,
    `  runtime_directory: ${runtimeDir}`,
    '  use_unix_socket: true',
    `  unix_socket_path: ${path.join(runtimeDir, 'pueue.socket')}`,
    `  pid_path: ${path.join(runtimeDir, 'pueue.pid')}`,
    '',
  ].join('\n');
}

/** @description Write the config (and its folders) when it is missing or differs. */
export function ensurePueueConfig(paths: RunnerHomePaths): void {
  fs.mkdirSync(path.join(paths.pueueDir, 'run'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(paths.pueueDir, 'data'), { recursive: true, mode: 0o700 });
  const text = renderPueueConfig(paths);
  let current: string | null = null;
  try {
    current = fs.readFileSync(paths.pueueConfig, 'utf8');
  } catch {
    current = null;
  }
  if (current !== text) writeTextFileAtomically(paths.pueueConfig, text, configMode);
}

/** @description Is the daemon answering? */
export async function checkIsPueueRunning(paths: RunnerHomePaths, runner: CommandRunner = runCommand): Promise<boolean> {
  const result = await runner(path.join(paths.binDir, 'pueue'), ['--config', paths.pueueConfig, 'status'], { timeoutMs: probeTimeoutMs });
  return result.ok;
}

/** @description Start the daemon (daemonized, so it outlives this process) unless it answers; `false` when it could not be started. */
export async function ensurePueueDaemon(paths: RunnerHomePaths, runner: CommandRunner = runCommand): Promise<boolean> {
  ensurePueueConfig(paths);
  if (await checkIsPueueRunning(paths, runner)) return true;
  const started = await runner(path.join(paths.binDir, 'pueued'), ['--daemonize', '--config', paths.pueueConfig], { timeoutMs: daemonStartTimeoutMs });
  return started.ok && await checkIsPueueRunning(paths, runner);
}

/** @description When a service manages Pueue the link must not start a second daemon: wait (up to `timeoutMs`) for the service's to answer. */
export async function waitForPueueDaemon(paths: RunnerHomePaths, timeoutMs: number, runner: CommandRunner = runCommand): Promise<boolean> {
  ensurePueueConfig(paths);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkIsPueueRunning(paths, runner)) return true;
    await new Promise((resolve) => { setTimeout(resolve, pueueWaitPollMs); });
  }
  return false;
}

/** What a Pueue daemon on this runner's private socket is doing. */
export type PueueState =
  | { kind: 'absent' }
  | { kind: 'idle' }
  | { kind: 'busy'; activeJobs: number }
  | { kind: 'unreadable' };

/** @description The tasks of `pueue status --json` that hold a process — `Running` and `Paused` — or `null` when the text is not that. */
export function countActivePueueTasks(statusJson: string): number | null {
  try {
    const parsed: { tasks?: Record<string, { status?: object | string }> } = JSON.parse(statusJson);
    if (parsed.tasks === undefined) return null;
    return Object.values(parsed.tasks).filter((task) => {
      const status = typeof task.status === 'string' ? [task.status] : Object.keys(task.status ?? {});
      return status.includes('Running') || status.includes('Paused');
    }).length;
  } catch {
    return null;
  }
}

/** @description Is a daemon answering on the runner's socket, and does it hold running jobs? */
export async function inspectPueue(paths: RunnerHomePaths, runner: CommandRunner = runCommand): Promise<PueueState> {
  const result = await runner(path.join(paths.binDir, 'pueue'), ['--config', paths.pueueConfig, 'status', '--json'], { timeoutMs: probeTimeoutMs });
  if (!result.ok) return { kind: 'absent' };
  const activeJobs = countActivePueueTasks(result.stdout);
  if (activeJobs === null) return { kind: 'unreadable' };
  return activeJobs === 0 ? { kind: 'idle' } : { kind: 'busy', activeJobs };
}

/** @description Ask a daemon that no service manager owns to shut down, and wait for it to go. Pueue kills the jobs it runs when it stops: only for an IDLE one. */
export async function shutDownPueue(paths: RunnerHomePaths, runner: CommandRunner = runCommand): Promise<boolean> {
  await runner(path.join(paths.binDir, 'pueue'), ['--config', paths.pueueConfig, 'shutdown'], { timeoutMs: probeTimeoutMs });
  const deadline = Date.now() + daemonStartTimeoutMs;
  while (Date.now() < deadline) {
    if (!(await checkIsPueueRunning(paths, runner))) return true;
    await new Promise((resolve) => { setTimeout(resolve, pueueWaitPollMs); });
  }
  return false;
}

/**
 * @description Stop every job of the queue and empty it (`pueue reset --force`: it kills the running tasks and their children and removes the
 * rest, so no queued task starts in their place), then wait until nothing is left running. `true` also when no daemon answers (its jobs died
 * with it). The reset only ASKS: Pueue 4 answers at once and its task handler kills the tasks a moment later, so one look right after the
 * command would still see them `Running` — it looks again, until `settleTimeoutMs` is over.
 */
export async function stopAllPueueJobs(paths: RunnerHomePaths, runner: CommandRunner = runCommand, settleTimeoutMs: number = daemonStartTimeoutMs): Promise<boolean> {
  if ((await inspectPueue(paths, runner)).kind === 'absent') return true;
  await runner(path.join(paths.binDir, 'pueue'), ['--config', paths.pueueConfig, 'reset', '--force'], { timeoutMs: daemonStartTimeoutMs });
  const deadline = Date.now() + settleTimeoutMs;
  for (;;) {
    const after = await inspectPueue(paths, runner);
    if (after.kind === 'absent' || after.kind === 'idle') return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => { setTimeout(resolve, pueueWaitPollMs); });
  }
}
