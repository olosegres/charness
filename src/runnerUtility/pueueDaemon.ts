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

/** The statuses of a task that holds a process: it runs, or it is paused with its process kept. */
export const pueueProcessStatuses: readonly string[] = ['Running', 'Paused'];

/** @description The tasks of `pueue status --json` whose status is one of `statuses` (default: those that hold a process, `Running` and `Paused`), or `null` when the text is not that. */
export function countActivePueueTasks(statusJson: string, statuses: readonly string[] = pueueProcessStatuses): number | null {
  const snapshot = parsePueueStatus(statusJson);
  return snapshot === null ? null : snapshot.tasks.filter((task) => statuses.includes(task.status)).length;
}

/**
 * @description Is a daemon answering on the runner's socket, and does it hold running jobs? ANY failure of the question — also a timeout — is `absent`: right for stopping and
 * clearing the queue ({@link stopAllPueueJobs}, where a daemon that does not answer is waited for no longer), WRONG for deciding whether a job would be cut. For that, ask
 * {@link readPueueView}, which tells "no daemon" from "no answer".
 */
export async function inspectPueue(paths: RunnerHomePaths, runner: CommandRunner = runCommand): Promise<PueueState> {
  const result = await runner(path.join(paths.binDir, 'pueue'), ['--config', paths.pueueConfig, 'status', '--json'], { timeoutMs: probeTimeoutMs });
  if (!result.ok) return { kind: 'absent' };
  const activeJobs = countActivePueueTasks(result.stdout);
  if (activeJobs === null) return { kind: 'unreadable' };
  return activeJobs === 0 ? { kind: 'idle' } : { kind: 'busy', activeJobs };
}

/** One task of `pueue status --json`: its id, its status word (`Running`, `Paused`, `Queued`, `Locked`, `Done`, …) and the group it belongs to. */
export interface PueueTask {
  id: string;
  status: string;
  group: string;
}

/** What `pueue status --json` shows: the tasks, and the groups Pueue has paused (a paused group starts none of its queued tasks). */
export interface PueueSnapshot {
  tasks: PueueTask[];
  pausedGroups: string[];
}

/** @description The tasks and paused groups of `pueue status --json`, or `null` when the text is not that. */
export function parsePueueStatus(statusJson: string): PueueSnapshot | null {
  try {
    const parsed: { tasks?: Record<string, { status?: object | string; group?: string }>; groups?: Record<string, { status?: string }> } = JSON.parse(statusJson);
    if (parsed.tasks === undefined) return null;
    const tasks = Object.entries(parsed.tasks).map(([id, task]) => ({
      id,
      status: typeof task.status === 'string' ? task.status : (Object.keys(task.status ?? {})[0] ?? 'Unknown'),
      group: task.group ?? 'default',
    }));
    const pausedGroups = Object.entries(parsed.groups ?? {}).filter(([, group]) => group.status === 'Paused').map(([name]) => name);
    return { tasks, pausedGroups };
  } catch {
    return null;
  }
}

/** What a look at the queue found: no daemon to ask, an answer that could not be had or read (`unknown`, with the reason), or the tasks. */
export type PueueView =
  | { kind: 'absent' }
  | { kind: 'unknown'; reason: string }
  | ({ kind: 'tasks' } & PueueSnapshot);

/** What the pueue client says when there is no daemon: it never started here (no secret file), or it is not running (no socket, a socket nobody listens on). */
const noDaemonPattern = /Did you start|Connection refused|No such file or directory/i;

/**
 * @description Look at the queue the way a decision about a job's Node needs it: unlike {@link inspectPueue}, only a client that says there is NO daemon counts as `absent`.
 * An answer that timed out, a failure of any other kind and a reply that cannot be read are `unknown` — a daemon that is busy with a heavy build is not a free queue.
 */
