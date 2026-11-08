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
import { jobId, scriptPath, slug, startRunnerStandIn, startStrangerProcess, stopRunnerStandIns, writeFile } from './remoteRunRunnerScriptKit';

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

/** Other children the tests keep (an `exec`, a prune): the hook below ends them with the stand-ins of the kit. */
const liveProcesses: ChildProcess[] = [];

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
  stopRunnerStandIns();
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
      const removed = pruneWithOldestProtected((copyDir) => writeFile(copyDir, 'lock', `${startRunnerStandIn()}\n${jobId}\n`));
      assert.deepEqual(removed, ['free-one-iiiiiiiiii', 'free-two-jjjjjjjjjj']);
      assert.ok(fs.existsSync(path.join(workDir, 'p', 'keep-hhhhhhhhhh')));
    });

    it('a job of it waits in the queue (a task, no process yet)', () => {
      const removed = pruneWithOldestProtected((copyDir) => writeJob(copyDir, 'box1-queued', { 'task-id': '4\n' }));
      assert.deepEqual(removed, ['free-one-iiiiiiiiii', 'free-two-jjjjjjjjjj']);
      assert.ok(fs.existsSync(path.join(workDir, 'p', 'keep-hhhhhhhhhh')));
    });

    it('a job of it runs (a task and a live process)', () => {
      const removed = pruneWithOldestProtected((copyDir) => writeJob(copyDir, 'box1-runnin', { 'task-id': '5\n', pid: `${startRunnerStandIn()}\n` }));
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
    // The figures an earlier measuring wrote while these copies were idle (the measuring leaves a copy that is in use alone, so it cannot take them now).
    for (const [copyDir, sizeGib] of [[busyDir, 41], [secondDir, 30], [path.join(workDir, 'p', 'tiny-ssssssssss'), 1]] as const) writeFile(copyDir, 'size-kb', `${sizeGib * kibPerGib}`);
    const result = runScript(['prepare', workDir, slug, jobId, 'default=1'], { REMOTE_RUN_MIN_FREE_GB: '60' });
    assert.equal(result.status, diskTooLowRunnerExitCode, result.stderr);
    const lines = result.stderr.trim().split('\n');
    assert.equal(lines.length, 1, 'one line, so the CLI shows it whole');
    assert.match(lines[0], /^remote-run-runner: only 28 GB free on the work disk, the runner needs 60 GB; biggest project copies: big-qqqqqqqqqq 41 GB, mid-rrrrrrrrrr 30 GB, tiny-ssssssssss 1 GB; free space with `charness remote-run clean <slug>`/);
    assert.match(lines[0], /on the copies of project folders whose last task is closed \(`charness remote-run runners` shows what they take\)/, 'a copy is a folder\'s, shared by its tasks: an agent that read «your own finished tasks» would clean one a sibling task still uses');
    assert.doesNotMatch(lines[0], /your own finished tasks/);
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

  it('leaves a copy that is IN USE alone once it has a figure — it would be wrong as soon as the build writes, and the walk would compete with the build — walks one with NO figure once anyway, and measures the first again when nothing uses it', () => {
    const busyDir = makeCopy('busy-ffffffffff', 5, hourMs);
    writeFile(busyDir, 'size-kb', '1');
    setAge(sizeFile('busy-ffffffffff'), 2 * hourMs);
    const execPid = startRunnerStandIn();
    writeFile(busyDir, `exec.${execPid}`, `${execPid}\n`);
    const newDir = makeCopy('new-jjjjjjjjjj', 9, hourMs);
    const newPid = startRunnerStandIn();
    writeFile(newDir, `exec.${newPid}`, `${newPid}\n`);
    makeCopy('idle-gggggggggg', 3, hourMs);
    assert.equal(runScript(['measure-copies', workDir]).status, 0);
    assert.equal(fs.readFileSync(sizeFile('busy-ffffffffff'), 'utf8').trim(), '1', 'a copy an `exec` runs in keeps the figure it has');
    assert.equal(fs.readFileSync(sizeFile('new-jjjjjjjjjj'), 'utf8').trim(), `${9 * kibPerGib}`, 'one in use that never had a figure is walked once — a refusal on a short disk names the copies it can');
    assert.equal(fs.readFileSync(sizeFile('idle-gggggggggg'), 'utf8').trim(), `${3 * kibPerGib}`, 'the idle one is measured');
    fs.rmSync(path.join(busyDir, `exec.${execPid}`));
    assert.equal(runScript(['measure-copies', workDir]).status, 0);
    assert.equal(fs.readFileSync(sizeFile('busy-ffffffffff'), 'utf8').trim(), `${5 * kibPerGib}`, 'after the exec: measured again');
  });

  /** The detached `measure-copies` that a call started has ended (its pid is gone). */
  async function waitForDetachedMeasuringToEnd(): Promise<void> {
    const pidFile = path.join(workDir, 'tmp', 'measure-copies.pid');
    const detachedPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    await waitFor(() => {
      try {
        process.kill(detachedPid, 0);
        return false;
      } catch {
        return true;
      }
    }, 'the detached measuring to end');
  }

  it('a submit that goes on (the disk is fine) starts no measuring of the other copies; one that is refused for a short disk does — the refusal names the biggest copies for the next submit', async () => {
    makeCopy('neighbour-hhhhhhhhhh', 10, 5 * hourMs);
    const prepared = runScript(['prepare', workDir, slug, jobId, 'default=1'], { REMOTE_RUN_MIN_FREE_GB: '10' });
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.equal(fs.existsSync(path.join(workDir, 'tmp', 'measure-copies.pid')), false, 'no walk over the neighbour\'s tree for a submit that is not refused');
    const busyDir = makeCopy('busy-iiiiiiiiii', 45, 2 * hourMs);
    writeJob(busyDir, 'box1-busy03', { 'task-id': '5\n' });
    const refused = runScript(['prepare', workDir, slug, 'box1-second', 'default=1'], { REMOTE_RUN_MIN_FREE_GB: '60' });
    assert.equal(refused.status, diskTooLowRunnerExitCode, refused.stderr);
    assert.equal(fs.existsSync(path.join(workDir, 'tmp', 'measure-copies.pid')), true, 'the refusal started the measuring');
    assert.match(refused.stderr, /their sizes are still being measured/, 'the copies in use have no figure yet');
    await waitForDetachedMeasuringToEnd();
    assert.equal(fs.readFileSync(sizeFile('busy-iiiiiiiiii'), 'utf8').trim(), `${45 * kibPerGib}`, 'the measuring walked the copy in use that had no figure — once');
    const refusedAgain = runScript(['prepare', workDir, slug, 'box1-third0', 'default=1'], { REMOTE_RUN_MIN_FREE_GB: '60' });
    assert.equal(refusedAgain.status, diskTooLowRunnerExitCode, refusedAgain.stderr);
    assert.match(refusedAgain.stderr, /biggest project copies: busy-iiiiiiiiii 45 GB/, 'and the next refusal names it');
    await waitForDetachedMeasuringToEnd();
  });

  it('probe counts the copies and sums their written figures at once, and starts the measuring of the missing ones detached', async () => {
    makeCopy('known-yyyyyyyyyy', 7, hourMs);
    writeFile(path.join(workDir, 'p', 'known-yyyyyyyyyy'), 'size-kb', `${7 * kibPerGib}`);
    makeCopy('unknown-zzzzzzzzzz', 3, hourMs);
    const result = runScript(['probe', workDir, 'prune']);
    assert.equal(result.status, 0, result.stderr);
    const probe = parseProbeOutput(result.stdout);
    assert.deepEqual(probe.copies, { count: 2, sizeMb: 7 * 1024, unmeasuredCount: 1 });
    assert.equal(probe.diskMinFreeMb, 15 * 1024, 'the default target of a 100 GB disk: 15 %');
    await waitFor(() => fs.existsSync(sizeFile('unknown-zzzzzzzzzz')), 'the detached measuring');
    assert.equal(fs.readFileSync(sizeFile('unknown-zzzzzzzzzz'), 'utf8').trim(), `${3 * kibPerGib}`);
  });

  it('the probe a run or an `exec` makes first (no `prune`) counts the copies the same, but starts NO measuring: the copy about to be built is not walked as its build begins', () => {
    makeCopy('known-kkkkkkkkkk', 7, hourMs);
    writeFile(path.join(workDir, 'p', 'known-kkkkkkkkkk'), 'size-kb', `${7 * kibPerGib}`);
    setAge(sizeFile('known-kkkkkkkkkk'), 2 * hourMs);
    makeCopy('unknown-llllllllll', 3, hourMs);
    const result = runScript(['probe', workDir]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(parseProbeOutput(result.stdout).copies, { count: 2, sizeMb: 7 * 1024, unmeasuredCount: 2 }, 'both are unmeasured: one has no figure, the other was used after its figure');
    assert.equal(fs.existsSync(path.join(workDir, 'tmp', 'measure-copies.pid')), false, 'and nothing was started');
    assert.equal(fs.existsSync(sizeFile('unknown-llllllllll')), false);
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
    writeFile(workDir, 'tmp/measure-copies.pid', `${startRunnerStandIn()}\n`);
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
    const livePid = startRunnerStandIn();
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
    const livePid = startRunnerStandIn();
    const deadPid = getDeadPid();
    writeFile(path.join(workDir, 'p', `.trash-being-removed-${livePid}`), 'tree/file.txt');
    writeFile(path.join(workDir, 'p', `.trash-cut-off-${deadPid}`), 'tree/file.txt');
    assert.equal(runShell(`remove_leftover_trash ${workDir}`).status, 0);
    assert.ok(fs.existsSync(path.join(workDir, 'p', `.trash-being-removed-${livePid}`)));
    assert.equal(fs.existsSync(path.join(workDir, 'p', `.trash-cut-off-${deadPid}`)), false);
  });

  it('the probe\'s detached prune (`prune`) leaves the copy-removal step to a prune that is at it, and says nothing — the lock stays the other\'s', () => {
    makeThreeCopies();
    const livePid = startRunnerStandIn();
    putPruneLock(livePid);
    const result = runScript(['prune', workDir], { REMOTE_RUN_MIN_FREE_GB: '70' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(listCopies().length, 3);
    assert.equal(fs.readFileSync(lockFile(), 'utf8').trim(), `${livePid}`);
  });

  it('in skip mode it leaves at once even though its disk is short — it never waits (a probe must not hang)', () => {
    makeThreeCopies();
    putPruneLock(startRunnerStandIn());
    const outcome = runShell(`prune_wait_sec=3; prune_poll_sec=0.2; started=$SECONDS; prune_work ${workDir} "" skip; echo waited=$((SECONDS - started))`, { REMOTE_RUN_MIN_FREE_GB: '70' });
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.match(outcome.stdout, /waited=[0-2]$/, 'not the 3 s of the wait it must not make');
    assert.equal(listCopies().length, 3, 'and it removed nothing: after a wait it would have gone on without the lock');
  });

  describe('a lock that nobody holds any more is taken over, and the prune goes on', () => {
    const scenarios: Array<[string, () => void]> = [
      ['its holder is gone', () => { putPruneLock(getDeadPid()); }],
      ['its pid went to a stranger (a daemon after a reboot)', () => { putPruneLock(startStrangerProcess()); }],
      ['it is over two hours old (a pid can be given to anything)', () => { putPruneLock(startRunnerStandIn(), 3 * hourMs); }],
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

    it('a right to break the lock that its winner died holding does not block anybody: the next generation takes it (the project lock\'s rule, not a second copy of it)', () => {
      const deadHolder = getDeadPid();
      putPruneLock(deadHolder);
      writeFile(workDir, `tmp/prune.lock.breaking.${deadHolder}.none.0`, `${getDeadPid()}\n\n`);
      const outcome = runShell(`acquire_prune_lock ${workDir} && echo won || echo lost`);
      assert.equal(outcome.stdout, 'won');
    });

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

    it('a stale verdict made on an old read does not break a fresh lock: a process that was slow after reading the stale holder finds somebody else\'s lock when it goes on, and leaves it alone', async () => {
      putPruneLock(getDeadPid());
      const flag = path.join(workRoot, 'stalled-once');
      // B reads the stale holder and stalls for a second, once; A comes 0.3 s later, breaks the lock and takes a fresh one. When B goes on, the lock is A's and must stay.
      const slowReader = `eval "orig_$(declare -f read_lock_holder)"; read_lock_holder() { orig_read_lock_holder "$@"; case "$1" in *prune.lock) [ -e ${flag} ] || { : > ${flag}; sleep 1; } ;; esac; }; acquire_prune_lock ${workDir} && { echo B-won; sleep 3; } || echo B-lost`;
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
    const otherLock = putPruneLock(startRunnerStandIn());
    // The other prune ends its work after a second: it removed the oldest copy and its lock goes.
    const body = `prune_poll_sec=0.1; ( sleep 1; command rm -rf "${path.join(workDir, 'p', 'oldest-aaaaaaaaaa')}" "${otherLock}" ) & started=$SECONDS; prune_work ${workDir} ""; echo waited=$((SECONDS - started))`;
    const outcome = runShell(body, { REMOTE_RUN_MIN_FREE_GB: '40' });
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.deepEqual(listCopies(), ['middle-bbbbbbbbbb', 'newest-cccccccccc'], 'it removed nothing of its own: 40 GB were free once the other was done');
    assert.match(outcome.stdout, /waited=[1-9]/);
  });

  it('the wait is bounded: a prune that never ends is waited for prune_wait_sec, then the submit goes on without the lock — and leaves the other\'s lock alone', () => {
    makeThreeCopies();
    const livePid = startRunnerStandIn();
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
    writeFile(workDir, 'tmp/measure-copies.pid', `${startRunnerStandIn()}\n`);
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

  it('a small copy between two big ones that freed nothing neither hides nor resets the verdict (an LRU order of big, small, big must not empty the runner of its big copies for nothing)', () => {
    makeCopyFreeing('big-one-aaaaaaaaaa', 30, 0, 9 * hourMs);
    makeCopyFreeing('small-bbbbbbbbbb', 0, 0, 7 * hourMs);
    writeFile(path.join(workDir, 'p', 'small-bbbbbbbbbb'), 'size-kb', '500000');
    makeCopyFreeing('big-two-cccccccccc', 30, 0, 5 * hourMs);
    makeCopyFreeing('big-three-dddddddddd', 30, 0, 3 * hourMs);
    // A disk whose free figure does not move at all (frozen at 10 GB, short of the 95 GB wanted).
    const result = runScript(['prune', workDir], { REMOTE_RUN_MIN_FREE_GB: '95', FAKE_DF_FREE_KB: `${10 * kibPerGib}` });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(parseRemovals(result.stdout), ['big-one-aaaaaaaaaa', 'small-bbbbbbbbbb', 'big-two-cccccccccc'], 'two big copies gave nothing back, whatever came between them');
    assert.match(result.stdout, /^stopped=big-two-cccccccccc freed_kb=0 size_kb=31457280$/m);
    assert.deepEqual(listCopies(), ['big-three-dddddddddd']);
  });

  it('a copy with no written size leaves the count as it is too: big (nothing), unmeasured, big (nothing) is two in a row', () => {
    makeCopyFreeing('big-one-aaaaaaaaaa', 30, 0, 9 * hourMs);
    makeCopy('unmeasured-bbbbbbbbbb', 0, 7 * hourMs);
    makeCopyFreeing('big-two-cccccccccc', 30, 0, 5 * hourMs);
    makeCopyFreeing('big-three-dddddddddd', 30, 0, 3 * hourMs);
    const result = runScript(['prune', workDir], { REMOTE_RUN_MIN_FREE_GB: '95', FAKE_DF_FREE_KB: `${10 * kibPerGib}` });
    assert.deepEqual(parseRemovals(result.stdout), ['big-one-aaaaaaaaaa', 'unmeasured-bbbbbbbbbb', 'big-two-cccccccccc']);
    assert.deepEqual(listCopies(), ['big-three-dddddddddd']);
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
    assert.equal(runScript(['probe', workDir, 'prune']).status, 0);
    const sizeFile = path.join(workDir, 'p', 'unmeasured-aaaaaaaaaa', 'size-kb');
    const deadline = Date.now() + 20_000;
    while (!fs.existsSync(sizeFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(fs.existsSync(sizeFile), 'the detached measuring ran');
  });

  it('a process that IS the runner script\'s (a live exec) still counts', () => {
    const copyDir = makeCopy('real-marker-aaaaaaaaaa', 1, 9 * hourMs);
    const livePid = startRunnerStandIn();
    writeFile(copyDir, `exec.${livePid}`, `${livePid}\n`);
    assert.equal(runShell(`check_copy_dir_is_busy ${copyDir} && echo busy || echo free`).stdout, 'busy');
  });

  it('a JOB whose recorded pid is a stranger\'s (it died with the machine) and a project LOCK held by a stranger\'s pid do not keep the copy in use — the job or the lock that are really there still do', () => {
    const isBusy = (copyDir: string): string => runShell(`check_copy_dir_is_busy ${copyDir} && echo busy || echo free`).stdout;
    const strangerJob = makeCopy('stranger-job-aaaaaaaaaa', 1, 9 * hourMs);
    setAge(writeJob(strangerJob, 'box1-crashed', { 'task-id': '4\n', pid: `${startStrangerProcess()}\n` }), 2 * hourMs);
    assert.equal(isBusy(strangerJob), 'free', 'the job it names is no process of the script');
    const strangerLock = makeCopy('stranger-lock-bbbbbbbbbb', 1, 9 * hourMs);
    writeFile(strangerLock, 'lock', `${startStrangerProcess()}\nbox1-crashed\n`);
    assert.equal(isBusy(strangerLock), 'free', 'nobody holds the lock');
    const liveJob = makeCopy('live-job-cccccccccc', 1, 9 * hourMs);
    setAge(writeJob(liveJob, 'box1-runnin', { 'task-id': '4\n', pid: `${startRunnerStandIn()}\n` }), 2 * hourMs);
    assert.equal(isBusy(liveJob), 'busy');
    const liveLock = makeCopy('live-lock-dddddddddd', 1, 9 * hourMs);
    writeFile(liveLock, 'lock', `${startRunnerStandIn()}\nbox1-runnin\n`);
    assert.equal(isBusy(liveLock), 'busy');
  });
});

describe('the script\'s test of "that pid is still one of ours" (`check_runner_pid_alive`)', () => {
  const alive = (pid: number | string, env: NodeJS.ProcessEnv = {}): string => runShell(`check_runner_pid_alive ${pid} && echo alive || echo not`, env).stdout;
  const startNamed = (argv0: string): number => {
    const child = spawn('bash', ['-c', 'read -r _', argv0, 'job'], { stdio: ['pipe', 'ignore', 'ignore'] });
    liveProcesses.push(child);
    assert.ok(child.pid !== undefined);
    return child.pid;
  };

  it('is the script\'s own file name, whatever its version or the way it was started — and nothing that merely has «runner» in its name', () => {
    const named = startNamed;
    assert.equal(alive(named('/work/bin/runner-0a1b2c3d.sh')), 'alive', 'the uploaded script');
    assert.equal(alive(named('/other/version/runner-ffffffff.sh')), 'alive', 'another version of it');
    assert.equal(alive(named('/repo/remoteRun/runner.sh')), 'alive', 'run from a checkout');
    assert.equal(alive(named('/Users/user/actions-runner/runsvc.sh')), 'not', 'GitHub\'s runner service, a long-lived process on build Macs');
    assert.equal(alive(named('/opt/some-runner-tool/start.sh')), 'not');
  });

  it('the name is the LAST path component and exactly the shape the hub uploads: a script under a folder called runner-… (a self-hosted CI runner installed as runner-01) is a stranger, so is a hash of another length or a letter past f', () => {
    assert.equal(alive(startNamed('/Users/user/runner-01/runsvc.sh')), 'not', 'a second GitHub runner on one Mac, installed as runner-01');
    assert.equal(alive(startNamed('/Users/user/runner-01/bin/run.sh')), 'not');
    assert.equal(alive(startNamed('/work/bin/runner-0123abc.sh')), 'not', 'seven hex digits');
    assert.equal(alive(startNamed('/work/bin/runner-0123abcde.sh')), 'not', 'nine hex digits');
    assert.equal(alive(startNamed('/work/bin/runner-0123abcg.sh')), 'not', 'not hex');
    assert.equal(alive(startNamed('/work/bin/runner-0123ABCD.sh')), 'not', 'the hash is lowercase');
    assert.equal(alive(startNamed('/Users/user/runner-01/bin/runner-0a1b2c3d.sh')), 'alive', 'the script itself, in a work dir whose own path has runner-01 in it');
  });

  it('the whole command line is asked for: a short exported COLUMNS (a profile read by the ssh exec, a service unit) cuts what a plain `ps` prints, and a LIVE job must not read as a stranger because its long path was cut', () => {
    const longPath = `/Volumes/an-external-disk-with-a-long-name/charness-runner-work/bin/runner-0a1b2c3d.sh`;
    const pid = startNamed(longPath);
    assert.equal(alive(pid, { COLUMNS: '20' }), 'alive');
    assert.equal(alive(pid, { COLUMNS: '5' }), 'alive');
    assert.equal(alive(startStrangerProcess(), { COLUMNS: '20' }), 'not', 'and a stranger is still a stranger');
  });

  it('is not alive for a process that is gone, a pid that is no number, or a stranger', () => {
    assert.equal(alive(getDeadPid()), 'not');
    assert.equal(alive("'1; echo hacked'"), 'not');
    assert.equal(alive(startStrangerProcess()), 'not');
    assert.equal(alive(startRunnerStandIn()), 'alive');
  });

  it('a `ps` that cannot answer (rejects the options, or says nothing) is no evidence against a process that is there: it counts as alive — a live exec must never be read as dead', () => {
    const strangerPid = startStrangerProcess();
    const deadPid = getDeadPid();
    for (const [name, body] of [['fails', 'exit 1'], ['says nothing', 'exit 0'], ['rejects the options', 'echo "ps: invalid option -- p" >&2; exit 1']] as const) {
      writeExecutable(path.join(fakeBinDir, 'ps'), `#!/bin/sh\n${body}\n`);
      assert.equal(alive(strangerPid), 'alive', `a ps that ${name}`);
      assert.equal(alive(deadPid), 'not', `a dead pid is dead whatever ps does (${name})`);
    }
  });
});

describe('a submit waits behind another prune only while its own disk is short', () => {
  it('with the disk at its target it does not wait for the prune that is removing idle copies (it has nothing to remove: the other one does it)', () => {
    makeCopy('idle-aaaaaaaaaa', 30, 5 * hourMs);
    writeFile(workDir, 'tmp/prune.lock', `${startRunnerStandIn()}\n`);
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

describe('`clean`: the owner of a task removes its project copy on request', () => {
  const clean = (copySlug: string, env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } => runScript(['clean', workDir, copySlug], env);

  it('removes the named copy only — read-only folders included — and says what it freed; the other copies are untouched', () => {
    const copyDir = makeCopy('task-aaaaaaaaaa', 41, 1 * hourMs);
    writeFile(copyDir, 'tree/ios/Pods/Core.xcframework/Headers/a.h');
    fs.chmodSync(path.join(copyDir, 'tree/ios/Pods/Core.xcframework/Headers'), 0o555);
    fs.chmodSync(path.join(copyDir, 'tree/ios/Pods/Core.xcframework'), 0o555);
    makeCopy('other-bbbbbbbbbb', 30, 2 * hourMs);
    const result = clean('task-aaaaaaaaaa');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `removed=task-aaaaaaaaaa freed_kb=${41 * kibPerGib} why=clean\n`);
    assert.deepEqual(fs.readdirSync(path.join(workDir, 'p')), ['other-bbbbbbbbbb'], 'nothing is left of it, not even a moved-aside folder');
    assert.ok(fs.existsSync(path.join(workDir, 'p', 'other-bbbbbbbbbb', 'tree/file.txt')));
  });

  it('a copy that is not there is «absent», not an error; a name that is no plain copy name is refused before anything is touched', () => {
    makeCopy('other-bbbbbbbbbb', 1, hourMs);
    const result = clean('never-there-aaaaaaaaaa');
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'absent=never-there-aaaaaaaaaa\n');
    for (const bad of ['../other-bbbbbbbbbb', '.trash-x-1', 'a/b', '']) {
      const refused = clean(bad);
      assert.equal(refused.status, 125, bad);
      assert.match(refused.stderr, /bad name/, bad);
    }
    assert.deepEqual(listCopies(), ['other-bbbbbbbbbb']);
  });

  describe('a copy that is in use is refused, and left exactly as it was', () => {
    const refusalFor = (setUp: (copyDir: string) => void): string => {
      const copyDir = makeCopy('busy-aaaaaaaaaa', 20, 1 * hourMs);
      setUp(copyDir);
      const result = clean('busy-aaaaaaaaaa');
      assert.equal(result.status, 0, result.stderr);
      assert.ok(fs.existsSync(path.join(copyDir, 'tree/file.txt')), 'nothing of it was removed');
      assert.deepEqual(fs.readdirSync(path.join(workDir, 'p')), ['busy-aaaaaaaaaa'], 'and it was not moved aside');
      return result.stdout.trim();
    };

    it('a job of it runs (a task and a live process)', () => {
      assert.equal(refusalFor((copyDir) => writeJob(copyDir, 'box1-runnin', { 'task-id': '5\n', pid: `${startRunnerStandIn()}\n` })), 'busy=busy-aaaaaaaaaa kind=running job=box1-runnin');
    });

    it('a job that runs holds the project lock too: the answer names the job, not the lock', () => {
      const pid = startRunnerStandIn();
      assert.equal(refusalFor((copyDir) => { writeJob(copyDir, 'box1-runnin', { 'task-id': '5\n', pid: `${pid}\n` }); writeFile(copyDir, 'lock', `${pid}\nbox1-runnin\n`); }), 'busy=busy-aaaaaaaaaa kind=running job=box1-runnin');
    });

    it('a job of it waits in the queue (a task, no process yet)', () => {
      assert.equal(refusalFor((copyDir) => writeJob(copyDir, 'box1-queued', { 'task-id': '4\n' })), 'busy=busy-aaaaaaaaaa kind=queued job=box1-queued');
    });

    it('a job of it is being submitted (no task yet, its job folder or its stage still moving)', () => {
      assert.equal(refusalFor((copyDir) => writeJob(copyDir, 'box1-sendin', { 'meta.json': '{}' })), 'busy=busy-aaaaaaaaaa kind=submitting job=box1-sendin');
      fs.rmSync(path.join(workDir, 'p'), { recursive: true, force: true });
      fs.mkdirSync(path.join(workDir, 'p'));
      assert.equal(refusalFor((copyDir) => { setAge(writeJob(copyDir, 'box1-upload', { log: '' }), 3 * hourMs); writeFile(copyDir, 'stage/box1-upload/projects/app/big-file.bin'); }), 'busy=busy-aaaaaaaaaa kind=submitting job=box1-upload');
    });

    it('an `exec` runs in it', () => {
      assert.equal(refusalFor((copyDir) => { const pid = startRunnerStandIn(); writeFile(copyDir, `exec.${pid}`, `${pid}\n`); }), 'busy=busy-aaaaaaaaaa kind=exec job=-');
    });

    it('its project lock is held by a live job', () => {
      assert.equal(refusalFor((copyDir) => writeFile(copyDir, 'lock', `${startRunnerStandIn()}\n${jobId}\n`)), `busy=busy-aaaaaaaaaa kind=lock job=${jobId}`);
    });
  });

  it('a copy in use is never even MOVED aside (the rename alone would pull the folder from under a running job\'s working directory): the busy check comes before the rename, not only after it', () => {
    const copyDir = makeCopy('busy-aaaaaaaaaa', 20, 1 * hourMs);
    writeJob(copyDir, 'box1-runnin', { 'task-id': '5\n', pid: `${startRunnerStandIn()}\n` });
    const renames = path.join(workRoot, 'renames.log');
    const outcome = runShell(`mv() { echo "$*" >> ${renames}; command mv "$@"; }; cmd_clean ${workDir} busy-aaaaaaaaaa`);
    assert.equal(outcome.stdout, 'busy=busy-aaaaaaaaaa kind=running job=box1-runnin');
    assert.equal(fs.existsSync(renames), false, 'no rename was made');
  });

  it('what only looks like use does not stop it: a job that ENDED a moment ago whose results were FETCHED (the prune keeps such a copy for an hour; `wait` / `fetch` say they have the files), a job or a lock of a pid that went to a stranger, a dead lock', () => {
    const copyDir = makeCopy('done-aaaaaaaaaa', 20, 1 * hourMs);
    writeJob(copyDir, 'box1-justen', { 'task-id': '1\n', exit: '0\n', fetched: '' });
    writeJob(copyDir, 'box1-crashed', { 'task-id': '2\n', pid: `${startStrangerProcess()}\n` });
    setAge(path.join(copyDir, 'jobs', 'box1-crashed'), 2 * hourMs);
    writeFile(copyDir, 'lock', `${getDeadPid()}\nbox1-crashed\n`);
    const result = clean('done-aaaaaaaaaa');
    assert.equal(result.stdout, `removed=done-aaaaaaaaaa freed_kb=${20 * kibPerGib} why=clean\n`);
    assert.deepEqual(listCopies(), []);
  });

  describe('a project copy is shared by every task run from one folder: the results of a job nobody has fetched are not for another task\'s clean to take', () => {
    it('an ended job whose results were never fetched keeps the copy, and the answer names it — the copy is neither moved nor touched', () => {
      const copyDir = makeCopy('shared-aaaaaaaaaa', 20, 1 * hourMs);
      writeJob(copyDir, 'box1-justen', { 'task-id': '1\n', exit: '0\n', log: 'its output\n' });
      const renames = path.join(workRoot, 'renames.log');
      const outcome = runShell(`mv() { echo "$*" >> ${renames}; command mv "$@"; }; cmd_clean ${workDir} shared-aaaaaaaaaa`);
      assert.equal(outcome.stdout, 'busy=shared-aaaaaaaaaa kind=results job=box1-justen');
      assert.equal(fs.existsSync(renames), false);
      assert.equal(fs.readFileSync(path.join(copyDir, 'jobs', 'box1-justen', 'log'), 'utf8'), 'its output\n', 'and the job\'s log is still there to be read');
    });

    it('the same job once it is fetched, and an unfetched one that ended over an hour ago, do not', () => {
      const fetchedDir = makeCopy('fetched-aaaaaaaaaa', 20, 1 * hourMs);
      writeJob(fetchedDir, 'box1-justen', { 'task-id': '1\n', exit: '0\n', fetched: '' });
      assert.match(clean('fetched-aaaaaaaaaa').stdout, /^removed=fetched-aaaaaaaaaa /);
      const oldDir = makeCopy('old-bbbbbbbbbb', 20, 3 * hourMs);
      setAge(path.join(writeJob(oldDir, 'box1-longag', { 'task-id': '2\n', exit: '0\n' }), 'exit'), 2 * hourMs);
      assert.match(clean('old-bbbbbbbbbb').stdout, /^removed=old-bbbbbbbbbb /);
    });

    it('one unfetched job among fetched ones is enough to keep it', () => {
      const copyDir = makeCopy('mixed-aaaaaaaaaa', 20, 1 * hourMs);
      writeJob(copyDir, 'box1-first0', { 'task-id': '1\n', exit: '0\n', fetched: '' });
      writeJob(copyDir, 'box1-second', { 'task-id': '2\n', exit: '0\n' });
      assert.equal(clean('mixed-aaaaaaaaaa').stdout, 'busy=mixed-aaaaaaaaaa kind=results job=box1-second\n');
    });

    it('`fetched` leaves the mark in the job\'s folder — found from the job id alone, as `wait` and `fetch` know only that — and refuses a job that is not there', () => {
      const copyDir = makeCopy('marked-aaaaaaaaaa', 20, 1 * hourMs);
      const jobDir = writeJob(copyDir, 'box1-justen', { 'task-id': '1\n', exit: '0\n' });
      const marked = runScript(['fetched', workDir, '-', 'box1-justen']);
      assert.equal(marked.status, 0, marked.stderr);
      assert.equal(fs.existsSync(path.join(jobDir, 'fetched')), true);
      assert.match(clean('marked-aaaaaaaaaa').stdout, /^removed=marked-aaaaaaaaaa /, 'and a clean now takes the copy');
      const missing = runScript(['fetched', workDir, '-', 'box1-nothing']);
      assert.equal(missing.status, 125);
      assert.match(missing.stderr, /no such job: box1-nothing/);
      const missingInKnownProject = runScript(['fetched', workDir, 'marked-aaaaaaaaaa', 'box1-nothing']);
      assert.equal(missingInKnownProject.status, 125, 'also when the project is named');
      assert.equal(fs.existsSync(path.join(workDir, 'p', 'marked-aaaaaaaaaa', 'jobs', 'box1-nothing')), false, 'and no folder was made for it');
    });

    it('the prune does not look at the mark: it keeps a copy whose job ended lately, fetched or not — it only guesses', () => {
      writeJob(makeCopy('fetched-results-aaaa', 30, 9 * hourMs), 'box1-justen', { 'task-id': '1\n', exit: '0\n', fetched: '' });
      makeCopy('free-bbbbbbbbbb', 30, 5 * hourMs);
      makeCopy('free-cccccccccc', 30, 3 * hourMs);
      assert.deepEqual(parseRemovals(runScript(['prune', workDir], { REMOTE_RUN_MIN_FREE_GB: '70' }).stdout), ['free-bbbbbbbbbb', 'free-cccccccccc']);
      assert.ok(fs.existsSync(path.join(workDir, 'p', 'fetched-results-aaaa')));
    });
  });

  describe('a removal that was cut off, or ran past its caller\'s time limit, leaves its folder under a `.trash-` name — «clean again» finishes it', () => {
    const trashOf = (copySlug: string, removerPid: number): string => path.join(workDir, 'p', `.trash-${copySlug}-${removerPid}`);
    const makeTrash = (copySlug: string, removerPid: number, sizeGib: number): string => {
      writeFile(trashOf(copySlug, removerPid), 'tree/file.txt');
      writeFile(trashOf(copySlug, removerPid), 'fake-kb', `${sizeGib * kibPerGib}`);
      return trashOf(copySlug, removerPid);
    };

    it('with no copy left, only the leftover of a remover that is gone: it is removed and the freed space said — not «absent»', () => {
      const trash = makeTrash('task-aaaaaaaaaa', getDeadPid(), 12);
      writeFile(path.join(workDir, 'p', 'other-bbbbbbbbbb'), 'fake-kb', `${1 * kibPerGib}`);
      const result = clean('task-aaaaaaaaaa');
      assert.equal(result.stdout, `removed=task-aaaaaaaaaa freed_kb=${12 * kibPerGib} why=clean\n`);
      assert.equal(fs.existsSync(trash), false);
      assert.ok(fs.existsSync(path.join(workDir, 'p', 'other-bbbbbbbbbb')));
    });

    it('a leftover whose remover still lives is left to it and said so — «removing», not a second rm of the same folder', () => {
      const trash = makeTrash('task-aaaaaaaaaa', startRunnerStandIn(), 12);
      assert.equal(clean('task-aaaaaaaaaa').stdout, 'removing=task-aaaaaaaaaa\n');
      assert.ok(fs.existsSync(path.join(trash, 'tree/file.txt')));
    });

    it('«clean again» while the earlier removal is still at it: that remover HOLDS the copy-removal lock to the end of its `rm`, yet the answer is `removing=` AT ONCE — not after the wait for the lock', () => {
      const removerPid = startRunnerStandIn();
      const trash = makeTrash('task-aaaaaaaaaa', removerPid, 12);
      writeFile(workDir, 'tmp/prune.lock', `${removerPid}\n`);
      const outcome = runShell(`prune_wait_sec=4; prune_poll_sec=0.2; started=$SECONDS; cmd_clean ${workDir} task-aaaaaaaaaa; echo waited=$((SECONDS - started))`);
      assert.equal(outcome.status, 0, outcome.stderr);
      assert.match(outcome.stdout, /^removing=task-aaaaaaaaaa\nwaited=[01]$/, 'a wait for the lock would have shown as 4');
      assert.ok(fs.existsSync(path.join(trash, 'tree/file.txt')), 'the leftover is the remover\'s');
      assert.equal(fs.readFileSync(path.join(workDir, 'tmp', 'prune.lock'), 'utf8').trim(), `${removerPid}`, 'and so is the lock');
    });

    it('several leftovers, every one with a live remover, and no copy: also `removing=` at once; with one remover gone it is NOT (that one has to be finished, which needs the lock)', () => {
      const first = startRunnerStandIn();
      const second = startRunnerStandIn();
      makeTrash('task-aaaaaaaaaa', first, 12);
      makeTrash('task-aaaaaaaaaa', second, 12);
      writeFile(workDir, 'tmp/prune.lock', `${first}\n`);
      const quick = runShell(`prune_wait_sec=4; prune_poll_sec=0.2; started=$SECONDS; cmd_clean ${workDir} task-aaaaaaaaaa; echo waited=$((SECONDS - started))`);
      assert.match(quick.stdout, /^removing=task-aaaaaaaaaa\nwaited=[01]$/);
      makeTrash('task-aaaaaaaaaa', getDeadPid(), 3);
      const waiting = runShell(`prune_wait_sec=1; prune_poll_sec=0.2; started=$SECONDS; cmd_clean ${workDir} task-aaaaaaaaaa; echo waited=$((SECONDS - started))`);
      assert.match(waiting.stdout, /waited=[1-3]$/, 'it waited for the lock this time');
      assert.match(waiting.stdout, /^removed=task-aaaaaaaaaa /m, 'and then finished the leftover whose remover was gone');
    });

    it('everything there was removed by another process while this call waited for the lock: «nothing there» (`absent=`), never an empty answer — the leftover of a dead remover is taken by the prune that holds the lock', () => {
      const holder = startRunnerStandIn();
      const trash = makeTrash('task-aaaaaaaaaa', getDeadPid(), 12);
      const lock = path.join(workDir, 'tmp', 'prune.lock');
      writeFile(workDir, 'tmp/prune.lock', `${holder}\n`);
      // The prune at work finishes the leftover after a second and gives its lock back.
      const body = `prune_poll_sec=0.1; ( sleep 1; command rm -rf "${trash}"; command rm -f "${lock}" ) & cmd_clean ${workDir} task-aaaaaaaaaa; echo "status=$?"`;
      const outcome = runShell(body);
      assert.equal(outcome.stdout, 'absent=task-aaaaaaaaaa\nstatus=0');
      assert.equal(fs.existsSync(trash), false);
    });

    it('a leftover with a job in it that runs (a copy put aside while it got busy) is not removed: busy, naming the job', () => {
      const trash = makeTrash('task-aaaaaaaaaa', getDeadPid(), 12);
      writeJob(trash, 'box1-runnin', { 'task-id': '5\n', pid: `${startRunnerStandIn()}\n` });
      assert.equal(clean('task-aaaaaaaaaa').stdout, 'busy=task-aaaaaaaaaa kind=running job=box1-runnin\n');
      assert.ok(fs.existsSync(path.join(trash, 'tree/file.txt')));
    });

    it('the copy AND a leftover of it: both go, one removed line each (the CLI adds them up)', () => {
      const trash = makeTrash('task-aaaaaaaaaa', getDeadPid(), 12);
      makeCopy('task-aaaaaaaaaa', 8, 1 * hourMs);
      const result = clean('task-aaaaaaaaaa');
      assert.deepEqual(result.stdout.trim().split('\n'), [`removed=task-aaaaaaaaaa freed_kb=${12 * kibPerGib} why=clean`, `removed=task-aaaaaaaaaa freed_kb=${8 * kibPerGib} why=clean`]);
      assert.equal(fs.existsSync(trash), false);
      assert.deepEqual(listCopies(), []);
    });

    it('the leftover of ANOTHER copy whose name starts with this one\'s is not this copy\'s: it is left alone and this one is «absent»', () => {
      const other = makeTrash('task-aaaaaaaaaa-other-0123456789', getDeadPid(), 12);
      const result = clean('task-aaaaaaaaaa');
      assert.equal(result.stdout, 'absent=task-aaaaaaaaaa\n');
      assert.ok(fs.existsSync(other));
    });
  });

  it('the prune, on the contrary, still keeps a copy whose job ended a moment ago — only `clean` believes the «fetched» mark', () => {
    writeJob(makeCopy('fresh-results-aaaaaaa', 30, 9 * hourMs), 'box1-justen', { 'task-id': '1\n', exit: '0\n' });
    makeCopy('free-bbbbbbbbbb', 30, 5 * hourMs);
    makeCopy('free-cccccccccc', 30, 3 * hourMs);
    assert.deepEqual(parseRemovals(runScript(['prune', workDir], { REMOTE_RUN_MIN_FREE_GB: '70' }).stdout), ['free-bbbbbbbbbb', 'free-cccccccccc']);
    assert.ok(fs.existsSync(path.join(workDir, 'p', 'fresh-results-aaaaaaa')));
  });

  it('a job that turns up between the check and the rename is found out by the second look at the moved folder: the copy goes back and the answer says why', () => {
    makeCopy('late-aaaaaaaaaa', 5, 1 * hourMs);
    const body = `mv() { command mv "$@"; case "$2" in */.trash-*) command mkdir -p "$2/jobs/box1-latejb"; : > "$2/jobs/box1-latejb/task-id" ;; esac; }; cmd_clean ${workDir} late-aaaaaaaaaa`;
    const outcome = runShell(body);
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.equal(outcome.stdout, 'busy=late-aaaaaaaaaa kind=queued job=box1-latejb');
    assert.deepEqual(fs.readdirSync(path.join(workDir, 'p')), ['late-aaaaaaaaaa'], 'put back, not removed');
    assert.ok(fs.existsSync(path.join(workDir, 'p', 'late-aaaaaaaaaa', 'jobs', 'box1-latejb')));
  });

  it('a prune that took the copy first leaves nothing to clean: «absent», not «stuck»', () => {
    makeCopy('raced-aaaaaaaaaa', 5, 1 * hourMs);
    const outcome = runShell(`remove_project_copy() { return 2; }; cmd_clean ${workDir} raced-aaaaaaaaaa`);
    assert.equal(outcome.stdout, 'absent=raced-aaaaaaaaaa');
  });

  it('one that would not go is «stuck»', () => {
    makeCopy('stuck-aaaaaaaaaa', 5, 1 * hourMs);
    const outcome = runShell(`remove_project_copy() { return 1; }; cmd_clean ${workDir} stuck-aaaaaaaaaa`);
    assert.equal(outcome.stdout, 'stuck=stuck-aaaaaaaaaa');
  });

  it('it takes the copy-removal lock like the prune does — and waits for a prune that is at it (a disk that is fine does not make it leave), then removes', () => {
    makeCopy('task-aaaaaaaaaa', 10, 1 * hourMs);
    const lock = path.join(workDir, 'tmp', 'prune.lock');
    writeFile(workDir, 'tmp/prune.lock', `${startRunnerStandIn()}\n`);
    // The other prune ends after a second: its lock goes.
    const body = `prune_poll_sec=0.1; ( sleep 1; command rm -f "${lock}" ) & started=$SECONDS; cmd_clean ${workDir} task-aaaaaaaaaa; echo waited=$((SECONDS - started))`;
    const outcome = runShell(body, { REMOTE_RUN_MIN_FREE_GB: '1' });
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.match(outcome.stdout, /^removed=task-aaaaaaaaaa freed_kb=\d+ why=clean\nwaited=[1-9]$/);
    assert.equal(fs.existsSync(lock), false, 'and it leaves no lock of its own behind');
  });

  it('the wait for another prune is bounded: past prune_wait_sec it goes on, and the other prune\'s lock is not touched', () => {
    makeCopy('task-aaaaaaaaaa', 10, 1 * hourMs);
    const livePid = startRunnerStandIn();
    writeFile(workDir, 'tmp/prune.lock', `${livePid}\n`);
    const outcome = runShell(`prune_wait_sec=1; prune_poll_sec=0.2; cmd_clean ${workDir} task-aaaaaaaaaa`);
    assert.match(outcome.stdout, /^removed=task-aaaaaaaaaa /);
    assert.equal(fs.readFileSync(path.join(workDir, 'tmp', 'prune.lock'), 'utf8').trim(), `${livePid}`);
  });

  it('a caller that hangs up while it removes does not leave the removal half-done nor its lock behind (the closed pipe is no reason to die before the report line, which comes before the lock is given back)', async () => {
    makeCopy('task-aaaaaaaaaa', 30, 1 * hourMs);
    const child = spawn('bash', [scriptPath, 'clean', workDir, 'task-aaaaaaaaaa'], { env: getEnv({ FAKE_RM_DELAY: '0.8' }), stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.destroy();
    await new Promise<void>((resolve) => { child.on('close', () => resolve()); });
    assert.deepEqual(fs.readdirSync(path.join(workDir, 'p')), []);
    assert.equal(fs.existsSync(path.join(workDir, 'tmp', 'prune.lock')), false, 'the copy-removal lock was given back');
  });

  it('works through the real subcommand dispatch, as the CLI calls it (the work dir first, then the slug)', () => {
    makeCopy('task-aaaaaaaaaa', 3, hourMs);
    const result = spawnSync('bash', [scriptPath, 'clean', workDir, 'task-aaaaaaaaaa'], { encoding: 'utf8', env: getEnv(), timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^removed=task-aaaaaaaaaa /);
  });
});

describe('the TMPDIR of a project copy (`<work>/t/<n>`) is part of the disk upkeep', () => {
  const tmpDirOf = (index: number): string => path.join(workDir, 't', `${index}`);
  const exists = (index: number, relative: string): boolean => fs.existsSync(path.join(tmpDirOf(index), relative));

  /** A copy that holds number `index`, and in its TMPDIR: an old and a fresh file at the top, an old and a fresh one deeper (a Metro cache), an old empty folder, a fresh empty one. */
  function makeCopyWithTmpdir(copySlug: string, index: number, sizeGib = 1): string {
    const copyDir = makeCopy(copySlug, sizeGib, hourMs);
    writeFile(copyDir, 'index', `${index}\n`);
    stageTmpdirFiles(index);
    return copyDir;
  }

  function stageTmpdirFiles(index: number): void {
    const dir = tmpDirOf(index);
    for (const relative of ['old.bin', 'fresh.bin', 'metro-cache/deep/old.bin', 'metro-cache/fresh.bin']) writeFile(dir, relative);
    for (const relative of ['old.bin', 'metro-cache/deep/old.bin']) setAge(path.join(dir, relative), 10 * dayMs);
    fs.mkdirSync(path.join(dir, 'old-empty'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'fresh-empty'), { recursive: true });
    setAge(path.join(dir, 'old-empty'), 10 * dayMs);
  }

  async function waitFor(condition: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`${what} did not happen`);
  }

  it('`sweep-tmpdirs` removes the files not modified for three days - however deep - and the old empty folders, and keeps what is newer', () => {
    makeCopyWithTmpdir('idle-aaaaaaaaaa', 3);
    const swept = runScript(['sweep-tmpdirs', workDir]);
    assert.equal(swept.status, 0, swept.stderr);
    assert.equal(exists(3, 'old.bin'), false);
    assert.equal(exists(3, 'metro-cache/deep/old.bin'), false);
    assert.equal(exists(3, 'old-empty'), false);
    assert.equal(exists(3, 'fresh.bin'), true);
    assert.equal(exists(3, 'metro-cache/fresh.bin'), true);
    assert.equal(exists(3, 'fresh-empty'), true, 'a folder made today stays');
  });

  it('a copy that is in use is not touched: a job that runs (or waits, or whose results nobody fetched) may need every file', () => {
    const copyDir = makeCopyWithTmpdir('busy-bbbbbbbbbb', 4);
    writeJob(copyDir, 'box1-runnin', { 'task-id': '5\n', pid: `${startRunnerStandIn()}\n` });
    const idleDir = makeCopyWithTmpdir('idle-cccccccccc', 5);
    assert.ok(fs.existsSync(idleDir));
    assert.equal(runScript(['sweep-tmpdirs', workDir]).status, 0);
    assert.equal(exists(4, 'old.bin'), true, 'the running job\'s copy');
    assert.equal(exists(5, 'old.bin'), false, 'the idle one next to it');
  });

  it('a TMPDIR that no copy holds the number of (its copy was removed while its number could not be had) is swept as well', () => {
    stageTmpdirFiles(9);
    assert.equal(runScript(['sweep-tmpdirs', workDir]).status, 0);
    assert.equal(exists(9, 'old.bin'), false);
    assert.equal(exists(9, 'fresh.bin'), true);
  });

  it('only numbered folders are looked at: the folders a removal set aside (`t/.gone-…`) and anything else in `t` are left to their own rules', () => {
    writeFile(path.join(workDir, 't'), 'not-a-number/old.bin');
    setAge(path.join(workDir, 't', 'not-a-number', 'old.bin'), 10 * dayMs);
    const goneFolder = `.gone-${startRunnerStandIn()}-1-1`;
    writeFile(path.join(workDir, 't'), `${goneFolder}/old.bin`);
    setAge(path.join(workDir, 't', goneFolder, 'old.bin'), 10 * dayMs);
    assert.equal(runScript(['sweep-tmpdirs', workDir]).status, 0);
    assert.ok(fs.existsSync(path.join(workDir, 't', 'not-a-number', 'old.bin')));
    assert.ok(fs.existsSync(path.join(workDir, 't', goneFolder, 'old.bin')), 'being removed by a live process: not ours to sweep');
  });

  it('a prune on a SHORT disk sweeps the TMPDIRs before it removes a copy for space; a prune on a disk that is fine leaves them to the detached sweep', () => {
    const copyDir = makeCopyWithTmpdir('busy-dddddddddd', 6, 30);
    writeJob(copyDir, 'box1-runnin', { 'task-id': '5\n', pid: `${startRunnerStandIn()}\n` });
    stageTmpdirFiles(7);
    assert.equal(runScript(['prune', workDir], { REMOTE_RUN_MIN_FREE_GB: '0' }).status, 0);
    assert.equal(exists(7, 'old.bin'), true, 'no short disk, no sweep from the prune');
    assert.equal(runScript(['prune', workDir], { REMOTE_RUN_MIN_FREE_GB: '90' }).status, 0);
    assert.equal(exists(7, 'old.bin'), false, 'a disk that is short gives up the stale files first');
    assert.equal(exists(6, 'old.bin'), true, 'but not those of a copy in use (which is not removed either)');
  });

  it('`prepare` starts the sweep detached - once per interval: the next one inside it leaves the stamp alone and starts nothing', async () => {
    makeCopyWithTmpdir('idle-eeeeeeeeee', 8);
    const first = runScript(['prepare', workDir, slug, jobId, 'default=1']);
    assert.equal(first.status, 0, first.stderr);
    await waitFor(() => !exists(8, 'old.bin'), 'the detached sweep');
    assert.equal(exists(8, 'fresh.bin'), true);
    const stamp = path.join(workDir, 'tmpdir-sweep.at');
    assert.ok(fs.existsSync(stamp));
    stageTmpdirFiles(8);
    assert.equal(runScript(['prepare', workDir, slug, 'box1-second', 'default=1']).status, 0);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(exists(8, 'old.bin'), true, 'inside the interval nothing is started');
    setAge(stamp, 7 * hourMs);
    assert.equal(runScript(['prepare', workDir, slug, 'box1-third0', 'default=1']).status, 0);
    await waitFor(() => !exists(8, 'old.bin'), 'the sweep once the interval is over');
  });

  it('the size of a copy includes its TMPDIR - the disk prune and the probe see where a copy in daily use piles up - and is measured again when the copy was used', () => {
    const copyDir = makeCopyWithTmpdir('piled-ffffffffff', 2, 7);
    writeFile(tmpDirOf(2), 'fake-kb', `${2 * kibPerGib}`);
    assert.equal(runScript(['measure-copies', workDir]).status, 0);
    assert.equal(fs.readFileSync(path.join(copyDir, 'size-kb'), 'utf8').trim(), `${9 * kibPerGib}`, '7 GB of copy and 2 GB of TMPDIR');
    assert.match(runScript(['probe', workDir]).stdout, new RegExp(`^copies_size_mb=${9 * 1024}$`, 'm'));
  });

  it('a copy without a number has no TMPDIR to add', () => {
    const copyDir = makeCopy('plain-gggggggggg', 3, hourMs);
    writeFile(tmpDirOf(2), 'fake-kb', `${5 * kibPerGib}`);
    assert.equal(runScript(['measure-copies', workDir]).status, 0);
    assert.equal(fs.readFileSync(path.join(copyDir, 'size-kb'), 'utf8').trim(), `${3 * kibPerGib}`);
  });
});
