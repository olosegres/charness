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
import { generateEd25519KeyPair } from '../runners/sshKeys';
import { writeIosCheck } from '../runnerUtility/iosCheck';
import { formatKeepRunningHelp, runPause, runService, runStatus, runUnpair, type CommandIo } from '../runnerUtility/runnerCommands';
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
async function startHub(knownKey: string): Promise<{ port: number; hostKey: string; unpairRequests: { count: number } }> {
  const hostKey = generateEd25519KeyPair('hub-host');
  const authenticate = createHubAuthenticator(knownKey);
  const unpairRequests = { count: 0 };
  const server = new Server({ hostKeys: [hostKey.privateKey] }, (connection) => {
    connection.on('error', () => undefined);
    connection.on('authentication', authenticate);
    connection.on('ready', () => {
      connection.on('session', (acceptSession) => {
        acceptSession().on('exec', (accept, reject, info) => {
          if (info.command !== 'unpair') {
            reject();
            return;
          }
          unpairRequests.count += 1;
          const channel = accept();
          channel.write(formatGateAnswerHead('unpair'));
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
  return { port: address.port, hostKey: hostKey.publicKey, unpairRequests };
}

function createServiceDeps(commands: string[]): ServiceDeps {
  const runner: CommandRunner = async (file, args) => {
    commands.push(`${file} ${args.join(' ')}`);
    return { ok: true, exitCode: 0, stdout: '', stderr: '', isTimedOut: false };
  };
  return { runner, platform: 'linux', uid: 1000, checkIsProcessAlive: () => false, accountName: 'runner', homeDir: home, nodePath: process.execPath, launchDaemonsDir: path.join(home, 'LaunchDaemons'), chown: () => undefined, resolveAccount: async () => null };
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
  it('on a Mac offers the terminal, the user service and the always-on daemon; on Linux no daemon', () => {
    const mac = formatKeepRunningHelp(paths, 'darwin', 'runner');
    assert.ok(mac.includes(`${paths.launcher} run`));
    assert.ok(mac.includes(`${paths.launcher} service install\n      in the background while this user is logged in`));
    assert.ok(mac.includes(`sudo ${paths.launcher} service install --system --user runner\n      always, also logged out — once, from an admin account`));
    const linux = formatKeepRunningHelp(paths, 'linux', 'runner');
    assert.ok(linux.includes('also after a logout or a reboot'));
    assert.ok(!linux.includes('--system'));
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

    assert.equal(await runUnpair({ isLocalOnly: false }, io, home, createServiceDeps(commands)), 0, errors);
    assert.equal(hub.unpairRequests.count, 1, 'the hub was told');
    assert.match(output, /Unpaired from charness @ExampleBot\. This machine no longer serves it\./);
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
    const refused = await runUnpair({ isLocalOnly: false }, io, home, createServiceDeps([]));
    assert.equal(refused, 1);
    assert.match(errors, /the hub could not be told.*unpair --local/);
    assert.notEqual(readRunnerConfig(paths), null, 'nothing was forgotten');

    output = '';
    assert.equal(await runUnpair({ isLocalOnly: true }, io, home, createServiceDeps([])), 0);
    assert.match(output, /here only — the hub was not told/);
    assert.equal(readRunnerConfig(paths), null);
  });

  it('a hub that no longer accepts the key has already forgotten this machine: the pairing is dropped here', async () => {
    const hub = await startHub(generateEd25519KeyPair('someone else').publicKey);
    ensureRunnerKeys(paths);
    pair(hub.port, hub.hostKey);
    assert.equal(await runUnpair({ isLocalOnly: false }, io, home, createServiceDeps([])), 0, errors);
    assert.equal(hub.unpairRequests.count, 0);
    assert.equal(readRunnerConfig(paths), null);
  });

  it('a system service is not touched from the account: the admin command to remove it is printed', async () => {
    ensureRunnerKeys(paths);
    pair(22);
    fs.writeFileSync(paths.serviceMarker, 'system-service\n');
    const commands: string[] = [];
    assert.equal(await runUnpair({ isLocalOnly: true }, io, home, createServiceDeps(commands)), 0);
    assert.match(errors, /sudo .*service uninstall --system --user/);
    assert.deepEqual(commands, []);
  });

  it('an account that is not paired is told so', async () => {
    assert.equal(await runUnpair({ isLocalOnly: false }, io, home, createServiceDeps([])), 1);
    assert.match(errors, /not paired/);
  });
});

describe('the service command', () => {
  it('a bad command line is a usage error, and install on an unpaired account is refused with what to do', async () => {
    assert.equal(await runService(['restart'], io, createServiceDeps([])), 2);
    assert.match(errors, /«install» or «uninstall»/);
    errors = '';
    const deps = createServiceDeps([]);
    assert.equal(await runService(['install'], io, { ...deps, homeDir: home }), 1);
    assert.match(output, /not paired yet/);
  });
});
