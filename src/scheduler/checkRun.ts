import { spawn } from 'node:child_process';

/**
 * @description The `'check'` delivery kind: a watchdog the agent creates with
 * `schedule_create` + `checkCommand`. At fire time the BOT runs the command in the
 * topic's bound folder; exit 0 is a pass and stays silent. The first failure after
 * a pass pins an alert and wakes the agent with the job's prompt plus the failure
 * and the output tail; further failures stay silent until a run passes again,
 * which posts one unpinned "passes again" line.
 *
 * WHY the bot runs it: a watcher the agent builds itself (a background loop,
 * `nohup`, a `sleep` loop, a tmux pane) dies with the session, a bot restart or a
 * crash, and then fails silently. A schedule is persisted, re-armed at boot and
 * catches up a run missed while the bot was down.
 *
 * The command runs as the bot's own user, the same user the agent's shell tools
 * run as, so it grants the agent nothing it could not already do.
 */

/** Timeout applied when `schedule_create` leaves `checkTimeoutSeconds` out. */
export const defaultCheckTimeoutSec = 60;

/** Upper bound of `checkTimeoutSeconds`: a check is a probe, not a job. */
export const maxCheckTimeoutSec = 600;

/** Longest `checkCommand` accepted. */
export const maxCheckCommandLength = 1000;

/** Output kept from a run (its TAIL — the end of a log is where the failure is). */
export const checkOutputMaxChars = 3000;

/**
 * Output tail shown in the topic alert. Shorter than {@link checkOutputMaxChars}
 * so the alert stays under Telegram's 4096-character message cap with the
 * command and the job name around it; the agent gets the full kept tail.
 */
export const checkAlertOutputMaxChars = 1500;

/** Command text shown in the topic alert. */
const checkAlertCommandMaxChars = 300;

/** Pause between SIGTERM and SIGKILL for a check that outlived its timeout. */
const checkKillGraceMs = 5000;

/** Environment variables a check never sees: its output is posted into the topic. */
const checkHiddenEnvNames = ['TELEGRAM_BOT_TOKEN'];

/**
 * @name CheckRunResult
 * @description One finished check run. `exitCode` is null when the process was
 * killed by a signal or never started (`startError`).
 */
export interface CheckRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  isTimedOut: boolean;
  /** Why the shell could not be started (e.g. the folder is gone). */
  startError?: string;
  /** Combined stdout + stderr, the last {@link checkOutputMaxChars} characters. */
  output: string;
}

/** @description A run passes only when it exited 0 within its timeout. */
export function checkIsCheckPassing(result: CheckRunResult): boolean {
  return result.exitCode === 0 && !result.isTimedOut && result.startError === undefined;
}

/**
 * What a finished run should produce: nothing (`quiet`), the alert that wakes
 * the agent (`alert`), or the one "passes again" line (`recovered`).
 */
export type CheckAlertDecision = 'quiet' | 'alert' | 'recovered';

/**
 * @description Alert on the passing → failing edge only, and announce the
 * failing → passing edge once. A check that keeps failing stays quiet: it already
 * raised its alert and woke the agent, and repeating that on every run would bury
 * the topic in pins.
 */
export function getCheckAlertDecision(input: { isPassing: boolean; wasFailing: boolean }): CheckAlertDecision {
  if (input.isPassing) return input.wasFailing ? 'recovered' : 'quiet';
  return input.wasFailing ? 'quiet' : 'alert';
}

/** @description Short technical description of a failed run: `exit 3`, `timeout 60s`, `SIGKILL`. */
export function describeCheckFailure(result: CheckRunResult, timeoutSec: number): string {
  if (result.startError !== undefined) return `error: ${result.startError}`;
  if (result.isTimedOut) return `timeout ${timeoutSec}s`;
  if (result.exitCode !== null) return `exit ${result.exitCode}`;
  return result.signal ?? 'killed';
}

/** @description The last `maxChars` characters of `text`, marked when something was cut. */
export function getOutputTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `…${text.slice(text.length - maxChars + 1)}`;
}

/** @description The command as the topic alert shows it, cut to a readable length. */
export function getCheckAlertCommand(command: string): string {
  return command.length <= checkAlertCommandMaxChars
    ? command
    : `${command.slice(0, checkAlertCommandMaxChars - 1)}…`;
}

/**
 * @description The prompt the agent is woken with: what failed and how, the
 * output tail, then the job's own prompt (what to do about it). English, like the
 * `[Scheduled run]` marker — it is read by the agent, never shown in the topic.
 */
export function buildCheckFailurePrompt(input: {
  name: string;
  command: string;
  failure: string;
  output: string;
  prompt: string;
}): string {
  const output = input.output.trim() || '(no output)';
  return [
    `[Scheduled check "${input.name}" failed]`,
    `Command (run by the bot in this folder): ${input.command}`,
    `Result: ${input.failure}`,
    'Output (tail):',
    '```',
    output,
    '```',
    '',
    'The bot stays silent while the check keeps failing and tells the topic when it passes again.',
    '',
    input.prompt,
  ].join('\n');
}

/** @description The bot's environment minus the variables a check must not see. */
export function buildCheckEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const checkEnv = { ...env };
  for (const name of checkHiddenEnvNames) delete checkEnv[name];
  return checkEnv;
}

/**
 * @description Run `command` through `/bin/sh -c` in `cwd` and collect its output
 * tail. The shell leads its own process group, so a run that outlives
 * `timeoutMs` is stopped together with everything it started: SIGTERM to the
 * group, SIGKILL after a grace period. Never rejects — a shell that cannot start
 * resolves with `startError`.
 */
export function runCheckCommand(input: {
  command: string;
  cwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
}): Promise<CheckRunResult> {
  return new Promise((resolve) => {
    let output = '';
    let isTimedOut = false;
    let killTimer: NodeJS.Timeout | null = null;
    let isSettled = false;

    const child = spawn('/bin/sh', ['-c', input.command], {
      cwd: input.cwd,
      env: input.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const appendOutput = (chunk: Buffer): void => {
      output = getOutputTail(output + chunk.toString('utf-8'), checkOutputMaxChars);
    };
    child.stdout?.on('data', appendOutput);
    child.stderr?.on('data', appendOutput);

    const signalGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The group already exited.
      }
    };

    const timeoutTimer = setTimeout(() => {
      isTimedOut = true;
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => signalGroup('SIGKILL'), checkKillGraceMs);
      killTimer.unref?.();
    }, input.timeoutMs);
    timeoutTimer.unref?.();

    const settle = (result: CheckRunResult): void => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve(result);
    };

    child.on('error', (error) => {
      settle({ exitCode: null, signal: null, isTimedOut: false, startError: error.message, output });
    });
    child.on('close', (exitCode, signal) => {
      settle({ exitCode, signal, isTimedOut, output });
    });
  });
}
