/**
 * @description `remoteRun/jobState.ts` and `jobFormat.ts`: what a job is doing or how it ended, from its own files and Pueue's task list.
 * The exit file is authoritative; a job killed hard (no exit file) is read from its markers and Pueue's verdict — and Pueue alone is
 * never trusted for a code (`pueue wait` exits 0 for a failed task; a task Pueue calls Killed may have been a timeout).
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { describeJobOutcome, describeJobState, parseJobFacts, parsePueueStatus, type JobFacts, type PueueTask } from '../remoteRun/jobState';
import { formatAge, formatDuration, formatJobList, formatJobStatus } from '../remoteRun/jobFormat';
import type { JobMeta } from '../remoteRun/jobMeta';

function facts(overrides: Partial<JobFacts> = {}): JobFacts {
  return { slug: 'app-1', exit: null, phase: '', taskId: 0, startedAtSeconds: null, finishedAtSeconds: null, isTimedOut: false, isKilled: false, isStarted: false, isWithArtifacts: false, failedStep: '', ...overrides };
}

function task(state: PueueTask['state'], result: PueueTask['result'] = null): PueueTask {
  return { id: 0, label: 'rr-box1-abc234', state, result };
}

describe('parsePueueStatus', () => {
  const statusJson = JSON.stringify({
    tasks: {
      0: { id: 0, label: 'rr-box1-aaaaaa', status: { Done: { result: 'Success', start: 'x', end: 'y' } }, envs: { SECRET: 'must be ignored' } },
      1: { id: 1, label: 'rr-box1-bbbbbb', status: { Done: { result: { Failed: 7 } } } },
      2: { id: 2, label: 'rr-box1-cccccc', status: { Done: { result: 'Killed' } } },
      3: { id: 3, label: 'rr-box1-dddddd', status: { Running: { start: 'z' } } },
      4: { id: 4, label: 'rr-box1-eeeeee', status: 'Queued' },
      5: { id: 5, label: 'someone-elses-task', status: { Running: {} } },
      6: { id: 6, label: null, status: 'Stashed' },
    },
  });

  it('keeps only our tasks (label rr-…) with their state and result', () => {
    const tasks = parsePueueStatus(statusJson);
    assert.deepEqual(tasks.map((entry) => [entry.id, entry.state, entry.result]), [
      [0, 'done', { kind: 'success' }],
      [1, 'done', { kind: 'failed', code: 7 }],
      [2, 'done', { kind: 'killed' }],
      [3, 'running', null],
      [4, 'queued', null],
    ]);
  });

  it('a STASHED task (a job that waits for the earlier job of its project, `runner.sh` «adding the job to Pueue») is queued - in the shape Pueue 4 really prints it - and so is the job that has it', () => {
    const stashedJson = JSON.stringify({
      tasks: {
        0: { id: 0, label: 'rr-box1-aaaaaa', status: { Stashed: { enqueue_at: null } } },
        1: { id: 1, label: 'rr-box1-bbbbbb', status: { Queued: { enqueued_at: '2026-11-08T19:25:53.439011846+04:00' } } },
        2: { id: 2, label: 'rr-box1-cccccc', status: { Paused: { start: 'x' } } },
      },
    });
    const tasks = parsePueueStatus(stashedJson);
    assert.deepEqual(tasks.map((entry) => [entry.id, entry.state]), [[0, 'queued'], [1, 'queued'], [2, 'other']]);
    // Not started, no result: the job is "queued" for `ls` and `status`, never "unknown".
    assert.deepEqual(describeJobOutcome(facts({ taskId: 0 }), tasks[0]), { state: 'queued' });
    assert.equal(describeJobState(describeJobOutcome(facts({ taskId: 0 }), tasks[0])), 'queued');
  });

  it('refuses a reply that is not Pueue\'s task list, with a message that quotes nothing of it', () => {
    assert.throws(() => parsePueueStatus('not json'), /did not return JSON/);
    assert.throws(() => parsePueueStatus('{"tasks": 5}'), /not its task list/);
  });
});

describe('parseJobFacts', () => {
  it('reads the runner\'s key=value lines', () => {
    const parsed = parseJobFacts('slug=app-1\nexit=3\nphase=done\ntask=7\nstarted=100\nfinished=130\ntimeout=0\nkilled=1\nhas_pid=1\nartifacts=1\nfailed_step=deps\n');
    assert.deepEqual(parsed, { slug: 'app-1', exit: 3, phase: 'done', taskId: 7, startedAtSeconds: 100, finishedAtSeconds: 130, isTimedOut: false, isKilled: true, isStarted: true, isWithArtifacts: true, failedStep: 'deps' });
  });

  it('an empty exit is "no exit yet", not 0', () => {
    assert.equal(parseJobFacts('exit=\nphase=running\n').exit, null);
  });
});

describe('describeJobOutcome', () => {
  it('the exit file decides: the command\'s own code passes through', () => {
    assert.deepEqual(describeJobOutcome(facts({ exit: 0 }), null), { state: 'done', code: 0, reason: 'exit' });
    assert.deepEqual(describeJobOutcome(facts({ exit: 7 }), task('done', { kind: 'failed', code: 1 })), { state: 'done', code: 7, reason: 'exit' });
  });

  it('124 with the timeout marker is a timeout, 137 with the kill marker a kill, 125 after a failed install the dependencies step', () => {
    assert.deepEqual(describeJobOutcome(facts({ exit: 124, isTimedOut: true }), null), { state: 'done', code: 124, reason: 'timeout' });
    assert.deepEqual(describeJobOutcome(facts({ exit: 137, isKilled: true }), null), { state: 'done', code: 137, reason: 'killed' });
    assert.deepEqual(describeJobOutcome(facts({ exit: 125, failedStep: 'deps' }), null), { state: 'done', code: 125, reason: 'deps-failed' });
  });

  it('a command that itself exits 124 or 137 without the marker is just that code', () => {
    assert.deepEqual(describeJobOutcome(facts({ exit: 124 }), null), { state: 'done', code: 124, reason: 'exit' });
    assert.deepEqual(describeJobOutcome(facts({ exit: 137 }), null), { state: 'done', code: 137, reason: 'exit' });
  });

  it('no exit file and Pueue says done: the job was killed hard — the markers and Pueue\'s verdict say which', () => {
    assert.deepEqual(describeJobOutcome(facts({ isStarted: true, isTimedOut: true }), task('done', { kind: 'killed' })), { state: 'done', code: 124, reason: 'timeout' });
    assert.deepEqual(describeJobOutcome(facts({ isStarted: true, isKilled: true }), task('done', { kind: 'failed', code: 143 })), { state: 'done', code: 137, reason: 'killed' });
    assert.deepEqual(describeJobOutcome(facts({ isStarted: true }), task('done', { kind: 'killed' })), { state: 'done', code: 137, reason: 'killed' });
    assert.deepEqual(describeJobOutcome(facts({ isStarted: true }), task('done', { kind: 'success' })), { state: 'done', code: 125, reason: 'lost' });
  });

  it('queued, running (with its phase) and unknown', () => {
    assert.deepEqual(describeJobOutcome(facts(), task('queued')), { state: 'queued' });
    assert.deepEqual(describeJobOutcome(facts(), task('running')), { state: 'queued' }, 'Pueue started it but the script has not yet');
    assert.deepEqual(describeJobOutcome(facts({ isStarted: true, phase: 'deps' }), task('running')), { state: 'running', phase: 'deps' });
    assert.deepEqual(describeJobOutcome(facts(), null), { state: 'unknown' });
    assert.deepEqual(describeJobOutcome(facts({ isStarted: true }), null), { state: 'done', code: 125, reason: 'lost' });
  });
});

describe('describeJobState', () => {
  it('one word per state', () => {
    assert.equal(describeJobState({ state: 'done', code: 0, reason: 'exit' }), 'passed');
    assert.equal(describeJobState({ state: 'done', code: 3, reason: 'exit' }), 'failed');
    assert.equal(describeJobState({ state: 'done', code: 124, reason: 'timeout' }), 'timed out');
    assert.equal(describeJobState({ state: 'done', code: 137, reason: 'killed' }), 'killed');
    assert.equal(describeJobState({ state: 'done', code: 125, reason: 'deps-failed' }), 'deps failed');
    assert.equal(describeJobState({ state: 'running', phase: 'running' }), 'running');
    assert.equal(describeJobState({ state: 'running', phase: 'waiting-lock' }), 'running (waiting-lock)');
    assert.equal(describeJobState({ state: 'queued' }), 'queued');
  });
});

describe('job formatting', () => {
  const nowMs = Date.UTC(2026, 9, 31, 12, 0, 0);
  const meta = (id: string, submittedMinutesAgo: number, command: string, subfolder = ''): JobMeta => ({
    id, runner: 'box1', slug: 'app-1', projectRoot: '/home/user/src/app', subfolder, command, submittedAtMs: nowMs - submittedMinutesAgo * 60_000, timeoutSeconds: 10800, owner: 'h:1', group: 'default', isBackground: false,
  });

  it('durations and ages read short', () => {
    assert.deepEqual([0, 45, 192, 3725, 90000].map(formatDuration), ['0s', '45s', '3m12s', '1h02m', '1d1h']);
    assert.deepEqual([10, 300, 7200, 259200].map(formatAge), ['just now', '5m ago', '2h ago', '3d ago']);
  });

  it('ls: newest first, aligned columns, the project with its subfolder, a long command cut', () => {
    const entries = [
      { meta: meta('box1-aaaaaa', 120, 'yarn test'), facts: facts({ exit: 0, startedAtSeconds: nowMs / 1000 - 7200, finishedAtSeconds: nowMs / 1000 - 7000 }), outcome: describeJobOutcome(facts({ exit: 0 }), null) },
      { meta: meta('box1-bbbbbb', 5, `yarn e2e ${'x'.repeat(100)}`, 'projects/mobile'), facts: facts({ isStarted: true, startedAtSeconds: nowMs / 1000 - 240, phase: 'running' }), outcome: describeJobOutcome(facts({ isStarted: true, phase: 'running' }), task('running')) },
    ];
    const lines = formatJobList(entries, nowMs);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^box1-bbbbbb  running +4m00s  5m ago +app\/projects\/mobile  yarn e2e x+…$/);
    assert.match(lines[1], /^box1-aaaaaa  passed +exit 0  3m20s  2h ago +app +yarn test$/);
  });

  it('status: the state, the runner, the project, the command, the times', () => {
    const text = formatJobStatus({ meta: meta('box1-aaaaaa', 10, 'yarn test'), facts: facts({ exit: 1, startedAtSeconds: nowMs / 1000 - 500, finishedAtSeconds: nowMs / 1000 - 380 }), outcome: describeJobOutcome(facts({ exit: 1 }), null) }, nowMs);
    assert.equal(text, [
      'job box1-aaaaaa — failed (exit 1)',
      '  runner: box1',
      '  project: app',
      '  command: yarn test',
      '  submitted 2026-10-31 11:50 UTC · started 2026-10-31 11:51 UTC · took 2m00s',
    ].join('\n'));
  });
});
