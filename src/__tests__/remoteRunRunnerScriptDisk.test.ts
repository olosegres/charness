/**
 * @description `remoteRun/runner.sh` — the disk upkeep of a runner, run against the real script and a real shell: project copies unused for days go; while the work disk is short of free space
 * the least recently used copy goes first, one by one, until the target is met — never a copy in use (a lock held by a live job, a queued, running or just-submitted job) nor the copy of the
 * job being submitted; a copy with read-only folders is removed too; a submit on a disk that stays short is refused with the biggest copies named; `measure-copies` writes the sizes `probe` sums.
 * Also the races the review of the first version found: a running `exec`, results about to be fetched, a copy that gets busy between the check and the rename, a slow upload, two prunes at once,
 * a refusal that must not measure, and a disk whose free figure does not follow the removals (APFS snapshots).
 * The disk and the sizes are faked by a `df` and a `du` on the PATH that read a `fake-kb` file in each copy, so a removal really frees "space" and everything else (find, mv, chmod, rm, ls) is real.
 * The first half; the clones, the hang-up, `clean`, the TMPDIR and the Xcode derived data cases are `remoteRunRunnerScriptDiskCopies.test.ts` (both share `remoteRunRunnerScriptDiskKit.ts`; split because a file runs under one
 * time limit and one file ran 80–90 s alone).
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
import { jobId, scriptPath, slug, startRunnerStandIn, startStrangerProcess, stopDetachedRuns, writeFile } from './remoteRunRunnerScriptKit';
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
    assert.deepEqual(probe.copies, { count: 2, sizeMb: 7 * 1024, unmeasuredCount: 1, clonedCount: 0 });
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
    assert.deepEqual(parseProbeOutput(result.stdout).copies, { count: 2, sizeMb: 7 * 1024, unmeasuredCount: 2, clonedCount: 0 }, 'both are unmeasured: one has no figure, the other was used after its figure');
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

describe('copies cloned from each other share their disk blocks: a removal that gave little back is no sign of a disk that does not follow', () => {
  /** A copy measured at `sizeGib` whose removal gives `freedGib` back to the fake disk; `seededFrom` / `isSource` are the marks a seed leaves (`seed_new_copy`). */
  function makeSeedCopy(copySlug: string, usedAgoMs: number, marks: { seededFrom?: string; isSource?: boolean }): void {
    const copyDir = makeCopy(copySlug, 0, usedAgoMs);
    writeFile(copyDir, 'size-kb', `${30 * kibPerGib}`);
    if (marks.seededFrom !== undefined) writeFile(copyDir, 'seeded-from', `${marks.seededFrom}\n`);
    if (marks.isSource === true) writeFile(copyDir, 'seed-shared', '');
  }

  it('removals of copies that still share blocks neither count towards «the disk is not following» nor reset it: three clones of one source go (as does the one with nothing shared), and only the last of them, which holds its blocks alone, is a verdict', () => {
    // The source and two copies cloned from it, then one that shares nothing: on a disk whose free figure does not move, the old rule stopped after the first two.
    makeSeedCopy('source-aaaaaaaaaa', 9 * hourMs, { isSource: true });
    makeSeedCopy('clone-one-bbbbbbbbbb', 7 * hourMs, { seededFrom: 'source-aaaaaaaaaa' });
    makeSeedCopy('clone-two-cccccccccc', 5 * hourMs, { seededFrom: 'source-aaaaaaaaaa' });
    makeCopy('alone-dddddddddd', 0, 3 * hourMs);
    writeFile(path.join(workDir, 'p', 'alone-dddddddddd'), 'size-kb', `${30 * kibPerGib}`);
    makeCopy('newest-eeeeeeeeee', 0, 1 * hourMs);
    writeFile(path.join(workDir, 'p', 'newest-eeeeeeeeee'), 'size-kb', `${30 * kibPerGib}`);
    const result = runScript(['prune', workDir], { REMOTE_RUN_MIN_FREE_GB: '95', FAKE_DF_FREE_KB: `${10 * kibPerGib}` });
    assert.equal(result.status, 0, result.stderr);
    // The source and the first clone share with a copy that is still there (not counted); the second clone is the last of its group (counted: 1); `alone` is the second (stop).
    assert.deepEqual(parseRemovals(result.stdout), ['source-aaaaaaaaaa', 'clone-one-bbbbbbbbbb', 'clone-two-cccccccccc', 'alone-dddddddddd']);
    assert.match(result.stdout, /^stopped=alone-dddddddddd freed_kb=0 size_kb=31457280$/m);
    assert.deepEqual(listCopies(), ['newest-eeeeeeeeee']);
  });

  it('a copy whose source or sharers are all gone holds its blocks alone: it counts like any other', () => {
    // `seeded-from` names a copy that is not there any more, and nobody else is of that group.
    makeSeedCopy('clone-one-aaaaaaaaaa', 9 * hourMs, { seededFrom: 'gone-source-zzzzzzzzzz' });
    makeSeedCopy('clone-two-bbbbbbbbbb', 7 * hourMs, { seededFrom: 'another-gone-yyyyyyyyyy' });
    makeCopy('newest-cccccccccc', 0, 1 * hourMs);
    writeFile(path.join(workDir, 'p', 'newest-cccccccccc'), 'size-kb', `${30 * kibPerGib}`);
    const result = runScript(['prune', workDir], { REMOTE_RUN_MIN_FREE_GB: '95', FAKE_DF_FREE_KB: `${10 * kibPerGib}` });
    assert.deepEqual(parseRemovals(result.stdout), ['clone-one-aaaaaaaaaa', 'clone-two-bbbbbbbbbb']);
    assert.match(result.stdout, /^stopped=clone-two-bbbbbbbbbb freed_kb=0 size_kb=31457280$/m);
    assert.deepEqual(listCopies(), ['newest-cccccccccc']);
  });
});

