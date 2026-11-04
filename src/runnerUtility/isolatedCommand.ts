import { spawn, type ChildProcess } from 'child_process';
import type { CommandOptions, CommandResult } from '../selfUpdate/commandRunner';

/**
 * @description How the ROOT step of the admin pairing line runs everything that is the runner account's — and the account runs the agents' code, so
 * what it can change must never be handed the admin's terminal. A child that is not isolated keeps the controlling terminal of the admin's shell
 * (`execFile` only pipes the three standard streams): through `/dev/tty` it can write over the screen, ask for keystrokes and, where the
 * system still allows it, type into the shell once `sudo` has ended. So a child here
 *
 *   - starts in a session of its own (`detached`: `setsid`), so it has no controlling terminal to open,
 *   - gets no standard input (`/dev/null`),
 *   - has its output PIPED through this process, which strips the control characters (escape sequences, carriage returns, bells, bidirectional
 *     overrides) before anyone prints it — what the account says reaches the operator as plain text, never as terminal commands.
 *
 * A signal that reaches this process (Ctrl-C in the admin's terminal goes to the foreground group, no longer the child's) is passed on to the
 * child's whole group, and once the child is gone this process dies of the signal itself. Builtins only: it runs from the root-owned copy of the
 * package, which has no `node_modules`.
 */

export interface IsolatedCommandOptions extends CommandOptions {
  /** Called with every piece of output as it arrives, already stripped (what the operator watches while a long step works). */
  onOutput?: (text: string, stream: 'stdout' | 'stderr') => void;
}

/** Runs a command to its end with no terminal; never throws — a failure is a result the caller words. */
export type IsolatedCommandRunner = (file: string, args: readonly string[], options: IsolatedCommandOptions) => Promise<CommandResult>;

/** The most of each output kept for the result; the tail is what says what went wrong. */
const maxKeptOutputBytes = 4 * 1024 * 1024;
/** Signals that reach this process and are passed on to the child's group. */
const forwardedSignals: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
/** Everything that is a control character (C0, DEL, C1 — escape sequences start with one), the bidirectional overrides and isolates, and the line and paragraph separators. */
const unsafeCharacterPattern = /[\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/gu;
const keptControlCharacters = new Set(['\n', '\t']);

/** @description `text` with every character that a terminal could act on, or that could disguise what is printed, taken out; newlines and tabs stay. */
export function stripControlCharacters(text: string): string {
  return text.replace(unsafeCharacterPattern, (character) => (keptControlCharacters.has(character) ? character : ''));
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    // A negative pid is the process group, which `detached` made of the child and everything it starts.
    process.kill(-child.pid, signal);
  } catch {
    // Already gone.
  }
}

function keepTail(kept: string, chunk: string): string {
  const joined = kept + chunk;
  return joined.length > maxKeptOutputBytes ? joined.slice(-maxKeptOutputBytes) : joined;
}

/** After the child has exited, how long its output pipes may stay open before they are cut: output still in flight is read in that time, a descendant that left the group and holds them is not waited for. */
const pipeDrainGraceMs = 5000;
/** The same once a deadline has passed or a signal was passed on: the operator is waiting, and nothing more is wanted from the child. */
const killedPipeGraceMs = 1000;
/** After a signal was passed on, how long the child has to end before its whole group is killed. */
const signalEscalationMs = 5000;

/**
 * @description The isolated runner: see the head of the file. It is settled by the child's EXIT, not only by its pipes closing: the account runs the agents'
 * code, and a program of it may start a descendant that leaves the group (`setsid`) and keeps the output open — `close` would then never come, the
 * deadline's kill of the group would miss it and the signals, all taken over here, would only be passed on to a group that is gone. So once the child
 * has exited — or the deadline has passed, or a signal was passed on — the pipes are cut after a short grace and the step ends with what it has. A
 * SECOND signal ends it at once: the group is killed outright and this process dies of the signal.
 */
export const runCommandIsolated: IsolatedCommandRunner = (file, args, options) =>
  new Promise((resolve) => {
    // The signal handlers go in BEFORE the child exists: a signal that comes between the fork and a later `process.on` (milliseconds on a starved machine) takes the
    // default action and kills this program with the child's group — its own session — left working. Node delivers a signal between ticks, so none can run `forward`
    // before `child` is assigned below.
    let child: ChildProcess;
    let stdout = '';
    let stderr = '';
    let isTimedOut = false;
    let interruptedBy: NodeJS.Signals | null = null;
    let isSettled = false;
    let hasExited = false;
    let exitCode: number | null = null;
    let graceTimer: NodeJS.Timeout | null = null;
    let escalationTimer: NodeJS.Timeout | null = null;

    const handlers = forwardedSignals.map((signal) => ({ signal, handler: (): void => forward(signal) }));
    for (const { signal, handler } of handlers) process.on(signal, handler);
    try {
      child = spawn(file, [...args], { cwd: options.cwd, env: options.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      for (const { signal, handler } of handlers) process.removeListener(signal, handler);
      throw error;
    }
    const deadlineTimer = setTimeout(() => {
      isTimedOut = true;
      killGroup(child, 'SIGKILL');
      armGrace(killedPipeGraceMs);
    }, options.timeoutMs);

    const finish = (result: CommandResult): void => {
      if (isSettled) return;
      isSettled = true;
      for (const timer of [deadlineTimer, graceTimer, escalationTimer]) if (timer !== null) clearTimeout(timer);
      for (const { signal, handler } of handlers) process.removeListener(signal, handler);
      child.stdout?.destroy();
      child.stderr?.destroy();
      // The operator interrupted: now that the step is over this process goes too, as an unhandled signal would have ended it.
      if (interruptedBy !== null) process.kill(process.pid, interruptedBy);
      resolve(result);
    };
    const settle = (): void => {
      finish({ ok: hasExited && exitCode === 0 && !isTimedOut, exitCode: hasExited ? exitCode : null, stdout, stderr, isTimedOut });
    };
    function armGrace(graceMs: number): void {
      if (graceTimer !== null) clearTimeout(graceTimer);
      graceTimer = setTimeout(settle, graceMs);
    }
    function forward(signal: NodeJS.Signals): void {
      const isSecond = interruptedBy !== null;
      interruptedBy = signal;
      if (isSecond) {
        killGroup(child, 'SIGKILL');
        settle();
        return;
      }
      killGroup(child, signal);
      escalationTimer = setTimeout(() => {
        killGroup(child, 'SIGKILL');
        armGrace(killedPipeGraceMs);
      }, signalEscalationMs);
      if (hasExited) armGrace(killedPipeGraceMs);
    }

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      const clean = stripControlCharacters(chunk);
      stdout = keepTail(stdout, clean);
      options.onOutput?.(clean, 'stdout');
    });
    child.stderr?.on('data', (chunk: string) => {
      const clean = stripControlCharacters(chunk);
      stderr = keepTail(stderr, clean);
      options.onOutput?.(clean, 'stderr');
    });
    child.once('error', (error) => {
      finish({ ok: false, exitCode: null, stdout, stderr: stderr || stripControlCharacters(error.message), isTimedOut: false });
    });
    child.once('exit', (code) => {
      hasExited = true;
      exitCode = code;
      armGrace(isTimedOut || interruptedBy !== null ? killedPipeGraceMs : pipeDrainGraceMs);
    });
    // `close` comes once the output pipes are drained too: the usual end, at once.
    child.once('close', settle);
  });
