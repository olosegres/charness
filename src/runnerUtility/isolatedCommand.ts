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

/** @description The isolated runner: see the head of the file. */
export const runCommandIsolated: IsolatedCommandRunner = (file, args, options) =>
  new Promise((resolve) => {
    const child = spawn(file, [...args], { cwd: options.cwd, env: options.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let isTimedOut = false;
    let interruptedBy: NodeJS.Signals | null = null;
    let isSettled = false;
    const forward = (signal: NodeJS.Signals): void => {
      interruptedBy = signal;
      killGroup(child, signal);
    };
    const handlers = forwardedSignals.map((signal) => ({ signal, handler: (): void => forward(signal) }));
    for (const { signal, handler } of handlers) process.on(signal, handler);
    const timer = setTimeout(() => {
      isTimedOut = true;
      killGroup(child, 'SIGKILL');
    }, options.timeoutMs);

    const settle = (result: CommandResult): void => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);
      for (const { signal, handler } of handlers) process.removeListener(signal, handler);
      // The operator interrupted: now that the child is gone this process goes too, as an unhandled signal would have ended it.
      if (interruptedBy !== null) process.kill(process.pid, interruptedBy);
      resolve(result);
    };

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
      settle({ ok: false, exitCode: null, stdout, stderr: stderr || stripControlCharacters(error.message), isTimedOut: false });
    });
    // `close`, not `exit`: the output pipes are drained by then.
    child.once('close', (code) => {
      settle({ ok: code === 0 && !isTimedOut, exitCode: code, stdout, stderr, isTimedOut });
    });
  });
