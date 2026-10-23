/**
 * @description Coverage for `scripts/self-update.sh` against throwaway repositories (a bare origin, a checkout that carries
 * the script, a second clone that pushes): `--check` says what an update would do and changes nothing (behind / up to date /
 * the five skips), `--hold-breaking` stops at a range that adds a `MIGRATION_*.md`, the plain run still fast-forwards,
 * installs when the lock changed, refreshes the Docker image's install stamp and builds when no watcher owns the checkout.
 * `yarn` is a stub that logs its calls; nothing outside the temp dir is touched.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const realScriptPath = path.resolve(__dirname, '..', '..', 'scripts', 'self-update.sh');
const heldBreakingExitCode = 3;

let sandboxDir: string;
let originDir: string;
let workDir: string;
let otherDir: string;
let stubBinDir: string;
let stubLogPath: string;

function createEnv(): NodeJS.ProcessEnv {
  return {
    PATH: `${stubBinDir}:${process.env.PATH}`,
    HOME: path.join(sandboxDir, 'home'),
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_SYSTEM: os.devNull,
    GIT_AUTHOR_NAME: 'Update Test',
    GIT_AUTHOR_EMAIL: 'update-test@example.invalid',
    GIT_COMMITTER_NAME: 'Update Test',
    GIT_COMMITTER_EMAIL: 'update-test@example.invalid',
    STUB_LOG: stubLogPath,
  };
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, env: createEnv(), encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} (${cwd}): ${result.stderr}`);
  return result.stdout.trim();
}

function writeFile(root: string, relativePath: string, content: string): void {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

/** A commit pushed to origin by someone else. */
function pushFromOther(files: Record<string, string>, message: string): string {
  git(otherDir, 'pull', '-q', '--rebase', 'origin', 'main');
  for (const [relativePath, content] of Object.entries(files)) writeFile(otherDir, relativePath, content);
  git(otherDir, 'add', '-A');
  git(otherDir, 'commit', '-q', '-m', message);
  git(otherDir, 'push', '-q', 'origin', 'main');
  return git(otherDir, 'rev-parse', '--short=7', 'HEAD');
}

interface ScriptRun {
  status: number | null;
  /** The `key=value` lines of stdout. */
  keys: Record<string, string>;
  stdout: string;
  stderr: string;
}

function runScript(...args: string[]): ScriptRun {
  const result = spawnSync('bash', [path.join(workDir, 'scripts', 'self-update.sh'), ...args], { cwd: workDir, env: createEnv(), encoding: 'utf8' });
  const keys: Record<string, string> = {};
  for (const line of result.stdout.split('\n')) {
    const match = /^(status|reason|from|to|behind|migrationGuides)=(.*)$/.exec(line);
    if (match) keys[match[1]] = match[2];
  }
  return { status: result.status, keys, stdout: result.stdout, stderr: result.stderr };
}

function readStubLog(): string[] {
  return fs.existsSync(stubLogPath) ? fs.readFileSync(stubLogPath, 'utf8').split('\n').filter((line) => line !== '') : [];
}

beforeEach(() => {
  sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-selfupdate-'));
  originDir = path.join(sandboxDir, 'origin.git');
  workDir = path.join(sandboxDir, 'work');
  otherDir = path.join(sandboxDir, 'other');
  stubBinDir = path.join(sandboxDir, 'bin');
  stubLogPath = path.join(sandboxDir, 'stub.log');
  fs.mkdirSync(path.join(sandboxDir, 'home'));
  fs.mkdirSync(stubBinDir);
  fs.writeFileSync(path.join(stubBinDir, 'yarn'), '#!/bin/sh\necho "yarn $*" >> "$STUB_LOG"\n', { mode: 0o755 });

  git(sandboxDir, 'init', '-q', '--bare', '-b', 'main', originDir);
  git(sandboxDir, 'clone', '-q', originDir, workDir);
  git(workDir, 'checkout', '-q', '-b', 'main');
  writeFile(workDir, 'scripts/self-update.sh', fs.readFileSync(realScriptPath, 'utf8'));
  writeFile(workDir, 'package.json', '{"name":"demo"}\n');
  writeFile(workDir, 'yarn.lock', '# lock 1\n');
  writeFile(workDir, 'src/a.ts', 'export const a = 1;\n');
  git(workDir, 'add', '-A');
  git(workDir, 'commit', '-q', '-m', 'chore: initial');
  git(workDir, 'push', '-q', '-u', 'origin', 'main');
  git(sandboxDir, 'clone', '-q', originDir, otherDir);
});

afterEach(() => {
  fs.rmSync(sandboxDir, { recursive: true, force: true });
});

