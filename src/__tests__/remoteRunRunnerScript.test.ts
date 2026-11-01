/**
 * @description `remoteRun/runner.sh` — the script that runs on a runner — as far as it can be tested without Pueue and ssh (the flow
 * `remoteRunE2e.test.ts` and `remoteRunLifecycleE2e.test.ts` run the rest): it parses and uses nothing newer than bash 3.2 (the stock bash of macOS); `probe` prints what
 * `probe.ts` parses; a bad project or job name is refused before anything is touched; the apply step mirrors deletions from the manifest
 * diff, leaves the runner's own ignored files alone, removes the folders it emptied, and never follows a hostile manifest entry out of
 * the copy; `jobs`, `meta`, `tail` and `result` read a job folder the way `ls` and `status` expect.
 *
 * rsync is needed for the apply step: a local run without it is SKIPPED with the reason, CI (`CI` is `true` or `1`) installs it and
 * fails without.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseProbeOutput } from '../remoteRun/probe';
import { iosBootFailureReasonPrefix } from '../runnerUtility/iosCheck';
import { parseJobFacts } from '../remoteRun/jobState';
import { checkIsProcessRunning } from './e2e/isolatedCharness';
import { jobId, scriptPath, slug, writeFile } from './remoteRunRunnerScriptKit';

const isCi = process.env.CI === 'true' || process.env.CI === '1';
const hasRsync = spawnSync('rsync', ['--version'], { stdio: 'ignore' }).status === 0;
const rsyncSkip = !hasRsync && !isCi ? 'rsync is not installed here (CI installs it)' : false;


let workRoot = '';
let workDir = '';

function runScript(args: string[], env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('bash', [scriptPath, ...args], { encoding: 'utf8', env: { ...process.env, PUEUE_BIN: '/nonexistent/pueue', ...env }, timeout: 60_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function getPaths(): { project: string; tree: string; stage: string; jobDir: string } {
  const project = path.join(workDir, 'p', slug);
  return { project, tree: path.join(project, 'tree'), stage: path.join(project, 'stage', jobId), jobDir: path.join(project, 'jobs', jobId) };
}

beforeEach(() => {
  workRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-script-')));
  workDir = path.join(workRoot, 'work');
  fs.mkdirSync(workDir);
});
afterEach(() => {
  fs.rmSync(workRoot, { recursive: true, force: true });
});

describe('the script as text', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');
  const code = source.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');

  it('is valid bash', () => {
    assert.equal(spawnSync('bash', ['-n', scriptPath]).status, 0);
  });

  it('uses nothing newer than bash 3.2 (a runner may be a Mac with its stock bash)', () => {
    const newerThanBash32: Array<[string, RegExp]> = [
      ['associative arrays', /\bdeclare\s+-A\b|\btypeset\s+-A\b/],
      ['mapfile / readarray', /\bmapfile\b|\breadarray\b/],
      ['wait -n', /\bwait\s+-n\b/],
      ['case-changing expansion', /\$\{[A-Za-z_]+(,,|\^\^|,|\^)\}/],
      ['|& pipe', /\|&/],
      ['&>> redirect', /&>>/],
      ['coproc', /\bcoproc\b/],
      ['read -t (its timeout status is not the same in bash 3.2 and 4+)', /\bread\s[^|;\n]*-t\b/],
      ['timeout(1)', /(^|[\s;|&(])timeout\s+\d/m],
      ['globstar', /shopt\s+-s\s+globstar/],
      ['${var@op}', /\$\{[A-Za-z_]+@[A-Za-z]\}/],
    ];
    assert.deepEqual(newerThanBash32.filter(([, pattern]) => pattern.test(code)).map(([name]) => name), []);
  });

  it('starts with a bash shebang and sets no `set -e` (every failure is handled where it happens)', () => {
    assert.ok(source.startsWith('#!/usr/bin/env bash\n'));
    assert.ok(!/^set -[a-z]*e/m.test(code));
  });
});

describe('probe', () => {
  it('prints what the probe parser reads: this machine, its resources, no Pueue here', () => {
    const result = runScript(['probe', workDir]);
    assert.equal(result.status, 0, result.stderr);
    const probe = parseProbeOutput(result.stdout);
    assert.notEqual(probe.os, '');
    assert.ok((probe.cpuThreads ?? 0) > 0, 'threads');
    assert.ok((probe.ramTotalMb ?? 0) > 0, 'RAM');
    assert.ok((probe.diskFreeMb ?? 0) > 0, 'disk');
    assert.equal(probe.pueueVersion, null, 'Pueue is not at the (nonexistent) PUEUE_BIN');
    assert.deepEqual([probe.jobsRunning, probe.jobsQueued, probe.jobsProjects], [0, 0, 0]);
    for (const name of ['android', 'ios', 'docker', 'playwright'] as const) {
      assert.ok(['yes', 'no'].includes(result.stdout.match(new RegExp(`^cap_${name}=(.*)$`, 'm'))?.[1] ?? ''), `cap_${name} is reported`);
    }
    assert.ok(fs.existsSync(workDir));
  });

  it('counts a started job, a queued job and the projects they belong to, from the job folders', () => {
    const runningDir = path.join(workDir, 'p', 'app-aaaaaaaaaa', 'jobs', 'box1-running');
    const queuedDir = path.join(workDir, 'p', 'app-bbbbbbbbbb', 'jobs', 'box1-queued');
    const finishedDir = path.join(workDir, 'p', 'app-aaaaaaaaaa', 'jobs', 'box1-finished');
    for (const directory of [runningDir, queuedDir, finishedDir]) {
      writeFile(directory, 'task-id', '1\n');
    }
    writeFile(runningDir, 'pid', `${process.pid}\n`);
    writeFile(finishedDir, 'exit', '0\n');
    const probe = parseProbeOutput(runScript(['probe', workDir]).stdout);
    assert.deepEqual([probe.jobsRunning, probe.jobsQueued, probe.jobsProjects], [1, 1, 2]);
  });
});

describe('names are checked before anything is touched', () => {
  it('a project name that is not one safe path component is refused', () => {
    for (const badSlug of ['../escape', 'a/b', '.hidden', 'with space', '']) {
      const result = runScript(['kill', workDir, badSlug, jobId]);
      assert.equal(result.status, 125, badSlug);
      assert.match(result.stderr, /bad name/, badSlug);
    }
    assert.deepEqual(fs.readdirSync(workDir), []);
  });

  it('a job id that is not lowercase letters, digits and dashes is refused', () => {
    for (const badJob of ['../x', 'a/b', 'UPPER', '-leading', 'with space']) {
      const result = runScript(['kill', workDir, slug, badJob]);
      assert.equal(result.status, 125, badJob);
      assert.match(result.stderr, /bad job id/, badJob);
    }
  });

  it('an id-only command for a job that does not exist says so', () => {
    const result = runScript(['result', workDir, '-', 'box1-nothing']);
    assert.equal(result.status, 125);
    assert.match(result.stderr, /no such job: box1-nothing/);
  });

  it('a job id that is already in use is refused by prepare before anything is touched', () => {
    writeFile(workDir, `p/${slug}/jobs/${jobId}/meta.json`, '{}');
    const result = runScript(['prepare', workDir, slug, jobId, 'default=1']);
    assert.equal(result.status, 125);
    assert.match(result.stderr, /job id already in use: box1-aaaaaa/);
    assert.equal(fs.existsSync(path.join(workDir, 'bin')), false);
  });

  it('an unknown subcommand is refused', () => {
    assert.match(runScript(['frobnicate', workDir]).stderr, /unknown subcommand/);
  });
});

describe('the apply step (sync-tree)', () => {
  function prepareJob(options: { oldManifest: string[]; newManifest: string[]; treeFiles: Record<string, string>; stageFiles: Record<string, string> }): void {
    const paths = getPaths();
    for (const [file, content] of Object.entries(options.treeFiles)) writeFile(paths.tree, file, content);
    fs.mkdirSync(paths.stage, { recursive: true });
    for (const [file, content] of Object.entries(options.stageFiles)) writeFile(paths.stage, file, content);
    fs.mkdirSync(paths.jobDir, { recursive: true });
    fs.writeFileSync(path.join(paths.project, 'manifest'), options.oldManifest.map((line) => `${line}\n`).join(''));
    fs.writeFileSync(path.join(paths.jobDir, 'manifest'), options.newManifest.map((line) => `${line}\n`).join(''));
  }

  it('mirrors deletions from the manifest diff, copies the staged files, keeps what the runner owns, removes the folders it emptied', { skip: rsyncSkip }, () => {
    const paths = getPaths();
    prepareJob({
      oldManifest: ['a.txt', 'sub/b.txt', 'sub/deep/c.txt', 'gone.txt'],
      newManifest: ['a.txt', 'sub/b.txt', 'new.txt'],
      treeFiles: { 'a.txt': 'old a', 'sub/b.txt': 'b', 'sub/deep/c.txt': 'c', 'gone.txt': 'g', 'node_modules/dep/marker': 'runner-owned', 'sub/built-by-a-job.txt': 'job output' },
      stageFiles: { 'a.txt': 'new a', 'sub/b.txt': 'b', 'new.txt': 'n' },
    });
    const result = runScript(['sync-tree', workDir, slug, jobId]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(paths.tree, 'a.txt'), 'utf8'), 'new a');
    assert.equal(fs.readFileSync(path.join(paths.tree, 'new.txt'), 'utf8'), 'n');
    assert.equal(fs.existsSync(path.join(paths.tree, 'gone.txt')), false, 'a file no longer sent is deleted');
    assert.equal(fs.existsSync(path.join(paths.tree, 'sub/deep/c.txt')), false);
    assert.equal(fs.existsSync(path.join(paths.tree, 'sub/deep')), false, 'the folder the deletion emptied goes with it');
    assert.equal(fs.readFileSync(path.join(paths.tree, 'node_modules/dep/marker'), 'utf8'), 'runner-owned', 'what the runner keeps is never touched');
    assert.equal(fs.readFileSync(path.join(paths.tree, 'sub/built-by-a-job.txt'), 'utf8'), 'job output', 'a folder that still holds something is kept with it');
    assert.equal(fs.existsSync(paths.stage), false, 'the stage dir is dropped');
    assert.equal(fs.readFileSync(path.join(paths.project, 'manifest'), 'utf8'), 'a.txt\nsub/b.txt\nnew.txt\n', 'this submit\'s list is the next diff\'s old side');
  });

  it('a hostile manifest never deletes outside the copy', { skip: rsyncSkip }, () => {
    const paths = getPaths();
    writeFile(workRoot, 'outside.txt', 'precious');
    writeFile(workDir, 'p/other-project/tree/neighbour.txt', 'neighbour');
    prepareJob({
      oldManifest: ['../../../../outside.txt', '/etc/hostname', 'a/../../../outside.txt', 'ok.txt'],
      newManifest: [],
      treeFiles: { 'ok.txt': 'x' },
      stageFiles: {},
    });
    const result = runScript(['sync-tree', workDir, slug, jobId]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(workRoot, 'outside.txt'), 'utf8'), 'precious');
    assert.equal(fs.readFileSync(path.join(workDir, 'p/other-project/tree/neighbour.txt'), 'utf8'), 'neighbour');
    assert.equal(fs.existsSync(path.join(paths.tree, 'ok.txt')), false, 'the honest entry is still honoured');
  });

  it('a file that becomes a folder and a folder that becomes a file both apply', { skip: rsyncSkip }, () => {
    const paths = getPaths();
    prepareJob({
      oldManifest: ['swap', 'dir/inner.txt'],
      newManifest: ['swap/inner.txt', 'dir'],
      treeFiles: { swap: 'was a file', 'dir/inner.txt': 'was in a folder' },
      stageFiles: { 'swap/inner.txt': 'now in a folder', dir: 'now a file' },
    });
    const result = runScript(['sync-tree', workDir, slug, jobId]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(paths.tree, 'swap/inner.txt'), 'utf8'), 'now in a folder');
    assert.equal(fs.readFileSync(path.join(paths.tree, 'dir'), 'utf8'), 'now a file');
  });

  it('a stage without .git removes the .git an earlier --with-git run left in the copy: .git only with --with-git', { skip: rsyncSkip }, () => {
    const paths = getPaths();
    prepareJob({ oldManifest: ['a.txt'], newManifest: ['a.txt'], treeFiles: { 'a.txt': 'a', '.git/HEAD': 'old head', '.git/refs/heads/main': 'x' }, stageFiles: { 'a.txt': 'a' } });
    assert.equal(runScript(['sync-tree', workDir, slug, jobId]).status, 0);
    assert.equal(fs.existsSync(path.join(paths.tree, '.git')), false, 'a plain run does not run against a stale history');
    assert.equal(fs.readFileSync(path.join(paths.tree, 'a.txt'), 'utf8'), 'a');
  });

  it('the first submit (no old manifest) just copies', { skip: rsyncSkip }, () => {
    const paths = getPaths();
    const manifestPath = path.join(paths.project, 'manifest');
    prepareJob({ oldManifest: [], newManifest: ['a.txt'], treeFiles: {}, stageFiles: { 'a.txt': 'first' } });
    fs.rmSync(manifestPath);
    assert.equal(runScript(['sync-tree', workDir, slug, jobId]).status, 0);
    assert.equal(fs.readFileSync(path.join(paths.tree, 'a.txt'), 'utf8'), 'first');
  });

  it('a staged .git replaces the copy\'s .git, and is not copied as a plain file', { skip: rsyncSkip }, () => {
    const paths = getPaths();
    prepareJob({ oldManifest: [], newManifest: ['a.txt'], treeFiles: { '.git/HEAD': 'old head', '.git/stale': 'stale' }, stageFiles: { 'a.txt': 'a', '.git/HEAD': 'new head' } });
    assert.equal(runScript(['sync-tree', workDir, slug, jobId]).status, 0);
    assert.equal(fs.readFileSync(path.join(paths.tree, '.git/HEAD'), 'utf8'), 'new head');
    assert.equal(fs.existsSync(path.join(paths.tree, '.git/stale')), false, 'the .git of the copy mirrors the staged one');
  });
});

describe('prune', () => {
  const dayMs = 24 * 60 * 60 * 1000;

  function makeOld(target: string, daysAgo: number): void {
    const when = new Date(Date.now() - daysAgo * dayMs);
    fs.utimesSync(target, when, when);
  }

  function writeJobFolder(id: string, files: string[], ageDays: number): string {
    const jobDir = path.join(workDir, 'p', slug, 'jobs', id);
    // A pid file names a process of the runner's own user: this test process stands for a job that runs.
    for (const file of files) writeFile(jobDir, file, file === 'pid' ? `${process.pid}\n` : '1\n');
    makeOld(jobDir, ageDays);
    return jobDir;
  }

  it('removes finished jobs older than three days and jobs that were never submitted; keeps the young, the running and the queued', () => {
    const oldFinished = writeJobFolder('box1-oldfin', ['task-id', 'exit'], 4);
    const oldNeverSubmitted = writeJobFolder('box1-oldnev', ['meta.json'], 4);
    const oldRunning = writeJobFolder('box1-oldrun', ['task-id', 'pid'], 4);
    const youngFinished = writeJobFolder('box1-younfi', ['task-id', 'exit'], 1);
    const result = runScript(['prune', workDir]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(oldFinished), false);
    assert.equal(fs.existsSync(oldNeverSubmitted), false);
    assert.equal(fs.existsSync(oldRunning), true, 'a job that has not finished is never pruned, however old');
    assert.equal(fs.existsSync(youngFinished), true);
  });

  it('removes stage folders older than a day and project copies unused for 30 days — but never a copy that holds the lock', () => {
    const staleStage = path.join(workDir, 'p', slug, 'stage', 'box1-stale');
    const freshStage = path.join(workDir, 'p', slug, 'stage', 'box1-fresh');
    for (const stage of [staleStage, freshStage]) writeFile(stage, 'a.txt');
    makeOld(staleStage, 2);
    const unusedCopy = path.join(workDir, 'p', 'unused-aaaaaaaaaa');
    writeFile(unusedCopy, 'used');
    makeOld(path.join(unusedCopy, 'used'), 31);
    const lockedCopy = path.join(workDir, 'p', 'locked-bbbbbbbbbb');
    writeFile(lockedCopy, 'used');
    makeOld(path.join(lockedCopy, 'used'), 31);
    fs.mkdirSync(path.join(lockedCopy, 'lock'));
    const usedCopy = path.join(workDir, 'p', 'used-cccccccccc');
    writeFile(usedCopy, 'used');
    makeOld(path.join(usedCopy, 'used'), 5);
    assert.equal(runScript(['prune', workDir]).status, 0);
    assert.equal(fs.existsSync(staleStage), false);
    assert.equal(fs.existsSync(freshStage), true);
    assert.equal(fs.existsSync(unusedCopy), false);
    assert.equal(fs.existsSync(lockedCopy), true);
    assert.equal(fs.existsSync(usedCopy), true);
  });
});

describe('the lease (through `exec`, which uses the same watcher as a foreground run)', () => {
  const leaseMs = 3000;
  const killedByTermCode = 143;
  const pollMs = 100;

  /** Where the watcher keeps its state: the runner's own `tmp` folder. */
  let leaseTmp = '';

  interface LeasedRun {
    write: (text: string) => void;
    endStream: () => void;
    finished: Promise<{ code: number | null; stdout: string; stderr: string; elapsedMs: number }>;
  }

  /** `exec` of `command` in the copy of the project, with the stream of this test as the caller's. */
  function startLeasedRun(command: string): LeasedRun {
    fs.mkdirSync(path.join(workDir, 'p', slug, 'tree'), { recursive: true });
    const startedAt = Date.now();
    const child = spawn('bash', [scriptPath, 'exec', workDir, slug, '', `${leaseMs}`, command], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (text: string) => { stdout += text; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (text: string) => { stderr += text; });
    child.stdin.on('error', () => { /* the run ended before the write */ });
    const finished = new Promise<{ code: number | null; stdout: string; stderr: string; elapsedMs: number }>((resolve) => {
      child.on('close', (code) => resolve({ code, stdout, stderr, elapsedMs: Date.now() - startedAt }));
    });
    return { write: (text) => child.stdin.write(text), endStream: () => child.stdin.end(), finished };
  }

  async function readPidWhenWritten(pidFile: string): Promise<number> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const pid = Number(fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim() : '');
      if (Number.isInteger(pid) && pid > 0) return pid;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    throw new Error(`${pidFile} was not written`);
  }

  async function waitForLeaseStateDir(): Promise<string> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const [stateDirName] = listLeaseState();
      if (stateDirName !== undefined && fs.existsSync(path.join(leaseTmp, stateDirName, 'beat'))) return path.join(leaseTmp, stateDirName);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    throw new Error('the watcher made no lease state dir');
  }

  function startBeating(run: LeasedRun, intervalMs: number): () => void {
    const timer = setInterval(() => run.write('h'), intervalMs);
    return () => clearInterval(timer);
  }

  beforeEach(() => {
    leaseTmp = path.join(workDir, 'tmp');
  });

  /** What the watchers left in the runner's `tmp` folder. */
  function listLeaseState(): string[] {
    return fs.existsSync(leaseTmp) ? fs.readdirSync(leaseTmp) : [];
  }

  it('a caller that keeps beating is never killed, however long the command runs — and the watcher leaves no state behind', async () => {
    const run = startLeasedRun(`sleep ${(leaseMs / 1000) * 2}; echo finished`);
    const stopBeating = startBeating(run, 300);
    const result = await run.finished;
    stopBeating();
    assert.equal(result.code, 0);
    assert.match(result.stdout, /finished/);
    assert.deepEqual(listLeaseState(), [], 'the lease state dir is removed');
  });

  it('a caller whose stream ends is gone: the command and what it started are killed at once', async () => {
    const pidFile = path.join(workRoot, 'ended.pid');
    const run = startLeasedRun(`sh -c 'echo $$ > ${pidFile}; sleep 60 & wait'`);
    const stopBeating = startBeating(run, 300);
    const pid = await readPidWhenWritten(pidFile);
    stopBeating();
    run.endStream();
    const result = await run.finished;
    assert.equal(result.code, killedByTermCode);
    assert.ok(result.elapsedMs < 30_000);
    assert.equal(checkIsProcessRunning(pid), false);
    assert.deepEqual(listLeaseState(), []);
  });

  it('a stream that stays open but goes silent (a frozen caller) is killed when the lease runs out — not before', async () => {
    const pidFile = path.join(workRoot, 'frozen.pid');
    const run = startLeasedRun(`sh -c 'echo $$ > ${pidFile}; sleep 60 & wait'`);
    const pid = await readPidWhenWritten(pidFile);
    const silentSince = Date.now();
    run.write('h');
    const result = await run.finished;
    assert.equal(result.code, killedByTermCode);
    assert.ok(Date.now() - silentSince >= leaseMs - 1000, `killed ${Date.now() - silentSince} ms after the last beat, before the ${leaseMs} ms lease`);
    assert.equal(checkIsProcessRunning(pid), false);
    run.endStream();
    assert.deepEqual(listLeaseState(), []);
  });

  it('a beat file caught empty (a writer between truncating and writing) neither ends the watcher nor blinds it: the verdict still comes when the stream ends', async () => {
    // The watcher alone, sourced: an arithmetic syntax error on an empty operand aborts the whole shell it runs in, which once ended the
    // watcher of a real run without a verdict — the job it was guarding then ran on for hours.
    const child = spawn('bash', ['-c', `source ${scriptPath}; work=${workDir}; exec 3<&0; watch_lease 30; echo "verdict=$?"`], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (text: string) => { stdout += text; });
    const finished = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
    const stateDir = await waitForLeaseStateDir();
    const beatPath = path.join(stateDir, 'beat');
    // Held empty across several polls of the watcher (one a second).
    const holdEmpty = setInterval(() => fs.writeFileSync(beatPath, ''), 50);
    await new Promise((resolve) => setTimeout(resolve, 3500));
    clearInterval(holdEmpty);
    child.stdin.end();
    await finished;
    assert.match(stdout, /^verdict=1$/m, `the watcher reported the end of the stream (output: ${JSON.stringify(stdout)})`);
    assert.deepEqual(listLeaseState(), []);
  });

  it('`exec` ends its stderr with the command\'s own exit code, so a command that exits 255 can be told from ssh\'s own 255', async () => {
    for (const code of [255, 0, 3]) {
      const leased = startLeasedRun(`echo out; echo err >&2; exit ${code}`);
      leased.write('h');
      const result = await leased.finished;
      assert.equal(result.code, code, `the command's ${code} is the script's exit status`);
      assert.equal(result.stdout, 'out\n');
      assert.equal(result.stderr, `err\n\u001eremote-run-exit:${code}\n`, 'the marker is the last thing on stderr');
    }
  });

  it('commands that end at once leave no lease state: the watcher is told to stop before it has done anything', async () => {
    const quickRuns = 25;
    for (let run = 0; run < quickRuns; run += 1) {
      const leased = startLeasedRun('true');
      leased.write('h');
      const result = await leased.finished;
      assert.equal(result.code, 0);
    }
    assert.deepEqual(listLeaseState(), []);
  });

});

