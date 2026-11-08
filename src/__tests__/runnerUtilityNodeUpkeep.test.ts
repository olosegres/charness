/**
 * @description `runnerUtility/nodeUpkeep.ts`: looking after the runner's own Node.js while the link is up. A failed attempt is written down and the next one is due a
 * DAY AFTER THE FAILURE (not a whole interval after the look began) or after an update of the program; a move off a system Node and a newer release of an own Node
 * rewrite the launcher and ask the link to leave — and the log names the Node it leaves, with its version; the link leaves only when nothing is under way (no
 * command over it, no update of the program being installed, no Pueue task); an old version is removed a week after it stopped being the runner's Node and only
 * while Pueue has nothing running or queued — whatever processes seem to run (a process started through the PATH cannot be seen from outside on macOS).
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
  checkIsLinkIdle,
  createIdleRestart,
  createPueueBusyCheck,
  ensureLauncherForRunningNode,
  getNextLookDelayMs,
  nodeMoveRetryMs,
  nodeVersionGraceMs,
  pruneOwnNodes,
  readNodeFailure,
  restartHint,
  runNodeUpkeep,
  startNodeUpkeepSchedule,
  type NodeUpkeepDeps,
} from '../runnerUtility/nodeUpkeep';
import { getRunnerHomePaths } from '../runnerUtility/runnerHome';

const systemNode = '/opt/homebrew/bin/node';
const systemVersion = '25.1.0';
const hour = 60 * 60 * 1000;
const dayMs = 24 * hour;
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
  getNow: () => number;
  setAppId: (value: string | null) => void;
  setPueueBusy: (value: boolean) => void;
}

/** The upkeep over a script that answers `answer` (and counts its runs; an attempt takes `attemptTakesMs`), a clock and an app copy the test moves, and a Pueue the test says is busy. */
function createHarness(answer: Partial<CommandResult>, overrides: { currentNodePath?: string; currentNodeVersion?: string; environment?: NodeJS.ProcessEnv; attemptTakesMs?: number; intervalMs?: number } = {}): Harness {
  let runs = 0;
  let nowValue = 1_000_000;
  let appId: string | null = 'app.aaaa';
  let isPueueBusy = false;
  const logs: string[] = [];
  const said: string[] = [];
  const runner: CommandRunner = async () => {
    runs += 1;
    nowValue += overrides.attemptTakesMs ?? 0;
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
    deps: {
      paths,
      move,
      log: (line) => { logs.push(line); },
      say: (line) => { said.push(line); },
      now: () => nowValue,
      getAppId: () => appId,
      checkIsPueueBusy: async () => isPueueBusy,
      intervalMs: overrides.intervalMs ?? dayMs,
      environment: overrides.environment ?? {},
    },
    logs,
    said,
    runs: () => runs,
    setNow: (value) => { nowValue = value; },
    getNow: () => nowValue,
    setAppId: (value) => { appId = value; },
    setPueueBusy: (value) => { isPueueBusy = value; },
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
    assert.equal((await runNodeUpkeep(harness.deps)).step, 'stay');
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
    assert.equal((await runNodeUpkeep(working.deps)).step, 'stay');
    assert.equal(readNodeFailure(paths), null);
  });
});