describe('--check', () => {
  test('up to date: says so, the same commit twice', () => {
    const head = git(workDir, 'rev-parse', '--short=7', 'HEAD');
    const result = runScript('--check');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.keys, { status: 'upToDate', from: head, to: head, behind: '0', migrationGuides: '' });
  });

  test('behind: the two commits, how many, no migration guide — and the checkout is untouched', () => {
    const before = git(workDir, 'rev-parse', '--short=7', 'HEAD');
    pushFromOther({ 'src/a.ts': 'export const a = 2;\n' }, 'fix: one');
    const target = pushFromOther({ 'src/a.ts': 'export const a = 3;\n' }, 'fix: two');
    const result = runScript('--check');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.keys, { status: 'behind', from: before, to: target, behind: '2', migrationGuides: '' });
    assert.equal(git(workDir, 'rev-parse', '--short=7', 'HEAD'), before, 'a check never merges');
    assert.deepEqual(readStubLog(), [], 'a check never runs yarn');
    assert.equal(result.stdout.includes('[self-update]'), false, 'the log of a check goes to stderr, stdout holds only the keys');
  });

  test('the migration guides a range ADDS are named; one that only changes an old guide is not', () => {
    pushFromOther({ 'MIGRATION_3_TO_4.md': '# guide\n', 'MIGRATION_OTHER.md': '# other\n' }, 'docs: guides');
    pushFromOther({ 'MIGRATION_3_TO_4.md': '# guide, edited\n' }, 'docs: edit');
    const result = runScript('--check');
    assert.equal(result.keys.migrationGuides, 'MIGRATION_3_TO_4.md MIGRATION_OTHER.md');
  });

  test('skip dirty: a tracked change, untracked files do not count', () => {
    writeFile(workDir, 'untracked.txt', 'x\n');
    assert.equal(runScript('--check').keys.status, 'upToDate');
    writeFile(workDir, 'src/a.ts', 'export const a = 99;\n');
    assert.deepEqual(runScript('--check').keys, { status: 'skip', reason: 'dirty' });
  });

  test('skip diverged: local commits, with and without new upstream ones', () => {
    writeFile(workDir, 'src/b.ts', 'export const b = 1;\n');
    git(workDir, 'add', '-A');
    git(workDir, 'commit', '-q', '-m', 'feat: local only');
    assert.deepEqual(runScript('--check').keys, { status: 'skip', reason: 'diverged' }, 'ahead of origin');
    pushFromOther({ 'src/c.ts': 'export const c = 1;\n' }, 'fix: upstream');
    assert.deepEqual(runScript('--check').keys, { status: 'skip', reason: 'diverged' }, 'diverged');
  });

  test('skip noUpstream: a branch that tracks nothing', () => {
    git(workDir, 'checkout', '-q', '-b', 'topic');
    assert.deepEqual(runScript('--check').keys, { status: 'skip', reason: 'noUpstream' });
  });

  test('skip inProgress: a merge or rebase under way', () => {
    fs.writeFileSync(path.join(workDir, '.git', 'MERGE_HEAD'), `${git(workDir, 'rev-parse', 'HEAD')}\n`);
    assert.deepEqual(runScript('--check').keys, { status: 'skip', reason: 'inProgress' });
    fs.rmSync(path.join(workDir, '.git', 'MERGE_HEAD'));
    fs.mkdirSync(path.join(workDir, '.git', 'rebase-merge'));
    assert.deepEqual(runScript('--check').keys, { status: 'skip', reason: 'inProgress' });
  });

  test('skip fetchFailed: the remote does not answer, exit 0 (a check never fails the caller)', () => {
    git(workDir, 'remote', 'set-url', 'origin', path.join(sandboxDir, 'gone.git'));
    const result = runScript('--check');
    assert.equal(result.status, 0);
    assert.deepEqual(result.keys, { status: 'skip', reason: 'fetchFailed' });
  });
});

