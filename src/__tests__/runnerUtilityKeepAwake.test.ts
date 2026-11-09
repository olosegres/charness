/**
 * @description `runnerUtility/keepAwake.ts`: while its link runs a runner holds an idle-sleep assertion — `caffeinate -i -t <seconds>` on a Mac,
 * `systemd-inhibit --what=idle … sleep <seconds>` on Linux, else nothing and the state says why. The holder is TIMED and OUTLIVES the link: the link restarts for every
 * update, and a holder that died with it left the Mac with no assertion for a moment — enough for an idle Mac to sleep five seconds later (measured on a real one), after which
 * nothing keeps it reachable. So a restart hands the holder over (the next link starts its own while it still holds), a renewal starts the new holder before the old one is
 * released, and only a stop ends the holder at once. The command lines, the order of starting and releasing and the state file are pinned against stand-ins; on Linux the REAL
 * `systemd-inhibit` is run: the lock shows in its own list, survives a hand-over until the next holder holds, and ends by itself when its time is up. What the real Mac's
 * `caffeinate` does with a closed lid is for the real Mac (docs/remote-run.md).
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describeKeepAwake } from '../runnerUtility/runnerCommands';
import { keepAwakeHoldSeconds } from '../remoteRun/probe';
import {
  checkIsHolderCommand,
  createKeepAwakeDeps,
  findExecutableOnPath,
  formatKeepAwakeState,
  parseHolderPid,
  planKeepAwake,
  renewEveryMs,
  startKeepAwake,
  type KeepAwakeDeps,
} from '../runnerUtility/keepAwake';
import { getRunnerHomePaths } from '../runnerUtility/runnerHome';
import { checkIsProcessAlive } from '../runnerUtility/guiAgent';

const holdSeconds = 300;

describe('planKeepAwake', () => {
  it('a Mac: `caffeinate -i -t <seconds>` — idle sleep only, never `-s`/`-d`, and NOT tied to the link (`-w`): it must outlive a restart — and nothing when caffeinate is not there', () => {
    assert.deepEqual(planKeepAwake('darwin', holdSeconds, (name) => `/usr/bin/${name}`), { method: 'caffeinate', file: '/usr/bin/caffeinate', args: ['-i', '-t', '300'] });
    assert.deepEqual(planKeepAwake('darwin', holdSeconds, () => null), { reason: 'caffeinate was not found on this Mac' });
  });

  it('Linux: `systemd-inhibit --what=idle --mode=block` around a `sleep` of that many seconds — and nothing without systemd-inhibit', () => {
    const plan = planKeepAwake('linux', holdSeconds, (name) => `/usr/bin/${name}`);
    assert.ok('method' in plan && plan.method === 'systemd-inhibit' && plan.file === '/usr/bin/systemd-inhibit');
    assert.deepEqual('args' in plan ? plan.args : [], ['--what=idle', '--who=charness-runner', '--why=the runner link is up', '--mode=block', 'sleep', '300']);
    assert.match('reason' in planKeepAwake('linux', holdSeconds, () => null) ? (planKeepAwake('linux', holdSeconds, () => null) as { reason: string }).reason : '', /systemd-inhibit was not found/);
  });

  it('the seconds are the lifetime the link asks for, and the shared constant is five minutes', () => {
    assert.deepEqual(planKeepAwake('darwin', 7, (name) => name), { method: 'caffeinate', file: 'caffeinate', args: ['-i', '-t', '7'] });
    assert.equal(keepAwakeHoldSeconds, 300);
    assert.ok(renewEveryMs * 4 <= keepAwakeHoldSeconds * 1000, 'a renewal that fails is tried again several times before the old holder runs out');
  });

  it('never an admin power setting: no plan names pmset, sudo or a power-management command', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const plan = planKeepAwake(platform, holdSeconds, (name) => `/usr/bin/${name}`);
      assert.ok('args' in plan);
      assert.doesNotMatch([plan.file, ...plan.args].join(' '), /pmset|sudo|systemctl|mask|sleep\.target|hibernate/);
    }
  });

  it('another system has none, and says so', () => {
    assert.deepEqual(planKeepAwake('win32', holdSeconds, () => '/x'), { reason: 'keeping the machine awake is not supported on win32' });
  });
});

describe('the state line', () => {
  it('is `<method> <pid>` or `none <reason>`, the reason one cut-short line', () => {
    assert.equal(formatKeepAwakeState({ method: 'caffeinate', holderPid: 77 }), 'caffeinate 77\n');
    assert.equal(formatKeepAwakeState({ method: 'systemd-inhibit', holderPid: 78 }), 'systemd-inhibit 78\n');
    assert.equal(formatKeepAwakeState({ method: null, reason: 'Failed to connect\nto bus:   no such file' }), 'none Failed to connect to bus: no such file\n');
    assert.ok(formatKeepAwakeState({ method: null, reason: 'x'.repeat(1000) }).length <= 'none '.length + 200 + 1);
  });

  it('is what the link tells at its start: how, and that a closed lid still sleeps it — or that it is NOT kept awake and why', () => {
    assert.equal(describeKeepAwake({ method: 'caffeinate', holderPid: 1 }), 'charness-runner: keeping this machine awake while the link runs (caffeinate -i; a closed lid still sleeps it)');
    assert.match(describeKeepAwake({ method: 'systemd-inhibit', holderPid: 1 }), /systemd-inhibit --what=idle/);
    assert.equal(describeKeepAwake({ method: null, reason: 'no bus' }), 'charness-runner: this machine is NOT kept awake while the link runs (no bus) — it may sleep when idle');
  });
});

describe('findExecutableOnPath', () => {
  it('the first folder of the PATH that has it, empty parts skipped', () => {
    const present = new Set(['/b/tool', '/c/tool']);
    assert.equal(findExecutableOnPath('tool', `/a::/b:/c`, (candidate) => present.has(candidate)), '/b/tool');
    assert.equal(findExecutableOnPath('tool', '/a:/d', (candidate) => present.has(candidate)), null);
  });
});

interface FakeHolder extends EventEmitter {
  pid: number | undefined;
  stderr: EventEmitter & { destroy: () => void };
  killed: NodeJS.Signals[];
  isReleased: boolean;
  kill: (signal: NodeJS.Signals) => boolean;
  unref: () => void;
}

/** Everything the keep-awake did to the world, in the order it did it: what makes «the new holder holds BEFORE the old one goes» checkable. */
let events: string[] = [];

