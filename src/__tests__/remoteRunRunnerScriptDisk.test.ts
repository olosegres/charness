/**
 * @description `runner-scripts/runner.sh` — the disk upkeep of a runner, run against the real script and a real shell: project copies unused for days go; while the work disk is short of free space
 * the least recently used copy goes first, one by one, until the target is met — never a copy in use (a lock held by a live job, a queued, running or just-submitted job) nor the copy of the
 * job being submitted; a copy with read-only folders is removed too; a submit on a disk that stays short is refused with the biggest copies named; `measure-copies` writes the sizes `probe` sums.
 * Also the races the review of the first version found: a running `exec`, results about to be fetched, a copy that gets busy between the check and the rename, a slow upload, two prunes at once,
 * and a refusal that must not measure.
 * The disk and the sizes are faked by a `df` and a `du` on the PATH that read a `fake-kb` file in each copy, so a removal really frees "space" and everything else (find, mv, chmod, rm, ls) is real.
 * The first part; the disk whose free figure does not follow the removals (APFS snapshots), the copies cloned from each other, the seed copy of a submit, the probe that never prunes, the pids that went to a stranger and the put-back are
 * `remoteRunRunnerScriptDiskSeedAndPids.test.ts`; the clones, the hang-up, `clean`, the TMPDIR and the Xcode derived data cases are `remoteRunRunnerScriptDiskCopies.test.ts` and `remoteRunRunnerScriptDiskClones.test.ts` (the cost of the clones' groups: `remoteRunRunnerScriptDiskClonesCost.test.ts`), the sizes of the copies (`measure-copies`)
 * and the two prunes at once are `remoteRunRunnerScriptDiskSizes.test.ts` (all share `remoteRunRunnerScriptDiskKit.ts`; split because a file runs under one time limit and one file ran 80–90 s alone).
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { diskTooLowRunnerExitCode } from '../remoteRun/pruneReport';
import { parseProbeOutput } from '../remoteRun/probe';
import { jobId, scriptPath, slug, startRunnerStandIn, stopDetachedRuns, writeFile } from './remoteRunRunnerScriptKit';
import { kibPerGib, dayMs, hourMs, workRoot, workDir, fakeBinDir, writeExecutable, getEnv, runScript, runFunction, setAge, makeCopy, writeJob, liveProcesses, getDeadPid, runShell, listCopies, parseRemovals, useDiskHarness } from './remoteRunRunnerScriptDiskKit';

useDiskHarness();

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

  it('starts the detached walk that measures the copies only AFTER it has taken this submit\'s copy back: a walk that outlives the call and meets the folder being removed would leave a copy nothing knows (a figure and no `used`: no prune takes it)', () => {
    writeJob(makeCopy('big-qqqqqqqqqq', 80, 2 * hourMs), 'box1-busy00', { 'task-id': '2\n' });
    const launchLog = path.join(workRoot, 'launch-log');
    // `nice` starts the detached run: what the submit's own folder looks like at that moment is the point.
    writeExecutable(path.join(fakeBinDir, 'nice'), `#!/bin/bash\necho "launched own-copy-exists=$([ -d '${path.join(workDir, 'p', slug)}' ] && echo yes || echo no)" >> '${launchLog}'\nshift 2\nexec "$@"\n`);
    const result = runScript(['prepare', workDir, slug, jobId, 'default=1'], { REMOTE_RUN_MIN_FREE_GB: '60' });
    assert.equal(result.status, diskTooLowRunnerExitCode, result.stderr);
    // The walk is started in the background (`nice` is its first word): the call may be over before `nice` has run, on a loaded host long before. Waited for, not read at once.
    stopDetachedRuns(workRoot);
    assert.equal(fs.readFileSync(launchLog, 'utf8').trim(), 'launched own-copy-exists=no', 'the first-ever copy of the refused submit is already gone when the walk starts');
    assert.equal(fs.existsSync(path.join(workDir, 'p', slug)), false, 'and stays gone');
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
    assert.deepEqual(probe.copies, { count: 2, sizeMb: 10 * 1024, unmeasuredCount: 1, clonedCount: 0 });
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
