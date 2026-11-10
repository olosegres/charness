/**
 * @description `remoteRun/runner.sh`, the time limit of a bounded call (`run_bounded`: a watchdog, there is no `timeout(1)` on a Mac) and the way the script ends a background job of its own. Bash reports a background job
 * that a SIGNAL ended on ITS stderr (`line N: PID Killed: 9  ( sleep … )`, `Terminated`) — whatever redirections the job itself has — at the first command after the death. Measured: bash 3.2.57 (the stock bash of macOS)
 * reports a job ended by SIGKILL AND one ended by SIGTERM; bash 5.3 reports only one ended by SIGKILL. The script stops its watchdogs and watchers by signal, so every job that made a bounded `simctl` call carried such a line
 * in its output, which reads like a failure. The limit itself must stay what it was: a call that runs past it is cut off, a call that ends in time stops its watchdog at once.
 *
 * Which case is load-bearing on which bash: the SIGKILL ones (`run_bounded`'s watchdog, the log of the iOS job) on every bash, so the Linux suite guards them. The SIGTERM ones (the helper's default signal: the lease
 * watcher of `exec` / `lease` and its heartbeat reader; the `exec` stderr case of `remoteRunRunnerScript.test.ts`) only on bash 3.2 — under bash 5 they still prove that the job is gone, not that nothing is reported — so
 * `.github/workflows/file-send-cross-platform.yml` runs this file and that case on a macOS runner, whose /bin/bash is 3.2. Locally: put a bash 3.2 first on PATH (`src/remoteRun/README.md`).
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { getRunEnvironment, runJob } from './remoteRunRunnerJobKit';
import { scriptPath } from './remoteRunRunnerScriptKit';
import { iosJob, rsyncSkip, sims, slugA, state, useSimulatorHarness } from './remoteRunRunnerScriptSimulatorKit';

/** What bash prints when it reports a job that a signal ended; on macOS the text carries the signal's number («Killed: 9»). */
const jobDeathNotice = /Killed|Terminated/;
/** The job-level case is not run on macOS CI: its apply step is tested against the rsync the Linux CI installs, and its SIGKILL path is the first case's, which runs there. */
const iosJobSkip = process.platform === 'darwin' ? 'not run on macOS CI: its SIGKILL path is the first case of this file' : rsyncSkip;
const programTimeoutMs = 60_000;
const limitSec = 1;
const longCallSec = 30;
/** A call that was cut off at its limit says so with the exit code of SIGKILL. */
const cutOffCode = 137;
const callTimeBudgetMs = 15_000;
const goneCheckLimit = 100;
const callRounds = 6;

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

describe('a job that needs iOS', { skip: iosJobSkip }, () => {
  useSimulatorHarness();

  it('the output of the job has no line of bash about a killed process: its `simctl` calls are bounded, and their watchdogs are stopped quietly (SIGKILL: every bash)', () => {
    const outcome = runJob(state.workDir, iosJob(slugA, 'box1-aaaaaa'), sims.environment);
    assert.equal(outcome.exit, '0', outcome.log);
    assert.ok(outcome.log.includes('is booted'), `the iOS steps ran, so their bounded calls were made:\n${outcome.log}`);
    assert.ok(!jobDeathNotice.test(outcome.log), `a line that reads like a failure:\n${outcome.log}`);
  });
});
