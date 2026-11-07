/**
 * @description `remoteRun/runner.sh` — the disk upkeep of a runner, run against the real script and a real shell: project copies unused for days go; while the work disk is short of free space
 * the least recently used copy goes first, one by one, until the target is met — never a copy in use (a lock held by a live job, a queued, running or just-submitted job) nor the copy of the
 * job being submitted; a copy with read-only folders is removed too; a submit on a disk that stays short is refused with the biggest copies named; `measure-copies` writes the sizes `probe` sums.
 * Also the races the review of the first version found: a running `exec`, results about to be fetched, a copy that gets busy between the check and the rename, a slow upload, two prunes at once,
 * a refusal that must not measure, and a disk whose free figure does not follow the removals (APFS snapshots).
 * The disk and the sizes are faked by a `df` and a `du` on the PATH that read a `fake-kb` file in each copy, so a removal really frees "space" and everything else (find, mv, chmod, rm, ls) is real.
 * In a file of its own, as a file runs under one time limit.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { diskTooLowRunnerExitCode } from '../remoteRun/pruneReport';
import { parseProbeOutput } from '../remoteRun/probe';
import { jobId, scriptPath, slug, writeFile } from './remoteRunRunnerScriptKit';

const kibPerGib = 1024 * 1024;
const dayMs = 24 * 60 * 60 * 1000;
const hourMs = 60 * 60 * 1000;
const fakeDiskGib = 100;

let workRoot = '';
let workDir = '';
let fakeBinDir = '';

/** `df -Pk` of a disk whose used space is the sum of the `fake-kb` files of the copies (and of copies being removed); `du -sk` of a copy is its `fake-kb`. */
const fakeDf = `#!/bin/bash
used=0
for marker in "$FAKE_WORK"/p/*/fake-kb "$FAKE_WORK"/p/.trash-*/fake-kb; do
  [ -f "$marker" ] && used=$((used + $(cat "$marker")))
done
total=$FAKE_DISK_TOTAL_KB
free=$((total - used))
# FAKE_DF_FREE_KB: a disk whose free figure does not follow removals (APFS keeps the space of deleted files while local snapshots hold it).
[ -n "\${FAKE_DF_FREE_KB:-}" ] && free=$FAKE_DF_FREE_KB
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/fake %s %s %s 1%% /\\n' "$total" "$used" "$free"
`;
const fakeDu = `#!/bin/bash
target=\${@: -1}
[ -n "\${FAKE_DU_LOG:-}" ] && echo "$target" >> "$FAKE_DU_LOG"
if [ -f "$target/fake-kb" ]; then printf '%s\\t%s\\n' "$(cat "$target/fake-kb")" "$target"; else exec /usr/bin/du "$@"; fi
`;
const fakePueue = '#!/bin/sh\nexit 0\n';
/** `rm` that takes its time when FAKE_RM_DELAY says so: a removal of tens of GB lasts minutes, and the caller may hang up meanwhile. */
const fakeRm = `#!/bin/bash
[ -n "\${FAKE_RM_DELAY:-}" ] && sleep "$FAKE_RM_DELAY"
exec /bin/rm "$@"
`;

function writeExecutable(file: string, content: string): void {
  fs.writeFileSync(file, content, { mode: 0o755 });
}

function removeTree(target: string): void {
  spawnSync('chmod', ['-R', 'u+rwX', target]);
  fs.rmSync(target, { recursive: true, force: true });
}

function getEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
    PUEUE_BIN: path.join(fakeBinDir, 'pueue'),
    FAKE_WORK: workDir,
    FAKE_DISK_TOTAL_KB: `${fakeDiskGib * kibPerGib}`,
    ...extra,
  };
}