describe('prune keeps what a queued job still needs', () => {
  const dayMs = 24 * 60 * 60 * 1000;

  function writeStage(id: string, jobFiles: string[]): string {
    const stageDir = path.join(workDir, 'p', slug, 'stage', id);
    writeFile(stageDir, 'a.txt');
    const when = new Date(Date.now() - 2 * dayMs);
    fs.utimesSync(stageDir, when, when);
    for (const file of jobFiles) writeFile(path.join(workDir, 'p', slug, 'jobs', id), file, file === 'pid' ? `${process.pid}\n` : '1\n');
    return stageDir;
  }

  it('an old stage folder of a job that waits in Pueue (a task, no exit yet) is never removed — behind a busy group it can wait for days — while the stage of a finished or never-submitted job goes', () => {
    const queued = writeStage('box1-queued', ['task-id']);
    const running = writeStage('box1-runnin', ['task-id', 'pid']);
    const finished = writeStage('box1-finish', ['task-id', 'exit']);
    const neverSubmitted = writeStage('box1-nevsub', ['meta.json']);
    assert.equal(runScript(['prune', workDir]).status, 0);
    assert.equal(fs.existsSync(queued), true, 'a queued job keeps its stage');
    assert.equal(fs.existsSync(running), true);
    assert.equal(fs.existsSync(finished), false);
    assert.equal(fs.existsSync(neverSubmitted), false);
  });
});

