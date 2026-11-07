/**
 * @description What the unit tests of `remoteRun/runner.sh` share (`remoteRunRunnerScript.test.ts`, `remoteRunRunnerScriptProbe.test.ts`, `remoteRunRunnerLock.test.ts`, `remoteRunRunnerScriptDisk.test.ts`,
 * `remoteRunGuiSession.test.ts`): where the script is, the project and job names the tests use, a file writer, and live processes that stand for the script\'s own (or a stranger).
 */

import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

export const scriptPath = path.resolve(__dirname, '..', '..', 'remoteRun', 'runner.sh');
export const slug = 'app-abc1234567';
export const jobId = 'box1-aaaaaa';

export function writeFile(root: string, relativePath: string, content = 'x'): void {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

const runnerStandIns: ChildProcess[] = [];

/**
 * A live process whose command line is the runner script\'s own (`bash …/bin/runner-<hash>.sh job`): what a pid that the script wrote into a job folder, a lock or a marker names — as far as the script\'s
 * `check_runner_pid_alive` can tell, which accepts nothing else as «that process is still ours». The test\'s own pid, or a `sleep`, is a stranger to it. End them with {@link stopRunnerStandIns}.
 */
export function startRunnerStandIn(): number {
  const child = spawn('bash', ['-c', 'read -r _', '/runner/bin/runner-0123abcd.sh', 'job'], { stdio: ['pipe', 'ignore', 'ignore'] });
  runnerStandIns.push(child);
  if (child.pid === undefined) throw new Error('the stand-in did not start');
  return child.pid;
}

/** A live process that is NOT the script\'s: what a recorded pid names after a reboot when a daemon got the number. */
export function startStrangerProcess(): number {
  // Detached: it leads a process group of its own, as a daemon does (what makes a `kill` of a recorded pid dangerous).
  const child = spawn('sleep', ['120'], { stdio: 'ignore', detached: true });
  runnerStandIns.push(child);
  if (child.pid === undefined) throw new Error('the stranger did not start');
  return child.pid;
}

export function stopRunnerStandIns(): void {
  for (const child of runnerStandIns.splice(0)) child.kill('SIGKILL');
}