export async function readPueueView(paths: RunnerHomePaths, runner: CommandRunner = runCommand): Promise<PueueView> {
  const result = await runner(path.join(paths.binDir, 'pueue'), ['--config', paths.pueueConfig, 'status', '--json'], { timeoutMs: probeTimeoutMs });
  if (!result.ok) {
    if (!result.isTimedOut && result.exitCode !== null && noDaemonPattern.test(result.stderr)) return { kind: 'absent' };
    return { kind: 'unknown', reason: result.isTimedOut ? `it did not answer within ${probeTimeoutMs / 1000} s` : `it failed (exit ${result.exitCode ?? 'none'})` };
  }
  const snapshot = parsePueueStatus(result.stdout);
  return snapshot === null ? { kind: 'unknown', reason: 'its answer could not be read' } : { kind: 'tasks', ...snapshot };
}

/**
 * @description A look at the queue ({@link readPueueView}) as a {@link PueueState}: for a caller that decides whether replacing a service would cut a job. A queue that could not be
 * asked (`unknown`) is `unreadable` — it cannot be told apart from one with running jobs — and never `absent`.
 */
export function summarizePueueView(view: PueueView, statuses: readonly string[] = pueueProcessStatuses): PueueState {
  if (view.kind === 'absent') return { kind: 'absent' };
  if (view.kind === 'unknown') return { kind: 'unreadable' };
  const activeJobs = view.tasks.filter((task) => statuses.includes(task.status)).length;
  return activeJobs === 0 ? { kind: 'idle' } : { kind: 'busy', activeJobs };
}

/** What Pueue is doing, as far as a restart or a removal of a Node must care. */
export type PueueActivity =
  /** Nothing unfinished — or there is no daemon to have any. */
  | { kind: 'idle' }
  /** A task is running, one will start by itself (queued in a group that runs), or Pueue could not be asked. */
  | { kind: 'busy'; description: string }
  /** Only tasks that will not move by themselves: paused, locked, or queued in a paused group (Pueue pauses a group that still had queued tasks when its daemon restarted). */
  | { kind: 'stuck'; description: string };

/** How many tasks a description names before it says "and N more". */
const namedTaskCount = 3;

function describeTasks(kind: string, tasks: ReadonlyArray<{ id: string; status: string; group: string }>): string {
  const named = tasks.slice(0, namedTaskCount).map((task) => `task ${task.id} (${task.status}, group ${task.group})`).join(', ');
  return `${kind}: ${named}${tasks.length > namedTaskCount ? ` and ${tasks.length - namedTaskCount} more` : ''}`;
}

/**
 * @description What a look at the queue means for a restart or a removal. A running task is busy; so is a queued one in a group that runs (it starts the moment a slot frees)
 * and a queue that could not be asked (a timed out or unreadable answer is not "free"); a paused or locked task, and a queued one in a paused group, are `stuck` — they
 * wait for a person — and are told apart so that a restart does not wait for them for ever. No daemon is idle. A finished task is nothing.
 */
export function classifyPueueView(view: PueueView): PueueActivity {
  if (view.kind === 'absent') return { kind: 'idle' };
  if (view.kind === 'unknown') return { kind: 'busy', description: `no answer from Pueue (${view.reason})` };
  const isStuckQueued = (task: { status: string; group: string }): boolean => task.status === 'Queued' && view.pausedGroups.includes(task.group);
  const moving = view.tasks.filter((task) => task.status === 'Running' || (task.status === 'Queued' && !isStuckQueued(task)));
  if (moving.length > 0) return { kind: 'busy', description: describeTasks('a running or queued task', moving) };
  const stuck = view.tasks.filter((task) => task.status === 'Paused' || task.status === 'Locked' || isStuckQueued(task));
  if (stuck.length > 0) return { kind: 'stuck', description: describeTasks('a task that waits for a person', stuck) };
  return { kind: 'idle' };
}

/** @description The check "what is Pueue doing?" for {@link PruneDeps} and {@link checkIsLinkIdle} ({@link classifyPueueView} of what `pueue status --json` says). */
export function createPueueActivityCheck(paths: RunnerHomePaths, runner: CommandRunner = runCommand): () => Promise<PueueActivity> {
  return async () => classifyPueueView(await readPueueView(paths, runner));
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