describe('a job that had to be SIGKILLed is an ended job', () => {
  const dayMs = 24 * 60 * 60 * 1000;
  let decoy: ChildProcess | null = null;

  afterEach(() => {
    if (decoy?.pid !== undefined) {
      try {
        process.kill(-decoy.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    decoy = null;
  });

  /** A job that is running on a command that ignores SIGTERM: a process group of its own whose leader's pid is the job's. */
  function startStubbornJob(): { jobDir: string; pid: number } {
    const paths = getPaths();
    fs.mkdirSync(paths.jobDir, { recursive: true });
    decoy = spawn('sh', ['-c', 'trap "" TERM; sleep 100'], { detached: true, stdio: 'ignore' });
    const pid = decoy.pid ?? 0;
    writeFile(paths.jobDir, 'task-id', '1\n');
    writeFile(paths.jobDir, 'pid', `${pid}\n`);
    writeFile(paths.stage, 'a.txt');
    return { jobDir: paths.jobDir, pid };
  }

  /** Run runner.sh functions (it is sourceable) for the job, the way the lease script or the watchdog does. */
  function runFunctions(body: string): { status: number | null; stdout: string } {
    const result = spawnSync('bash', ['-c', `source ${scriptPath}; set_paths ${workDir} ${slug} ${jobId}; kill_grace_sec=1; ${body}`], {
      encoding: 'utf8',
      env: { ...process.env, PUEUE_BIN: '/nonexistent/pueue' },
      timeout: 60_000,
    });
    return { status: result.status, stdout: result.stdout };
  }

  it('`kill` of a command that ignores SIGTERM: after the grace time it is SIGKILLed AND recorded — exit 137, phase done, a finish time, its stage gone', async () => {
    const { jobDir, pid } = startStubbornJob();
    assert.equal(runFunctions('kill_job').status, 0);
    assert.equal(fs.readFileSync(path.join(jobDir, 'exit'), 'utf8').trim(), '137');
    assert.equal(fs.readFileSync(path.join(jobDir, 'phase'), 'utf8').trim(), 'done');
    assert.match(fs.readFileSync(path.join(jobDir, 'finished-at'), 'utf8').trim(), /^\d+$/);
    assert.equal(fs.existsSync(getPaths().stage), false);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(checkIsProcessRunning(pid), false, 'and it is really gone');
  });

  it('the time limit\'s SIGKILL records 124, not 137', () => {
    const { jobDir } = startStubbornJob();
    writeFile(jobDir, 'timeout', '');
    assert.equal(runFunctions('hard_kill_job 1').status, 0);
    assert.equal(fs.readFileSync(path.join(jobDir, 'exit'), 'utf8').trim(), '124');
  });

  it('a kill that is the caller\'s time limit running out is recorded as the limit — 124, "timed out" — not as a kill (137), on a running job and on one still queued', () => {
    const running = startStubbornJob();
    assert.equal(runFunctions('kill_job timeout').status, 0);
    assert.equal(fs.readFileSync(path.join(running.jobDir, 'exit'), 'utf8').trim(), '124');
    assert.equal(fs.existsSync(path.join(running.jobDir, 'timeout')), true, 'the limit\'s marker is what `status` reads');
    assert.equal(fs.existsSync(path.join(running.jobDir, 'killed')), false, 'and there is no kill marker beside it');
    // A queued one: no process yet, Pueue removes the task (stubbed here), and the record is written at once.
    const queuedDir = path.join(workDir, 'p', slug, 'jobs', 'box1-queued');
    writeFile(queuedDir, 'task-id', '2\n');
    const result = spawnSync('bash', ['-c', `source ${scriptPath}; set_paths ${workDir} ${slug} box1-queued; kill_grace_sec=1; pq() { return 0; }; kill_job timeout`], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(queuedDir, 'exit'), 'utf8').trim(), '124');
    assert.equal(fs.existsSync(path.join(queuedDir, 'killed')), false);
  });

  it('a plain kill still records 137 with the kill marker', () => {
    const { jobDir } = startStubbornJob();
    assert.equal(runFunctions('kill_job').status, 0);
    assert.equal(fs.readFileSync(path.join(jobDir, 'exit'), 'utf8').trim(), '137');
    assert.equal(fs.existsSync(path.join(jobDir, 'killed')), true);
    assert.equal(fs.existsSync(path.join(jobDir, 'timeout')), false);
  });

  it('`kill` of a job that had already finished says so with its code and kills nothing; of a job that never existed it refuses', () => {
    const paths = getPaths();
    writeFile(paths.jobDir, 'task-id', '7\n');
    writeFile(paths.jobDir, 'exit', '4\n');
    const finished = runScript(['kill', workDir, slug, jobId]);
    assert.equal(finished.status, 0, finished.stderr);
    assert.equal(finished.stdout.trim(), 'already-ended 4');
    assert.equal(fs.existsSync(path.join(paths.jobDir, 'killed')), false, 'no kill marker was put on a job that was over');
    assert.equal(fs.readFileSync(path.join(paths.jobDir, 'exit'), 'utf8').trim(), '4');
    const missing = runScript(['kill', workDir, slug, 'box1-neverx']);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /no such job: box1-neverx/);
  });

  it('an exit a job wrote itself is never overwritten by the kill record', () => {
    const { jobDir } = startStubbornJob();
    writeFile(jobDir, 'exit', '0\n');
    assert.equal(runFunctions('hard_kill_job 1').status, 0);
    assert.equal(fs.readFileSync(path.join(jobDir, 'exit'), 'utf8').trim(), '0');
  });

  it('prune also removes a job an EARLIER runner script SIGKILLed without recording it — a task, a process that is gone, no exit — after 3 days; one whose process runs, or that is queued, stays', () => {
    const deadPid = spawnSync('true').pid;
    const makeOld = (target: string): void => {
      const when = new Date(Date.now() - 4 * dayMs);
      fs.utimesSync(target, when, when);
    };
    const writeOldJob = (id: string, files: Record<string, string>): string => {
      const jobDir = path.join(workDir, 'p', slug, 'jobs', id);
      for (const [name, content] of Object.entries(files)) writeFile(jobDir, name, content);
      makeOld(jobDir);
      return jobDir;
    };
    const killedEarlier = writeOldJob('box1-killed', { 'task-id': '4\n', pid: `${deadPid}\n` });
    const running = writeOldJob('box1-runnin', { 'task-id': '5\n', pid: `${process.pid}\n` });
    const queued = writeOldJob('box1-queued', { 'task-id': '6\n' });
    assert.equal(runScript(['prune', workDir]).status, 0);
    assert.equal(fs.existsSync(killedEarlier), false, 'the SIGKILLed job is pruned');
    assert.equal(fs.existsSync(running), true);
    assert.equal(fs.existsSync(queued), true);
  });
});

describe('the number of a task Pueue has forgotten can belong to another job', () => {
  const blockingSleepSeconds = '31.17';
  /**
   * What the stub `pq wait` does: block in a CHILD process that is not the last thing the function runs. The real `pueue wait` is
   * a child of the subshell the script starts for `pq`; whether bash runs a last command in place of that subshell (it can in
   * 5.3, it does not in 5.2, the bash of Ubuntu 24.04 and so of the CI runner) is not something the script may depend on. The
   * trailing `:` keeps the child a child on every bash, so the test is the same on all of them.
   */
  const blockingPueueWaitStub = `sleep ${blockingSleepSeconds}; :`;

  /** Run runner.sh functions with a stub `pq` (the body of the stub is `stubBody`) and say how long it took; `input` is what the caller's stdin carries. */
  function runWithStub(stubBody: string, body: string, input?: string): { status: number | null; stdout: string; seconds: number } {
    const startedAt = Date.now();
    // The trap ends what the body started in the background (the log streamer loops until a file that a red run never writes).
    const result = spawnSync('bash', ['-c', `trap 'kill $(jobs -p) 2> /dev/null' EXIT TERM; source ${scriptPath}; pq() { ${stubBody}; }; ${body}`], { encoding: 'utf8', timeout: 25_000, input });
    return { status: result.status, stdout: result.stdout, seconds: (Date.now() - startedAt) / 1000 };
  }

  function writeEndedJob(id: string, files: Record<string, string> = {}): string {
    const jobDir = path.join(workDir, 'p', slug, 'jobs', id);
    for (const [name, content] of Object.entries({ 'task-id': '7\n', exit: '137\n', ...files })) writeFile(jobDir, name, content);
    return jobDir;
  }

  /** The stub's blocking `sleep` is the only process with this exact command line. */
  const countStubSleeps = (): number => {
    const listing = spawnSync('ps', ['-u', `${os.userInfo().uid}`, '-o', 'args='], { encoding: 'utf8' }).stdout;
    return listing.split('\n').filter((line) => line.trim() === `sleep ${blockingSleepSeconds}`).length;
  };

  it('`wait` of a job that already has its exit file returns at once, however long Pueue\'s wait on that number would take (it follows whoever holds the number now)', () => {
    writeEndedJob(jobId);
    const outcome = runWithStub(blockingPueueWaitStub, `cmd_wait ${workDir} ${slug} ${jobId}`);
    assert.equal(outcome.stdout.trim(), 'done');
    assert.ok(outcome.seconds < 8, `it took ${outcome.seconds} s: it waited for Pueue`);
    assert.equal(countStubSleeps(), 0, 'and no wait is left running');
  });

  it('a wait that is blocked on Pueue ends as soon as the exit file appears — and the Pueue wait it started is ended with it', () => {
    const jobDir = writeEndedJob(jobId, { exit: '' });
    fs.rmSync(path.join(jobDir, 'exit'));
    const outcome = runWithStub(blockingPueueWaitStub, `( sleep 1; echo 137 > ${jobDir}/exit ) & cmd_wait ${workDir} ${slug} ${jobId}`);
    assert.equal(outcome.stdout.trim(), 'done');
    assert.ok(outcome.seconds >= 0.8 && outcome.seconds < 8, `it took ${outcome.seconds} s`);
    assert.equal(countStubSleeps(), 0, 'the Pueue wait it started is gone');
  });

  it('the Pueue wait it starts never reads the caller\'s stdin — in a lease that is the heartbeat stream, which only the watcher may read', () => {
    const jobDir = writeEndedJob(jobId, { exit: '' });
    fs.rmSync(path.join(jobDir, 'exit'));
    const stdinSeenByPueueWait = path.join(workDir, 'stdin-seen-by-pueue-wait');
    // A job under job control (`set -m`) is NOT given /dev/null as stdin by bash; the stub drains whatever its stdin is.
    const outcome = runWithStub(`cat > ${stdinSeenByPueueWait}; ${blockingPueueWaitStub}`, `( sleep 1; echo 0 > ${jobDir}/exit ) & cmd_wait ${workDir} ${slug} ${jobId}`, 'a-heartbeat-byte');
    assert.equal(outcome.stdout.trim(), 'done');
    assert.equal(fs.readFileSync(stdinSeenByPueueWait, 'utf8'), '', 'the Pueue wait was handed /dev/null, not the caller\'s stream');
    assert.equal(countStubSleeps(), 0, 'and the Pueue wait it started is gone');
  });

  it('when Pueue\'s wait ends first (a job that runs and finishes) the wait ends with it, then waits for the exit file as before', () => {
    const jobDir = writeEndedJob(jobId, { exit: '' });
    fs.rmSync(path.join(jobDir, 'exit'));
    const outcome = runWithStub('sleep 0.4', `( sleep 1; echo 0 > ${jobDir}/exit ) & cmd_wait ${workDir} ${slug} ${jobId}`);
    assert.equal(outcome.stdout.trim(), 'done');
    assert.ok(outcome.seconds >= 0.9 && outcome.seconds < 8, `it took ${outcome.seconds} s: the exit file is still waited for after Pueue is done`);
  });

  it('`logs -f` of a job that already has its exit file ends at once too', () => {
    const jobDir = writeEndedJob(jobId, { log: 'line one\n' });
    const outcome = runWithStub(blockingPueueWaitStub, `cmd_follow ${workDir} ${slug} ${jobId} start`);
    assert.equal(outcome.status, 0);
    assert.equal(outcome.stdout, 'line one\n');
    assert.ok(outcome.seconds < 8, `it took ${outcome.seconds} s`);
    assert.equal(fs.existsSync(path.join(jobDir, 'drain-stop')), true);
  });

  it('`logs -f` that is blocked on Pueue ends as soon as the exit file appears, with the log to the end — and the Pueue wait it started is ended with it', () => {
    const jobDir = writeEndedJob(jobId, { exit: '', log: 'line one\n' });
    fs.rmSync(path.join(jobDir, 'exit'));
    const outcome = runWithStub(blockingPueueWaitStub, `( sleep 1; echo 'line two' >> ${jobDir}/log; echo 0 > ${jobDir}/exit ) & cmd_follow ${workDir} ${slug} ${jobId} start`);
    assert.equal(outcome.status, 0);
    assert.equal(outcome.stdout, 'line one\nline two\n');
    assert.ok(outcome.seconds >= 0.8 && outcome.seconds < 8, `it took ${outcome.seconds} s`);
    assert.equal(countStubSleeps(), 0, 'the Pueue wait it started is gone');
  });

  it('a job killed while queued is marked as having lost its task, because Pueue may give the number to the next job', () => {
    const queuedDir = path.join(workDir, 'p', slug, 'jobs', jobId);
    writeFile(queuedDir, 'task-id', '7\n');
    const outcome = runWithStub('return 0', `set_paths ${workDir} ${slug} ${jobId}; kill_grace_sec=1; kill_job`);
    assert.equal(outcome.status, 0);
    assert.equal(fs.existsSync(path.join(queuedDir, 'task-removed')), true);
    assert.equal(fs.readFileSync(path.join(queuedDir, 'exit'), 'utf8').trim(), '137');
  });

  describe('prune removes a Pueue task only when it is the job\'s own', () => {
    const dayMs = 24 * 60 * 60 * 1000;
    /** Prune the old ended job `id`; `statusJson` is what the stub `pueue status` answers; returns the calls the stub saw and whether the folder is gone. */
    function prune(id: string, files: Record<string, string>, statusJson: string): { calls: string[]; folderGone: boolean } {
      const jobDir = writeEndedJob(id, files);
      const old = new Date(Date.now() - 4 * dayMs);
      fs.utimesSync(jobDir, old, old);
      const callsFile = path.join(workRoot, `calls-${id}.log`);
      const stub = `printf '%s\\n' "$*" >> ${callsFile}; if [ "$1" = status ]; then printf '%s' '${statusJson}'; fi; return 0`;
      const outcome = runWithStub(stub, `prune_work ${workDir}`);
      assert.equal(outcome.status, 0);
      return { calls: fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').trim().split('\n') : [], folderGone: !fs.existsSync(jobDir) };
    }

    it('a task that carries the job\'s own label is removed, and the folder with it', () => {
      const outcome = prune('box1-ownone', {}, '{"tasks":{"7":{"id":7,"label":"rr-box1-ownone","command":"x"}},"groups":{}}');
      assert.deepEqual(outcome.calls, ['status --json label=rr-box1-ownone', 'remove 7']);
      assert.equal(outcome.folderGone, true);
    });

    it('a number that Pueue no longer has, or that another job holds, is left alone — the old folder still goes', () => {
      const none = prune('box1-gonenx', {}, '{"tasks":{},"groups":{}}');
      assert.deepEqual(none.calls, ['status --json label=rr-box1-gonenx']);
      assert.equal(none.folderGone, true);
      const reused = prune('box1-reusdx', {}, '{"tasks":{"9":{"id":9,"label":"rr-box1-other1","command":"x"}},"groups":{}}');
      assert.deepEqual(reused.calls, ['status --json label=rr-box1-reusdx'], 'task 7 was not removed: the only task answered is another number');
      assert.equal(reused.folderGone, true);
    });

    it('a job whose task was removed when it was killed is not even asked about: its number is not its own any more', () => {
      const outcome = prune('box1-killdq', { 'task-removed': '' }, '{"tasks":{"7":{"id":7,"label":"rr-box1-killdq","command":"x"}},"groups":{}}');
      assert.deepEqual(outcome.calls, [], 'Pueue was not asked anything');
      assert.equal(outcome.folderGone, true);
    });
  });
});

describe('collecting the result files (collect_artifacts)', () => {
  const findLogName = 'find-calls.log';
  let binDir = '';

  /** Run `collect_artifacts` for the job, with a `find` in front of the real one that writes down what it was asked to walk. */
  function collect(): { status: number | null; stderr: string; walked: string } {
    const result = spawnSync('bash', ['-c', `source ${scriptPath}; set_paths ${workDir} ${slug} ${jobId}; collect_artifacts`], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
      timeout: 60_000,
    });
    const logPath = path.join(binDir, findLogName);
    return { status: result.status, stderr: result.stderr, walked: fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '' };
  }

  function listArtifacts(): string[] {
    const root = path.join(getPaths().jobDir, 'artifacts');
    const found: string[] = [];
    const visit = (directory: string): void => {
      if (!fs.existsSync(directory)) return;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(entryPath);
        else found.push(path.relative(root, entryPath));
      }
    };
    visit(root);
    return found.sort();
  }

  beforeEach(() => {
    binDir = path.join(workRoot, 'bin');
    fs.mkdirSync(binDir);
    const realFind = spawnSync('which', ['find'], { encoding: 'utf8' }).stdout.trim();
    fs.writeFileSync(path.join(binDir, 'find'), `#!/bin/bash\nprintf '%s\\n' "$*" >> ${path.join(binDir, findLogName)}\nexec ${realFind} "$@"\n`, { mode: 0o755 });
    const paths = getPaths();
    fs.mkdirSync(paths.jobDir, { recursive: true });
    fs.mkdirSync(paths.tree, { recursive: true });
    fs.writeFileSync(path.join(paths.jobDir, 'start-marker'), '');
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(paths.jobDir, 'start-marker'), past, past);
    writeFile(paths.tree, 'test-results/snap.txt', 'snapshot');
    writeFile(paths.tree, 'e2e/artifacts/shot.png', 'png');
    writeFile(paths.tree, 'node_modules/pkg/deep/in.txt', 'not wanted');
    writeFile(paths.tree, 'build/out/app.apk', 'apk');
  });

  it('walks only the fixed folders of the patterns — never the rest of the copy (node_modules, build folders) — and brings back what matches', () => {
    const paths = getPaths();
    writeFile(paths.jobDir, 'pull.ere', '^test-results(/.*)?$\n^e2e/artifacts(/.*)?$\n');
    writeFile(paths.jobDir, 'pull.roots', 'test-results\ne2e/artifacts\n');
    const outcome = collect();
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.deepEqual(listArtifacts(), ['e2e/artifacts/shot.png', 'test-results/snap.txt']);
    assert.equal(outcome.walked.trim().split('\n').length, 1, 'one walk');
    assert.match(outcome.walked, /^test-results e2e\/artifacts -name \.git -prune/);
    assert.ok(!/(^| )\.( |$)/.test(outcome.walked), 'and never the whole copy');
  });

  it('what the roots leave out is not looked at, whatever the patterns would say', () => {
    const paths = getPaths();
    writeFile(paths.jobDir, 'pull.ere', '^(test-results|build)(/.*)?$\n');
    writeFile(paths.jobDir, 'pull.roots', 'test-results\n');
    assert.equal(collect().status, 0);
    assert.deepEqual(listArtifacts(), ['test-results/snap.txt'], 'build/ matches a pattern but is outside the walked roots');
  });

  it('a pattern that starts with a wildcard (root `.`) walks the whole copy; so does a job from an older main box that sent no roots', () => {
    const paths = getPaths();
    writeFile(paths.jobDir, 'pull.ere', '^(.*/)?app\\.apk$\n');
    writeFile(paths.jobDir, 'pull.roots', '.\n');
    assert.equal(collect().status, 0);
    assert.deepEqual(listArtifacts(), ['build/out/app.apk']);
    fs.rmSync(path.join(paths.jobDir, 'artifacts'), { recursive: true, force: true });
    fs.rmSync(path.join(paths.jobDir, 'pull.roots'));
    fs.rmSync(path.join(binDir, findLogName), { force: true });
    assert.equal(collect().status, 0);
    assert.deepEqual(listArtifacts(), ['build/out/app.apk']);
    assert.match(collect().walked, /^\. -name \.git -prune/m);
  });

  it('a root that does not exist, or is a symlink out of the copy, or is reached through one, is skipped — a link is never followed', () => {
    const paths = getPaths();
    const outside = path.join(workRoot, 'outside');
    writeFile(outside, 'artifacts/secret.txt', 'outside the copy');
    fs.symlinkSync(outside, path.join(paths.tree, 'linked'));
    fs.symlinkSync(path.join(outside, 'artifacts'), path.join(paths.tree, 'direct'));
    writeFile(paths.jobDir, 'pull.ere', '^(linked|direct|missing|test-results)(/.*)?$\n');
    writeFile(paths.jobDir, 'pull.roots', 'linked/artifacts\ndirect\nmissing\ntest-results\n');
    const outcome = collect();
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.deepEqual(listArtifacts(), ['test-results/snap.txt']);
    assert.ok(!outcome.walked.includes('linked') && !outcome.walked.includes('direct') && !outcome.walked.includes('missing'), outcome.walked);
  });

  it('a root that is a single file is collected too, and a root with ".." is refused', () => {
    const paths = getPaths();
    writeFile(paths.jobDir, 'pull.ere', '^test-results/snap\\.txt(/.*)?$\n');
    writeFile(paths.jobDir, 'pull.roots', 'test-results/snap.txt\n../outside\n');
    assert.equal(collect().status, 0);
    assert.deepEqual(listArtifacts(), ['test-results/snap.txt']);
  });

  it('with no root left to walk nothing is walked at all', () => {
    const paths = getPaths();
    writeFile(paths.jobDir, 'pull.ere', '^missing(/.*)?$\n');
    writeFile(paths.jobDir, 'pull.roots', 'missing\n');
    const outcome = collect();
    assert.equal(outcome.status, 0);
    assert.equal(outcome.walked, '');
    assert.deepEqual(listArtifacts(), []);
  });
});

