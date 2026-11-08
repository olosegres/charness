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
import { scriptPath, startRunnerStandIn, stopRunnerStandIns, writeFile } from './remoteRunRunnerScriptKit';

const slug = 'app-aaaaaaaaaa';
const otherSlug = 'app-bbbbbbbbbb';

/** A task list in files: `add` numbers a task (stashed with `--stashed`), `enqueue` queues it, `remove` takes it away, `status --json label=…` lists the matching task; every call is a line of calls.log. */
const fakePueue = `#!/bin/bash
dir=\${FAKE_PQ:?}
printf '%s\\n' "$*" >> "$dir/calls.log"
mkdir -p "$dir/tasks"
case $1 in
  status)
    [ -z "\${FAKE_PQ_DOWN:-}" ] || exit 1
    if [ "$2" = --json ]; then
      printf '{"tasks":{'
      first=1
      for file in "$dir"/tasks/*; do
        [ -e "$file" ] || continue
        id=$(basename "$file")
        label=$(sed -n 1p "$file")
        case $3 in label=*) [ "label=$label" = "$3" ] || continue ;; esac
        [ $first -eq 1 ] || printf ','
        first=0
        printf '"%s": {"id": %s, "label": "%s"}' "$id" "$id" "$label"
      done
      printf '}}\\n'
    fi
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
  fs.rmSync(root, { recursive: true, force: true });
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

  it('a stashed job whose Pueue task is not its own (Pueue numbered it again, or lost it) loses its mark and is passed over - nothing else of Pueue\'s is enqueued by mistake', () => {
    stageThree();
    endJob('box1-aaaaaa');
    fs.rmSync(path.join(pueueDir, 'tasks', readTaskId('box1-bbbbbb')));
    enqueueFor('box1-aaaaaa');
    assert.equal(isStashed('box1-bbbbbb'), false);
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
    const probe = runScript(['probe', workDir]);
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
    runScript(['probe', workDir]);
    assert.equal(readTaskState(readTaskId('box1-bbbbbb')), 'Queued');
    assert.equal(readTaskState(readTaskId('box1-cccccc')), 'Stashed');
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