describe('the update (what cron runs)', () => {
  test('fast-forwards, names from and to, builds when no watcher owns the checkout, installs nothing when the lock is unchanged', () => {
    const before = git(workDir, 'rev-parse', '--short=7', 'HEAD');
    const target = pushFromOther({ 'src/a.ts': 'export const a = 2;\n' }, 'fix: one');
    const result = runScript();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.keys, { status: 'updated', from: before, to: target, behind: '1', migrationGuides: '' });
    assert.match(result.stdout, /\[self-update\] updated \w+\.\.\w+ \(1 commits\)/);
    assert.equal(git(workDir, 'rev-parse', '--short=7', 'HEAD'), target);
    assert.deepEqual(readStubLog(), ['yarn build']);
  });

  test('up to date: nothing to do, nothing built', () => {
    const result = runScript();
    assert.equal(result.status, 0);
    assert.equal(result.keys.status, 'upToDate');
    assert.deepEqual(readStubLog(), []);
  });

  test('a changed yarn.lock runs `yarn install --immutable` and refreshes the Docker install stamp that exists', () => {
    const stampPath = path.join(workDir, 'node_modules', '.charness-image');
    fs.mkdirSync(path.dirname(stampPath), { recursive: true });
    fs.writeFileSync(stampPath, 'stale\n');
    const newLock = '# lock 2\n';
    pushFromOther({ 'yarn.lock': newLock }, 'chore: dependencies');
    const result = runScript();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readStubLog(), ['yarn install --immutable', 'yarn build']);
    assert.equal(fs.readFileSync(stampPath, 'utf8').trim(), crypto.createHash('sha256').update(newLock).digest('hex'));
    assert.equal(fs.existsSync(path.join(workDir, 'node_modules', '.telegramcode-image')), false, 'a stamp that did not exist is not created');
  });

  test('without a stamp (not the image) none is created', () => {
    pushFromOther({ 'yarn.lock': '# lock 2\n' }, 'chore: dependencies');
    assert.equal(runScript().status, 0);
    assert.equal(fs.existsSync(path.join(workDir, 'node_modules')), false);
  });

  test('a hot watcher on the checkout rebuilds by itself: no `yarn build`; a changed lock nudges it by touching tsconfig.json', async () => {
    // pgrep -f matches the full command line: a process that carries `<checkout>/node_modules/.bin/tsc` is "the watcher".
    const watcher = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', path.join(workDir, 'node_modules', '.bin', 'tsc')], { stdio: 'ignore' });
    try {
      writeFile(workDir, 'tsconfig.json', '{}\n');
      git(workDir, 'add', '-A');
      git(workDir, 'commit', '-q', '-m', 'chore: tsconfig');
      git(workDir, 'push', '-q', 'origin', 'main');
      const touchedBefore = fs.statSync(path.join(workDir, 'tsconfig.json')).mtimeMs;
      pushFromOther({ 'yarn.lock': '# lock 2\n' }, 'chore: dependencies');
      await new Promise((resolve) => setTimeout(resolve, 50));
      const result = runScript();
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /hot mode detected/);
      assert.match(result.stdout, /nudged tsc -w/);
      assert.deepEqual(readStubLog(), ['yarn install --immutable']);
      assert.ok(fs.statSync(path.join(workDir, 'tsconfig.json')).mtimeMs > touchedBefore);
    } finally {
      watcher.kill('SIGKILL');
    }
  });

  test('a migration guide in the range is merged by the plain run, with the log warning it always had', () => {
    pushFromOther({ 'MIGRATION_3_TO_4.md': '# guide\n' }, 'docs: guide');
    const result = runScript();
    assert.equal(result.status, 0);
    assert.equal(result.keys.status, 'updated');
    assert.equal(result.keys.migrationGuides, 'MIGRATION_3_TO_4.md');
    assert.match(result.stdout, /WARNING: breaking change — read MIGRATION_3_TO_4\.md and the top entry of CHANGELOG\.md/);
  });

  test('a checkout the check skips is skipped by the update too — same reasons, same words, exit 0', () => {
    writeFile(workDir, 'src/a.ts', 'export const a = 99;\n');
    pushFromOther({ 'src/b.ts': 'export const b = 1;\n' }, 'fix: upstream');
    const result = runScript();
    assert.equal(result.status, 0);
    assert.match(result.stdout, /\[self-update\] tracked changes in the working tree — skip/);
    assert.deepEqual(result.keys, { status: 'skip', reason: 'dirty' });
    assert.deepEqual(readStubLog(), []);
  });

  test('an unreachable remote fails the update (cron mails it) with the reason named', () => {
    git(workDir, 'remote', 'set-url', 'origin', path.join(sandboxDir, 'gone.git'));
    const result = runScript();
    assert.equal(result.status, 1);
    assert.deepEqual(result.keys, { status: 'skip', reason: 'fetchFailed' });
  });
});

describe('--hold-breaking', () => {
  test('a range that adds a MIGRATION_*.md is not merged: exit 3, from / to / guides named, the checkout untouched', () => {
    const before = git(workDir, 'rev-parse', '--short=7', 'HEAD');
    pushFromOther({ 'src/a.ts': 'export const a = 2;\n' }, 'fix: one');
    const target = pushFromOther({ 'MIGRATION_3_TO_4.md': '# guide\n' }, 'docs: guide');
    const result = runScript('--hold-breaking');
    assert.equal(result.status, heldBreakingExitCode);
    assert.deepEqual(result.keys, { status: 'held', from: before, to: target, behind: '2', migrationGuides: 'MIGRATION_3_TO_4.md' });
    assert.equal(git(workDir, 'rev-parse', '--short=7', 'HEAD'), before);
    assert.deepEqual(readStubLog(), []);
  });

  test('without a guide in the range it updates like the plain run', () => {
    const target = pushFromOther({ 'src/a.ts': 'export const a = 2;\n' }, 'fix: one');
    const result = runScript('--hold-breaking');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.keys.status, 'updated');
    assert.equal(git(workDir, 'rev-parse', '--short=7', 'HEAD'), target);
  });
});

test('an unknown argument is refused', () => {
  const result = runScript('--nope');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown argument: --nope/);
});
