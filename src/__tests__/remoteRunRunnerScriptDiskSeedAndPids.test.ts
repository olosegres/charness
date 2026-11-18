/**
 * @description `remoteRun/runner.sh` — the disk upkeep of a runner, the second part of `remoteRunRunnerScriptDisk.test.ts` (they share `remoteRunRunnerScriptDiskKit.ts`; split because a file runs under one time limit and one ran 91 s alone on a loaded box):
 * a disk whose free figure does not follow the removals (APFS snapshots, purgeable space) and the copies cloned from each other that share blocks; the copy the first run of a submitted job is seeded from is pruned last;
 * the probe that picks a runner never prunes; a pid that went to a stranger pins nothing and the script's test of "that pid is still one of ours"; a submit waits behind another prune only while its own disk is short; a put-back that
 * meets a folder somebody just made. The disk and the sizes are faked by a `df` and a `du` on the PATH that read a `fake-kb` file in each copy.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { diskTooLowRunnerExitCode } from '../remoteRun/pruneReport';
import { jobId, slug, startRunnerStandIn, startStrangerProcess, writeFile } from './remoteRunRunnerScriptKit';
import { kibPerGib, dayMs, hourMs, workDir, fakeBinDir, writeExecutable, runScript, setAge, makeCopy, writeJob, liveProcesses, getDeadPid, runShell, listCopies, parseRemovals, useDiskHarness } from './remoteRunRunnerScriptDiskKit';

useDiskHarness();

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
