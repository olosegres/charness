/**
 * @description Coverage for the boot-time rollback of a new version that cannot start (`src/selfUpdate/bootRollback.ts`, wired in
 * `src/cli/bot.ts` BEFORE the bot module is imported): the right way back for the install kind found at boot, and — through the
 * built CLI on a temp git checkout — that a plain process which has failed to boot the new commit twice resets to the previous one,
 * rebuilds, records the outcome for the restored version and starts again as itself.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createBootRollback } from '../selfUpdate/bootRollback';
import type { CommandResult, CommandRunner } from '../selfUpdate/commandRunner';
import { createPendingMarker, readUpdatePending, writeUpdatePending, type UpdatePendingMarker } from '../selfUpdate/updatePending';

const repoRoot = path.resolve(__dirname, '..', '..');

function createRecorder(): { runCommand: CommandRunner; lines: string[] } {
  const lines: string[] = [];
  const runCommand: CommandRunner = async (file, args) => {
    lines.push([file, ...args].join(' '));
    const result: CommandResult = { ok: true, exitCode: 0, stdout: args[0] === 'diff' ? 'src/a.ts\nyarn.lock\n' : '', stderr: '', isTimedOut: false };
    return result;
  };
  return { runCommand, lines };
}

function createMarker(kind: 'npm' | 'git', overrides: Partial<UpdatePendingMarker> = {}): UpdatePendingMarker {
  return {
    ...createPendingMarker({ kind, from: { version: '3.4.0', commit: kind === 'git' ? 'a1b2c3d' : null }, to: { version: '3.5.0', commit: kind === 'git' ? 'd4e5f6a' : null }, isUserRequested: false }),
    attempts: 2,
    ...overrides,
  };
}

const npmGlobalRoot = '/home/u/.npm-global/lib/node_modules/charness';
const writablePrefixFs = {
  checkExists: () => false,
  checkIsWritable: (directory: string) => directory === '/home/u/.npm-global/lib/node_modules' || directory === '/home/u/.npm-global/bin',
};
const checkoutFs = { checkExists: () => true, checkIsWritable: () => true };

describe('the way back, by install kind', () => {
  test('npm: the previous version is reinstalled into the same prefix, preferring the npm cache', async () => {
    const { runCommand, lines } = createRecorder();
    const rollback = createBootRollback({ packageRoot: npmGlobalRoot, execPath: '/n/bin/node', platform: 'linux', hasExecve: true, isHotWorker: false, runCommand, filesystem: writablePrefixFs });
    await rollback(createMarker('npm'));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\/n\/bin\/npm install -g --prefix \/home\/u\/\.npm-global charness@3\.4\.0 .*--prefer-offline/);
  });

  test('git: reset --keep the previous commit, reinstall when the lock moved, rebuild', async () => {
    const { runCommand, lines } = createRecorder();
    const rollback = createBootRollback({ packageRoot: '/srv/charness', execPath: '/n/bin/node', platform: 'linux', hasExecve: true, isHotWorker: false, runCommand, filesystem: checkoutFs });
    await rollback(createMarker('git'));
    assert.deepEqual(lines, ['git diff --name-only a1b2c3d d4e5f6a', 'git reset --keep a1b2c3d', 'yarn install --immutable', 'yarn build']);
  });

  test('git in a hot worker: no build of its own — the watcher rebuilds the reset checkout', async () => {
    const { runCommand, lines } = createRecorder();
    const rollback = createBootRollback({ packageRoot: '/srv/charness', execPath: '/n/bin/node', platform: 'linux', hasExecve: true, isHotWorker: true, runCommand, filesystem: checkoutFs });
    await rollback(createMarker('git'));
    assert.equal(lines.includes('yarn build'), false);
    assert.ok(lines.includes('git reset --keep a1b2c3d'));
  });

  test('an install that is no longer what the marker says, or a marker without commits, cannot be rolled back — and says so', async () => {
    const { runCommand } = createRecorder();
    const asCheckout = createBootRollback({ packageRoot: '/srv/charness', execPath: '/n/bin/node', platform: 'linux', hasExecve: true, isHotWorker: false, runCommand, filesystem: checkoutFs });
    await assert.rejects(asCheckout(createMarker('npm')), /not an npm global one any more \(checkout\)/);
    const asNpm = createBootRollback({ packageRoot: npmGlobalRoot, execPath: '/n/bin/node', platform: 'linux', hasExecve: true, isHotWorker: false, runCommand, filesystem: writablePrefixFs });
    await assert.rejects(asNpm(createMarker('git')), /not a git checkout any more \(npmGlobal\)/);
    await assert.rejects(asCheckout(createMarker('git', { from: { version: '3.4.0', commit: null } })), /names no commit/);
  });
});

describe('the built CLI on a checkout whose new commit cannot start', () => {
  let sandbox: string;
  let checkout: string;
  let dataDir: string;

  function git(...args: string[]): string {
    const result = spawnSync('git', args, {
      cwd: checkout,
      env: { PATH: process.env.PATH, HOME: path.join(sandbox, 'home'), GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_SYSTEM: os.devNull, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  }

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-bootrollback-'));
    checkout = path.join(sandbox, 'charness');
    dataDir = path.join(sandbox, 'data');
    fs.mkdirSync(path.join(sandbox, 'home'));
    fs.mkdirSync(path.join(sandbox, 'bin'));
    fs.mkdirSync(checkout);
    fs.cpSync(path.join(repoRoot, 'dist'), path.join(checkout, 'dist'), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(checkout, 'package.json'));
    fs.mkdirSync(path.join(checkout, 'scripts'));
    fs.writeFileSync(path.join(checkout, 'scripts', 'self-update.sh'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(checkout, 'yarn.lock'), '# 1\n');
    fs.writeFileSync(path.join(sandbox, 'bin', 'yarn'), `#!/bin/sh\necho "yarn $*" >> "${path.join(sandbox, 'yarn.log')}"\n`, { mode: 0o755 });
    git('init', '-q', '-b', 'main');
    // dist/ is the checkout's build output: ignored, not part of the commits.
    fs.writeFileSync(path.join(checkout, '.gitignore'), 'dist/\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'the version that worked');
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  function runCli(): { status: number | null; output: string } {
    const result = spawnSync(process.execPath, [path.join(checkout, 'dist', 'cli.js')], {
      cwd: sandbox,
      env: { PATH: `${path.join(sandbox, 'bin')}:${process.env.PATH}`, HOME: path.join(sandbox, 'home'), DATA_DIR: dataDir, WORK_ROOT: sandbox, NODE_PATH: path.join(repoRoot, 'node_modules') },
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { status: result.status, output: result.stdout + result.stderr };
  }

  test('twice unconfirmed: the third boot resets to the previous commit, rebuilds, leaves a rolledBack marker and starts again as itself', () => {
    const working = git('rev-parse', '--short=7', 'HEAD');
    fs.writeFileSync(path.join(checkout, 'yarn.lock'), '# 2\n');
    git('commit', '-q', '-am', 'the version that does not start');
    const broken = git('rev-parse', '--short=7', 'HEAD');
    fs.mkdirSync(dataDir, { recursive: true });
    writeUpdatePending(dataDir, createMarker('git', { from: { version: '3.4.0', commit: working }, to: { version: '3.5.0', commit: broken }, attempts: 2 }));

    const result = runCli();
    assert.match(result.output, /\[update\] 3\.5\.0 did not start 2 times — going back to 3\.4\.0/);
    assert.equal(git('rev-parse', '--short=7', 'HEAD'), working, 'the checkout is back on the commit that worked');
    assert.deepEqual(fs.readFileSync(path.join(sandbox, 'yarn.log'), 'utf8').trim().split('\n'), ['yarn install --immutable', 'yarn build']);
    const marker = readUpdatePending(dataDir);
    assert.equal(marker?.status, 'rolledBack');
    assert.match(marker?.failureReason ?? '', /did not start/);
    // The process started again as itself (the same pid, through execve): the boot banner appears twice, and the second run is the plain one.
    assert.equal(result.output.match(/Warning: no \.env file found/g)?.length, 2, result.output);
    assert.equal(result.output.match(/did not start 2 times/g)?.length, 1, 'the second image does not roll back again');
  });

  test('below the limit the boot only counts itself in and carries on', () => {
    fs.mkdirSync(dataDir, { recursive: true });
    writeUpdatePending(dataDir, createMarker('git', { attempts: 0, from: { version: '3.4.0', commit: git('rev-parse', '--short=7', 'HEAD') } }));
    const result = runCli();
    assert.doesNotMatch(result.output, /did not start/);
    assert.equal(readUpdatePending(dataDir)?.attempts, 1);
    assert.equal(fs.existsSync(path.join(sandbox, 'yarn.log')), false, 'nothing is rebuilt');
  });
});
