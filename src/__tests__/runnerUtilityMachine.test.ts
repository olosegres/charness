/**
 * @description `runnerUtility/machineReport.ts`, `adminCheck.ts` and the text of `status` / the pairing screen: what the check shows about the
 * machine, and the warning for an account whose rights the agents' code would run with.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { checkIsAdminAccount, formatAdminWarning } from '../runnerUtility/adminCheck';
import { collectMachineReport, formatMachineReport, getArchName, parseOsRelease, type MachineProbe } from '../runnerUtility/machineReport';
import { formatKeepRunningHelp, formatRemovedMessage, runStatus } from '../runnerUtility/runnerCommands';
import type { ProcessControl } from '../runnerUtility/localLinkStop';
import { writeRunnerConfig, writeRunnerStatus, type RunnerConfig } from '../runnerUtility/runnerConfig';
import { getRunnerHomePaths } from '../runnerUtility/runnerHome';
import { generateEd25519KeyPair } from '../runners/sshKeys';

function createProbe(overrides: Partial<MachineProbe> = {}): MachineProbe {
  return {
    runner: async () => ({ ok: false, exitCode: 1, stdout: '', stderr: '', isTimedOut: false }),
    platform: 'linux',
    nodeArch: 'x64',
    homeDir: '/home/runner',
    environment: {},
    checkExists: () => false,
    readTextFile: () => null,
    cpus: () => [{ model: 'AMD Ryzen 7 9700X ' }, { model: 'AMD Ryzen 7 9700X ' }],
    totalMemoryBytes: () => 64 * 1024 ** 3,
    freeDiskBytes: () => 210 * 1024 ** 3,
    ...overrides,
  };
}

describe('admin account', () => {
  it('macOS: the admin group; Linux: root, sudo, wheel or admin', () => {
    assert.equal(checkIsAdminAccount({ platform: 'darwin', uid: 501, groups: ['staff', 'admin'] }), true);
    assert.equal(checkIsAdminAccount({ platform: 'darwin', uid: 502, groups: ['staff', 'everyone'] }), false);
    assert.equal(checkIsAdminAccount({ platform: 'darwin', uid: 0, groups: [] }), false, 'root is not a Mac admin group member, and nothing in this check runs as root there');
    assert.equal(checkIsAdminAccount({ platform: 'linux', uid: 0, groups: [] }), true);
    for (const group of ['sudo', 'wheel', 'admin']) assert.equal(checkIsAdminAccount({ platform: 'linux', uid: 1000, groups: ['users', group] }), true, group);
    assert.equal(checkIsAdminAccount({ platform: 'linux', uid: 1000, groups: ['users', 'docker'] }), false);
  });

  it('the warning names the account and says what to do', () => {
    assert.match(formatAdminWarning('example-user').join('\n'), /«example-user» is an admin account.*standard user/s);
  });
});

describe('machine report', () => {
  it('reads PRETTY_NAME and names the architectures the way people do', () => {
    assert.equal(parseOsRelease('NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n'), 'Ubuntu 24.04.1 LTS');
    assert.equal(parseOsRelease(null), null);
    assert.equal(getArchName('x64'), 'x86_64');
    assert.equal(getArchName('arm64'), 'arm64');
  });

  it('a Linux box with an SDK, KVM and Docker', async () => {
    const present = new Set(['/home/runner/Android/Sdk', '/home/runner/Android/Sdk/emulator/emulator', '/dev/kvm', '/home/runner/.cache/ms-playwright']);
    const report = await collectMachineReport(createProbe({
      checkExists: (candidate) => present.has(candidate),
      readTextFile: () => 'PRETTY_NAME="Ubuntu 24.04"\n',
      runner: async (file) => ({ ok: file === 'docker', exitCode: 0, stdout: 'Docker version 27.0.3, build abc\n', stderr: '', isTimedOut: false }),
    }), '/home/runner/.charness-runner');
    assert.deepEqual(formatMachineReport(report), [
      '  Ubuntu 24.04 (x86_64) · AMD Ryzen 7 9700X, 2 cores · RAM 64 GB · disk 210 GB free',
      '  can: android (KVM, emulator found) · ios: no · playwright (browsers installed) · docker (27.0.3)',
    ]);
  });

  it('a Mac: HVF, Xcode for iOS, and no browsers or Docker', async () => {
    const present = new Set(['/Users/runner/Library/Android/sdk', '/Users/runner/Library/Android/sdk/emulator/emulator']);
    const report = await collectMachineReport(createProbe({
      platform: 'darwin',
      nodeArch: 'arm64',
      homeDir: '/Users/runner',
      checkExists: (candidate) => present.has(candidate),
      runner: async (file) => ({ ok: file !== 'docker', exitCode: 0, stdout: file === 'sw_vers' ? '15.1\n' : 'Xcode 16.2\nBuild version 16C5032a\n', stderr: '', isTimedOut: false }),
    }), '/Users/runner/.charness-runner');
    const text = formatMachineReport(report).join('\n');
    assert.match(text, /macOS 15\.1 \(arm64\)/);
    assert.match(text, /android \(HVF, emulator found\)/);
    assert.match(text, /ios \(Xcode 16\.2, checked when the service starts\)/);
    assert.match(text, /playwright: no/);
    assert.match(text, /docker: no/);
  });

  it('says why Android is not available', async () => {
    const withoutSdk = await collectMachineReport(createProbe(), '/r');
    assert.equal(withoutSdk.capabilities[0].detail, 'no Android SDK found');
    const present = new Set(['/home/runner/Android/Sdk']);
    const withoutEmulator = await collectMachineReport(createProbe({ checkExists: (candidate) => present.has(candidate) }), '/r');
    assert.equal(withoutEmulator.capabilities[0].detail, 'the SDK has no emulator');
  });
});

describe('status text', () => {
  let home = '';
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  /** A process table in which `pid` is a live `node …/runnerCli.js run` — the link `status.json` names. */
  const linkProcess: ProcessControl = {
    checkIsAlive: () => true,
    readCommand: () => '/usr/bin/node /home/runner/.charness-runner/current/dist/runnerUtility/runnerCli.js run',
    signal: () => undefined,
    terminateGraceMs: 0,
    killGraceMs: 0,
  };

  function run(processControl?: ProcessControl): string {
    let output = '';
    runStatus({ stdout: (text) => { output += text; }, stderr: () => undefined }, home, processControl);
    return output;
  }

  function pair(): RunnerConfig {
    const config: RunnerConfig = {
      runnerId: 'abcdef012345',
      name: 'mac',
      hub: { host: 'host.example', port: 22, user: 'hubuser', hostKey: generateEd25519KeyPair('h').publicKey, publicKey: generateEd25519KeyPair('p').publicKey, label: '@ExampleBot' },
      packageId: '0123456789abcdef',
      pairedAtMs: Date.UTC(2026, 10, 1, 12, 0, 0),
    };
    writeRunnerConfig(getRunnerHomePaths(home), config);
    return config;
  }

  it('an account that is not paired says how to attach it', () => {
    assert.match(run(), /not paired.*\/runners/);
  });

  it('a paired account whose link is not running says so', () => {
    pair();
    assert.match(run(), /Runner “mac” of charness @ExampleBot \(host\.example:22\)\n {2}link: not running/);
  });

  it('a pid in status.json that is alive but is not the runner\'s link (a reboot, a reused pid) is «not running», whatever the record says — here the real process table, this test process is the live stranger', () => {
    pair();
    writeRunnerStatus(getRunnerHomePaths(home), { pid: process.pid, state: 'linked', sinceMs: 1, updatedAtMs: 1, lastError: null, activeJobs: 2, packageId: null });
    const text = run();
    assert.match(text, /link: not running/);
    assert.doesNotMatch(text, /linked since|jobs running over the link/);
  });

  it('shows the link state, the jobs and the package while it runs', () => {
    pair();
    writeRunnerStatus(getRunnerHomePaths(home), { pid: process.pid, state: 'linked', sinceMs: Date.UTC(2026, 10, 1, 12, 5, 0), updatedAtMs: 1, lastError: null, activeJobs: 2, packageId: '0123456789abcdef' });
    const text = run(linkProcess);
    assert.match(text, /link: linked since \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    assert.match(text, /jobs running over the link: 2/);
    assert.match(text, /package: 0123456789abcdef/);
  });

  it('a runner the hub removed is told so in the words of the plan', () => {
    pair();
    writeRunnerStatus(getRunnerHomePaths(home), { pid: process.pid, state: 'removed', sinceMs: 1, updatedAtMs: 1, lastError: 'removed by @ExampleBot', activeJobs: 0, packageId: null });
    assert.ok(run(linkProcess).includes('This runner was removed by @ExampleBot. Pair again with a new line from /runners.'));
    assert.equal(formatRemovedMessage('@ExampleBot'), 'This runner was removed by @ExampleBot. Pair again with a new line from /runners.');
  });

  it('the pairing text tells how to keep the runner running', () => {
    assert.match(formatKeepRunningHelp(getRunnerHomePaths('/Users/runner')), /Keep it running:\n {2}\/Users\/runner\/\.charness-runner\/bin\/charness-runner run/);
  });
});
