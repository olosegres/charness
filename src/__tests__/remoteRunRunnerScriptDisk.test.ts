/**
 * @description `remoteRun/runner.sh` — the disk upkeep of a runner, run against the real script and a real shell: project copies unused for days go; while the work disk is short of free space
 * the least recently used copy goes first, one by one, until the target is met — never a copy in use (a lock held by a live job, a queued, running or just-submitted job) nor the copy of the
 * job being submitted; a copy with read-only folders is removed too; a submit on a disk that stays short is refused with the biggest copies named; `measure-copies` writes the sizes `probe` sums.
 * The disk and the sizes are faked by a `df` and a `du` on the PATH that read a `fake-kb` file in each copy, so a removal really frees "space" and everything else (find, mv, chmod, rm, ls) is real.
 * In a file of its own, as a file runs under one time limit.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
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
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/fake %s %s %s 1%% /\\n' "$total" "$used" "$((total - used))"
`;
const fakeDu = `#!/bin/bash
target=\${@: -1}
if [ -f "$target/fake-kb" ]; then printf '%s\\t%s\\n' "$(cat "$target/fake-kb")" "$target"; else exec /usr/bin/du "$@"; fi
`;
const fakePueue = '#!/bin/sh\nexit 0\n';

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
});
afterEach(() => {
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
    it('a lock whose holder is gone, a job that ended, a job that never got a task and is long over', () => {
      const deadPid = spawnSync('true').pid;
      const lockedDir = makeCopy('dead-lock-kkkkkkkkkk', 20, 9 * hourMs);
      writeFile(lockedDir, 'lock', `${deadPid}\n${jobId}\n`);
      const endedDir = makeCopy('ended-job-llllllllll', 20, 7 * hourMs);
      writeJob(endedDir, 'box1-ended0', { 'task-id': '1\n', exit: '0\n' });
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

  it('writes the size of every copy whose figure is missing or old, and leaves a fresh one alone', () => {
    makeCopy('missing-vvvvvvvvvv', 7, hourMs);
    makeCopy('old-wwwwwwwwww', 3, hourMs);
    writeFile(path.join(workDir, 'p', 'old-wwwwwwwwww'), 'size-kb', '1');
    setAge(sizeFile('old-wwwwwwwwww'), 2 * hourMs);
    makeCopy('fresh-xxxxxxxxxx', 4, hourMs);
    writeFile(path.join(workDir, 'p', 'fresh-xxxxxxxxxx'), 'size-kb', '5');
    assert.equal(runScript(['measure-copies', workDir]).status, 0);
    assert.equal(fs.readFileSync(sizeFile('missing-vvvvvvvvvv'), 'utf8').trim(), `${7 * kibPerGib}`);
    assert.equal(fs.readFileSync(sizeFile('old-wwwwwwwwww'), 'utf8').trim(), `${3 * kibPerGib}`, 'an old figure is measured again');
    assert.equal(fs.readFileSync(sizeFile('fresh-xxxxxxxxxx'), 'utf8').trim(), '5', 'a fresh one is trusted');
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

  it('probe on a disk short of free space starts the prune detached instead of making the probe wait for it', async () => {
    makeCopy('oldest-aaaaaaaaaa', 45, 5 * hourMs);
    makeCopy('newest-cccccccccc', 45, 1 * hourMs);
    const result = runScript(['probe', workDir]);
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
