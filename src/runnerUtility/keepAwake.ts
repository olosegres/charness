import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { writeTextFileAtomically } from '../configDirFile';
import { keepAwakeHoldSeconds, type KeepAwakeMethod } from '../remoteRun/probe';
import type { RunnerHomePaths } from './runnerHome';

/**
 * @description A runner keeps its machine awake while its link runs: it holds an IDLE-sleep assertion, the way `caffeinate -i` does, so a Mac with its lid
 * open never goes to sleep under a job (or between two jobs), and one with the lid closed sleeps as it always did — closing the lid is not idle, and
 * nothing here overrides it. Nothing of the machine's power settings is read or changed (never `pmset`, nothing that needs an admin), and the
 * display may still turn off:
 *
 *   macOS   `caffeinate -i -t <holdSeconds>`
 *   Linux   `systemd-inhibit --what=idle … sleep <holdSeconds>`
 *   else    nothing — and `runners` says so (no `systemd-inhibit` on the PATH, no D-Bus session for it, another system)
 *
 * WHY A TIMED HOLDER THAT OUTLIVES THE LINK, not one tied to the link's process (`caffeinate -w <pid>`): the link restarts itself for every update of the hub's
 * package, and a holder that died with it left the Mac with NO assertion for the moment before the new link took its own. A Mac whose user is away has its idle
 * timer long expired, so that moment is enough: measured on a real Mac (macOS 26), `pmset -g log` shows the old `caffeinate` die with `[System: No Assertions]`
 * and `Entering Sleep state due to 'Idle Sleep'` five seconds later — although the new link's `caffeinate` was already holding when the sleep began (it came
 * within the same second). An assertion cannot wake a Mac that sleeps, and a DarkWake always ends in a Maintenance Sleep with it held, so the runner then stayed offline until
 * someone pressed a key (hours; four times since 11-05). So the holder is:
 *
 *   - timed: it ends by itself after {@link keepAwakeHoldSeconds}, whatever became of the link — a stop, a SIGKILL, a crash leave no orphan for longer than that;
 *   - renewed every {@link renewEveryMs} while the link runs, the NEW holder first and the old one released only after it holds (never an instant with none);
 *   - left running when the link leaves to come back (an update, a restart, a crash: {@link KeepAwake.handOver}), so the next link starts its own holder while this
 *     one still holds, and ended at once only when the link is stopped ({@link KeepAwake.stop}: the operator's stop, an unpair, a removal).
 *
 * What is not covered, and `runners` says: a closed lid, the Apple menu's Sleep and the power button, a battery running out, and a link that stays away for longer than
 * {@link keepAwakeHoldSeconds} (a crash loop, a machine that was busy for minutes before the new link came up).
 *
 * What was done is written to `<state>/awake` (`caffeinate 123`, `systemd-inhibit 123`, or `none <reason>`) for `runner.sh probe`, which tells whether the
 * holder is still alive. A holder that ends while the link runs is tried again every {@link retryAfterMs}.
 */

/** @name KeepAwakeState @description How the machine is kept awake right now: by which holder process, or not at all and why. */
export type KeepAwakeState = { method: KeepAwakeMethod; holderPid: number } | { method: null; reason: string };

/** What a holder is asked to be: the command line, and which method it is. */
export type KeepAwakePlan = { method: KeepAwakeMethod; file: string; args: string[] } | { reason: string };

/** How often the link starts a new holder: at most a fifth of the lifetime, so a renewal that fails (no process slot on a loaded machine) is tried again several times before the old holder runs out. */
export const renewEveryMs = 60 * 1000;
/** How long a holder must stay up to count as holding: one that dies at once (no bus for `systemd-inhibit`) is a failure, not a lock. */
export const defaultSettleMs = 500;
export const retryAfterMs = 30 * 1000;
const stderrTailChars = 400;
const reasonMaxChars = 200;

