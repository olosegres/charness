import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { z } from 'zod';
import { getCaughtErrnoCode, writeJsonFileAtomically } from '../configDirFile';
import { getHubFilePaths, getRunnerLinkPaths } from './hubPaths';
import { hubIdPattern } from './hubIds';

/**
 * @description The hub's view of a runner's link: the gate that holds it writes `link/<id>.json` (its pid, since when, a heartbeat) and
 * listens on `link/<id>.sock`. A runner is ONLINE when its socket accepts a connection; the json only says who holds the socket and
 * when it was last seen. A removed runner's link is cut by deleting the socket (the gate notices within one check interval and
 * leaves) and, when the recorded pid still is that runner's gate, by stopping it at once; its two link files go with it, and any left behind
 * for a runner the registry does not know are swept by {@link sweepOrphanLinkRecords}.
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

/** @description Cut the link of a runner that was removed: no new connection reaches it, its gate leaves, and its link files are deleted. */
export function cutRunnerLink(dir: string, runnerId: string): void {
  const state = readLinkState(dir, runnerId);
  const paths = getRunnerLinkPaths(dir, runnerId);
  fs.rmSync(paths.socket, { force: true });
  if (state !== null && state.endedAtMs === null && checkIsGateProcessOf(state.pid, runnerId)) {
    try {
      process.kill(state.pid, 'SIGTERM');
    } catch (error) {
      if (getCaughtErrnoCode(error) !== 'ESRCH') throw error;
    }
  }
  // Nobody reads the status of a runner that is gone, and a gate that leaves because of the removal writes none (`gateLink.ts`).
  fs.rmSync(paths.state, { force: true });
}

const linkRecordExtensions = ['json', 'sock'];

/** @description The runner id a link file belongs to (`<id>.json`, `<id>.sock`); `null` for anything else in the folder (a temp file of an atomic write, a gate's pending socket). */
function getLinkRecordRunnerId(fileName: string): string | null {
  const [runnerId, extension, ...rest] = fileName.split('.');
  return hubIdPattern.test(runnerId) && linkRecordExtensions.includes(extension) && rest.length === 0 ? runnerId : null;
}

/**
 * @description Delete the link files (`<id>.json`, `<id>.sock`) of every runner that is not in `registeredRunnerIds`: a removal that was cut
 * short, a gate that wrote its status after the removal, a runner dropped from the registry by hand. Records of a runner whose gate is still
 * running are kept — it is on its way out, and {@link cutRunnerLink} still needs the pid to stop it.
 *
 * Best effort, and it NEVER throws: the registry operation that calls it has already written its files, and a folder that cannot be listed
 * or a file that cannot be deleted is only leftover clutter, tried again by the next operation. What went wrong is handed to `onProblem`,
 * which the caller must give (a sweep that cannot say what failed would hide exactly what it exists to report); a missing folder is not a
 * problem: nothing was ever linked. Returns the names deleted.
 */
export function sweepOrphanLinkRecords(dir: string, registeredRunnerIds: readonly string[], onProblem: (message: string) => void): string[] {
  const linkDir = getHubFilePaths(dir).linkDir;
  let names: string[];
  try {
    names = fs.readdirSync(linkDir);
  } catch (error) {
    const code = getCaughtErrnoCode(error);
    if (code !== 'ENOENT') onProblem(`the link folder could not be listed (${code}); leftover link files stay until it can be`);
    return [];
  }
  const deleted: string[] = [];
  for (const name of names) {
    const runnerId = getLinkRecordRunnerId(name);
    if (runnerId === null || registeredRunnerIds.includes(runnerId)) continue;
    const state = readLinkState(dir, runnerId);
    if (state !== null && state.endedAtMs === null && checkIsGateProcessOf(state.pid, runnerId)) continue;
    try {
      fs.rmSync(path.join(linkDir, name), { force: true });
      deleted.push(name);
    } catch (error) {
      onProblem(`the leftover link file ${name} could not be deleted (${getCaughtErrnoCode(error)})`);
    }
  }
  return deleted;
}
