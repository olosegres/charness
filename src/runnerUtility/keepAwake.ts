import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { writeTextFileAtomically } from '../configDirFile';
import type { KeepAwakeMethod } from '../remoteRun/probe';
import type { RunnerHomePaths } from './runnerHome';

/**
 * @description A runner keeps its machine awake while its link runs: it holds an IDLE-sleep assertion, the way `caffeinate -i` does, so a Mac with its lid
 * open never goes to sleep under a job (or between two jobs), and one with the lid closed sleeps as it always did — closing the lid is not idle, and
 * nothing here overrides it. Nothing of the machine's power settings is read or changed (never `pmset`, nothing that needs an admin), and the
 * display may still turn off:
 *
 *   macOS   `caffeinate -i -w <the link's pid>` — a child of the link that ends by itself the moment the link's process does (a stop, a removal, a crash,
 *           a SIGKILL): no orphan to keep the Mac awake after the runner is gone
 *   Linux   `systemd-inhibit --what=idle … sh -c 'while kill -0 <the link's pid> …; sleep 2; done'` — the lock is held while that loop runs, and the loop
 *           ends within two seconds of the link's process, however it ended
 *   else    nothing — and `runners` says so (no `systemd-inhibit` on the PATH, no D-Bus session for it, another system)
 *
 * What was done is written to `<state>/awake` (`caffeinate 123`, `systemd-inhibit 123`, or `none <reason>`) for `runner.sh probe`, which tells whether the
 * holder is still alive. A holder that ends while the link runs is tried again every {@link retryAfterMs}.
 */

/** @name KeepAwakeState @description How the machine is kept awake right now: by which holder process, or not at all and why. */
export type KeepAwakeState = { method: KeepAwakeMethod; holderPid: number } | { method: null; reason: string };

/** What a holder is asked to be: the command line, and which method it is. */
export type KeepAwakePlan = { method: KeepAwakeMethod; file: string; args: string[] } | { reason: string };

const holderLoopSeconds = 2;
/** How long a holder must stay up to count as holding: one that dies at once (no bus for `systemd-inhibit`) is a failure, not a lock. */
export const defaultSettleMs = 500;
export const retryAfterMs = 30 * 1000;
const stderrTailChars = 400;
const reasonMaxChars = 200;
/** `sh -c <script> sh <pid>`: the lock lasts as long as the link's process does. */
const waitForLinkScript = `while kill -0 "$1" 2> /dev/null; do sleep ${holderLoopSeconds}; done`;

/** @description The holder to start for this platform, or why there is none: pure, `findExecutable` is the PATH lookup. */
export function planKeepAwake(platform: NodeJS.Platform, linkPid: number, findExecutable: (name: string) => string | null): KeepAwakePlan {
  if (platform === 'darwin') {
    const file = findExecutable('caffeinate');
    return file === null ? { reason: 'caffeinate was not found on this Mac' } : { method: 'caffeinate', file, args: ['-i', '-w', `${linkPid}`] };
  }
  if (platform === 'linux') {
    const file = findExecutable('systemd-inhibit');
    if (file === null) return { reason: 'systemd-inhibit was not found (no systemd here, or not on the PATH of the runner)' };
    return { method: 'systemd-inhibit', file, args: ['--what=idle', '--who=charness-runner', '--why=the runner link is up', '--mode=block', 'sh', '-c', waitForLinkScript, 'sh', `${linkPid}`] };
  }
  return { reason: `keeping the machine awake is not supported on ${platform}` };
}

/** @description The one line of `<state>/awake`. A reason is one line, cut short: it is the machine's own text (a holder's stderr). */
export function formatKeepAwakeState(state: KeepAwakeState): string {
  if (state.method !== null) return `${state.method} ${state.holderPid}\n`;
  return `none ${state.reason.replace(/\s+/g, ' ').trim().slice(0, reasonMaxChars)}\n`;
}

export interface KeepAwakeDeps {
  platform: NodeJS.Platform;
  /** The pid of the link: what the holder is tied to. */
  linkPid: number;
  findExecutable: (name: string) => string | null;
  spawnHolder: (file: string, args: readonly string[]) => ChildProcess;
  settleMs: number;
  retryMs: number;
  writeState: (line: string) => void;
  removeState: () => void;
}

export interface KeepAwake {
  getState: () => KeepAwakeState;
  /** End the holder and forget the state. Idempotent, synchronous (it runs from the process's `exit` too). */
  stop: () => void;
}

type HolderOutcome = { kind: 'holding' } | { kind: 'ended'; detail: string };

