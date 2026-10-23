/**
 * @description Coverage for the update sources: `npmSource.ts` (what `npm view` says, the exact `npm install -g --prefix`
 * it runs with the npm next to the running node, the offline-preferring rollback), `hostLock.ts` (one installer per host,
 * a dead or hung owner is taken over), and `gitSource.ts` (the `self-update.sh` keys parsed, the held range, the diff of
 * CHANGELOG.md, the rollback that resets, reinstalls when the lock moved and rebuilds unless a hot watcher does).
 * Commands go through a recording runner; the real `npm install` is covered by the flows.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CommandOptions, CommandResult, CommandRunner } from '../selfUpdate/commandRunner';
import { hostLockStaleMs, installTimeoutMs, queryTimeoutMs } from '../selfUpdate/constants';
import { checkChangesEmittedSource, checkIsEmittedSource, createGitSource, parseGitCheck, parseScriptKeys } from '../selfUpdate/gitSource';
import { acquireHostLock, type HostLockDeps } from '../selfUpdate/hostLock';
import { createNpmSource, getHostLockPath, getNpmBinary, parseNpmViewOutput, UpdateSourceError } from '../selfUpdate/npmSource';

interface RecordedCall {
  file: string;
  args: readonly string[];
  options: CommandOptions;
}

function createResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return { ok: true, exitCode: 0, stdout: '', stderr: '', isTimedOut: false, ...overrides };
}

/** A runner that records every call and answers from `answer` (default: success with no output). */
function createRecordingRunner(answer: (call: RecordedCall) => CommandResult = () => createResult()): { runner: CommandRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const runner: CommandRunner = async (file, args, options) => {
    const call = { file, args, options };
    calls.push(call);
    return answer(call);
  };
  return { runner, calls };
}

