/**
 * @description `remoteRun/runner.sh`, the time limit of a bounded call (`run_bounded`: a watchdog, there is no `timeout(1)` on a Mac) and the way the script ends a background job of its own. Bash reports a background job
 * that a SIGNAL ended on ITS stderr (`line N: PID Killed: 9  ( sleep … )`, `Terminated`) — whatever redirections the job itself has — at the first command after the death. Measured: bash 3.2.57 (the stock bash of macOS)
 * reports a job ended by SIGKILL AND one ended by SIGTERM; bash 5.3 reports only one ended by SIGKILL. The script stops its watchdogs and watchers by signal, so every job that made a bounded `simctl` call carried such a line
 * in its output, which reads like a failure. The limit itself must stay what it was: a call that runs past it is cut off, a call that ends in time stops its watchdog at once.
 *
 * Which case is load-bearing on which bash: the SIGKILL ones (`run_bounded`'s watchdog, the log of the iOS job) on every bash, so the Linux suite guards them. The SIGTERM ones (the helper's default signal, and `exec`
 * end to end: its stderr must be exactly the command's and the exit marker, which guards the TERM stop `cmd_exec` makes of its watcher) only on bash 3.2; under bash 5 they still prove that the job is gone, not that
 * nothing is reported. So `.github/workflows/file-send-cross-platform.yml` runs THIS WHOLE FILE on a macOS runner, whose /bin/bash is 3.2 (no test-name selection: one that matches nothing would pass silently).
 * The other two TERM stops (`cmd_lease`'s stop of its watcher, `end_lease_watch`'s stop of the heartbeat reader) have no case of their own: with a plain `kill` in their place nothing reached stderr under bash 3.2.57 (the
 * `exec` case stayed green in 4 of 4 runs; `cmd_lease`, run with a stubbed Pueue, in 18 of 18 — its closing `wait "$streamer_pid" 2> /dev/null` takes any report of the watcher), so no stderr check can fail on them: the
 * helper's cases cover what those calls do. Locally: put a bash 3.2 first on PATH (`src/remoteRun/README.md`).
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getRunEnvironment, runJob } from './remoteRunRunnerJobKit';
import { removeTestRoot, scriptPath, slug } from './remoteRunRunnerScriptKit';
import { iosJob, rsyncSkip, sims, slugA, state, useSimulatorHarness } from './remoteRunRunnerScriptSimulatorKit';

/** What bash prints when it reports a job that a signal ended; on macOS the text carries the signal's number («Killed: 9»). */
const jobDeathNotice = /Killed|Terminated/;
/** The job-level case is not run on macOS (a developer's Mac or macOS CI): the job needs rsync 3, which the Linux CI installs and a Mac does not necessarily have (its own rsync may be another implementation); its SIGKILL path is the first case's, which runs there. */
const iosJobSkip = process.platform === 'darwin' ? 'skipped on macOS: the job needs rsync 3, which the Linux CI installs and a Mac may not have; its SIGKILL path is the first case of this file' : rsyncSkip;
const programTimeoutMs = 60_000;
const limitSec = 1;
const longCallSec = 30;
/** A call that was cut off at its limit says so with the exit code of SIGKILL. */
const cutOffCode = 137;
const callTimeBudgetMs = 15_000;
const goneCheckLimit = 100;
const callRounds = 6;
const leaseMs = 3000;
const leasedRunTimeoutMs = 60_000;
const leasedExitCodes = [0, 3, 255];

