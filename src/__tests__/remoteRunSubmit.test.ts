/**
 * @description `stageJob` (`remoteRun/submit.ts`) and `--with-git`: the check that the project's `.git` is a directory (a linked
 * worktree or a submodule checkout keeps a file there) must refuse BEFORE anything reaches the runner — it used to run after the whole
 * project was sent, so the refusal came after minutes of upload and left a staged job behind. And what `prepare` answers: the project copies the runner's
 * prune removed are said, the runner's refusal of a job its disk has no room for is the error (exit 125) with the runner's own words, and `prepare` gets the long call timeout.
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
import { getProjectKey } from '../remoteRun/jobId';
import { getProjectContext } from '../remoteRun/project';
import { RemoteRunError } from '../remoteRun/remoteRunError';
import { diskTooLowRunnerExitCode } from '../remoteRun/pruneReport';
import { prepareCallTimeoutMs, type RunnerClient } from '../remoteRun/runnerClient';
import type { SshRunResult } from '../remoteRun/ssh';
import { getJobOwner, stageJob } from '../remoteRun/submit';
import { remoteRunExitCodes } from '../remoteRun/exitCodes';

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

const withGitOptions: RemoteRunOptions = { runner: null, needs: null, runnerWaitSeconds: null, group: null, timeoutSeconds: null, isWithGit: true, send: [], env: [], isBackground: false };

async function stage(projectRoot: string, options: RemoteRunOptions): Promise<{ error: Error | null; calls: string[]; cacheEntries: string[]; metaFiles: string[]; metaDirectory: string }> {
  const { client, calls } = createRecordingClient();
  const metaDirectory = fs.mkdtempSync(path.join(workRoot, 'meta-'));
  let error: Error | null = null;
  try {
    await stageJob({ client, project: getProjectContext(projectRoot), command: 'true', options, metaDirectory, say: () => undefined });
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error('not an error');
  }
  return { error, calls, cacheEntries: fs.existsSync(client.cacheDir) ? fs.readdirSync(client.cacheDir) : [], metaFiles: fs.readdirSync(metaDirectory), metaDirectory };
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
    assert.deepEqual(reached.calls, ['call'], 'prepare is the first thing asked of the runner');

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
    assert.deepEqual(withoutGit.calls, ['call']);
  });
});

describe('stageJob and a job that needs iOS', () => {
  beforeEach(() => {
    workRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remote-run-submit-')));
  });

  afterEach(() => {
    fs.rmSync(workRoot, { recursive: true, force: true });
  });

  it('`--needs ios` marks the job (`needs-ios` among its files, which the runner reads to run it in a login session); any other need does not', async () => {
    const project = path.join(workRoot, 'project');
    fs.mkdirSync(project);
    git(project, 'init', '-q', '-b', 'main');
    const ios = await stage(project, { ...withGitOptions, isWithGit: false, needs: 'ios' });
    assert.ok(ios.metaFiles.includes('needs-ios'), ios.metaFiles.join(', '));
    for (const needs of ['android', 'docker', 'playwright', null] as const) {
      const other = await stage(project, { ...withGitOptions, isWithGit: false, needs });
      assert.ok(!other.metaFiles.includes('needs-ios'), `${needs}: ${other.metaFiles.join(', ')}`);
    }
  });
});

describe('stageJob and what the project asks the runner to clean after the job', () => {
  beforeEach(() => {
    workRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remote-run-submit-')));
  });
  afterEach(() => {
    fs.rmSync(workRoot, { recursive: true, force: true });
  });

  it('`clean-after-success:` of .remote-run reaches the runner as the job\'s two files — the compiled patterns and the folders to walk, as `pull:` does; a project without the line sends them empty (the runner removes nothing)', async () => {
    const project = path.join(workRoot, 'project');
    fs.mkdirSync(project);
    git(project, 'init', '-q', '-b', 'main');
    const without = await stage(project, { ...withGitOptions, isWithGit: false });
    assert.equal(fs.readFileSync(path.join(without.metaDirectory, 'clean-after-success.ere'), 'utf8'), '');
    assert.equal(fs.readFileSync(path.join(without.metaDirectory, 'clean-after-success.roots'), 'utf8'), '');
    fs.writeFileSync(path.join(project, '.remote-run'), 'pull: test-results\nclean-after-success: ios/build/Intermediates.noindex projects/*/ios/build/**/Intermediates.noindex\n');
    const asked = await stage(project, { ...withGitOptions, isWithGit: false });
    assert.equal(fs.readFileSync(path.join(asked.metaDirectory, 'clean-after-success.ere'), 'utf8'), '^ios/build/Intermediates\\.noindex(/.*)?$\n^projects/[^/]*/ios/build/(.*/)?Intermediates\\.noindex(/.*)?$\n');
    assert.equal(fs.readFileSync(path.join(asked.metaDirectory, 'clean-after-success.roots'), 'utf8'), 'ios/build/Intermediates.noindex\nprojects\n');
    assert.equal(fs.readFileSync(path.join(asked.metaDirectory, 'pull.roots'), 'utf8'), 'test-results\n', 'and `pull:` is its own list');
  });
});

