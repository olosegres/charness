import { spawn, spawnSync, type ChildProcess } from 'child_process';
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
 *   this agent   (account's GUI session)            starts `bash -c <command>` there as the leader of a process group of its own, writes that group's id
 *                                                   (`pgid`), its output appended to the job's log, and `exit` when it ends
 *   a kill       the script touches `kill`           the agent ends the step's process group (TERM, KILL after the runner's grace)
 *   a lost owner the script is gone (SIGKILLed)      the agent ends the step too: nothing runs on for a job nobody waits for
 *
 * The agent beats into `agent.json` every few seconds (`runner.sh` reads it: no beat for {@link guiAgentStaleAfterMs} = no agent = no session, and
 * says so instead of queueing into nothing). A step is NOT taken down with the agent: it is a process group of its own (`detached` is `setsid`), which
 * neither a crash of the agent nor launchd ending the agent's own group reaches — so the group id is in the request folder, and whoever cuts a step ends
 * its group: the script, when it cuts the step with 125 because the heartbeat is gone or another instance answers (TERM, KILL after the grace), and an
 * agent that starts and finds the groups of an earlier instance (`reapStepsOfEarlierInstances`). Without that a dying agent would orphan an `xcodebuild`
 * while the script released the project's lock to the next job. No auto-login: the session is the owner's to open once.
 *
 * A recorded id is NEVER signalled on trust: the folders live on disk and survive a reboot, pids restart after one, and an old number can name an unrelated
 * group of the account (Finder, the Dock, the new agent). A folder older than the system's boot is removed without a signal; otherwise the id is signalled only
 * while the process of that pid still has the start time recorded beside it (`pgid-start`, from `ps -o lstart=`) — or is gone while the group's other members
 * keep the id from being handed out again. The same goes for the job script's pid (`owner`, `owner-start`): a reused pid does not make a dead script look alive.
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
const requestFileNames = { cwd: 'cwd', command: 'command', locale: 'locale', log: 'log', env: 'env', owner: 'owner', go: 'go', started: 'started', pgid: 'pgid', pgidStart: 'pgid-start', ownerStart: 'owner-start', cut: 'cut', kill: 'kill', exit: 'exit' } as const;
/** The exit code of a step that was cut (its agent was replaced, its script went): what `runner.sh` says for a cut step. */
const cutStepExitCode = 125;
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
  /** The script's start time as `ps` says it (recorded by the script), `null` from a script that did not record it. */
  ownerStart: string | null;
}

/** What `ps -o lstart=` says of a process's start, the way both sides compare it: whitespace squeezed, so «Tue Nov  4 02:10:11 2026» is one string everywhere. */
export function normalizeProcessStart(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** What is known of a process's start: the text (`known`), that there is no such process (`none`), or that `ps` could not be asked (`unknown`). */
export type ProcessStart = { kind: 'known'; text: string } | { kind: 'none' } | { kind: 'unknown' };

const processStartDeadlineMs = 5 * 1000;

/** @description The start time of process `pid` from `ps -o lstart= -p` (C locale: one format on Linux and macOS, and the one `runner.sh` reads). */
export function readProcessStart(pid: number): ProcessStart {
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', `${pid}`], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout: processStartDeadlineMs });
  if (result.error !== undefined || result.signal !== null || result.status === null) return { kind: 'unknown' };
  const text = normalizeProcessStart(result.stdout);
  if (result.status === 0 && text !== '') return { kind: 'known', text };
  return result.status === 1 && text === '' ? { kind: 'none' } : { kind: 'unknown' };
}

/** When the system booted, from its uptime: what a folder written before it must not be trusted past (`Date.now() - os.uptime()`). */
export function getBootTimeMs(): number {
  return Date.now() - os.uptime() * 1000;
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
    ownerStart: normalizeProcessStart(read(requestFileNames.ownerStart) ?? '') || null,
  };
}

/** Start a step as the LEADER of a process group of its own (its pgid is its pid): the group is what a cut ends. */
export type StepStarter = (request: { directory: string; command: string; env: NodeJS.ProcessEnv; logFd: number }) => ChildProcess;

