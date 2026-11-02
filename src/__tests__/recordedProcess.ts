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
