import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { writeJsonFileAtomically } from '../configDirFile';
import { runCommand, type CommandRunner } from '../selfUpdate/commandRunner';
import { checkLauncherIsFor, ensureLauncher, readLauncherNodePath } from './launcher';
import { inspectPueue, pueueUnfinishedStatuses } from './pueueDaemon';
import { checkIsManagedNode, describeNode, ensureOwnNode, getInstalledVersion, getOwnInstallFolder, testKeepNodeEnvName, type NodeMoveDeps } from './managedNode';
import type { RunnerHomePaths } from './runnerHome';

/**
 * @description Looking after the runner's own Node.js while the link is up — never before it, and never at the cost of a job:
 *
 *   move      a runner that runs on a system or Homebrew Node gets its own (`managedNode.ts`), as the account
 *   update    a runner on its own Node asks for the newest release of its line, so it gets security fixes
 *   restart   a Node that is newer or new is used by the launcher's NEXT start; the link leaves for that (exit {@link nodeMovedExitCode}) only when
 *             no command runs over it ({@link createIdleRestart}), as it does for an update of its program
 *   prune     the folder of a version is removed only {@link nodeVersionGraceMs} after it stopped being the runner's Node (the moment is recorded) AND only while
 *             Pueue has no running or queued task: a job keeps the PATH it was queued with, and a process started through that PATH cannot be told from outside
 *             (macOS `ps` shows `node`, not where it lives). The work folders a killed install left are removed too
 *   failure   an attempt that failed (no network, a full disk, a download that does not run here) is written down with the app copy it happened under;
 *             the next attempt is made {@link nodeMoveRetryMs} after the failure or after the next update of the program ({@link getNextLookDelayMs}) — never
 *             a download at every start
 *
 * The shared Node of an admin line (root-owned) is never touched here: only the next admin line refreshes it.
 */

/** How long a failed attempt is left alone (unless the program was updated since). */
export const nodeMoveRetryMs = 24 * 60 * 60 * 1000;
/** A work folder of an install that is older than this belongs to an install that was killed. */
const staleInstallMs = 60 * 60 * 1000;
/** How long a version's folder stays after it stopped being the runner's Node: a job queued on it, or one that runs for days, still finds its `node` there. */
export const nodeVersionGraceMs = 7 * 24 * 60 * 60 * 1000;
/** A timer that fires a moment early (timers are rounded) must not find the retry not yet due. */
const retrySlackMs = 1000;
const recordFileMode = 0o600;
const failureFileMode = recordFileMode;
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

/** When `target` was last changed, or `null` when it is gone (an install that finished while the folders were being looked at). */
function getModifiedAtMs(target: string): number | null {
  try {
    return fs.statSync(target).mtimeMs;
  } catch {
    return null;
  }
}

const currentRecordSchema = z.strictObject({
  /** `v24.22.2` → when the folder was last the runner's Node (running, named by the launcher or just installed), or first seen. */
  lastCurrentMs: z.record(z.string(), z.number().int().nonnegative()),
});

function readLastCurrentMs(paths: Pick<RunnerHomePaths, 'nodeCurrent'>): Record<string, number> {
  try {
    return currentRecordSchema.parse(JSON.parse(fs.readFileSync(paths.nodeCurrent, 'utf8'))).lastCurrentMs;
  } catch {
    return {};
  }
}

export interface PruneDeps {
  now: () => number;
  log: (line: string) => void;
  /** Does Pueue have a task that is running, paused, queued or locked — or can that not be told? A job queued with the old PATH must not lose its Node. */
  checkIsPueueBusy: () => Promise<boolean>;
}

/**
 * @description Look after the version folders of `paths.ownNodeDir`. `current` are the folders (real paths) that are the runner's Node right now: they are stamped with the
 * time of this look, and so is a folder seen for the first time (its grace starts then). A folder that is not current is removed only when its stamp is
 * {@link nodeVersionGraceMs} old — and then only if Pueue has no running or queued task. The work folders of installs that were killed (older than an hour: a fresh
 * one is an install in progress) go always. Returns the names removed.
 */