/** `runner.sh` sourced (it only defines its functions then), then `lines`, in one bash. */
function runProgram(lines: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('bash', ['-c', [`source '${scriptPath}'`, ...lines].join('\n')], { encoding: 'utf8', env: getRunEnvironment(), timeout: programTimeoutMs });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('a bounded call and its watchdog', () => {
  it('a call that ends in time keeps its exit code and the watchdog it stops (SIGKILL: reported by every bash) is not reported — a round after round of calls leaves nothing on stderr', () => {
    // One command per line, as a script runs them: bash reports a dead job at a command AFTER the call that ended it, and not inside a loop.
    const rounds = Array.from({ length: callRounds }, () => ['run_bounded 30 true; echo "zero=$?"', 'run_bounded 30 sleep 0.1; echo "slept=$?"', "run_bounded 30 sh -c 'exit 3'; echo \"three=$?\""]).flat();
    const result = runProgram([...rounds, 'true', 'true']);
    assert.equal(result.stdout, 'zero=0\nslept=0\nthree=3\n'.repeat(callRounds), result.stderr);
    assert.equal(result.stderr, '', 'no «Killed: 9», no «Terminated»: the watchdog is stopped by the script itself, and the job output is not the place to say so');
  });

  it('a call that runs past its limit is still cut off at it — exit code 137, the time of the limit and not of the call — and the cut says nothing either', () => {
    const startedAt = Date.now();
    const result = runProgram([`run_bounded ${limitSec} sleep ${longCallSec}`, 'echo "code=$?"', 'true', 'true']);
    assert.equal(result.stdout.trim(), `code=${cutOffCode}`, result.stderr);
    assert.ok(Date.now() - startedAt < callTimeBudgetMs, `it took ${(Date.now() - startedAt) / 1000} s: the call was not cut off at its limit`);
    assert.equal(result.stderr, '');
  });

  it('the call\'s own stdout and stderr are the caller\'s, and its stdin is /dev/null whatever the caller\'s is', () => {
    const result = runProgram(['run_bounded 30 sh -c \'echo out; echo err >&2; cat; echo "stdin-done"\' < /dev/zero', 'echo "code=$?"']);
    assert.equal(result.stdout, 'out\nstdin-done\ncode=0\n');
    assert.equal(result.stderr, 'err\n');
  });
});

describe('stopping a background job of the script\'s own', () => {
  /** A job that would run for a long time, stopped with `stopArguments` of `stop_background_job`, then a few commands: the point where bash reports a job that a signal ended. */
  function stopLongJob(stopArguments: string): { status: number | null; stdout: string; stderr: string } {
    return runProgram([
      `( sleep ${longCallSec} ) > /dev/null 2>&1 &`,
      'job_pid=$!',
      `stop_background_job "$job_pid" ${stopArguments}`,
      'looks=0',
      `while kill -0 "$job_pid" 2> /dev/null && [ "$looks" -lt ${goneCheckLimit} ]; do sleep 0.05; looks=$((looks + 1)); done`,
      'kill -0 "$job_pid" 2> /dev/null && echo "alive" || echo "gone"',
      'true',
      'true',
    ]);
  }

  it('SIGTERM by default: the job is gone, and the shell says nothing about its death (the silence is load-bearing on bash 3.2 only: bash 5 reports no job ended by SIGTERM)', () => {
    const result = stopLongJob('');
    assert.equal(result.stdout.trim(), 'gone', result.stderr);
    assert.equal(result.stderr, '');
  });

  it('a signal named by the caller (SIGKILL, for a job that may ignore TERM) ends it as well, quietly (reported by every bash without the helper)', () => {
    const result = stopLongJob('KILL');
    assert.equal(result.stdout.trim(), 'gone', result.stderr);
    assert.equal(result.stderr, '');
  });

  it('a job that already ended on its own, and one that was never there, are no failure and no message', () => {
    const result = runProgram([
      '( exit 0 ) &',
      'finished_pid=$!',
      'sleep 0.2',
      'stop_background_job "$finished_pid"; echo "finished=$?"',
      'stop_background_job 999999999; echo "never=$?"',
    ]);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /^finished=\d+\nnever=\d+\n$/);
  });
});

interface LeasedRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** `bash <bashArguments>` with the stream of this test as the caller's — what a lease watches: one heartbeat is written, and the stream stays open until the run ends. */
function runWithOpenStream(bashArguments: string[]): Promise<LeasedRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', bashArguments, { stdio: ['pipe', 'pipe', 'pipe'], env: getRunEnvironment() });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (text: string) => { stdout += text; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (text: string) => { stderr += text; });
    child.stdin.on('error', () => { /* the run ended before the write */ });
    child.stdin.write('h');
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`the run did not end within ${leasedRunTimeoutMs} ms`));
    }, leasedRunTimeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

// The macOS step of `.github/workflows/file-send-cross-platform.yml` runs this WHOLE file under the stock bash 3.2 and depends on these cases for the SIGTERM path: do not move them out of this file, and do not
// select cases of this file by name there.
describe('the watcher of `exec` is stopped quietly (SIGTERM: load-bearing on bash 3.2 only, where the macOS CI step runs this file; bash 5 reports no job ended by SIGTERM)', () => {
  let workRoot = '';
  let workDir = '';

  beforeEach(() => {
    workRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-lease-')));
    workDir = path.join(workRoot, 'work');
    fs.mkdirSync(path.join(workDir, 'p', slug, 'tree'), { recursive: true });
  });
  afterEach(() => {
    removeTestRoot(workRoot);
  });

  it('`exec` ends its stderr with the command\'s own exit marker and nothing after it, whatever the code: the watcher it stops, and that watcher\'s heartbeat reader, are not reported', async () => {
    for (const code of leasedExitCodes) {
      const result = await runWithOpenStream([scriptPath, 'exec', workDir, slug, '', `${leaseMs}`, `echo out; echo err >&2; exit ${code}`]);
      assert.equal(result.code, code, `the command's ${code} is the script's exit status`);
      assert.equal(result.stdout, 'out\n');
      assert.equal(result.stderr, `err\n\u001eremote-run-exit:${code}\n`, 'the marker is the last thing on stderr: no «Terminated» before or after it');
    }
  });
});

describe('a job that needs iOS', { skip: iosJobSkip }, () => {
  useSimulatorHarness();

  it('the output of the job has no line of bash about a killed process: its `simctl` calls are bounded, and their watchdogs are stopped quietly (SIGKILL: every bash)', () => {
    const outcome = runJob(state.workDir, iosJob(slugA, 'box1-aaaaaa'), sims.environment);
    assert.equal(outcome.exit, '0', outcome.log);
    assert.ok(outcome.log.includes('is booted'), `the iOS steps ran, so their bounded calls were made:\n${outcome.log}`);
    assert.ok(!jobDeathNotice.test(outcome.log), `a line that reads like a failure:\n${outcome.log}`);
  });
});