describe('the time limit counts from the moment the job was queued', () => {
  const pollMs = 100;

  /** A job folder as `prepare` + `submit` leave it, ready for `runner.sh job` to run directly (as Pueue would). */
  function prepareJobToRun(options: { command: string; timeoutSec: number; queuedSecondsAgo: number }): { jobDir: string; ran: string } {
    const paths = getPaths();
    const ran = path.join(workRoot, 'command-ran');
    fs.mkdirSync(paths.stage, { recursive: true });
    writeFile(paths.stage, 'a.txt');
    fs.mkdirSync(paths.jobDir, { recursive: true });
    writeFile(paths.jobDir, 'manifest', 'a.txt\n');
    writeFile(paths.jobDir, 'subfolder', '');
    writeFile(paths.jobDir, 'cmd', options.command.replace('{ran}', ran));
    writeFile(paths.jobDir, 'timeout-sec', `${options.timeoutSec}`);
    writeFile(paths.jobDir, 'task-id', '1\n');
    writeFile(paths.jobDir, 'queued-at', `${Math.floor(Date.now() / 1000) - options.queuedSecondsAgo}\n`);
    return { jobDir: paths.jobDir, ran };
  }

  /** `runner.sh job` as Pueue starts it: a process group of its own. Resolves with the exit file's content and the time it took. */
  async function runJobUntilItEnds(jobDir: string, giveUpMs: number): Promise<{ exit: string; elapsedMs: number }> {
    const startedAt = Date.now();
    const child = spawn('bash', [scriptPath, 'job', workDir, slug, jobId], { detached: true, stdio: 'ignore', env: { ...process.env, PUEUE_BIN: '/nonexistent/pueue' } });
    try {
      while (Date.now() - startedAt < giveUpMs) {
        if (fs.existsSync(path.join(jobDir, 'exit'))) return { exit: fs.readFileSync(path.join(jobDir, 'exit'), 'utf8').trim(), elapsedMs: Date.now() - startedAt };
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
      return { exit: 'still running', elapsedMs: Date.now() - startedAt };
    } finally {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* ended */
        }
      }
    }
  }

  it('a job that waited its whole limit in the queue is over when it starts: 124 at once, its command never runs', async () => {
    const { jobDir, ran } = prepareJobToRun({ command: 'touch {ran}', timeoutSec: 60, queuedSecondsAgo: 120 });
    const result = await runJobUntilItEnds(jobDir, 30_000);
    assert.equal(result.exit, '124');
    assert.equal(fs.existsSync(ran), false, 'the command was not started');
    assert.match(fs.readFileSync(path.join(jobDir, 'log'), 'utf8'), /remote-run: its time limit ran out while it was queued/);
    assert.equal(fs.existsSync(path.join(jobDir, 'timeout')), true);
  });

  it('a job that waited part of its limit gets the rest, not the whole limit again', { skip: rsyncSkip }, async () => {
    const { jobDir } = prepareJobToRun({ command: 'sleep 120', timeoutSec: 40, queuedSecondsAgo: 36 });
    const result = await runJobUntilItEnds(jobDir, 25_000);
    assert.equal(result.exit, '124', 'cut off after the rest of the limit (about 4 s), not after another 40 s');
    assert.ok(result.elapsedMs < 25_000, `${result.elapsedMs} ms`);
  });
});