describe('stageJob and the repository the runner matches copies on', () => {
  beforeEach(() => {
    workRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remote-run-submit-')));
  });
  afterEach(() => {
    fs.rmSync(workRoot, { recursive: true, force: true });
  });

  /** Stage the project at `projectRoot` against a runner that answers `prepare`; the job's files and the arguments `prepare` got come back. */
  async function stageAndReadPrepare(projectRoot: string, extraFiles: Record<string, string> = {}): Promise<{ metaFiles: string[]; metaDirectory: string; prepareArgs: readonly string[] }> {
    for (const [name, content] of Object.entries(extraFiles)) fs.writeFileSync(path.join(projectRoot, name), content);
    const { client } = createRecordingClient();
    let prepareArgs: readonly string[] = [];
    const answering: RunnerClient = {
      ...client,
      call: async (subcommand, args) => {
        assert.equal(subcommand, 'prepare');
        prepareArgs = args;
        return { exitCode: 1, stdout: '', stderr: 'stop here', isTimedOut: false };
      },
    };
    const metaDirectory = fs.mkdtempSync(path.join(workRoot, 'meta-'));
    await assert.rejects(stageJob({ client: answering, project: getProjectContext(projectRoot), command: 'true', options: { ...withGitOptions, isWithGit: false }, metaDirectory, say: () => undefined }));
    return { metaFiles: fs.readdirSync(metaDirectory), metaDirectory, prepareArgs };
  }

  it('the job carries the key of its repository — the same for a clone in a folder of another name — and `prepare` is told it with the install key, so its prune can keep the copy this job is seeded from', async () => {
    const original = path.join(workRoot, 'overview');
    fs.mkdirSync(original);
    git(original, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(original, 'yarn.lock'), '# lock\n');
    git(original, 'add', '-A');
    git(original, 'commit', '-q', '-m', 'init');
    const clone = path.join(workRoot, 'overview-lingua');
    git(workRoot, 'clone', '-q', original, clone);
    const rootCommit = execFileSync('git', ['-C', original, 'rev-list', '--max-parents=0', 'HEAD'], { encoding: 'utf8' }).trim();
    const first = await stageAndReadPrepare(original);
    const second = await stageAndReadPrepare(clone);
    const expectedKey = getProjectKey(getJobOwner(), rootCommit);
    for (const staged of [first, second]) {
      assert.equal(fs.readFileSync(path.join(staged.metaDirectory, 'project-key'), 'utf8'), expectedKey);
      assert.equal(staged.prepareArgs[3], expectedKey, 'the 4th argument of prepare');
      assert.equal(staged.prepareArgs[4], fs.readFileSync(path.join(staged.metaDirectory, 'install-key'), 'utf8'), 'the 5th: the install key the job carries');
    }
  });

  it('a repository with no commit has no key: no file, and `prepare` gets an empty word (nothing is seeded from, or kept for, it)', async () => {
    const project = path.join(workRoot, 'project');
    fs.mkdirSync(project);
    git(project, 'init', '-q', '-b', 'main');
    const staged = await stageAndReadPrepare(project, { 'yarn.lock': '# lock\n' });
    assert.ok(!staged.metaFiles.includes('project-key'), staged.metaFiles.join(', '));
    assert.equal(staged.prepareArgs[3], '');
  });
});

