/**
 * @description A process-level test's private tmux server must never outlive the
 * test (`e2e/isolatedCharness.ts`): a run killed outright — SIGKILL of the whole
 * process group, which no `exit` handler sees — once left its server and five
 * fake agents running for six hours. Two guards: a detached reaper that ends
 * the instance when its owner dies, and the next run's sweep of a provably
 * dead earlier instance of the same prefix (and only such: a live one is kept). The teardown itself must not lean on the
 * agents' goodwill either: a fake `claude` that a test told to ignore its stop signals (`ignore-stop-signals`), left so by a
 * run that ended mid-step, outlived its tmux server and its folder for a day and a half — the teardown ends what the
 * instance started whatever its agents do with their signals, and fails the file when a fake agent it launched still runs.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { fakeClaudeLogFileNames } from './jiraE2e/fakeClaudeContract';
import {
  checkIsProcessRunning,
  createIsolatedInstanceLayout,
  fakeClaudePath,
  fakeClaudeTuiPath,
  getFakeClaudeTuiLaunchesPath,
  getProcessStartTicks,
  getTmuxEnv,
  getTmuxSocketDir,
  isolatedInstanceOwnerFileName,
  listTmuxSessions,
  reapDeadIsolatedInstances,
  readIsolatedInstanceOwner,
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

/** An agent a test left deaf to its stop signals: it writes its pid to `process.argv[2]`, ignores a hang-up and a terminate, and idles. */
const stopSignalIgnoringAgentCode = [
  `require('fs').writeFileSync(process.argv[2], String(process.pid));`,
  `process.on('SIGHUP', () => {});`,
  `process.on('SIGTERM', () => {});`,
  `setInterval(() => {}, 1000);`,
].join('\n');
/**
 * A bot that is still running when the teardown starts (the reaper's case): it keeps starting children, which carry its HOME.
 * A teardown that reads the process list once cannot see a child started after it.
 */
const childSpawningBotCode = [
  `const { spawn } = require('child_process');`,
  `setInterval(() => {`,
  `  for (let started = 0; started < 5; started += 1) spawn('sleep', ['60'], { stdio: 'ignore', detached: true }).unref();`,
  `}, 1);`,
].join('\n');
/** How many processes of the instance run before the teardown begins: the bot is in full swing. */
const botProcessesBeforeTeardown = 20;

/** The two fake agents the teardown checks, with the launch log each one writes. */
const fakeAgentKinds = [
  { name: 'stream-json', scriptPath: fakeClaudePath, launchLog: 'streamJson' },
  { name: 'tmux TUI', scriptPath: fakeClaudeTuiPath, launchLog: 'tui' },
] as const;

/** A pid this test names as a long-gone fake agent: no such process runs (the kernel's pid space ends far below it). */
const gonePid = 2 ** 22 + 1;

const createdRoots: string[] = [];

/** The start time of this test process — `/proc` is required here, so a reused-pid case can be built from it. */
function getOwnStartTicks(): number {
  const startTicks = getProcessStartTicks(process.pid);
  assert.ok(startTicks !== null, 'this test reads start times from /proc');
  return startTicks;
}