describe('the probe fits its 20 s however many of its questions hang', () => {
  const stepLimitSec = 4;
  let fakeBin = '';

  function writeFake(name: string, body: string): void {
    const target = path.join(fakeBin, name);
    fs.writeFileSync(target, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }

  /** `probe_slow` of a Mac whose tools are the fakes in `fakeBin`, run as a sourced function; returns its lines and how long it took. */
  function probeSlowOfAMac(): { lines: Record<string, string>; elapsedSec: number } {
    const result = spawnSync('bash', ['-c', `source ${scriptPath}; uname() { echo Darwin; }; work=${workDir}; start=$SECONDS; probe_slow; echo "elapsed=$((SECONDS - start))"`], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, PUEUE_BIN: path.join(fakeBin, 'pueue') },
      timeout: 60_000,
    });
    const lines: Record<string, string> = {};
    for (const line of result.stdout.split('\n')) {
      const separator = line.indexOf('=');
      if (separator > 0) lines[line.slice(0, separator)] = line.slice(separator + 1);
    }
    return { lines, elapsedSec: Number(lines.elapsed) };
  }

  beforeEach(() => {
    fakeBin = path.join(workRoot, 'fake-bin');
    fs.mkdirSync(fakeBin);
  });

  it('Xcode, the simulators, Docker and Pueue all hanging cost one step limit in all — not one each — and say so, instead of "not found"', () => {
    for (const hanging of ['xcodebuild', 'xcrun', 'docker', 'pueue']) writeFake(hanging, 'exec sleep 120');
    const { lines, elapsedSec } = probeSlowOfAMac();
    assert.ok(elapsedSec <= stepLimitSec + 3, `${elapsedSec} s: the questions were asked one after the other (four of them would take ${4 * stepLimitSec} s)`);
    assert.equal(lines.cap_ios, 'no');
    assert.equal(lines.cap_ios_detail, 'Xcode did not answer in time');
    assert.equal(lines.cap_docker, 'no');
    assert.equal(lines.pueue, 'missing');
    assert.ok(Number(lines.disk_free_mb) > 0, 'the answers that did come are reported');
  });

  it('a slow simctl does not turn a working Xcode into "no Xcode", nor invent a simulator count', () => {
    writeFake('xcodebuild', 'echo "Xcode 16.2"; echo "Build version 16C5032a"');
    writeFake('xcrun', 'exec sleep 120');
    writeFake('pueue', 'echo "pueue 4.0.4"');
    const { lines, elapsedSec } = probeSlowOfAMac();
    assert.ok(elapsedSec <= stepLimitSec + 3, `${elapsedSec} s`);
    assert.equal(lines.cap_ios, 'yes');
    assert.equal(lines.cap_ios_detail, 'Xcode 16.2');
    assert.equal(lines.pueue, '4.0.4');
  });

  it('everything answering: the Xcode version with the simulators it lists, Docker up, Pueue\'s version', () => {
    writeFake('xcodebuild', 'echo "Xcode 16.2"');
    writeFake('xcrun', 'printf "    iPhone 16 (AAAA) (Shutdown)\\n    iPhone 16 Pro (BBBB) (Booted)\\n"');
    writeFake('docker', 'echo ok');
    writeFake('pueue', 'echo "pueue 4.0.4"');
    const { lines, elapsedSec } = probeSlowOfAMac();
    assert.ok(elapsedSec <= 3, `${elapsedSec} s`);
    assert.equal(lines.cap_ios, 'yes');
    assert.equal(lines.cap_ios_detail, 'Xcode 16.2, 2 simulators');
    assert.equal(lines.cap_docker, 'yes');
  });

  it('an Xcode that is not there is "not found" (not "did not answer"), and the probe leaves no scratch state behind', () => {
    writeFake('xcodebuild', 'exit 127');
    const { lines } = probeSlowOfAMac();
    assert.equal(lines.cap_ios, 'no');
    assert.equal(lines.cap_ios_detail, 'Xcode not found');
    assert.deepEqual(fs.readdirSync(path.join(workDir, 'tmp')), [], 'the probe\'s scratch folder is removed');
  });
});

