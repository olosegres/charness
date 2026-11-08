/**
 * @description `runnerUtility/keepAwake.ts`: while its link runs a runner holds an idle-sleep assertion — `caffeinate -i -w <link pid>` on a Mac,
 * `systemd-inhibit --what=idle` on Linux, else nothing and the state says why — tied to the link's process so that no stop, removal, crash or SIGKILL
 * leaves a holder keeping the machine awake. The command lines and the state file are pinned against stand-ins; on Linux the REAL `systemd-inhibit` is
 * run: the lock shows in its own list while a stand-in link lives, and is gone, holder and all, within seconds of that link being SIGKILLed. What
 * `caffeinate -w` does with a closed lid is for the real Mac (docs/remote-run.md).
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
import {
  createKeepAwakeDeps,
  findExecutableOnPath,
  formatKeepAwakeState,
  planKeepAwake,
  startKeepAwake,
  type KeepAwakeDeps,
} from '../runnerUtility/keepAwake';
import { getRunnerHomePaths } from '../runnerUtility/runnerHome';
import { checkIsProcessAlive } from '../runnerUtility/guiAgent';

const linkPid = 4242;

describe('planKeepAwake', () => {
  it('a Mac: `caffeinate -i -w <the link\'s pid>` — idle sleep only, never `-s`/`-d`, tied to the link — and nothing when caffeinate is not there', () => {
    assert.deepEqual(planKeepAwake('darwin', linkPid, (name) => `/usr/bin/${name}`), { method: 'caffeinate', file: '/usr/bin/caffeinate', args: ['-i', '-w', '4242'] });
    assert.deepEqual(planKeepAwake('darwin', linkPid, () => null), { reason: 'caffeinate was not found on this Mac' });
  });

  it('Linux: `systemd-inhibit --what=idle --mode=block` around a loop that lasts as long as the link\'s pid does — and nothing without systemd-inhibit', () => {
    const plan = planKeepAwake('linux', linkPid, (name) => `/usr/bin/${name}`);
    assert.ok('method' in plan && plan.method === 'systemd-inhibit' && plan.file === '/usr/bin/systemd-inhibit');
    assert.deepEqual('args' in plan ? plan.args.slice(0, 4) : [], ['--what=idle', '--who=charness-runner', '--why=the runner link is up', '--mode=block']);
    assert.deepEqual('args' in plan ? plan.args.slice(4) : [], ['sh', '-c', 'while kill -0 "$1" 2> /dev/null; do sleep 2; done', 'sh', '4242']);
    assert.match('reason' in planKeepAwake('linux', linkPid, () => null) ? (planKeepAwake('linux', linkPid, () => null) as { reason: string }).reason : '', /systemd-inhibit was not found/);
  });

  it('never an admin power setting: no plan names pmset, sudo or a power-management command', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const plan = planKeepAwake(platform, linkPid, (name) => `/usr/bin/${name}`);
      assert.ok('args' in plan);
      assert.doesNotMatch([plan.file, ...plan.args].join(' '), /pmset|sudo|systemctl|mask|sleep\.target|hibernate/);
    }
  });

  it('another system has none, and says so', () => {
    assert.deepEqual(planKeepAwake('win32', linkPid, () => '/x'), { reason: 'keeping the machine awake is not supported on win32' });
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
  stderr: EventEmitter;
  killed: NodeJS.Signals[];
  kill: (signal: NodeJS.Signals) => boolean;
}

function createFakeHolder(pid: number | undefined = 9001): FakeHolder {
  const holder = new EventEmitter() as FakeHolder;
  holder.pid = pid;
  holder.stderr = new EventEmitter();
  holder.killed = [];
  holder.kill = (signal) => { holder.killed.push(signal); return true; };
  return holder;
}

describe('startKeepAwake with a stand-in holder', () => {
  let written: string[] = [];
  let removed = 0;
  let spawned: Array<{ file: string; args: readonly string[] }> = [];
  let holders: FakeHolder[] = [];
  let behave: (holder: FakeHolder) => void = () => undefined;

  beforeEach(() => {
    written = [];
    removed = 0;
    spawned = [];
    holders = [];
    behave = () => undefined;
  });

  function createDeps(overrides: Partial<KeepAwakeDeps> = {}): KeepAwakeDeps {
    return {
      platform: 'darwin',
      linkPid,
      findExecutable: (name) => `/usr/bin/${name}`,
      spawnHolder: (file, args) => {
        spawned.push({ file, args });
        const holder = createFakeHolder(9000 + holders.length + 1);
        holders.push(holder);
        // A microtask: the holder's listeners are attached in the same synchronous run that spawned it, so this is after them — and, unlike a timer, not a race with the settle time on a loaded box.
        queueMicrotask(() => { behave(holder); });
        return holder as unknown as ChildProcess;
      },
      settleMs: 30,
      retryMs: 40,
      writeState: (line) => { written.push(line); },
      removeState: () => { removed += 1; },
      ...overrides,
    };
  }

  it('a holder that stays up: the state is the method and the holder\'s pid, written once; the command is the plan\'s', async () => {
    const keepAwake = await startKeepAwake(createDeps());
    assert.deepEqual(keepAwake.getState(), { method: 'caffeinate', holderPid: 9001 });
    assert.deepEqual(written, ['caffeinate 9001\n']);
    assert.deepEqual(spawned, [{ file: '/usr/bin/caffeinate', args: ['-i', '-w', '4242'] }]);
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
    const deadline = Date.now() + 5000;
    while (keepAwake.getState().method === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
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

  it('a stop while the first attempt is still settling ends that holder too — it never outlives the link', async () => {
    const pending = startKeepAwake(createDeps({ settleMs: 80 }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The stop of a link that is going down before the assertion has settled: the handle only exists after the promise, so the process-exit path is the caller's
    // (`process.once('exit', stop)`); here the holder is ended once it is known.
    const keepAwake = await pending;
    keepAwake.stop();
    assert.deepEqual(holders[0].killed, ['SIGTERM']);
  });
});

/** The `--why` of the lock the runner's link takes (`keepAwake.ts`). */
const lockReason = 'the runner link is up';

