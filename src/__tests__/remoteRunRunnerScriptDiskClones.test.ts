/**
 * @description `remoteRun/runner.sh` — the disk upkeep of a runner, the clones part of `remoteRunRunnerScriptDiskCopies.test.ts` (they share `remoteRunRunnerScriptDiskKit.ts`; split because a file runs under one time limit and one ran
 * 95 s alone on a loaded box; the clones' cost cases live in `remoteRunRunnerScriptDiskClonesCost.test.ts`): what shows the sizes of clones says that `du` counts them in full, and a caller that hangs up while `prepare` removes copies. Run against the real script and a real shell, with the fake disk of the kit.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */


import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { diskTooLowRunnerExitCode } from '../remoteRun/pruneReport';
import { parseProbeOutput } from '../remoteRun/probe';
import { jobId, scriptPath, slug, startRunnerStandIn, writeFile } from './remoteRunRunnerScriptKit';
import { kibPerGib, hourMs, workDir, getEnv, runScript, makeCopy, writeJob, listCopies, useDiskHarness } from './remoteRunRunnerScriptDiskKit';

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
