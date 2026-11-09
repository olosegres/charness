/**
 * @description `remoteRun/runner.sh` — the disk upkeep of a runner, the second half of `remoteRunRunnerScriptDisk.test.ts` (they share `remoteRunRunnerScriptDiskKit.ts`; split because a file runs under one time limit and one ran 80–90 s alone):
 * what shows the sizes of clones says that `du` counts them in full; a caller that hangs up while `prepare` removes copies; `clean` — the owner of a task removes its project copy on request; the TMPDIR of a project copy is part of the
 * disk upkeep; the Xcode derived data of a copy nobody used for a day goes with the sweep. Run against the real script and a real shell, with the fake disk of the kit.
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
import { kibPerGib, dayMs, hourMs, workRoot, workDir, fakeBinDir, writeExecutable, getEnv, runScript, setAge, makeCopy, writeJob, liveProcesses, getDeadPid, runShell, listCopies, parseRemovals, useDiskHarness } from './remoteRunRunnerScriptDiskKit';

useDiskHarness();

describe('what shows the sizes of clones says that `du` counts them in full', () => {
  /** Copies measured at 30 GiB; `a` is the source and `b`, `c` are clones of it, `d` stands alone. */
  function makeClonedCopies(): void {
    for (const [name, marks] of [['a-aaaaaaaaaa', { isSource: true }], ['b-bbbbbbbbbb', { seededFrom: 'a-aaaaaaaaaa' }], ['c-cccccccccc', { seededFrom: 'a-aaaaaaaaaa' }], ['d-dddddddddd', {}]] as const) {
      const copyDir = makeCopy(name, 30, 5 * hourMs);
      writeFile(copyDir, 'size-kb', `${30 * kibPerGib}`);
      if ('seededFrom' in marks) writeFile(copyDir, 'seeded-from', `${marks.seededFrom}\n`);
      if ('isSource' in marks) writeFile(copyDir, 'seed-shared', '');
    }
  }

  it('the probe counts the copies that share blocks with another: a clone, the copy it came from, other clones of it — not a copy that stands alone, and not one whose source and sharers are all gone', () => {
    makeClonedCopies();
    makeCopy('orphan-eeeeeeeeee', 30, 5 * hourMs);
    writeFile(path.join(workDir, 'p', 'orphan-eeeeeeeeee'), 'seeded-from', 'gone-zzzzzzzzzz\n');
    assert.equal(runScript(['measure-copies', workDir]).status, 0);
    const copies = parseProbeOutput(runScript(['probe', workDir]).stdout).copies;
    assert.equal(copies?.count, 5);
    assert.equal(copies?.clonedCount, 3, 'the source and its two clones');
  });

  it('a runner with no clone says 0, as a runner that predates the seed (the field is absent) reads as none', () => {
    makeCopy('alone-aaaaaaaaaa', 5, hourMs);
    assert.match(runScript(['probe', workDir]).stdout, /^copies_cloned=0$/m);
  });

  it('two groups of clones and copies that belong to none: every member of a group of two or more counts, nothing else (a lone mark, an orphan whose origin is gone, a copy that stands alone)', () => {
    for (const [name, marks] of [
      ['a-aaaaaaaaaa', { isSource: true }], ['b-bbbbbbbbbb', { seededFrom: 'a-aaaaaaaaaa' }], ['c-cccccccccc', { seededFrom: 'a-aaaaaaaaaa' }],
      ['d-dddddddddd', { isSource: true }], ['e-eeeeeeeeee', { seededFrom: 'd-dddddddddd' }],
      ['f-ffffffffff', {}], ['g-gggggggggg', { seededFrom: 'gone-zzzzzzzzzz' }], ['h-hhhhhhhhhh', { isSource: true }],
    ] as const) {
      const copyDir = makeCopy(name, 1, hourMs);
      if ('seededFrom' in marks) writeFile(copyDir, 'seeded-from', `${marks.seededFrom}\n`);
      if ('isSource' in marks) writeFile(copyDir, 'seed-shared', '');
    }
    assert.equal(parseProbeOutput(runScript(['probe', workDir]).stdout).copies?.clonedCount, 5, 'a, b, c and d, e');
  });

  describe('the cost is linear in the number of copies: each copy\'s group is read once (a runner whose every copy is a clone: the owner\'s Mac)', () => {
    const copyCount = 24;
    /** A `cat` that logs every read of a `seeded-from` mark: one is one `get_copy_seed_group`, which is the script's own forks. */
    function logSeedGroupReads(): string {
      const logFile = path.join(workRoot, 'seed-group-reads');
      writeExecutable(path.join(fakeBinDir, 'cat'), `#!/bin/bash\ncase "$*" in *seeded-from*) echo read >> '${logFile}' ;; esac\nexec /bin/cat "$@"\n`);
      return logFile;
    }
    const countReads = (logFile: string): number => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter((line) => line !== '').length : 0);
    function makeAllClones(): void {
      for (let number = 0; number < copyCount; number += 1) {
        const copyDir = makeCopy(`clone-${number.toString().padStart(2, '0')}aaaaaaaa`, 1, hourMs);
        writeFile(copyDir, number === 0 ? 'seed-shared' : 'seeded-from', number === 0 ? '' : 'clone-00aaaaaaaa\n');
      }
    }

    it('a probe reads each copy\'s mark once, not once per copy for each copy', () => {
      makeAllClones();
      const logFile = logSeedGroupReads();
      const copies = parseProbeOutput(runScript(['probe', workDir]).stdout).copies;
      assert.equal(copies?.clonedCount, copyCount);
      assert.ok(countReads(logFile) <= copyCount, `${countReads(logFile)} reads for ${copyCount} copies`);
    });

    it('so does the refusal that names the biggest copies', () => {
      makeAllClones();
      const runnerPid = startRunnerStandIn();
      for (let number = 0; number < copyCount; number += 1) writeJob(path.join(workDir, 'p', `clone-${number.toString().padStart(2, '0')}aaaaaaaa`), 'box1-runnin', { 'task-id': '5\n', pid: `${runnerPid}\n` });
      assert.equal(runScript(['measure-copies', workDir]).status, 0);
      const logFile = logSeedGroupReads();
      const refused = runScript(['prepare', workDir, slug, jobId, 'default=1'], { REMOTE_RUN_MIN_FREE_GB: '90', FAKE_DF_FREE_KB: `${10 * kibPerGib}` });
      assert.equal(refused.status, diskTooLowRunnerExitCode);
      assert.match(refused.stderr, /\(clones counted in full\)/);
      assert.ok(countReads(logFile) <= copyCount + 2 * 3, `${countReads(logFile)} reads for ${copyCount} copies`);
    });
  });

  it('the note names only what the line names: clones that are NOT among the biggest copies listed do not make the listed ones «counted in full»', () => {
    const runnerPid = startRunnerStandIn();
    // Three big copies that stand alone (they are the ones listed) and a small pair of clones nobody names.
    for (const name of ['big-one-aaaaaaaaaa', 'big-two-bbbbbbbbbb', 'big-three-cccccccccc']) writeJob(makeCopy(name, 30, 5 * hourMs), 'box1-runnin', { 'task-id': '5\n', pid: `${runnerPid}\n` });
    for (const [name, mark] of [['small-source-dddddddddd', 'seed-shared'], ['small-clone-eeeeeeeeee', 'seeded-from']] as const) {
      const copyDir = makeCopy(name, 1, 5 * hourMs);
      writeFile(copyDir, mark, mark === 'seeded-from' ? 'small-source-dddddddddd\n' : '');
      writeJob(copyDir, 'box1-runnin', { 'task-id': '5\n', pid: `${runnerPid}\n` });
    }
    assert.equal(runScript(['measure-copies', workDir]).status, 0);
    const refused = runScript(['prepare', workDir, slug, jobId, 'default=1'], { REMOTE_RUN_MIN_FREE_GB: '90', FAKE_DF_FREE_KB: `${10 * kibPerGib}` });
    assert.equal(refused.status, diskTooLowRunnerExitCode);
    assert.match(refused.stderr, /biggest project copies: big-(one|two|three)-\w+ 30 GB, big-\w+-\w+ 30 GB, big-\w+-\w+ 30 GB; free space with/);
    assert.doesNotMatch(refused.stderr, /clones counted/);
  });

  it('the two notes of the listing share one parenthesis: «(and 1 not measured yet; clones counted in full)»', () => {
    const runnerPid = startRunnerStandIn();
    makeClonedCopies();
    for (const name of ['a-aaaaaaaaaa', 'b-bbbbbbbbbb', 'c-cccccccccc', 'd-dddddddddd']) writeJob(path.join(workDir, 'p', name), 'box1-runnin', { 'task-id': '5\n', pid: `${runnerPid}\n` });
    // One copy with no figure: a job runs in it, so the refusal cannot measure it (it measures nothing).
    writeJob(makeCopy('unmeasured-eeeeeeeeee', 30, 5 * hourMs), 'box1-runnin', { 'task-id': '5\n', pid: `${runnerPid}\n` });
    const refused = runScript(['prepare', workDir, slug, jobId, 'default=1'], { REMOTE_RUN_MIN_FREE_GB: '90', FAKE_DF_FREE_KB: `${10 * kibPerGib}` });
    assert.equal(refused.status, diskTooLowRunnerExitCode);
    assert.match(refused.stderr, /biggest project copies: [^(;]* \(and 1 not measured yet; clones counted in full\); free space with/);
  });

  it('the refusal of a submit that names the biggest copies says so when some of them are clones — and says nothing of it when none is', () => {
    makeClonedCopies();
    // Every copy has a job that runs: the prune may not take them, and the refusal names them.
    const runnerPid = startRunnerStandIn();
    for (const name of ['a-aaaaaaaaaa', 'b-bbbbbbbbbb', 'c-cccccccccc', 'd-dddddddddd']) writeJob(path.join(workDir, 'p', name), 'box1-runnin', { 'task-id': '5\n', pid: `${runnerPid}\n` });
    assert.equal(runScript(['measure-copies', workDir]).status, 0);
    const refused = runScript(['prepare', workDir, slug, jobId, 'default=1'], { REMOTE_RUN_MIN_FREE_GB: '90', FAKE_DF_FREE_KB: `${10 * kibPerGib}` });
    assert.equal(refused.status, diskTooLowRunnerExitCode);
    assert.match(refused.stderr, /biggest project copies: [^;]* \(clones counted in full\); free space with/);
    fs.rmSync(path.join(workDir, 'p', 'b-bbbbbbbbbb'), { recursive: true });
    fs.rmSync(path.join(workDir, 'p', 'c-cccccccccc'), { recursive: true });
    const alone = runScript(['prepare', workDir, slug, 'box1-bbbbbb', 'default=1'], { REMOTE_RUN_MIN_FREE_GB: '90', FAKE_DF_FREE_KB: `${10 * kibPerGib}` });
    assert.equal(alone.status, diskTooLowRunnerExitCode);
    assert.doesNotMatch(alone.stderr, /clones counted/);
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

  it('a stale tree with READ-ONLY folders (a killed `pod install`, any extractor of a read-only archive) is swept too - the folders are made writable first - and a fresh read-only folder is left as it is', () => {
    makeCopyWithTmpdir('idle-hhhhhhhhhh', 3);
    const staleFile = path.join(tmpDirOf(3), 'Pods', 'Core.xcframework', 'Headers', 'a.h');
    writeFile(path.join(tmpDirOf(3), 'Pods'), 'Core.xcframework/Headers/a.h');
    writeFile(path.join(tmpDirOf(3), 'Pods'), 'Core.xcframework/Info.plist');
    writeFile(path.join(tmpDirOf(3), 'fresh-ro'), 'keep.txt');
    for (const target of [staleFile, path.join(tmpDirOf(3), 'Pods', 'Core.xcframework', 'Info.plist')]) setAge(target, 10 * dayMs);
    for (const folder of ['Pods/Core.xcframework/Headers', 'Pods/Core.xcframework', 'Pods']) {
      setAge(path.join(tmpDirOf(3), folder), 10 * dayMs);
      fs.chmodSync(path.join(tmpDirOf(3), folder), 0o555);
    }
    fs.chmodSync(path.join(tmpDirOf(3), 'fresh-ro'), 0o555);
    try {
      assert.equal(runScript(['sweep-tmpdirs', workDir]).status, 0);
      assert.equal(exists(3, 'Pods/Core.xcframework/Headers/a.h'), false, 'the old file inside the read-only folder is gone');
      assert.equal(exists(3, 'Pods/Core.xcframework/Info.plist'), false);
      // The folders themselves stay for now: removing a file made their modification time fresh, and an empty folder goes by age too (three days later).
      assert.equal(exists(3, 'fresh-ro/keep.txt'), true, 'a fresh folder is not touched');
      assert.equal(fs.statSync(path.join(tmpDirOf(3), 'fresh-ro')).mode & 0o200, 0, 'its mode is as it was');
    } finally {
      fs.chmodSync(path.join(tmpDirOf(3), 'fresh-ro'), 0o755);
    }
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

  it('the sweep of a SHORT disk is not run on every submit: it takes the stamp\'s turn (30 minutes), so a disk that stays short for days does not make each `prepare` walk every TMPDIR again', () => {
    makeCopyWithTmpdir('busy-iiiiiiiiii', 6, 30);
    const stamp = path.join(workDir, 'tmpdir-sweep.at');
    writeJob(path.join(workDir, 'p', 'busy-iiiiiiiiii'), 'box1-runnin', { 'task-id': '5\n', pid: `${startRunnerStandIn()}\n` });
    stageTmpdirFiles(7);
    assert.equal(runScript(['prune', workDir], { REMOTE_RUN_MIN_FREE_GB: '90' }).status, 0);
    assert.equal(exists(7, 'old.bin'), false, 'the first prune on a short disk sweeps');
    assert.ok(fs.existsSync(stamp), 'and takes the turn');
    stageTmpdirFiles(7);
    assert.equal(runScript(['prune', workDir], { REMOTE_RUN_MIN_FREE_GB: '90' }).status, 0);
    assert.equal(exists(7, 'old.bin'), true, 'the second, minutes later, leaves the walk alone');
    setAge(stamp, 31 * 60 * 1000);
    assert.equal(runScript(['prune', workDir], { REMOTE_RUN_MIN_FREE_GB: '90' }).status, 0);
    assert.equal(exists(7, 'old.bin'), false, 'a turn that has come round sweeps again');
  });

  it('`prepare` starts the sweep detached - once per interval: the next one inside it leaves the stamp alone and starts nothing', async () => {
    makeCopyWithTmpdir('idle-eeeeeeeeee', 8);
    const first = runScript(['prepare', workDir, slug, jobId, 'default=1']);
    assert.equal(first.status, 0, first.stderr);
    await waitFor(() => !exists(8, 'old.bin'), 'the detached sweep');
    // The sweep is over before the files are staged again: one still walking would take the staged ones as well.
    stopDetachedRuns(workRoot);
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

describe('the Xcode derived data of a copy that nobody used for a day (`ios/build`, but not its `generated`) goes with the sweep of idle copies', () => {
  const tree = (copySlug: string, relative: string): string => path.join(workDir, 'p', copySlug, 'tree', relative);
  const exists = (copySlug: string, relative: string): boolean => fs.existsSync(tree(copySlug, relative));
  const buildData = ['projects/x/ios/build/Products/app.txt', 'projects/x/ios/build/Intermediates.noindex/a.o', 'projects/x/ios/build/Build/Products/Debug/app', 'ios/DerivedData/ModuleCache/m.pcm'];
  /** What `pod install` writes into `ios/build/generated`: the sources of the codegen pods (React Native 0.74+ podspecs point at them) — part of the native project, which a build with its `pod install` skipped cannot do without. */
  const codegenPodspec = 'projects/x/ios/build/generated/ios/ReactCodegen/ReactCodegen.podspec';
  const notBuildData = [
    codegenPodspec,
    'projects/x/ios/build/generated/ios/ReactAppDependencyProvider/ReactAppDependencyProvider.podspec',
    'projects/x/ios/Podfile',
    'projects/x/ios/Pods/Pod/pod.h',
    'projects/x/ios/Source.swift',
    'projects/x/android/build/out.apk',
    'build/out.js',
    'node_modules/pkg/ios/build/prebuilt.a',
    'projects/x/node_modules/pkg/ios/DerivedData/prebuilt.a',
    'ios/Pods/Pod/ios/build/inside-pods.txt',
  ];

  /** A copy with the build data of an iOS build next to what must stay: its manifest lists the sources the main box sent (the Podfile and the Swift file), its size has been measured. */
  function makeCopyWithBuildData(copySlug: string, usedAgoMs: number): string {
    const copyDir = makeCopy(copySlug, 8, usedAgoMs);
    for (const relative of [...buildData, ...notBuildData]) writeFile(path.join(copyDir, 'tree'), relative);
    // What the fake `du` says of the units that go: 3 GiB (`ios/build/Build`) and 2 GiB (`ios/DerivedData`) of the copy's 8, the other entries of `ios/build` nothing.
    writeFile(path.join(copyDir, 'tree'), 'projects/x/ios/build/Build/fake-kb', `${3 * kibPerGib}`);
    for (const small of ['Products', 'Intermediates.noindex']) writeFile(path.join(copyDir, 'tree'), `projects/x/ios/build/${small}/fake-kb`, '0');
    writeFile(path.join(copyDir, 'tree'), 'ios/DerivedData/fake-kb', `${2 * kibPerGib}`);
    writeFile(copyDir, 'manifest', 'projects/x/ios/Podfile\nprojects/x/ios/Source.swift\n');
    writeFile(copyDir, 'size-kb', `${8 * kibPerGib}`);
    return copyDir;
  }

  function expectTrimmed(copySlug: string): void {
    for (const relative of buildData) assert.equal(exists(copySlug, relative), false, `${relative} is gone`);
    for (const relative of notBuildData) assert.equal(exists(copySlug, relative), true, `${relative} stays`);
  }

  function expectUntouched(copySlug: string): void {
    for (const relative of [...buildData, ...notBuildData]) assert.equal(exists(copySlug, relative), true, `${relative} stays`);
  }

  it('`sweep-tmpdirs` removes the derived data of `ios/build` and `ios/DerivedData` of a copy idle for more than 24 hours — of every app folder — and nothing else: `ios/build/generated` (the codegen pods\' sources) stays, and so do the sources, the Pods, the other build folders, anything inside node_modules or Pods', () => {
    const copyDir = makeCopyWithBuildData('idle-aaaaaaaaaa', 25 * hourMs);
    const swept = runScript(['sweep-tmpdirs', workDir]);
    assert.equal(swept.status, 0, swept.stderr);
    expectTrimmed('idle-aaaaaaaaaa');
    assert.equal(fs.readFileSync(path.join(copyDir, 'build-data-trimmed'), 'utf8').trim().split(', ').sort().join(', '), 'ios/DerivedData, projects/x/ios/build', 'what went is written down for the next job');
    assert.equal(fs.readFileSync(path.join(copyDir, 'size-kb'), 'utf8').trim(), `${3 * kibPerGib}`, 'the measured size goes down by what was taken out of it: 8 - 3 - 2 GiB');
    assert.equal(fs.existsSync(path.join(copyDir, 'lock')), false, 'the lock it took is given back');
    assert.deepEqual(fs.readdirSync(copyDir).filter((name) => name.startsWith('build-trash')), [], 'and nothing is left of what was removed');
    assert.equal(fs.existsSync(path.join(copyDir, 'used')), true);
    assert.ok(Date.now() - fs.statSync(path.join(copyDir, 'used')).mtimeMs > 24 * hourMs, 'a trim is no use of the copy: it is still as idle as it was');
  });

  it('a copy used within the day keeps its build data: the next iOS run of it is incremental', () => {
    makeCopyWithBuildData('recent-bbbbbbbbbb', 23 * hourMs);
    assert.equal(runScript(['sweep-tmpdirs', workDir]).status, 0);
    expectUntouched('recent-bbbbbbbbbb');
  });

  it('a copy in use keeps it — a lock a live job holds, a job that runs, waits or ended lately, an `exec` — however long ago its last mark of use was written', () => {
    const locked = makeCopyWithBuildData('locked-cccccccccc', 30 * hourMs);
    const lockHolderPid = startRunnerStandIn();
    writeFile(locked, 'lock', `${lockHolderPid}\nsome-job\n`);
    const running = makeCopyWithBuildData('running-dddddddddd', 30 * hourMs);
    writeJob(running, 'box1-runnin', { 'task-id': '5\n', pid: `${startRunnerStandIn()}\n` });
    const queued = makeCopyWithBuildData('queued-eeeeeeeeee', 30 * hourMs);
    writeJob(queued, 'box1-queued', { 'task-id': '6\n' });
    const execCopy = makeCopyWithBuildData('exec-ffffffffff', 30 * hourMs);
    writeFile(execCopy, `exec.${startRunnerStandIn()}`, '');
    const ended = makeCopyWithBuildData('ended-gggggggggg', 30 * hourMs);
    writeJob(ended, 'box1-ended0', { exit: '0\n' });
    makeCopyWithBuildData('idle-hhhhhhhhhh', 30 * hourMs);
    assert.equal(runScript(['sweep-tmpdirs', workDir]).status, 0);
    for (const busy of ['locked-cccccccccc', 'running-dddddddddd', 'queued-eeeeeeeeee', 'exec-ffffffffff', 'ended-gggggggggg']) expectUntouched(busy);
    expectTrimmed('idle-hhhhhhhhhh');
    assert.equal(fs.readFileSync(path.join(locked, 'lock'), 'utf8'), `${lockHolderPid}\nsome-job\n`, 'the lock of the job is not touched');
  });

  it('under the copy\'s own lock the trim looks again: a copy used since the caller looked (a `prepare` touched it), an `exec`, a lock a job took meanwhile keep their build data', () => {
    const touched = makeCopyWithBuildData('touched-iiiiiiiiii', hourMs);
    assert.equal(runShell(`trim_copy_build_data '${touched}'`).status, 0);
    expectUntouched('touched-iiiiiiiiii');
    assert.equal(fs.existsSync(path.join(touched, 'lock')), false, 'the lock it took is given back');
    const execCopy = makeCopyWithBuildData('exec-jjjjjjjjjj', 30 * hourMs);
    writeFile(execCopy, `exec.${startRunnerStandIn()}`, '');
    assert.equal(runShell(`trim_copy_build_data '${execCopy}'`).status, 0);
    expectUntouched('exec-jjjjjjjjjj');
    const locked = makeCopyWithBuildData('locked-kkkkkkkkkk', 30 * hourMs);
    const holderPid = startRunnerStandIn();
    writeFile(locked, 'lock', `${holderPid}\nsome-job\n`);
    assert.equal(runShell(`trim_copy_build_data '${locked}'`).status, 0);
    expectUntouched('locked-kkkkkkkkkk');
    assert.equal(fs.readFileSync(path.join(locked, 'lock'), 'utf8'), `${holderPid}\nsome-job\n`);
  });

  it('never sources: a folder that holds a file the main box sent (the manifest lists it), and a copy with no manifest at all, are left whole', () => {
    const tracked = makeCopyWithBuildData('tracked-llllllllll', 30 * hourMs);
    writeFile(tracked, 'manifest', 'projects/x/ios/Podfile\nprojects/x/ios/build/Sources/Tracked.swift\nprojects/x/ios/build/tracked-flag.json\n');
    writeFile(path.join(tracked, 'tree'), 'projects/x/ios/build/Sources/Tracked.swift');
    writeFile(path.join(tracked, 'tree'), 'projects/x/ios/build/tracked-flag.json');
    const unknown = makeCopyWithBuildData('unknown-mmmmmmmmmm', 30 * hourMs);
    fs.rmSync(path.join(unknown, 'manifest'));
    assert.equal(runScript(['sweep-tmpdirs', workDir]).status, 0);
    assert.equal(exists('tracked-llllllllll', 'projects/x/ios/build/Sources/Tracked.swift'), true, 'the entry of `ios/build` with a sent file in it stays whole');
    assert.equal(exists('tracked-llllllllll', 'projects/x/ios/build/tracked-flag.json'), true, 'and so does a sent file that is itself an entry');
    assert.equal(exists('tracked-llllllllll', 'projects/x/ios/build/Products/app.txt'), false, 'the other entries of the same `ios/build` go');
    assert.equal(exists('tracked-llllllllll', 'ios/DerivedData/ModuleCache/m.pcm'), false, 'the other build folder of that copy goes');
    expectUntouched('unknown-mmmmmmmmmm');
  });

  it('read-only folders in the build data (an xcframework) do not keep it', () => {
    makeCopyWithBuildData('readonly-nnnnnnnnnn', 30 * hourMs);
    writeFile(path.join(workDir, 'p', 'readonly-nnnnnnnnnn', 'tree'), 'projects/x/ios/build/Pods/Core.xcframework/Info.plist');
    for (const folder of ['projects/x/ios/build/Pods/Core.xcframework', 'projects/x/ios/build/Pods', 'projects/x/ios/build']) fs.chmodSync(tree('readonly-nnnnnnnnnn', folder), 0o555);
    assert.equal(runScript(['sweep-tmpdirs', workDir]).status, 0);
    assert.equal(exists('readonly-nnnnnnnnnn', 'projects/x/ios/build/Pods'), false);
    assert.equal(exists('readonly-nnnnnnnnnn', codegenPodspec), true, 'while the codegen pods\' sources stay (their parent was read-only too)');
  });

  it('a prune on a SHORT disk trims before it removes a copy for space — on the stamp\'s turn, not every time — and a prune on a disk that is fine leaves it to the detached sweep', () => {
    makeCopyWithBuildData('idle-oooooooooo', 30 * hourMs);
    const stamp = path.join(workDir, 'tmpdir-sweep.at');
    // Only the part up to the copy removal is looked at: that step is stubbed, or the idle copy would be removed whole.
    const prune = (minFreeGb: string): void => {
      const result = runShell('prune_copies_for_space() { :; }; prune_work "$FAKE_WORK" "" skip', { REMOTE_RUN_MIN_FREE_GB: minFreeGb });
      assert.equal(result.status, 0, result.stderr);
    };
    prune('0');
    expectUntouched('idle-oooooooooo');
    prune('95');
    expectTrimmed('idle-oooooooooo');
    assert.ok(fs.existsSync(stamp), 'and takes the turn');
    for (const relative of buildData) writeFile(path.join(workDir, 'p', 'idle-oooooooooo', 'tree'), relative);
    prune('95');
    assert.equal(exists('idle-oooooooooo', buildData[0]), true, 'the second, minutes later, leaves the walk alone');
    setAge(stamp, 31 * 60 * 1000);
    prune('95');
    assert.equal(exists('idle-oooooooooo', buildData[0]), false, 'a turn that has come round trims again');
  });

  it('`prepare` starts the sweep detached, which trims: the copy of ANOTHER project, idle for a day, loses its build data a moment after a submit', async () => {
    makeCopyWithBuildData('idle-pppppppppp', 30 * hourMs);
    fs.mkdirSync(path.join(workDir, 't'), { recursive: true });
    // The renames of the trim are slowed, as a loaded host slows them: the first build folder is gone long before the last one, and before the note.
    writeExecutable(path.join(fakeBinDir, 'mv'), '#!/bin/bash\ncase "$*" in\n  *build-trash.*) /bin/mv "$@"; code=$?; sleep 0.6; exit $code ;;\nesac\nexec /bin/mv "$@"\n');
    const first = runScript(['prepare', workDir, slug, jobId, 'default=1']);
    assert.equal(first.status, 0, first.stderr);
    // The trim moves the build folders out of the tree one after the other, then writes its note and removes the trash: one folder being gone is not the trim being over. Waited for the way a teardown waits for it.
    stopDetachedRuns(workRoot);
    expectTrimmed('idle-pppppppppp');
    assert.ok(fs.existsSync(path.join(workDir, 'p', 'idle-pppppppppp', 'build-data-trimmed')), 'and the note for the next job is written');
    assert.ok(fs.existsSync(path.join(workDir, 'p', slug, 'tree')), 'and the copy of the submit itself is not what was trimmed');
  });
  it('the measured size is LOWERED by what the trim took, never dropped: a figure smaller than that goes to 0, a copy that had none is left with none (a short-disk prune reads that as «cannot tell»)', () => {
    makeCopyWithBuildData('small-qqqqqqqqqq', 30 * hourMs);
    writeFile(path.join(workDir, 'p', 'small-qqqqqqqqqq'), 'size-kb', `${4 * kibPerGib}`);
    const unmeasured = makeCopyWithBuildData('unmeasured-rrrrrrrrrr', 30 * hourMs);
    fs.rmSync(path.join(unmeasured, 'size-kb'));
    assert.equal(runScript(['sweep-tmpdirs', workDir]).status, 0);
    assert.equal(fs.readFileSync(path.join(workDir, 'p', 'small-qqqqqqqqqq', 'size-kb'), 'utf8').trim(), '0');
    assert.equal(fs.existsSync(path.join(unmeasured, 'size-kb')), false, 'no figure is made up');
    expectTrimmed('unmeasured-rrrrrrrrrr');
  });

  it('a short-disk prune over copies that were just trimmed still STOPS when removing them gives nothing back: the figures it judges by are lowered, not dropped (a copy without one can never be a verdict)', () => {
    // Three copies idle for a day, measured at 30 GiB each, 8 GiB of it build data; the free figure of the disk does not follow removals (APFS snapshots).
    for (const [name, usedAgoHours] of [['oldest-ssssssssss', 40], ['middle-tttttttttt', 38], ['newest-uuuuuuuuuu', 36]] as const) {
      const copyDir = makeCopyWithBuildData(name, usedAgoHours * hourMs);
      writeFile(copyDir, 'fake-kb', '0');
      writeFile(copyDir, 'size-kb', `${30 * kibPerGib}`);
      writeFile(path.join(copyDir, 'tree'), 'projects/x/ios/build/Build/fake-kb', `${8 * kibPerGib}`);
    }
    const result = runScript(['prune', workDir], { REMOTE_RUN_MIN_FREE_GB: '95', FAKE_DF_FREE_KB: `${10 * kibPerGib}` });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(parseRemovals(result.stdout), ['oldest-ssssssssss', 'middle-tttttttttt'], 'two removals that gave nothing back, and the prune stopped');
    assert.match(result.stdout, /^stopped=middle-tttttttttt freed_kb=0 size_kb=\d+$/m);
    assert.deepEqual(listCopies(), ['newest-uuuuuuuuuu']);
    // The trim had run before them, on all three: what was left of the newest shows it.
    assert.equal(exists('newest-uuuuuuuuuu', buildData[0]), false);
  });

  describe('the copy\'s lock is held for the renames alone', () => {
    /**
     * A `rm` that sleeps for 3 s when it is asked to remove a build trash, after leaving a marker (the removal of tens of GB takes minutes), and that writes down, when it is asked to remove a copy's lock, what was already
     * there beside it: the note for the next job and the lowered figure — what a job that takes the lock the moment it is free would meet.
     */
    function slowTrashRemoval(): { markerFile: string; lockReleaseFile: string } {
      const markerFile = path.join(workRoot, 'trash-removal-started');
      const lockReleaseFile = path.join(workRoot, 'state-at-lock-release');
      writeExecutable(path.join(fakeBinDir, 'rm'), [
        '#!/bin/bash',
        'for argument; do',
        '  case "$argument" in',
        `    *build-trash.*) : > '${markerFile}'; sleep 3 ;;`,
        `    */lock) printf 'note=%s size=%s\\n' "$([ -e "$(dirname "$argument")/build-data-trimmed" ] && echo yes || echo no)" "$(cat "$(dirname "$argument")/size-kb" 2> /dev/null)" >> '${lockReleaseFile}' ;;`,
        '  esac',
        'done',
        'exec /bin/rm "$@"',
        '',
      ].join('\n'));
      return { markerFile, lockReleaseFile };
    }

    it('the folders are renamed out of the tree, the note and the figure are written and the lock is given back BEFORE the removal starts: a job, a seed or a `clean` is not kept waiting for it, and an `exec` finds no folder half deleted', async () => {
      const copyDir = makeCopyWithBuildData('slow-vvvvvvvvvv', 30 * hourMs);
      const { markerFile, lockReleaseFile } = slowTrashRemoval();
      const sweep = spawn('bash', [scriptPath, 'sweep-tmpdirs', workDir], { env: getEnv(), stdio: 'ignore' });
      liveProcesses.push(sweep);
      const ended = new Promise<void>((resolve) => sweep.on('close', () => resolve()));
      const deadline = Date.now() + 20_000;
      while (!fs.existsSync(markerFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(fs.existsSync(markerFile), 'the removal of the trash started');
      // The removal is under way (it sleeps): everything else is already settled.
      assert.equal(fs.existsSync(path.join(copyDir, 'lock')), false, 'the lock is already given back');
      expectTrimmed('slow-vvvvvvvvvv');
      assert.equal(fs.readFileSync(path.join(copyDir, 'size-kb'), 'utf8').trim(), `${3 * kibPerGib}`);
      assert.ok(fs.existsSync(path.join(copyDir, 'build-data-trimmed')), 'the note is there before anyone can take the lock');
      const trash = fs.readdirSync(copyDir).filter((name) => name.startsWith('build-trash.'));
      assert.equal(trash.length, 1, 'the folders wait in a trash of the copy, outside its tree');
      await ended;
      assert.deepEqual(fs.readdirSync(copyDir).filter((name) => name.startsWith('build-trash')), [], 'and are removed after');
      assert.equal(fs.readFileSync(lockReleaseFile, 'utf8').trim(), `note=yes size=${3 * kibPerGib}`, 'when the lock was given back the note and the figure were already written: a job that takes the lock then meets them, never a stale note after a rebuild');
    });

    it('a trash that a sweep was cut off in the middle of removing is removed by the next one — unless its process is still alive, which is at it', () => {
      const copyDir = makeCopy('leftover-wwwwwwwwww', 1, hourMs);
      const deadPid = getDeadPid();
      const alivePid = startRunnerStandIn();
      for (const pid of [deadPid, alivePid]) writeFile(copyDir, `build-trash.${pid}/0/Products/app.txt`);
      fs.chmodSync(path.join(copyDir, `build-trash.${deadPid}`, '0'), 0o555);
      assert.equal(runScript(['sweep-tmpdirs', workDir]).status, 0);
      assert.equal(fs.existsSync(path.join(copyDir, `build-trash.${deadPid}`)), false, 'a process that is gone');
      assert.equal(fs.existsSync(path.join(copyDir, `build-trash.${alivePid}`)), true, 'a live one is removing it');
    });
  });

  it('an `ios/build` that holds nothing but `generated` is left alone, with no note and no change of the figure: nothing in it is derived data', () => {
    const copyDir = makeCopy('onlygen-yyyyyyyyyy', 5, 30 * hourMs);
    writeFile(path.join(copyDir, 'tree'), codegenPodspec);
    writeFile(copyDir, 'manifest', 'projects/x/package.json\n');
    writeFile(copyDir, 'size-kb', `${5 * kibPerGib}`);
    assert.equal(runScript(['sweep-tmpdirs', workDir]).status, 0);
    assert.equal(exists('onlygen-yyyyyyyyyy', codegenPodspec), true);
    assert.equal(fs.existsSync(path.join(copyDir, 'build-data-trimmed')), false);
    assert.equal(fs.readFileSync(path.join(copyDir, 'size-kb'), 'utf8').trim(), `${5 * kibPerGib}`);
  });

  it('never leaves the copy: a build folder that is a symlink (`ios/build` -> somewhere), an app folder that is a symlink to a folder holding `ios/build`, are not followed and not touched; a folder with a SPACE in its path is trimmed like any', () => {
    const copyDir = makeCopy('links-xxxxxxxxxx', 5, 30 * hourMs);
    const outside = path.join(workRoot, 'outside');
    writeFile(outside, 'keep/derived.txt', 'not the runner\'s');
    writeFile(outside, 'ios/build/Products/inner.txt', 'not the runner\'s either');
    const treeDir = path.join(copyDir, 'tree');
    fs.mkdirSync(path.join(treeDir, 'projects', 'x', 'ios'), { recursive: true });
    fs.symlinkSync(path.join(outside, 'keep'), path.join(treeDir, 'projects', 'x', 'ios', 'build'));
    fs.symlinkSync(outside, path.join(treeDir, 'projects', 'linked'));
    writeFile(treeDir, 'projects/my app/ios/build/Products/a.txt');
    writeFile(treeDir, 'projects/my app/ios/Podfile');
    writeFile(copyDir, 'manifest', 'projects/my app/ios/Podfile\n');
    assert.equal(runScript(['sweep-tmpdirs', workDir]).status, 0);
    assert.equal(fs.readFileSync(path.join(outside, 'keep', 'derived.txt'), 'utf8'), 'not the runner\'s', 'the folder a build link points to is untouched');
    assert.equal(fs.readFileSync(path.join(outside, 'ios', 'build', 'Products', 'inner.txt'), 'utf8'), 'not the runner\'s either', 'and so is one an app folder link leads to');
    assert.ok(fs.lstatSync(path.join(treeDir, 'projects', 'x', 'ios', 'build')).isSymbolicLink(), 'the links stay as they are');
    assert.ok(fs.lstatSync(path.join(treeDir, 'projects', 'linked')).isSymbolicLink());
    assert.equal(fs.existsSync(path.join(treeDir, 'projects', 'my app', 'ios', 'build', 'Products')), false, 'the folder with a space in its path is trimmed');
    assert.equal(fs.existsSync(path.join(treeDir, 'projects', 'my app', 'ios', 'Podfile')), true, 'and its sources stay');
    assert.equal(fs.readFileSync(path.join(copyDir, 'build-data-trimmed'), 'utf8').trim(), 'projects/my app/ios/build');
  });
});