describe('npm', () => {
  test('the npm binary is the one next to the running node', () => {
    assert.equal(getNpmBinary('/home/u/.nvm/versions/node/v22.23.3/bin/node'), '/home/u/.nvm/versions/node/v22.23.3/bin/npm');
  });

  test('`npm view` output: version, the node range, deprecated or not', () => {
    assert.deepEqual(parseNpmViewOutput('{"version":"3.5.0","engines":{"node":">=22.12"}}'), { version: '3.5.0', engines: '>=22.12', isDeprecated: false });
    assert.deepEqual(parseNpmViewOutput('{"version":"3.5.0","deprecated":"use 3.5.1"}'), { version: '3.5.0', engines: null, isDeprecated: true });
    assert.deepEqual(parseNpmViewOutput('{"version":"3.5.0","engines":{},"deprecated":""}'), { version: '3.5.0', engines: null, isDeprecated: false });
  });

  test('unreadable or nameless output is an error naming what it was', () => {
    assert.throws(() => parseNpmViewOutput('not json'), (error: Error) => error instanceof UpdateSourceError && /unreadable/.test(error.message));
    assert.throws(() => parseNpmViewOutput('{"engines":{}}'), /named no version/);
    assert.throws(() => parseNpmViewOutput('null'), /named no version/);
  });

  test('getLatest asks for the latest dist-tag of charness with a deadline and returns what it says', async () => {
    const { runner, calls } = createRecordingRunner(() => createResult({ stdout: '{"version":"3.5.0","engines":{"node":">=22.12"}}' }));
    const source = createNpmSource({ runCommand: runner, execPath: '/n/bin/node', prefix: '/n' });
    assert.deepEqual(await source.getLatest(), { version: '3.5.0', engines: '>=22.12', isDeprecated: false });
    assert.equal(calls[0].file, '/n/bin/npm');
    assert.deepEqual(calls[0].args.slice(0, 5), ['view', 'charness@latest', 'version', 'engines', 'deprecated']);
    assert.ok(calls[0].args.includes('--json'));
    assert.equal(calls[0].options.timeoutMs, queryTimeoutMs);
  });

  test('a registry that does not answer is an UpdateSourceError — a timeout is worded as one', async () => {
    const down = createNpmSource({ runCommand: createRecordingRunner(() => createResult({ ok: false, exitCode: 1, stderr: 'npm ERR! network ENOTFOUND registry.npmjs.org' })).runner, execPath: '/n/bin/node', prefix: '/n' });
    await assert.rejects(down.getLatest(), (error: Error) => error instanceof UpdateSourceError && /did not answer: .*ENOTFOUND/.test(error.message));
    const slow = createNpmSource({ runCommand: createRecordingRunner(() => createResult({ ok: false, exitCode: null, isTimedOut: true })).runner, execPath: '/n/bin/node', prefix: '/n' });
    await assert.rejects(slow.getLatest(), /did not answer in time/);
  });

  test('install: `npm install -g --prefix <prefix> charness@X` with the long deadline; scripts are NOT skipped (node-pty builds)', async () => {
    const { runner, calls } = createRecordingRunner();
    const source = createNpmSource({ runCommand: runner, execPath: '/n/bin/node', prefix: '/home/u/.npm-global' });
    await source.install('3.5.0');
    assert.equal(calls[0].file, '/n/bin/npm');
    assert.deepEqual(calls[0].args.slice(0, 5), ['install', '-g', '--prefix', '/home/u/.npm-global', 'charness@3.5.0']);
    assert.equal(calls[0].args.includes('--ignore-scripts'), false);
    assert.equal(calls[0].args.includes('--prefer-offline'), false);
    assert.equal(calls[0].options.timeoutMs, installTimeoutMs);
  });

  test('a rollback prefers the npm cache; a failed or timed-out install says why', async () => {
    const { runner, calls } = createRecordingRunner();
    await createNpmSource({ runCommand: runner, execPath: '/n/bin/node', prefix: '/n' }).install('3.4.0', { isRollback: true });
    assert.ok(calls[0].args.includes('--prefer-offline'));

    const failing = createNpmSource({ runCommand: createRecordingRunner(() => createResult({ ok: false, exitCode: 1, stderr: 'gyp ERR! build error' })).runner, execPath: '/n/bin/node', prefix: '/n' });
    await assert.rejects(failing.install('3.5.0'), /npm install 3\.5\.0 failed: gyp ERR! build error/);
    const hung = createNpmSource({ runCommand: createRecordingRunner(() => createResult({ ok: false, exitCode: null, isTimedOut: true })).runner, execPath: '/n/bin/node', prefix: '/n' });
    await assert.rejects(hung.install('3.5.0'), /did not finish in time/);
  });

  test('the host-wide lock sits in the prefix\'s global node_modules', () => {
    assert.equal(getHostLockPath('/home/u/.npm-global'), '/home/u/.npm-global/lib/node_modules/.charness-update.lock');
  });
});

describe('the host-wide lock', () => {
  let directory: string;
  let lockPath: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-hostlock-'));
    lockPath = path.join(directory, '.charness-update.lock');
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function createDeps(overrides: Partial<HostLockDeps> = {}): HostLockDeps {
    return { now: () => 1_000_000, pid: 111, checkIsProcessAlive: () => true, ...overrides };
  }

  test('one holder at a time; the lock is free again once released', () => {
    const first = acquireHostLock(lockPath, createDeps({ pid: 111 }));
    assert.ok(first);
    assert.equal(acquireHostLock(lockPath, createDeps({ pid: 222 })), null);
    first.release();
    assert.equal(fs.existsSync(lockPath), false);
    assert.ok(acquireHostLock(lockPath, createDeps({ pid: 222 })));
  });

  test('a lock whose owner is gone is taken over', () => {
    assert.ok(acquireHostLock(lockPath, createDeps({ pid: 111 })));
    const taken = acquireHostLock(lockPath, createDeps({ pid: 222, checkIsProcessAlive: (pid) => pid !== 111 }));
    assert.ok(taken);
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid, 222);
  });

  test('a lock older than the stale limit is taken over even though its pid still answers (an install that hung)', () => {
    assert.ok(acquireHostLock(lockPath, createDeps({ pid: 111, now: () => 1_000_000 })));
    assert.equal(acquireHostLock(lockPath, createDeps({ pid: 222, now: () => 1_000_000 + hostLockStaleMs })), null, 'exactly at the limit it is still held');
    assert.ok(acquireHostLock(lockPath, createDeps({ pid: 222, now: () => 1_000_000 + hostLockStaleMs + 1 })));
  });

  test('an unreadable lock file is stale', () => {
    fs.writeFileSync(lockPath, 'garbage');
    assert.ok(acquireHostLock(lockPath, createDeps()));
  });

  test('a release never removes a lock somebody else took over meanwhile', () => {
    const first = acquireHostLock(lockPath, createDeps({ pid: 111 }));
    assert.ok(first);
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 222, startedAt: 1_000_000 }));
    first.release();
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid, 222);
  });

  test('a lock in a folder that does not exist is an error, not a silent "not locked"', () => {
    assert.throws(() => acquireHostLock(path.join(directory, 'missing', 'lock'), createDeps()), /ENOENT/);
  });
});

