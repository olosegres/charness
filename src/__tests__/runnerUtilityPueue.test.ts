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
import { countActivePueueTasks, inspectPueue, pueueUnfinishedStatuses, shutDownPueue, stopAllPueueJobs } from '../runnerUtility/pueueDaemon';
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
    assert.deepEqual(await inspectPueue(paths, runner, pueueUnfinishedStatuses), { kind: 'busy', activeJobs: 1 });
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