export interface GuiAgentDeps {
  now: () => number;
  isProcessAlive: (pid: number) => boolean;
  /** The environment a job gets over the link (`readExecEnv`): the step runs in the same one, plus the job's own `-e` lines. */
  readEnv: () => NodeJS.ProcessEnv;
  startStep: StepStarter;
  /** SIGTERM / SIGKILL to a step's whole process group. */
  signalGroup: (pid: number, signal: NodeJS.Signals) => void;
  /** Is any process left in the group? */
  isGroupAlive: (pgid: number) => boolean;
  /** The start time of a process (`readProcessStart`): what keeps a recorded pid from being trusted once it names someone else. */
  readProcessStart: (pid: number) => ProcessStart;
  /** When the system booted: a request folder from before it is stale, whatever its pids say. */
  getBootTimeMs: () => number;
  /** A problem of one request that must not take the agent down (a full disk, a folder nobody can write): told, and the agent goes on. */
  reportError: (line: string) => void;
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
    isGroupAlive: (pgid) => checkIsProcessAlive(-pgid),
    readProcessStart,
    getBootTimeMs,
    reportError: (line) => { process.stderr.write(`charness-runner: ${line}\n`); },
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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
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
  /** Process groups of steps nobody runs any more (an earlier agent's, a vanished script's), asked to end and not yet gone: killed after the grace. */
  const groupsEnding: Array<{ pgid: number; recordedStart: string; terminatedAtMs: number }> = [];
  /**
   * Requests whose handling failed. The failure is told ONCE, however many looks it takes to answer: the script that waits for the step keeps seeing the agent beat,
   * so it never cuts the step itself — the only way it stops waiting is an answer, and a request left without one would hang its job (and hold its project's lock).
   */
  const failedRequests = new Map<string, { answerCode: number; isAnswerPending: boolean; isAnswerFailureTold: boolean }>();
  /** Per request, the pid of its job script whose start time was checked: a pid is not handed out while its process lives, so one check is all there is to do. */
  const verifiedOwners = new Map<string, number>();
  let lastBeatAtMs = 0;