describe('reading a job folder', () => {
  function writeJob(id: string, exitCode: string | null): void {
    const jobDir = path.join(workDir, 'p', slug, 'jobs', id);
    writeFile(jobDir, 'meta.json', JSON.stringify({ id, runner: 'box1' }));
    writeFile(jobDir, 'log', 'line 1\nline 2\nline 3\n');
    writeFile(jobDir, 'phase', 'done\n');
    writeFile(jobDir, 'task-id', '4\n');
    if (exitCode !== null) writeFile(jobDir, 'exit', `${exitCode}\n`);
  }

  it('`jobs` is one JSON array with each job\'s facts and meta, filtered by project when asked', () => {
    writeJob('box1-aaaaaa', '0');
    writeJob('box1-bbbbbb', null);
    writeFile(workDir, 'p/other-project/jobs/box1-cccccc/meta.json', JSON.stringify({ id: 'box1-cccccc' }));
    const all: Array<{ id: string; facts: string; meta: { id: string } }> = JSON.parse(runScript(['jobs', workDir]).stdout);
    assert.deepEqual(all.map((entry) => entry.id).sort(), ['box1-aaaaaa', 'box1-bbbbbb', 'box1-cccccc']);
    const ofProject: Array<{ id: string; facts: string }> = JSON.parse(runScript(['jobs', workDir, slug]).stdout);
    assert.deepEqual(ofProject.map((entry) => entry.id).sort(), ['box1-aaaaaa', 'box1-bbbbbb']);
    const finished = ofProject.find((entry) => entry.id === 'box1-aaaaaa');
    assert.equal(parseJobFacts((finished?.facts ?? '').replace(/;/g, '\n')).exit, 0);
    assert.equal(parseJobFacts((ofProject.find((entry) => entry.id === 'box1-bbbbbb')?.facts ?? '').replace(/;/g, '\n')).exit, null);
  });

  it('`jobs` of a runner with no jobs is an empty array', () => {
    assert.deepEqual(JSON.parse(runScript(['jobs', workDir]).stdout), []);
  });

  it('`result`, `meta` and `tail` answer by job id alone (the slug is "-")', () => {
    writeJob('box1-aaaaaa', '3');
    const facts = parseJobFacts(runScript(['result', workDir, '-', 'box1-aaaaaa']).stdout);
    assert.equal(facts.exit, 3);
    assert.equal(facts.slug, slug);
    assert.equal(facts.taskId, 4);
    assert.deepEqual(JSON.parse(runScript(['meta', workDir, '-', 'box1-aaaaaa']).stdout), { id: 'box1-aaaaaa', runner: 'box1' });
    assert.equal(runScript(['tail', workDir, '-', 'box1-aaaaaa', '2']).stdout, 'line 2\nline 3\n');
    assert.equal(runScript(['tail', workDir, '-', 'box1-aaaaaa', 'all']).stdout, 'line 1\nline 2\nline 3\n');
  });

  it('`workdir` creates the folder and prints it absolute', () => {
    const relativeToWork = path.join(workDir, 'new', '..', 'fresh');
    const result = runScript(['workdir', relativeToWork]);
    assert.equal(result.stdout.trim(), path.join(workDir, 'fresh'));
    assert.ok(fs.statSync(path.join(workDir, 'fresh')).isDirectory());
  });
});

