/**
 * @description `remoteRun/runner.sh` — the script that runs on a runner — as far as it can be tested without Pueue and ssh (the flow
 * `remoteRunE2e.test.ts` runs the rest): it parses and uses nothing newer than bash 3.2 (the stock bash of macOS); `probe` prints what
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
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseProbeOutput } from '../remoteRun/probe';
import { parseJobFacts } from '../remoteRun/jobState';
import { checkIsProcessRunning } from './e2e/isolatedCharness';

const scriptPath = path.resolve(__dirname, '..', '..', 'remoteRun', 'runner.sh');
const isCi = process.env.CI === 'true' || process.env.CI === '1';
const hasRsync = spawnSync('rsync', ['--version'], { stdio: 'ignore' }).status === 0;
const rsyncSkip = !hasRsync && !isCi ? 'rsync is not installed here (CI installs it)' : false;

const slug = 'app-abc1234567';
const jobId = 'box1-aaaaaa';

let workRoot = '';
let workDir = '';

function runScript(args: string[], env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('bash', [scriptPath, ...args], { encoding: 'utf8', env: { ...process.env, PUEUE_BIN: '/nonexistent/pueue', ...env }, timeout: 60_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function writeFile(root: string, relativePath: string, content = 'x'): void {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
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
    for (const file of files) writeFile(jobDir, file, '1\n');
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
    finished: Promise<{ code: number | null; stdout: string; elapsedMs: number }>;
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
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (text: string) => { stdout += text; });
    child.stdin.on('error', () => { /* the run ended before the write */ });
    const finished = new Promise<{ code: number | null; stdout: string; elapsedMs: number }>((resolve) => {
      child.on('close', (code) => resolve({ code, stdout, elapsedMs: Date.now() - startedAt }));
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

  it('a caller whose stream ends without saying "done" is gone: the command and what it started are killed at once', async () => {
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

  it('"d" then the end of the stream is a goodbye, not a death: the command is left to finish', async () => {
    const run = startLeasedRun('sleep 2; echo finished-after-goodbye');
    run.write('h');
    run.write('d');
    run.endStream();
    const result = await run.finished;
    assert.equal(result.code, 0);
    assert.match(result.stdout, /finished-after-goodbye/);
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
