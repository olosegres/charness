/**
 * @description Coverage for `src/selfUpdate/updateRuntime.ts` — the process-bound half of the update engine: what this install
 * is (npm global / checkout / read-only checkout / npx), the version it is running (read ONCE, so an in-place install cannot
 * change it under the process), the commit of a checkout, the installed version and CHANGELOG read afresh from disk, and how a new
 * install is probed (`charness self-check --expect`) and how commits are counted.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CommandOptions, CommandResult, CommandRunner } from '../selfUpdate/commandRunner';
import { getHostLockPath } from '../selfUpdate/npmSource';
import { createUpdateRuntime, type UpdateRuntimeOptions } from '../selfUpdate/updateRuntime';

let sandbox: string;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-runtime-'));
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function write(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

interface Call {
  file: string;
  args: readonly string[];
  options: CommandOptions;
}

function createRunner(answers: Record<string, Partial<CommandResult>> = {}): { runCommand: CommandRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runCommand: CommandRunner = async (file, args, options) => {
    calls.push({ file, args, options });
    const answer = answers[`${file} ${args[0]}`] ?? {};
    return { ok: true, exitCode: 0, stdout: '', stderr: '', isTimedOut: false, ...answer };
  };
  return { runCommand, calls };
}

function createOptions(packageRoot: string, overrides: Partial<UpdateRuntimeOptions> = {}): UpdateRuntimeOptions {
  return {
    dataDir: path.join(sandbox, 'data'),
    packageRoot,
    execPath: '/n/bin/node',
    platform: 'linux',
    nodeVersion: '22.23.3',
    argv: ['/n/bin/node', '/x/charness', 'hot'],
    isHotMode: false,
    ...overrides,
  };
}

function createNpmGlobalInstall(version: string): { prefix: string; packageRoot: string } {
  const prefix = path.join(sandbox, 'prefix');
  const packageRoot = path.join(prefix, 'lib', 'node_modules', 'charness');
  fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  write(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'charness', version }));
  write(path.join(packageRoot, 'CHANGELOG.md'), '# Changelog\n\n## 3.4.0 — x\n\n**Old.** x\n');
  write(path.join(packageRoot, 'dist', 'cli.js'), '');
  return { prefix, packageRoot };
}

describe('an npm global install', () => {
  test('is recognised, its prefix named, its sources built; the running version is read once while the installed one is read afresh', async () => {
    const { prefix, packageRoot } = createNpmGlobalInstall('3.4.0');
    const runtime = await createUpdateRuntime(createOptions(packageRoot, { runCommand: createRunner().runCommand }));
    assert.deepEqual(runtime.installKind, { kind: 'npmGlobal', prefix });
    assert.deepEqual(runtime.running, { version: '3.4.0', commit: null });
    assert.ok(runtime.npm);
    assert.equal(runtime.git, null);
    assert.equal(runtime.readInstalledVersion(), '3.4.0');

    // `npm i -g` replaces the files under the running process.
    write(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'charness', version: '3.5.0' }));
    write(path.join(packageRoot, 'CHANGELOG.md'), '# Changelog\n\n## 3.5.0 — y\n\n**New.** y\n');
    assert.equal(runtime.running.version, '3.4.0', 'what this process runs does not change with the files');
    assert.equal(runtime.readInstalledVersion(), '3.5.0');
    assert.match(runtime.readInstalledChangelog() ?? '', /## 3\.5\.0/);
  });

  test('a missing or unreadable package.json / CHANGELOG is null, not a throw', async () => {
    const { packageRoot } = createNpmGlobalInstall('3.4.0');
    const runtime = await createUpdateRuntime(createOptions(packageRoot, { runCommand: createRunner().runCommand }));
    fs.rmSync(path.join(packageRoot, 'CHANGELOG.md'));
    write(path.join(packageRoot, 'package.json'), 'not json');
    assert.equal(runtime.readInstalledChangelog(), null);
    assert.equal(runtime.readInstalledVersion(), null);
  });

  test('the host lock is the prefix\'s and is exclusive', async () => {
    const { prefix, packageRoot } = createNpmGlobalInstall('3.4.0');
    const runtime = await createUpdateRuntime(createOptions(packageRoot, { runCommand: createRunner().runCommand }));
    const first = runtime.hostLock?.acquire();
    assert.ok(first);
    assert.ok(fs.existsSync(getHostLockPath(prefix)));
    assert.equal(runtime.hostLock?.acquire(), null);
    first.release();
    assert.ok(runtime.hostLock?.acquire());
  });

  test('the self-check is `node <root>/dist/cli.js self-check --expect <version>` with a deadline; a failure carries the output tail', async () => {
    const { packageRoot } = createNpmGlobalInstall('3.4.0');
    const { runCommand, calls } = createRunner({ [`/n/bin/node ${path.join(packageRoot, 'dist', 'cli.js')}`]: { ok: false, exitCode: 1, stderr: 'self-check: node-pty does not load\n' } });
    const runtime = await createUpdateRuntime(createOptions(packageRoot, { runCommand }));
    assert.deepEqual(await runtime.runSelfCheck('3.5.0'), { ok: false, detail: 'self-check: node-pty does not load' });
    assert.deepEqual(calls[0].args, [path.join(packageRoot, 'dist', 'cli.js'), 'self-check', '--expect', '3.5.0']);
    assert.ok(calls[0].options.timeoutMs > 0);
    await runtime.runSelfCheck(null);
    assert.deepEqual(calls[1].args, [path.join(packageRoot, 'dist', 'cli.js'), 'self-check']);
  });

  test('a timed-out self-check says so; a passing one has no detail', async () => {
    const { packageRoot } = createNpmGlobalInstall('3.4.0');
    const slow = await createUpdateRuntime(createOptions(packageRoot, { runCommand: createRunner({ [`/n/bin/node ${path.join(packageRoot, 'dist', 'cli.js')}`]: { ok: false, exitCode: null, isTimedOut: true } }).runCommand }));
    assert.deepEqual(await slow.runSelfCheck('3.5.0'), { ok: false, detail: 'the self-check did not finish in time' });
    const fine = await createUpdateRuntime(createOptions(packageRoot, { runCommand: createRunner().runCommand }));
    assert.deepEqual(await fine.runSelfCheck('3.5.0'), { ok: true, detail: '' });
  });

  test('commits are counted with git rev-list in the install; a bad answer is "unknown"', async () => {
    const { packageRoot } = createNpmGlobalInstall('3.4.0');
    const counted = createRunner({ 'git rev-list': { stdout: '12\n' } });
    const runtime = await createUpdateRuntime(createOptions(packageRoot, { runCommand: counted.runCommand }));
    assert.equal(await runtime.countCommits('a1b2c3d', 'd4e5f6a'), 12);
    assert.deepEqual(counted.calls[0].args, ['rev-list', '--count', 'a1b2c3d..d4e5f6a']);
    const garbled = await createUpdateRuntime(createOptions(packageRoot, { runCommand: createRunner({ 'git rev-list': { stdout: 'fatal' } }).runCommand }));
    assert.equal(await garbled.countCommits('a', 'b'), null);
    const failed = await createUpdateRuntime(createOptions(packageRoot, { runCommand: createRunner({ 'git rev-list': { ok: false, stdout: '' } }).runCommand }));
    assert.equal(await failed.countCommits('a', 'b'), null);
  });

  test('the marker and the re-exec target are the data dir\'s and the install\'s', async () => {
    const { packageRoot } = createNpmGlobalInstall('3.4.0');
    const runtime = await createUpdateRuntime(createOptions(packageRoot, { runCommand: createRunner().runCommand }));
    assert.equal(runtime.marker.read(), null);
    runtime.marker.write({ kind: 'npm', status: 'pending', from: { version: '3.4.0', commit: null }, to: { version: '3.5.0', commit: null }, attempts: 0, isUserRequested: false });
    assert.equal(runtime.marker.read()?.to.version, '3.5.0');
    runtime.marker.clear();
    assert.equal(runtime.marker.read(), null);
    assert.deepEqual(runtime.reexecTarget, { file: '/n/bin/node', args: ['/n/bin/node', path.join(packageRoot, 'dist', 'cli.js'), 'hot'] });
  });
});

describe('a git checkout', () => {
  function createCheckout(): string {
    const root = path.join(sandbox, 'charness');
    write(path.join(root, 'package.json'), JSON.stringify({ name: 'charness', version: '3.4.0' }));
    write(path.join(root, 'scripts', 'self-update.sh'), '#!/bin/sh\n');
    fs.mkdirSync(path.join(root, '.git'));
    return root;
  }

  test('a writable checkout: its sources, the commit it runs (short sha), no npm source, no host lock; hot mode is passed through', async () => {
    const root = createCheckout();
    const { runCommand, calls } = createRunner({ 'git rev-parse': { stdout: 'a1b2c3d\n' } });
    const runtime = await createUpdateRuntime(createOptions(root, { runCommand, isHotMode: true }));
    assert.deepEqual(runtime.installKind, { kind: 'checkout', root });
    assert.deepEqual(runtime.running, { version: '3.4.0', commit: 'a1b2c3d' });
    assert.deepEqual([calls[0].file, calls[0].args, calls[0].options.cwd], ['git', ['rev-parse', '--short=7', 'HEAD'], root]);
    assert.equal(runtime.npm, null);
    assert.ok(runtime.git);
    assert.equal(runtime.hostLock, null);
    assert.equal(runtime.isHotMode, true);
  });

  test('a read-only checkout is not watched: no source at all, but the commit it runs is known', async () => {
    const root = createCheckout();
    const readOnly = { checkExists: (target: string) => fs.existsSync(target), checkIsWritable: () => false };
    const runtime = await createUpdateRuntime(createOptions(root, { runCommand: createRunner({ 'git rev-parse': { stdout: 'a1b2c3d\n' } }).runCommand, filesystem: readOnly }));
    assert.equal(runtime.installKind.kind, 'notifyOnly');
    assert.equal(runtime.running.commit, 'a1b2c3d');
    assert.equal(runtime.npm, null);
    assert.equal(runtime.git, null);
  });

  test('a checkout whose commit cannot be read runs with commit null — and with a real repository it is the head', async () => {
    const root = createCheckout();
    const unreadable = await createUpdateRuntime(createOptions(root, { runCommand: createRunner({ 'git rev-parse': { ok: false } }).runCommand }));
    assert.equal(unreadable.running.commit, null);

    fs.rmSync(path.join(root, '.git'), { recursive: true });
    const git = (...args: string[]) => spawnSync('git', args, { cwd: root, env: { PATH: process.env.PATH, HOME: sandbox, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_SYSTEM: os.devNull, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' }, encoding: 'utf8' });
    git('init', '-q');
    git('add', '-A');
    git('commit', '-q', '-m', 'one');
    const head = git('rev-parse', '--short=7', 'HEAD').stdout.trim();
    const real = await createUpdateRuntime(createOptions(root));
    assert.equal(real.running.commit, head);
  });
});

describe('npx', () => {
  test('is ephemeral: no source is built', async () => {
    const packageRoot = path.join(sandbox, '.npm', '_npx', 'abc', 'node_modules', 'charness');
    write(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'charness', version: '3.4.0' }));
    const runtime = await createUpdateRuntime(createOptions(packageRoot, { runCommand: createRunner().runCommand }));
    assert.deepEqual(runtime.installKind, { kind: 'ephemeral' });
    assert.equal(runtime.npm, null);
    assert.equal(runtime.git, null);
  });
});