describe('what the probe says of a paired runner (its state folder is the parent of the work dir)', () => {
  /** Make `workRoot` look like the state folder of a charness-runner: `config.json` and `keys/` beside `work/`. */
  function makeStateFolder(): void {
    writeFile(workRoot, 'config.json', '{}');
    fs.mkdirSync(path.join(workRoot, 'keys'));
  }

  function probe(): { text: string; parsed: ReturnType<typeof parseProbeOutput> } {
    const result = runScript(['probe', workDir]);
    assert.equal(result.status, 0, result.stderr);
    return { text: result.stdout, parsed: parseProbeOutput(result.stdout) };
  }

  it('a hand-made runner (no state folder around its work dir) prints none of it', () => {
    const { text } = probe();
    assert.ok(!/^(paused|service|runner_version|ios_boot)/m.test(text), text);
  });

  it('a work dir that is merely called work, beside a config.json but no keys/, is not a runner state folder', () => {
    writeFile(workRoot, 'config.json', '{}');
    assert.ok(!/^paused=/m.test(probe().text));
    fs.rmSync(path.join(workRoot, 'config.json'));
    fs.mkdirSync(path.join(workRoot, 'keys'));
    assert.ok(!/^paused=/m.test(probe().text));
  });

  it('a runner nobody paused and nobody installed as a service is running by hand', () => {
    makeStateFolder();
    const { parsed } = probe();
    assert.deepEqual([parsed.isPaused, parsed.serviceKind, parsed.iosBoot, parsed.runnerVersion], [false, 'foreground', null, null]);
  });

  it('the paused flag is a file: present = paused', () => {
    makeStateFolder();
    writeFile(workRoot, 'paused', '');
    assert.equal(probe().parsed.isPaused, true);
    fs.rmSync(path.join(workRoot, 'paused'));
    assert.equal(probe().parsed.isPaused, false);
  });

  it('the service file names how it is kept running: user or system service; a word nobody knows is "unknown", not "run by hand"', () => {
    makeStateFolder();
    for (const [word, expected] of [['user-service', 'user-service'], ['system-service\n', 'system-service'], ['launchd-magic', 'unknown']] as const) {
      writeFile(workRoot, 'service', word);
      assert.equal(probe().text.match(/^service=(.*)$/m)?.[1], expected, word);
    }
  });

  it('the charness version is the one in the installed package (`current/package.json`)', () => {
    makeStateFolder();
    writeFile(path.join(workRoot, 'current'), 'package.json', '{\n  "name": "charness",\n  "version": "3.8.0",\n  "scripts": {}\n}\n');
    assert.equal(probe().parsed.runnerVersion, '3.8.0');
  });

  it('the iOS boot check file: bootable, not bootable (with its detail), or unreadable', () => {
    makeStateFolder();
    // The exact line `writeIosCheck` writes (iosCheck.ts), so the two sides of the file cannot drift apart again.
    writeFile(workRoot, 'ios-check.json', '{"status":"pass","checkedAtMs":1,"xcode":"16.2 (16C5032a)","reason":null}\n');
    assert.deepEqual(probe().parsed.iosBoot, { status: 'ok', detail: '' });
    writeFile(workRoot, 'ios-check.json', '{"status":"fail","checkedAtMs":1,"xcode":"16.2 (16C5032a)","reason":"the Simulator did not boot: no login session"}\n');
    assert.deepEqual(probe().parsed.iosBoot, { status: 'failed', detail: 'the Simulator did not boot: no login session' });
    writeFile(workRoot, 'ios-check.json', '{"status":"skipped","checkedAtMs":1,"xcode":null,"reason":null}\n');
    assert.deepEqual(probe().parsed.iosBoot, { status: 'unchecked', detail: '' });
    writeFile(workRoot, 'ios-check.json', 'garbage');
    assert.deepEqual(probe().parsed.iosBoot, { status: 'unchecked', detail: '' });
  });
});

