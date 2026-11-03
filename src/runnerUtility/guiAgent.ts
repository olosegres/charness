import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import { writeTextFileAtomically } from '../configDirFile';
import type { RunnerHomePaths } from './runnerHome';

/**
 * @description The login session's agent of an always-on Mac. A runner kept running by LaunchDaemons lives in launchd's System session, and
 * Xcode's nested builds crash there (SIGTRAP at «Resolve Package Graph»; the same build is fine in the account's GUI session). The account's own
 * LaunchAgent in `gui/<uid>` runs this program while the account has a login session; a job that needs iOS runs its steps through it.
 *
 *   `runner.sh`  (job script, System session)       writes <state>/gui/requests/<id>/ — cwd, command, locale, log, env, owner, then `go` last
 *   this agent   (account's GUI session)            starts `bash -c <command>` there, its output appended to the job's log, writes `exit`
 *   a kill       the script touches `kill`           the agent ends the step's process group (TERM, KILL after the runner's grace)
 *   a lost owner the script is gone (SIGKILLed)      the agent ends the step too: nothing runs on for a job nobody waits for
 *
 * The agent beats into `agent.json` every few seconds (`runner.sh` reads it: no beat for {@link guiAgentStaleAfterMs} = no agent = no session, and
 * says so instead of queueing into nothing). A step is the agent's child, so an agent that stops cuts it (launchd ends its process group), and the
 * script sees the heartbeat go, or another `startedAtMs`, and cuts the step with 125. No auto-login: the session is the owner's to open once.
 */

/** How often the agent beats, and how long without a beat is «gone» — `gui_agent_stale_sec` in `remoteRun/runner.sh` is the same number (a test pins both). */
export const guiAgentBeatIntervalMs = 5 * 1000;
export const guiAgentStaleAfterMs = 20 * 1000;
const requestPollMs = 300;
/** How often an agent asks whether its always-on service is still there. */
export const guiAgentServiceCheckIntervalMs = 30 * 1000;
/** After SIGTERM a step gets this long before SIGKILL: `kill_grace_sec` of `runner.sh`. */
const stepKillGraceMs = 10 * 1000;
const statusFileMode = 0o644;
const requestFileNames = { cwd: 'cwd', command: 'command', locale: 'locale', log: 'log', env: 'env', owner: 'owner', go: 'go', started: 'started', kill: 'kill', exit: 'exit' } as const;
/** `cd "$directory" || exit 126` of `run_step`: a step whose folder is gone ends with the shell's code for it. */
const cannotStartExitCode = 126;
const signalExitCodeBase = 128;
const envNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

const statusSchema = z.strictObject({
  pid: z.number().int().positive(),
  uid: z.number().int().nonnegative(),
  account: z.string(),
  /** Another one than a script saw when it asked for its step means the agent restarted: the step is lost. */
  startedAtMs: z.number().int().nonnegative(),
  beatAtMs: z.number().int().nonnegative(),
});

/** @name GuiAgentStatus @description `gui/agent.json`: one JSON line. */
export type GuiAgentStatus = z.infer<typeof statusSchema>;

