/**
 * @description `runner-scripts/runner.sh` — the disk upkeep of a runner, the clones' COST part of `remoteRunRunnerScriptDiskClones.test.ts` (they share
 * `remoteRunRunnerScriptDiskKit.ts`; split because a file runs under one time limit and that one ran 115 s alone on a loaded box): the
 * cost is linear in the number of copies — each copy's group of clones is read once, by the probe and by the refusal that names the
 * biggest copies. Run against the real script and a real shell, with the fake disk of the kit.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { diskTooLowRunnerExitCode } from '../remoteRun/pruneReport';
import { parseProbeOutput } from '../remoteRun/probe';
import { jobId, slug, startRunnerStandIn, writeFile } from './remoteRunRunnerScriptKit';
import { kibPerGib, hourMs, workRoot, workDir, fakeBinDir, writeExecutable, runScript, makeCopy, writeJob, useDiskHarness } from './remoteRunRunnerScriptDiskKit';

useDiskHarness();

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
