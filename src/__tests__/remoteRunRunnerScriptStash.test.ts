/**
 * @description `remoteRun/runner.sh`, a job whose project has another job under way takes no Pueue slot («adding the job to Pueue»): `add_job` stashes it (`pueue add --stashed`, a `stashed` mark in its folder) while the project
 * copy has a job without a result; `finish_job` (and a kill that removes a queued job) enqueues the OLDEST stashed job when nothing else of the copy is under way; `prepare` and `probe` do the same for a predecessor that died before it
 * could (the safety net); a killed stashed job is removed from Pueue and loses its mark; a Pueue that does not answer judges nothing; the scheduling mutex is only an ordering device (without it a job is queued as before). Driven against a stand-in
 * for Pueue that keeps its task list in files and records every call; the real Pueue is `remoteRunSchedulingE2e.test.ts`.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { scriptPath, startRunnerStandIn, stopDetachedRuns, stopRunnerStandIns, writeFile, removeTestRoot } from './remoteRunRunnerScriptKit';

const slug = 'app-aaaaaaaaaa';
const otherSlug = 'app-bbbbbbbbbb';

/** A task list in files: `add` numbers a task (stashed with `--stashed`), `enqueue` queues it, `remove` takes it away, `status --json label=…` lists the matching task; every call is a line of calls.log. */
const fakePueue = `#!/bin/bash
dir=\${FAKE_PQ:?}
printf '%s\\n' "$*" >> "$dir/calls.log"
mkdir -p "$dir/tasks"
case $1 in
  status)
    # FAKE_PQ_STATUS_SLOW_SEC: Pueue answers, but only after that long (a daemon starved of CPU on a machine with load 129).
    [ -z "\${FAKE_PQ_STATUS_SLOW_SEC:-}" ] || sleep "$FAKE_PQ_STATUS_SLOW_SEC"
    [ -z "\${FAKE_PQ_DOWN:-}" ] || exit 1
    # FAKE_PQ_DOWN_FILE: Pueue does not answer for as long as that file exists (a daemon that restarts, then is back).
    [ ! -e "\${FAKE_PQ_DOWN_FILE:-/nonexistent}" ] || exit 1
    # A label query that fails while the plain status answers: Pueue busy, a socket hiccup.
    if [ "$2" = --json ] && [ -n "$3" ] && [ -n "\${FAKE_PQ_LABEL_DOWN:-}" ]; then exit 1; fi
    if [ "$2" = --json ]; then
      printf '{"tasks":{'
      first=1
      for file in "$dir"/tasks/*; do
        [ -e "$file" ] || continue
        id=$(basename "$file")
        label=$(sed -n 1p "$file")
        state=$(sed -n 2p "$file")
        case $3 in label=*) [ "label=$label" = "$3" ] || continue ;; esac
        [ $first -eq 1 ] || printf ','
        first=0
        printf '"%s": {"id": %s, "label": "%s", "status": {"%s": {}}}' "$id" "$id" "$label" "$state"
      done
      printf '}}\\n'
    fi
    ;;
  wait)
    # Blocks while the task is stashed, like the real one (bounded, so a test that forgets cannot hang); with FAKE_PQ_WAIT_BLOCKS, while the task exists at all (a queued job that waits for a slot).
    waited=0
    while { [ "$(sed -n 2p "$dir/tasks/$2" 2> /dev/null)" = Stashed ] || { [ -n "\${FAKE_PQ_WAIT_BLOCKS:-}" ] && [ -f "$dir/tasks/$2" ]; }; } && [ $waited -lt 300 ]; do sleep 0.1; waited=$((waited+1)); done
    ;;
  add)
    shift
    state=Queued
    label=
    while [ $# -gt 0 ]; do
      case $1 in
        --stashed) state=Stashed ;;
        -l) label=$2; shift ;;
        -g | -w) shift ;;
        --) break ;;
      esac
      shift
    done
    id=$(( $(cat "$dir/counter" 2> /dev/null || echo 0) + 1 ))
    echo "$id" > "$dir/counter"
    printf '%s\\n%s\\n' "$label" "$state" > "$dir/tasks/$id"
    echo "$id"
    ;;
  enqueue)
    [ -f "$dir/tasks/$2" ] || exit 1
    printf '%s\\nQueued\\n' "$(sed -n 1p "$dir/tasks/$2")" > "$dir/tasks/$2"
    ;;
  remove)
    [ -f "$dir/tasks/$2" ] || exit 1
    rm -f "$dir/tasks/$2"
    ;;
esac
exit 0
`;

let root = '';
let workDir = '';
let pueueDir = '';

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stash-')));
  workDir = path.join(root, 'work');
  pueueDir = path.join(root, 'pq');
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.mkdirSync(pueueDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'bin', 'pueue'), fakePueue, { mode: 0o755 });
});
afterEach(() => {
  stopRunnerStandIns();
  removeTestRoot(root);
});

function getEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, PUEUE_BIN: path.join(root, 'bin', 'pueue'), FAKE_PQ: pueueDir, ...extra };
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runScript(args: string[], extra: NodeJS.ProcessEnv = {}): Run {
  const result = spawnSync('bash', [scriptPath, ...args], { encoding: 'utf8', env: getEnvironment(extra), timeout: 60_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The script's functions `source`d in a process of their own, with the globals of one job set the way the script has them. */
function runSourced(body: string, jobId: string, extra: NodeJS.ProcessEnv = {}): Run {
  const program = [`source ${scriptPath}`, `work=${workDir}; slug=${slug}; job=${jobId}; proj="$work/p/$slug"; jobs_dir="$proj/jobs"; jd="$jobs_dir/$job"; killed=0`, body].join('\n');
  const result = spawnSync('bash', ['-c', program], { encoding: 'utf8', env: getEnvironment(extra), timeout: 60_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * A `probe` as a runner is asked it, and what it started: the scheduling safety net runs DETACHED (`settle-queue`, so the answer never waits for the scheduling mutex or Pueue), so a case that is about what the net
 * DID waits for that run to end before it looks.
 */
function probeAndSettle(extra: NodeJS.ProcessEnv = {}): Run {
  const answered = runScript(['probe', workDir], extra);
  stopDetachedRuns(root);
  return answered;
}

const jobFolder = (jobId: string, slugName = slug): string => path.join(workDir, 'p', slugName, 'jobs', jobId);

function createJobFolder(jobId: string, slugName = slug): string {
  const folder = jobFolder(jobId, slugName);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'log'), '');
  return folder;
}

/** Submit a job as `prepare` leaves it: through the script's own `submit`. */
function submit(jobId: string, slugName = slug): Run {
  createJobFolder(jobId, slugName);
  const submitted = runScript(['submit', workDir, slugName, jobId, 'default']);
  assert.equal(submitted.status, 0, submitted.stderr);
  return submitted;
}

async function waitUntil(check: () => boolean, what: string, limitMs = 15_000): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const isStashed = (jobId: string, slugName = slug): boolean => fs.existsSync(path.join(jobFolder(jobId, slugName), 'stashed'));
const readTaskId = (jobId: string, slugName = slug): string => fs.readFileSync(path.join(jobFolder(jobId, slugName), 'task-id'), 'utf8').trim();
const readCalls = (): string[] => (fs.existsSync(path.join(pueueDir, 'calls.log')) ? fs.readFileSync(path.join(pueueDir, 'calls.log'), 'utf8').split('\n').filter((line) => line !== '') : []);
const readTaskState = (taskId: string): string | null => {
  const file = path.join(pueueDir, 'tasks', taskId);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n')[1] : null;
};
/** The job has ended: a result is written, as `record_job_end` does. */
const endJob = (jobId: string, slugName = slug): void => writeFile(jobFolder(jobId, slugName), 'exit', '0\n');
/** The job runs: it has recorded a live process. */
function markRunning(jobId: string, slugName = slug): void {
  writeFile(jobFolder(jobId, slugName), 'pid', `${startRunnerStandIn()}\n`);
}

describe('adding a job', () => {
  it('a job of a project with nothing under way is queued as usual: no --stashed, no mark', () => {
    submit('box1-aaaaaa');
    assert.ok(!readCalls().some((call) => call.includes('--stashed')));
    assert.equal(isStashed('box1-aaaaaa'), false);
    assert.equal(readTaskState(readTaskId('box1-aaaaaa')), 'Queued');
  });

  it('a job whose project has another one queued or running is STASHED - `pueue add --stashed`, a mark in its folder, its task number written like any other - and so is the next, behind both', () => {
    submit('box1-aaaaaa');
    submit('box1-bbbbbb');
    submit('box1-cccccc');
    assert.equal(isStashed('box1-bbbbbb'), true);
    assert.equal(isStashed('box1-cccccc'), true);
    assert.equal(readTaskState(readTaskId('box1-bbbbbb')), 'Stashed');
    assert.equal(readTaskState(readTaskId('box1-cccccc')), 'Stashed');
    assert.equal(readCalls().filter((call) => call.includes('--stashed')).length, 2);
    assert.match(fs.readFileSync(path.join(jobFolder('box1-bbbbbb'), 'task-id'), 'utf8'), /^\d+\n$/);
    assert.equal(fs.existsSync(path.join(workDir, 'p', slug, 'sched.lock')), false, 'the mutex is given back');
  });

  it('a project whose earlier job has a result, or whose process died, is idle: the new job is queued as usual', () => {
    submit('box1-aaaaaa');
    endJob('box1-aaaaaa');
    submit('box1-bbbbbb');
    assert.equal(isStashed('box1-bbbbbb'), false);
    markRunning('box1-bbbbbb');
    fs.rmSync(path.join(jobFolder('box1-bbbbbb'), 'pid'));
    writeFile(jobFolder('box1-bbbbbb'), 'pid', '99999999\n');
    submit('box1-cccccc');
    assert.equal(isStashed('box1-cccccc'), false, 'a job whose process is gone is not under way');
  });

  it('another project is not waited for: its job is queued as usual', () => {
    submit('box1-aaaaaa');
    submit('box1-bbbbbb', otherSlug);
    assert.equal(isStashed('box1-bbbbbb', otherSlug), false);
  });

  it('a job being submitted (its folder has no task yet) is not "under way"', () => {
    createJobFolder('box1-aaaaaa');
    submit('box1-bbbbbb');
    assert.equal(isStashed('box1-bbbbbb'), false);
  });

  it('with the mutex held by a live process for longer than it is waited for, the job is queued as before (not stashed): the project lock is what keeps jobs apart, this only decides who takes a slot', () => {
    submit('box1-aaaaaa');
    writeFile(workDir, 'p/' + slug + '/sched.lock', `${startRunnerStandIn()}\nsome-job\n`);
    createJobFolder('box1-bbbbbb');
    const added = runSourced('sched_lock_wait_sec=1; add_job default; echo "added=$?"', 'box1-bbbbbb');
    assert.match(added.stdout, /added=0/, added.stderr);
    assert.equal(isStashed('box1-bbbbbb'), false);
    assert.equal(readTaskState(readTaskId('box1-bbbbbb')), 'Queued');
  });

  it('a Pueue that refuses the job fails the add, leaves no task number and no mark, and gives the mutex back', () => {
    submit('box1-aaaaaa');
    createJobFolder('box1-bbbbbb');
    const brokenBin = path.join(root, 'broken-bin');
    fs.mkdirSync(brokenBin);
    fs.writeFileSync(path.join(brokenBin, 'pueue'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const added = runSourced('add_job default; echo "added=$?"', 'box1-bbbbbb', { PUEUE_BIN: path.join(brokenBin, 'pueue') });
    assert.match(added.stdout, /added=1/);
    assert.equal(fs.existsSync(path.join(jobFolder('box1-bbbbbb'), 'task-id')), false);
    assert.equal(isStashed('box1-bbbbbb'), false);
    assert.equal(fs.existsSync(path.join(workDir, 'p', slug, 'sched.lock')), false);
  });
});

describe('enqueueing the stashed job of a project', () => {
  /** Jobs A (under way), B and C (stashed behind it), in that order. */
  function stageThree(): void {
    submit('box1-aaaaaa');
    submit('box1-bbbbbb');
    submit('box1-cccccc');
  }
  const enqueueFor = (jobId: string): Run => runSourced('enqueue_idle_stashed_of_project "$proj"', jobId);

  it('when the project\'s job ends the OLDEST stashed job is enqueued and loses its mark; the next one stays stashed behind it', () => {
    stageThree();
    endJob('box1-aaaaaa');
    enqueueFor('box1-aaaaaa');
    assert.equal(readTaskState(readTaskId('box1-bbbbbb')), 'Queued');
    assert.equal(isStashed('box1-bbbbbb'), false);
    assert.equal(readTaskState(readTaskId('box1-cccccc')), 'Stashed');
    assert.equal(isStashed('box1-cccccc'), true);
    assert.equal(readCalls().filter((call) => call.startsWith('enqueue')).length, 1, 'one job takes a slot at a time');
  });

  it('while another job of the project is under way (the one just enqueued included) nothing is enqueued - and when that one ends, the next is', () => {
    stageThree();
    endJob('box1-aaaaaa');
    enqueueFor('box1-aaaaaa');
    enqueueFor('box1-aaaaaa');
    assert.equal(readTaskState(readTaskId('box1-cccccc')), 'Stashed');
    endJob('box1-bbbbbb');
    enqueueFor('box1-bbbbbb');
    assert.equal(readTaskState(readTaskId('box1-cccccc')), 'Queued');
    assert.equal(isStashed('box1-cccccc'), false);
  });

  it('a predecessor that is still queued or running keeps its successors stashed', () => {
    stageThree();
    markRunning('box1-aaaaaa');
    enqueueFor('box1-aaaaaa');
    assert.ok(!readCalls().some((call) => call.startsWith('enqueue')));
  });

  it('a stashed job that has a result already (it was killed) loses its mark and is passed over: the next one is enqueued', () => {
    stageThree();
    endJob('box1-aaaaaa');
    endJob('box1-bbbbbb');
    enqueueFor('box1-aaaaaa');
    assert.equal(isStashed('box1-bbbbbb'), false);
    assert.equal(readTaskState(readTaskId('box1-cccccc')), 'Queued');
  });

  it('a stashed job whose Pueue task is gone (Pueue was reset, or lost it) is ENDED as lost - not only unmarked: it must stop counting as under way - and the next one is enqueued; nothing else of Pueue\'s is enqueued by mistake', () => {
    stageThree();
    endJob('box1-aaaaaa');
    fs.rmSync(path.join(pueueDir, 'tasks', readTaskId('box1-bbbbbb')));
    enqueueFor('box1-aaaaaa');
    assert.equal(isStashed('box1-bbbbbb'), false);
    assert.equal(fs.readFileSync(path.join(jobFolder('box1-bbbbbb'), 'exit'), 'utf8').trim(), '137');
    assert.equal(readTaskState(readTaskId('box1-cccccc')), 'Queued');
    assert.deepEqual(readCalls().filter((call) => call.startsWith('enqueue')), [`enqueue ${readTaskId('box1-cccccc')}`]);
  });

  it('a Pueue that does not answer judges nothing: the marks stay, and the next look enqueues', () => {
    stageThree();
    endJob('box1-aaaaaa');
    runSourced('enqueue_idle_stashed_of_project "$proj"', 'box1-aaaaaa', { FAKE_PQ_DOWN: '1' });
    assert.equal(isStashed('box1-bbbbbb'), true);
    assert.equal(isStashed('box1-cccccc'), true);
    enqueueFor('box1-aaaaaa');
    assert.equal(readTaskState(readTaskId('box1-bbbbbb')), 'Queued');
  });

  it('asks Pueue nothing when nothing is stashed (every job end calls it)', () => {
    submit('box1-aaaaaa');
    endJob('box1-aaaaaa');
    const callsBefore = readCalls().length;
    enqueueFor('box1-aaaaaa');
    assert.equal(readCalls().length, callsBefore);
  });

  it('with the mutex held by a live process it does nothing, quietly - the next `prepare` or `probe` will', () => {
    stageThree();
    endJob('box1-aaaaaa');
    writeFile(workDir, `p/${slug}/sched.lock`, `${startRunnerStandIn()}\nsome-job\n`);
    const run = runSourced('sched_lock_wait_sec=1; enqueue_idle_stashed_of_project "$proj"; echo "code=$?"', 'box1-aaaaaa');
    assert.match(run.stdout, /code=0/);
    assert.equal(isStashed('box1-bbbbbb'), true);
  });
});

describe('the safety net: `prepare` and `probe`', () => {
  /** A is SIGKILLed: it has a task and a pid that is gone, no result - and B waits stashed behind it. */
  function stageDeadPredecessor(): void {
    submit('box1-aaaaaa');
    markRunning('box1-aaaaaa');
    submit('box1-bbbbbb');
    assert.equal(isStashed('box1-bbbbbb'), true, 'B waits behind a live A');
    // A is SIGKILLed: its pid is recorded and gone, it wrote no result and ran no `finish_job`.
    writeFile(jobFolder('box1-aaaaaa'), 'pid', '99999999\n');
  }

  it('`probe` enqueues the oldest stashed job of a project whose predecessor died before it could say so - and counts stashed jobs as queued', () => {
    stageDeadPredecessor();
    submit('box1-cccccc', otherSlug);
    const probe = probeAndSettle();
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(readTaskState(readTaskId('box1-bbbbbb')), 'Queued');
    assert.equal(isStashed('box1-bbbbbb'), false);
    assert.match(probe.stdout, /^jobs_queued=2$/m, 'B (now queued) and the other project\'s job');
  });

  it('`probe` counts a job that is still stashed behind a live predecessor as queued, and leaves it stashed', () => {
    submit('box1-aaaaaa');
    markRunning('box1-aaaaaa');
    submit('box1-bbbbbb');
    const probe = runScript(['probe', workDir]);
    assert.match(probe.stdout, /^jobs_running=1$/m);
    assert.match(probe.stdout, /^jobs_queued=1$/m);
    assert.equal(isStashed('box1-bbbbbb'), true);
  });

  it('`prepare` (of any job of the runner) does the same', () => {
    stageDeadPredecessor();
    const prepared = runScript(['prepare', workDir, otherSlug, 'box1-dddddd', 'default=1']);
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.equal(readTaskState(readTaskId('box1-bbbbbb')), 'Queued');
    assert.equal(isStashed('box1-bbbbbb'), false);
  });

  it('a project with several stashed jobs gets ONE enqueued per look, however many there are', () => {
    stageDeadPredecessor();
    submit('box1-cccccc');
    probeAndSettle();
    assert.equal(readTaskState(readTaskId('box1-bbbbbb')), 'Queued');
    assert.equal(readTaskState(readTaskId('box1-cccccc')), 'Stashed');
  });
});

describe('the probe\'s answer never waits for the scheduling safety net', () => {
  /** A job that is being queued: it has its task number and no process yet — what a probe sees while a submit is under way, and what the safety net then looks at. */
  const slowPueueSec = 8;
  const answerBoundMs = 4_000;

  it('a job that is starting while Pueue answers `status` slowly (a daemon starved of CPU on a loaded Mac): the probe still answers at once, counting the job as queued — it used to wait for Pueue, 25.8 s against 0.4 s measured, past the caller\'s 20 s', () => {
    submit('box1-aaaaaa');
    const startedAt = Date.now();
    const probe = runScript(['probe', workDir], { FAKE_PQ_STATUS_SLOW_SEC: `${slowPueueSec}` });
    const tookMs = Date.now() - startedAt;
    assert.equal(probe.status, 0, probe.stderr);
    assert.ok(tookMs < answerBoundMs, `the probe took ${tookMs} ms: it waited for Pueue (${slowPueueSec} s)`);
    assert.match(probe.stdout, /^jobs_queued=1$/m, 'the starting job is counted');
    assert.match(probe.stdout, /^pueue=/m);
  });

  it('the scheduling mutex held by a live process (a submit under way): the probe still answers at once, and the net is left to run on its own', () => {
    submit('box1-aaaaaa');
    writeFile(workDir, `p/${slug}/sched.lock`, `${startRunnerStandIn()}\nsome-job\n`);
    const startedAt = Date.now();
    const probe = runScript(['probe', workDir]);
    const tookMs = Date.now() - startedAt;
    assert.equal(probe.status, 0, probe.stderr);
    assert.ok(tookMs < answerBoundMs, `the probe took ${tookMs} ms: it waited for the scheduling mutex`);
    assert.match(probe.stdout, /^jobs_queued=1$/m);
  });

  it('the net still runs — in the background, one at a time: the lost job is ended after the answer, and a probe while it is still going starts no second', async () => {
    submit('box1-aaaaaa');
    fs.rmSync(path.join(pueueDir, 'tasks', readTaskId('box1-aaaaaa')));
    const first = runScript(['probe', workDir], { FAKE_PQ_STATUS_SLOW_SEC: '2' });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /^jobs_queued=1$/m, 'the answer does not wait: the lost job still counts');
    const pidFile = path.join(workDir, 'tmp', 'settle-queue.pid');
    assert.ok(fs.existsSync(pidFile), 'a detached run was started');
    const startedPid = fs.readFileSync(pidFile, 'utf8').trim();
    runScript(['probe', workDir], { FAKE_PQ_STATUS_SLOW_SEC: '2' });
    assert.equal(fs.readFileSync(pidFile, 'utf8').trim(), startedPid, 'a probe while the net is still going does not start another');
    await waitUntil(() => fs.existsSync(path.join(jobFolder('box1-aaaaaa'), 'exit')), 'the net to end the lost job');
    assert.equal(fs.readFileSync(path.join(jobFolder('box1-aaaaaa'), 'exit'), 'utf8').trim(), '137');
  });

  it('`settle-queue` is the net itself, run by hand like the probe used to: it ends a lost job and enqueues a stashed one', () => {
    submit('box1-aaaaaa');
    submit('box1-bbbbbb');
    fs.rmSync(path.join(pueueDir, 'tasks', readTaskId('box1-aaaaaa')));
    const settled = runScript(['settle-queue', workDir]);
    assert.equal(settled.status, 0, settled.stderr);
    assert.equal(fs.readFileSync(path.join(jobFolder('box1-aaaaaa'), 'exit'), 'utf8').trim(), '137');
    assert.equal(readTaskState(readTaskId('box1-bbbbbb')), 'Queued');
  });
});

describe('a job that Pueue has lost does not stall its project', () => {
  const readExit = (jobId: string, slugName = slug): string | null => {
    const file = path.join(jobFolder(jobId, slugName), 'exit');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : null;
  };
  /** A is queued and B waits stashed behind it; then Pueue forgets A (`pueue reset` of a hub removal or an unpair, a lost state file). */
  function stageLostQueuedJob(): void {
    submit('box1-aaaaaa');
    submit('box1-bbbbbb');
    fs.rmSync(path.join(pueueDir, 'tasks', readTaskId('box1-aaaaaa')));
  }

  it('the next `probe` ends the lost job (it did not run: 137, killed, and a line in its log) and enqueues the stashed one behind it', () => {
    stageLostQueuedJob();
    const probe = probeAndSettle();
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(readExit('box1-aaaaaa'), '137');
    assert.ok(fs.existsSync(path.join(jobFolder('box1-aaaaaa'), 'killed')), 'it reads as killed, not as a failed run');
    assert.match(fs.readFileSync(path.join(jobFolder('box1-aaaaaa'), 'log'), 'utf8'), /remote-run: the Pueue task of this job is gone .* it did not run/);
    assert.equal(readTaskState(readTaskId('box1-bbbbbb')), 'Queued');
    assert.equal(isStashed('box1-bbbbbb'), false);
  });

  it('a job submitted behind a lost one is not stashed behind it for ever: the lost one is ended first, and the new job is queued as usual', () => {
    submit('box1-aaaaaa');
    fs.rmSync(path.join(pueueDir, 'tasks', readTaskId('box1-aaaaaa')));
    submit('box1-bbbbbb');
    assert.equal(readExit('box1-aaaaaa'), '137');
    assert.equal(isStashed('box1-bbbbbb'), false);
    assert.equal(readTaskState(readTaskId('box1-bbbbbb')), 'Queued');
  });

  it('a task that Pueue has finished (Done) while its job never recorded a process did not run either: it is ended as lost', () => {
    stageLostQueuedJob();
    fs.writeFileSync(path.join(pueueDir, 'tasks', readTaskId('box1-aaaaaa')), `rr-box1-aaaaaa\nDone\n`);
    probeAndSettle();
    assert.equal(readExit('box1-aaaaaa'), '137');
    assert.equal(readTaskState(readTaskId('box1-bbbbbb')), 'Queued');
  });

  it('a job that is under way is NOT judged lost: a queued one Pueue still holds, a running one with a process', () => {
    submit('box1-aaaaaa');
    submit('box1-bbbbbb', otherSlug);
    markRunning('box1-bbbbbb', otherSlug);
    submit('box1-cccccc');
    probeAndSettle();
    assert.equal(readExit('box1-aaaaaa'), null);
    assert.equal(readExit('box1-bbbbbb', otherSlug), null);
    assert.equal(isStashed('box1-cccccc'), true, 'still waiting behind the queued one');
  });

  it('a label query that fails while Pueue otherwise answers judges nothing: the lost-looking job is not ended, and the stash mark stays', () => {
    stageLostQueuedJob();
    probeAndSettle({ FAKE_PQ_LABEL_DOWN: '1' });
    assert.equal(readExit('box1-aaaaaa'), null);
    assert.equal(isStashed('box1-bbbbbb'), true);
    assert.equal(readTaskState(readTaskId('box1-bbbbbb')), 'Stashed');
    probeAndSettle();
    assert.equal(readExit('box1-aaaaaa'), '137', 'the next look, with Pueue answering, does');
    assert.equal(readTaskState(readTaskId('box1-bbbbbb')), 'Queued');
  });

  it('a stashed job whose label query failed keeps its mark (it is not "not ours")', () => {
    submit('box1-aaaaaa');
    submit('box1-bbbbbb');
    endJob('box1-aaaaaa');
    runSourced('enqueue_idle_stashed_of_project "$proj"', 'box1-aaaaaa', { FAKE_PQ_LABEL_DOWN: '1' });
    assert.equal(isStashed('box1-bbbbbb'), true);
    assert.equal(readExit('box1-bbbbbb'), null);
  });
});

describe('a job that is removing paths after it succeeded is still under way', () => {
  it('a job with a result and the phase `cleaning` (its process alive: it holds the project lock) makes the next job stashed - not queued to sit in the lock wait', () => {
    submit('box1-aaaaaa');
    endJob('box1-aaaaaa');
    markRunning('box1-aaaaaa');
    writeFile(jobFolder('box1-aaaaaa'), 'phase', 'cleaning\n');
    submit('box1-bbbbbb');
    assert.equal(isStashed('box1-bbbbbb'), true);
  });

  it('and it is not enqueued behind it either, until the cleaning is over (phase done)', () => {
    submit('box1-aaaaaa');
    endJob('box1-aaaaaa');
    markRunning('box1-aaaaaa');
    writeFile(jobFolder('box1-aaaaaa'), 'phase', 'cleaning\n');
    submit('box1-bbbbbb');
    probeAndSettle();
    assert.equal(isStashed('box1-bbbbbb'), true);
    writeFile(jobFolder('box1-aaaaaa'), 'phase', 'done\n');
    probeAndSettle();
    assert.equal(isStashed('box1-bbbbbb'), false);
  });

  it('a cleaning job whose process died is not under way (it would block the project for ever): the next job is queued as usual', () => {
    submit('box1-aaaaaa');
    endJob('box1-aaaaaa');
    writeFile(jobFolder('box1-aaaaaa'), 'pid', '99999999\n');
    writeFile(jobFolder('box1-aaaaaa'), 'phase', 'cleaning\n');
    submit('box1-bbbbbb');
    assert.equal(isStashed('box1-bbbbbb'), false);
  });
});

describe('a job that waits for a stashed one is also the safety net', () => {
  it('`wait` on a stashed job whose predecessor ended without enqueueing it (a watchdog\'s SIGKILL takes the job and the watchdog together) enqueues it by itself within its re-check', () => {
    submit('box1-aaaaaa');
    markRunning('box1-aaaaaa');
    submit('box1-bbbbbb');
    // A is gone for good: a result written by the hard kill, no one to enqueue its successor.
    endJob('box1-aaaaaa');
    const waited = runSourced('stash_recheck_sec=1; cmd_wait "$work" "$slug" "$job"', 'box1-bbbbbb');
    assert.match(waited.stdout, /^done$/m, waited.stderr);
    assert.equal(readTaskState(readTaskId('box1-bbbbbb')), 'Queued');
    assert.equal(isStashed('box1-bbbbbb'), false);
  });

  it('a job that is not stashed asks Pueue only whether it has lost the task - once before it waits, once after - and enqueues nothing while it waits', () => {
    submit('box1-aaaaaa');
    const callsBefore = readCalls().length;
    runSourced('stash_recheck_sec=1; cmd_wait "$work" "$slug" "$job"', 'box1-aaaaaa');
    const calls = readCalls().slice(callsBefore);
    assert.deepEqual(calls.filter((call) => call.startsWith('enqueue')), []);
    assert.ok(calls.filter((call) => call.startsWith('status --json')).length <= 2, calls.join(' | '));
  });

  it('a job that runs (it has a process) is not asked about at all', () => {
    submit('box1-aaaaaa');
    markRunning('box1-aaaaaa');
    const callsBefore = readCalls().length;
    runScript(['result', workDir, slug, 'box1-aaaaaa']);
    runSourced('stash_recheck_sec=1; cmd_wait "$work" "$slug" "$job"', 'box1-aaaaaa');
    assert.deepEqual(readCalls().slice(callsBefore).filter((call) => call.startsWith('status --json')), []);
  });
});

describe('a job that Pueue has lost, found by whoever looks at it', () => {
  const readExit = (jobId: string, slugName = slug): string | null => {
    const file = path.join(jobFolder(jobId, slugName), 'exit');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : null;
  };
  /** Pueue forgot the task of job `jobId` (a reset), and a job of another project got its number: `strangerState` is what that task is doing. */
  function stageNumberTakenByAnother(jobId: string, strangerState: string): string {
    const lostNumber = readTaskId(jobId);
    fs.writeFileSync(path.join(pueueDir, 'tasks', lostNumber), `rr-box1-zzzzzz\n${strangerState}\n`);
    return lostNumber;
  }

  it('a project with ONE lost queued job and nothing stashed: `probe` ends it (137) - it was "queued" for ever in `/runners` and in the way of its copy - and the next probe counts it no more', () => {
    submit('box1-aaaaaa');
    fs.rmSync(path.join(pueueDir, 'tasks', readTaskId('box1-aaaaaa')));
    const probe = probeAndSettle();
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(readExit('box1-aaaaaa'), '137');
    assert.match(runScript(['probe', workDir]).stdout, /^jobs_queued=0$/m);
  });

  it('its copy is no longer «busy: queued»: `clean` refused it for as long as the lost job counted as waiting, and removes it once `probe` has ended the job and its result is fetched', () => {
    submit('box1-aaaaaa');
    fs.rmSync(path.join(pueueDir, 'tasks', readTaskId('box1-aaaaaa')));
    assert.match(runScript(['clean', workDir, slug]).stdout, /^busy=app-aaaaaaaaaa kind=queued job=box1-aaaaaa$/m);
    probeAndSettle();
    assert.equal(runScript(['fetched', workDir, '-', 'box1-aaaaaa']).status, 0);
    assert.match(runScript(['clean', workDir, slug]).stdout, /^removed=app-aaaaaaaaaa /m);
  });

  it('`prepare` of any job does the same', () => {
    submit('box1-aaaaaa');
    fs.rmSync(path.join(pueueDir, 'tasks', readTaskId('box1-aaaaaa')));
    const prepared = runScript(['prepare', workDir, otherSlug, 'box1-dddddd', 'default=1']);
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.equal(readExit('box1-aaaaaa'), '137');
  });

  it('a job that Pueue still holds, queued behind nothing, is left alone by `probe` (it only asks, it ends nothing)', () => {
    submit('box1-aaaaaa');
    probeAndSettle();
    assert.equal(readExit('box1-aaaaaa'), null);
    assert.equal(readTaskState(readTaskId('box1-aaaaaa')), 'Queued');
  });

  it('`wait` on a lost job answers `done` at once with 137 - not after the exit-file wait with "state unknown" - and `result` shows the result', () => {
    submit('box1-aaaaaa');
    fs.rmSync(path.join(pueueDir, 'tasks', readTaskId('box1-aaaaaa')));
    const started = Date.now();
    const waited = runScript(['wait', workDir, slug, 'box1-aaaaaa']);
    assert.match(waited.stdout, /^done$/m, waited.stderr);
    assert.ok(Date.now() - started < 4_000, 'no wait for the exit file');
    assert.equal(readExit('box1-aaaaaa'), '137');
    assert.match(runScript(['result', workDir, slug, 'box1-aaaaaa']).stdout, /^exit=137$/m);
  });

  it('`result` alone judges it too (a view of a lost job must not show it as queued for ever)', () => {
    submit('box1-aaaaaa');
    fs.rmSync(path.join(pueueDir, 'tasks', readTaskId('box1-aaaaaa')));
    assert.match(runScript(['result', workDir, slug, 'box1-aaaaaa']).stdout, /^exit=137$/m);
  });

  it('`wait` on a lost job whose number another job holds now does not follow that other job: it is ended first (a `pueue wait` on the number would follow the stranger for as long as it lives)', () => {
    submit('box1-aaaaaa');
    stageNumberTakenByAnother('box1-aaaaaa', 'Stashed');
    const started = Date.now();
    const waited = runScript(['wait', workDir, slug, 'box1-aaaaaa']);
    assert.match(waited.stdout, /^done$/m, waited.stderr);
    assert.ok(Date.now() - started < 10_000, 'it did not wait for the stranger');
    assert.equal(readExit('box1-aaaaaa'), '137');
  });

  it('a Pueue that does not answer (or a label query that fails) leaves the job as it is: `result` shows no result, nothing is ended', () => {
    submit('box1-aaaaaa');
    fs.rmSync(path.join(pueueDir, 'tasks', readTaskId('box1-aaaaaa')));
    assert.match(runScript(['result', workDir, slug, 'box1-aaaaaa'], { FAKE_PQ_DOWN: '1' }).stdout, /^exit=$/m);
    assert.match(runScript(['result', workDir, slug, 'box1-aaaaaa'], { FAKE_PQ_LABEL_DOWN: '1' }).stdout, /^exit=$/m);
    assert.equal(readExit('box1-aaaaaa'), null);
  });
});

describe('a kill never acts on a Pueue number that was not confirmed to be the job\'s own', () => {
  const readExit = (jobId: string): string | null => {
    const file = path.join(jobFolder(jobId), 'exit');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : null;
  };
  const callsOn = (verb: string, task: string): string[] => readCalls().filter((call) => call === `${verb} ${task}`);
  /** Job A has no process; Pueue lost its task (a reset) and handed the number to another project's job, in `strangerState`. */
  function stageLostJobWithNumberTaken(strangerState: string): string {
    submit('box1-aaaaaa');
    const number = readTaskId('box1-aaaaaa');
    fs.writeFileSync(path.join(pueueDir, 'tasks', number), `rr-box1-zzzzzz\n${strangerState}\n`);
    return number;
  }

  it('a lost job whose number now carries ANOTHER job\'s running task: `kill` ends the lost job (137) and neither kills nor removes the stranger\'s task', () => {
    const number = stageLostJobWithNumberTaken('Running');
    const killed = runScript(['kill', workDir, slug, 'box1-aaaaaa']);
    assert.equal(killed.stdout.trim(), 'killed', killed.stderr);
    assert.equal(readExit('box1-aaaaaa'), '137');
    assert.deepEqual(callsOn('kill', number), [], 'no pueue kill on a number that is not ours');
    assert.deepEqual(callsOn('remove', number), [], 'no pueue remove either');
    assert.equal(readTaskState(number), 'Running', 'the stranger\'s task is as it was');
  });

  it('the same for a stranger\'s queued task: it is not removed from under its owner', () => {
    const number = stageLostJobWithNumberTaken('Queued');
    runScript(['kill', workDir, slug, 'box1-aaaaaa']);
    assert.deepEqual(callsOn('remove', number), []);
    assert.equal(readTaskState(number), 'Queued');
  });

  it('a kill for a time limit (`timeout`) of a lost job is recorded as 124', () => {
    stageLostJobWithNumberTaken('Running');
    runScript(['kill', workDir, slug, 'box1-aaaaaa', 'timeout']);
    assert.equal(readExit('box1-aaaaaa'), '124');
  });

  it('a lost job that a stashed one waits behind: the kill lets that one go', () => {
    submit('box1-aaaaaa');
    submit('box1-bbbbbb');
    fs.rmSync(path.join(pueueDir, 'tasks', readTaskId('box1-aaaaaa')));
    runScript(['kill', workDir, slug, 'box1-aaaaaa']);
    assert.equal(readExit('box1-aaaaaa'), '137');
    assert.equal(readTaskState(readTaskId('box1-bbbbbb')), 'Queued');
  });

  it('a Pueue that does not answer: the kill fails and says why, kills nothing, and marks nothing - an unconfirmed number is never acted on', () => {
    submit('box1-aaaaaa');
    const number = readTaskId('box1-aaaaaa');
    const killed = runScript(['kill', workDir, slug, 'box1-aaaaaa'], { FAKE_PQ_DOWN: '1' });
    assert.notEqual(killed.status, 0);
    assert.match(killed.stderr, /Pueue did not answer/);
    assert.deepEqual(callsOn('remove', number), []);
    assert.equal(fs.existsSync(path.join(jobFolder('box1-aaaaaa'), 'killed')), false);
    assert.equal(readExit('box1-aaaaaa'), null);
  });

  it('a job whose process is gone (SIGKILLed, no result) and whose number is another job\'s now: `kill` does not `pueue kill` the number', () => {
    submit('box1-aaaaaa');
    const number = readTaskId('box1-aaaaaa');
    writeFile(jobFolder('box1-aaaaaa'), 'pid', '99999999\n');
    fs.writeFileSync(path.join(pueueDir, 'tasks', number), 'rr-box1-zzzzzz\nRunning\n');
    runScript(['kill', workDir, slug, 'box1-aaaaaa']);
    assert.deepEqual(callsOn('kill', number), []);
    assert.equal(readTaskState(number), 'Running');
  });

  it('...and does when the task under the number IS the job\'s own (the check does not just switch the kill off)', () => {
    submit('box1-aaaaaa');
    const number = readTaskId('box1-aaaaaa');
    writeFile(jobFolder('box1-aaaaaa'), 'pid', '99999999\n');
    fs.writeFileSync(path.join(pueueDir, 'tasks', number), 'rr-box1-aaaaaa\nRunning\n');
    runScript(['kill', workDir, slug, 'box1-aaaaaa']);
    assert.ok(callsOn('kill', number).length >= 1, 'its own task is killed');
  });
});

describe('killing', () => {
  it('a stashed job is removed from Pueue like a queued one: its task is gone, it ends with 137, its mark is gone - and the job under way is left alone', () => {
    submit('box1-aaaaaa');
    markRunning('box1-aaaaaa');
    submit('box1-bbbbbb');
    const task = readTaskId('box1-bbbbbb');
    const killed = runScript(['kill', workDir, slug, 'box1-bbbbbb']);
    assert.equal(killed.stdout.trim(), 'killed', killed.stderr);
    assert.equal(readTaskState(task), null);
    assert.equal(fs.readFileSync(path.join(jobFolder('box1-bbbbbb'), 'exit'), 'utf8').trim(), '137');
    assert.equal(isStashed('box1-bbbbbb'), false);
    assert.ok(fs.existsSync(path.join(jobFolder('box1-bbbbbb'), 'task-removed')));
    assert.equal(fs.existsSync(path.join(jobFolder('box1-aaaaaa'), 'exit')), false);
  });

  it('killing a job that is only queued, with a stashed one behind it, lets that one go (nothing else of the project is under way)', () => {
    submit('box1-aaaaaa');
    submit('box1-bbbbbb');
    const killed = runScript(['kill', workDir, slug, 'box1-aaaaaa']);
    assert.equal(killed.stdout.trim(), 'killed', killed.stderr);
    assert.equal(readTaskState(readTaskId('box1-bbbbbb')), 'Queued');
    assert.equal(isStashed('box1-bbbbbb'), false);
  });

  it('killing a stashed job behind a live one does not let the one behind IT go', () => {
    submit('box1-aaaaaa');
    markRunning('box1-aaaaaa');
    submit('box1-bbbbbb');
    submit('box1-cccccc');
    runScript(['kill', workDir, slug, 'box1-bbbbbb']);
    assert.equal(readTaskState(readTaskId('box1-cccccc')), 'Stashed');
  });
});

describe('the lease watcher\'s kill of a queued job that Pueue cannot answer about', () => {
  // A foreground run is interrupted (or its caller dies) while pueued does not answer: the hub's `kill` call is refused («Pueue did not answer»), and the lease's watcher is the only one left to stop the job.
  it('is tried again until Pueue answers: the queued job ends as killed (137), its task is removed - it never starts - and the lease ends with it', async () => {
    const downFile = path.join(root, 'pueue-down');
    createJobFolder('box1-aaaaaa');
    const lease = spawn('bash', [scriptPath, 'lease', workDir, slug, 'box1-aaaaaa', 'default', '2000'], { env: getEnvironment({ FAKE_PQ_WAIT_BLOCKS: '1', FAKE_PQ_DOWN_FILE: downFile }), stdio: ['pipe', 'ignore', 'ignore'] });
    const leaseEnded = new Promise<void>((resolve) => { lease.on('close', () => resolve()); });
    try {
      lease.stdin.write('h');
      await waitUntil(() => fs.existsSync(path.join(jobFolder('box1-aaaaaa'), 'task-id')), 'the job to be queued');
      writeFile(root, 'pueue-down', '');
      lease.stdin.end();
      await waitUntil(() => fs.existsSync(path.join(jobFolder('box1-aaaaaa'), 'kill-pending')), 'the watcher to meet the refusal and keep its kill pending');
      assert.equal(fs.existsSync(path.join(jobFolder('box1-aaaaaa'), 'exit')), false, 'nothing is ended while Pueue does not answer');
      const task = readTaskId('box1-aaaaaa');
      assert.equal(readTaskState(task), 'Queued');
      fs.rmSync(downFile);
      await waitUntil(() => fs.existsSync(path.join(jobFolder('box1-aaaaaa'), 'exit')), 'the retry to end the job', 30_000);
      assert.equal(fs.readFileSync(path.join(jobFolder('box1-aaaaaa'), 'exit'), 'utf8').trim(), '137');
      assert.equal(readTaskState(task), null, 'its task was removed: it never starts');
      assert.equal(fs.existsSync(path.join(jobFolder('box1-aaaaaa'), 'pid')), false);
      await Promise.race([leaseEnded, new Promise((_resolve, reject) => setTimeout(() => reject(new Error('the lease did not end')), 30_000))]);
      assert.equal(fs.existsSync(path.join(jobFolder('box1-aaaaaa'), 'kill-pending')), false, 'the marker goes with the retry');
    } finally {
      lease.kill('SIGKILL');
    }
  });
});

describe('waiting for a job', () => {
  it('a job that is stashed still has its task number, so `result` shows it as submitted and not started (the hub reads Pueue\'s `Stashed` as queued)', () => {
    submit('box1-aaaaaa');
    submit('box1-bbbbbb');
    const facts = runScript(['result', workDir, slug, 'box1-bbbbbb']);
    assert.match(facts.stdout, new RegExp(`^task=${readTaskId('box1-bbbbbb')}$`, 'm'));
    assert.match(facts.stdout, /^has_pid=0$/m);
    assert.match(facts.stdout, /^exit=$/m);
  });

  it('two jobs added at the same moment behind a running one are both stashed, and each is enqueued in its turn', async () => {
    submit('box1-aaaaaa');
    markRunning('box1-aaaaaa');
    createJobFolder('box1-bbbbbb');
    createJobFolder('box1-cccccc');
    await Promise.all(['box1-bbbbbb', 'box1-cccccc'].map((jobId) => new Promise<void>((resolve) => {
      const child = spawn('bash', [scriptPath, 'submit', workDir, slug, jobId, 'default'], { env: getEnvironment(), stdio: 'ignore' });
      child.on('close', () => resolve());
    })));
    assert.equal(isStashed('box1-bbbbbb'), true);
    assert.equal(isStashed('box1-cccccc'), true);
    assert.notEqual(readTaskId('box1-bbbbbb'), readTaskId('box1-cccccc'));
  });
});