function createFakeHolder(pid: number | undefined = 9001): FakeHolder {
  const holder = new EventEmitter() as FakeHolder;
  holder.pid = pid;
  const stderr = new EventEmitter() as FakeHolder['stderr'];
  stderr.destroy = () => { holder.isReleased = true; };
  holder.stderr = stderr;
  holder.killed = [];
  holder.isReleased = false;
  holder.kill = (signal) => { holder.killed.push(signal); events.push(`kill ${pid}`); return true; };
  holder.unref = () => { events.push(`unref ${pid}`); };
  return holder;
}

describe('startKeepAwake with a stand-in holder', () => {
  let written: string[] = [];
  let removed = 0;
  let spawned: Array<{ file: string; args: readonly string[] }> = [];
  let holders: FakeHolder[] = [];
  let behave: (holder: FakeHolder, index: number) => void = () => undefined;
  /** The holder the state file names when the link starts: the previous link's, left running by its hand-over. */
  let predecessorPid: number | null = null;
  const renewMs = 50;
  const retryMs = 40;
  const settleMs = 30;

  beforeEach(() => {
    written = [];
    removed = 0;
    spawned = [];
    holders = [];
    events = [];
    behave = () => undefined;
    predecessorPid = null;
  });

  function createDeps(overrides: Partial<KeepAwakeDeps> = {}): KeepAwakeDeps {
    return {
      platform: 'darwin',
      holdSeconds,
      renewMs: 60_000,
      findExecutable: (name) => `/usr/bin/${name}`,
      spawnHolder: (file, args) => {
        spawned.push({ file, args });
        const index = holders.length;
        const holder = createFakeHolder(9000 + index + 1);
        holders.push(holder);
        events.push(`spawn ${holder.pid}`);
        // A microtask: the holder's listeners are attached in the same synchronous run that spawned it, so this is after them — and, unlike a timer, not a race with the settle time on a loaded box.
        queueMicrotask(() => { behave(holder, index); });
        return holder as unknown as ChildProcess;
      },
      settleMs,
      retryMs,
      writeState: (line) => { written.push(line); events.push(`state ${line.trim()}`); },
      removeState: () => { removed += 1; events.push('state removed'); },
      readPredecessorPid: () => predecessorPid,
      endPredecessor: (pid) => { events.push(`end predecessor ${pid}`); },
      ...overrides,
    };
  }

  async function waitUntilThat(description: string, check: () => boolean, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(check(), `${description} did not happen within ${timeoutMs} ms`);
  }

  it('a holder that stays up: the state is the method and the holder\'s pid, written once; the command is the plan\'s', async () => {
    const keepAwake = await startKeepAwake(createDeps());
    assert.deepEqual(keepAwake.getState(), { method: 'caffeinate', holderPid: 9001 });
    assert.deepEqual(written, ['caffeinate 9001\n']);
    assert.deepEqual(spawned, [{ file: '/usr/bin/caffeinate', args: ['-i', '-t', '300'] }]);
    keepAwake.stop();
  });

  it('a holder that ends at once (no bus for systemd-inhibit) is no lock: «none», with what it said', async () => {
    behave = (holder) => { holder.stderr.emit('data', Buffer.from('Failed to connect to bus: No such file or directory\n')); holder.emit('exit', 1, null); };
    const keepAwake = await startKeepAwake(createDeps({ platform: 'linux' }));
    assert.deepEqual(keepAwake.getState(), { method: null, reason: 'systemd-inhibit ended at once (Failed to connect to bus: No such file or directory)' });
    assert.equal(written.at(-1), 'none systemd-inhibit ended at once (Failed to connect to bus: No such file or directory)\n');
    keepAwake.stop();
  });

  it('a holder that cannot be started, or has no pid, is «none» too — never an exception, the link comes up all the same', async () => {
    behave = (holder) => { holder.emit('error', new Error('spawn caffeinate ENOENT')); };
    const failed = await startKeepAwake(createDeps());
    assert.deepEqual(failed.getState(), { method: null, reason: 'caffeinate ended at once (spawn caffeinate ENOENT)' });
    failed.stop();
    const thrown = await startKeepAwake(createDeps({ spawnHolder: () => { throw new Error('EACCES'); } }));
    assert.deepEqual(thrown.getState(), { method: null, reason: 'caffeinate could not be started (EACCES)' });
    thrown.stop();
  });

  it('nothing to hold with (no tool, another system): «none» with the plan\'s reason, nothing spawned', async () => {
    const keepAwake = await startKeepAwake(createDeps({ findExecutable: () => null }));
    assert.deepEqual(keepAwake.getState(), { method: null, reason: 'caffeinate was not found on this Mac' });
    assert.deepEqual(spawned, []);
    keepAwake.stop();
  });

  it('a holder that ends while the link runs is noted at once and replaced after the retry time', async () => {
    const keepAwake = await startKeepAwake(createDeps());
    holders[0].emit('exit', null, 'SIGKILL');
    assert.deepEqual(keepAwake.getState(), { method: null, reason: 'the caffeinate process ended while the link runs (SIGKILL); trying again' });
    await waitUntilThat('the replacement holder', () => keepAwake.getState().method !== null);
    assert.deepEqual(keepAwake.getState(), { method: 'caffeinate', holderPid: 9002 });
    assert.equal(written.at(-1), 'caffeinate 9002\n');
    keepAwake.stop();
  });

  it('stop ends the holder, forgets the state and makes no new holder — also called twice, and while a retry is pending', async () => {
    const keepAwake = await startKeepAwake(createDeps());
    holders[0].emit('exit', 1, null);
    keepAwake.stop();
    keepAwake.stop();
    assert.equal(removed, 1);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(holders.length, 1, 'no retry after a stop');

    const running = await startKeepAwake(createDeps());
    running.stop();
    assert.deepEqual(holders.at(-1)?.killed, ['SIGTERM']);
    assert.equal(removed, 2);
  });

  it('a stop while the first attempt is still settling ends that holder too — it never outlives a STOPPED link', async () => {
    const pending = startKeepAwake(createDeps({ settleMs: 80 }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The stop of a link that is going down before the assertion has settled: the handle only exists after the promise, so the process-exit path is the caller's
    // (`process.once('exit', …)`); here the holder is ended once it is known.
    const keepAwake = await pending;
    keepAwake.stop();
    assert.deepEqual(holders[0].killed, ['SIGTERM']);
  });

  describe('renewal and hand-over: the machine is never left with no holder', () => {
    it('a renewal starts the NEW holder, writes its pid, and only then ends the old one — in that order, never a moment with none', async () => {
      const keepAwake = await startKeepAwake(createDeps({ renewMs }));
      await waitUntilThat('the renewal', () => holders.length >= 2 && holders[0].killed.length === 1);
      assert.deepEqual(events.slice(0, 5), ['spawn 9001', 'state caffeinate 9001', 'spawn 9002', 'state caffeinate 9002', 'kill 9001']);
      assert.deepEqual(keepAwake.getState(), { method: 'caffeinate', holderPid: 9002 });
      assert.deepEqual(holders[0].killed, ['SIGTERM']);
      assert.equal(written.some((line) => line.startsWith('none')), false, 'the old holder being ended by the renewal is not «ended while the link runs»');
      keepAwake.stop();
    });

    it('a renewal that fails (cannot be started, or ends at once) leaves the old holder and the state alone, and is tried again', async () => {
      let failures = 2;
      behave = (holder, index) => {
        if (index >= 1 && failures > 0) { failures -= 1; holder.emit('exit', 1, null); }
      };
      const keepAwake = await startKeepAwake(createDeps({ renewMs }));
      await waitUntilThat('the renewal that finally works', () => holders.length >= 4 && holders[0].killed.length === 1);
      assert.deepEqual(holders.slice(0, 3).map((holder) => holder.killed.length), [1, 0, 0], 'the old holder was ended only once a new one held — not by the failed renewals');
      assert.equal(written.some((line) => line.startsWith('none')), false, 'the failed renewals never said «not kept awake»: the old holder still held');
      assert.deepEqual(keepAwake.getState(), { method: 'caffeinate', holderPid: 9004 });
      keepAwake.stop();

      events = [];
      const throwing = await startKeepAwake(createDeps({ renewMs, spawnHolder: (() => { let calls = 0; return (file: string, args: readonly string[]) => { calls += 1; if (calls === 2) throw new Error('EAGAIN'); spawned.push({ file, args }); const holder = createFakeHolder(9100 + calls); holders.push(holder); return holder as unknown as ChildProcess; }; })() }));
      await waitUntilThat('the retry after a spawn that threw', () => { const state = throwing.getState(); return state.method === 'caffeinate' && state.holderPid !== 9101; });
      throwing.stop();
    });

    it('a hand-over does NOT end the holder or remove the state — it runs out by itself — and makes no new holder, however long the link lingers', async () => {
      const keepAwake = await startKeepAwake(createDeps({ renewMs }));
      keepAwake.handOver();
      keepAwake.handOver();
      keepAwake.stop();
      await new Promise((resolve) => setTimeout(resolve, renewMs * 4));
      assert.equal(holders.length, 1, 'no renewal after a hand-over');
      assert.deepEqual(holders[0].killed, [], 'the holder is left running: that is the bridge over the restart');
      assert.equal(removed, 0, 'the state file stays: it names the holder that is still there');
      assert.equal(holders[0].isReleased, true, 'the link no longer waits on the holder (its stderr is let go and it is unref\'d), so it can leave');
      assert.ok(events.includes('unref 9001'));
    });

    it('a hand-over while a renewal is still settling leaves BOTH holders running — the new one is let go too, nothing is killed', async () => {
      const keepAwake = await startKeepAwake(createDeps({ renewMs: 10, settleMs: 80 }));
      await waitUntilThat('the renewal to be spawned', () => holders.length === 2);
      keepAwake.handOver();
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.deepEqual(holders.map((holder) => holder.killed.length), [0, 0]);
      assert.equal(holders[1].isReleased, true, 'the late holder is let go as well');
      assert.equal(holders.length, 2, 'and none is started after it');
      assert.equal(removed, 0);
    });

    it('a stop while a renewal is still settling ends BOTH holders and forgets the state', async () => {
      const keepAwake = await startKeepAwake(createDeps({ renewMs: 10, settleMs: 80 }));
      await waitUntilThat('the renewal to be spawned', () => holders.length === 2);
      keepAwake.stop();
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.deepEqual(holders.map((holder) => holder.killed), [['SIGTERM'], ['SIGTERM']]);
      assert.equal(removed, 1);
      assert.equal(holders.length, 2);
    });

    it('the next link\'s holder takes over while the old link\'s still holds: a restart is two instances, the second started before the first one\'s time is up', async () => {
      const first = await startKeepAwake(createDeps());
      first.handOver();
      const second = await startKeepAwake(createDeps());
      assert.deepEqual(holders.map((holder) => holder.killed), [[], []], 'the new link did not end the old holder: it is not its to end, and it still holds');
      assert.deepEqual(events.filter((event) => event.startsWith('spawn') || event.startsWith('kill')), ['spawn 9001', 'spawn 9002']);
      assert.deepEqual(second.getState(), { method: 'caffeinate', holderPid: 9002 });
      second.stop();
    });

    it('the holder the previous link left is ended ONCE this link\'s holds — after its pid is written, never before — so there is one holder per machine', async () => {
      predecessorPid = 4321;
      const keepAwake = await startKeepAwake(createDeps({ renewMs: 20 }));
      await waitUntilThat('a renewal to be done (its new holder holds and the first is let go)', () => holders.length >= 2 && holders[0].killed.length === 1);
      assert.deepEqual(events.slice(0, 3), ['spawn 9001', 'state caffeinate 9001', 'end predecessor 4321'], 'the new holder holds and is on record before the old link\'s goes');
      assert.equal(events.filter((event) => event.startsWith('end predecessor')).length, 1, 'once: a renewal does not end it again');
      keepAwake.stop();
    });

    it('while no holder of this link holds yet (the first one failed) the previous link\'s is kept — it is the only one — and is ended when a retry holds', async () => {
      predecessorPid = 4321;
      behave = (holder, index) => { if (index === 0) holder.emit('exit', 1, null); };
      const keepAwake = await startKeepAwake(createDeps());
      assert.equal(keepAwake.getState().method, null);
      assert.ok(!events.some((event) => event.startsWith('end predecessor')), 'nothing was ended while this link held nothing');
      await waitUntilThat('the retry that holds', () => keepAwake.getState().method === 'caffeinate');
      assert.ok(events.includes('end predecessor 4321'));
      assert.ok(events.indexOf('state caffeinate 9002') < events.indexOf('end predecessor 4321'));
      keepAwake.stop();
    });

    it('no predecessor (a first start, a stop, a state of «none»), or the very pid this link just started: nothing is ended', async () => {
      const first = await startKeepAwake(createDeps());
      first.stop();
      predecessorPid = 9001;
      holders = [];
      const same = await startKeepAwake(createDeps());
      same.stop();
      assert.ok(!events.some((event) => event.startsWith('end predecessor')), JSON.stringify(events));
    });

    it('a stop right after the start still ends this link\'s own holder, and the predecessor was ended already: nothing of the previous link survives a stop', async () => {
      predecessorPid = 4321;
      const keepAwake = await startKeepAwake(createDeps());
      keepAwake.stop();
      assert.ok(events.includes('end predecessor 4321'));
      assert.deepEqual(holders[0].killed, ['SIGTERM']);
    });
  });
});

describe('the previous link\'s holder, from the state file', () => {
  it('parseHolderPid reads `<method> <pid>` and nothing else: «none», a damaged or absurd pid, another word, nothing', () => {
    assert.equal(parseHolderPid('caffeinate 123\n'), 123);
    assert.equal(parseHolderPid('systemd-inhibit 4567'), 4567);
    for (const text of ['', 'none no bus\n', 'caffeinate\n', 'caffeinate 12x', 'caffeinate -5', 'caffeinate 0', 'caffeinate 1', 'sleep 123', 'caffeinate 99999999999999999999']) assert.equal(parseHolderPid(text), null, JSON.stringify(text));
  });

  it('checkIsHolderCommand knows a holder of THIS runner — however it was launched — and nothing else that a recorded pid may have become (a job\'s own caffeinate, another tool\'s lock, any process)', () => {
    for (const command of [
      'caffeinate -i -t 300',
      '/usr/bin/caffeinate -i -t 7\n',
      '/usr/bin/systemd-inhibit --what=idle --who=charness-runner --why=the runner link is up --mode=block sleep 300',
      '/bin/sh /tmp/stand-in/bin/systemd-inhibit --what=idle --who=charness-runner --why=the runner link is up --mode=block sleep 300',
    ]) assert.equal(checkIsHolderCommand(command), true, command);
    for (const command of [
      'caffeinate -i -w 4242', // what a job's own command gets (`runner.sh`)
      'caffeinate -d -t 300',
      'caffeinate -i -t 300 make',
      '/usr/bin/systemd-inhibit --what=idle --who=someone-else --why=x --mode=block sleep 300',
      'sleep 300',
      'node /app/dist/runnerUtility/runnerCli.js run',
      '',
    ]) assert.equal(checkIsHolderCommand(command), false, command);
  });
});

/** The `--why` of the lock the runner's link takes (`keepAwake.ts`). */
const lockReason = 'the runner link is up';

const hasWorkingSystemdInhibit = process.platform === 'linux' && spawnSync('systemd-inhibit', ['--what=idle', '--why=test', '--mode=block', 'true']).status === 0;

describe('the real systemd-inhibit', { skip: hasWorkingSystemdInhibit ? false : 'no working systemd-inhibit here' }, () => {
  let root = '';
  let decoyHolder: ChildProcess | null = null;
  /** Holders a test left running on purpose (a hand-over leaves one): ended by the test's teardown, they would otherwise hold a lock for minutes. */
  const leftHolders: number[] = [];

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keep-awake-')));
  });
  afterEach(() => {
    for (const pid of leftHolders.splice(0)) if (checkIsProcessAlive(pid)) process.kill(pid, 'SIGKILL');
    if (decoyHolder !== null && decoyHolder.pid !== undefined && checkIsProcessAlive(decoyHolder.pid)) decoyHolder.kill('SIGKILL');
    decoyHolder = null;
    fs.rmSync(root, { recursive: true, force: true });
  });

  function listLocks(): string {
    return spawnSync('systemd-inhibit', ['--list', '--no-pager'], { encoding: 'utf8' }).stdout;
  }

  /**
   * The lines of systemd's list that are the lock of process `holderPid` (its PID column). Never "any lock with this text": another process on the box (a runner of another account, a test of
   * another checkout) may hold a lock with the very same who and why, and a check that took it for ours failed whenever one came or went between two looks.
   */
  function listLocksOfHolder(holderPid: number): string[] {
    const pidColumn = new RegExp(`\\s${holderPid}\\s`);
    return listLocks().split('\n').filter((line) => line.includes(lockReason) && pidColumn.test(line));
  }

  async function waitUntil(description: string, check: () => boolean, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(check(), `${description} did not happen within ${timeoutMs} ms`);
  }

  function createRealDeps(overrides: Partial<KeepAwakeDeps> = {}): { deps: KeepAwakeDeps; awakeFile: string } {
    const paths = getRunnerHomePaths(path.join(root, 'home'));
    fs.mkdirSync(paths.root, { recursive: true });
    return { deps: { ...createKeepAwakeDeps(paths), ...overrides }, awakeFile: paths.awakeFile };
  }

  function getHolderPid(state: ReturnType<Awaited<ReturnType<typeof startKeepAwake>>['getState']>): number {
    assert.equal(state.method, 'systemd-inhibit', JSON.stringify(state));
    return state.method === null ? 0 : state.holderPid;
  }

  it('the lock shows in systemd\'s own list while the link lives, and a stop removes the state file and ends the holder and its lock at once', async () => {
    const { deps, awakeFile } = createRealDeps();
    const keepAwake = await startKeepAwake(deps);
    const holderPid = getHolderPid(keepAwake.getState());
    assert.equal(fs.readFileSync(awakeFile, 'utf8'), `systemd-inhibit ${holderPid}\n`);
    assert.equal(listLocksOfHolder(holderPid).length, 1, 'systemd lists the holder\'s lock');
    assert.match(listLocksOfHolder(holderPid)[0], /charness-runner .*\bidle\b +the runner link is up +block/, 'who, what (idle), why, mode (block)');

    keepAwake.stop();
    assert.equal(fs.existsSync(awakeFile), false);
    await waitUntil('the lock to go', () => listLocksOfHolder(holderPid).length === 0);
    await waitUntil('the holder to be gone', () => !checkIsProcessAlive(holderPid));
  });

  it('a link that is gone without a stop (SIGKILL, a crash) leaves the lock for the holder\'s own time only — it ends by itself, so no orphan keeps the machine awake for long', async () => {
    const { deps } = createRealDeps({ holdSeconds: 2 });
    const keepAwake = await startKeepAwake(deps);
    const holderPid = getHolderPid(keepAwake.getState());
    leftHolders.push(holderPid);
    keepAwake.handOver();
    assert.equal(checkIsProcessAlive(holderPid), true, 'the holder outlives the link');
    assert.equal(listLocksOfHolder(holderPid).length, 1, 'and its lock is listed');
    await waitUntil('the holder to end by itself', () => !checkIsProcessAlive(holderPid));
    assert.equal(listLocksOfHolder(holderPid).length, 0, 'with its lock');
  });

  /**
   * Start a link after `previousEnd` ended the previous one's way, and say whether the previous link's lock was still listed at the very instant this link's holder was RECORDED in the state file (`writeState`, which
   * comes before the predecessor is ended).
   */
  async function startNextLink(setUp: ReturnType<typeof createRealDeps>, oldHolder: number): Promise<{ isOldLockListedAtRecording: boolean | null; next: Awaited<ReturnType<typeof startKeepAwake>> }> {
    const seen: { isOldLockListedAtRecording: boolean | null } = { isOldLockListedAtRecording: null };
    const next = await startKeepAwake({
      ...setUp.deps,
      writeState: (line) => {
        if (!line.includes(`${oldHolder}`) && seen.isOldLockListedAtRecording === null) seen.isOldLockListedAtRecording = listLocksOfHolder(oldHolder).length === 1;
        setUp.deps.writeState(line);
      },
    });
    return { isOldLockListedAtRecording: seen.isOldLockListedAtRecording, next };
  }

  it('a restart of the link: the old holder\'s lock is still listed when the next link\'s holder is recorded — and with a STOP in between (what a link tied holder did) it is already gone: the gap an idle Mac sleeps in', async () => {
    const handOver = createRealDeps();
    const before = await startKeepAwake(handOver.deps);
    const oldHolder = getHolderPid(before.getState());
    leftHolders.push(oldHolder);
    before.handOver();
    const { isOldLockListedAtRecording, next: after } = await startNextLink(handOver, oldHolder);
    const newHolder = getHolderPid(after.getState());
    leftHolders.push(newHolder);
    assert.notEqual(newHolder, oldHolder);
    assert.equal(isOldLockListedAtRecording, true, 'the old link\'s lock was still there when the new link\'s holder went on record: there was no moment with none');
    assert.equal(listLocksOfHolder(newHolder).length, 1);
    assert.equal(fs.readFileSync(handOver.awakeFile, 'utf8'), `systemd-inhibit ${newHolder}\n`, 'the state names the new holder');

    // The negative control: the same restart, but the old link STOPS (ends its holder at once) — by the time the next holder is recorded the first lock is gone. The check above can tell the two apart.
    const stopped = createRealDeps();
    const stoppedBefore = await startKeepAwake(stopped.deps);
    const stoppedHolder = getHolderPid(stoppedBefore.getState());
    stoppedBefore.stop();
    const { isOldLockListedAtRecording: isStoppedLockListed, next: stoppedAfter } = await startNextLink(stopped, stoppedHolder);
    leftHolders.push(getHolderPid(stoppedAfter.getState()));
    assert.equal(isStoppedLockListed, false, 'after a stop the old lock is gone by the time the next holder is recorded: for that stretch the machine had none');
    after.stop();
    stoppedAfter.stop();
  });

  it('the next link ends the holder the previous one left — only once its own holds — and one the state file names that is NOT a holder (a recycled pid) is left alone', async () => {
    const handOver = createRealDeps();
    const previous = await startKeepAwake(handOver.deps);
    const previousHolder = getHolderPid(previous.getState());
    leftHolders.push(previousHolder);
    previous.handOver();
    assert.equal(checkIsProcessAlive(previousHolder), true);
    const next = await startKeepAwake(handOver.deps);
    const nextHolder = getHolderPid(next.getState());
    leftHolders.push(nextHolder);
    await waitUntil('the previous link\'s holder to be ended by this one', () => !checkIsProcessAlive(previousHolder));
    assert.equal(checkIsProcessAlive(nextHolder), true, 'its own holds');
    assert.equal(listLocksOfHolder(previousHolder).length, 0, 'and the old lock went with it');
    next.stop();

    // A state file that names a process which is not a holder: it is a recycled pid, and it is never signalled.
    const bystander = spawn('sleep', ['120'], { stdio: 'ignore' });
    const bystanderPid = bystander.pid ?? 0;
    try {
      fs.writeFileSync(handOver.awakeFile, `systemd-inhibit ${bystanderPid}\n`);
      const third = await startKeepAwake(handOver.deps);
      leftHolders.push(getHolderPid(third.getState()));
      // Waited a moment: a signalled child is a zombie (still «alive» to `kill -0`) until its parent has reaped it; the child's own exit record is what says it was ended.
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.ok(bystander.exitCode === null && bystander.signalCode === null, `a process that does not look like our holder is not ended (it ended: ${bystander.exitCode ?? bystander.signalCode})`);
      assert.equal(checkIsProcessAlive(bystanderPid), true);
      third.stop();
    } finally {
      bystander.kill('SIGKILL');
    }
  });

  it('a lock with the very same text held by ANOTHER process neither hides this holder\'s lock going nor fails the check — it is not ours', async () => {
    // What another runner on the box looks like to `systemd-inhibit --list`: same who, same why, a pid of its own, and it outlives this test's holder.
    decoyHolder = spawn('systemd-inhibit', ['--what=idle', '--who=charness-runner', `--why=${lockReason}`, '--mode=block', 'sleep', '120'], { stdio: 'ignore' });
    const decoyPid = decoyHolder.pid ?? 0;
    await waitUntil('the decoy\'s lock to show', () => listLocksOfHolder(decoyPid).length === 1);
    const { deps } = createRealDeps();
    const keepAwake = await startKeepAwake(deps);
    const holderPid = getHolderPid(keepAwake.getState());
    assert.notEqual(holderPid, decoyPid);
    assert.equal(listLocksOfHolder(holderPid).length, 1);
    keepAwake.stop();
    await waitUntil('the holder\'s lock to go', () => listLocksOfHolder(holderPid).length === 0);
    await waitUntil('the holder to be gone', () => !checkIsProcessAlive(holderPid));
    assert.equal(listLocksOfHolder(decoyPid).length, 1, 'the other process\'s lock is still listed, with the same text: a check on the text alone would never see this holder\'s lock go');
  });
});
