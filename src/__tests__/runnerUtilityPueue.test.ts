/**
 * @description `runnerUtility/pueueDaemon.ts` against a recording command runner: what a Pueue daemon on the runner\'s socket is doing (none,
 * idle, busy with Running / Paused jobs, unreadable), shutting an idle one down, and stopping every job of the queue. The same functions
 * with a real daemon are in `runnerServiceTakeoverE2e.test.ts`.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { CommandResult, CommandRunner } from '../selfUpdate/commandRunner';
import { countActivePueueTasks, inspectPueue, parsePueueStatus, readPueueView, shutDownPueue, stopAllPueueJobs, summarizePueueView } from '../runnerUtility/pueueDaemon';

/** Every status of a task that is not over: it runs, is paused, waits in the queue or is locked. */
const pueueUnfinishedStatuses: readonly string[] = ['Running', 'Paused', 'Queued', 'Locked'];
import { getRunnerHomePaths, type RunnerHomePaths } from '../runnerUtility/runnerHome';

let paths: RunnerHomePaths;
let home = '';

function tasks(...statuses: Array<string | Record<string, object>>): string {
  return JSON.stringify({ tasks: Object.fromEntries(statuses.map((status, index) => [index, { status }])) });
}

describe('counting the jobs that hold a process', () => {
  it('counts Running and Paused tasks — Pueue kills those when it stops — and not the queued or the finished', () => {
    assert.equal(countActivePueueTasks(tasks({ Running: {} }, { Queued: {} }, { Done: {} }, { Paused: {} })), 2);
    assert.equal(countActivePueueTasks(tasks({ Queued: {} }, 'Stashed')), 0);
    assert.equal(countActivePueueTasks(tasks('Running')), 1);
    assert.equal(countActivePueueTasks(JSON.stringify({ tasks: {} })), 0);
  });

  it('with the unfinished statuses it also counts the QUEUED and the locked — they start the moment a slot frees — and still not the finished or the stashed', () => {
    assert.equal(countActivePueueTasks(tasks({ Running: {} }, { Queued: {} }, { Done: {} }, { Paused: {} }), pueueUnfinishedStatuses), 3);
    assert.equal(countActivePueueTasks(tasks({ Queued: {} }, 'Stashed', { Locked: {} }, { Done: {} }), pueueUnfinishedStatuses), 2);
    assert.equal(countActivePueueTasks(tasks({ Done: {} }, 'Stashed'), pueueUnfinishedStatuses), 0);
  });

  it('is null for text that is not Pueue\'s status', () => {
    assert.equal(countActivePueueTasks('not json'), null);
    assert.equal(countActivePueueTasks(JSON.stringify({ other: 1 })), null);
  });
});

describe('asking the daemon', () => {
  let daemonUp: boolean;
  let statusJson: string;
  let commands: string[];
  /** After `reset --force` the tasks are still `Running` for this many looks (Pueue 4 answers the command at once and kills them later); `null` = no reset yet. */
  let looksUntilKilled: number | null;
  const runner: CommandRunner = async (file, args) => {
    const line = `${path.basename(file)} ${args.join(' ')}`;
    commands.push(line);
    const result = (ok: boolean, stdout = ''): CommandResult => ({ ok, exitCode: ok ? 0 : 1, stdout, stderr: '', isTimedOut: false });
    if (line.endsWith('status --json')) {
      if (looksUntilKilled === null) return result(daemonUp, statusJson);
      if (looksUntilKilled > 0) {
        looksUntilKilled -= 1;
        return result(daemonUp, statusJson);
      }
      return result(daemonUp, tasks());
    }
    if (line.endsWith(' status')) return result(daemonUp);
    if (line.endsWith('shutdown')) {
      daemonUp = false;
      return result(true);
    }
    if (line.endsWith('reset --force')) {
      looksUntilKilled = 1;
      return result(true);
    }
    return result(true);
  };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pq-'));
    paths = getRunnerHomePaths(home);
    daemonUp = true;
    statusJson = tasks();
    commands = [];
    looksUntilKilled = null;
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('absent, idle, busy and unreadable', async () => {
    daemonUp = false;
    assert.deepEqual(await inspectPueue(paths, runner), { kind: 'absent' });
    daemonUp = true;
    assert.deepEqual(await inspectPueue(paths, runner), { kind: 'idle' });
    statusJson = tasks({ Running: {} }, { Paused: {} });
    assert.deepEqual(await inspectPueue(paths, runner), { kind: 'busy', activeJobs: 2 });
    statusJson = '<html>';
    assert.deepEqual(await inspectPueue(paths, runner), { kind: 'unreadable' });
  });

  it('a queue that holds only queued jobs is idle for most callers and busy for one that counts the queued ones', async () => {
    statusJson = tasks({ Queued: {} }, { Done: {} });
    assert.deepEqual(await inspectPueue(paths, runner), { kind: 'idle' });
    assert.deepEqual(summarizePueueView(await readPueueView(paths, runner), pueueUnfinishedStatuses), { kind: 'busy', activeJobs: 1 });
  });

  it('shutting down waits until the daemon no longer answers', async () => {
    assert.equal(await shutDownPueue(paths, runner), true);
    assert.equal(daemonUp, false);
    assert.ok(commands.some((line) => line.endsWith('shutdown')));
  });

  it('stopping the jobs empties the queue and checks nothing is left running; with no daemon there is nothing to stop', async () => {
    statusJson = tasks({ Running: {} }, { Queued: {} });
    assert.equal(await stopAllPueueJobs(paths, runner), true, 'true although the first look after the reset still saw the task running: the kill is asynchronous');
    assert.ok(commands.some((line) => line.endsWith('reset --force')));
    assert.ok(commands.filter((line) => line.endsWith('status --json')).length >= 3, 'it looked again until the queue was empty');
    assert.deepEqual(await inspectPueue(paths, runner), { kind: 'idle' });

    commands = [];
    daemonUp = false;
    assert.equal(await stopAllPueueJobs(paths, runner), true);
    assert.ok(!commands.some((line) => line.includes('reset')), 'no daemon, no reset');
  });

  it('is false when a job survives the reset', async () => {
    statusJson = tasks({ Running: {} });
    const stubborn: CommandRunner = async (file, args) => {
      if (args.includes('reset')) return { ok: true, exitCode: 0, stdout: '', stderr: '', isTimedOut: false };
      return runner(file, args, { timeoutMs: 1 });
    };
    assert.equal(await stopAllPueueJobs(paths, stubborn, 200), false);
  });
});