const hasWorkingSystemdInhibit = process.platform === 'linux' && spawnSync('systemd-inhibit', ['--what=idle', '--why=test', '--mode=block', 'true']).status === 0;

describe('the real systemd-inhibit', { skip: hasWorkingSystemdInhibit ? false : 'no working systemd-inhibit here' }, () => {
  let root = '';
  let standInLink: ChildProcess | null = null;
  let decoyHolder: ChildProcess | null = null;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keep-awake-')));
  });
  afterEach(() => {
    if (standInLink !== null && standInLink.pid !== undefined && checkIsProcessAlive(standInLink.pid)) standInLink.kill('SIGKILL');
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

  it('the lock shows in systemd\'s own list while the link lives; a SIGKILLed link leaves neither the lock nor a holder — the machine would sleep again', async () => {
    standInLink = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { stdio: 'ignore' });
    const paths = getRunnerHomePaths(path.join(root, 'home'));
    fs.mkdirSync(paths.root, { recursive: true });
    const keepAwake = await startKeepAwake({ ...createKeepAwakeDeps(paths), linkPid: standInLink.pid ?? 0 });
    const state = keepAwake.getState();
    assert.equal(state.method, 'systemd-inhibit', JSON.stringify(state));
    const holderPid = state.method === null ? 0 : state.holderPid;
    assert.equal(fs.readFileSync(paths.awakeFile, 'utf8'), `systemd-inhibit ${holderPid}\n`);
    assert.equal(listLocksOfHolder(holderPid).length, 1, 'systemd lists the holder\'s lock');
    assert.match(listLocksOfHolder(holderPid)[0], /charness-runner .*\bidle\b +the runner link is up +block/, 'who, what (idle), why, mode (block)');

    standInLink.kill('SIGKILL');
    await waitUntil('the lock to go', () => listLocksOfHolder(holderPid).length === 0);
    await waitUntil('the holder to be gone', () => !checkIsProcessAlive(holderPid));
    keepAwake.stop();
  });

  it('a normal stop removes the state file and the lock goes with the holder', async () => {
    standInLink = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { stdio: 'ignore' });
    const paths = getRunnerHomePaths(path.join(root, 'home'));
    fs.mkdirSync(paths.root, { recursive: true });
    const keepAwake = await startKeepAwake({ ...createKeepAwakeDeps(paths), linkPid: standInLink.pid ?? 0 });
    const state = keepAwake.getState();
    assert.equal(state.method, 'systemd-inhibit');
    const holderPid = state.method === null ? 0 : state.holderPid;
    keepAwake.stop();
    assert.equal(fs.existsSync(paths.awakeFile), false);
    await waitUntil('the lock to go', () => listLocksOfHolder(holderPid).length === 0);
    await waitUntil('the holder to be gone', () => !checkIsProcessAlive(holderPid));
  });

  it('a lock with the very same text held by ANOTHER process neither hides this holder\'s lock going nor fails the check — it is not ours', async () => {
    // What another runner on the box looks like to `systemd-inhibit --list`: same who, same why, a pid of its own, and it outlives this test's holder.
    decoyHolder = spawn('systemd-inhibit', ['--what=idle', '--who=charness-runner', `--why=${lockReason}`, '--mode=block', 'sleep', '120'], { stdio: 'ignore' });
    const decoyPid = decoyHolder.pid ?? 0;
    await waitUntil('the decoy\'s lock to show', () => listLocksOfHolder(decoyPid).length === 1);
    standInLink = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { stdio: 'ignore' });
    const paths = getRunnerHomePaths(path.join(root, 'home'));
    fs.mkdirSync(paths.root, { recursive: true });
    const keepAwake = await startKeepAwake({ ...createKeepAwakeDeps(paths), linkPid: standInLink.pid ?? 0 });
    const state = keepAwake.getState();
    const holderPid = state.method === null ? 0 : state.holderPid;
    assert.notEqual(holderPid, decoyPid);
    assert.equal(listLocksOfHolder(holderPid).length, 1);
    keepAwake.stop();
    await waitUntil('the holder\'s lock to go', () => listLocksOfHolder(holderPid).length === 0);
    await waitUntil('the holder to be gone', () => !checkIsProcessAlive(holderPid));
    assert.equal(listLocksOfHolder(decoyPid).length, 1, 'the other process\'s lock is still listed, with the same text: a check on the text alone would never see this holder\'s lock go');
  });
});