describe('git', () => {
  test('the script keys are read from its stdout, log lines ignored', () => {
    assert.deepEqual(parseScriptKeys('[self-update] updated a..b (2 commits)\nstatus=updated\nfrom=a1b2c3d\nto=d4e5f6a\nbehind=2\nmigrationGuides=\n'), {
      status: 'updated',
      from: 'a1b2c3d',
      to: 'd4e5f6a',
      behind: '2',
      migrationGuides: '',
    });
  });

  test('a check: behind with guides, up to date, a skip with its reason', () => {
    assert.deepEqual(parseGitCheck('status=behind\nfrom=a1b2c3d\nto=d4e5f6a\nbehind=12\nmigrationGuides=MIGRATION_3_TO_4.md MIGRATION_X.md\n'), {
      status: 'behind',
      reason: null,
      from: 'a1b2c3d',
      to: 'd4e5f6a',
      behind: 12,
      migrationGuides: ['MIGRATION_3_TO_4.md', 'MIGRATION_X.md'],
    });
    assert.equal(parseGitCheck('status=upToDate\nfrom=a1b2c3d\nto=a1b2c3d\nbehind=0\nmigrationGuides=\n').status, 'upToDate');
    assert.deepEqual(parseGitCheck('status=skip\nreason=dirty\n'), { status: 'skip', reason: 'dirty', from: '', to: '', behind: 0, migrationGuides: [] });
    assert.equal(parseGitCheck('status=skip\nreason=somethingNew\n').reason, null, 'an unknown reason is no reason, not a crash');
  });

  test('a check without a status is an error', () => {
    assert.throws(() => parseGitCheck('nothing useful'), /printed no status/);
  });

  test('check runs `bash scripts/self-update.sh --check` in the checkout', async () => {
    const { runner, calls } = createRecordingRunner(() => createResult({ stdout: 'status=upToDate\nfrom=a\nto=a\nbehind=0\nmigrationGuides=\n' }));
    const source = createGitSource({ runCommand: runner, root: '/srv/charness' });
    assert.equal((await source.check()).status, 'upToDate');
    assert.deepEqual([calls[0].file, calls[0].args, calls[0].options.cwd, calls[0].options.timeoutMs], ['bash', ['/srv/charness/scripts/self-update.sh', '--check'], '/srv/charness', queryTimeoutMs]);
  });

  test('apply passes --hold-breaking unless the tap allowed the breaking range, and reads updated / held / upToDate / skip', async () => {
    const answers: CommandResult[] = [
      createResult({ stdout: 'status=updated\nfrom=a1b2c3d\nto=d4e5f6a\nbehind=3\nmigrationGuides=\n' }),
      createResult({ ok: false, exitCode: 3, stdout: 'status=held\nfrom=a1b2c3d\nto=d4e5f6a\nbehind=3\nmigrationGuides=MIGRATION_3_TO_4.md\n' }),
      createResult({ stdout: 'status=upToDate\n' }),
      createResult({ stdout: 'status=skip\nreason=diverged\n' }),
    ];
    const { runner, calls } = createRecordingRunner(() => answers.shift() ?? createResult());
    const source = createGitSource({ runCommand: runner, root: '/srv/charness' });
    assert.deepEqual(await source.apply({ holdBreaking: true }), { status: 'updated', from: 'a1b2c3d', to: 'd4e5f6a', migrationGuides: [] });
    assert.deepEqual(calls[0].args, ['/srv/charness/scripts/self-update.sh', '--hold-breaking']);
    assert.deepEqual(await source.apply({ holdBreaking: true }), { status: 'held', from: 'a1b2c3d', to: 'd4e5f6a', migrationGuides: ['MIGRATION_3_TO_4.md'] });
    assert.deepEqual(await source.apply({ holdBreaking: false }), { status: 'upToDate' });
    assert.deepEqual(calls[2].args, ['/srv/charness/scripts/self-update.sh']);
    assert.equal(calls[2].options.timeoutMs, installTimeoutMs);
    assert.deepEqual(await source.apply({ holdBreaking: false }), { status: 'skip', reason: 'diverged' });
  });

  test('a script that fails or never finishes is an UpdateSourceError with its words', async () => {
    const failing = createGitSource({ runCommand: createRecordingRunner(() => createResult({ ok: false, exitCode: 1, stdout: '[self-update] fetching origin failed\n' })).runner, root: '/srv/c' });
    await assert.rejects(failing.apply({ holdBreaking: false }), /self-update\.sh failed: .*fetching origin failed/);
    const hung = createGitSource({ runCommand: createRecordingRunner(() => createResult({ ok: false, exitCode: null, isTimedOut: true })).runner, root: '/srv/c' });
    await assert.rejects(hung.apply({ holdBreaking: false }), /did not finish in time/);
    await assert.rejects(hung.check(), /did not answer in time/);
  });

  test('the CHANGELOG diff asks for the whole file as context', async () => {
    const { runner, calls } = createRecordingRunner(() => createResult({ stdout: 'the diff' }));
    const diff = await createGitSource({ runCommand: runner, root: '/srv/c' }).getChangelogDiff('a1b2c3d', 'd4e5f6a');
    assert.equal(diff, 'the diff');
    assert.deepEqual(calls[0].args, ['diff', '--unified=100000', 'a1b2c3d..d4e5f6a', '--', 'CHANGELOG.md']);
  });

  test('rollback: reset --keep the old commit, reinstall when the lock moved, rebuild unless a hot watcher does', async () => {
    const { runner, calls } = createRecordingRunner((call) => (call.args[0] === 'diff' ? createResult({ stdout: 'src/a.ts\nyarn.lock\n' }) : createResult()));
    const source = createGitSource({ runCommand: runner, root: '/srv/c' });
    await source.rollback({ from: 'a1b2c3d', to: 'd4e5f6a', isHot: false });
    assert.deepEqual(
      calls.map((call) => [call.file, ...call.args].join(' ')),
      ['git diff --name-only a1b2c3d d4e5f6a', 'git reset --keep a1b2c3d', 'yarn install --immutable', 'yarn build'],
    );
  });

  test('rollback with no manifest change skips the install; in hot mode it does not build either', async () => {
    const { runner, calls } = createRecordingRunner((call) => (call.args[0] === 'diff' ? createResult({ stdout: 'src/a.ts\n' }) : createResult()));
    await createGitSource({ runCommand: runner, root: '/srv/c' }).rollback({ from: 'a', to: 'b', isHot: true });
    assert.deepEqual(
      calls.map((call) => [call.file, ...call.args].join(' ')),
      ['git diff --name-only a b', 'git reset --keep a'],
    );
  });

  test('which changes make `tsc -w` write under dist/ (and so make nodemon replace the worker): compiled sources only', () => {
    for (const compiled of ['src/bot.ts', 'src/selfUpdate/updateEngine.ts', 'src/types.ts', 'src/connectors/telegram/commands/selfUpdate.ts']) {
      assert.equal(checkIsEmittedSource(compiled), true, compiled);
    }
    for (const notCompiled of ['README.md', 'CHANGELOG.md', 'SETUP.md', 'package.json', 'yarn.lock', 'tsconfig.json', 'scripts/self-update.sh', 'docker/entrypoint.sh', 'stt/gigaam_sidecar.py', 'src/__tests__/bot.test.ts', 'src/release/cli.ts', 'src/types.d.ts', 'src/README.md', 'src/i18n/locale.json']) {
      assert.equal(checkIsEmittedSource(notCompiled), false, notCompiled);
    }
    assert.equal(checkChangesEmittedSource(['README.md', 'src/bot.ts']), true, 'one compiled source among docs is enough');
    assert.equal(checkChangesEmittedSource(['README.md', 'yarn.lock']), false);
    assert.equal(checkChangesEmittedSource([]), false);
  });

  test('getChangedFiles lists the paths between two commits', async () => {
    const { runner, calls } = createRecordingRunner(() => createResult({ stdout: 'README.md\nsrc/bot.ts\n' }));
    assert.deepEqual(await createGitSource({ runCommand: runner, root: '/srv/c' }).getChangedFiles('a1b2c3d', 'd4e5f6a'), ['README.md', 'src/bot.ts']);
    assert.deepEqual(calls[0].args, ['diff', '--name-only', 'a1b2c3d', 'd4e5f6a']);
  });

  describe('the hot worker reload', () => {
    let root = '';
    let entryPath = '';
    const staleTime = new Date('2026-01-01T00:00:00Z');

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-hot-reload-'));
      entryPath = path.join(root, 'dist', 'cli', 'botEntry.js');
      fs.mkdirSync(path.dirname(entryPath), { recursive: true });
      fs.writeFileSync(entryPath, '// the worker entry\n');
      fs.utimesSync(entryPath, staleTime, staleTime);
    });

    afterEach(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });

    const getEntryMtime = (): number => fs.statSync(entryPath).mtimeMs;

    test('reloadHotWorker touches the worker entry under dist/ — its content stays, only its mtime moves (what nodemon reacts to)', async () => {
      const source = createGitSource({ runCommand: createRecordingRunner().runner, root });
      await source.reloadHotWorker();
      assert.ok(getEntryMtime() > staleTime.getTime());
      assert.equal(fs.readFileSync(entryPath, 'utf8'), '// the worker entry\n');
    });

    test('with no dist/ to touch it says so, naming the path', async () => {
      fs.rmSync(path.join(root, 'dist'), { recursive: true });
      await assert.rejects(createGitSource({ runCommand: createRecordingRunner().runner, root }).reloadHotWorker(), /cannot ask the hot worker to reload \(.*botEntry\.js\)/);
    });

    test('a hot rollback of a range that changed no compiled source asks for the reload — otherwise the watcher has nothing to rebuild and the worker would not come back', async () => {
      const { runner } = createRecordingRunner((call) => (call.args[0] === 'diff' ? createResult({ stdout: 'README.md\nCHANGELOG.md\n' }) : createResult()));
      await createGitSource({ runCommand: runner, root }).rollback({ from: 'a', to: 'b', isHot: true });
      assert.ok(getEntryMtime() > staleTime.getTime());
    });

    test('a hot rollback of a range with a compiled source leaves the rebuild to the watcher: nothing is touched', async () => {
      const { runner } = createRecordingRunner((call) => (call.args[0] === 'diff' ? createResult({ stdout: 'README.md\nsrc/bot.ts\n' }) : createResult()));
      await createGitSource({ runCommand: runner, root }).rollback({ from: 'a', to: 'b', isHot: true });
      assert.equal(getEntryMtime(), staleTime.getTime());
    });

    test('a plain rollback never touches it', async () => {
      const { runner } = createRecordingRunner((call) => (call.args[0] === 'diff' ? createResult({ stdout: 'README.md\n' }) : createResult()));
      await createGitSource({ runCommand: runner, root }).rollback({ from: 'a', to: 'b', isHot: false });
      assert.equal(getEntryMtime(), staleTime.getTime());
    });
  });

  test('a rollback step that fails says which', async () => {
    const failingBuild = createRecordingRunner((call) => (call.file === 'yarn' ? createResult({ ok: false, exitCode: 1, stderr: 'tsc: error TS2307' }) : createResult()));
    await assert.rejects(createGitSource({ runCommand: failingBuild.runner, root: '/srv/c' }).rollback({ from: 'a', to: 'b', isHot: false }), /yarn build failed on the way back: .*TS2307/);
    const refusedReset = createRecordingRunner((call) => (call.args[0] === 'reset' ? createResult({ ok: false, exitCode: 1, stderr: 'error: Entry src/a.ts not uptodate. Cannot merge.' }) : createResult()));
    await assert.rejects(createGitSource({ runCommand: refusedReset.runner, root: '/srv/c' }).rollback({ from: 'a', to: 'b', isHot: false }), /git reset failed/);
  });
});