export function readGuiAgentStatus(paths: RunnerHomePaths): GuiAgentStatus | null {
  try {
    const parsed = statusSchema.safeParse(JSON.parse(fs.readFileSync(paths.guiAgentStatus, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeGuiAgentStatus(paths: RunnerHomePaths, status: GuiAgentStatus): void {
  fs.mkdirSync(path.dirname(paths.guiAgentStatus), { recursive: true, mode: 0o700 });
  writeTextFileAtomically(paths.guiAgentStatus, `${JSON.stringify(statusSchema.parse(status))}\n`, statusFileMode);
}

/** @description Is the agent there: it beat within {@link guiAgentStaleAfterMs} and its process is alive. What `runner.sh` decides the same way. */
export function checkIsGuiAgentAlive(status: GuiAgentStatus | null, nowMs: number, isProcessAlive: (pid: number) => boolean): boolean {
  return status !== null && nowMs - status.beatAtMs <= guiAgentStaleAfterMs && isProcessAlive(status.pid);
}

export function checkIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

/** `NAME=VALUE` per line, as `runner.sh` exports them (no quote handling: the value is everything after the first `=`); a line that is not a pair is skipped. */
export function parseJobEnvLines(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const separator = line.indexOf('=');
    const name = separator === -1 ? '' : line.slice(0, separator);
    if (envNamePattern.test(name)) values[name] = line.slice(separator + 1);
  }
  return values;
}

interface StepRequest {
  directory: string;
  command: string;
  locale: string;
  logFile: string;
  jobEnvText: string;
  ownerPid: number | null;
}

function readTextFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/** The request in `requestDir`, or `null` while it is not whole (`go` is written last, so a folder without it is still being made). */
function readStepRequest(requestDir: string): StepRequest | null {
  if (!fs.existsSync(path.join(requestDir, requestFileNames.go))) return null;
  const read = (name: string): string | null => readTextFile(path.join(requestDir, name));
  const directory = read(requestFileNames.cwd);
  const command = read(requestFileNames.command);
  const logFile = read(requestFileNames.log);
  if (directory === null || command === null || logFile === null) return null;
  const ownerText = read(requestFileNames.owner)?.trim() ?? '';
  return {
    directory,
    command,
    logFile,
    locale: read(requestFileNames.locale) ?? '',
    jobEnvText: read(requestFileNames.env) ?? '',
    ownerPid: /^\d+$/.test(ownerText) ? Number(ownerText) : null,
  };
}

export type StepStarter = (request: { directory: string; command: string; env: NodeJS.ProcessEnv; logFd: number }) => ChildProcess;

export interface GuiAgentDeps {
  now: () => number;
  isProcessAlive: (pid: number) => boolean;
  /** The environment a job gets over the link (`readExecEnv`): the step runs in the same one, plus the job's own `-e` lines. */
  readEnv: () => NodeJS.ProcessEnv;
  startStep: StepStarter;
  /** SIGTERM / SIGKILL to a step's whole process group. */
  signalGroup: (pid: number, signal: NodeJS.Signals) => void;
  pid: number;
  uid: number;
  account: string;
  killGraceMs: number;
}

export function createGuiAgentDeps(readEnv: () => NodeJS.ProcessEnv): GuiAgentDeps {
  return {
    now: Date.now,
    isProcessAlive: checkIsProcessAlive,
    readEnv,
    startStep: ({ directory, command, env, logFd }) => spawn('/bin/bash', ['-c', command], { cwd: directory, env, detached: true, stdio: ['ignore', logFd, logFd] }),
    signalGroup: (pid, signal) => {
      try {
        process.kill(-pid, signal);
      } catch {
        /* the group is gone already */
      }
    },
    pid: process.pid,
    uid: os.userInfo().uid,
    account: os.userInfo().username,
    killGraceMs: stepKillGraceMs,
  };
}

interface RunningStep {
  child: ChildProcess;
  terminatedAtMs: number | null;
  isKilled: boolean;
}

export interface GuiAgent {
  /** One look: start the requests that are ready, end the steps asked to end (or whose job script is gone), clean up after dead scripts, beat when due. */
  tick: () => void;
  /** Steps that are running now. */
  getRunningCount: () => number;
  /** End every running step and remove the heartbeat: the agent is leaving. */
  stop: () => void;
  getStartedAtMs: () => number;
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  const signalNumber = signal === null ? undefined : os.constants.signals[signal];
  return signalExitCodeBase + (signalNumber ?? 0);
}

/** @description The agent's work, without a loop: {@link GuiAgent.tick} is called every {@link requestPollMs}-ish by `runGuiAgent`, and by a test whenever it wants one look. */
export function createGuiAgent(paths: RunnerHomePaths, deps: GuiAgentDeps): GuiAgent {
  const startedAtMs = deps.now();
  const running = new Map<string, RunningStep>();
  let lastBeatAtMs = 0;

  const writeExit = (requestDir: string, code: number): void => {
    writeTextFileAtomically(path.join(requestDir, requestFileNames.exit), `${code}\n`, 0o644);
  };

  const beat = (): void => {
    lastBeatAtMs = deps.now();
    writeGuiAgentStatus(paths, { pid: deps.pid, uid: deps.uid, account: deps.account, startedAtMs, beatAtMs: lastBeatAtMs });
  };

  const startRequest = (id: string, requestDir: string, request: StepRequest): void => {
    fs.writeFileSync(path.join(requestDir, requestFileNames.started), `${deps.now()}\n`);
    const env: NodeJS.ProcessEnv = { ...deps.readEnv(), ...(request.locale === '' ? {} : { LC_ALL: request.locale }), ...parseJobEnvLines(request.jobEnvText) };
    let logFd: number | null = null;
    try {
      logFd = fs.openSync(request.logFile, 'a');
      const child = deps.startStep({ directory: request.directory, command: request.command, env, logFd });
      const step: RunningStep = { child, terminatedAtMs: null, isKilled: false };
      running.set(id, step);
      child.once('error', () => {
        if (running.get(id) === step) running.delete(id);
        writeExit(requestDir, cannotStartExitCode);
      });
      child.once('close', (code, signal) => {
        if (running.get(id) !== step) return;
        running.delete(id);
        writeExit(requestDir, describeExit(code, signal));
      });
    } catch {
      writeExit(requestDir, cannotStartExitCode);
    } finally {
      if (logFd !== null) fs.closeSync(logFd);
    }
  };

  const endStep = (step: RunningStep): void => {
    const pid = step.child.pid;
    if (pid === undefined) return;
    if (step.terminatedAtMs === null) {
      step.terminatedAtMs = deps.now();
      deps.signalGroup(pid, 'SIGTERM');
    } else if (!step.isKilled && deps.now() - step.terminatedAtMs >= deps.killGraceMs) {
      step.isKilled = true;
      deps.signalGroup(pid, 'SIGKILL');
    }
  };

  const lookAtRequest = (id: string): void => {
    const requestDir = path.join(paths.guiRequestsDir, id);
    const request = readStepRequest(requestDir);
    if (request === null) return;
    const step = running.get(id);
    const isOwnerGone = request.ownerPid !== null && !deps.isProcessAlive(request.ownerPid);
    if (step !== undefined) {
      if (isOwnerGone || fs.existsSync(path.join(requestDir, requestFileNames.kill)) || step.terminatedAtMs !== null) endStep(step);
      return;
    }
    // Not running: a script that is gone leaves nothing behind; a request already started (by an earlier agent) is never started again.
    if (isOwnerGone) {
      fs.rmSync(requestDir, { recursive: true, force: true });
      return;
    }
    if (!fs.existsSync(path.join(requestDir, requestFileNames.started)) && !fs.existsSync(path.join(requestDir, requestFileNames.exit))) startRequest(id, requestDir, request);
  };

  return {
    tick: () => {
      if (deps.now() - lastBeatAtMs >= guiAgentBeatIntervalMs) beat();
      let ids: string[] = [];
      try {
        ids = fs.readdirSync(paths.guiRequestsDir);
      } catch {
        ids = [];
      }
      for (const id of ids) lookAtRequest(id);
    },
    getRunningCount: () => running.size,
    stop: () => {
      for (const step of running.values()) endStep(step);
      fs.rmSync(paths.guiAgentStatus, { force: true });
    },
    getStartedAtMs: () => startedAtMs,
  };
}

/** How often `runGuiAgent` looks. */
export const guiAgentPollMs = requestPollMs;

export interface GuiAgentRunOptions {
  signal: AbortSignal;
  /**
   * Is the always-on service this agent belongs to gone (an admin removed the daemons)? The agent then leaves for good — the command that runs it also
   * removes its own definition — instead of waiting in the account's session for a link that will not come back. This is how it is removed with the
   * daemons: no command an admin pastes names the account's folders (what the runner reports about itself never goes into a `sudo` line).
   */
  checkIsServiceRemoved?: () => boolean;
  /** How often that is asked ({@link guiAgentServiceCheckIntervalMs}; a test's own). */
  serviceCheckIntervalMs?: number;
  /** The id of the package copy that runs (the folder `current` points at): another one means an update, and an idle agent restarts onto it by leaving. */
  getAppId: () => string | null;
  /** Called every poll too: the silencer of the Simulator's audio. */
  onTick?: () => void;
}

/**
 * @description Run the agent until `signal` aborts; `'restart'` when an update replaced the package and no step runs (the service manager starts it again, now on
 * the new code); `'removed'` when its always-on service is gone.
 */
export async function runGuiAgent(paths: RunnerHomePaths, deps: GuiAgentDeps, options: GuiAgentRunOptions): Promise<'stopped' | 'restart' | 'removed'> {
  fs.mkdirSync(paths.guiRequestsDir, { recursive: true, mode: 0o700 });
  const agent = createGuiAgent(paths, deps);
  const startedAppId = options.getAppId();
  return new Promise((resolve) => {
    let lastServiceCheckMs = deps.now();
    const finish = (result: 'stopped' | 'restart' | 'removed'): void => {
      clearInterval(timer);
      agent.stop();
      resolve(result);
    };
    const timer = setInterval(() => {
      agent.tick();
      options.onTick?.();
      if (agent.getRunningCount() === 0 && options.getAppId() !== startedAppId) finish('restart');
      else if (options.checkIsServiceRemoved !== undefined && deps.now() - lastServiceCheckMs >= (options.serviceCheckIntervalMs ?? guiAgentServiceCheckIntervalMs)) {
        lastServiceCheckMs = deps.now();
        if (options.checkIsServiceRemoved()) finish('removed');
      }
    }, requestPollMs);
    agent.tick();
    options.signal.addEventListener('abort', () => finish('stopped'), { once: true });
  });
}