  /**
   * A file of a request folder, through a temp file and a rename so a script never reads half of it — and NOT through `writeTextFileAtomically`, which makes missing
   * folders: the script that cut the step has removed its request folder already (it ended the step's group and went on), nobody is left to read the answer, and a
   * folder made again for it would be litter nothing removes. Some of this runs from the step's `close` event: a throw there would be an uncaught exception that kills
   * the whole agent, so a folder that is gone is no error — `false` says so — while any other failure (a full disk, no permission) is thrown for the caller to answer.
   */
  const writeIntoRequest = (requestDir: string, name: string, text: string): boolean => {
    const file = path.join(requestDir, name);
    const tempFile = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tempFile, text, { mode: 0o644 });
      fs.renameSync(tempFile, file);
      return true;
    } catch (error) {
      fs.rmSync(tempFile, { force: true });
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
      throw error;
    }
  };

  const writeExit = (requestDir: string, code: number): void => {
    writeIntoRequest(requestDir, requestFileNames.exit, `${code}\n`);
  };

  /**
   * Answer a failed request with the code kept for it: 126 («the step could not be started») — or, where the step ran and only its end could not be written down, its own
   * code. Where even that cannot be written (a full disk) the answer stays pending and is tried again on every look — told once — until it goes through. Nothing is
   * answered for a request whose step runs.
   */
  const answerFailedRequest = (id: string, requestDir: string): void => {
    const failed = failedRequests.get(id);
    if (failed === undefined || running.has(id)) return;
    if (fs.existsSync(path.join(requestDir, requestFileNames.exit))) {
      failed.isAnswerPending = false;
      return;
    }
    try {
      writeExit(requestDir, failed.answerCode);
      failed.isAnswerPending = false;
    } catch (error) {
      if (failed.isAnswerFailureTold) return;
      failed.isAnswerFailureTold = true;
      deps.reportError(`the answer of request ${id} could not be written (${describeError(error)}): it is tried again on every look`);
    }
  };

  /** A request whose handling threw: told once (`what` names the failure), answered `answerCode` — 126, unless the step ran and ended with a code of its own. The first code kept wins. */
  const failRequest = (id: string, requestDir: string, what: string, error: unknown, answerCode: number = cannotStartExitCode): void => {
    if (!failedRequests.has(id)) {
      failedRequests.set(id, { answerCode, isAnswerPending: true, isAnswerFailureTold: false });
      deps.reportError(`${what} (${id}: ${describeError(error)})`);
    }
    answerFailedRequest(id, requestDir);
  };

  /** The step's own end, written from an event handler: a throw there would take the whole agent down, so a write that fails is a failed request instead — answered with the step's real code once it can be written. */
  const answerStepEnd = (id: string, requestDir: string, code: number): void => {
    try {
      writeExit(requestDir, code);
    } catch (error) {
      failRequest(id, requestDir, 'the end of a step could not be written down', error, code);
    }
  };

  const beat = (): void => {
    lastBeatAtMs = deps.now();
    writeGuiAgentStatus(paths, { pid: deps.pid, uid: deps.uid, account: deps.account, startedAtMs, beatAtMs: lastBeatAtMs });
  };

  const readPgid = (requestDir: string): number | null => {
    const text = readTextFile(path.join(requestDir, requestFileNames.pgid))?.trim() ?? '';
    // 1 is not a group a step can lead (it would be everything): a damaged file never reaches it.
    return /^\d+$/.test(text) && Number(text) > 1 ? Number(text) : null;
  };

  const readRecordedGroupStart = (requestDir: string): string | null => normalizeProcessStart(readTextFile(path.join(requestDir, requestFileNames.pgidStart)) ?? '') || null;

  /**
   * Is `pgid` still the group of the step whose leader started at `recordedStart`? The leader is there with that very start (it is ours); or the leader is gone while the
   * group still has members — a pid is not handed out while a group carries it, so that is the same group; anything else (another process with that pid, no start
   * recorded, `ps` that cannot be asked, nothing left) is not a group to signal.
   */
  const checkIsRecordedGroup = (pgid: number, recordedStart: string | null): boolean => {
    if (recordedStart === null) return false;
    const current = deps.readProcessStart(pgid);
    if (current.kind === 'known') return current.text === recordedStart;
    if (current.kind === 'unknown') return false;
    return deps.isGroupAlive(pgid);
  };

  /**
   * Is the job script of a request still there? Its pid alive AND, where the script recorded its start, that process: the start is compared on the first look at the
   * request (a pid of an earlier boot or an earlier script may name someone else by then), and no more after it matched — `ps` is a fork the agent waits for, and it has a
   * heartbeat to write.
   */
  const checkIsOwnerAlive = (id: string, request: StepRequest): boolean => {
    if (request.ownerPid === null) return true;
    if (!deps.isProcessAlive(request.ownerPid)) return false;
    if (request.ownerStart === null || verifiedOwners.get(id) === request.ownerPid) return true;
    const current = deps.readProcessStart(request.ownerPid);
    if (current.kind === 'unknown') return true;
    if (current.kind !== 'known' || current.text !== request.ownerStart) return false;
    verifiedOwners.set(id, request.ownerPid);
    return true;
  };

  const getFileTimeMs = (filePath: string): number | null => {
    try {
      return fs.statSync(filePath).mtimeMs;
    } catch {
      return null;
    }
  };

  /** Was the request written before the system booted? By the time the step started, else by its `go` (or the folder's own time): nothing in it — a pid, a group — can be trusted. */
  const checkIsFromEarlierBoot = (requestDir: string): boolean => {
    const startedText = readTextFile(path.join(requestDir, requestFileNames.started))?.trim() ?? '';
    const referenceMs = /^\d+$/.test(startedText) ? Number(startedText) : (getFileTimeMs(path.join(requestDir, requestFileNames.go)) ?? getFileTimeMs(requestDir));
    return referenceMs !== null && referenceMs < deps.getBootTimeMs();
  };

  /** End the process group of a step that is not (or is no longer) this agent's own to run — if it is the group that was recorded: TERM now, KILL after the grace if anything is left. */
  const endGroupOfOrphan = (requestDir: string): void => {
    const pgid = readPgid(requestDir);
    const recordedStart = readRecordedGroupStart(requestDir);
    if (pgid === null || recordedStart === null || groupsEnding.some((entry) => entry.pgid === pgid) || !checkIsRecordedGroup(pgid, recordedStart)) return;
    deps.signalGroup(pgid, 'SIGTERM');
    groupsEnding.push({ pgid, recordedStart, terminatedAtMs: deps.now() });
  };

  const finishEndingGroups = (): void => {
    for (let index = groupsEnding.length - 1; index >= 0; index -= 1) {
      const { pgid, recordedStart, terminatedAtMs } = groupsEnding[index];
      if (!deps.isGroupAlive(pgid)) groupsEnding.splice(index, 1);
      else if (deps.now() - terminatedAtMs >= deps.killGraceMs) {
        if (checkIsRecordedGroup(pgid, recordedStart)) deps.signalGroup(pgid, 'SIGKILL');
        groupsEnding.splice(index, 1);
      }
    }
  };

  /**
   * An agent that starts finds the steps of the one before it: it was replaced or crashed under them, and a step is a process group of its own that nothing
   * took down. A folder from before the system booted is removed with nothing signalled. Every other step that never wrote its `exit` has its (recorded) group ended;
   * a script that still waits is answered 125 and told by `cut` that its step was cut (it ends the group itself before it goes on), a script that is gone leaves its
   * folder to be removed.
   */
  const reapStepsOfEarlierInstances = (): void => {
    let ids: string[] = [];
    try {
      ids = fs.readdirSync(paths.guiRequestsDir);
    } catch {
      return;
    }
    for (const id of ids) {
      const requestDir = path.join(paths.guiRequestsDir, id);
      if (checkIsFromEarlierBoot(requestDir)) {
        fs.rmSync(requestDir, { recursive: true, force: true });
        continue;
      }
      if (fs.existsSync(path.join(requestDir, requestFileNames.exit)) || !fs.existsSync(path.join(requestDir, requestFileNames.started))) continue;
      endGroupOfOrphan(requestDir);
      const request = readStepRequest(requestDir);
      if (request !== null && checkIsOwnerAlive(id, request)) {
        writeIntoRequest(requestDir, requestFileNames.cut, '');
        writeExit(requestDir, cutStepExitCode);
      } else {
        fs.rmSync(requestDir, { recursive: true, force: true });
      }
    }
  };

  /** Record the group of a step just started — its leader's start time first, then the id, so that an id is never there without the start that vouches for it. */
  const recordGroup = (requestDir: string, pgid: number): 'recorded' | 'skipped' | 'gone' => {
    const start = deps.readProcessStart(pgid);
    // The leader has exited already: nothing to record, its own end is the answer. A start that cannot be READ is another matter — a group nobody can verify is a group no cut may ever
    // signal, so it is a group that cannot be recorded.
    if (start.kind === 'none') return 'skipped';
    if (start.kind === 'unknown') throw new Error('the start of the step\'s leader could not be read (`ps` did not answer)');
    if (!writeIntoRequest(requestDir, requestFileNames.pgidStart, `${start.text}\n`)) return 'gone';
    return writeIntoRequest(requestDir, requestFileNames.pgid, `${pgid}\n`) ? 'recorded' : 'gone';
  };

  const startRequest = (id: string, requestDir: string, request: StepRequest): void => {
    // The script cut its step and removed the folder in the meantime: nothing is left to run for. A write that fails any other way throws to the look, which answers 126.
    if (!writeIntoRequest(requestDir, requestFileNames.started, `${deps.now()}\n`)) return;
    let logFd: number | null = null;
    try {
      const env: NodeJS.ProcessEnv = { ...deps.readEnv(), ...(request.locale === '' ? {} : { LC_ALL: request.locale }), ...parseJobEnvLines(request.jobEnvText) };
      logFd = fs.openSync(request.logFile, 'a');
      const child = deps.startStep({ directory: request.directory, command: request.command, env, logFd });
      const step: RunningStep = { child, terminatedAtMs: null, isKilled: false };
      running.set(id, step);
      child.once('error', () => {
        if (running.get(id) === step) running.delete(id);
        answerStepEnd(id, requestDir, cannotStartExitCode);
      });
      child.once('close', (code, signal) => {
        if (running.get(id) !== step) return;
        running.delete(id);
        answerStepEnd(id, requestDir, describeExit(code, signal));
      });
      let recording: 'recorded' | 'skipped' | 'gone' = 'skipped';
      try {
        if (child.pid !== undefined) recording = recordGroup(requestDir, child.pid);
      } catch (error) {
        // The group cannot be recorded (a full disk, no permission, a start nobody could read): it must not run where no cut could find it. It ends here, and the answer is «could not start».
        running.delete(id);
        if (child.pid !== undefined) deps.signalGroup(child.pid, 'SIGKILL');
        failRequest(id, requestDir, 'the process group of a step could not be recorded, so the step was ended', error);
        return;
      }
      if (recording === 'gone') {
        // The folder went while the step started: the script is gone with it, and nobody will read an answer.
        running.delete(id);
        if (child.pid !== undefined) deps.signalGroup(child.pid, 'SIGKILL');
      }
    } catch (error) {
      failRequest(id, requestDir, 'a step could not be started', error);
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
    const step = running.get(id);
    // A folder from before the system booted — whatever its pids and groups now name — is removed with nothing signalled. (Never a folder this agent runs a step for.)
    if (step === undefined && checkIsFromEarlierBoot(requestDir)) {
      fs.rmSync(requestDir, { recursive: true, force: true });
      return;
    }
    const request = readStepRequest(requestDir);
    if (request === null) return;
    const isOwnerGone = !checkIsOwnerAlive(id, request);
    if (step !== undefined) {
      if (isOwnerGone || fs.existsSync(path.join(requestDir, requestFileNames.kill)) || step.terminatedAtMs !== null) endStep(step);
      return;
    }
    // Not running: a script that is gone leaves nothing behind — its step's group, if an earlier agent started one, is ended — and a request already
    // started (by an earlier agent) is never started again.
    if (isOwnerGone) {
      if (!fs.existsSync(path.join(requestDir, requestFileNames.exit))) endGroupOfOrphan(requestDir);
      fs.rmSync(requestDir, { recursive: true, force: true });
      return;
    }
    const failed = failedRequests.get(id);
    if (failed !== undefined) {
      if (failed.isAnswerPending) answerFailedRequest(id, requestDir);
      return;
    }
    if (!fs.existsSync(path.join(requestDir, requestFileNames.started)) && !fs.existsSync(path.join(requestDir, requestFileNames.exit))) startRequest(id, requestDir, request);
  };

  reapStepsOfEarlierInstances();

  return {
    tick: () => {
      if (deps.now() - lastBeatAtMs >= guiAgentBeatIntervalMs) beat();
      finishEndingGroups();
      let ids: string[];
      try {
        ids = fs.readdirSync(paths.guiRequestsDir);
      } catch {
        // A folder that cannot be listed this time (too many open files, an I/O error) says nothing about its requests: what is remembered of them stays.
        return;
      }
      for (const id of ids) {
        try {
          lookAtRequest(id);
        } catch (error) {
          failRequest(id, path.join(paths.guiRequestsDir, id), 'a request of the login session\'s agent could not be handled', error);
        }
      }
      // What is remembered of a request goes with its folder.
      for (const remembered of [failedRequests, verifiedOwners]) {
        for (const id of remembered.keys()) if (!ids.includes(id)) remembered.delete(id);
      }
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
