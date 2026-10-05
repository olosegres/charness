/**
 * @description A process-level test's private tmux server must never outlive the
 * test (`e2e/isolatedCharness.ts`): a run killed outright — SIGKILL of the whole
 * process group, which no `exit` handler sees — once left its server and five
 * fake agents running for six hours. Two guards: a detached reaper that ends
 * the instance when its owner dies, and the next run's sweep of a provably
 * dead earlier instance of the same prefix (and only such: a live one is kept).
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import {
  createIsolatedInstanceLayout,
  getProcessStartTicks,
  getTmuxEnv,
  getTmuxSocketDir,
  isolatedInstanceOwnerFileName,
  listTmuxSessions,
  reapDeadIsolatedInstances,
  removeIsolatedInstanceSync,
  type IsolatedInstanceLayout,
  type IsolatedInstanceOwner,
} from './e2e/isolatedCharness';

/** A prefix of this test's own, so the sweep under test can never touch another suite's instance. */
const prefix = 'charness-reaptest-';
const reaperWaitMs = 15 * 1000;
const waitStepMs = 250;
const isolatedCharnessPath = path.join(__dirname, 'e2e', 'isolatedCharness.ts');
const tsxLoaderPath = path.join(__dirname, '..', '..', 'node_modules', 'tsx', 'dist', 'loader.mjs');

const createdRoots: string[] = [];

/** A stale layout as a crashed run leaves it: its folder, its tmux dir, its owner file — and a running private server. */
function createStaleLayout(owner: Omit<IsolatedInstanceOwner, 'tmuxTmpDir' | 'tmuxSocketName'>, isServerStarted: boolean): { testRoot: string; socketPath: string } {
  const testRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  createdRoots.push(testRoot);
  const tmuxTmpDir = path.join(testRoot, 'tmux');
  fs.mkdirSync(tmuxTmpDir, { mode: 0o700 });
  const tmuxSocketName = `${prefix}stale`;
  const ownerRecord: IsolatedInstanceOwner = { ...owner, tmuxTmpDir, tmuxSocketName };
  fs.writeFileSync(path.join(testRoot, isolatedInstanceOwnerFileName), JSON.stringify(ownerRecord));
  const socketPath = path.join(getTmuxSocketDir(tmuxTmpDir), tmuxSocketName);
  if (isServerStarted) {
    const started = spawnSync('tmux', ['-L', tmuxSocketName, 'new-session', '-d', '-s', 'stale'], { env: getTmuxEnv(tmuxTmpDir), encoding: 'utf8' });
    assert.equal(started.status, 0, `the stale server started: ${started.stderr}`);
    assert.deepEqual(listTmuxSessions(['-S', socketPath], getTmuxEnv(null)), ['stale']);
  }
  return { testRoot, socketPath };
}

/** Whether a tmux server answers at `socketPath` (a read-only probe). */
function checkIsServerRunning(socketPath: string): boolean {
  return spawnSync('tmux', ['-S', socketPath, 'list-sessions'], { env: getTmuxEnv(null) }).status === 0;
}

async function waitUntil(description: string, timeoutMs: number, check: () => boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, waitStepMs));
  }
}

describe('a private tmux server of a process-level test never outlives the test', () => {
  after(() => {
    for (const testRoot of createdRoots) {
      for (const socketName of fs.existsSync(getTmuxSocketDir(path.join(testRoot, 'tmux'))) ? fs.readdirSync(getTmuxSocketDir(path.join(testRoot, 'tmux'))) : []) {
        spawnSync('tmux', ['-S', path.join(getTmuxSocketDir(path.join(testRoot, 'tmux')), socketName), 'kill-server'], { env: getTmuxEnv(null) });
      }
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('the next run reaps a dead earlier instance — its tmux server and folder — and leaves a live one alone', async () => {
    // A process that has exited: its pid is gone from /proc (and its start time can never match a reused pid).
    const exited = spawnSync('true');
    assert.ok(exited.pid, 'the short-lived process ran');
    const dead = createStaleLayout({ pid: exited.pid, startTicks: 1 }, true);
    const live = createStaleLayout({ pid: process.pid, startTicks: getProcessStartTicks(process.pid) }, false);

    const reaped = reapDeadIsolatedInstances(prefix);

    assert.deepEqual(reaped, [dead.testRoot], 'exactly the dead instance was reaped');
    assert.equal(checkIsServerRunning(dead.socketPath), false, 'the dead instance\'s server is gone');
    assert.ok(!fs.existsSync(dead.testRoot), 'the dead instance\'s folder is gone');
    assert.ok(fs.existsSync(path.join(live.testRoot, isolatedInstanceOwnerFileName)), 'the live instance is untouched');
  });

  it('a layout owned by a reused pid (same pid, another start time) counts as dead', () => {
    const stale = createStaleLayout({ pid: process.pid, startTicks: getProcessStartTicks(process.pid) - 1 }, false);
    assert.deepEqual(reapDeadIsolatedInstances(prefix), [stale.testRoot]);
    assert.ok(!fs.existsSync(stale.testRoot));
  });

  it('a run killed outright (SIGKILL, no exit handler runs) still loses its private tmux server: the detached reaper ends it', async () => {
    // A child that creates a layout with a running private server, prints its root, and then waits to be killed.
    const childCode = [
      // The helper is compiled as CommonJS, so an ES module sees its exports on `default`.
      `const helperModule = await import(${JSON.stringify(pathToFileURL(isolatedCharnessPath).href)});`,
      `const { createIsolatedInstanceLayout, getTmuxEnv } = helperModule.default ?? helperModule;`,
      `const { spawnSync } = await import('child_process');`,
      `const layout = createIsolatedInstanceLayout(${JSON.stringify(prefix)}, []);`,
      `spawnSync('tmux', ['-L', layout.tmuxSocketName, 'new-session', '-d', '-s', 'victim'], { env: getTmuxEnv(layout.tmuxTmpDir) });`,
      `process.stdout.write(layout.testRoot + '\\n');`,
      `setInterval(() => {}, 1000);`,
    ].join('\n');
    const child = spawn(process.execPath, ['--import', pathToFileURL(tsxLoaderPath).href, '--input-type=module', '--eval', childCode], { stdio: ['ignore', 'pipe', 'inherit'] });
    let childOutput = '';
    child.stdout.on('data', (chunk: Buffer) => { childOutput += chunk.toString('utf8'); });
    await waitUntil('the child\'s layout root', reaperWaitMs, () => childOutput.includes('\n'));
    const testRoot = childOutput.trim();
    createdRoots.push(testRoot);
    const layout: Pick<IsolatedInstanceLayout, 'tmuxTmpDir'> = { tmuxTmpDir: path.join(testRoot, 'tmux') };
    const [socketName] = fs.readdirSync(getTmuxSocketDir(layout.tmuxTmpDir));
    const socketPath = path.join(getTmuxSocketDir(layout.tmuxTmpDir), socketName);
    assert.deepEqual(listTmuxSessions(['-S', socketPath], getTmuxEnv(null)), ['victim'], 'the child\'s private server runs');

    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    await waitUntil('the reaper to end the orphaned instance', reaperWaitMs, () => !checkIsServerRunning(socketPath) && !fs.existsSync(testRoot));
  });

  it('a normal removal leaves nothing for the reaper or the next run', async () => {
    const layout = createIsolatedInstanceLayout(prefix, []);
    createdRoots.push(layout.testRoot);
    removeIsolatedInstanceSync(layout, null);
    assert.ok(!fs.existsSync(layout.testRoot));
    assert.deepEqual(reapDeadIsolatedInstances(prefix), []);
  });
});
