/**
 * @description `runner-scripts/runner.sh` — stashed jobs, the lost-job half of `remoteRunRunnerScriptStash.test.ts` (split because a file runs under one time limit and one ran 70 s alone on a loaded box): a job that Pueue has lost does not
 * stall its project, a job that is removing paths after it succeeded is still under way, a lost job found by whoever looks at it, and a job that waits for a stashed one is also the safety net.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */


import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { writeFile } from './remoteRunRunnerScriptKit';
import { slug, otherSlug, workDir, pueueDir, runScript, runSourced, probeAndSettle, jobFolder, submit, isStashed, readTaskId, readCalls, readTaskState, endJob, markRunning, useStashHarness } from './remoteRunRunnerScriptStashKit';

useStashHarness();

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
