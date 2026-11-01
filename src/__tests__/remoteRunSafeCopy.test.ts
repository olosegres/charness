/**
 * @description `remoteRun/safeCopy.ts`: the runner is not trusted to write into the main box. Only regular files that a `pull:` pattern
 * names come in; a symlink, a path no pattern names, or a destination that would pass through a symlink or over a directory of the
 * project is refused (and counted), and nothing outside the project root is ever written.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { copyFetchedFiles, getProtectedPathReason } from '../remoteRun/safeCopy';

let workRoot = '';
let fetchedRoot = '';
let projectRoot = '';
let outsideRoot = '';

function writeFile(root: string, relativePath: string, content: string, mode = 0o644): void {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, { mode });
  fs.chmodSync(target, mode);
}

describe('copyFetchedFiles', () => {
  beforeEach(() => {
    workRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'safe-copy-')));
    fetchedRoot = path.join(workRoot, 'fetched');
    projectRoot = path.join(workRoot, 'project');
    outsideRoot = path.join(workRoot, 'outside');
    for (const directory of [fetchedRoot, projectRoot, outsideRoot]) fs.mkdirSync(directory);
  });
  afterEach(() => {
    fs.rmSync(workRoot, { recursive: true, force: true });
  });

  it('copies the files a pattern names, creating the folders, and nothing else', () => {
    writeFile(fetchedRoot, 'e2e/artifacts/shot.png', 'png');
    writeFile(fetchedRoot, 'src/__snapshots__/a.snap', 'snap');
    writeFile(fetchedRoot, 'src/other.ts', 'not named');
    const result = copyFetchedFiles({ fetchedRoot, projectRoot, patterns: ['e2e/artifacts', '**/__snapshots__'] });
    assert.deepEqual(result.copied.sort(), ['e2e/artifacts/shot.png', 'src/__snapshots__/a.snap']);
    assert.equal(result.refusedCount, 1);
    assert.equal(fs.readFileSync(path.join(projectRoot, 'src/__snapshots__/a.snap'), 'utf8'), 'snap');
    assert.equal(fs.existsSync(path.join(projectRoot, 'src/other.ts')), false);
  });

  it('overwrites an existing regular file of the project (an updated snapshot) and keeps its executable bit', () => {
    writeFile(projectRoot, 'test-results/run.sh', 'old', 0o644);
    writeFile(fetchedRoot, 'test-results/run.sh', 'new', 0o755);
    copyFetchedFiles({ fetchedRoot, projectRoot, patterns: ['test-results'] });
    assert.equal(fs.readFileSync(path.join(projectRoot, 'test-results/run.sh'), 'utf8'), 'new');
    assert.equal(fs.statSync(path.join(projectRoot, 'test-results/run.sh')).mode & 0o777, 0o755);
  });

  it('strips setuid and setgid', () => {
    writeFile(fetchedRoot, 'test-results/tool', 'x', 0o755);
    fs.chmodSync(path.join(fetchedRoot, 'test-results/tool'), 0o6755);
    copyFetchedFiles({ fetchedRoot, projectRoot, patterns: ['test-results'] });
    assert.equal(fs.statSync(path.join(projectRoot, 'test-results/tool')).mode & 0o7777, 0o755);
  });

  it('refuses a symlink in the fetched folder, even one a pattern names', () => {
    writeFile(outsideRoot, 'secret.txt', 'secret');
    fs.mkdirSync(path.join(fetchedRoot, 'test-results'));
    fs.symlinkSync(path.join(outsideRoot, 'secret.txt'), path.join(fetchedRoot, 'test-results/link.txt'));
    const result = copyFetchedFiles({ fetchedRoot, projectRoot, patterns: ['test-results'] });
    assert.deepEqual(result.copied, []);
    assert.equal(result.refusedCount, 1);
    assert.equal(fs.existsSync(path.join(projectRoot, 'test-results/link.txt')), false);
  });

  it('refuses to write through a directory of the project that is a symlink to somewhere else — nothing lands outside', () => {
    fs.symlinkSync(outsideRoot, path.join(projectRoot, 'test-results'));
    writeFile(fetchedRoot, 'test-results/escaped.txt', 'x');
    const result = copyFetchedFiles({ fetchedRoot, projectRoot, patterns: ['test-results'] });
    assert.deepEqual(result.copied, []);
    assert.equal(result.refusedCount, 1);
    assert.deepEqual(fs.readdirSync(outsideRoot), []);
  });

  it('refuses to write over a symlink file of the project (it would write to the link\'s target)', () => {
    writeFile(outsideRoot, 'target.txt', 'untouched');
    fs.mkdirSync(path.join(projectRoot, 'test-results'));
    fs.symlinkSync(path.join(outsideRoot, 'target.txt'), path.join(projectRoot, 'test-results/report.txt'));
    writeFile(fetchedRoot, 'test-results/report.txt', 'from the runner');
    const result = copyFetchedFiles({ fetchedRoot, projectRoot, patterns: ['test-results'] });
    assert.equal(result.copied.length, 0);
    assert.equal(fs.readFileSync(path.join(outsideRoot, 'target.txt'), 'utf8'), 'untouched');
  });

  it('refuses to replace a directory of the project with a file', () => {
    fs.mkdirSync(path.join(projectRoot, 'test-results/report'), { recursive: true });
    writeFile(fetchedRoot, 'test-results/report', 'a file where the project has a folder');
    const result = copyFetchedFiles({ fetchedRoot, projectRoot, patterns: ['test-results'] });
    assert.equal(result.copied.length, 0);
    assert.equal(result.refusedCount, 1);
    assert.ok(fs.statSync(path.join(projectRoot, 'test-results/report')).isDirectory());
  });

  it('a broad pattern (**) brings every regular file EXCEPT anything inside a .git and the project\'s own .remote-run — a hostile runner cannot plant a hook or a config', () => {
    fs.mkdirSync(path.join(projectRoot, '.git', 'hooks'), { recursive: true });
    for (const safe of ['ok.txt', 'sub/ok.txt', 'sub/.remote-run', '.gitignore', '.github/workflows/ci.yml', 'gitlog.txt']) writeFile(fetchedRoot, safe, 'fine');
    for (const hostile of ['.git/hooks/pre-commit', '.git/config', 'sub/.git', 'nested/.git/hooks/post-merge', '.Git/hooks/pre-push', '.GIT/config', '.remote-run', '.REMOTE-RUN']) writeFile(fetchedRoot, hostile, 'planted');
    writeFile(projectRoot, '.remote-run', 'pull: **\n');
    const result = copyFetchedFiles({ fetchedRoot, projectRoot, patterns: ['**'] });
    assert.deepEqual(result.copied.sort(), ['.github/workflows/ci.yml', '.gitignore', 'gitlog.txt', 'ok.txt', 'sub/.remote-run', 'sub/ok.txt']);
    assert.equal(result.refusedCount, 8);
    assert.deepEqual(fs.readdirSync(path.join(projectRoot, '.git', 'hooks')), [], 'no hook was planted');
    assert.equal(fs.existsSync(path.join(projectRoot, '.git', 'config')), false);
    assert.equal(fs.readFileSync(path.join(projectRoot, '.remote-run'), 'utf8'), 'pull: **\n', 'the project\'s own config is untouched');
    for (const caseVariant of ['.Git', '.GIT']) assert.equal(fs.existsSync(path.join(projectRoot, caseVariant)), false, caseVariant);
  });

  it('a pattern that names .git or .remote-run outright does not bring them either', () => {
    writeFile(fetchedRoot, '.git/hooks/pre-commit', 'planted');
    writeFile(fetchedRoot, '.remote-run', 'planted');
    const result = copyFetchedFiles({ fetchedRoot, projectRoot, patterns: ['.git', '.remote-run'] });
    assert.deepEqual(result, { copied: [], refusedCount: 2 });
  });

  it('getProtectedPathReason: a .git anywhere in the path, only the ROOT .remote-run, case-insensitively', () => {
    assert.equal(getProtectedPathReason('.git/hooks/pre-commit'), 'inside a .git');
    assert.equal(getProtectedPathReason('a/b/.git'), 'inside a .git');
    assert.equal(getProtectedPathReason('x/.GIT/config'), 'inside a .git');
    assert.equal(getProtectedPathReason('.remote-run'), "the project's .remote-run");
    assert.equal(getProtectedPathReason('.Remote-Run'), "the project's .remote-run");
    for (const fine of ['sub/.remote-run', '.gitignore', '.gitattributes', '.github/x', 'my.git/x', 'out/report.txt']) assert.equal(getProtectedPathReason(fine), null, fine);
  });

  it('leaves no temp file behind', () => {
    writeFile(fetchedRoot, 'test-results/a.txt', 'a');
    copyFetchedFiles({ fetchedRoot, projectRoot, patterns: ['test-results'] });
    assert.deepEqual(fs.readdirSync(path.join(projectRoot, 'test-results')), ['a.txt']);
  });

  it('with no pattern nothing is copied and every file is counted refused', () => {
    writeFile(fetchedRoot, 'a.txt', 'a');
    assert.deepEqual(copyFetchedFiles({ fetchedRoot, projectRoot, patterns: [] }), { copied: [], refusedCount: 1 });
  });
});
