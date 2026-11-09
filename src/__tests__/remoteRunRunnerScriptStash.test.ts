/**
 * @description `remoteRun/runner.sh`, a job whose project has another job under way takes no Pueue slot («adding the job to Pueue»): `add_job` stashes it (`pueue add --stashed`, a `stashed` mark in its folder) while the project
 * copy has a job without a result; `finish_job` (and a kill that removes a queued job) enqueues the OLDEST stashed job when nothing else of the copy is under way; `prepare` and `probe` do the same for a predecessor that died before it
 * could (the safety net — the probe starts it detached and its answer never waits for it); a Pueue that does not answer judges nothing; the scheduling mutex is only an ordering device (without it a job is queued as before). Driven against
 * a stand-in for Pueue that keeps its task list in files and records every call (`remoteRunRunnerScriptStashKit.ts`); the real Pueue is `remoteRunSchedulingE2e.test.ts`. A job that waits for a stashed one is itself the safety net, and a job Pueue lost is found by whoever looks at it. The cases about killing, the lease watcher's retry of a kill and waiting for a job are `remoteRunRunnerScriptStashWaiting.test.ts`.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */


import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { killDetachedRuns, startRunnerStandIn, writeFile } from './remoteRunRunnerScriptKit';
import { slug, otherSlug, root, workDir, pueueDir, Run, runScript, runSourced, probeAndSettle, jobFolder, createJobFolder, submit, waitUntil, isStashed, readTaskId, readCalls, readTaskState, endJob, markRunning, useStashHarness } from './remoteRunRunnerScriptStashKit';

useStashHarness();

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
  const slowPueueSec = 6;
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
    killDetachedRuns(root);
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
    killDetachedRuns(root);
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