describe('a Mac (the platform is faked, with fake Xcode and caffeinate)', () => {
  let fakeBin = '';
  let caffeinateLog = '';

  function writeFake(name: string, body: string): void {
    fs.writeFileSync(path.join(fakeBin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }

  /** Bash sourcing the script with `uname` saying Darwin, running `commands`; the fakes are first on the PATH. */
  function runAsAMac(commands: string): { stdout: string; stderr: string } {
    const result = spawnSync('bash', ['-c', `source ${scriptPath}; uname() { echo Darwin; }; work=${workDir}; ${commands}`], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, PUEUE_BIN: path.join(fakeBin, 'pueue'), CAFFEINATE_LOG: caffeinateLog },
      timeout: 60_000,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  }

  function readLines(text: string): Record<string, string> {
    const lines: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const separator = line.indexOf('=');
      if (separator > 0) lines[line.slice(0, separator)] = line.slice(separator + 1);
    }
    return lines;
  }

  beforeEach(() => {
    fakeBin = path.join(workRoot, 'fake-bin');
    fs.mkdirSync(fakeBin);
    caffeinateLog = path.join(workRoot, 'caffeinate.log');
    writeFake('caffeinate', 'echo "$@" >> "$CAFFEINATE_LOG"');
    writeFake('xcodebuild', 'echo "Xcode 16.2"');
    writeFake('xcrun', 'printf "    iPhone 16 (AAAA) (Shutdown)\\n"');
    writeFake('pueue', 'echo "pueue 4.0.4"');
  });

  it('iOS: Xcode is there and the runner\'s service booted a Simulator — yes, with the Xcode version and the simulators', () => {
    writeFile(workRoot, 'config.json', '{}');
    fs.mkdirSync(path.join(workRoot, 'keys'));
    writeFile(workRoot, 'ios-check.json', '{"status":"pass","checkedAtMs":1,"xcode":"16.2 (16C5032a)","reason":null}\n');
    const lines = readLines(runAsAMac('read_runner_state; probe_slow').stdout);
    assert.equal(lines.cap_ios, 'yes');
    assert.equal(lines.cap_ios_detail, 'Xcode 16.2, 1 simulators');
  });

  it('iOS: Xcode is there but the service could not boot a Simulator — no, and the reason is the login session (the plan\'s owner choice A)', () => {
    writeFile(workRoot, 'config.json', '{}');
    fs.mkdirSync(path.join(workRoot, 'keys'));
    writeFile(workRoot, 'ios-check.json', `{"status":"fail","checkedAtMs":1,"xcode":"16.2 (16C5032a)","reason":"${iosBootFailureReasonPrefix} boot: CoreSimulator is not available to a daemon"}\n`);
    const lines = readLines(runAsAMac('read_runner_state; probe_slow').stdout);
    assert.equal(lines.cap_ios, 'no');
    assert.equal(lines.cap_ios_detail, "needs the runner user's login session");
  });

  it('iOS: a PAIRED runner with no record yet is still being checked — no, not yes: the answer of an earlier start must not be offered meanwhile', () => {
    writeFile(workRoot, 'config.json', '{}');
    fs.mkdirSync(path.join(workRoot, 'keys'));
    const lines = readLines(runAsAMac('read_runner_state; probe_runner_state; probe_slow').stdout);
    assert.equal(lines.cap_ios, 'no');
    assert.equal(lines.cap_ios_detail, 'the iOS Simulator is being checked');
    assert.equal(lines.paused, 'no', 'the runner state IS read, so this probe reaches probe_runner_state\'s output');
    assert.equal(lines.ios_boot, undefined, 'and no answer is reported as the check\'s');
  });

  it('iOS: a check that failed for another reason shows THAT reason — a login session would be the wrong cure for a missing runtime', () => {
    writeFile(workRoot, 'config.json', '{}');
    fs.mkdirSync(path.join(workRoot, 'keys'));
    writeFile(workRoot, 'ios-check.json', '{"status":"fail","checkedAtMs":1,"xcode":"16.2 (16C5032a)","reason":"no iOS simulator runtime and iPhone device type are installed"}\n');
    const lines = readLines(runAsAMac('read_runner_state; probe_slow').stdout);
    assert.equal(lines.cap_ios, 'no');
    assert.equal(lines.cap_ios_detail, 'the iOS Simulator check failed: no iOS simulator runtime and iPhone device type are installed');
    writeFile(workRoot, 'ios-check.json', '{"status":"fail","checkedAtMs":1,"xcode":null,"reason":null}\n');
    assert.equal(readLines(runAsAMac('read_runner_state; probe_slow').stdout).cap_ios_detail, 'the iOS Simulator check failed');
  });

  it('the script and the utility agree on which failures are the boot refusal: the script carries the very prefix the check writes', () => {
    assert.ok(fs.readFileSync(scriptPath, 'utf8').includes(`"${iosBootFailureReasonPrefix}"*)`));
  });

  it('iOS: a runner with no boot check (a hand-made one, or one run in a terminal) keeps the answer Xcode gives', () => {
    const lines = readLines(runAsAMac('read_runner_state; probe_slow').stdout);
    assert.equal(lines.cap_ios, 'yes');
  });

  /** What the fake caffeinate was asked, once it has written it (it is started in the background and may outlive the script by a moment). */
  async function readCaffeinateLog(): Promise<string> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (fs.existsSync(caffeinateLog) && fs.readFileSync(caffeinateLog, 'utf8').endsWith('\n')) return fs.readFileSync(caffeinateLog, 'utf8');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('the fake caffeinate was never called');
  }

  it('a job\'s command runs with caffeinate holding the Mac awake for its process — and keeps its own exit code', async () => {
    fs.mkdirSync(path.join(workRoot, 'jd'));
    const { stdout } = runAsAMac(`jd=${workRoot}/jd; run_step ${workRoot} 'exit 3'; wait; echo "code=$step_code"`);
    assert.equal(readLines(stdout).code, '3');
    assert.match(await readCaffeinateLog(), /^-i -w \d+\n$/);
  });

  it('`exec` holds the Mac awake the same way', async () => {
    fs.mkdirSync(path.join(workDir, 'p', slug, 'tree'), { recursive: true });
    writeFake('uname', 'echo Darwin');
    spawnSync('bash', [scriptPath, 'exec', workDir, slug, '', '3000', 'true'], {
      encoding: 'utf8',
      input: '',
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, CAFFEINATE_LOG: caffeinateLog },
      timeout: 60_000,
    });
    assert.match(await readCaffeinateLog(), /^-i -w \d+\n$/);
  });

  // On a real Mac the system's own caffeinate would be found (and hold the test shell): the case is for the machines CI and the dev box are.
  it('nothing on a system that is not a Mac, and nothing breaks where caffeinate is missing', { skip: process.platform === 'darwin' ? 'this Mac has a real caffeinate' : false }, () => {
    const notAMac = spawnSync('bash', ['-c', `source ${scriptPath}; fake_pid=$$; keep_awake_while "$fake_pid"; wait; echo done`], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, CAFFEINATE_LOG: caffeinateLog },
      timeout: 60_000,
    });
    assert.equal(notAMac.stdout.trim(), 'done');
    assert.equal(fs.existsSync(caffeinateLog), false, 'caffeinate was not started off a Mac');
    fs.rmSync(path.join(fakeBin, 'caffeinate'));
    const missing = runAsAMac('keep_awake_while $$; wait; echo done');
    assert.equal(missing.stdout.trim().endsWith('done'), true, missing.stderr);
  });
});
