/**
 * @description What the unit tests of `remoteRun/runner.sh` share (`remoteRunRunnerScript.test.ts`, `remoteRunRunnerScriptProbe.test.ts`, `remoteRunRunnerLock.test.ts`, `remoteRunRunnerScriptDisk.test.ts`,
 * `remoteRunRunnerScriptDiskCopies.test.ts`, the stash files, `remoteRunGuiSession.test.ts`): where the script is, the project and job names the tests use, a file writer, and live processes that stand for the script\'s own (or a stranger).
 */

import { spawn, spawnSync, type ChildProcess } from 'child_process';
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

const detachedRunPidPattern = /^(measure-copies|sweep-tmpdirs|prune|simctl-cleanup|settle-queue)\.pid$/;
const detachedRunSearchDepth = 5;
const detachedRunGraceMs = 15_000;
const detachedRunPollMs = 25;

/** Where the detached runs the script starts (`start_detached_run`: measure-copies, sweep-tmpdirs, prune, simctl-cleanup, settle-queue) keep their pid: `<work>/tmp/<name>.pid`, wherever a test put its work dir under `root`. */
function findDetachedRunPidFiles(root: string, depth = 0): string[] {
  if (depth > detachedRunSearchDepth) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      // A copy's own tree can be big and holds no work dir.
      if (entry.name !== 'tree' && entry.name !== 'node_modules') found.push(...findDetachedRunPidFiles(entryPath, depth + 1));
    } else if (path.basename(root) === 'tmp' && detachedRunPidPattern.test(entry.name)) {
      found.push(entryPath);
    }
  }
  return found;
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/** Is `pid` a detached run of the script — alive AND its command line the script's own (a pid file outlives its process, and the number may be someone else's by now: that one is never waited for or killed)? */
function checkIsDetachedRun(pid: number): boolean {
  const command = spawnSync('ps', ['-ww', '-p', `${pid}`, '-o', 'command='], { encoding: 'utf8' }).stdout;
  return /runner(?:-[0-9a-f]{8})?\.sh\s+(?:measure-copies|sweep-tmpdirs|prune|simctl-cleanup|settle-queue)\b/.test(command);
}

/**
 * Wait for the runs the script detached under `root` (a refused `prepare` starts `measure-copies`, any `prepare` may start the sweep, a probe of a view the prune): they are meant to outlive the call that started them, and one that is still
 * at its walk writes into a copy's folder while the test's teardown removes it — `ENOTEMPTY` on the `rmdir`, a failed hook, on a loaded runner. They normally end within milliseconds; one that is still there after the grace is killed.
 * Call it before the work dir is removed.
 */
export function stopDetachedRuns(root: string): void {
  for (const pidFile of findDetachedRunPidFiles(root)) {
    const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (!Number.isInteger(pid) || pid <= 1) continue;
    const deadline = Date.now() + detachedRunGraceMs;
    while (checkIsDetachedRun(pid) && Date.now() < deadline) sleepSync(detachedRunPollMs);
    if (checkIsDetachedRun(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // gone in the meantime
      }
      const killedAt = Date.now();
      while (checkIsDetachedRun(pid) && Date.now() - killedAt < detachedRunGraceMs) sleepSync(detachedRunPollMs);
    }
  }
}

/**
 * End the runs the script detached under `root` AT ONCE, without waiting for their walk: for a case that has seen what it needed and would otherwise stand in the teardown's wait for a run that is held on purpose
 * (a Pueue that takes seconds to answer, a scheduling mutex nobody releases). What such a run had started (its `sleep`) is left to end by itself.
 */
export function killDetachedRuns(root: string): void {
  for (const pidFile of findDetachedRunPidFiles(root)) {
    const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (!Number.isInteger(pid) || pid <= 1 || !checkIsDetachedRun(pid)) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // gone in the meantime
    }
  }
}

/** Remove a test's root after the detached runs of the script under it are over (and, for a file written in the last instant, a few tries: the removal is not the test). */
export function removeTestRoot(root: string): void {
  stopDetachedRuns(root);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
