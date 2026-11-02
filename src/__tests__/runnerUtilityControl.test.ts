/**
 * @description `runnerUtility/runnerCommands.ts` — `pause`, `resume`, `unpair`, `service` and what `status` now says about them. A runner is
 * paused by an empty file the probe reads; `unpair` tells the hub (an ssh server that speaks the gate's words here), stops the user
 * service, and forgets the pairing but keeps the installed program, the tools and the queue; a hub that cannot be reached leaves
 * everything as it was unless `--local`.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Server } from 'ssh2';
import type { CommandRunner } from '../selfUpdate/commandRunner';
import { formatGateAnswerHead } from '../runners/gateProtocol';
import { encodePairCode } from '../runners/pairCode';
import { generateEd25519KeyPair } from '../runners/sshKeys';
import { createPairCodePayload } from './runnersTestKit';
import { writeIosCheck } from '../runnerUtility/iosCheck';
import { formatKeepRunningHelp, runPair, runPause, runService, runStatus, runUnpair, type CommandIo, type UnpairDeps } from '../runnerUtility/runnerCommands';
import type { ProcessControl } from '../runnerUtility/localLinkStop';
import { readRunnerConfig, writeRunnerConfig, writeRunnerStatus, type RunnerConfig } from '../runnerUtility/runnerConfig';
import { checkIsRunnerPaused } from '../runnerUtility/runnerFlags';
import { getRunnerHomePaths, type RunnerHomePaths } from '../runnerUtility/runnerHome';
import { ensureRunnerKeys, readRunnerKeys } from '../runnerUtility/runnerKeys';
import { createHubAuthenticator } from '../runnerUtility/runnerServers';
import type { ServiceDeps } from '../runnerUtility/serviceManager';

let home = '';
let paths: RunnerHomePaths;
let output = '';
let errors = '';
const hubs: Array<{ close: () => void }> = [];

const io: CommandIo = { stdout: (text) => { output += text; }, stderr: (text) => { errors += text; } };

function pair(port = 22, hostKey = generateEd25519KeyPair('h').publicKey): RunnerConfig {
  ensureRunnerKeys(paths);
  const config: RunnerConfig = {
    runnerId: 'abcdef012345',
    name: 'mac',
    hub: { host: '127.0.0.1', port, user: 'hubuser', hostKey, publicKey: generateEd25519KeyPair('p').publicKey, label: '@ExampleBot' },
    packageId: '0123456789abcdef',
    pairedAtMs: Date.UTC(2026, 10, 1, 12, 0, 0),
  };
  writeRunnerConfig(paths, config);
  return config;
}

/** The hub as far as `unpair` can tell: it knows the runner's key (or does not) and answers the `unpair` word. */
async function startHub(knownKey: string): Promise<{ port: number; hostKey: string; unpairRequests: { count: number }; cancelRequests: { count: number } }> {
  const hostKey = generateEd25519KeyPair('hub-host');
  const authenticate = createHubAuthenticator(knownKey);
  const unpairRequests = { count: 0 };
  const cancelRequests = { count: 0 };
  const server = new Server({ hostKeys: [hostKey.privateKey] }, (connection) => {
    connection.on('error', () => undefined);
    connection.on('authentication', authenticate);
    connection.on('ready', () => {
      connection.on('session', (acceptSession) => {
        acceptSession().on('exec', (accept, reject, info) => {
          if (info.command !== 'unpair' && info.command !== 'cancel') {
            reject();
            return;
          }
          (info.command === 'unpair' ? unpairRequests : cancelRequests).count += 1;
          const channel = accept();
          channel.write(formatGateAnswerHead(info.command));
          channel.write('{"ok":true}\n');
          channel.exit(0);
          channel.end();
        });
      });
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  hubs.push({ close: () => { server.close(); } });
  return { port: address.port, hostKey: hostKey.publicKey, unpairRequests, cancelRequests };
}

function createServiceDeps(commands: string[]): ServiceDeps {
  const runner: CommandRunner = async (file, args) => {
    commands.push(`${file} ${args.join(' ')}`);
    return { ok: true, exitCode: 0, stdout: '', stderr: '', isTimedOut: false };
  };
  return { runner, platform: 'linux', uid: 1000, checkIsRunnerLink: () => false, accountName: 'runner', homeDir: home, nodePath: process.execPath, launchDaemonsDir: path.join(home, 'LaunchDaemons') };
}

/** A Pueue with one running task that `reset --force` ends: `status --json` shows it until the reset, an empty queue after. */
function createBusyQueueRunner(commands: string[]): CommandRunner {
  let isReset = false;
  const answer = (isOk: boolean, stdout = ''): Awaited<ReturnType<CommandRunner>> => ({ ok: isOk, exitCode: isOk ? 0 : 1, stdout, stderr: '', isTimedOut: false });
  return async (file, args) => {
    commands.push(`${file} ${args.join(' ')}`);
    if (args.includes('reset')) {
      isReset = true;
      return answer(true);
    }
    if (args.includes('status') && args.includes('--json')) return answer(true, JSON.stringify({ tasks: isReset ? {} : { 0: { status: { Running: {} } } } }));
    return answer(false);
  };
}

/** The unpair command's collaborators: the service manager and the queue record their commands; no process is running. */
function createUnpairDeps(commands: string[], overrides: Partial<UnpairDeps> = {}): UnpairDeps {
  const idleProcess: ProcessControl = { checkIsAlive: () => false, readCommand: () => null, signal: () => undefined, terminateGraceMs: 50, killGraceMs: 50 };
  const queueRunner: CommandRunner = async (file, args) => {
    commands.push(`${file} ${args.join(' ')}`);
    return { ok: false, exitCode: 1, stdout: '', stderr: '', isTimedOut: false };
  };
  return { service: createServiceDeps(commands), process: idleProcess, queueRunner, ...overrides };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-'));
  paths = getRunnerHomePaths(home);
  fs.mkdirSync(paths.root, { recursive: true });
  output = '';
  errors = '';
});
afterEach(() => {
  for (const hub of hubs.splice(0)) hub.close();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('pause and resume', () => {
  it('pausing writes the flag the probe reads, resuming removes it, and an unpaired account is told so', () => {
    assert.equal(runPause(true, io, home), 1);
    assert.match(errors, /not paired/);
    pair();
    assert.equal(runPause(true, io, home), 0);
    assert.equal(checkIsRunnerPaused(paths), true);
    assert.match(output, /Paused.*no job is sent/);
    assert.equal(runPause(false, io, home), 0);
    assert.equal(checkIsRunnerPaused(paths), false);
    assert.match(output, /Resumed/);
  });
});

describe('status', () => {
  function status(): string {
    output = '';
    runStatus(io, home);
    return output;
  }

  it('tells the kind of service and whether the runner is paused', () => {
    pair();
    writeRunnerStatus(paths, { pid: process.pid, state: 'linked', sinceMs: 1, updatedAtMs: 1, lastError: null, activeJobs: 0, packageId: null });
    assert.match(status(), /service: none/);
    fs.writeFileSync(paths.serviceMarker, 'system-service\n');
    fs.writeFileSync(paths.pausedFlag, '');
    assert.match(status(), /service: system service \(always on\) · PAUSED/);
    fs.writeFileSync(paths.serviceMarker, 'user-service\n');
    assert.match(status(), /service: user service · PAUSED/);
  });

  it('says what the iOS boot check found, in the words of the probe', () => {
    pair();
    writeRunnerStatus(paths, { pid: process.pid, state: 'linked', sinceMs: 1, updatedAtMs: 1, lastError: null, activeJobs: 0, packageId: null });
    writeIosCheck(paths, { status: 'pass', checkedAtMs: 1, xcode: '16.2 (16C5032a)', reason: null });
    assert.match(status(), /ios: the Simulator boots \(Xcode 16\.2 \(16C5032a\)\)/);
    writeIosCheck(paths, { status: 'fail', checkedAtMs: 1, xcode: '16.2 (16C5032a)', reason: 'the Simulator did not boot: no login session' });
    assert.match(status(), /ios: no — needs the runner user's login session \(the Simulator did not boot/);
    writeIosCheck(paths, { status: 'skipped', checkedAtMs: 1, xcode: null, reason: 'not macOS' });
    assert.doesNotMatch(status(), /ios:/);
  });
});

describe('the pairing text', () => {
  it('on a Mac offers the terminal, the user service and — through an admin line — the always-on daemon; on Linux no daemon', () => {
    const mac = formatKeepRunningHelp(paths, 'darwin');
    assert.ok(mac.includes(`${paths.launcher} run`));
    assert.ok(mac.includes(`${paths.launcher} service install\n      in the background while this user is logged in`));
    assert.ok(mac.includes('an admin account\'s paste of a fresh admin line from /runners\n      always, also logged out'));
    assert.ok(!mac.includes('sudo') && !mac.includes('--system'), 'no command that would have root run this account\'s own program');
    const linux = formatKeepRunningHelp(paths, 'linux');
    assert.ok(linux.includes('also after a logout or a reboot'));
    assert.ok(!linux.includes('--system') && !linux.includes('admin line'));
  });
});

describe('unpair', () => {
  function keepEverythingElse(): void {
    fs.mkdirSync(paths.binDir, { recursive: true });
    fs.mkdirSync(paths.workDir, { recursive: true });
    fs.writeFileSync(path.join(paths.binDir, 'pueue'), 'tool');
    fs.writeFileSync(path.join(paths.root, 'app.aaaaaaaaaaaa'), 'app');
    fs.writeFileSync(paths.envFile, 'KEY=value\n');
  }

  it('tells the hub, stops the user service and forgets the pairing here — and keeps the program, the tools, the work folder and the queue', async () => {
    const keys = ensureRunnerKeys(paths);
    const hub = await startHub(keys.client.publicKey);
    pair(hub.port, hub.hostKey);
    keepEverythingElse();
    fs.writeFileSync(paths.serviceMarker, 'user-service\n');
    fs.writeFileSync(paths.pausedFlag, '');
    writeIosCheck(paths, { status: 'pass', checkedAtMs: 1, xcode: null, reason: null });
    writeRunnerStatus(paths, { pid: process.pid, state: 'linked', sinceMs: 1, updatedAtMs: 1, lastError: null, activeJobs: 0, packageId: null });
    const commands: string[] = [];

    assert.equal(await runUnpair({ isLocalOnly: false }, io, home, createUnpairDeps(commands)), 0, errors);
    assert.equal(hub.unpairRequests.count, 1, 'the hub was told');
    assert.match(output, /Unpaired from charness @ExampleBot\. The link on this machine is stopped, and so are its jobs\./);
    assert.ok(commands.some((line) => line.startsWith('systemctl --user disable --now')), 'the user service is stopped');
    assert.equal(readRunnerConfig(paths), null);
    assert.equal(readRunnerKeys(paths), null);
    for (const gone of [paths.status, paths.pausedFlag, paths.iosCheck, paths.serviceMarker]) assert.equal(fs.existsSync(gone), false, gone);
    for (const kept of [path.join(paths.binDir, 'pueue'), paths.workDir, paths.envFile, path.join(paths.root, 'app.aaaaaaaaaaaa')]) assert.equal(fs.existsSync(kept), true, kept);
  });

  it('a hub that cannot be reached changes nothing — `--local` forgets the pairing here only', async () => {
    const closed = await startHub(generateEd25519KeyPair('placeholder').publicKey);
    hubs.splice(0).forEach((hub) => hub.close());
    ensureRunnerKeys(paths);
    pair(closed.port, closed.hostKey);
    const refused = await runUnpair({ isLocalOnly: false }, io, home, createUnpairDeps([]));
    assert.equal(refused, 1);
    assert.match(errors, /the hub could not be told.*unpair --local/);
    assert.notEqual(readRunnerConfig(paths), null, 'nothing was forgotten');

    output = '';
    assert.equal(await runUnpair({ isLocalOnly: true }, io, home, createUnpairDeps([])), 0);
    assert.match(output, /here only — the hub was not told/);
    assert.equal(readRunnerConfig(paths), null);
  });

  it('a hub that no longer accepts the key has already forgotten this machine: the pairing is dropped here', async () => {
    const hub = await startHub(generateEd25519KeyPair('someone else').publicKey);
    ensureRunnerKeys(paths);
    pair(hub.port, hub.hostKey);
    assert.equal(await runUnpair({ isLocalOnly: false }, io, home, createUnpairDeps([])), 0, errors);
    assert.equal(hub.unpairRequests.count, 0);
    assert.equal(readRunnerConfig(paths), null);
  });

  it('a system service is not touched from the account: unpair stops with the admin\'s plain commands and changes nothing — not even the hub is told', async () => {
    const keys = ensureRunnerKeys(paths);
    const hub = await startHub(keys.client.publicKey);
    pair(hub.port, hub.hostKey);
    fs.writeFileSync(paths.serviceMarker, 'system-service\n');
    const commands: string[] = [];
    assert.equal(await runUnpair({ isLocalOnly: false }, io, home, createUnpairDeps(commands)), 1);
    assert.match(errors, /runs as a system service \(always on\), which only an admin can stop\. As an admin, run:\n {2}sudo launchctl bootout system\/com\.charness\.runner\.[0-9a-f]{8}\n {2}sudo launchctl bootout system\/com\.charness\.runner\.pueued\.[0-9a-f]{8}\n {2}sudo rm \S+\.plist \S+\.plist\nthen run `charness-runner service uninstall` here and unpair again\. Nothing was changed\./);
    assert.doesNotMatch(errors, /--system/, 'no charness program is asked to run as root');
    assert.deepEqual(commands, []);
    assert.equal(hub.unpairRequests.count, 0);
    assert.notEqual(readRunnerConfig(paths), null);
  });

  it('a user service that cannot be stopped keeps the pairing, and does not say it is gone', async () => {
    ensureRunnerKeys(paths);
    pair(22);
    fs.writeFileSync(paths.serviceMarker, 'user-service\n');
    const commands: string[] = [];
    const service = createServiceDeps(commands);
    const stuck: UnpairDeps = createUnpairDeps(commands, { service: { ...service, runner: async (file, args) => {
      commands.push(`${file} ${args.join(' ')}`);
      return { ok: false, exitCode: 1, stdout: args.includes('show') ? 'active\n' : '', stderr: '', isTimedOut: false };
    } } });
    assert.equal(await runUnpair({ isLocalOnly: true }, io, home, stuck), 1);
    assert.match(errors, /service on this machine could not be stopped, so the pairing is kept here/);
    assert.doesNotMatch(output, /Unpaired/);
    assert.notEqual(readRunnerConfig(paths), null);
    assert.notEqual(readRunnerKeys(paths), null);
  });

  it('a foreground runner that is still linked is stopped — and checked to be gone — before the pairing is forgotten; the queue\'s jobs are stopped too', async () => {
    ensureRunnerKeys(paths);
    pair(22);
    const alive = new Set([4242]);
    const signals: string[] = [];
    const commands: string[] = [];
    writeRunnerStatus(paths, { pid: 4242, state: 'linked', sinceMs: 1, updatedAtMs: 1, lastError: null, activeJobs: 0, packageId: null });
    const control: ProcessControl = {
      checkIsAlive: (pid) => alive.has(pid),
      readCommand: () => `/usr/bin/node ${paths.currentApp}/dist/runnerUtility/runnerCli.js run`,
      signal: (pid, signal) => { signals.push(signal); if (signal === 'SIGTERM') alive.delete(pid); },
      terminateGraceMs: 500,
      killGraceMs: 500,
    };
    assert.equal(await runUnpair({ isLocalOnly: true }, io, home, createUnpairDeps(commands, { process: control, queueRunner: createBusyQueueRunner(commands) })), 0, errors);
    assert.deepEqual(signals, ['SIGTERM']);
    assert.equal(alive.has(4242), false);
    assert.ok(commands.some((line) => line.endsWith('reset --force')), 'the queue was emptied: its running jobs are killed');
    assert.equal(readRunnerConfig(paths), null);
  });

  it('a runner that ignores TERM is killed; one that cannot be stopped at all keeps the pairing in place', async () => {
    ensureRunnerKeys(paths);
    pair(22);
    writeRunnerStatus(paths, { pid: 4243, state: 'linked', sinceMs: 1, updatedAtMs: 1, lastError: null, activeJobs: 0, packageId: null });
    const alive = new Set([4243]);
    const signals: string[] = [];
    const stubborn: ProcessControl = {
      checkIsAlive: (pid) => alive.has(pid),
      readCommand: () => `node ${paths.currentApp}/dist/runnerUtility/runnerCli.js run`,
      signal: (pid, signal) => { signals.push(signal); if (signal === 'SIGKILL') alive.delete(pid); },
      terminateGraceMs: 200,
      killGraceMs: 200,
    };
    assert.equal(await runUnpair({ isLocalOnly: true }, io, home, createUnpairDeps([], { process: stubborn })), 0, errors);
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);

    ensureRunnerKeys(paths);
    pair(22);
    writeRunnerStatus(paths, { pid: 4244, state: 'linked', sinceMs: 1, updatedAtMs: 1, lastError: null, activeJobs: 0, packageId: null });
    const unkillable: ProcessControl = { ...stubborn, checkIsAlive: (pid) => pid === 4244, signal: () => undefined };
    errors = '';
    assert.equal(await runUnpair({ isLocalOnly: true }, io, home, createUnpairDeps([], { process: unkillable })), 1);
    assert.match(errors, /could not be stopped \(the link process \(pid 4244\) did not end\), so the pairing is kept here/);
    assert.notEqual(readRunnerConfig(paths), null, 'the pairing is still there: the runner still holds it');
  });

  it('a pid in status.json that now belongs to another program is left alone', async () => {
    ensureRunnerKeys(paths);
    pair(22);
    writeRunnerStatus(paths, { pid: 4245, state: 'linked', sinceMs: 1, updatedAtMs: 1, lastError: null, activeJobs: 0, packageId: null });
    const signals: string[] = [];
    const reused: ProcessControl = { checkIsAlive: () => true, readCommand: () => '/usr/bin/vim notes.txt', signal: (_pid, signal) => { signals.push(signal); }, terminateGraceMs: 50, killGraceMs: 50 };
    assert.equal(await runUnpair({ isLocalOnly: true }, io, home, createUnpairDeps([], { process: reused })), 0);
    assert.deepEqual(signals, []);
  });

  it('an account that is not paired is told so', async () => {
    assert.equal(await runUnpair({ isLocalOnly: false }, io, home, createUnpairDeps([])), 1);
    assert.match(errors, /not paired/);
  });
});

describe('pairing an account that is already paired', () => {
  /** A pairing code whose temporary key a stand-in hub knows; the hub counts the `cancel` requests it gets. */
  async function createCodeOnHub(): Promise<{ code: string; hub: Awaited<ReturnType<typeof startHub>> }> {
    const temporaryKey = generateEd25519KeyPair('temporary');
    const hub = await startHub(temporaryKey.publicKey);
    return { code: encodePairCode(createPairCodePayload({ host: '127.0.0.1', port: hub.port, user: 'hubuser', hostKey: hub.hostKey, privateKey: temporaryKey.privateKey })), hub };
  }

  it('an admin line pasted again (a failed service step, or a Mac that only lacks the always-on service) pairs nothing twice, CLOSES its code on the hub, and lets the line go on to the service — a plain pair is still refused', async () => {
    pair();
    const { code, hub } = await createCodeOnHub();
    const before = fs.readFileSync(paths.config, 'utf8');
    assert.equal(await runPair(code, '/app', null, io, home, { isServiceFollowing: true }), 0);
    assert.match(output, /This account is already paired \(as “mac” with @ExampleBot\): it is not paired again\. Its always-on service is installed next, by the same line\./);
    assert.equal(errors, '');
    assert.equal(hub.cancelRequests.count, 1, 'the code is closed with its own key: it is not left open in sudo\'s log, and its Telegram messages settle');
    assert.equal(fs.readFileSync(paths.config, 'utf8'), before, 'the pairing is as it was');
    output = '';
    assert.equal(await runPair(code, '/app', null, io, home), 1);
    assert.match(errors, /this account is already paired \(as “mac” with @ExampleBot\)/);
    assert.equal(output, '');
    assert.equal(hub.cancelRequests.count, 1, 'a plain pair closes nothing');
  });

  it('a hub that cannot be reached for the closing is said, and the line still goes on to the service — the code then runs out by itself', async () => {
    pair();
    const { code, hub } = await createCodeOnHub();
    hubs.pop()?.close();
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    assert.equal(hub.cancelRequests.count, 0);
    assert.equal(await runPair(code, '/app', null, io, home, { isServiceFollowing: true }), 0);
    assert.match(errors, /the pairing code of this line could not be closed on the hub \(.+\); it stays open until it expires/);
  });

  it('a code that is not a pairing code is refused even for an admin line, and nothing is asked of any hub', async () => {
    pair();
    assert.equal(await runPair('cr1.never-read', '/app', null, io, home, { isServiceFollowing: true }), 1);
    assert.match(errors, /the pairing code is damaged/);
    assert.equal(output, '');
  });
});

describe('the service command', () => {
  it('the account\'s side of the always-on install answers in one JSON line the admin step reads — its exit code says whether it may go on', async () => {
    // No Pueue daemon answers on this account's queue.
    const noQueue: CommandRunner = async () => ({ ok: false, exitCode: 1, stdout: '', stderr: '', isTimedOut: false });
    const asAccount = { ...createServiceDeps([]), runner: noQueue, platform: 'darwin' as const, uid: 501, homeDir: home };
    assert.equal(await runService(['system-step', 'prepare'], io, asAccount), 1);
    assert.deepEqual(JSON.parse(output.trim()), { ok: false, lines: ['This account is not paired yet: run the line from /runners on this machine first, then install the service.'] });
    output = '';
    pair();
    fs.mkdirSync(paths.binDir, { recursive: true });
    fs.writeFileSync(path.join(paths.binDir, 'pueued'), '');
    assert.equal(await runService(['system-step', 'prepare'], io, asAccount), 0);
    assert.deepEqual(JSON.parse(output.trim()), { ok: true, hadService: false });
    assert.equal(fs.readFileSync(paths.serviceMarker, 'utf8'), 'system-service\n');
    output = '';
    assert.equal(await runService(['system-step', 'abandon'], io, asAccount), 0);
    assert.equal(fs.existsSync(paths.serviceMarker), false);
    errors = '';
    assert.equal(await runService(['system-step'], io, asAccount), 2);
    assert.match(errors, /needs «prepare» or «abandon»/);
  });

  it('--system through the account\'s program is refused with the way that works (a root run of this program would be the account\'s own files running as root)', async () => {
    const asAccount = { ...createServiceDeps([]), platform: 'darwin' as const, uid: 0, homeDir: home };
    assert.equal(await runService(['install', '--system', '--user', 'runner'], io, asAccount), 1);
    assert.match(output, /through a pairing line: paste a fresh admin line from \/runners/);
  });

  it('a bad command line is a usage error, and install on an unpaired account is refused with what to do', async () => {
    assert.equal(await runService(['restart'], io, createServiceDeps([])), 2);
    assert.match(errors, /«install» or «uninstall»/);
    errors = '';
    const deps = createServiceDeps([]);
    assert.equal(await runService(['install'], io, { ...deps, homeDir: home }), 1);
    assert.match(output, /not paired yet/);
  });
});