describe('reading the tasks and the paused groups (what a restart or a removal of a Node decides on)', () => {
  /** The shape Pueue 4.0.4 prints: a task's status is a word or an object with its details; a group has a status. */
  const snapshot = JSON.stringify({
    tasks: {
      3: { id: 3, status: { Running: { start: '2026-11-08T00:00:00Z' } }, group: 'builds' },
      4: { id: 4, status: { Queued: { enqueued_at: '2026-11-08T00:00:00Z' } }, group: 'default' },
      5: { id: 5, status: 'Stashed' },
    },
    groups: { default: { status: 'Paused', parallel_tasks: 1 }, builds: { status: 'Running', parallel_tasks: 1 } },
  });

  it('reads each task\'s id, status word and group (a task without a group is in `default`), and which groups are paused', () => {
    assert.deepEqual(parsePueueStatus(snapshot), {
      tasks: [{ id: '3', status: 'Running', group: 'builds' }, { id: '4', status: 'Queued', group: 'default' }, { id: '5', status: 'Stashed', group: 'default' }],
      pausedGroups: ['default'],
    });
    assert.deepEqual(parsePueueStatus(JSON.stringify({ tasks: {} })), { tasks: [], pausedGroups: [] });
    assert.equal(parsePueueStatus('not json'), null);
    assert.equal(parsePueueStatus('{}'), null);
  });

  it('the counter and the reader are ONE parser: they agree on the same text, a status in either shape', () => {
    const unfinished = ['Running', 'Queued'];
    assert.equal(countActivePueueTasks(snapshot, unfinished), parsePueueStatus(snapshot)?.tasks.filter((task) => unfinished.includes(task.status)).length);
    assert.equal(countActivePueueTasks(snapshot, unfinished), 2);
    assert.equal(countActivePueueTasks('{}'), null, 'and both refuse what is not a status');
  });

  function createRunner(answer: Partial<CommandResult>): CommandRunner {
    return async () => ({ ok: true, exitCode: 0, stdout: '', stderr: '', isTimedOut: false, ...answer });
  }

  it('says there is NO daemon only when the client says so — in the words it really uses when it never started and when it stopped', async () => {
    const neverStarted = 'Error: \n   0: I/O error at path "/x/data/shared_secret" while opening secret file. Did you start the daemon at least once?:\n      No such file or directory (os error 2)';
    const stopped = 'Error: \n   0: Failed to initialize client.\n   2: I/O error at path "/x/run/pueue.socket" while connecting to daemon. Did you start it?:\n      No such file or directory (os error 2)';
    const refused = 'Error: \n  0: Connection refused (os error 111)';
    for (const stderr of [neverStarted, stopped, refused]) assert.deepEqual(await readPueueView(paths, createRunner({ ok: false, exitCode: 1, stderr })), { kind: 'absent' });
  });

  it('a probe that timed out, one that failed for another reason, and a reply that is no status are UNKNOWN — with the reason — never "no daemon"', async () => {
    assert.deepEqual(await readPueueView(paths, createRunner({ ok: false, exitCode: null, isTimedOut: true, stderr: 'Did you start it?' })), { kind: 'unknown', reason: 'it did not answer within 5 s' }, 'even when its words look like "no daemon": it was cut off');
    assert.deepEqual(await readPueueView(paths, createRunner({ ok: false, exitCode: 101, stderr: 'thread panicked' })), { kind: 'unknown', reason: 'it failed (exit 101)' });
    assert.deepEqual(await readPueueView(paths, createRunner({ stdout: 'not json' })), { kind: 'unknown', reason: 'its answer could not be read' });
  });

  it('returns the tasks of an answer', async () => {
    const view = await readPueueView(paths, createRunner({ stdout: snapshot }));
    assert.equal(view.kind, 'tasks');
    assert.deepEqual(view.kind === 'tasks' ? view.pausedGroups : null, ['default']);
  });
});
