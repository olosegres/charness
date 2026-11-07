import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { writeJsonFileAtomically } from '../configDirFile';
import { checkLauncherIsFor, ensureLauncher, readLauncherNodePath } from './launcher';
import { checkIsManagedNode, describeNode, ensureOwnNode, getInstalledVersion, getOwnInstallFolder, testKeepNodeEnvName, type NodeMoveDeps } from './managedNode';
import type { RunnerHomePaths } from './runnerHome';

/**
 * @description Looking after the runner's own Node.js while the link is up — never before it, and never at the cost of a job:
 *
 *   move      a runner that runs on a system or Homebrew Node gets its own (`managedNode.ts`), as the account
 *   update    a runner on its own Node asks for the newest release of its line, so it gets security fixes
 *   restart   a Node that is newer or new is used by the launcher's NEXT start; the link leaves for that (exit {@link nodeMovedExitCode}) only when
 *             no command runs over it ({@link createIdleRestart}), as it does for an update of its program
 *   prune     the folders of versions that no process uses any more, and the work folders a killed install left, are removed
 *   failure   an attempt that failed (no network, a full disk, a download that does not run here) is written down with the app copy it happened under;
 *             the next attempt waits for a day or for the next update of the program ({@link nodeMoveRetryMs}) — never a download at every start
 *
 * The shared Node of an admin line (root-owned) is never touched here: only the next admin line refreshes it.
 */

/** How long a failed attempt is left alone (unless the program was updated since). */
export const nodeMoveRetryMs = 24 * 60 * 60 * 1000;
/** A work folder of an install that is older than this belongs to an install that was killed. */
const staleInstallMs = 60 * 60 * 1000;
const failureFileMode = 0o600;
const psDeadlineMs = 10 * 1000;
const installFolderPattern = /^v\d+\.\d+\.\d+$/;
const workFolderPrefix = '.install.';

const nodeFailureSchema = z.strictObject({
  failedAtMs: z.number().int().nonnegative(),
  /** The app copy (`app.<id>`) the link ran when it failed; another one means the program was updated since. */
  appId: z.string().nullable(),
  reason: z.string(),
});
/** @name NodeFailure @description `node-failure.json`. */
export type NodeFailure = z.infer<typeof nodeFailureSchema>;

/** @description The recorded failure, or `null` when there is none (or the file is not a valid record: it is then as good as none). */
export function readNodeFailure(paths: Pick<RunnerHomePaths, 'nodeFailure'>): NodeFailure | null {
  try {
    return nodeFailureSchema.parse(JSON.parse(fs.readFileSync(paths.nodeFailure, 'utf8')));
  } catch {
    return null;
  }
}

function writeNodeFailure(paths: Pick<RunnerHomePaths, 'nodeFailure'>, failure: NodeFailure | null): void {
  if (failure === null) fs.rmSync(paths.nodeFailure, { force: true });
  else writeJsonFileAtomically(paths.nodeFailure, nodeFailureSchema.parse(failure), failureFileMode);
}

/** @description Is an attempt to be made now? Not while a failure under the same app copy is younger than {@link nodeMoveRetryMs}. */
export function checkIsAttemptDue(failure: NodeFailure | null, appId: string | null, nowMs: number): boolean {
  return failure === null || failure.appId !== appId || nowMs - failure.failedAtMs >= nodeMoveRetryMs;
}

/** @description The executables of the running processes (real paths) — what decides whether a Node install is still in use. Never throws; what cannot be read is left out. */
export function listRunningExecutables(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'linux') {
    const executables: string[] = [];
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        executables.push(fs.readlinkSync(path.join('/proc', name, 'exe')));
      } catch {
        // A process that ended, or one of another user.
      }
    }
    return executables;
  }
  const listing = spawnSync('ps', ['-axo', 'comm='], { encoding: 'utf8', timeout: psDeadlineMs });
  return listing.status === 0 ? listing.stdout.split('\n').map((line) => line.trim()).filter((line) => path.isAbsolute(line)) : [];
}

/** When `target` was last changed, or `null` when it is gone (an install that finished while the folders were being looked at). */
function getModifiedAtMs(target: string): number | null {
  try {
    return fs.statSync(target).mtimeMs;
  } catch {
    return null;
  }
}