describe('when the next look is due (the retry of a failed attempt is a day after the FAILURE)', () => {
  const failure = { failedAtMs: 5 * hour, appId: 'app.aaaa', reason: 'no network' };

  it('is the interval after a look that worked or when no failure is on record, and at once-ish for a failure under another app copy', () => {
    assert.equal(getNextLookDelayMs(null, 'app.aaaa', 0, dayMs), dayMs);
    assert.equal(getNextLookDelayMs(failure, 'app.bbbb', 6 * hour, dayMs), dayMs);
    assert.equal(getNextLookDelayMs(failure, 'app.aaaa', failure.failedAtMs + nodeMoveRetryMs + 1, dayMs), dayMs, 'already due: the usual interval');
  });

  it('is the time left to failedAt + 24 h (and a second for the timer\'s rounding) while a failure under this app copy is pending', () => {
    assert.equal(getNextLookDelayMs(failure, 'app.aaaa', failure.failedAtMs, dayMs), nodeMoveRetryMs + 1000);
    assert.equal(getNextLookDelayMs(failure, 'app.aaaa', failure.failedAtMs + 20 * 60 * 1000, dayMs), nodeMoveRetryMs - 20 * 60 * 1000 + 1000);
  });

  it('with the REAL interval of a day and an attempt that takes 20 minutes: the look the failed one schedules makes the retry — the old fixed interval from the start skipped it and the real retry came a day later', async () => {
    const harness = createHarness({ ok: false, exitCode: 1, stderr: 'charness-runner: could not download\n' }, { attemptTakesMs: 20 * 60 * 1000 });
    const startedAt = harness.getNow();
    const first = await runNodeUpkeep(harness.deps);
    assert.equal(harness.runs(), 1);
    assert.equal(readNodeFailure(paths)?.failedAtMs, startedAt + 20 * 60 * 1000, 'the failure is written when the attempt ENDS');
    // What a fixed 24 h timer from the start would do: it fires 24 h after the start, 20 minutes short of the failure's day.
    harness.setNow(startedAt + dayMs);
    assert.equal(checkIsAttemptDue(readNodeFailure(paths), 'app.aaaa', harness.getNow()), false, 'the fixed interval finds the retry not yet due');
    // What the look schedules instead: the timer fires first.nextLookInMs after the look ended.
    harness.setNow(startedAt + 20 * 60 * 1000 + first.nextLookInMs);
    assert.equal(checkIsAttemptDue(readNodeFailure(paths), 'app.aaaa', harness.getNow()), true);
    await runNodeUpkeep(harness.deps);
    assert.equal(harness.runs(), 2, 'the retry was made, 24 hours after the failure');
    assert.ok(first.nextLookInMs < dayMs + 2000 && first.nextLookInMs > dayMs - 60 * 60 * 1000, `${first.nextLookInMs} ms is about a day`);
  });

  it('THE SCHEDULE of the runner, with the real day and an attempt that takes 20 minutes: the failed look is retried 24 hours after the failure — a timer set when the look BEGAN would fire 20 minutes before that day is over, find the retry not due, and the real retry would be a whole interval later', async () => {
    const harness = createHarness({ ok: false, exitCode: 1, stderr: 'charness-runner: could not download\n' }, { attemptTakesMs: 20 * 60 * 1000 });
    const startedAt = harness.getNow();
    const timers: Array<{ callback: () => void; dueAt: number }> = [];
    startNodeUpkeepSchedule(async () => (await runNodeUpkeep(harness.deps)).nextLookInMs, (callback, ms) => { timers.push({ callback, dueAt: harness.getNow() + ms }); });
    await new Promise((resolve) => { setImmediate(resolve); });
    assert.equal(harness.runs(), 1, 'the first look, at the start');
    assert.equal(timers.length, 1, 'one look is scheduled, after the first one ended');
    assert.ok(timers[0].dueAt >= readNodeFailure(paths)!.failedAtMs + nodeMoveRetryMs, 'not a moment before the failure\'s day is over');
    assert.ok(timers[0].dueAt < startedAt + dayMs + 60 * 60 * 1000, 'and about then');
    harness.setNow(timers[0].dueAt);
    timers[0].callback();
    await new Promise((resolve) => { setImmediate(resolve); });
    assert.equal(harness.runs(), 2, 'the retry was made, 24 hours after the failure');
  });

  it('a look that worked schedules the usual interval, a skipped one the time left, and the keep-the-Node seam the usual interval', async () => {
    const own = writeNode('v22.99.0');
    const worked = createHarness({ stdout: `${own}\n` }, { currentNodePath: own, currentNodeVersion: '22.99.0', intervalMs: 3000 });
    assert.equal((await runNodeUpkeep(worked.deps)).nextLookInMs, 3000);
    const failed = createHarness({ ok: false, exitCode: 1, stderr: 'x\n' }, { intervalMs: 3000 });
    await runNodeUpkeep(failed.deps);
    failed.setNow(failed.getNow() + hour);
    const skipped = await runNodeUpkeep(failed.deps);
    assert.equal(failed.runs(), 1);
    assert.equal(skipped.nextLookInMs, nodeMoveRetryMs - hour + 1000, 'not the interval of a flow, not a whole day: the time left');
    fs.rmSync(paths.nodeFailure, { force: true });
    const kept = createHarness({}, { environment: { [testKeepNodeEnvName]: '1' }, intervalMs: 3000 });
    assert.deepEqual(await runNodeUpkeep(kept.deps), { step: 'stay', nextLookInMs: 3000 });
  });
});

