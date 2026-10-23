/**
 * @description Coverage for the in-place restart (`src/selfUpdate/restart.ts`, `launchEnvironment.ts`): the new image's command
 * line, the problems found BEFORE anything is shut down, a failed or unavailable `process.execve` ending in exit 75 instead of
 * a silent death, and — through a real child that calls the real `process.execve` — that the SAME pid carries on with the
 * launch environment (not the live one), the cwd and the arguments, and the first image's exit handlers never run.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getLaunchEnvironment } from '../selfUpdate/launchEnvironment';
import { getReexecProblems, getReexecTarget, reexecProcess, restartFailedExitCode, type ReexecDeps } from '../selfUpdate/restart';

const repoRoot = path.resolve(__dirname, '..', '..');
const probePath = path.join(__dirname, 'fixtures', 'reexecProbe.ts');
const tsxLoaderUrl = pathToFileURL(path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;

describe('the new image', () => {
  test('is `node <packageRoot>/dist/cli.js` with the original arguments, argv[0] being node itself', () => {
    assert.deepEqual(getReexecTarget({ execPath: '/n/bin/node', packageRoot: '/opt/charness', argv: ['/n/bin/node', '/x/charness', 'hot', '--flag'] }), {
      file: '/n/bin/node',
      args: ['/n/bin/node', '/opt/charness/dist/cli.js', 'hot', '--flag'],
    });
    assert.deepEqual(getReexecTarget({ execPath: '/n/bin/node', packageRoot: '/opt/charness', argv: ['/n/bin/node', '/x/charness'] }).args, ['/n/bin/node', '/opt/charness/dist/cli.js']);
  });

  test('problems are found before anything is shut down: a missing node, a missing cli.js', () => {
    const target = getReexecTarget({ execPath: '/n/bin/node', packageRoot: '/opt/charness', argv: ['node', 'cli'] });
    assert.deepEqual(getReexecProblems(target, () => true), []);
    assert.deepEqual(getReexecProblems(target, (candidate) => candidate === '/n/bin/node'), ['/opt/charness/dist/cli.js is gone']);
    assert.deepEqual(getReexecProblems(target, () => false), ['the node executable /n/bin/node is gone', '/opt/charness/dist/cli.js is gone']);
  });
});

describe('reexecProcess with a fake execve', () => {
  const target = { file: '/n/bin/node', args: ['/n/bin/node', '/opt/charness/dist/cli.js'] };

  function createDeps(overrides: Partial<ReexecDeps> = {}): { deps: ReexecDeps; exits: number[]; logs: string[]; calls: unknown[][] } {
    const exits: number[] = [];
    const logs: string[] = [];
    const calls: unknown[][] = [];
    const deps: ReexecDeps = {
      execve: (file, args, env) => {
        calls.push([file, args, env]);
        throw new Error('stands in for the process being gone');
      },
      exit: (code) => exits.push(code),
      log: (line) => logs.push(line),
      ...overrides,
    };
    return { deps, exits, logs, calls };
  }

  test('hands execve the target and the environment it was given', () => {
    const { deps, calls } = createDeps();
    reexecProcess(target, { A: '1' }, deps);
    assert.deepEqual(calls, [[target.file, target.args, { A: '1' }]]);
  });

  test('an execve that throws is logged and ends with exit 75, not silence', () => {
    const { deps, exits, logs } = createDeps();
    reexecProcess(target, {}, deps);
    assert.deepEqual(exits, [restartFailedExitCode]);
    assert.match(logs[0], /execve failed: stands in for the process being gone/);
  });

  test('a Node without process.execve ends with exit 75 too', () => {
    const { deps, exits, logs } = createDeps({ execve: undefined });
    reexecProcess(target, {}, deps);
    assert.deepEqual(exits, [restartFailedExitCode]);
    assert.match(logs[0], /no process\.execve/);
  });
});

describe('the launch environment', () => {
  test('is the environment as it was when the process started, not what was loaded into process.env since', () => {
    process.env.CHARNESS_LAUNCH_PROBE = 'set after launch';
    try {
      assert.equal(getLaunchEnvironment().CHARNESS_LAUNCH_PROBE, undefined);
      assert.equal(getLaunchEnvironment().PATH, process.env.PATH);
    } finally {
      delete process.env.CHARNESS_LAUNCH_PROBE;
    }
  });

  test('each call is a copy: editing it changes nothing', () => {
    getLaunchEnvironment().PATH = 'tampered';
    assert.notEqual(getLaunchEnvironment().PATH, 'tampered');
  });
});

describe('the real process.execve', () => {
  test('the same pid goes on, with the given environment and arguments, in the same cwd; exit handlers of the old image never run', () => {
    const result = spawnSync(process.execPath, ['--import', tsxLoaderUrl, probePath, 'first', tsxLoaderUrl], {
      cwd: repoRoot,
      env: { PATH: process.env.PATH, REEXEC_PROBE: 'live value', HOME: process.env.HOME },
      encoding: 'utf8',
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split('\n');
    assert.equal(lines.length, 2, `the first image's exit handler must not run: ${result.stdout}`);
    const first: { pid: number } = JSON.parse(lines[0]);
    const second: { pid: number; cwd: string; probe: string | null; stale: string | null; args: string[] } = JSON.parse(lines[1]);
    assert.equal(second.pid, first.pid);
    assert.equal(second.cwd, repoRoot);
    assert.equal(second.probe, 'from the launch environment');
    assert.equal(second.stale, null, 'a value set on the live process.env after launch is not carried over');
    assert.deepEqual(second.args.slice(0, 1), ['second']);
  });
});
