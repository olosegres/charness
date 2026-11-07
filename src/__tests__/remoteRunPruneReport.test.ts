/**
 * @description `remoteRun/pruneReport.ts`: the lines a runner\'s `prepare` prints about the project copies its prune removed, parsed, and the one short line each becomes in the submit\'s output.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { diskTooLowRunnerExitCode, formatPrunedCopyLine, parsePrunedCopies } from '../remoteRun/pruneReport';
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

describe('the exit code the runner refuses with', () => {
  it('is the same number in the script and here', () => {
    const script = fs.readFileSync(scriptPath, 'utf8');
    assert.equal(new RegExp(`^low_disk_exit_code=${diskTooLowRunnerExitCode}$`, 'm').test(script), true);
  });
});
