import { spawn } from 'child_process';

/**
 * @description `rsync` as a spawned process with a deadline. Exit 24 ("some source files vanished", a file edited while it was being
 * sent) is not a failure: the next submit sends the new state. The ssh half is the `-e` command the caller built.
 */

/** A first send of a large project is the slowest thing remote-run does. */
export const syncTimeoutMs = 30 * 60 * 1000;
const rsyncVanishedFilesExitCode = 24;
const stderrTailLength = 600;

export interface RsyncResult {
  isOk: boolean;
  /** The last of rsync's stderr, for a message. */
  errorTail: string;
}

/** @description Run rsync with `args`, `input` on its stdin (the NUL-separated file list). */
export function runRsync(args: readonly string[], options: { input?: string; timeoutMs?: number } = {}): Promise<RsyncResult> {
  return new Promise((resolve) => {
    const child = spawn('rsync', [...args], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    let isTimedOut = false;
    const timer = setTimeout(() => {
      isTimedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs ?? syncTimeoutMs);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.stdin.on('error', () => { /* rsync ended before it read the whole list */ });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ isOk: false, errorTail: `could not start rsync: ${error.message}` });
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      const isOk = exitCode === 0 || exitCode === rsyncVanishedFilesExitCode;
      resolve({ isOk, errorTail: isTimedOut ? 'rsync ran past its deadline' : stderr.trim().slice(-stderrTailLength) });
    });
    child.stdin.end(options.input ?? '');
  });
}
