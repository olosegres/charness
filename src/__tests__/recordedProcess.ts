import * as fs from 'fs';

/**
 * @description The pid a test's stand-in process wrote into `pidFilePath` (`echo $! > file`), or `null` unless the file holds exactly one whole
 * number above 1. A shell creates the file BEFORE it writes the pid, so a stand-in killed in between leaves it empty — and `Number('')` is 0,
 * and `process.kill(0, …)` is a signal to the whole process group: the test file, the test runner and `yarn test`. A pid is never taken
 * from a file by any other means than this.
 */
export function readRecordedPid(pidFilePath: string): number | null {
  let text: string;
  try {
    text = fs.readFileSync(pidFilePath, 'utf8').trim();
  } catch {
    return null;
  }
  if (!/^\d+$/.test(text)) return null;
  const pid = Number.parseInt(text, 10);
  return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
}

/**
 * @description Is there a process with this pid? Signal 0 sends nothing: a process that is gone is `ESRCH`; any other answer (`EPERM`: it exists and is
 * not ours) means it is there. A child of the test process is reaped when it exits, so it stops existing then. The pid is one the test spawned or read
 * through {@link readRecordedPid}: 0 would ask about the whole process group.
 */
export function checkIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
}

/** @description Kill the one process whose pid a test recorded in `pidFilePath` — nothing else, by no name and no sweep; a missing, empty or malformed record, or a process that is gone, is nothing to do. */
export function killRecordedProcess(pidFilePath: string, signal: NodeJS.Signals = 'SIGKILL'): void {
  const pid = readRecordedPid(pidFilePath);
  if (pid === null) return;
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}
