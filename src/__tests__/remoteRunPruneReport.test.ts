/**
 * @description `remoteRun/pruneReport.ts`: the lines a runner\'s `prepare` prints about the project copies its prune removed, parsed, and the one short line each becomes in the submit\'s output.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseProbeOutput } from '../remoteRun/probe';
import { describePrepareTimeout, diskTooLowRunnerExitCode, formatPrunedCopyLine, formatPruneHeadsUp, formatRemovalStopLine, parsePrunedCopies, parseRemovalStop } from '../remoteRun/pruneReport';
import { scriptPath } from './remoteRunRunnerScriptKit';
import fs from 'fs';

describe('parsePrunedCopies', () => {
  it('reads a removed copy with what it freed and why, and a copy that would not go; other lines are not its business', () => {
    const copies = parsePrunedCopies('removed=app-1 freed_kb=31457280 why=space\nsome other line\nremoved=app-2 freed_kb= why=idle\nstuck=app-3\nwork=/runner/work\n');
    assert.deepEqual(copies, [
      { slug: 'app-1', isStuck: false, freedMb: 30720, reason: 'space' },
      { slug: 'app-2', isStuck: false, freedMb: null, reason: 'idle' },
      { slug: 'app-3', isStuck: true },
    ]);
  });

  it('a line that is not exactly the format (a word before it, an unknown reason, a slug with a path) is ignored', () => {
    assert.deepEqual(parsePrunedCopies('x removed=a freed_kb=1 why=idle\nremoved=a freed_kb=1 why=whim\nstuck=a b\n'), []);
  });
});

describe('formatPrunedCopyLine', () => {
  it('says which copy went, what it freed and why — for the two reasons, with and without a figure', () => {
    assert.equal(formatPrunedCopyLine('mac', { slug: 'app-1', isStuck: false, freedMb: 41 * 1024, reason: 'idle' }), 'runner mac: removed the project copy app-1 (freed 41 GB, unused for days)');
    assert.equal(formatPrunedCopyLine('mac', { slug: 'app-1', isStuck: false, freedMb: 512, reason: 'space' }), 'runner mac: removed the project copy app-1 (freed 0.5 GB, the disk was short of free space)');
    assert.equal(formatPrunedCopyLine('mac', { slug: 'app-1', isStuck: false, freedMb: null, reason: 'space' }), 'runner mac: removed the project copy app-1 (the disk was short of free space)');
  });

  it('a copy that would not go says so, and that the next prune tries again', () => {
    assert.equal(formatPrunedCopyLine('mac', { slug: 'app-3', isStuck: true }), 'runner mac: could not remove the project copy app-3 completely (read-only or in use) — the next prune tries again');
  });
});

describe('the prune that stopped because a removal gave nothing back', () => {
  it('is read from its `stopped=` line, in megabytes; no such line is none, and a malformed one is none', () => {
    assert.deepEqual(parseRemovalStop('removed=app-1 freed_kb=0 why=space\nstopped=app-1 freed_kb=0 size_kb=31457280\nwork=/w\n'), { slug: 'app-1', freedMb: 0, sizeMb: 30720 });
    assert.equal(parseRemovalStop('removed=app-1 freed_kb=31457280 why=space\n'), null);
    assert.equal(parseRemovalStop('stopped=app-1 freed_kb= size_kb=1\nstopped=a b freed_kb=0 size_kb=1\n'), null);
  });

  it('says what it saw and the Mac cause it points at', () => {
    assert.equal(
      formatRemovalStopLine('mac', { slug: 'app-1', freedMb: 0, sizeMb: 30720 }),
      "runner mac: removing the project copy app-1 gave back 0 GB of its 30 GB — the disk's free space is not following (on a Mac: Time Machine local snapshots or purgeable space, see docs/remote-run.md), so it stopped removing more copies",
    );
  });
});

describe('the words before and after a slow prepare', () => {
  const probeOf = (diskFreeMb: number, diskMinFreeMb: number | null): ReturnType<typeof parseProbeOutput> => parseProbeOutput(['os=Darwin', `disk_free_mb=${diskFreeMb}`, ...(diskMinFreeMb === null ? [] : [`disk_min_free_mb=${diskMinFreeMb}`])].join('\n'));

  it('a disk under what the runner keeps free is announced, with both figures: the removal that follows is silent for minutes', () => {
    assert.equal(
      formatPruneHeadsUp('mac', probeOf(8 * 1024, 60 * 1024)),
      'runner mac: 8 GB free, it keeps 60 GB — removing the least recently used project copies first (this can take minutes)',
    );
  });

  it('a disk at its target, a runner that wants none (0), one that did not say and one never probed are not announced', () => {
    assert.equal(formatPruneHeadsUp('mac', probeOf(100 * 1024, 60 * 1024)), null);
    assert.equal(formatPruneHeadsUp('mac', probeOf(8 * 1024, 0)), null);
    assert.equal(formatPruneHeadsUp('mac', probeOf(8 * 1024, null)), null);
    assert.equal(formatPruneHeadsUp('mac', null), null);
  });

  it('a prepare that ran out of its time says the runner goes on by itself and to submit again, not that something failed', () => {
    assert.equal(
      describePrepareTimeout('mac', 15 * 60 * 1000),
      'runner "mac": preparing the job took longer than 15 minutes (it removes old project copies first, which is slow on a big disk) — the runner goes on with that by itself: submit again in a few minutes',
    );
  });
});

describe('the exit code the runner refuses with', () => {
  it('is the same number in the script and here', () => {
    const script = fs.readFileSync(scriptPath, 'utf8');
    assert.equal(new RegExp(`^low_disk_exit_code=${diskTooLowRunnerExitCode}$`, 'm').test(script), true);
  });
});
