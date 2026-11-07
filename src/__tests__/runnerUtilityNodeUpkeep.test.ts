/**
 * @description `runnerUtility/nodeUpkeep.ts`: looking after the runner's own Node.js while the link is up. A failed attempt is written down and left alone for a
 * day or until the program is updated (never a download at every start); a move off a system Node and a newer release of an own Node rewrite the launcher and
 * ask the link to leave — and the log names the Node it leaves, with its version; the link leaves only when no command runs; what no process uses any more is
 * removed (and what a killed install left), while the Node that runs, the one the launcher names and the new one stay.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CommandResult, CommandRunner } from '../selfUpdate/commandRunner';
import { ensureLauncher } from '../runnerUtility/launcher';
import { testKeepNodeEnvName, type NodeMoveDeps } from '../runnerUtility/managedNode';
import {
  checkIsAttemptDue,
  createIdleRestart,
  ensureLauncherForRunningNode,
  listRunningExecutables,
  nodeMoveRetryMs,
  pruneOwnNodes,
  readNodeFailure,
  restartHint,
  runNodeUpkeep,
  type NodeUpkeepDeps,
} from '../runnerUtility/nodeUpkeep';
import { getRunnerHomePaths } from '../runnerUtility/runnerHome';
import { waitUntil } from './runnersTestKit';

const systemNode = '/opt/homebrew/bin/node';
const systemVersion = '25.1.0';
const hour = 60 * 60 * 1000;
let root = '';
let paths = getRunnerHomePaths('/home/runner');

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'node-upkeep-')));
  paths = getRunnerHomePaths(path.join(root, 'home'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeNode(version: string): string {
  const file = path.join(paths.ownNodeDir, version, 'bin', 'node');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  return fs.realpathSync(file);
}

interface Harness {
  deps: NodeUpkeepDeps;
  logs: string[];
  said: string[];
  runs: () => number;
  setNow: (value: number) => void;
  setAppId: (value: string | null) => void;
  setRunning: (executables: string[]) => void;
}

/** The upkeep over a script that answers `answer` (and counts its runs), a clock and an app copy the test moves, and a process list the test names. */
function createHarness(answer: Partial<CommandResult>, overrides: { currentNodePath?: string; currentNodeVersion?: string; environment?: NodeJS.ProcessEnv } = {}): Harness {
  let runs = 0;
  let nowValue = 1_000_000;
  let appId: string | null = 'app.aaaa';
  let running: string[] = [];
  const logs: string[] = [];
  const said: string[] = [];
  const runner: CommandRunner = async () => {
    runs += 1;
    return { ok: true, exitCode: 0, stdout: '', stderr: '', isTimedOut: false, ...answer };
  };
  const move: NodeMoveDeps = {
    runner,
    currentNodePath: overrides.currentNodePath ?? systemNode,
    currentNodeVersion: overrides.currentNodeVersion ?? systemVersion,
    scriptPath: '/app/remoteRun/ensureNode.sh',
    distUrl: null,
    sharedBase: path.join(root, 'shared'),
    checkScriptExists: () => true,
  };
  return {
    deps: { paths, move, log: (line) => { logs.push(line); }, say: (line) => { said.push(line); }, now: () => nowValue, getAppId: () => appId, listRunningExecutables: () => running, environment: overrides.environment ?? {} },
    logs,
    said,
    runs: () => runs,
    setNow: (value) => { nowValue = value; },
    setAppId: (value) => { appId = value; },
    setRunning: (executables) => { running = executables; },
  };
}