function getRealPathOrSelf(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

export interface PruneDeps {
  listRunningExecutables: () => string[];
  now: () => number;
  log: (line: string) => void;
}

/**
 * @description Remove from `paths.ownNodeDir` the version folders that are not in `keep` (their paths) and that no running process is an executable of,
 * and the work folders of installs that were killed (older than an hour: a fresh one is an install in progress). Returns the names removed.
 */
export function pruneOwnNodes(paths: Pick<RunnerHomePaths, 'ownNodeDir'>, keep: readonly string[], deps: PruneDeps): string[] {
  let ownDir: string;
  let names: string[];
  try {
    ownDir = fs.realpathSync(paths.ownNodeDir);
    names = fs.readdirSync(ownDir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  const running = deps.listRunningExecutables().map(getRealPathOrSelf);
  for (const name of names) {
    const folder = path.join(ownDir, name);
    if (name.startsWith(workFolderPrefix)) {
      if (deps.now() - (getModifiedAtMs(folder) ?? deps.now()) < staleInstallMs) continue;
    } else if (!installFolderPattern.test(name) || keep.includes(folder) || running.some((executable) => executable.startsWith(`${folder}${path.sep}`))) {
      continue;
    }
    fs.rmSync(folder, { recursive: true, force: true });
    removed.push(name);
    deps.log(name.startsWith(workFolderPrefix) ? `removed the leftover of an interrupted Node.js install (${name})` : `removed Node.js ${name.slice(1)}, which no process uses any more`);
  }
  return removed;
}

/**
 * @description Make the launcher start `runningNodePath`, the Node that runs this link — except when the launcher already names one of the runner's own Nodes
 * while the link runs on another: that is a launcher process that was started before the runner moved (an update of the program restarts the app through the
 * OLD launcher, whose Node is still the old one), and rewriting the file for the Node that happens to run would undo the move.
 */
export function ensureLauncherForRunningNode(paths: RunnerHomePaths, runningNodePath: string): void {
  const named = readLauncherNodePath(paths);
  const isNamingOwnNode = named !== null && checkIsManagedNode(named, paths) && !checkIsManagedNode(runningNodePath, paths);
  if (!isNamingOwnNode) ensureLauncher(paths, runningNodePath);
}

export type NodeUpkeepResult = 'restart' | 'stay';

export interface NodeUpkeepDeps {
  paths: RunnerHomePaths;
  move: NodeMoveDeps;
  /** Lines for the log (stderr) and for what the operator should see (stdout). */
  log: (line: string) => void;
  say: (line: string) => void;
  now: () => number;
  /** The app copy that runs (`app.<id>`); `null` when it cannot be read. */
  getAppId: () => string | null;
  listRunningExecutables: () => string[];
  environment: NodeJS.ProcessEnv;
}

/** What the log says about the end of a link's life under the old launcher: a service manager restarts it; a terminal run has to be started again by hand. */
export const restartHint = 'a service manager starts the launcher again by itself; started from a terminal, start `charness-runner run` again';

/**
 * @description One look after the Node.js of the runner (see the head of the file). `restart` when a Node is in place that the launcher now names and this link
 * does not run on: the caller leaves for the launcher's new start when no command runs. Never throws.
 */
export async function runNodeUpkeep(deps: NodeUpkeepDeps): Promise<NodeUpkeepResult> {
  if (deps.environment[testKeepNodeEnvName] === '1') return 'stay';
  const { paths, move } = deps;
  const failure = readNodeFailure(paths);
  if (!checkIsAttemptDue(failure, deps.getAppId(), deps.now())) {
    deps.log(`this runner's last attempt to get a Node.js of its own (or a newer one) failed — ${failure?.reason ?? 'no reason recorded'} — and is tried again after 24 hours or the next update of the program`);
    return 'stay';
  }
  const outcome = await ensureOwnNode(paths, move);
  if (outcome.kind === 'failed') {
    writeNodeFailure(paths, { failedAtMs: deps.now(), appId: deps.getAppId(), reason: outcome.reason });
    deps.log(`this runner runs on ${describeNode(move.currentNodePath, move.currentNodeVersion)} and could not get a Node.js of its own or a newer one: ${outcome.reason}. It tries again after 24 hours or the next update of the program.`);
    return 'stay';
  }
  writeNodeFailure(paths, null);
  const keep = [getOwnInstallFolder(move.currentNodePath, paths), outcome.kind === 'installed' ? getOwnInstallFolder(outcome.nodePath, paths) : null, ...getLauncherInstallFolder(paths)]
    .filter((folder): folder is string => folder !== null);
  let result: NodeUpkeepResult = 'stay';
  if (outcome.kind === 'installed') {
    if (outcome.log !== '') deps.log(outcome.log);
    if (checkLauncherIsFor(paths, outcome.nodePath)) {
      deps.log(`the launcher already names ${outcome.nodePath}, but this link still runs on ${describeNode(move.currentNodePath, move.currentNodeVersion)}: start the launcher again to use it`);
    } else {
      ensureLauncher(paths, outcome.nodePath);
      const leaving = describeNode(move.currentNodePath, move.currentNodeVersion);
      const arriving = describeNode(outcome.nodePath, getInstalledVersion(outcome.nodePath));
      deps.say(outcome.isMove
        ? `charness-runner: this runner now has its own ${arriving} and leaves ${leaving}: jobs will run the new one (to keep them on the old one, see «A runner's Node» in docs/remote-run.md); the link starts again on it when no command runs — ${restartHint}`
        : `charness-runner: a newer release of this runner's own Node.js is in place: ${arriving}, replacing ${leaving}; the link starts again on it when no command runs — ${restartHint}`);
      result = 'restart';
    }
  }
  pruneOwnNodes(paths, keep, { listRunningExecutables: deps.listRunningExecutables, now: deps.now, log: (line) => { deps.log(line); } });
  return result;
}

/** The version folder of the Node the launcher on disk names, as a list of zero or one folder (a launcher that names a Node outside the runner's folder keeps nothing). */
function getLauncherInstallFolder(paths: RunnerHomePaths): string[] {
  const named = readLauncherNodePath(paths);
  const folder = named === null ? null : getOwnInstallFolder(named, paths);
  return folder === null ? [] : [folder];
}

export interface IdleRestartDeps {
  getActiveCount: () => number;
  /** Ends the link so that the launcher starts again; called once. */
  leave: () => void;
}

export interface IdleRestart {
  /** The launcher must start again on a new Node: leave now if no command runs, else as soon as none does. */
  request: () => void;
  /** The number of running commands changed. */
  notifyActiveCountChange: () => void;
}

/** @description The hand-over of a wanted restart to the moment no command runs over the link (the way an update of the program waits for idleness). */
export function createIdleRestart(deps: IdleRestartDeps): IdleRestart {
  let isRequested = false;
  let hasLeft = false;
  const leaveIfIdle = (): void => {
    if (!isRequested || hasLeft || deps.getActiveCount() !== 0) return;
    hasLeft = true;
    deps.leave();
  };
  return {
    request: () => {
      isRequested = true;
      leaveIfIdle();
    },
    notifyActiveCountChange: leaveIfIdle,
  };
}
