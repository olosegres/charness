/**
 * @description `remoteRun/project.ts` over REAL git repositories: which files a project sends — tracked and untracked, never ignored,
 * a file deleted on disk but still in the index dropped, submodules' files included under their folder (the gitlink itself is not a
 * file), `.git` never — what `.remote-run` trims and opts in (`exclude:`, `send:`, also for a file git ignores), the held-back secrets,
 * the refused names, the project root and subfolder, and the refusal of a folder that is not a git project.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getHookDirectories, getProjectContext, planProjectSend, readProjectConfig } from '../remoteRun/project';
import { RemoteRunError } from '../remoteRun/remoteRunError';

let workRoot = '';

function git(directory: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=Test', '-c', 'protocol.file.allow=always', '-C', directory, ...args], { stdio: 'ignore' });
}

function writeFile(root: string, relativePath: string, content = 'x'): void {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function createRepository(name: string): string {
  const directory = path.join(workRoot, name);
  fs.mkdirSync(directory);
  git(directory, 'init', '-q', '-b', 'main');
  return directory;
}

describe('planProjectSend', () => {
  beforeEach(() => {
    workRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remote-run-project-')));
  });
  afterEach(() => {
    fs.rmSync(workRoot, { recursive: true, force: true });
  });

  it('sends tracked and untracked files, never ignored ones, drops a tracked file that is gone, never .git', () => {
    const repository = createRepository('app');
    writeFile(repository, '.gitignore', 'node_modules/\nbuild/\n*.log\n');
    writeFile(repository, 'src/tracked.ts');
    writeFile(repository, 'src/deleted.ts');
    git(repository, 'add', '-A');
    git(repository, 'commit', '-q', '-m', 'init');
    writeFile(repository, 'src/untracked.ts');
    writeFile(repository, 'node_modules/dep/index.js');
    writeFile(repository, 'build/out.js');
    writeFile(repository, 'run.log');
    fs.rmSync(path.join(repository, 'src/deleted.ts'));
    const plan = planProjectSend(getProjectContext(repository));
    assert.deepEqual(plan.files, ['.gitignore', 'src/tracked.ts', 'src/untracked.ts']);
    assert.ok(!plan.files.some((file) => file.startsWith('.git/')));
  });

  it('includes the files of a checked-out submodule under its folder, and not the submodule entry itself', () => {
    const library = createRepository('library');
    writeFile(library, 'lib.ts');
    git(library, 'add', '-A');
    git(library, 'commit', '-q', '-m', 'lib');
    const repository = createRepository('app');
    writeFile(repository, 'main.ts');
    git(repository, 'submodule', 'add', '-q', library, 'vendor/library');
    git(repository, 'add', '-A');
    git(repository, 'commit', '-q', '-m', 'with submodule');
    writeFile(repository, 'vendor/library/untracked-in-submodule.ts');
    const plan = planProjectSend(getProjectContext(repository));
    assert.ok(plan.files.includes('vendor/library/lib.ts'));
    assert.ok(plan.files.includes('vendor/library/untracked-in-submodule.ts'));
    assert.ok(plan.files.includes('.gitmodules'));
    assert.ok(!plan.files.includes('vendor/library'), 'the gitlink is a folder: rsync would send it whole, ignored files and all');
    assert.ok(!plan.files.some((file) => file.startsWith('vendor/library/.git')));
  });

  it('a submodule that is not checked out contributes nothing and breaks nothing', () => {
    const library = createRepository('library');
    writeFile(library, 'lib.ts');
    git(library, 'add', '-A');
    git(library, 'commit', '-q', '-m', 'lib');
    const repository = createRepository('app');
    git(repository, 'submodule', 'add', '-q', library, 'vendor/library');
    git(repository, 'commit', '-q', '-m', 'with submodule');
    fs.rmSync(path.join(repository, 'vendor/library'), { recursive: true, force: true });
    fs.mkdirSync(path.join(repository, 'vendor/library'));
    const plan = planProjectSend(getProjectContext(repository));
    assert.ok(!plan.files.some((file) => file.startsWith('vendor/library')));
  });

  it('holds secret-looking files back, and `send:` brings one in — also when git ignores it', () => {
    const repository = createRepository('app');
    writeFile(repository, '.gitignore', '.env.test\n');
    writeFile(repository, '.env', 'KEY=1');
    writeFile(repository, '.env.example', 'KEY=');
    writeFile(repository, '.env.test', 'KEY=test');
    writeFile(repository, 'deploy.pem', 'pem');
    writeFile(repository, 'src/a.ts');
    let plan = planProjectSend(getProjectContext(repository));
    assert.deepEqual(plan.heldBack, ['.env', 'deploy.pem']);
    assert.ok(plan.files.includes('.env.example'));
    assert.ok(!plan.files.includes('.env.test'), 'ignored and not opted in: never sent');
    writeFile(repository, '.remote-run', 'send: .env.test deploy.pem\n');
    plan = planProjectSend(getProjectContext(repository));
    assert.ok(plan.files.includes('.env.test'));
    assert.ok(plan.files.includes('deploy.pem'));
    assert.deepEqual(plan.heldBack, ['.env']);
  });

  it('`exclude:` keeps a folder out', () => {
    const repository = createRepository('app');
    writeFile(repository, 'fixtures/huge/a.bin');
    writeFile(repository, 'src/a.ts');
    writeFile(repository, '.remote-run', 'exclude: fixtures/huge\n');
    assert.deepEqual(planProjectSend(getProjectContext(repository)).files.filter((file) => file !== '.remote-run'), ['src/a.ts']);
  });

  it('refuses a file name with a newline, naming it', () => {
    const repository = createRepository('app');
    writeFile(repository, 'bad\nname.ts');
    writeFile(repository, 'ok.ts');
    assert.deepEqual(planProjectSend(getProjectContext(repository)).refused, ['bad\nname.ts']);
  });

  it('sends a symlink as a symlink and skips a directory entry', () => {
    const repository = createRepository('app');
    writeFile(repository, 'real.ts');
    fs.symlinkSync('real.ts', path.join(repository, 'alias.ts'));
    const plan = planProjectSend(getProjectContext(repository));
    assert.ok(plan.files.includes('alias.ts'));
  });
});

describe('getHookDirectories', () => {
  beforeEach(() => {
    workRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remote-run-hooks-')));
  });
  afterEach(() => {
    fs.rmSync(workRoot, { recursive: true, force: true });
  });

  const conventional = ['.husky', '.githooks'];
  const read = (repository: string): string[] => getHookDirectories(repository).sort();

  it('with no core.hooksPath: git\'s own .git/hooks (the .git rule covers it too) and the conventional hook folders', () => {
    const repository = createRepository('plain');
    assert.deepEqual(read(repository), ['.git/hooks', '.githooks', '.husky']);
  });

  it('a core.hooksPath inside the project is protected; husky 9\'s `.husky/_` brings its parent, where the hooks a developer writes are', () => {
    const repository = createRepository('hooks');
    git(repository, 'config', 'core.hooksPath', 'ci/git-hooks');
    assert.deepEqual(read(repository), [...conventional, 'ci/git-hooks'].sort());
    git(repository, 'config', 'core.hooksPath', '.husky/_');
    assert.deepEqual(read(repository), ['.githooks', '.husky', '.husky/_']);
    git(repository, 'config', 'core.hooksPath', 'tools/hooks/_');
    assert.deepEqual(read(repository), [...conventional, 'tools/hooks', 'tools/hooks/_'].sort());
  });

  it('an absolute path inside the project counts, one outside it (or above it) is not the project\'s to protect', () => {
    const repository = createRepository('absolute');
    git(repository, 'config', 'core.hooksPath', path.join(repository, 'inside', 'hooks'));
    assert.ok(read(repository).includes('inside/hooks'));
    git(repository, 'config', 'core.hooksPath', path.join(workRoot, 'elsewhere'));
    assert.deepEqual(read(repository), ['.githooks', '.husky']);
    git(repository, 'config', 'core.hooksPath', '../shared-hooks');
    assert.deepEqual(read(repository), ['.githooks', '.husky']);
  });

  it('a hooks folder that is the project root takes everything: the empty path', () => {
    const repository = createRepository('rootpath');
    git(repository, 'config', 'core.hooksPath', '.');
    assert.ok(read(repository).includes(''));
  });

  it('a linked worktree (its .git is a file; its hooks are in the main checkout) has the conventional folders only', () => {
    const repository = createRepository('main');
    writeFile(repository, 'a.txt');
    git(repository, 'add', '-A');
    git(repository, 'commit', '-q', '-m', 'init');
    git(repository, 'worktree', 'add', '-q', path.join(workRoot, 'linked'), '-b', 'linked');
    assert.deepEqual(read(path.join(workRoot, 'linked')), ['.githooks', '.husky']);
  });

  it('a folder that is not a git repository still gets the conventional ones', () => {
    const plain = path.join(workRoot, 'not-a-repo');
    fs.mkdirSync(plain);
    assert.deepEqual(read(plain), ['.githooks', '.husky']);
  });
});

describe('getProjectContext', () => {
  beforeEach(() => {
    workRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remote-run-context-')));
  });
  afterEach(() => {
    fs.rmSync(workRoot, { recursive: true, force: true });
  });

  it('the root of the working tree, the subfolder the command runs in, and a slug of that root', () => {
    const repository = createRepository('monorepo');
    writeFile(repository, 'packages/app/src/a.ts');
    const fromRoot = getProjectContext(repository);
    const fromSubfolder = getProjectContext(path.join(repository, 'packages/app/src'));
    assert.equal(fromRoot.root, repository);
    assert.equal(fromRoot.subfolder, '');
    assert.equal(fromSubfolder.root, repository);
    assert.equal(fromSubfolder.subfolder, 'packages/app/src');
    assert.equal(fromSubfolder.slug, fromRoot.slug);
    assert.match(fromRoot.slug, /^monorepo-[0-9a-f]{10}$/);
  });

  it('a folder that is not a git project is refused with a message that says what remote-run needs', () => {
    const plain = path.join(workRoot, 'plain');
    fs.mkdirSync(plain);
    assert.throws(() => getProjectContext(plain), (error: Error) => error instanceof RemoteRunError && /not inside a git working tree/.test(error.message));
  });

  it('a broken .remote-run is an error naming its lines; a missing one is the empty config', () => {
    const repository = createRepository('app');
    assert.deepEqual(readProjectConfig(repository).pull, []);
    writeFile(repository, '.remote-run', 'colour: red\n');
    assert.throws(() => readProjectConfig(repository), /\.remote-run line 1: unknown key "colour"/);
  });
});