describe('when an attempt is made', () => {
  it('always without a failure on record; not while a failure under the same app copy is younger than a day; again after a day, or at once after an update of the program', () => {
    const failure = { failedAtMs: 1000, appId: 'app.aaaa', reason: 'no network' };
    assert.equal(checkIsAttemptDue(null, 'app.aaaa', 5), true);
    assert.equal(checkIsAttemptDue(failure, 'app.aaaa', 1000 + nodeMoveRetryMs - 1), false);
    assert.equal(checkIsAttemptDue(failure, 'app.aaaa', 1000 + nodeMoveRetryMs), true);
    assert.equal(checkIsAttemptDue(failure, 'app.bbbb', 1001), true, 'the program was updated since');
    assert.equal(checkIsAttemptDue(failure, null, 1001), true, 'an app copy that cannot be read is not the same one');
  });

  it('reads the record back, and takes a file that is no valid record for none', () => {
    fs.mkdirSync(path.dirname(paths.nodeFailure), { recursive: true });
    assert.equal(readNodeFailure(paths), null);
    fs.writeFileSync(paths.nodeFailure, JSON.stringify({ failedAtMs: 5, appId: null, reason: 'x' }));
    assert.deepEqual(readNodeFailure(paths), { failedAtMs: 5, appId: null, reason: 'x' });
    fs.writeFileSync(paths.nodeFailure, '{"failedAtMs": "yesterday"}');
    assert.equal(readNodeFailure(paths), null);
    fs.writeFileSync(paths.nodeFailure, 'not json');
    assert.equal(readNodeFailure(paths), null);
  });
});

describe('a failed attempt', () => {
  it('is written down with the app copy and the reason, told in the log with the way out, and leaves the runner on the Node it has', async () => {
    const harness = createHarness({ ok: false, exitCode: 1, stderr: 'charness-runner: could not download\n' });
    ensureLauncher(paths, systemNode);
    const before = fs.readFileSync(paths.launcher, 'utf8');
    assert.equal(await runNodeUpkeep(harness.deps), 'stay');
    assert.deepEqual(readNodeFailure(paths), { failedAtMs: 1_000_000, appId: 'app.aaaa', reason: 'could not download' });
    assert.match(harness.logs.join('\n'), /^this runner runs on Node\.js 25\.1\.0 at \/opt\/homebrew\/bin\/node and could not get a Node\.js of its own or a newer one: could not download\. It tries again after 24 hours or the next update of the program\.$/);
    assert.equal(fs.readFileSync(paths.launcher, 'utf8'), before);
  });

  it('is NOT tried again at the next start, nor an hour later — no download at every start of a service that restarts — but after a day, and after an update of the program', async () => {
    const harness = createHarness({ ok: false, exitCode: 1, stderr: 'charness-runner: could not download\n' });
    await runNodeUpkeep(harness.deps);
    assert.equal(harness.runs(), 1);
    harness.setNow(1_000_000 + hour);
    await runNodeUpkeep(harness.deps);
    await runNodeUpkeep(harness.deps);
    assert.equal(harness.runs(), 1, 'the script was not asked again');
    assert.match(harness.logs.at(-1) ?? '', /last attempt to get a Node\.js of its own \(or a newer one\) failed — could not download — and is tried again after 24 hours or the next update of the program/);
    harness.setNow(1_000_000 + nodeMoveRetryMs);
    await runNodeUpkeep(harness.deps);
    assert.equal(harness.runs(), 2, 'a day later');
    harness.setNow(1_000_000 + nodeMoveRetryMs + hour);
    await runNodeUpkeep(harness.deps);
    assert.equal(harness.runs(), 2, 'the day starts again from the new failure');
    harness.setAppId('app.bbbb');
    await runNodeUpkeep(harness.deps);
    assert.equal(harness.runs(), 3, 'an update of the program');
  });

  it('is forgotten once an attempt works', async () => {
    const failing = createHarness({ ok: false, exitCode: 1, stderr: 'x\n' });
    await runNodeUpkeep(failing.deps);
    assert.notEqual(readNodeFailure(paths), null);
    const own = writeNode('v22.99.0');
    const working = createHarness({ stdout: `${own}\n` }, { currentNodePath: own, currentNodeVersion: '22.99.0' });
    working.setAppId('app.bbbb');
    assert.equal(await runNodeUpkeep(working.deps), 'stay');
    assert.equal(readNodeFailure(paths), null);
  });
});

