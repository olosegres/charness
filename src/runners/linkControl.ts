import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import { z } from 'zod';
import { getCaughtErrnoCode, writeJsonFileAtomically } from '../configDirFile';
import { getHubFilePaths, getRunnerLinkPaths } from './hubPaths';

/**
 * @description The hub's view of a runner's link: the gate that holds it writes `link/<id>.json` (its pid, since when, a heartbeat) and
 * listens on `link/<id>.sock`. A runner is ONLINE when its socket accepts a connection; the json only says who holds the socket and
 * when it was last seen. A removed runner's link is cut by deleting the socket (the gate notices within one check interval and
 * leaves) and, when the recorded pid still is that runner's gate, by stopping it at once.
 */

const stateFileMode = 0o600;
const probeTimeoutMs = 1000;

const linkStateSchema = z.strictObject({
  pid: z.number().int().positive(),
  sinceMs: z.number().int().nonnegative(),
  lastBeatMs: z.number().int().nonnegative(),
  /** Set by the gate when it leaves; `null` while it holds the link. */
  endedAtMs: z.number().int().nonnegative().nullable(),
});

/** @name LinkState @description `link/<id>.json`. */
export type LinkState = z.infer<typeof linkStateSchema>;

export interface RunnerLinkStatus {
  isOnline: boolean;
  /** When the link in force started (only while online). */
  sinceMs: number | null;
  /** The last time the hub knew the link alive; `null` if it never was. */
  lastSeenMs: number | null;
}

export function readLinkState(dir: string, runnerId: string): LinkState | null {
  try {
    const parsed = linkStateSchema.safeParse(JSON.parse(fs.readFileSync(getRunnerLinkPaths(dir, runnerId).state, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeLinkState(dir: string, runnerId: string, state: LinkState): void {
  fs.mkdirSync(getHubFilePaths(dir).linkDir, { recursive: true, mode: 0o700 });
  writeJsonFileAtomically(getRunnerLinkPaths(dir, runnerId).state, linkStateSchema.parse(state), stateFileMode);
}

/** @description Does anything accept a connection on the unix socket `socketPath` right now? */
export function probeSocket(socketPath: string, timeoutMs: number = probeTimeoutMs): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    const settle = (isAccepted: boolean): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(isAccepted);
    };
    const timer = setTimeout(() => settle(false), timeoutMs);
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
  });
}

export async function getRunnerLinkStatus(dir: string, runnerId: string): Promise<RunnerLinkStatus> {
  const state = readLinkState(dir, runnerId);
  const isOnline = await probeSocket(getRunnerLinkPaths(dir, runnerId).socket);
  return {
    isOnline,
    sinceMs: isOnline ? (state?.sinceMs ?? null) : null,
    lastSeenMs: state === null ? null : (state.endedAtMs ?? state.lastBeatMs),
  };
}

/** @description Is `pid` a charness gate serving runner `runnerId`? (A pid in an old json may belong to anything by now.) */
export function checkIsGateProcessOf(pid: number, runnerId: string): boolean {
  const listing = spawnSync('ps', ['-p', pid.toString(), '-o', 'command='], { encoding: 'utf8', timeout: probeTimeoutMs * 5 });
  return listing.status === 0 && listing.stdout.includes('runner-gate') && listing.stdout.includes(` runner ${runnerId}`);
}

/** @description Cut the link of a runner that was removed: no new connection reaches it, and its gate leaves. */
export function cutRunnerLink(dir: string, runnerId: string): void {
  const state = readLinkState(dir, runnerId);
  try {
    fs.rmSync(getRunnerLinkPaths(dir, runnerId).socket, { force: true });
  } catch (error) {
    if (getCaughtErrnoCode(error) !== 'ENOENT') throw error;
  }
  if (state !== null && state.endedAtMs === null && checkIsGateProcessOf(state.pid, runnerId)) {
    try {
      process.kill(state.pid, 'SIGTERM');
    } catch (error) {
      if (getCaughtErrnoCode(error) !== 'ESRCH') throw error;
    }
  }
}