describe('stageJob and what the runner says to prepare', () => {
  const preparedAnswer = (overrides: Partial<SshRunResult>): SshRunResult => ({ exitCode: 0, stdout: '', stderr: '', isTimedOut: false, ...overrides });

  beforeEach(() => {
    workRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remote-run-submit-')));
  });
  afterEach(() => {
    fs.rmSync(workRoot, { recursive: true, force: true });
  });

  /** Stage a project against a runner whose `prepare` answers `answer`; what was said and which call options `prepare` got come back. */
  async function stageWithPrepareAnswer(answer: SshRunResult): Promise<{ error: Error | null; said: string[]; prepareTimeoutMs: number | undefined }> {
    const project = path.join(workRoot, 'project');
    fs.mkdirSync(project);
    git(project, 'init', '-q', '-b', 'main');
    const { client } = createRecordingClient();
    let prepareTimeoutMs: number | undefined;
    const answering: RunnerClient = {
      ...client,
      call: async (subcommand, _args, options) => {
        assert.equal(subcommand, 'prepare', 'nothing else is asked before the answer is read');
        prepareTimeoutMs = options?.timeoutMs;
        return answer;
      },
    };
    const said: string[] = [];
    const metaDirectory = fs.mkdtempSync(path.join(workRoot, 'meta-'));
    let error: Error | null = null;
    try {
      await stageJob({ client: answering, project: getProjectContext(project), command: 'true', options: { ...withGitOptions, isWithGit: false }, metaDirectory, say: (line) => said.push(line) });
    } catch (caught) {
      error = caught instanceof Error ? caught : new Error('not an error');
    }
    return { error, said, prepareTimeoutMs };
  }

  it('a runner short of disk refuses the job: its own words are the error (exit 125), and what its prune removed first is said before', async () => {
    const refusal = 'only 8 GB free on the work disk, the runner needs 60 GB; biggest project copies: app-1 41 GB, app-2 30 GB; free space with `charness remote-run clean <slug>` on the copies of project folders whose last task is closed';
    const { error, said } = await stageWithPrepareAnswer(preparedAnswer({
      exitCode: diskTooLowRunnerExitCode,
      stdout: 'removed=old-1 freed_kb=31457280 why=space\n',
      stderr: `remote-run-runner: ${refusal}\n`,
    }));
    assert.ok(error instanceof RemoteRunError);
    assert.equal(error.message, `runner "box1": ${refusal}`);
    assert.equal(error.exitCode, remoteRunExitCodes.failed);
    assert.deepEqual(said, ['runner box1: removed the project copy old-1 (freed 30 GB, the disk was short of free space)']);
  });

  it('every removed copy is a line of the submit\'s output, with what it freed and why; a copy that would not go says so (no work dir line is given here, so the stage ends right after prepare)', async () => {
    const { error, said } = await stageWithPrepareAnswer(preparedAnswer({
      stdout: 'removed=idle-1 freed_kb=2097152 why=idle\nremoved=lru-2 freed_kb= why=space\nstuck=ro-3\n',
    }));
    assert.equal(error?.message, 'runner "box1": prepare did not report its work dir');
    assert.deepEqual(said, [
      'runner box1: removed the project copy idle-1 (freed 2 GB, unused for days)',
      'runner box1: removed the project copy lru-2 (the disk was short of free space)',
      'runner box1: could not remove the project copy ro-3 completely (read-only or in use) — the next prune tries again',
    ]);
  });

  it('a disk the last probe found under its target is announced BEFORE prepare (which says nothing until it is done): the figures and what is about to happen', async () => {
    const cacheDir = path.join(workRoot, 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'box1.probe.json'), JSON.stringify({ seenAtMs: Date.now(), text: 'os=Darwin\ndisk_free_mb=8192\ndisk_min_free_mb=61440\n' }));
    const events: string[] = [];
    const { client } = createRecordingClient();
    const answering: RunnerClient = { ...client, call: async () => { events.push('prepare'); return preparedAnswer({ exitCode: 1, stderr: 'remote-run-runner: boom\n' }); } };
    const project = path.join(workRoot, 'project');
    fs.mkdirSync(project);
    git(project, 'init', '-q', '-b', 'main');
    await assert.rejects(stageJob({ client: answering, project: getProjectContext(project), command: 'true', options: { ...withGitOptions, isWithGit: false }, metaDirectory: fs.mkdtempSync(path.join(workRoot, 'meta-')), say: (line) => events.push(line) }));
    assert.deepEqual(events, ['runner box1: 8 GB free, it keeps 60 GB — removing the least recently used project copies first (this can take minutes)', 'prepare']);
  });

  it('with no probe on record, or a disk at its target, nothing is added before prepare', async () => {
    const { said } = await stageWithPrepareAnswer(preparedAnswer({ exitCode: 1, stderr: 'remote-run-runner: boom\n' }));
    assert.deepEqual(said, []);
  });

  it('a prune that stopped because a removal gave nothing back says so — also when the submit then goes on', async () => {
    const { said } = await stageWithPrepareAnswer(preparedAnswer({ stdout: 'removed=app-1 freed_kb=0 why=space\nstopped=app-1 freed_kb=0 size_kb=31457280\n' }));
    assert.deepEqual(said, [
      'runner box1: removed the project copy app-1 (freed 0 GB, the disk was short of free space)',
      "runner box1: removing project copies gave back almost nothing twice in a row (the last, app-1: 0 GB of its 30 GB) — the disk's free space is not following (a Mac keeps it while Time Machine local snapshots or purgeable space hold it; jobs writing meanwhile eat it too, see docs/remote-run.md), so it stopped removing more copies",
    ]);
  });

  it('a prepare that timed out says the runner carries on as far as it can — not «prepare failed»', async () => {
    const { error } = await stageWithPrepareAnswer(preparedAnswer({ exitCode: null, isTimedOut: true, stderr: '' }));
    assert.ok(error instanceof RemoteRunError);
    assert.match(error.message, /^runner "box1": preparing the job took longer than 15 minutes .* carries on with that as far as it can: submit again in a few minutes, the next submit continues where it stopped$/);
    assert.doesNotMatch(error.message, /prepare failed/);
  });

  it('prepare gets the long call timeout: removing project copies of tens of GB takes minutes', async () => {
    const { prepareTimeoutMs } = await stageWithPrepareAnswer(preparedAnswer({ exitCode: 1, stderr: 'remote-run-runner: boom\n' }));
    assert.equal(prepareTimeoutMs, prepareCallTimeoutMs);
    assert.ok(prepareCallTimeoutMs >= 10 * 60 * 1000);
  });

  it('any other failure of prepare is reported the way every runner call is: the runner\'s last lines', async () => {
    const { error } = await stageWithPrepareAnswer(preparedAnswer({ exitCode: 125, stderr: 'remote-run-runner: Pueue daemon is not reachable\n' }));
    assert.equal(error?.message, 'runner "box1": prepare failed — remote-run-runner: Pueue daemon is not reachable');
  });
});