describe('the prune of a submit leaves the copy the submitted job\'s first run is seeded from to the last', () => {
  const projectKey = 'a'.repeat(32);
  const installKey = 'key-of-the-install';

  /** A finished copy of the repository: its key and the install it finished with, `usedAgoMs` ago. */
  function makeSiblingCopy(copySlug: string, usedAgoMs: number, options: { key?: string; hasProjectKey?: boolean } = {}): void {
    const copyDir = makeCopy(copySlug, 30, usedAgoMs);
    if (options.hasProjectKey !== false) writeFile(copyDir, 'project-key', `${projectKey}\n`);
    writeFile(copyDir, 'deps.hash', `${options.key ?? installKey}\n`);
  }

  it('on a short disk the oldest copy goes first — except the one this new copy would be cloned from: the others go instead', () => {
    makeSiblingCopy('overview-aaaaaaaaaa', 9 * hourMs);
    makeCopy('other-project-bbbbbbbbbb', 30, 5 * hourMs);
    makeCopy('another-cccccccccc', 30, 3 * hourMs);
    // 90 GB used of 100, 50 wanted free: two copies must go.
    const result = runScript(['prepare', workDir, slug, jobId, 'default=1', projectKey, installKey], { REMOTE_RUN_MIN_FREE_GB: '50' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(parseRemovals(result.stdout), ['other-project-bbbbbbbbbb', 'another-cccccccccc']);
    assert.ok(listCopies().includes('overview-aaaaaaaaaa'), 'the source of the seed is still there');
  });

  it('it is the one the job would pick: the sibling with its install key, not a more recently used one with another key', () => {
    makeSiblingCopy('with-key-aaaaaaaaaa', 9 * hourMs);
    makeSiblingCopy('other-key-bbbbbbbbbb', 5 * hourMs, { key: 'another-install' });
    makeCopy('unrelated-cccccccccc', 30, 3 * hourMs);
    const result = runScript(['prepare', workDir, slug, jobId, 'default=1', projectKey, installKey], { REMOTE_RUN_MIN_FREE_GB: '50' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(parseRemovals(result.stdout), ['other-key-bbbbbbbbbb', 'unrelated-cccccccccc']);
    assert.deepEqual(listCopies(), [slug, 'with-key-aaaaaaaaaa']);
  });

  it('if the others are not enough it goes too, after them (the job is not refused for it)', () => {
    makeSiblingCopy('overview-aaaaaaaaaa', 9 * hourMs);
    makeCopy('unrelated-bbbbbbbbbb', 30, 5 * hourMs);
    // 60 GB used, 80 wanted free: the unrelated copy goes (free 70), and the source after it (free 100).
    const result = runScript(['prepare', workDir, slug, jobId, 'default=1', projectKey, installKey], { REMOTE_RUN_MIN_FREE_GB: '80' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(parseRemovals(result.stdout), ['unrelated-bbbbbbbbbb', 'overview-aaaaaaaaaa'], 'last, not first');
  });

  it('a job with no repository key, or a copy that has run before, protects nothing: the oldest copy goes first, as before', () => {
    makeSiblingCopy('overview-aaaaaaaaaa', 9 * hourMs);
    makeCopy('unrelated-bbbbbbbbbb', 30, 5 * hourMs);
    makeCopy('another-cccccccccc', 30, 3 * hourMs);
    const withoutKey = runScript(['prepare', workDir, slug, jobId, 'default=1', '', installKey], { REMOTE_RUN_MIN_FREE_GB: '50' });
    assert.equal(withoutKey.status, 0, withoutKey.stderr);
    assert.deepEqual(parseRemovals(withoutKey.stdout), ['overview-aaaaaaaaaa', 'unrelated-bbbbbbbbbb']);
    // A copy of its own already (a manifest: a job applied its stage): not seeded again, so no sibling is kept for it.
    makeSiblingCopy('overview-aaaaaaaaaa', 9 * hourMs);
    makeCopy('unrelated-bbbbbbbbbb', 30, 5 * hourMs);
    writeFile(path.join(workDir, 'p', slug), 'manifest', 'a.txt\n');
    const hasRun = runScript(['prepare', workDir, slug, 'box1-bbbbbb', 'default=1', projectKey, installKey], { REMOTE_RUN_MIN_FREE_GB: '50' });
    assert.equal(hasRun.status, 0, hasRun.stderr);
    assert.deepEqual(parseRemovals(hasRun.stdout)[0], 'overview-aaaaaaaaaa');
  });

  it('the 3-day age rule keeps it too, for this one submit: a source idle for four days is not removed by the prepare of the copy that is about to be seeded from it — a copy of another repository idle as long is', () => {
    makeSiblingCopy('overview-aaaaaaaaaa', 4 * dayMs);
    makeCopy('other-repository-bbbbbbbbbb', 1, 4 * dayMs);
    const result = runScript(['prepare', workDir, slug, jobId, 'default=1', projectKey, installKey], { REMOTE_RUN_MIN_FREE_GB: '0' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(parseRemovals(result.stdout), ['other-repository-bbbbbbbbbb']);
    assert.ok(listCopies().includes('overview-aaaaaaaaaa'), 'the source of the seed is still there');
    // What it was kept for ends with that submit: the next prepare (the copy has run now) takes it by age if nobody used it.
    writeFile(path.join(workDir, 'p', slug), 'manifest', 'a.txt\n');
    const next = runScript(['prepare', workDir, slug, 'box1-bbbbbb', 'default=1', projectKey, installKey], { REMOTE_RUN_MIN_FREE_GB: '0' });
    assert.deepEqual(parseRemovals(next.stdout), ['overview-aaaaaaaaaa']);
  });

  it('a copy of another repository, or one with no key, is not the source: it is removed in its turn', () => {
    makeSiblingCopy('other-repo-aaaaaaaaaa', 9 * hourMs, { hasProjectKey: false });
    makeCopy('unrelated-bbbbbbbbbb', 30, 5 * hourMs);
    makeCopy('another-cccccccccc', 30, 3 * hourMs);
    const result = runScript(['prepare', workDir, slug, jobId, 'default=1', projectKey, installKey], { REMOTE_RUN_MIN_FREE_GB: '50' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(parseRemovals(result.stdout)[0], 'other-repo-aaaaaaaaaa');
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