/** Wait up to `settleMs` for the holder to end: `ended` with what it said, or `holding` when it is still there. */
function waitForHolderToSettle(child: ChildProcess, settleMs: number, getStderrTail: () => string): Promise<HolderOutcome> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: 'holding' }), settleMs);
    child.once('error', (error: Error) => {
      clearTimeout(timer);
      resolve({ kind: 'ended', detail: error.message });
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      const said = getStderrTail().trim().split('\n').pop() ?? '';
      resolve({ kind: 'ended', detail: said !== '' ? said : `exit ${code ?? signal ?? 'unknown'}` });
    });
  });
}

/**
 * @description Start holding the idle-sleep assertion. Resolves once the first attempt has settled — a holder that stayed up, or the reason there is none — and never
 * rejects: a machine that cannot be kept awake is a state `runners` shows, not a reason for the link not to come up.
 */
export async function startKeepAwake(deps: KeepAwakeDeps): Promise<KeepAwake> {
  let state: KeepAwakeState = { method: null, reason: 'not started' };
  let holder: ChildProcess | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let isStopped = false;

  const publish = (next: KeepAwakeState): void => {
    state = next;
    try {
      deps.writeState(formatKeepAwakeState(next));
    } catch {
      /* the state file is for `runners`; a folder that cannot be written is already the link's problem */
    }
  };

  const scheduleRetry = (): void => {
    if (isStopped || retryTimer !== null) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void attempt();
    }, deps.retryMs);
    retryTimer.unref();
  };

  const attempt = async (): Promise<void> => {
    const plan = planKeepAwake(deps.platform, deps.linkPid, deps.findExecutable);
    if ('reason' in plan) {
      publish({ method: null, reason: plan.reason });
      return;
    }
    let stderrTail = '';
    let child: ChildProcess;
    try {
      child = deps.spawnHolder(plan.file, plan.args);
    } catch (error) {
      publish({ method: null, reason: `${plan.method} could not be started (${error instanceof Error ? error.message : 'unknown error'})` });
      scheduleRetry();
      return;
    }
    child.stderr?.on('data', (chunk: Buffer) => { stderrTail = (stderrTail + chunk.toString()).slice(-stderrTailChars); });
    const outcome = await waitForHolderToSettle(child, deps.settleMs, () => stderrTail);
    if (isStopped) {
      child.kill('SIGTERM');
      return;
    }
    if (outcome.kind === 'ended' || child.pid === undefined) {
      publish({ method: null, reason: `${plan.method} ended at once (${outcome.kind === 'ended' ? outcome.detail : 'no pid'})` });
      scheduleRetry();
      return;
    }
    holder = child;
    publish({ method: plan.method, holderPid: child.pid });
    child.once('exit', (code, signal) => {
      if (holder !== child) return;
      holder = null;
      if (isStopped) return;
      publish({ method: null, reason: `the ${plan.method} process ended while the link runs (${code ?? signal ?? 'unknown'}); trying again` });
      scheduleRetry();
    });
  };

  await attempt();
  return {
    getState: () => state,
    stop: () => {
      if (isStopped) return;
      isStopped = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      holder?.kill('SIGTERM');
      holder = null;
      try {
        deps.removeState();
      } catch {
        /* already gone */
      }
    },
  };
}

/** @description The first executable `name` in `pathValue`'s folders, or `null`. */
export function findExecutableOnPath(name: string, pathValue: string, checkIsExecutable: (candidate: string) => boolean): string | null {
  for (const folder of pathValue.split(path.delimiter)) {
    if (folder === '') continue;
    const candidate = path.join(folder, name);
    if (checkIsExecutable(candidate)) return candidate;
  }
  return null;
}

/** Where the system's own tools are, whatever the PATH of the account's service says. */
const systemToolFolders = '/usr/bin:/bin:/usr/sbin:/sbin';
const stateFileMode = 0o644;

function checkIsExecutableFile(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** @description The real holder of this machine's link: the PATH's `caffeinate` / `systemd-inhibit` (then the system's folders), `<state>/awake` for its state. */
export function createKeepAwakeDeps(paths: RunnerHomePaths): KeepAwakeDeps {
  return {
    platform: process.platform,
    linkPid: process.pid,
    findExecutable: (name) => findExecutableOnPath(name, `${process.env.PATH ?? ''}${path.delimiter}${systemToolFolders}`, checkIsExecutableFile),
    spawnHolder: (file, args) => spawn(file, [...args], { stdio: ['ignore', 'ignore', 'pipe'] }),
    settleMs: defaultSettleMs,
    retryMs: retryAfterMs,
    writeState: (line) => { writeTextFileAtomically(paths.awakeFile, line, stateFileMode); },
    removeState: () => { fs.rmSync(paths.awakeFile, { force: true }); },
  };
}
