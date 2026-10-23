import { execFile } from 'child_process';

export interface CommandResult {
  ok: boolean;
  /** `null` when the process never started or was killed (timeout). */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  isTimedOut: boolean;
}

export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** A finite child gets a deadline that runs the failure path: the process is killed when it passes. */
  timeoutMs: number;
}

/** Runs a command to its end; never throws — a failure is a result the caller words. */
export type CommandRunner = (file: string, args: readonly string[], options: CommandOptions) => Promise<CommandResult>;

/** Large enough for an npm install's or a build's output; the engine keeps only a tail of it. */
const maxOutputBytes = 32 * 1024 * 1024;

/** @description The real runner: `execFile` with a deadline. */
export const runCommand: CommandRunner = (file, args, options) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { cwd: options.cwd, env: options.env, timeout: options.timeoutMs, maxBuffer: maxOutputBytes, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ ok: true, exitCode: 0, stdout, stderr, isTimedOut: false });
          return;
        }
        // `execFile` reports a killed (timed out) child with `killed` and a null code, a failed start with a string code.
        const isTimedOut = error.killed === true;
        resolve({
          ok: false,
          exitCode: typeof error.code === 'number' ? error.code : null,
          stdout,
          stderr: stderr || error.message,
          isTimedOut,
        });
      },
    );
  });

/** @description The last `lineCount` non-empty lines of a command's output, for a failure message. */
export function getOutputTail(result: CommandResult, lineCount = 5): string {
  const lines = `${result.stderr}\n${result.stdout}`.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  return lines.slice(-lineCount).join('\n');
}