function runScript(args: string[], env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('bash', [scriptPath, ...args], { encoding: 'utf8', env: getEnv(env), timeout: 60_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Run a function of the script (sourced) and return its stdout. */
function runFunction(body: string, env: NodeJS.ProcessEnv = {}): string {
  const result = spawnSync('bash', ['-c', `source ${scriptPath}; ${body}`], { encoding: 'utf8', env: getEnv(env), timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function setAge(target: string, ageMs: number): void {
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(target, when, when);
}

/** A project copy of `sizeGib` GiB (as the fake disk counts it), last used `usedAgoMs` ago. */
function makeCopy(copySlug: string, sizeGib: number, usedAgoMs: number): string {
  const copyDir = path.join(workDir, 'p', copySlug);
  writeFile(copyDir, 'tree/file.txt');
  writeFile(copyDir, 'used', '');
  writeFile(copyDir, 'fake-kb', `${sizeGib * kibPerGib}`);
  setAge(path.join(copyDir, 'used'), usedAgoMs);
  return copyDir;
}

function writeJob(copyDir: string, id: string, files: Record<string, string>): string {
  const jobDir = path.join(copyDir, 'jobs', id);
  for (const [name, content] of Object.entries(files)) writeFile(jobDir, name, content);
  return jobDir;
}

/** Processes the tests keep alive to stand for other processes; the hook below ends them. */
const liveProcesses: ChildProcess[] = [];

/** A live process that is one of the runner script\'s own (its command line names `runner.sh`, as `bash …/runner-<hash>.sh prune …` does): another prune, an `exec`. */
function startLiveProcess(): number {
  const child = spawn('bash', ['-c', 'read -r _', 'runner.sh'], { stdio: ['pipe', 'ignore', 'ignore'] });
  liveProcesses.push(child);
  assert.ok(child.pid !== undefined);
  return child.pid;
}

/** A live process that is NOT the script\'s: what a recorded pid names after a reboot when a daemon got the number. */
function startStrangerProcess(): number {
  const child = spawn('sleep', ['120'], { stdio: 'ignore' });
  liveProcesses.push(child);
  assert.ok(child.pid !== undefined);
  return child.pid;
}

function getDeadPid(): number {
  const pid = spawnSync('true').pid;
  assert.ok(pid !== undefined);
  return pid;
}

/** Run `body` in a shell that has the script's functions (and `workDir` as `work`); returns what it printed and its exit status. */
function runShell(body: string, env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('bash', ['-c', `source ${scriptPath}; ${body}`], { encoding: 'utf8', env: getEnv(env), timeout: 60_000 });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr };
}

function listCopies(): string[] {
  return fs.readdirSync(path.join(workDir, 'p')).filter((name) => !name.startsWith('.')).sort();
}

function parseRemovals(stdout: string): string[] {
  return stdout.split('\n').filter((line) => line.startsWith('removed=')).map((line) => line.slice('removed='.length).split(' ')[0]);
}

beforeEach(() => {
  workRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-script-disk-')));
  workDir = path.join(workRoot, 'work');
  fakeBinDir = path.join(workRoot, 'fakebin');
  fs.mkdirSync(path.join(workDir, 'p'), { recursive: true });
  fs.mkdirSync(fakeBinDir);
  writeExecutable(path.join(fakeBinDir, 'df'), fakeDf);
  writeExecutable(path.join(fakeBinDir, 'du'), fakeDu);
  writeExecutable(path.join(fakeBinDir, 'pueue'), fakePueue);
  writeExecutable(path.join(fakeBinDir, 'rm'), fakeRm);
});
afterEach(() => {
  for (const child of liveProcesses.splice(0)) child.kill('SIGKILL');
  removeTree(workRoot);
});

describe('the free space a runner wants kept', () => {
  const target = (totalGib: number, env: NodeJS.ProcessEnv = {}): number => Number(runFunction(`get_min_free_kb ${totalGib * kibPerGib}`, env)) / kibPerGib;

  it('is the smaller of 60 GB and 15 % of the disk', () => {
    assert.equal(target(200), 30, '15 % of a small disk');
    assert.equal(target(1000), 60, 'the cap on a big disk');
    assert.equal(target(400), 60, '15 % of 400 is exactly over the cap');
  });

  it('is what the runner\'s config says, and 0 turns it off; a value that is no plain number is ignored', () => {
    assert.equal(target(1000, { REMOTE_RUN_MIN_FREE_GB: '120' }), 120);
    assert.equal(target(1000, { REMOTE_RUN_MIN_FREE_GB: '0' }), 0);
    assert.equal(target(1000, { REMOTE_RUN_MIN_FREE_GB: '08' }), 8, 'a leading zero is not octal');
    assert.equal(target(1000, { REMOTE_RUN_MIN_FREE_GB: 'lots' }), 60);
  });
});

describe('prune by age', () => {
  it('removes a project copy unused for more than three days; keeps one used within three', () => {
    makeCopy('old-aaaaaaaaaa', 1, 4 * dayMs);
    makeCopy('recent-bbbbbbbbbb', 1, 2 * dayMs);
    const result = runScript(['prune', workDir]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(listCopies(), ['recent-bbbbbbbbbb']);
    assert.match(result.stdout, /^removed=old-aaaaaaaaaa freed_kb=1048576 why=idle$/m, 'the removal is reported with what it freed and why');
  });

  it('takes the idle days from the runner\'s config; a number that is not one falls back to three', () => {
    makeCopy('two-days-cccccccccc', 1, 2 * dayMs);
    assert.equal(runScript(['prune', workDir], { REMOTE_RUN_COPY_MAX_IDLE_DAYS: 'x' }).status, 0);
    assert.deepEqual(listCopies(), ['two-days-cccccccccc'], 'two days is within the default');
    assert.equal(runScript(['prune', workDir], { REMOTE_RUN_COPY_MAX_IDLE_DAYS: '0' }).status, 0);
    assert.deepEqual(listCopies(), ['two-days-cccccccccc'], '0 is not a limit');
    assert.equal(runScript(['prune', workDir], { REMOTE_RUN_COPY_MAX_IDLE_DAYS: '1' }).status, 0);
    assert.deepEqual(listCopies(), [], 'one idle day is the limit the config set');
  });

  it('removes a copy whose folders are read-only (CocoaPods xcframeworks), which plain `rm -rf` leaves behind', () => {
    const copyDir = makeCopy('pods-dddddddddd', 1, 5 * dayMs);
    writeFile(copyDir, 'tree/ios/Pods/Core.xcframework/Headers/a.h');
    fs.chmodSync(path.join(copyDir, 'tree/ios/Pods/Core.xcframework/Headers'), 0o555);
    fs.chmodSync(path.join(copyDir, 'tree/ios/Pods/Core.xcframework'), 0o555);
    assert.equal(runScript(['prune', workDir]).status, 0);
    assert.deepEqual(listCopies(), []);
    assert.deepEqual(fs.readdirSync(path.join(workDir, 'p')), [], 'nothing is left of it, not even a moved-aside folder');
  });

  it('finishes a removal that an earlier prune did not (a folder left under a `.trash-` name)', () => {
    writeFile(path.join(workDir, 'p', '.trash-gone-ffffffffff-123'), 'tree/file.txt');
    assert.equal(runScript(['prune', workDir]).status, 0);
    assert.deepEqual(fs.readdirSync(path.join(workDir, 'p')), []);
  });

  it('says so when a copy cannot be removed, and goes on', { skip: process.getuid?.() === 0 ? 'root can remove anything' : false }, () => {
    makeCopy('stuck-gggggggggg', 1, 5 * dayMs);
    fs.chmodSync(path.join(workDir, 'p'), 0o555);
    try {
      const result = runScript(['prune', workDir]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /^stuck=stuck-gggggggggg$/m);
      assert.doesNotMatch(result.stdout, /removed=/);
    } finally {
      fs.chmodSync(path.join(workDir, 'p'), 0o755);
    }
    assert.deepEqual(listCopies(), ['stuck-gggggggggg']);
  });
});

describe('prune by free space', () => {
  /** Three copies of 30 GB on a 100 GB disk: 10 GB free. `oldest` was used longest ago. */
  function makeThreeCopies(): { oldest: string; middle: string; newest: string } {
    makeCopy('oldest-aaaaaaaaaa', 30, 5 * hourMs);
    makeCopy('middle-bbbbbbbbbb', 30, 3 * hourMs);
    makeCopy('newest-cccccccccc', 30, 1 * hourMs);
    return { oldest: 'oldest-aaaaaaaaaa', middle: 'middle-bbbbbbbbbb', newest: 'newest-cccccccccc' };
  }

  it('does nothing while the free space is at the target', () => {
    makeThreeCopies();
    const result = runScript(['prune', workDir], { REMOTE_RUN_MIN_FREE_GB: '10' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(listCopies().length, 3);
    assert.equal(result.stdout, '');
  });

  it('removes the least recently used copy first and stops as soon as the target is met', () => {
    const copies = makeThreeCopies();
    const result = runScript(['prune', workDir], { REMOTE_RUN_MIN_FREE_GB: '40' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(parseRemovals(result.stdout), [copies.oldest], 'one removal brings 10 GB to 40 GB');
    assert.deepEqual(listCopies(), [copies.middle, copies.newest]);
    assert.match(result.stdout, /^removed=oldest-aaaaaaaaaa freed_kb=31457280 why=space$/m);
  });

  it('goes on in the order of use while the target is not met', () => {
    const copies = makeThreeCopies();
    const result = runScript(['prune', workDir], { REMOTE_RUN_MIN_FREE_GB: '70' });
    assert.deepEqual(parseRemovals(result.stdout), [copies.oldest, copies.middle]);
    assert.deepEqual(listCopies(), [copies.newest]);
  });

  it('uses the default target (the smaller of 60 GB and 15 %) when the config says nothing: 10 GB free of 100 GB is under 15 GB', () => {
    makeThreeCopies();
    const result = runScript(['prune', workDir]);
    assert.deepEqual(parseRemovals(result.stdout), ['oldest-aaaaaaaaaa']);
  });

  it('with the target off (0) removes nothing for space', () => {
    makeThreeCopies();
    assert.equal(runScript(['prune', workDir], { REMOTE_RUN_MIN_FREE_GB: '0' }).stdout, '');
    assert.equal(listCopies().length, 3);
  });

  describe('never removes a copy that is in use', () => {
    /** The oldest copy is `protectedSlug`; two younger ones are free to go. Returns what a prune that needs 70 GB removed. */
    function pruneWithOldestProtected(setUp: (copyDir: string) => void): string[] {
      const oldestDir = makeCopy('keep-hhhhhhhhhh', 30, 9 * hourMs);
      setUp(oldestDir);
      makeCopy('free-one-iiiiiiiiii', 30, 5 * hourMs);
      makeCopy('free-two-jjjjjjjjjj', 30, 3 * hourMs);
      const result = runScript(['prune', workDir], { REMOTE_RUN_MIN_FREE_GB: '70' });
      assert.equal(result.status, 0, result.stderr);
      return parseRemovals(result.stdout);
    }

    it('its lock is held by a live job', () => {
      const removed = pruneWithOldestProtected((copyDir) => writeFile(copyDir, 'lock', `${process.pid}\n${jobId}\n`));
      assert.deepEqual(removed, ['free-one-iiiiiiiiii', 'free-two-jjjjjjjjjj']);
      assert.ok(fs.existsSync(path.join(workDir, 'p', 'keep-hhhhhhhhhh')));
    });

    it('a job of it waits in the queue (a task, no process yet)', () => {
      const removed = pruneWithOldestProtected((copyDir) => writeJob(copyDir, 'box1-queued', { 'task-id': '4\n' }));
      assert.deepEqual(removed, ['free-one-iiiiiiiiii', 'free-two-jjjjjjjjjj']);
      assert.ok(fs.existsSync(path.join(workDir, 'p', 'keep-hhhhhhhhhh')));
    });

    it('a job of it runs (a task and a live process)', () => {
      const removed = pruneWithOldestProtected((copyDir) => writeJob(copyDir, 'box1-runnin', { 'task-id': '5\n', pid: `${process.pid}\n` }));
      assert.deepEqual(removed, ['free-one-iiiiiiiiii', 'free-two-jjjjjjjjjj']);
      assert.ok(fs.existsSync(path.join(workDir, 'p', 'keep-hhhhhhhhhh')));
    });

    it('a job of it was just prepared and is still sending its files (no task yet)', () => {
      const removed = pruneWithOldestProtected((copyDir) => writeJob(copyDir, 'box1-sendin', { 'meta.json': '{}' }));
      assert.deepEqual(removed, ['free-one-iiiiiiiiii', 'free-two-jjjjjjjjjj']);
      assert.ok(fs.existsSync(path.join(workDir, 'p', 'keep-hhhhhhhhhh')));
    });

    it('is the copy of the job being submitted (`prepare` of its slug): even when it is all that is left to remove it stays, and the submit is refused instead', () => {
      makeCopy('free-one-iiiiiiiiii', 30, 5 * hourMs);
      makeCopy(slug, 30, 9 * hourMs);
      makeCopy('free-two-jjjjjjjjjj', 30, 3 * hourMs);
      const result = runScript(['prepare', workDir, slug, jobId, 'default=1'], { REMOTE_RUN_MIN_FREE_GB: '80' });
      assert.equal(result.status, diskTooLowRunnerExitCode, result.stderr);
      assert.deepEqual(parseRemovals(result.stdout), ['free-one-iiiiiiiiii', 'free-two-jjjjjjjjjj']);
      assert.deepEqual(listCopies(), [slug]);
    });

    it('the slug the prune is told to keep stays on its own, whatever the copy holds (no job of it is prepared yet)', () => {
      makeCopy(slug, 30, 9 * hourMs);
      makeCopy('free-one-iiiiiiiiii', 30, 5 * hourMs);
      assert.deepEqual(parseRemovals(runFunction(`prune_work ${workDir} ${slug}`, { REMOTE_RUN_MIN_FREE_GB: '90' })), ['free-one-iiiiiiiiii']);
      assert.deepEqual(listCopies(), [slug]);
      makeCopy('idle-qqqqqqqqqq', 1, 4 * dayMs);
      makeCopy('idle-keep-rrrrrrrrrr', 1, 4 * dayMs);
      assert.deepEqual(parseRemovals(runFunction(`prune_work ${workDir} idle-keep-rrrrrrrrrr`, { REMOTE_RUN_MIN_FREE_GB: '0' })), ['idle-qqqqqqqqqq'], 'also by age');
    });
  });

  describe('removes a copy that only looks like it is in use', () => {
    it('a lock whose holder is gone, a job that ended long ago, a job that never got a task and is long over', () => {
      const deadPid = spawnSync('true').pid;
      const lockedDir = makeCopy('dead-lock-kkkkkkkkkk', 20, 9 * hourMs);
      writeFile(lockedDir, 'lock', `${deadPid}\n${jobId}\n`);
      const endedDir = makeCopy('ended-job-llllllllll', 20, 7 * hourMs);
      setAge(path.join(writeJob(endedDir, 'box1-ended0', { 'task-id': '1\n', exit: '0\n' }), 'exit'), 2 * hourMs);
      const abandonedDir = makeCopy('abandoned-mmmmmmmmmm', 20, 5 * hourMs);
      setAge(writeJob(abandonedDir, 'box1-never0', { 'meta.json': '{}' }), 2 * hourMs);
      makeCopy('last-nnnnnnnnnn', 20, 1 * hourMs);
      const result = runScript(['prune', workDir], { REMOTE_RUN_MIN_FREE_GB: '70' });
      assert.deepEqual(parseRemovals(result.stdout), ['dead-lock-kkkkkkkkkk', 'ended-job-llllllllll', 'abandoned-mmmmmmmmmm']);
    });
  });

  it('takes `exec` as use: the copy an `exec` ran in is not the least recently used any more', () => {
    makeCopy(slug, 30, 9 * hourMs);
    makeCopy('other-pppppppppp', 30, 5 * hourMs);
    const usedFile = path.join(workDir, 'p', slug, 'used');
    const before = fs.statSync(usedFile).mtimeMs;
    const exec = spawnSync('bash', [scriptPath, 'exec', workDir, slug, '', '60000', 'true'], { encoding: 'utf8', env: getEnv(), input: '', timeout: 30_000 });
    assert.equal(exec.status, 0, exec.stderr);
    assert.ok(fs.statSync(usedFile).mtimeMs > before + hourMs, 'its mark of use is fresh');
    const result = runScript(['prune', workDir], { REMOTE_RUN_MIN_FREE_GB: '45' });
    assert.deepEqual(parseRemovals(result.stdout), ['other-pppppppppp'], 'the other copy went first');
  });
});

describe('a submit on a disk that stays short', () => {
  it('is refused at once with the numbers, the biggest copies and the way out; what `prepare` made for it is taken back', () => {
    const busyDir = makeCopy('big-qqqqqqqqqq', 41, 2 * hourMs);
    writeJob(busyDir, 'box1-busy00', { 'task-id': '2\n' });
    const secondDir = makeCopy('mid-rrrrrrrrrr', 30, 2 * hourMs);
    writeJob(secondDir, 'box1-busy01', { 'task-id': '3\n' });
    makeCopy('tiny-ssssssssss', 1, 2 * hourMs);
    writeJob(path.join(workDir, 'p', 'tiny-ssssssssss'), 'box1-busy02', { 'task-id': '4\n' });
    assert.equal(runScript(['measure-copies', workDir]).status, 0, 'the sizes the refusal names were written down by the detached measuring of an earlier call');
    const result = runScript(['prepare', workDir, slug, jobId, 'default=1'], { REMOTE_RUN_MIN_FREE_GB: '60' });
    assert.equal(result.status, diskTooLowRunnerExitCode, result.stderr);
    const lines = result.stderr.trim().split('\n');
    assert.equal(lines.length, 1, 'one line, so the CLI shows it whole');
    assert.match(lines[0], /^remote-run-runner: only 28 GB free on the work disk, the runner needs 60 GB; biggest project copies: big-qqqqqqqqqq 41 GB, mid-rrrrrrrrrr 30 GB, tiny-ssssssssss 1 GB; free space with `charness remote-run clean <slug>`/);
    assert.deepEqual(listCopies(), ['big-qqqqqqqqqq', 'mid-rrrrrrrrrr', 'tiny-ssssssssss'], 'the new project left no empty copy behind');
    assert.equal(result.stdout.includes('work='), false);
  });

  it('keeps the existing copy of the submitting project and drops only the job it just made', () => {
    writeJob(makeCopy('big-qqqqqqqqqq', 80, 2 * hourMs), 'box1-busy00', { 'task-id': '2\n' });
    const ownDir = makeCopy(slug, 5, 8 * hourMs);
    writeJob(ownDir, 'box1-earlie', { 'task-id': '9\n', exit: '0\n' });
    const result = runScript(['prepare', workDir, slug, jobId, 'default=1'], { REMOTE_RUN_MIN_FREE_GB: '60' });
    assert.equal(result.status, diskTooLowRunnerExitCode, result.stderr);
    assert.ok(fs.existsSync(path.join(ownDir, 'tree/file.txt')), 'its copy is untouched');
    assert.equal(fs.existsSync(path.join(ownDir, 'jobs', jobId)), false);
    assert.equal(fs.existsSync(path.join(ownDir, 'stage', jobId)), false);
    assert.ok(fs.existsSync(path.join(ownDir, 'jobs', 'box1-earlie')));
  });

  it('says when no project copy is there to free: the disk is full of other things', () => {
    const result = runScript(['prepare', workDir, slug, jobId, 'default=1'], { REMOTE_RUN_MIN_FREE_GB: '200' });
    assert.equal(result.status, diskTooLowRunnerExitCode);
    assert.match(result.stderr, /there is no project copy here to free: the disk is full of other files/);
  });

  it('is not refused when pruning made room — and says what it removed', () => {
    makeCopy('idle-ttttttttt', 60, 6 * hourMs);
    makeCopy('used-uuuuuuuuuu', 20, 1 * hourMs);
    const result = runScript(['prepare', workDir, slug, jobId, 'default=1'], { REMOTE_RUN_MIN_FREE_GB: '50' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^removed=idle-ttttttttt freed_kb=62914560 why=space$/m);
    assert.match(result.stdout, /^work=/m);
  });

  it('is never refused with the target off (0)', () => {
    makeCopy('big-qqqqqqqqqq', 99, 1 * hourMs);
    const result = runScript(['prepare', workDir, slug, jobId, 'default=1'], { REMOTE_RUN_MIN_FREE_GB: '0' });
    assert.equal(result.status, 0, result.stderr);
  });
});

describe('sizes of the project copies (`measure-copies`) and what `probe` says of them', () => {
  const sizeFile = (copySlug: string): string => path.join(workDir, 'p', copySlug, 'size-kb');

  async function waitFor(condition: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`${what} did not happen`);
  }

  it('writes the size of a copy whose figure is missing or was written before the copy was last used — and leaves alone one nobody touched since, however long ago it was written', () => {
    makeCopy('missing-vvvvvvvvvv', 7, hourMs);
    makeCopy('used-since-wwwwwwwwww', 3, hourMs);
    writeFile(path.join(workDir, 'p', 'used-since-wwwwwwwwww'), 'size-kb', '1');
    setAge(sizeFile('used-since-wwwwwwwwww'), 2 * hourMs);
    makeCopy('untouched-xxxxxxxxxx', 4, 30 * hourMs);
    writeFile(path.join(workDir, 'p', 'untouched-xxxxxxxxxx'), 'size-kb', '5');
    setAge(sizeFile('untouched-xxxxxxxxxx'), 29 * hourMs);
    assert.equal(runScript(['measure-copies', workDir]).status, 0);
    assert.equal(fs.readFileSync(sizeFile('missing-vvvvvvvvvv'), 'utf8').trim(), `${7 * kibPerGib}`);
    assert.equal(fs.readFileSync(sizeFile('used-since-wwwwwwwwww'), 'utf8').trim(), `${3 * kibPerGib}`, 'used after its figure: measured again');
    assert.equal(fs.readFileSync(sizeFile('untouched-xxxxxxxxxx'), 'utf8').trim(), '5', 'a figure a day old is still right for a copy nobody used since: no `du` over millions of files for it');
  });

  it('probe counts the copies and sums their written figures at once, and starts the measuring of the missing ones detached', async () => {
    makeCopy('known-yyyyyyyyyy', 7, hourMs);
    writeFile(path.join(workDir, 'p', 'known-yyyyyyyyyy'), 'size-kb', `${7 * kibPerGib}`);
    makeCopy('unknown-zzzzzzzzzz', 3, hourMs);
    const result = runScript(['probe', workDir]);
    assert.equal(result.status, 0, result.stderr);
    const probe = parseProbeOutput(result.stdout);
    assert.deepEqual(probe.copies, { count: 2, sizeMb: 7 * 1024, unmeasuredCount: 1 });
    assert.equal(probe.diskMinFreeMb, 15 * 1024, 'the default target of a 100 GB disk: 15 %');
    await waitFor(() => fs.existsSync(sizeFile('unknown-zzzzzzzzzz')), 'the detached measuring');
    assert.equal(fs.readFileSync(sizeFile('unknown-zzzzzzzzzz'), 'utf8').trim(), `${3 * kibPerGib}`);
  });

  it('probe of a VIEW (`probe <work> prune`) on a disk short of free space starts the prune detached instead of making the probe wait for it', async () => {
    makeCopy('oldest-aaaaaaaaaa', 45, 5 * hourMs);
    makeCopy('newest-cccccccccc', 45, 1 * hourMs);
    const result = runScript(['probe', workDir, 'prune']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(parseProbeOutput(result.stdout).diskFreeMb, 10 * 1024, 'the probe reports the disk as it found it');
    await waitFor(() => listCopies().length === 1, 'the detached prune');
    assert.deepEqual(listCopies(), ['newest-cccccccccc']);
  });

  it('probe on a disk at its target removes nothing', () => {
    makeCopy('only-aaaaaaaaaa', 10, 5 * hourMs);
    assert.equal(runScript(['probe', workDir]).status, 0);
    assert.deepEqual(listCopies(), ['only-aaaaaaaaaa']);
  });
});

describe('probe: a copy counts as measured while nobody used it since its figure was written, however old the figure is', () => {
  it('a figure newer than the copy\'s last use is measured; one written before it is not (and the detached measuring is asked for)', () => {
    // A «detached measuring» that is already running keeps the probe from starting its own while this one reads the figures.
    writeFile(workDir, 'tmp/measure-copies.pid', `${startLiveProcess()}\n`);
    makeCopy('still-right-aaaaaaaaaa', 4, 30 * hourMs);
    writeFile(path.join(workDir, 'p', 'still-right-aaaaaaaaaa'), 'size-kb', `${4 * kibPerGib}`);
    setAge(path.join(workDir, 'p', 'still-right-aaaaaaaaaa', 'size-kb'), 20 * hourMs);
    makeCopy('used-since-bbbbbbbbbb', 6, 1 * hourMs);
    writeFile(path.join(workDir, 'p', 'used-since-bbbbbbbbbb'), 'size-kb', `${6 * kibPerGib}`);
    setAge(path.join(workDir, 'p', 'used-since-bbbbbbbbbb', 'size-kb'), 2 * hourMs);
    const probe = parseProbeOutput(runScript(['probe', workDir]).stdout);
    assert.deepEqual(probe.copies, { count: 2, sizeMb: 10 * 1024, unmeasuredCount: 1 });
  });
});

describe('a copy an `exec` runs in is in use (exec takes no lock and leaves no job folder)', () => {
  function pruneForSpaceWithOldestHolding(marker: (copyDir: string) => void): string[] {
    marker(makeCopy('keep-hhhhhhhhhh', 30, 9 * hourMs));
    makeCopy('free-one-iiiiiiiiii', 30, 5 * hourMs);
    makeCopy('free-two-jjjjjjjjjj', 30, 3 * hourMs);
    return parseRemovals(runScript(['prune', workDir], { REMOTE_RUN_MIN_FREE_GB: '70' }).stdout);
  }

  it('a marker of a live process keeps the copy, however old its mark of use', () => {
    const livePid = startLiveProcess();
    const removed = pruneForSpaceWithOldestHolding((copyDir) => writeFile(copyDir, `exec.${livePid}`, `${livePid}\n`));
    assert.deepEqual(removed, ['free-one-iiiiiiiiii', 'free-two-jjjjjjjjjj']);
    assert.ok(fs.existsSync(path.join(workDir, 'p', 'keep-hhhhhhhhhh')));
  });

  it('a marker of a process that is gone protects nothing and is cleared', () => {
    const deadPid = getDeadPid();
    const copyDir = makeCopy('stale-marker-kkkkkkkkkk', 1, 9 * hourMs);
    writeFile(copyDir, `exec.${deadPid}`, `${deadPid}\n`);
    const outcome = runShell(`check_copy_dir_is_busy ${copyDir} && echo busy || echo free`);
    assert.equal(outcome.stdout, 'free');
    assert.equal(fs.existsSync(path.join(copyDir, `exec.${deadPid}`)), false);
  });

  it('a REAL `exec` writes its marker for as long as it runs: a prune that needs the space meanwhile leaves its copy alone; when it ends the marker is gone and the copy counts as just used', async () => {
    const copyDir = makeCopy(slug, 30, 9 * hourMs);
    makeCopy('free-one-iiiiiiiiii', 30, 5 * hourMs);
    makeCopy('free-two-jjjjjjjjjj', 30, 3 * hourMs);
    const exec = spawn('bash', [scriptPath, 'exec', workDir, slug, '', '60000', 'sleep 4'], { env: getEnv(), stdio: ['pipe', 'ignore', 'ignore'] });
    liveProcesses.push(exec);
    const exited = new Promise<number | null>((resolve) => exec.on('close', resolve));
    const markerFile = path.join(copyDir, `exec.${exec.pid}`);
    const deadline = Date.now() + 20_000;
    while (!fs.existsSync(markerFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(fs.existsSync(markerFile), 'the marker is written while the command runs');
    const removed = parseRemovals(runScript(['prune', workDir], { REMOTE_RUN_MIN_FREE_GB: '70' }).stdout);
    assert.deepEqual(removed, ['free-one-iiiiiiiiii', 'free-two-jjjjjjjjjj'], 'the oldest copy is the one the exec runs in — and it stays');
    assert.ok(fs.existsSync(path.join(copyDir, 'tree/file.txt')));
    // The start of the command already counted as use; only its END can make the mark fresh again once it has gone stale under a long run.
    setAge(path.join(copyDir, 'used'), 9 * hourMs);
    assert.equal(await exited, 0);
    assert.equal(fs.existsSync(markerFile), false, 'the exit hook removes it');
    assert.ok(Date.now() - fs.statSync(path.join(copyDir, 'used')).mtimeMs < 30_000, 'the end of the command counts as use');
  });

  it('an `exec` into a copy that is not there (a prune removed it) says so instead of leaving a marker in a folder it made', () => {
    const result = spawnSync('bash', [scriptPath, 'exec', workDir, slug, '', '60000', 'true'], { encoding: 'utf8', env: getEnv(), input: '', timeout: 30_000 });
    assert.equal(result.status, 125);
    assert.match(result.stderr, /the runner has no copy of this project yet/);
    assert.equal(fs.existsSync(path.join(workDir, 'p', slug)), false, 'no folder was made for the marker');
  });
});

describe('the result files of a job that just ended are kept, and a job\'s end is the copy\'s last use', () => {
  it('a copy whose job ended less than an hour ago is not removed, however old its mark of use; one whose job ended longer ago is', () => {
    const recentDir = makeCopy('recent-end-aaaaaaaaaa', 30, 9 * hourMs);
    writeJob(recentDir, 'box1-justen', { 'task-id': '1\n', exit: '0\n' });
    const oldDir = makeCopy('old-end-bbbbbbbbbb', 30, 7 * hourMs);
    setAge(path.join(writeJob(oldDir, 'box1-longag', { 'task-id': '2\n', exit: '0\n' }), 'exit'), 2 * hourMs);
    makeCopy('newest-cccccccccc', 30, 1 * hourMs);
    const removed = parseRemovals(runScript(['prune', workDir], { REMOTE_RUN_MIN_FREE_GB: '70' }).stdout);
    assert.deepEqual(removed, ['old-end-bbbbbbbbbb', 'newest-cccccccccc'], 'the copy with fresh results is skipped, the next oldest goes');
    assert.ok(fs.existsSync(path.join(recentDir, 'jobs', 'box1-justen', 'exit')));
  });

  it('`finish_job` touches the copy\'s mark of use (a job that ran for hours must not leave the copy as old as its submit)', () => {
    const copyDir = makeCopy(slug, 1, 5 * hourMs);
    writeJob(copyDir, jobId, { 'task-id': '3\n' });
    const outcome = runShell(`set_paths ${workDir} ${slug} ${jobId}; killed=0; lock_held=0; timeout_sec=5; finish_job 0`);
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.ok(Date.now() - fs.statSync(path.join(copyDir, 'used')).mtimeMs < 30_000);
    assert.equal(fs.readFileSync(path.join(copyDir, 'jobs', jobId, 'exit'), 'utf8').trim(), '0');
  });

  it('and so does the end of a job that was killed while queued (`finish_killed_job`)', () => {
    const copyDir = makeCopy(slug, 1, 5 * hourMs);
    writeJob(copyDir, jobId, { 'task-id': '3\n' });
    const outcome = runShell(`set_paths ${workDir} ${slug} ${jobId}; finish_killed_job`);
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.ok(Date.now() - fs.statSync(path.join(copyDir, 'used')).mtimeMs < 30_000);
  });
});

describe('a copy that gets busy between the check that chose it and the rename that removes it', () => {
  /** `remove_project_copy` of `copySlug` where `mv` first does the rename and then plants `afterRename` in the moved folder, as a `prepare` that landed in between would have. */
  function removeWithPlantedJob(copySlug: string, extra = ''): { code: string; stdout: string } {
    const outcome = runShell(`mv() { command mv "$@"; case "$2" in */.trash-*) mkdir -p "$2/jobs/box1-latejb"; ${extra} ;; esac; }; remove_project_copy ${workDir} ${copySlug}; echo code=$?`);
    return { code: outcome.stdout.split('=').pop() ?? '', stdout: outcome.stdout };
  }

  it('is asked about again once moved aside: it is put back, and nothing of it is removed', () => {
    const copyDir = makeCopy('late-busy-aaaaaaaaaa', 5, 9 * hourMs);
    const outcome = removeWithPlantedJob('late-busy-aaaaaaaaaa');
    assert.equal(outcome.code, '3', outcome.stdout);
    assert.ok(fs.existsSync(path.join(copyDir, 'jobs', 'box1-latejb')), 'the new job folder is where its submit expects it');
    assert.ok(fs.existsSync(path.join(copyDir, 'tree/file.txt')));
    assert.deepEqual(fs.readdirSync(path.join(workDir, 'p')), ['late-busy-aaaaaaaaaa'], 'no trash left behind');
  });

  it('when the name was taken again meanwhile it cannot go back: it stays under its trash name, which no prune removes while something in it is in use — and removes once nothing is', () => {
    makeCopy('late-busy-bbbbbbbbbb', 5, 9 * hourMs);
    const outcome = removeWithPlantedJob('late-busy-bbbbbbbbbb', `mkdir -p "${workDir}/p/late-busy-bbbbbbbbbb/tree"`);
    assert.equal(outcome.code, '3', outcome.stdout);
    const trashName = fs.readdirSync(path.join(workDir, 'p')).find((name) => name.startsWith('.trash-late-busy-bbbbbbbbbb-'));
    assert.ok(trashName !== undefined, 'the busy folder was not deleted');
    const trashDir = path.join(workDir, 'p', trashName);
    assert.equal(runShell(`remove_leftover_trash ${workDir}`).status, 0);
    assert.ok(fs.existsSync(path.join(trashDir, 'jobs', 'box1-latejb')), 'a later prune leaves it while its job is young');
    setAge(path.join(trashDir, 'jobs', 'box1-latejb'), 2 * hourMs);
    assert.equal(runShell(`remove_leftover_trash ${workDir}`).status, 0);
    assert.equal(fs.existsSync(trashDir), false, 'and takes it when nothing in it is in use');
  });

  it('a copy that is already gone (another prune took it) is nothing to report: no line, no «stuck»', () => {
    const outcome = runShell(`remove_and_report_copy ${workDir} never-there-aaaaaaaaaa space; echo code=$?`);
    assert.equal(outcome.stdout, 'code=2');
  });

  it('`prepare` whose project folder a concurrent prune took says so, instead of answering with a work dir whose job folder is gone', () => {
    const result = spawnSync('bash', ['-c', `source ${scriptPath}; prune_work() { rm -rf "$proj"; }; cmd_prepare ${workDir} ${slug} ${jobId} default=1`], { encoding: 'utf8', env: getEnv(), timeout: 60_000 });
    assert.equal(result.status, 125, result.stderr);
    assert.match(result.stderr, /the project copy was being removed while this job was prepared — submit again/);
    assert.equal(result.stdout.includes('work='), false);
  });
});

describe('a job being submitted keeps its copy while its files are still coming', () => {
  const isBusy = (copyDir: string, graceMinutes = ''): string => runShell(`${graceMinutes === '' ? '' : `pending_submit_grace_min=${graceMinutes};`} check_copy_dir_is_busy ${copyDir} && echo busy || echo free`).stdout;

  it('a job folder untouched for hours, but a stage folder still receiving files: in use — the upload of a big project is quiet in the job folder for as long as it takes', () => {
    const copyDir = makeCopy('uploading-aaaaaaaaaa', 5, 9 * hourMs);
    const jobDir = writeJob(copyDir, 'box1-upload', { log: '' });
    setAge(jobDir, 3 * hourMs);
    writeFile(copyDir, 'stage/box1-upload/projects/app/big-file.bin');
    assert.equal(isBusy(copyDir), 'busy');
  });

  it('the same without any recent activity (the grace set to 0 stands for a stage nobody has touched for long: a ctime cannot be set back) is a job that failed half-way: not in use', () => {
    const copyDir = makeCopy('abandoned-bbbbbbbbbb', 5, 9 * hourMs);
    const jobDir = writeJob(copyDir, 'box1-upload', { log: '' });
    setAge(jobDir, 3 * hourMs);
    writeFile(copyDir, 'stage/box1-upload/projects/app/big-file.bin');
    assert.equal(isBusy(copyDir, '0'), 'free');
  });
});

describe('two prunes at once', () => {
  function makeThreeCopies(): void {
    makeCopy('oldest-aaaaaaaaaa', 30, 5 * hourMs);
    makeCopy('middle-bbbbbbbbbb', 30, 3 * hourMs);
    makeCopy('newest-cccccccccc', 30, 1 * hourMs);
  }

  const lockFile = (): string => path.join(workDir, 'tmp', 'prune.lock');

  /** The lock of the copy-removal step as another prune holds it: its pid inside, made `ageMs` ago. */
  function putPruneLock(holderPid: number | string, ageMs = 60_000): string {
    writeFile(workDir, 'tmp/prune.lock', typeof holderPid === 'number' ? `${holderPid}\n` : holderPid);
    setAge(lockFile(), ageMs);
    return lockFile();
  }

  it('a trash folder whose remover still lives is left to it; one whose remover is gone is finished', () => {
    const livePid = startLiveProcess();
    const deadPid = getDeadPid();
    writeFile(path.join(workDir, 'p', `.trash-being-removed-${livePid}`), 'tree/file.txt');
    writeFile(path.join(workDir, 'p', `.trash-cut-off-${deadPid}`), 'tree/file.txt');
    assert.equal(runShell(`remove_leftover_trash ${workDir}`).status, 0);
    assert.ok(fs.existsSync(path.join(workDir, 'p', `.trash-being-removed-${livePid}`)));
    assert.equal(fs.existsSync(path.join(workDir, 'p', `.trash-cut-off-${deadPid}`)), false);
  });

  it('the probe\'s detached prune (`prune`) leaves the copy-removal step to a prune that is at it, and says nothing — the lock stays the other\'s', () => {
    makeThreeCopies();
    const livePid = startLiveProcess();
    putPruneLock(livePid);
    const result = runScript(['prune', workDir], { REMOTE_RUN_MIN_FREE_GB: '70' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(listCopies().length, 3);
    assert.equal(fs.readFileSync(lockFile(), 'utf8').trim(), `${livePid}`);
  });

  it('in skip mode it leaves at once even though its disk is short — it never waits (a probe must not hang)', () => {
    makeThreeCopies();
    putPruneLock(startLiveProcess());
    const outcome = runShell(`prune_wait_sec=3; prune_poll_sec=0.2; started=$SECONDS; prune_work ${workDir} "" skip; echo waited=$((SECONDS - started))`, { REMOTE_RUN_MIN_FREE_GB: '70' });
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.match(outcome.stdout, /waited=[0-2]$/, 'not the 3 s of the wait it must not make');
    assert.equal(listCopies().length, 3, 'and it removed nothing: after a wait it would have gone on without the lock');
  });

  describe('a lock that nobody holds any more is taken over, and the prune goes on', () => {
    const scenarios: Array<[string, () => void]> = [
      ['its holder is gone', () => { putPruneLock(getDeadPid()); }],
      ['its pid went to a stranger (a daemon after a reboot)', () => { putPruneLock(startStrangerProcess()); }],
      ['it is over two hours old (a pid can be given to anything)', () => { putPruneLock(startLiveProcess(), 3 * hourMs); }],
      ['it is empty and over a minute old (its creator died between the create and the write)', () => { putPruneLock('', 3 * 60_000); }],
      ['it holds no pid at all', () => { putPruneLock('not a pid\n', 60_000); }],
    ];
    for (const [name, setUp] of scenarios) {
      it(name, () => {
        makeThreeCopies();
        setUp();
        const result = runScript(['prune', workDir], { REMOTE_RUN_MIN_FREE_GB: '70' });
        assert.deepEqual(parseRemovals(result.stdout), ['oldest-aaaaaaaaaa', 'middle-bbbbbbbbbb']);
        assert.equal(fs.existsSync(lockFile()), false, 'and its own lock is gone when it ends');
        assert.deepEqual(fs.readdirSync(path.join(workDir, 'tmp')).filter((entry) => entry.startsWith('prune.lock')), [], 'no right to break it is left behind');
      });
    }

    it('an EMPTY lock that is young is a creator about to write: it is held', () => {
      makeThreeCopies();
      putPruneLock('', 1000);
      const result = runScript(['prune', workDir], { REMOTE_RUN_MIN_FREE_GB: '70' });
      assert.equal(result.stdout, '');
      assert.equal(listCopies().length, 3);
    });

    it('a breaker that is slow between checking the lock and removing it cannot take a fresh lock away: the right to break is exclusive, so a second process that finds the same stale lock meanwhile loses', async () => {
      putPruneLock(getDeadPid());
      // B stalls for a second just before it removes the lock (its `rm`); A arrives 0.3 s later at the same stale lock. If A could break it too, A would remove it, take a fresh one, and B's late `rm` would delete A's
      // fresh lock — two holders.
      const slowBreaker = `rm() { case "$*" in *prune.lock) sleep 1 ;; esac; command rm "$@"; }; acquire_prune_lock ${workDir} && { echo B-won; sleep 3; } || echo B-lost`;
      const quickBreaker = `sleep 0.3; acquire_prune_lock ${workDir} && { echo A-won; sleep 3; } || echo A-lost`;
      const outputs = await Promise.all([slowBreaker, quickBreaker].map((body) => new Promise<string>((resolve) => {
        const child = spawn('bash', ['-c', `source ${scriptPath}; ${body}`], { env: getEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
        let output = '';
        child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
        child.on('close', () => resolve(output.trim()));
      })));
      assert.deepEqual(outputs, ['B-won', 'A-lost']);
    });

    it('a breaker that was slow BEFORE it took the right finds a fresh lock of somebody else when it gets there, and leaves it alone (it breaks only the lock of the holder it saw)', async () => {
      putPruneLock(getDeadPid());
      const flag = path.join(workRoot, 'stalled-once');
      // B reads the stale holder and then stalls for a second, once; A comes 0.3 s later, breaks the lock and takes a fresh one. When B goes on, the lock is A's and must stay.
      const slowReader = `read_file() { cat "$1" 2> /dev/null; case "$1" in *prune.lock) [ -e ${flag} ] || { : > ${flag}; sleep 1; } ;; esac; }; acquire_prune_lock ${workDir} && { echo B-won; sleep 3; } || echo B-lost`;
      const quickBreaker = `sleep 0.3; acquire_prune_lock ${workDir} && { echo A-won; sleep 3; } || echo A-lost`;
      const outputs = await Promise.all([slowReader, quickBreaker].map((body) => new Promise<string>((resolve) => {
        const child = spawn('bash', ['-c', `source ${scriptPath}; ${body}`], { env: getEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
        let output = '';
        child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
        child.on('close', () => resolve(output.trim()));
      })));
      assert.deepEqual(outputs, ['B-lost', 'A-won']);
    });

    it('of several processes that find the same stale lock exactly one gets it (the right to break it is exclusive); the rest see it held', () => {
      putPruneLock(getDeadPid());
      const contenders = 8;
      // The winner keeps the lock for two seconds, like a prune at work: a lock whose holder had already exited would be stale again for the next contender.
      const body = `acquire_prune_lock ${workDir} && { echo won; sleep 2; } || echo lost`;
      const results = Array.from({ length: contenders }, () => spawn('bash', ['-c', `source ${scriptPath}; ${body}`], { env: getEnv(), stdio: ['ignore', 'pipe', 'ignore'] }));
      return Promise.all(results.map((child) => new Promise<string>((resolve) => {
        let output = '';
        child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
        child.on('close', () => resolve(output.trim()));
      }))).then((outputs) => {
        assert.equal(outputs.filter((output) => output === 'won').length, 1, outputs.join(','));
      });
    });
  });

  it('a submit\'s prune WAITS for the other one and then decides by the disk as the other left it (here the other freed enough: it removes nothing)', () => {
    makeThreeCopies();
    const otherLock = putPruneLock(startLiveProcess());
    // The other prune ends its work after a second: it removed the oldest copy and its lock goes.
    const body = `prune_poll_sec=0.1; ( sleep 1; command rm -rf "${path.join(workDir, 'p', 'oldest-aaaaaaaaaa')}" "${otherLock}" ) & started=$SECONDS; prune_work ${workDir} ""; echo waited=$((SECONDS - started))`;
    const outcome = runShell(body, { REMOTE_RUN_MIN_FREE_GB: '40' });
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.deepEqual(listCopies(), ['middle-bbbbbbbbbb', 'newest-cccccccccc'], 'it removed nothing of its own: 40 GB were free once the other was done');
    assert.match(outcome.stdout, /waited=[1-9]/);
  });

  it('the wait is bounded: a prune that never ends is waited for prune_wait_sec, then the submit goes on without the lock — and leaves the other\'s lock alone', () => {
    makeThreeCopies();
    const livePid = startLiveProcess();
    putPruneLock(livePid);
    const outcome = runShell(`prune_wait_sec=1; prune_poll_sec=0.2; started=$SECONDS; prune_work ${workDir} ""; echo waited=$((SECONDS - started))`, { REMOTE_RUN_MIN_FREE_GB: '40' });
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.deepEqual(listCopies(), ['middle-bbbbbbbbbb', 'newest-cccccccccc']);
    assert.match(outcome.stdout, /waited=[1-4]$/);
    assert.equal(fs.readFileSync(lockFile(), 'utf8').trim(), `${livePid}`, 'a prune that never had the lock does not give it back');
  });

  it('its own lock is gone when it ends', () => {
    makeThreeCopies();
    assert.equal(runScript(['prune', workDir], { REMOTE_RUN_MIN_FREE_GB: '40' }).status, 0);
    assert.equal(fs.existsSync(lockFile()), false);
  });

  it('two real prunes started at the same moment remove ONE copy between them, not one each (the second finds the first at it and leaves, or waits and finds the disk fine)', async () => {
    makeThreeCopies();
    const env = getEnv({ REMOTE_RUN_MIN_FREE_GB: '40', FAKE_RM_DELAY: '1' });
    const outputs = await Promise.all([0, 1].map(() => new Promise<string>((resolve) => {
      const child = spawn('bash', [scriptPath, 'prune', workDir], { env, stdio: ['ignore', 'pipe', 'ignore'] });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
      child.on('close', () => resolve(output));
    })));
    assert.equal(outputs.flatMap(parseRemovals).length, 1, outputs.join(' | '));
    assert.deepEqual(listCopies(), ['middle-bbbbbbbbbb', 'newest-cccccccccc']);
  });
});

describe('the refusal never measures', () => {
  function refuse(env: NodeJS.ProcessEnv = {}): { status: number | null; stderr: string; duLog: string } {
    // A «detached measuring» that is already running keeps `prepare` from starting its own (which would call du too).
    writeFile(workDir, 'tmp/measure-copies.pid', `${startLiveProcess()}\n`);
    const duLog = path.join(workRoot, 'du.log');
    const result = runScript(['prepare', workDir, slug, jobId, 'default=1'], { REMOTE_RUN_MIN_FREE_GB: '60', FAKE_DU_LOG: duLog, ...env });
    return { status: result.status, stderr: result.stderr, duLog: fs.existsSync(duLog) ? fs.readFileSync(duLog, 'utf8') : '' };
  }

  it('copies with no written size are counted, not `du`-ed: right after an upgrade the refusal still comes at once and says the sizes are being measured', () => {
    writeJob(makeCopy('big-qqqqqqqqqq', 41, 2 * hourMs), 'box1-busy00', { 'task-id': '2\n' });
    writeJob(makeCopy('mid-rrrrrrrrrr', 30, 2 * hourMs), 'box1-busy01', { 'task-id': '3\n' });
    const outcome = refuse();
    assert.equal(outcome.status, diskTooLowRunnerExitCode, outcome.stderr);
    assert.equal(outcome.duLog, '', 'nothing was measured on the way to the refusal');
    assert.match(outcome.stderr, /2 project copies, their sizes are still being measured; free space with `charness remote-run clean <slug>`/);
  });

  it('names the copies that have a written size and counts the others', () => {
    writeJob(makeCopy('big-qqqqqqqqqq', 41, 2 * hourMs), 'box1-busy00', { 'task-id': '2\n' });
    writeJob(makeCopy('mid-rrrrrrrrrr', 30, 2 * hourMs), 'box1-busy01', { 'task-id': '3\n' });
    writeFile(path.join(workDir, 'p', 'big-qqqqqqqqqq'), 'size-kb', `${41 * kibPerGib}`);
    const outcome = refuse();
    assert.equal(outcome.status, diskTooLowRunnerExitCode, outcome.stderr);
    assert.equal(outcome.duLog, '');
    assert.match(outcome.stderr, /biggest project copies: big-qqqqqqqqqq 41 GB \(and 1 not measured yet\); free space with/);
  });
});

describe('a disk whose free figure does not follow the removals (APFS snapshots, purgeable space)', () => {
  function writeSizes(): void {
    assert.equal(runScript(['measure-copies', workDir]).status, 0);
  }

  /** A copy measured at `sizeGib` whose removal gives `freedGib` back to the fake disk (0: as on a disk whose free figure does not follow). */
  function makeCopyFreeing(copySlug: string, sizeGib: number, freedGib: number, usedAgoMs: number): void {
    makeCopy(copySlug, freedGib, usedAgoMs);
    writeFile(path.join(workDir, 'p', copySlug), 'size-kb', `${sizeGib * kibPerGib}`);
  }

  it('stops after two removals IN A ROW that freed next to nothing from copies measured bigger — instead of removing every idle copy — and says so', () => {
    makeCopy('oldest-aaaaaaaaaa', 30, 5 * hourMs);
    makeCopy('middle-bbbbbbbbbb', 30, 3 * hourMs);
    makeCopy('newest-cccccccccc', 30, 1 * hourMs);
    writeSizes();
    const result = runScript(['prune', workDir], { REMOTE_RUN_MIN_FREE_GB: '70', FAKE_DF_FREE_KB: `${10 * kibPerGib}` });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(parseRemovals(result.stdout), ['oldest-aaaaaaaaaa', 'middle-bbbbbbbbbb'], 'two removals that gave nothing back, and the prune stopped');
    assert.match(result.stdout, /^stopped=middle-bbbbbbbbbb freed_kb=0 size_kb=31457280$/m);
    assert.deepEqual(listCopies(), ['newest-cccccccccc']);
  });

  it('one removal that gave little back is not a verdict (a job writing to the same disk meanwhile can eat what it freed): it goes on, and a removal that did free resets the count', () => {
    // no gain (count 1) · gain (reset) · no gain (count 1 again, not 2) · gain: all four go, and nothing says «stopped».
    makeCopyFreeing('c1-aaaaaaaaaa', 30, 0, 9 * hourMs);
    makeCopyFreeing('c2-bbbbbbbbbb', 30, 30, 7 * hourMs);
    makeCopyFreeing('c3-cccccccccc', 30, 0, 5 * hourMs);
    makeCopyFreeing('c4-dddddddddd', 30, 30, 3 * hourMs);
    const result = runScript(['prune', workDir], { REMOTE_RUN_MIN_FREE_GB: '95' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(parseRemovals(result.stdout), ['c1-aaaaaaaaaa', 'c2-bbbbbbbbbb', 'c3-cccccccccc', 'c4-dddddddddd']);
    assert.doesNotMatch(result.stdout, /stopped=/);
  });

  it('goes on while it cannot tell: a copy with no written size, or a small one, gives little back by itself', () => {
    makeCopy('oldest-aaaaaaaaaa', 30, 5 * hourMs);
    makeCopy('small-bbbbbbbbbb', 0, 3 * hourMs);
    writeFile(path.join(workDir, 'p', 'small-bbbbbbbbbb'), 'size-kb', '500000');
    makeCopy('newest-cccccccccc', 30, 1 * hourMs);
    const result = runScript(['prune', workDir], { REMOTE_RUN_MIN_FREE_GB: '70', FAKE_DF_FREE_KB: `${10 * kibPerGib}` });
    assert.deepEqual(parseRemovals(result.stdout), ['oldest-aaaaaaaaaa', 'small-bbbbbbbbbb', 'newest-cccccccccc'], 'no figure for the first, a small one for the second: nothing to conclude');
    assert.doesNotMatch(result.stdout, /stopped=/);
  });

  it('the refusal that follows names the causes', () => {
    writeJob(makeCopy('busy-aaaaaaaaaa', 30, 7 * hourMs), 'box1-busy00', { 'task-id': '2\n' });
    makeCopy('removable-bbbbbbbbbb', 30, 5 * hourMs);
    makeCopy('removable-cccccccccc', 30, 3 * hourMs);
    writeSizes();
    const result = runScript(['prepare', workDir, slug, jobId, 'default=1'], { REMOTE_RUN_MIN_FREE_GB: '70', FAKE_DF_FREE_KB: `${10 * kibPerGib}` });
    assert.equal(result.status, diskTooLowRunnerExitCode);
    assert.match(result.stderr, /Removing copies did not give their space back \(on a Mac: APFS local snapshots or purgeable space; anywhere: jobs writing meanwhile, see docs\/remote-run\.md\)/);
  });
});

describe('the probe that picks a runner for a run or an `exec` never prunes (only a view of the runners does)', () => {
  it('on a short disk it starts no prune, and nothing is removed; the probe of a view does start it', () => {
    makeCopy('oldest-aaaaaaaaaa', 45, 5 * hourMs);
    makeCopy('newest-cccccccccc', 45, 1 * hourMs);
    assert.equal(runScript(['probe', workDir]).status, 0);
    assert.equal(fs.existsSync(path.join(workDir, 'tmp', 'prune.pid')), false, 'no detached prune was started');
    assert.deepEqual(listCopies(), ['newest-cccccccccc', 'oldest-aaaaaaaaaa']);
    assert.equal(runScript(['probe', workDir, 'prune']).status, 0);
    assert.equal(fs.existsSync(path.join(workDir, 'tmp', 'prune.pid')), true, 'a view\'s probe does');
  });

  it('the project about to be used is the least recently used copy: the probe of its own submit leaves it alone, and the `prepare` that follows keeps it and removes the others instead', () => {
    const projectDir = makeCopy(slug, 30, 9 * hourMs);
    makeCopy('other-one-aaaaaaaaaa', 30, 5 * hourMs);
    makeCopy('other-two-bbbbbbbbbb', 30, 3 * hourMs);
    assert.equal(runScript(['probe', workDir]).status, 0, 'what chooseClient does first');
    const result = runScript(['prepare', workDir, slug, jobId, 'default=1'], { REMOTE_RUN_MIN_FREE_GB: '70' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(parseRemovals(result.stdout), ['other-one-aaaaaaaaaa', 'other-two-bbbbbbbbbb']);
    assert.ok(fs.existsSync(path.join(projectDir, 'tree/file.txt')), 'the project\'s copy survived: no from-scratch send, no from-scratch build');
    assert.ok(fs.existsSync(path.join(projectDir, 'jobs', jobId)));
  });
});

describe('a pid that went to a stranger pins nothing (after a crash or a reboot pids start again from low numbers)', () => {
  it('an `exec` marker, a prune marker and a trash folder whose pid is a live process that is NOT the runner script\'s are as good as dead — and cleared or finished', () => {
    const strangerPid = startStrangerProcess();
    const copyDir = makeCopy('stranger-marker-aaaaaaaa', 1, 9 * hourMs);
    writeFile(copyDir, `exec.${strangerPid}`, `${strangerPid}\n`);
    assert.equal(runShell(`check_copy_dir_is_busy ${copyDir} && echo busy || echo free`).stdout, 'free');
    assert.equal(fs.existsSync(path.join(copyDir, `exec.${strangerPid}`)), false);
    writeFile(path.join(workDir, 'p', `.trash-orphan-bbbbbbbbbb-${strangerPid}`), 'tree/file.txt');
    assert.equal(runShell(`remove_leftover_trash ${workDir}`).status, 0);
    assert.equal(fs.existsSync(path.join(workDir, 'p', `.trash-orphan-bbbbbbbbbb-${strangerPid}`)), false, 'the trash of tens of GB is finished, not left for good');
  });

  it('a pid file of a detached run that names a stranger does not stop the next one from starting', async () => {
    writeFile(workDir, 'tmp/measure-copies.pid', `${startStrangerProcess()}\n`);
    makeCopy('unmeasured-aaaaaaaaaa', 3, hourMs);
    assert.equal(runScript(['probe', workDir]).status, 0);
    const sizeFile = path.join(workDir, 'p', 'unmeasured-aaaaaaaaaa', 'size-kb');
    const deadline = Date.now() + 20_000;
    while (!fs.existsSync(sizeFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(fs.existsSync(sizeFile), 'the detached measuring ran');
  });

  it('a process that IS the runner script\'s (a live exec) still counts', () => {
    const copyDir = makeCopy('real-marker-aaaaaaaaaa', 1, 9 * hourMs);
    const livePid = startLiveProcess();
    writeFile(copyDir, `exec.${livePid}`, `${livePid}\n`);
    assert.equal(runShell(`check_copy_dir_is_busy ${copyDir} && echo busy || echo free`).stdout, 'busy');
  });
});

describe('a submit waits behind another prune only while its own disk is short', () => {
  it('with the disk at its target it does not wait for the prune that is removing idle copies (it has nothing to remove: the other one does it)', () => {
    makeCopy('idle-aaaaaaaaaa', 30, 5 * hourMs);
    writeFile(workDir, 'tmp/prune.lock', `${startLiveProcess()}\n`);
    const outcome = runShell(`prune_wait_sec=20; prune_poll_sec=0.2; started=$SECONDS; prune_work ${workDir} ""; echo waited=$((SECONDS - started))`, { REMOTE_RUN_MIN_FREE_GB: '5' });
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.match(outcome.stdout, /waited=[0-2]$/);
    assert.deepEqual(listCopies(), ['idle-aaaaaaaaaa']);
  });
});

describe('a put-back that meets a folder somebody just made', () => {
  it('does not leave the copy nested INSIDE it (where no prune looks and its markers cannot be seen): it comes out again, under its trash name', () => {
    makeCopy('late-busy-dddddddddd', 5, 9 * hourMs);
    // After the rename a `prepare` plants a job in the moved copy (so it must go back), and makes the folder of the name just before the `mv` that puts it back.
    const body = `mv() { if [[ "$1" == */.trash-* && "$2" != */.trash-* ]]; then command mkdir -p "$2"; fi; command mv "$@"; case "$2" in */.trash-*) command mkdir -p "$2/jobs/box1-latejb" ;; esac; }; remove_project_copy ${workDir} late-busy-dddddddddd; echo code=$?`;
    const outcome = runShell(body);
    assert.equal(outcome.stdout.split('=').pop(), '3', outcome.stdout);
    const names = fs.readdirSync(path.join(workDir, 'p')).sort();
    assert.equal(names.length, 2, names.join(', '));
    assert.ok(names.includes('late-busy-dddddddddd'), 'the new folder of the name is there');
    assert.deepEqual(fs.readdirSync(path.join(workDir, 'p', 'late-busy-dddddddddd')), [], 'with nothing nested in it');
    const trashName = names.find((name) => name.startsWith('.trash-late-busy-dddddddddd-'));
    assert.ok(trashName !== undefined && fs.existsSync(path.join(workDir, 'p', trashName, 'jobs', 'box1-latejb')), 'the copy is whole under its trash name');
  });
});

describe('a caller that hangs up while `prepare` removes copies', () => {
  it('does not stop the removal half-way: the closed pipe is no reason to die (SIGPIPE would end it after the copy it is at)', async () => {
    makeCopy('oldest-aaaaaaaaaa', 30, 5 * hourMs);
    makeCopy('middle-bbbbbbbbbb', 30, 3 * hourMs);
    makeCopy('newest-cccccccccc', 30, 1 * hourMs);
    const child = spawn('bash', [scriptPath, 'prepare', workDir, slug, jobId, 'default=1'], { env: getEnv({ REMOTE_RUN_MIN_FREE_GB: '60', FAKE_RM_DELAY: '0.8' }), stdio: ['ignore', 'pipe', 'ignore'] });
    // The ssh call is gone before the first removal ends.
    child.stdout.destroy();
    await new Promise<void>((resolve) => { child.on('close', () => resolve()); });
    assert.deepEqual(listCopies(), ['newest-cccccccccc', slug].sort(), 'both copies that had to go are gone');
  });
});