/** A stale layout as a crashed run leaves it: its folder, its tmux dir, its owner file — and a running private server. */
function createStaleLayout(owner: Omit<IsolatedInstanceOwner, 'tmuxTmpDir' | 'tmuxSocketName'> & Partial<IsolatedInstanceOwner>, isServerStarted: boolean): { testRoot: string; socketPath: string } {
  const testRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  createdRoots.push(testRoot);
  const tmuxTmpDir = path.join(testRoot, 'tmux');
  fs.mkdirSync(tmuxTmpDir, { mode: 0o700 });
  const tmuxSocketName = `${prefix}stale`;
  const ownerRecord: IsolatedInstanceOwner = { tmuxTmpDir, tmuxSocketName, ...owner };
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

/** The processes that run with `home` as their HOME: what every process of an instance carries. */
function listRunningProcessesWithHome(home: string): number[] {
  return fs.readdirSync('/proc').map(Number).filter((pid) => {
    if (!Number.isInteger(pid) || !checkIsProcessRunning(pid)) return false;
    try {
      return fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`HOME=${home}`);
    } catch {
      return false;
    }
  });
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
    const live = createStaleLayout({ pid: process.pid, startTicks: getOwnStartTicks() }, false);

    const reaped = reapDeadIsolatedInstances(prefix);

    assert.deepEqual(reaped, [dead.testRoot], 'exactly the dead instance was reaped');
    assert.equal(checkIsServerRunning(dead.socketPath), false, 'the dead instance\'s server is gone');
    assert.ok(!fs.existsSync(dead.testRoot), 'the dead instance\'s folder is gone');
    assert.ok(fs.existsSync(path.join(live.testRoot, isolatedInstanceOwnerFileName)), 'the live instance is untouched');
  });

  it('a layout owned by a reused pid (same pid, another start time) counts as dead', () => {
    const stale = createStaleLayout({ pid: process.pid, startTicks: getOwnStartTicks() - 1 }, false);
    assert.deepEqual(reapDeadIsolatedInstances(prefix), [stale.testRoot]);
    assert.ok(!fs.existsSync(stale.testRoot));
  });

  it('an owner file naming the user\'s default server, or a tmux dir outside its layout, is read as no owner at all', () => {
    // Asserted on the READ alone, never through the sweep: with the record check broken, a sweep over these
    // records would kill the user's own default server — the very thing the check exists to make impossible.
    const defaultServer = createStaleLayout({ pid: process.pid, startTicks: getOwnStartTicks(), tmuxSocketName: 'default' }, false);
    const foreignDir = createStaleLayout({ pid: process.pid, startTicks: getOwnStartTicks(), tmuxTmpDir: '/tmp' }, false);
    const intact = createStaleLayout({ pid: process.pid, startTicks: getOwnStartTicks() }, false);
    assert.equal(readIsolatedInstanceOwner(defaultServer.testRoot), null);
    assert.equal(readIsolatedInstanceOwner(foreignDir.testRoot), null);
    assert.equal(readIsolatedInstanceOwner(intact.testRoot)?.tmuxSocketName, `${prefix}stale`);
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
    // The launch log names a gone process and a running one that is no fake agent (a reused pid): neither is a survivor.
    const notSurvivorLaunches = [gonePid, process.pid].map((pid) => `${JSON.stringify({ pid })}\n`).join('');
    fs.writeFileSync(path.join(layout.fakeLogDir, fakeClaudeLogFileNames.launches), notSurvivorLaunches);
    fs.writeFileSync(getFakeClaudeTuiLaunchesPath(layout), notSurvivorLaunches);
    const exitCodeBefore = process.exitCode;
    removeIsolatedInstanceSync(layout, null);
    assert.equal(process.exitCode, exitCodeBefore, 'nothing was reported');
    assert.ok(!fs.existsSync(layout.testRoot));
    assert.deepEqual(reapDeadIsolatedInstances(prefix), []);
  });

  it('a teardown ends an agent that ignores its hang-up and its terminate, and one that ran without a tmux server of its own', async () => {
    const layout = createIsolatedInstanceLayout(prefix, []);
    createdRoots.push(layout.testRoot);
    const agentPath = path.join(layout.testRoot, 'agent.js');
    fs.writeFileSync(agentPath, stopSignalIgnoringAgentCode);
    // The agent as the instance's tmux server hosts it: a pane of the private server, with the instance's HOME.
    const pidPaths = ['tmux-agent.pid', 'outside-agent.pid'].map((fileName) => path.join(layout.testRoot, fileName));
    const started = spawnSync('tmux', ['-L', layout.tmuxSocketName, 'new-session', '-d', '-s', 'agent', `env HOME='${layout.instanceHome}' '${process.execPath}' '${agentPath}' '${pidPaths[0]}'`], { env: getTmuxEnv(layout.tmuxTmpDir), encoding: 'utf8' });
    assert.equal(started.status, 0, `the private server started the agent: ${started.stderr}`);
    // And one the instance started outside its tmux server (an orphan of an earlier teardown, a respawn after the server's death).
    const outsideAgent = spawn(process.execPath, [agentPath, pidPaths[1]], { env: { ...process.env, HOME: layout.instanceHome }, detached: true, stdio: 'ignore' });
    outsideAgent.unref();
    await waitUntil('both agents to run', reaperWaitMs, () => pidPaths.every((pidPath) => fs.existsSync(pidPath) && fs.readFileSync(pidPath, 'utf8') !== ''));
    const agentPids = pidPaths.map((pidPath) => Number(fs.readFileSync(pidPath, 'utf8')));
    try {
      for (const pid of agentPids) assert.ok(checkIsProcessRunning(pid), `${pid} runs before the teardown`);
      removeIsolatedInstanceSync(layout, null);
      await waitUntil('the agents to end', reaperWaitMs, () => agentPids.every((pid) => !checkIsProcessRunning(pid)));
      assert.ok(!fs.existsSync(layout.testRoot), 'the folder is gone');
    } finally {
      for (const pid of agentPids) {
        if (checkIsProcessRunning(pid)) process.kill(pid, 'SIGKILL');
      }
    }
  });

  it('a child the instance starts while the teardown reads the process list is ended by a later pass', async () => {
    const layout = createIsolatedInstanceLayout(prefix, []);
    createdRoots.push(layout.testRoot);
    const botPath = path.join(layout.testRoot, 'bot.js');
    fs.writeFileSync(botPath, childSpawningBotCode);
    const bot = spawn(process.execPath, [botPath], { env: { ...process.env, HOME: layout.instanceHome }, detached: true, stdio: 'ignore' });
    bot.unref();
    try {
      await waitUntil('the bot to be starting children', reaperWaitMs, () => listRunningProcessesWithHome(layout.instanceHome).length >= botProcessesBeforeTeardown);
      removeIsolatedInstanceSync(layout, null);
      await waitUntil('nothing of the instance to run any more, the children started during the teardown included', reaperWaitMs, () => listRunningProcessesWithHome(layout.instanceHome).length === 0);
    } finally {
      for (const pid of listRunningProcessesWithHome(layout.instanceHome)) process.kill(pid, 'SIGKILL');
    }
  });

  for (const { name, scriptPath, launchLog } of fakeAgentKinds) {
    it(`a ${name} fake agent the teardown cannot end fails the file: it names the pid and the run exits non-zero`, async () => {
      // Started with another HOME than the instance's, so the sweep does not know it; the launch log still names it.
      const survivor = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', scriptPath], { detached: true, stdio: 'ignore' });
      survivor.unref();
      assert.ok(survivor.pid, 'the survivor started');
      // The teardown runs in a process of its own: it must fail THAT process, not this test.
      const childCode = [
        `const helperModule = await import(${JSON.stringify(pathToFileURL(isolatedCharnessPath).href)});`,
        `const { createIsolatedInstanceLayout, getFakeClaudeTuiLaunchesPath, removeIsolatedInstanceSync } = helperModule.default ?? helperModule;`,
        `const fs = await import('fs');`,
        `const path = await import('path');`,
        `const layout = createIsolatedInstanceLayout(${JSON.stringify(prefix)}, []);`,
        `const launchLogPath = process.env.LAUNCH_LOG === 'tui' ? getFakeClaudeTuiLaunchesPath(layout) : path.join(layout.fakeLogDir, ${JSON.stringify(fakeClaudeLogFileNames.launches)});`,
        `fs.writeFileSync(launchLogPath, JSON.stringify({ pid: Number(process.env.SURVIVOR_PID) }) + '\\n');`,
        `removeIsolatedInstanceSync(layout, null);`,
      ].join('\n');
      try {
        const teardown = spawnSync(process.execPath, ['--import', pathToFileURL(tsxLoaderPath).href, '--input-type=module', '--eval', childCode], {
          encoding: 'utf8',
          env: { ...process.env, SURVIVOR_PID: survivor.pid.toString(), LAUNCH_LOG: launchLog },
        });
        assert.equal(teardown.status, 1, `the file's process exits non-zero: ${teardown.stderr}`);
        assert.match(teardown.stderr, new RegExp(`still running after the teardown.*${survivor.pid}`));
      } finally {
        process.kill(survivor.pid, 'SIGKILL');
      }
    });
  }
});