describe('a Node put in place', () => {
  it('for a runner that was on a system Node: the launcher is rewritten, the link is asked to leave, and the log names the Node it leaves (path and version), the one it gets, how to keep the old one, and how the restart happens', async () => {
    const installed = writeNode('v24.22.2');
    ensureLauncher(paths, systemNode);
    const harness = createHarness({ stdout: `${installed}\n`, stderr: 'charness-runner: installing Node.js v24.22.2\n' });
    assert.equal(await runNodeUpkeep(harness.deps), 'restart');
    assert.equal(fs.readFileSync(paths.launcher, 'utf8').includes(`NODE='${installed}'`), true);
    const said = harness.said.join('\n');
    assert.match(said, /^charness-runner: this runner now has its own Node\.js 24\.22\.2 at \S+\/v24\.22\.2\/bin\/node and leaves Node\.js 25\.1\.0 at \/opt\/homebrew\/bin\/node: jobs will run the new one /);
    assert.ok(said.includes('«A runner\'s Node» in docs/remote-run.md'), 'and where to read how to keep the old one');
    assert.ok(said.includes(restartHint));
    assert.equal(restartHint, 'a service manager starts the launcher again by itself; started from a terminal, start `charness-runner run` again');
    assert.deepEqual(harness.logs, ['installing Node.js v24.22.2'], 'the script\'s own words reach the log, as the log words them');
  });

  it('for a runner on its own Node: a newer release is told as such, and the launcher follows', async () => {
    const running = writeNode('v22.20.0');
    const newer = writeNode('v22.23.4');
    ensureLauncher(paths, running);
    const harness = createHarness({ stdout: `${newer}\n` }, { currentNodePath: running, currentNodeVersion: '22.20.0' });
    assert.equal(await runNodeUpkeep(harness.deps), 'restart');
    assert.equal(fs.readFileSync(paths.launcher, 'utf8').includes(`NODE='${newer}'`), true);
    assert.match(harness.said.join('\n'), /a newer release of this runner's own Node\.js is in place: Node\.js 22\.23\.4 at \S+, replacing Node\.js 22\.20\.0 at \S+; the link starts again on it when no command runs/);
  });

  it('does NOT ask the link to leave when the launcher already names that Node while this link runs on another — it would loop at every restart — and leaves the launcher alone', async () => {
    const installed = writeNode('v24.22.2');
    ensureLauncher(paths, installed);
    const inode = fs.statSync(paths.launcher).ino;
    const harness = createHarness({ stdout: `${installed}\n` });
    assert.equal(await runNodeUpkeep(harness.deps), 'stay');
    assert.match(harness.logs.join('\n'), /the launcher already names \S+, but this link still runs on Node\.js 25\.1\.0 at \/opt\/homebrew\/bin\/node: start the launcher again to use it/);
    assert.equal(fs.statSync(paths.launcher).ino, inode);
    assert.deepEqual(harness.said, []);
  });

  it('asks for nothing from a link that runs on the shared Node, and for no change when it already has the newest release of its line', async () => {
    const shared = path.join(root, 'shared', 'v22.99.0', 'bin', 'node');
    fs.mkdirSync(path.dirname(shared), { recursive: true });
    fs.writeFileSync(shared, '');
    const onShared = createHarness({}, { currentNodePath: shared, currentNodeVersion: '22.99.0' });
    assert.equal(await runNodeUpkeep(onShared.deps), 'stay');
    assert.equal(onShared.runs(), 0);
    const own = writeNode('v22.99.0');
    const current = createHarness({ stdout: `${own}\n` }, { currentNodePath: own, currentNodeVersion: '22.99.0' });
    assert.equal(await runNodeUpkeep(current.deps), 'stay');
    assert.deepEqual(current.said, []);
  });

  it('is skipped altogether for a flow\'s runner that is told to keep the Node it has', async () => {
    const harness = createHarness({ stdout: `${writeNode('v24.22.2')}\n` }, { environment: { [testKeepNodeEnvName]: '1' } });
    assert.equal(await runNodeUpkeep(harness.deps), 'stay');
    assert.equal(harness.runs(), 0);
  });
});

describe('the launcher at the start of a link', () => {
  it('follows the Node that runs — a system Node, or a Node started by hand — as it always did', () => {
    ensureLauncherForRunningNode(paths, systemNode);
    assert.equal(fs.readFileSync(paths.launcher, 'utf8').includes(`NODE='${systemNode}'`), true);
    ensureLauncherForRunningNode(paths, '/opt/other/bin/node');
    assert.equal(fs.readFileSync(paths.launcher, 'utf8').includes(`NODE='/opt/other/bin/node'`), true);
  });

  it('is NOT rewritten for the Node that runs when it already names one of the runner\'s own and the link runs on another — an old launcher process that was started before the move would undo it', () => {
    const own = writeNode('v24.22.2');
    ensureLauncher(paths, own);
    const inode = fs.statSync(paths.launcher).ino;
    ensureLauncherForRunningNode(paths, systemNode);
    assert.equal(fs.statSync(paths.launcher).ino, inode);
    assert.equal(fs.readFileSync(paths.launcher, 'utf8').includes(`NODE='${own}'`), true);
    ensureLauncherForRunningNode(paths, own);
    assert.equal(fs.statSync(paths.launcher).ino, inode, 'and nothing to change when it runs on it');
  });

  it('is rewritten when the link runs on an own Node and the launcher names something else', () => {
    const own = writeNode('v24.22.2');
    ensureLauncher(paths, systemNode);
    ensureLauncherForRunningNode(paths, own);
    assert.equal(fs.readFileSync(paths.launcher, 'utf8').includes(`NODE='${own}'`), true);
  });
});

describe('removing what is not used', () => {
  function createPruneDeps(running: string[] = [], nowMs: number = Date.now()): { removedLogs: string[]; deps: Parameters<typeof pruneOwnNodes>[2] } {
    const removedLogs: string[] = [];
    return { removedLogs, deps: { listRunningExecutables: () => running, now: () => nowMs, log: (line) => { removedLogs.push(line); } } };
  }

  it('removes the versions that are not kept and that no process runs; keeps the kept ones and any that a process is an executable of (a long build started from an older Node)', () => {
    const [keptA, keptB] = [writeNode('v22.23.4'), writeNode('v22.20.0')];
    const usedByProcess = writeNode('v22.10.0');
    writeNode('v20.1.0');
    fs.mkdirSync(path.join(paths.ownNodeDir, 'notes'));
    const { removedLogs, deps } = createPruneDeps([usedByProcess, '/usr/bin/sleep']);
    const removed = pruneOwnNodes(paths, [path.dirname(path.dirname(keptA)), path.dirname(path.dirname(keptB))], deps);
    assert.deepEqual(removed, ['v20.1.0']);
    assert.deepEqual(fs.readdirSync(paths.ownNodeDir).sort(), ['notes', 'v22.10.0', 'v22.20.0', 'v22.23.4'], 'a folder that is not a version is never touched');
    assert.deepEqual(removedLogs, ['removed Node.js 20.1.0, which no process uses any more']);
  });

  it('removes the work folder of an install that was killed (older than an hour) and leaves one that is in progress', () => {
    const stale = path.join(paths.ownNodeDir, '.install.AbCdEf12');
    const fresh = path.join(paths.ownNodeDir, '.install.ZyXwVu98');
    for (const folder of [stale, fresh]) fs.mkdirSync(folder, { recursive: true });
    const now = Date.now();
    fs.utimesSync(stale, new Date(now - 2 * hour), new Date(now - 2 * hour));
    const { deps } = createPruneDeps([], now);
    assert.deepEqual(pruneOwnNodes(paths, [], deps), ['.install.AbCdEf12']);
    assert.equal(fs.existsSync(fresh), true);
  });

  it('is done by every look: after a restart onto a newer Node the old one goes — the Node that runs, the one the launcher names and the new one are kept before it', async () => {
    const old = writeNode('v22.20.0');
    const running = writeNode('v22.23.4');
    ensureLauncher(paths, running);
    const harness = createHarness({ stdout: `${running}\n` }, { currentNodePath: running, currentNodeVersion: '22.23.4' });
    assert.equal(await runNodeUpkeep(harness.deps), 'stay');
    assert.equal(fs.existsSync(path.dirname(path.dirname(old))), false, 'the old release, which nothing uses');
    assert.equal(fs.existsSync(running), true);
    // …but not before a restart: the Node the link runs on, the one the launcher named a moment ago (an old launcher process may still run it) and the new one are kept.
    const stillRunning = writeNode('v22.30.0');
    const next = writeNode('v22.31.0');
    const unrelated = writeNode('v22.25.0');
    ensureLauncher(paths, stillRunning);
    const leaving = createHarness({ stdout: `${next}\n` }, { currentNodePath: stillRunning, currentNodeVersion: '22.30.0' });
    assert.equal(await runNodeUpkeep(leaving.deps), 'restart');
    assert.equal(fs.existsSync(stillRunning), true, 'the Node this link runs on');
    assert.equal(fs.existsSync(next), true, 'the new one');
    assert.equal(fs.existsSync(unrelated), false, 'one that neither runs, nor is named, nor is new');
    // After the restart the link runs on the new one: the old one is no longer used by anything and goes at the next look.
    const afterRestart = createHarness({ stdout: `${next}\n` }, { currentNodePath: next, currentNodeVersion: '22.31.0' });
    assert.equal(await runNodeUpkeep(afterRestart.deps), 'stay');
    assert.equal(fs.existsSync(stillRunning), false, 'the release the link left');
    assert.equal(fs.existsSync(next), true);
  });
});

describe('listing the executables of running processes (what decides that an install is in use)', () => {
  it('finds a process started from a copy of an executable in an install folder', async (context) => {
    // A shell is one binary that runs from wherever it is copied to (`sleep` is a multi-call one on some systems).
    const shell = fs.realpathSync('/bin/sh');
    const install = path.join(root, 'v9.9.9', 'bin');
    fs.mkdirSync(install, { recursive: true });
    try {
      fs.copyFileSync(shell, path.join(install, 'node'));
    } catch {
      context.skip('this shell cannot be copied here');
    }
    fs.chmodSync(path.join(install, 'node'), 0o755);
    const child = spawn(path.join(install, 'node'), ['-c', 'sleep 30'], { stdio: 'ignore' });
    try {
      await waitUntil(() => listRunningExecutables().some((executable) => executable.startsWith(`${fs.realpathSync(install)}${path.sep}`)), 'the process to show among the running executables');
    } finally {
      child.kill('SIGKILL');
    }
  });
});

describe('leaving only when no command runs', () => {
  it('leaves at once when asked while nothing runs; waits while a command runs and leaves when the last one ends; leaves once', () => {
    let active = 2;
    let leaves = 0;
    const restart = createIdleRestart({ getActiveCount: () => active, leave: () => { leaves += 1; } });
    restart.notifyActiveCountChange();
    assert.equal(leaves, 0, 'nothing was asked');
    restart.request();
    assert.equal(leaves, 0, 'two commands run');
    active = 1;
    restart.notifyActiveCountChange();
    assert.equal(leaves, 0, 'one still runs');
    active = 0;
    restart.notifyActiveCountChange();
    assert.equal(leaves, 1);
    restart.notifyActiveCountChange();
    restart.request();
    assert.equal(leaves, 1, 'once');
    const idle = createIdleRestart({ getActiveCount: () => 0, leave: () => { leaves += 1; } });
    idle.request();
    assert.equal(leaves, 2, 'at once when idle');
  });
});
