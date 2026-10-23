import * as fs from 'fs';
import * as path from 'path';

/**
 * Replacing the running process with a fresh image of the same charness: `process.execve` — the SAME pid, so systemd,
 * pm2, nohup or a foreground terminal see nothing happen. The new image gets the launch environment (see
 * `launchEnvironment.ts`) and the original arguments; the agents are external processes and are re-adopted as on any restart.
 */

/** `EX_TEMPFAIL`: the restart could not be done now, a supervisor may try again. */
export const restartFailedExitCode = 75;

export interface ReexecTarget {
  file: string;
  args: string[];
}

/** @description The command line of a re-exec: `node <packageRoot>/dist/cli.js <the original arguments>`. */
export function getReexecTarget(options: { execPath: string; packageRoot: string; argv: readonly string[] }): ReexecTarget {
  const cliPath = path.join(options.packageRoot, 'dist', 'cli.js');
  // argv[0] of the new image is the executable itself; `process.argv` here is [node, script, ...arguments].
  return { file: options.execPath, args: [options.execPath, cliPath, ...options.argv.slice(2)] };
}

/** @description What would make a re-exec fail, found BEFORE anything is shut down: a missing node, a missing `dist/cli.js`. */
export function getReexecProblems(target: ReexecTarget, checkExists: (target: string) => boolean = fs.existsSync): string[] {
  const problems: string[] = [];
  if (!checkExists(target.file)) problems.push(`the node executable ${target.file} is gone`);
  const cliPath = target.args[1];
  if (!checkExists(cliPath)) problems.push(`${cliPath} is gone`);
  return problems;
}

export interface ReexecDeps {
  execve: ((file: string, args: readonly string[], env: NodeJS.ProcessEnv) => never) | undefined;
  exit: (code: number) => void;
  log: (line: string) => void;
}

/**
 * @description Replace this process with `target`. Never returns on success. A missing `process.execve` or an error from it
 * is logged and ends the process with {@link restartFailedExitCode}, so a supervisor sees a failed restart rather than a bot
 * that is silently gone.
 */
export function reexecProcess(target: ReexecTarget, env: NodeJS.ProcessEnv, deps: ReexecDeps): void {
  if (!deps.execve) {
    deps.log('[update] this Node has no process.execve — cannot restart in place');
    deps.exit(restartFailedExitCode);
    return;
  }
  try {
    deps.execve(target.file, target.args, env);
  } catch (error) {
    deps.log(`[update] execve failed: ${error instanceof Error ? error.message : String(error)}`);
    deps.exit(restartFailedExitCode);
  }
}

/** @description The real dependencies of {@link reexecProcess}. */
export function createDefaultReexecDeps(): ReexecDeps {
  const nativeExecve = process.execve;
  return {
    execve: nativeExecve ? (file, args, env) => nativeExecve.call(process, file, args, env) : undefined,
    exit: (code) => process.exit(code),
    log: (line) => console.error(line),
  };
}
