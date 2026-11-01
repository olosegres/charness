/**
 * @description `stageJob` (`remoteRun/submit.ts`) and `--with-git`: the check that the project's `.git` is a directory (a linked
 * worktree or a submodule checkout keeps a file there) must refuse BEFORE anything reaches the runner — it used to run after the whole
 * project was sent, so the refusal came after minutes of upload and left a staged job behind.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { RemoteRunOptions } from '../remoteRun/cliArgs';
import { getProjectContext } from '../remoteRun/project';
import { RemoteRunError } from '../remoteRun/remoteRunError';
import type { RunnerClient } from '../remoteRun/runnerClient';
import { stageJob } from '../remoteRun/submit';

const reachedRunnerMessage = 'the runner was reached';

let workRoot = '';

function git(directory: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=Test', '-C', directory, ...args], { stdio: 'ignore' });
}

/** A client that records every call to the runner and fails the first one: all these cases need is to see whether the runner was reached. */
function createRecordingClient(): { client: RunnerClient; calls: string[] } {
  const calls: string[] = [];
  const fail = (name: string) => async (): Promise<never> => {
    calls.push(name);
    throw new RemoteRunError(reachedRunnerMessage);
  };
  const client: RunnerClient = {
    runner: { name: 'box1', ssh: 'user@127.0.0.1', workDir: '/work' },
    cacheDir: path.join(workRoot, 'cache'),
    rsyncSshCommand: 'ssh',
    ensureScript: fail('ensureScript'),
    getAbsoluteWorkDir: fail('getAbsoluteWorkDir'),
    call: fail('call'),
    callOrThrow: fail('callOrThrow'),
    stream: () => {
      calls.push('stream');
      throw new RemoteRunError(reachedRunnerMessage);
    },
  };
  return { client, calls };
}

const withGitOptions: RemoteRunOptions = { runner: null, needs: null, runnerWaitSeconds: null, group: null, timeoutSeconds: null, isWithGit: true, env: [], isBackground: false };

async function stage(projectRoot: string, options: RemoteRunOptions): Promise<{ error: Error | null; calls: string[]; cacheEntries: string[] }> {
  const { client, calls } = createRecordingClient();
  const metaDirectory = path.join(workRoot, 'meta');
  fs.mkdirSync(metaDirectory, { recursive: true });
  let error: Error | null = null;
  try {
    await stageJob({ client, project: getProjectContext(projectRoot), command: 'true', options, metaDirectory, say: () => undefined });
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error('not an error');
  }
  return { error, calls, cacheEntries: fs.existsSync(client.cacheDir) ? fs.readdirSync(client.cacheDir) : [] };
}

describe('stageJob with --with-git', () => {
  beforeEach(() => {
    workRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remote-run-submit-')));
  });

  afterEach(() => {
    fs.rmSync(workRoot, { recursive: true, force: true });
  });

  it('a linked worktree (its .git is a file) is refused before the runner is touched and before a job record is written', async () => {
    const main = path.join(workRoot, 'main');
    fs.mkdirSync(main);
    git(main, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(main, 'a.txt'), 'a');
    git(main, 'add', '.');
    git(main, 'commit', '-q', '-m', 'first');
    const linked = path.join(workRoot, 'linked');
    git(main, 'worktree', 'add', '-q', linked);
    assert.ok(fs.statSync(path.join(linked, '.git')).isFile(), 'the setup: a linked worktree keeps a .git FILE');

    const { error, calls, cacheEntries } = await stage(linked, withGitOptions);

    assert.match(error?.message ?? '', /--with-git needs the project's \.git to be a directory/);
    assert.deepEqual(calls, [], 'nothing was asked of the runner');
    assert.deepEqual(cacheEntries, [], 'no job record was written for a job that never existed');
  });

  it('an ordinary project (a .git folder) passes the check and goes on to the runner; without --with-git a worktree is not asked about its .git at all', async () => {
    const ordinary = path.join(workRoot, 'ordinary');
    fs.mkdirSync(ordinary);
    git(ordinary, 'init', '-q', '-b', 'main');
    const reached = await stage(ordinary, withGitOptions);
    assert.equal(reached.error?.message, reachedRunnerMessage);
    assert.deepEqual(reached.calls, ['callOrThrow'], 'prepare is the first thing asked of the runner');

    const main = path.join(workRoot, 'main2');
    fs.mkdirSync(main);
    git(main, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(main, 'a.txt'), 'a');
    git(main, 'add', '.');
    git(main, 'commit', '-q', '-m', 'first');
    const linked = path.join(workRoot, 'linked2');
    git(main, 'worktree', 'add', '-q', linked);
    const withoutGit = await stage(linked, { ...withGitOptions, isWithGit: false });
    assert.equal(withoutGit.error?.message, reachedRunnerMessage);
    assert.deepEqual(withoutGit.calls, ['callOrThrow']);
  });
});