export async function pruneOwnNodes(paths: Pick<RunnerHomePaths, 'ownNodeDir' | 'nodeCurrent'>, current: readonly string[], deps: PruneDeps): Promise<string[]> {
  let ownDir: string;
  let names: string[];
  try {
    ownDir = fs.realpathSync(paths.ownNodeDir);
    names = fs.readdirSync(ownDir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  const nowMs = deps.now();
  for (const name of names.filter((candidate) => candidate.startsWith(workFolderPrefix))) {
    const folder = path.join(ownDir, name);
    if (nowMs - (getModifiedAtMs(folder) ?? nowMs) < staleInstallMs) continue;
    fs.rmSync(folder, { recursive: true, force: true });
    removed.push(name);
    deps.log(`removed the leftover of an interrupted Node.js install (${name})`);
  }
  const previous = readLastCurrentMs(paths);
  const stamps: Record<string, number> = {};
  const versions = names.filter((name) => installFolderPattern.test(name));
  for (const name of versions) stamps[name] = current.includes(path.join(ownDir, name)) ? nowMs : (previous[name] ?? nowMs);
  const expired = versions.filter((name) => !current.includes(path.join(ownDir, name)) && nowMs - stamps[name] >= nodeVersionGraceMs);
  if (expired.length > 0 && await deps.checkIsPueueBusy()) {
    deps.log(`keeps ${expired.map((name) => name.slice(1)).join(', ')}: Node.js version(s) the runner left more than ${nodeVersionGraceMs / 86_400_000} days ago, while Pueue still has a running or queued task`);
  } else {
    for (const name of expired) {
      fs.rmSync(path.join(ownDir, name), { recursive: true, force: true });
      delete stamps[name];
      removed.push(name);
      deps.log(`removed Node.js ${name.slice(1)}, which the runner left more than ${nodeVersionGraceMs / 86_400_000} days ago`);
    }
  }
  writeJsonFileAtomically(paths.nodeCurrent, currentRecordSchema.parse({ lastCurrentMs: stamps }), recordFileMode);
  return removed;
}

/** @description The check "does Pueue have a task that is not over?" for {@link PruneDeps} and {@link checkIsLinkIdle}: no daemon answering means no task; an answer that cannot be read counts as busy. */
export function createPueueBusyCheck(paths: RunnerHomePaths, runner: CommandRunner = runCommand): () => Promise<boolean> {
  return async () => {
    const state = await inspectPueue(paths, runner, pueueUnfinishedStatuses);
    return state.kind === 'busy' || state.kind === 'unreadable';
  };
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

export interface NodeUpkeepResult {
  /** `restart`: a Node is in place that the launcher now names and this link does not run on — the caller leaves for the launcher's new start when it is idle. */
  step: 'restart' | 'stay';
  /** When the next look is due, from now. */
  nextLookInMs: number;
}

/**
 * @description When the next look is due: `intervalMs` after a look that worked, but {@link nodeMoveRetryMs} after the FAILURE that is on record (plus a second for the
 * timer's rounding) — a failure is written when the attempt ENDS, which can be minutes after it began, so a fixed interval from the start would find the retry
 * not yet due and skip it, and the real retry would come a whole interval later. A failure recorded under another app copy is due at once.
 */
export function getNextLookDelayMs(failure: NodeFailure | null, appId: string | null, nowMs: number, intervalMs: number): number {
  if (failure === null || failure.appId !== appId) return intervalMs;
  const untilDueMs = failure.failedAtMs + nodeMoveRetryMs - nowMs;
  return untilDueMs <= 0 ? intervalMs : untilDueMs + retrySlackMs;
}

export interface NodeUpkeepDeps {
  paths: RunnerHomePaths;
  move: NodeMoveDeps;
  /** Lines for the log (stderr) and for what the operator should see (stdout). */
  log: (line: string) => void;
  say: (line: string) => void;
  now: () => number;
  /** The app copy that runs (`app.<id>`); `null` when it cannot be read. */
  getAppId: () => string | null;
  checkIsPueueBusy: () => Promise<boolean>;
  /** How often a look is made when nothing failed ({@link nodeUpkeepIntervalMs}, or a flow's shorter one). */
  intervalMs: number;
  environment: NodeJS.ProcessEnv;
}

/** What the log says about the end of a link's life under the old launcher: a service manager restarts it; a terminal run has to be started again by hand. */
export const restartHint = 'a service manager starts the launcher again by itself; started from a terminal, start `charness-runner run` again';

/**
 * @description One look after the Node.js of the runner (see the head of the file). `restart` when a Node is in place that the launcher now names and this link
 * does not run on: the caller leaves for the launcher's new start when it is idle. Never throws.
 */
export async function runNodeUpkeep(deps: NodeUpkeepDeps): Promise<NodeUpkeepResult> {
  const { paths, move } = deps;
  const stay = (): NodeUpkeepResult => ({ step: 'stay', nextLookInMs: getNextLookDelayMs(readNodeFailure(paths), deps.getAppId(), deps.now(), deps.intervalMs) });
  if (deps.environment[testKeepNodeEnvName] === '1') return stay();
  const failure = readNodeFailure(paths);
  if (!checkIsAttemptDue(failure, deps.getAppId(), deps.now())) {
    deps.log(`this runner's last attempt to get a Node.js of its own (or a newer one) failed — ${failure?.reason ?? 'no reason recorded'} — and is tried again after 24 hours or the next update of the program`);
    return stay();
  }
  const outcome = await ensureOwnNode(paths, move);
  if (outcome.kind === 'failed') {
    writeNodeFailure(paths, { failedAtMs: deps.now(), appId: deps.getAppId(), reason: outcome.reason });
    deps.log(`this runner runs on ${describeNode(move.currentNodePath, move.currentNodeVersion)} and could not get a Node.js of its own or a newer one: ${outcome.reason}. It tries again after 24 hours or the next update of the program.`);
    return stay();
  }
  writeNodeFailure(paths, null);
  let step: NodeUpkeepResult['step'] = 'stay';
  if (outcome.kind === 'installed') {
    if (outcome.log !== '') deps.log(outcome.log);
    if (checkLauncherIsFor(paths, outcome.nodePath)) {
      deps.log(`the launcher already names ${outcome.nodePath}, but this link still runs on ${describeNode(move.currentNodePath, move.currentNodeVersion)}: start the launcher again to use it`);
    } else {
      ensureLauncher(paths, outcome.nodePath);
      const leaving = describeNode(move.currentNodePath, move.currentNodeVersion);
      const arriving = describeNode(outcome.nodePath, getInstalledVersion(outcome.nodePath));
      deps.say(outcome.isMove
        ? `charness-runner: this runner now has its own ${arriving} and leaves ${leaving}: jobs will run the new one (to keep them on the old one, see «A runner's Node» in docs/remote-run.md); the link starts again on it when no command, app update or Pueue task is under way — ${restartHint}`
        : `charness-runner: a newer release of this runner's own Node.js is in place: ${arriving}, replacing ${leaving}; the link starts again on it when no command, app update or Pueue task is under way — ${restartHint}`);
      step = 'restart';
    }
  }
  // Current right now: the Node this link runs on, the one the launcher names (after the rewrite above) and the new one — each stamped, so it is the OLD ones that age.
  const current = [getOwnInstallFolder(move.currentNodePath, paths), outcome.kind === 'installed' ? getOwnInstallFolder(outcome.nodePath, paths) : null, ...getLauncherInstallFolder(paths)]
    .filter((folder): folder is string => folder !== null);
  await pruneOwnNodes(paths, current, { now: deps.now, log: (line) => { deps.log(line); }, checkIsPueueBusy: deps.checkIsPueueBusy });
  return { step, nextLookInMs: deps.intervalMs };
}

/** The version folder of the Node the launcher on disk names, as a list of zero or one folder (a launcher that names a Node outside the runner's folder keeps nothing). */
function getLauncherInstallFolder(paths: RunnerHomePaths): string[] {
  const named = readLauncherNodePath(paths);
  const folder = named === null ? null : getOwnInstallFolder(named, paths);
  return folder === null ? [] : [folder];
}

/**
 * @description Run `look` now and then again when it says: each look is scheduled by the END of the one before it, so a failure — written when its attempt ENDS,
 * minutes after the look began — is never found "not yet due" by a timer that was set when the look began. `look` returns the delay to the next one.
 */
export function startNodeUpkeepSchedule(look: () => Promise<number>, setTimer: (callback: () => void, ms: number) => unknown = setUnrefTimer): void {
  const run = async (): Promise<void> => {
    const nextLookInMs = await look();
    setTimer(() => { void run(); }, nextLookInMs);
  };
  void run();
}

export interface LinkIdleChecks {
  getActiveExecCount: () => number;
  /** Is an update of the program being installed? */
  isUpdating: () => boolean;
  checkIsPueueBusy: () => Promise<boolean>;
}

/**
 * @description Is nothing under way that a restart of the link would cut or strand — no command over it, no update of the program being installed (its download
 * and `npm ci` would be orphaned), and no Pueue task running or queued (a job queued with the old PATH keeps its Node)? The cheap questions come first.
 */
export async function checkIsLinkIdle(checks: LinkIdleChecks): Promise<boolean> {
  if (checks.getActiveExecCount() !== 0 || checks.isUpdating()) return false;
  return !(await checks.checkIsPueueBusy());
}

export interface IdleRestartDeps {
  /** True when nothing a restart would cut is under way ({@link checkIsLinkIdle}). A check that fails counts as not idle. */
  checkIsIdle: () => Promise<boolean>;
  /** Ends the link so that the launcher starts again; called once. */
  leave: () => void;
  /** How long to wait before looking again while something is under way (Pueue tasks end without an event for the link). */
  pollMs: number;
  /** A timer for the next look (default: `setTimeout`, unref'd); a test's own. */
  setTimer?: (callback: () => void, ms: number) => { clear: () => void };
}

export interface IdleRestart {
  /** The launcher must start again on a new Node: leave as soon as nothing is under way. */
  request: () => void;
  /** Whether {@link IdleRestart.request} was called. */
  isRequested: () => boolean;
  /** Something that was under way may have ended (the last command, an update that settled): look at once. */
  notifyChange: () => void;
}

function setUnrefTimer(callback: () => void, ms: number): { clear: () => void } {
  const timer = setTimeout(callback, ms);
  timer.unref();
  return { clear: () => { clearTimeout(timer); } };
}

/** @description The hand-over of a wanted restart to the moment nothing is under way (the way an update of the program waits for idleness). Looks again on a change and every `pollMs`. */
export function createIdleRestart(deps: IdleRestartDeps): IdleRestart {
  const setTimer = deps.setTimer ?? setUnrefTimer;
  let isRequested = false;
  let hasLeft = false;
  let isChecking = false;
  let isLookAgainWanted = false;
  let timer: { clear: () => void } | null = null;
  const look = async (): Promise<void> => {
    if (!isRequested || hasLeft) return;
    if (isChecking) {
      isLookAgainWanted = true;
      return;
    }
    isChecking = true;
    try {
      let isIdle = false;
      do {
        isLookAgainWanted = false;
        timer?.clear();
        timer = null;
        isIdle = await deps.checkIsIdle().catch(() => false);
      } while (!isIdle && isLookAgainWanted);
      if (isIdle) {
        hasLeft = true;
        deps.leave();
      } else {
        timer = setTimer(() => { timer = null; void look(); }, deps.pollMs);
      }
    } finally {
      isChecking = false;
    }
  };
  return {
    request: () => {
      isRequested = true;
      void look();
    },
    isRequested: () => isRequested,
    notifyChange: () => { void look(); },
  };
}
