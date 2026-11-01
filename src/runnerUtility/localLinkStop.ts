import { spawnSync } from 'child_process';
import { readRunnerStatus } from './runnerConfig';
import type { RunnerHomePaths } from './runnerHome';

/**
 * @description Stopping the runner's link on THIS machine, and knowing it stopped. A process that holds a pairing holds the keys and the
 * configuration in memory: deleting the files does not end its link, and it can go on serving the hub's commands and reconnect.
 * So before a pairing is forgotten (`unpair`) the link process is asked to stop (TERM), then forced (KILL), and the answer is only
 * «stopped» when the pid is really gone. The pid comes from `status.json`; a pid that now belongs to another program (it was reused) is
 * recognised by its command line and left alone.
 */

const terminateGraceMs = 10 * 1000;
const killGraceMs = 3 * 1000;
const pollMs = 100;
const commandProbeTimeoutMs = 5000;

export interface ProcessControl {
  checkIsAlive: (pid: number) => boolean;
  /** The command line of `pid`, or `null` when it cannot be read. */
  readCommand: (pid: number) => string | null;
  signal: (pid: number, signal: NodeJS.Signals) => void;
  terminateGraceMs: number;
  killGraceMs: number;
}

export function createProcessControl(): ProcessControl {
  return {
    checkIsAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return error instanceof Error && 'code' in error && error.code === 'EPERM';
      }
    },
    readCommand: (pid) => {
      const listing = spawnSync('ps', ['-p', pid.toString(), '-o', 'command='], { encoding: 'utf8', timeout: commandProbeTimeoutMs });
      return listing.status === 0 && listing.stdout.trim() !== '' ? listing.stdout.trim() : null;
    },
    signal: (pid, signal) => { process.kill(pid, signal); },
    terminateGraceMs,
    killGraceMs,
  };
}

/** @description Is this command line the runner's link — `…/runnerCli.js run`? */
export function checkIsRunnerLinkCommand(command: string | null): boolean {
  return command !== null && /runnerCli\.js\s+run(\s|$)/.test(command);
}

async function waitUntilGone(pid: number, control: ProcessControl, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!control.checkIsAlive(pid)) return true;
    await new Promise((resolve) => { setTimeout(resolve, pollMs); });
  }
  return !control.checkIsAlive(pid);
}

/**
 * @description Stop the link process named by `status.json` (a foreground `run`, or whatever a service started): TERM, then KILL. `null`
 * when it is gone (or was never there); otherwise the reason it is still running.
 */
export async function stopLocalLink(paths: RunnerHomePaths, control: ProcessControl = createProcessControl()): Promise<string | null> {
  const status = readRunnerStatus(paths);
  if (status === null || !control.checkIsAlive(status.pid)) return null;
  if (!checkIsRunnerLinkCommand(control.readCommand(status.pid))) return null;
  try {
    control.signal(status.pid, 'SIGTERM');
    if (await waitUntilGone(status.pid, control, control.terminateGraceMs)) return null;
    control.signal(status.pid, 'SIGKILL');
  } catch (error) {
    return `the link process (pid ${status.pid}) could not be signalled (${error instanceof Error ? error.message : 'unknown error'})`;
  }
  return (await waitUntilGone(status.pid, control, control.killGraceMs)) ? null : `the link process (pid ${status.pid}) did not end`;
}