describe('a Node put in place', () => {
  it('for a runner that was on a system Node: the launcher is rewritten, the link is asked to leave, and the log names the Node it leaves (path and version), the one it gets, how to keep the old one, and how the restart happens', async () => {
    const installed = writeNode('v24.22.2');
    ensureLauncher(paths, systemNode);
    const harness = createHarness({ stdout: `${installed}\n`, stderr: 'charness-runner: installing Node.js v24.22.2\n' });
    assert.equal((await runNodeUpkeep(harness.deps)).step, 'restart');
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
    assert.equal((await runNodeUpkeep(harness.deps)).step, 'restart');
    assert.equal(fs.readFileSync(paths.launcher, 'utf8').includes(`NODE='${newer}'`), true);
    assert.match(harness.said.join('\n'), /a newer release of this runner's own Node\.js is in place: Node\.js 22\.23\.4 at \S+, replacing Node\.js 22\.20\.0 at \S+; the link starts again on it when no command, app update or Pueue task is under way/);
  });

  it('does NOT ask the link to leave when the launcher already names that Node while this link runs on another — it would loop at every restart — and leaves the launcher alone', async () => {
    const installed = writeNode('v24.22.2');
    ensureLauncher(paths, installed);
    const inode = fs.statSync(paths.launcher).ino;
    const harness = createHarness({ stdout: `${installed}\n` });
    assert.equal((await runNodeUpkeep(harness.deps)).step, 'stay');
    assert.match(harness.logs.join('\n'), /the launcher already names \S+, but this link still runs on Node\.js 25\.1\.0 at \/opt\/homebrew\/bin\/node: start the launcher again to use it/);
    assert.equal(fs.statSync(paths.launcher).ino, inode);
    assert.deepEqual(harness.said, []);
  });

  it('asks for nothing from a link that runs on the shared Node, and for no change when it already has the newest release of its line', async () => {
    const shared = path.join(root, 'shared', 'v22.99.0', 'bin', 'node');
    fs.mkdirSync(path.dirname(shared), { recursive: true });
    fs.writeFileSync(shared, '');
    const onShared = createHarness({}, { currentNodePath: shared, currentNodeVersion: '22.99.0' });
    assert.equal((await runNodeUpkeep(onShared.deps)).step, 'stay');
    assert.equal(onShared.runs(), 0);
    const own = writeNode('v22.99.0');
    const current = createHarness({ stdout: `${own}\n` }, { currentNodePath: own, currentNodeVersion: '22.99.0' });
    assert.equal((await runNodeUpkeep(current.deps)).step, 'stay');
    assert.deepEqual(current.said, []);
  });

  it('is skipped altogether for a flow\'s runner that is told to keep the Node it has', async () => {
    const harness = createHarness({ stdout: `${writeNode('v24.22.2')}\n` }, { environment: { [testKeepNodeEnvName]: '1' } });
    assert.equal((await runNodeUpkeep(harness.deps)).step, 'stay');
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

describe('removing old versions', () => {
  interface PruneRun { removed: string[]; logs: string[]; pueueAsked: number }

  async function prune(options: { current?: string[]; nowMs: number; isPueueBusy?: boolean }): Promise<PruneRun> {
    const logs: string[] = [];
    let pueueAsked = 0;
    const removed = await pruneOwnNodes(paths, options.current ?? [], {
      now: () => options.nowMs,
      log: (line) => { logs.push(line); },
      checkIsPueueBusy: async () => { pueueAsked += 1; return options.isPueueBusy ?? false; },
    });
    return { removed, logs, pueueAsked };
  }
  const folderOf = (nodePath: string): string => path.dirname(path.dirname(nodePath));
  const readStamps = (): Record<string, number> => JSON.parse(fs.readFileSync(paths.nodeCurrent, 'utf8')).lastCurrentMs;

  it('stamps what is current and what it sees for the first time, and removes an old version only a week after the stamp — not a day, not six days', async () => {
    const current = writeNode('v22.23.4');
    const old = writeNode('v22.20.0');
    const t0 = 50 * dayMs;
    assert.deepEqual((await prune({ current: [folderOf(current)], nowMs: t0 })).removed, [], 'seen for the first time: its week starts now');
    assert.deepEqual(readStamps(), { 'v22.23.4': t0, 'v22.20.0': t0 });
    assert.deepEqual((await prune({ current: [folderOf(current)], nowMs: t0 + dayMs })).removed, []);
    assert.deepEqual((await prune({ current: [folderOf(current)], nowMs: t0 + 6 * dayMs })).removed, [], 'six days');
    assert.equal(nodeVersionGraceMs, 7 * dayMs);
    const week = await prune({ current: [folderOf(current)], nowMs: t0 + 7 * dayMs });
    assert.deepEqual(week.removed, ['v22.20.0']);
    assert.equal(fs.existsSync(folderOf(old)), false);
    assert.equal(fs.existsSync(folderOf(current)), true);
    assert.deepEqual(readStamps(), { 'v22.23.4': t0 + 7 * dayMs }, 'the record forgets what is gone');
  });

  it('a version that is current again is stamped again — its week is counted from when it stopped being current, not from when it was first seen', async () => {
    const [a, b] = [writeNode('v22.20.0'), writeNode('v22.23.4')];
    const t0 = 10 * dayMs;
    await prune({ current: [folderOf(a)], nowMs: t0 });
    await prune({ current: [folderOf(b)], nowMs: t0 + 3 * dayMs });
    await prune({ current: [folderOf(a)], nowMs: t0 + 6 * dayMs });
    assert.deepEqual((await prune({ current: [folderOf(a)], nowMs: t0 + 9 * dayMs + 1 })).removed, [], 'b stopped being current at day 6: day 9 is three days after');
    assert.deepEqual((await prune({ current: [folderOf(a)], nowMs: t0 + 13 * dayMs })).removed, ['v22.23.4']);
  });

  it('keeps a version a week old while Pueue has a running or queued task — and asks Pueue only when something is old enough to go', async () => {
    const current = writeNode('v22.23.4');
    const old = writeNode('v22.20.0');
    const t0 = 20 * dayMs;
    const young = await prune({ current: [folderOf(current)], nowMs: t0, isPueueBusy: true });
    assert.equal(young.pueueAsked, 0, 'nothing is old enough: Pueue is not even asked');
    const busy = await prune({ current: [folderOf(current)], nowMs: t0 + 8 * dayMs, isPueueBusy: true });
    assert.deepEqual(busy.removed, []);
    assert.equal(busy.pueueAsked, 1);
    assert.match(busy.logs.join('\n'), /keeps 22\.20\.0: Node\.js version\(s\) the runner left more than 7 days ago, while Pueue still has a running or queued task/);
    assert.equal(fs.existsSync(folderOf(old)), true);
    const idle = await prune({ current: [folderOf(current)], nowMs: t0 + 8 * dayMs + 1, isPueueBusy: false });
    assert.deepEqual(idle.removed, ['v22.20.0']);
  });

  it('does not look at processes at all: a process started through the PATH (`env node …` — on macOS `ps` shows just `node`) on a version the runner left a day ago keeps it', async (context) => {
    const current = writeNode('v22.23.4');
    const oldNode = writeNode('v22.20.0');
    // A shell is one binary that runs from wherever it is copied to; the job reaches it as `node` through its PATH, not by an absolute path.
    try {
      fs.copyFileSync(fs.realpathSync('/bin/sh'), oldNode);
    } catch {
      context.skip('this shell cannot be copied here');
    }
    fs.chmodSync(oldNode, 0o755);
    const job = spawn('env', ['node', '-c', 'sleep 30'], { stdio: 'ignore', env: { PATH: `${path.dirname(oldNode)}:/usr/bin:/bin` } });
    try {
      const t0 = 30 * dayMs;
      await prune({ current: [folderOf(oldNode)], nowMs: t0 });
      const afterOneDay = await prune({ current: [folderOf(current)], nowMs: t0 + dayMs });
      assert.deepEqual(afterOneDay.removed, []);
      assert.equal(fs.existsSync(oldNode), true, 'the Node the job runs on is still there');
      assert.equal((await prune({ current: [folderOf(current)], nowMs: t0 + 8 * dayMs, isPueueBusy: true })).removed.length, 0, 'and after a week, with the job queued in Pueue');
    } finally {
      job.kill('SIGKILL');
    }
  });

  it('removes the work folder of an install that was killed (older than an hour) at any time — Pueue or not — and leaves one that is in progress', async () => {
    const stale = path.join(paths.ownNodeDir, '.install.AbCdEf12');
    const fresh = path.join(paths.ownNodeDir, '.install.ZyXwVu98');
    for (const folder of [stale, fresh]) fs.mkdirSync(folder, { recursive: true });
    const now = Date.now();
    fs.utimesSync(stale, new Date(now - 2 * hour), new Date(now - 2 * hour));
    const result = await prune({ nowMs: now, isPueueBusy: true });
    assert.deepEqual(result.removed, ['.install.AbCdEf12']);
    assert.equal(fs.existsSync(fresh), true);
  });

  it('never touches a folder that is not a version, and takes a missing Node folder for nothing to do', async () => {
    fs.mkdirSync(path.join(paths.ownNodeDir, 'notes'), { recursive: true });
    assert.deepEqual((await prune({ nowMs: 100 * dayMs })).removed, []);
    assert.deepEqual((await prune({ nowMs: 200 * dayMs })).removed, []);
    assert.equal(fs.existsSync(path.join(paths.ownNodeDir, 'notes')), true);
    fs.rmSync(paths.ownNodeDir, { recursive: true });
    assert.deepEqual((await prune({ nowMs: 0 })).removed, []);
  });

  it('is part of every look: the Node that runs, the one the launcher names and the new one are stamped as current, so it is the OLD ones that age and go a week later', async () => {
    const old = writeNode('v22.20.0');
    const running = writeNode('v22.30.0');
    const next = writeNode('v22.31.0');
    ensureLauncher(paths, running);
    const leaving = createHarness({ stdout: `${next}\n` }, { currentNodePath: running, currentNodeVersion: '22.30.0' });
    assert.equal((await runNodeUpkeep(leaving.deps)).step, 'restart');
    assert.deepEqual(Object.keys(readStamps()).sort(), ['v22.20.0', 'v22.30.0', 'v22.31.0']);
    assert.equal(fs.existsSync(folderOf(old)), true, 'first seen: its week starts');
    // After the restart the link runs on the new one; a week later the two older releases go.
    const afterRestart = createHarness({ stdout: `${next}\n` }, { currentNodePath: next, currentNodeVersion: '22.31.0' });
    afterRestart.setNow(leaving.getNow() + 8 * dayMs);
    assert.equal((await runNodeUpkeep(afterRestart.deps)).step, 'stay');
    assert.equal(fs.existsSync(folderOf(old)), false);
    assert.equal(fs.existsSync(folderOf(running)), false, 'the release the link left');
    assert.equal(fs.existsSync(folderOf(next)), true);
  });
});

describe('Pueue as the idle restart and the pruning see it', () => {
  function createRunner(answer: Partial<CommandResult>): CommandRunner {
    return async () => ({ ok: true, exitCode: 0, stdout: '', stderr: '', isTimedOut: false, ...answer });
  }
  const tasks = (statuses: Array<string | object>): string => JSON.stringify({ tasks: Object.fromEntries(statuses.map((status, index) => [String(index), { status }])) });

  it('is busy for a running, paused, queued or locked task — a queued one too: it starts the moment a slot frees —, idle for finished ones or none, and idle when no daemon answers', async () => {
    for (const status of [{ Running: { start: 1 } }, 'Queued', 'Paused', 'Locked']) {
      assert.equal(await createPueueBusyCheck(paths, createRunner({ stdout: tasks([status]) }))(), true, JSON.stringify(status));
    }
    assert.equal(await createPueueBusyCheck(paths, createRunner({ stdout: tasks([{ Done: { result: 'Success' } }, 'Stashed']) }))(), false, 'a finished task and one that waits for a person');
    assert.equal(await createPueueBusyCheck(paths, createRunner({ stdout: tasks([]) }))(), false);
    assert.equal(await createPueueBusyCheck(paths, createRunner({ ok: false, exitCode: 1 }))(), false, 'no daemon: no task');
  });

  it('is busy when its answer cannot be read — an unknown is not "nothing is running"', async () => {
    assert.equal(await createPueueBusyCheck(paths, createRunner({ stdout: 'not json' }))(), true);
  });
});

describe('leaving only when nothing is under way', () => {
  it('asks the cheap questions first: a command over the link or an update being installed is busy without asking Pueue', async () => {
    let pueueAsked = 0;
    const checkIsPueueBusy = async (): Promise<boolean> => { pueueAsked += 1; return false; };
    assert.equal(await checkIsLinkIdle({ getActiveExecCount: () => 1, isUpdating: () => false, checkIsPueueBusy }), false);
    assert.equal(await checkIsLinkIdle({ getActiveExecCount: () => 0, isUpdating: () => true, checkIsPueueBusy }), false);
    assert.equal(pueueAsked, 0);
    assert.equal(await checkIsLinkIdle({ getActiveExecCount: () => 0, isUpdating: () => false, checkIsPueueBusy }), true);
    assert.equal(pueueAsked, 1);
    assert.equal(await checkIsLinkIdle({ getActiveExecCount: () => 0, isUpdating: () => false, checkIsPueueBusy: async () => true }), false, 'a Pueue task running or queued');
  });

  /** A timer the test fires itself. */
  function createManualTimers(): { setTimer: (callback: () => void, ms: number) => { clear: () => void }; fire: () => void; pending: () => number; delays: number[] } {
    const callbacks = new Map<number, () => void>();
    const delays: number[] = [];
    let nextId = 0;
    return {
      setTimer: (callback, ms) => {
        const id = nextId;
        nextId += 1;
        callbacks.set(id, callback);
        delays.push(ms);
        return { clear: () => { callbacks.delete(id); } };
      },
      fire: () => {
        const [first] = [...callbacks.entries()];
        if (first === undefined) throw new Error('no timer is pending');
        callbacks.delete(first[0]);
        first[1]();
      },
      pending: () => callbacks.size,
      delays,
    };
  }
  const settle = async (): Promise<void> => { await new Promise((resolve) => { setImmediate(resolve); }); };

  it('leaves at once when asked while nothing is under way; waits while something is — looking again on a change and on a timer — and leaves once', async () => {
    let busy = true;
    let leaves = 0;
    const timers = createManualTimers();
    const restart = createIdleRestart({ checkIsIdle: async () => !busy, leave: () => { leaves += 1; }, pollMs: 15_000, setTimer: timers.setTimer });
    restart.notifyChange();
    await settle();
    assert.equal(leaves, 0, 'nothing was asked for');
    assert.equal(restart.isRequested(), false);
    restart.request();
    await settle();
    assert.equal(restart.isRequested(), true);
    assert.equal(leaves, 0, 'something is under way');
    assert.deepEqual(timers.delays, [15_000], 'it looks again later: a Pueue task ends without an event');
    timers.fire();
    await settle();
    assert.equal(leaves, 0, 'the timer\'s look found it still busy');
    busy = false;
    restart.notifyChange();
    await settle();
    assert.equal(leaves, 1);
    assert.equal(timers.pending(), 0, 'and nothing is left waiting');
    restart.notifyChange();
    restart.request();
    await settle();
    assert.equal(leaves, 1, 'once');
  });

  it('leaves on the timer alone when nothing tells it of a change (a Pueue task that ends)', async () => {
    let busy = true;
    let leaves = 0;
    const timers = createManualTimers();
    const restart = createIdleRestart({ checkIsIdle: async () => !busy, leave: () => { leaves += 1; }, pollMs: 1000, setTimer: timers.setTimer });
    restart.request();
    await settle();
    busy = false;
    timers.fire();
    await settle();
    assert.equal(leaves, 1);
  });

  it('a check that fails is not idle — it is tried again, never a leave', async () => {
    let leaves = 0;
    const timers = createManualTimers();
    const restart = createIdleRestart({ checkIsIdle: async () => { throw new Error('pueue is gone'); }, leave: () => { leaves += 1; }, pollMs: 1000, setTimer: timers.setTimer });
    restart.request();
    await settle();
    assert.equal(leaves, 0);
    assert.equal(timers.pending(), 1);
  });

  it('a change that arrives while a check is under way is looked at again, not lost', async () => {
    let leaves = 0;
    let calls = 0;
    const gate: { open: (() => void) | null } = { open: null };
    const restart = createIdleRestart({
      checkIsIdle: () => {
        calls += 1;
        if (calls === 1) return new Promise<boolean>((resolve) => { gate.open = () => resolve(false); });
        return Promise.resolve(true);
      },
      leave: () => { leaves += 1; },
      pollMs: 1_000_000,
      setTimer: createManualTimers().setTimer,
    });
    restart.request();
    await settle();
    restart.notifyChange();
    gate.open?.();
    await settle();
    await settle();
    assert.equal(calls, 2);
    assert.equal(leaves, 1);
  });
});