/** @description The holder to start for this platform, lasting `holdSeconds`, or why there is none: pure, `findExecutable` is the PATH lookup. */
export function planKeepAwake(platform: NodeJS.Platform, holdSeconds: number, findExecutable: (name: string) => string | null): KeepAwakePlan {
  if (platform === 'darwin') {
    const file = findExecutable('caffeinate');
    return file === null ? { reason: 'caffeinate was not found on this Mac' } : { method: 'caffeinate', file, args: ['-i', '-t', `${holdSeconds}`] };
  }
  if (platform === 'linux') {
    const file = findExecutable('systemd-inhibit');
    if (file === null) return { reason: 'systemd-inhibit was not found (no systemd here, or not on the PATH of the runner)' };
    return { method: 'systemd-inhibit', file, args: ['--what=idle', '--who=charness-runner', '--why=the runner link is up', '--mode=block', 'sleep', `${holdSeconds}`] };
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
  /** How long one holder lasts ({@link keepAwakeHoldSeconds}). */
  holdSeconds: number;
  /** How often a new holder takes over from the old one ({@link renewEveryMs}). */
  renewMs: number;
  findExecutable: (name: string) => string | null;
  spawnHolder: (file: string, args: readonly string[]) => ChildProcess;
  settleMs: number;
  retryMs: number;
  writeState: (line: string) => void;
  removeState: () => void;
}

export interface KeepAwake {
  getState: () => KeepAwakeState;
  /** The link is stopped for good: end the holder and forget the state. Idempotent, synchronous (it runs from the process's `exit` too). */
  stop: () => void;
  /**
   * The link leaves but will be back (an update, a restart onto a new Node, a crash that its service restarts): no more renewals, and the holder is NOT ended — it runs
   * out by itself, so the next link's holder takes over while it still holds. The state file stays: it names the holder that is still there. Idempotent, synchronous.
   */
  handOver: () => void;
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
  let timer: NodeJS.Timeout | null = null;
  let end: 'stop' | 'handOver' | null = null;

  const publish = (next: KeepAwakeState): void => {
    state = next;
    try {
      deps.writeState(formatKeepAwakeState(next));
    } catch {
      /* the state file is for `runners`; a folder that cannot be written is already the link's problem */
    }
  };

  const schedule = (delayMs: number): void => {
    if (end !== null) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void attempt();
    }, delayMs);
    timer.unref();
  };

  /** Let go of a holder that runs on by itself: this process must be able to leave without it. */
  const release = (child: ChildProcess): void => {
    child.stderr?.destroy();
    child.unref();
  };

  /**
   * Start a holder — the first one, a renewal, or a retry — and let it take over from the one there is only once it holds, so no instant is left without an assertion.
   * Whatever goes wrong while a holder is still there leaves that holder and its state alone: it lasts for most of its lifetime yet, and the next try comes soon.
   */
  const attempt = async (): Promise<void> => {
    const plan = planKeepAwake(deps.platform, deps.holdSeconds, deps.findExecutable);
    if ('reason' in plan) {
      if (holder === null) publish({ method: null, reason: plan.reason });
      return;
    }
    let stderrTail = '';
    let child: ChildProcess;
    try {
      child = deps.spawnHolder(plan.file, plan.args);
    } catch (error) {
      if (holder === null) publish({ method: null, reason: `${plan.method} could not be started (${error instanceof Error ? error.message : 'unknown error'})` });
      schedule(deps.retryMs);
      return;
    }
    child.stderr?.on('data', (chunk: Buffer) => { stderrTail = (stderrTail + chunk.toString()).slice(-stderrTailChars); });
    const outcome = await waitForHolderToSettle(child, deps.settleMs, () => stderrTail);
    if (end === 'stop') {
      child.kill('SIGTERM');
      return;
    }
    if (outcome.kind === 'ended' || child.pid === undefined) {
      if (holder === null) publish({ method: null, reason: `${plan.method} ended at once (${outcome.kind === 'ended' ? outcome.detail : 'no pid'})` });
      schedule(deps.retryMs);
      return;
    }
    if (end === 'handOver') {
      release(child);
      return;
    }
    const previous = holder;
    holder = child;
    publish({ method: plan.method, holderPid: child.pid });
    // The old holder goes only now: the new one holds already, so the machine is never left with none.
    previous?.kill('SIGTERM');
    child.once('exit', (code, signal) => {
      if (holder !== child) return;
      holder = null;
      if (end !== null) return;
      publish({ method: null, reason: `the ${plan.method} process ended while the link runs (${code ?? signal ?? 'unknown'}); trying again` });
      schedule(deps.retryMs);
    });
    schedule(deps.renewMs);
  };

  await attempt();
  return {
    getState: () => state,
    stop: () => {
      if (end !== null) return;
      end = 'stop';
      if (timer !== null) clearTimeout(timer);
      holder?.kill('SIGTERM');
      holder = null;
      try {
        deps.removeState();
      } catch {
        /* already gone */
      }
    },
    handOver: () => {
      if (end !== null) return;
      end = 'handOver';
      if (timer !== null) clearTimeout(timer);
      if (holder !== null) release(holder);
      holder = null;
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
    holdSeconds: keepAwakeHoldSeconds,
    renewMs: renewEveryMs,
    findExecutable: (name) => findExecutableOnPath(name, `${process.env.PATH ?? ''}${path.delimiter}${systemToolFolders}`, checkIsExecutableFile),
    // Its own process group: a service manager that ends the link's group (launchd does, once the job's main process is gone) must not take the holder with it — that is the very gap this closes.
    spawnHolder: (file, args) => spawn(file, [...args], { stdio: ['ignore', 'ignore', 'pipe'], detached: true }),
    settleMs: defaultSettleMs,
    retryMs: retryAfterMs,
    writeState: (line) => { writeTextFileAtomically(paths.awakeFile, line, stateFileMode); },
    removeState: () => { fs.rmSync(paths.awakeFile, { force: true }); },
  };
}
