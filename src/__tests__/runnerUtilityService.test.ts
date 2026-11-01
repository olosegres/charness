/**
 * @description `runnerUtility/serviceUnits.ts` + `serviceManager.ts`: the two services of a runner (the link and Pueue). The systemd units and
 * launchd property lists as text; the lingering plan; the `service` command line; and install / uninstall against a recording command
 * runner and a temp home, on Linux (user units), macOS (LaunchAgents) and macOS as an admin (LaunchDaemons that run as the account).
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { CommandResult, CommandRunner } from '../selfUpdate/commandRunner';
import { writeRunnerConfig, type RunnerConfig } from '../runnerUtility/runnerConfig';
import { getRunnerHomePaths, type RunnerHomePaths } from '../runnerUtility/runnerHome';
import { installService, parseServiceCommand, readServiceKind, uninstallService, type ServiceDeps, type TargetAccount } from '../runnerUtility/serviceManager';
import {
  describeLingerRemedy,
  getServiceNames,
  parseLingerState,
  planLaunchdJobs,
  renderLaunchdPlist,
  renderSystemdLinkUnit,
  renderSystemdPueuedUnit,
} from '../runnerUtility/serviceUnits';
import { generateEd25519KeyPair } from '../runners/sshKeys';

const paths = getRunnerHomePaths('/home/runner');
const names = getServiceNames(paths.root);

describe('service names', () => {
  it('carry a short hash of the state folder: stable, and different for another runner on the same machine', () => {
    assert.match(names.hash, /^[0-9a-f]{8}$/);
    assert.equal(getServiceNames(paths.root).hash, names.hash);
    assert.notEqual(getServiceNames('/home/other/.charness-runner').hash, names.hash);
    assert.equal(names.systemdLink, `charness-runner-${names.hash}.service`);
    assert.equal(names.systemdPueued, `charness-runner-pueued-${names.hash}.service`);
    assert.equal(names.launchdLink, `com.charness.runner.${names.hash}`);
    assert.equal(names.launchdPueued, `com.charness.runner.pueued.${names.hash}`);
  });
});

describe('systemd units', () => {
  it('the link runs the launcher, restarts always, and — KillMode=process — stops with the launcher alone, after and wanting the queue', () => {
    const unit = renderSystemdLinkUnit(paths, names);
    assert.ok(unit.includes(`ExecStart="${paths.launcher}" run`));
    for (const line of ['Type=simple', 'Restart=always', 'KillMode=process', 'WantedBy=default.target', `Wants=network-online.target ${names.systemdPueued}`, `After=network-online.target ${names.systemdPueued}`]) {
      assert.ok(unit.split('\n').includes(line), line);
    }
  });

  it('the queue is Pueue in the foreground, at nice, restarting; it is its own unit so a link restart never touches it', () => {
    const unit = renderSystemdPueuedUnit(paths);
    assert.ok(unit.includes(`ExecStart="${path.join(paths.binDir, 'pueued')}" --config "${paths.pueueConfig}"`));
    assert.ok(!unit.includes('--daemonize'));
    for (const line of ['Nice=10', 'Restart=always', 'WantedBy=default.target']) assert.ok(unit.split('\n').includes(line), line);
    assert.ok(!unit.includes('KillMode'));
    assert.ok(!/taskpolicy/.test(unit));
  });

  it('quotes a path with a space and doubles a percent sign (systemd reads %h and friends)', () => {
    const odd = getRunnerHomePaths('/home/a b/100%');
    const unit = renderSystemdLinkUnit(odd, getServiceNames(odd.root));
    assert.ok(unit.includes('ExecStart="/home/a b/100%%/.charness-runner/bin/charness-runner" run'));
    assert.ok(unit.includes('(/home/a b/100%%/.charness-runner)'));
  });
});

describe('launchd property lists', () => {
  const jobs = planLaunchdJobs(paths, names, 'runner', '/opt/node/bin', null);
  const daemonJobs = planLaunchdJobs(paths, names, 'runner', '/opt/node/bin', 'runner');

  it('a LaunchAgent keeps the link alive, throttled, and does not kill what the link started', () => {
    const plist = renderLaunchdPlist(jobs.link);
    assert.ok(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.ok(plist.includes(`<key>Label</key><string>${names.launchdLink}</string>`));
    assert.ok(plist.includes(`<string>${paths.launcher}</string>`) && plist.includes('<string>run</string>'));
    for (const fragment of ['<key>RunAtLoad</key><true/>', '<key>KeepAlive</key><true/>', '<key>ThrottleInterval</key><integer>10</integer>', '<key>AbandonProcessGroup</key><true/>']) assert.ok(plist.includes(fragment), fragment);
    assert.ok(!plist.includes('UserName'), 'an agent runs as the logged-in account without being told to');
    assert.ok(!plist.includes('<key>Nice</key>'));
    assert.ok(plist.includes('<key>HOME</key><string>/home/runner</string>'));
    assert.match(plist, /<key>PATH<\/key><string>\/home\/runner\/\.charness-runner\/bin:\/opt\/node\/bin:\/opt\/homebrew\/bin/);
  });

  it('a LaunchDaemon runs as the account it is told to — nothing more', () => {
    const plist = renderLaunchdPlist(daemonJobs.link);
    assert.ok(plist.includes('<key>UserName</key><string>runner</string>'));
    assert.ok(!plist.includes('<key>UserName</key><string>root</string>'));
  });

  it('Pueue runs at nice 10 — and never under taskpolicy, which on Apple Silicon pins jobs to the efficiency cores', () => {
    const plist = renderLaunchdPlist(jobs.pueued);
    assert.ok(plist.includes('<key>Nice</key><integer>10</integer>'));
    assert.ok(plist.includes(`<string>${path.join(paths.binDir, 'pueued')}</string>`) && plist.includes('<string>--config</string>'));
    assert.ok(!/taskpolicy/.test(plist));
    assert.ok(plist.includes(`<string>${path.join(paths.logsDir, 'pueued.log')}</string>`));
  });

  it('escapes what XML reads specially', () => {
    const odd = getRunnerHomePaths('/home/a&b<c>');
    const plist = renderLaunchdPlist(planLaunchdJobs(odd, getServiceNames(odd.root), 'a&b', '/n', null).link);
    assert.ok(plist.includes('/home/a&amp;b&lt;c&gt;/.charness-runner'));
    assert.ok(!plist.includes('a&b<c>'));
  });
});

describe('lingering', () => {
  it('reads loginctl\'s answer, and names the one sudo line when the account cannot switch it on', () => {
    assert.equal(parseLingerState('Linger=yes\n'), 'yes');
    assert.equal(parseLingerState('Linger=no\n'), 'no');
    assert.equal(parseLingerState('Failed to get user: no such user'), 'unknown');
    assert.match(describeLingerRemedy('runner'), /sudo loginctl enable-linger runner$/);
  });
});

describe('service command line', () => {
  it('reads install / uninstall with an optional --system --user pair', () => {
    assert.deepEqual(parseServiceCommand(['install']), { ok: true, action: 'install', request: { isSystem: false, userName: null } });
    assert.deepEqual(parseServiceCommand(['install', '--system', '--user', 'runner']), { ok: true, action: 'install', request: { isSystem: true, userName: 'runner' } });
    assert.deepEqual(parseServiceCommand(['uninstall', '--user', 'runner', '--system']), { ok: true, action: 'uninstall', request: { isSystem: true, userName: 'runner' } });
  });

  it('refuses the rest: no action, --system without --user, --user without --system, unknown words', () => {
    for (const args of [[], ['restart'], ['install', '--system'], ['install', '--user', 'runner'], ['install', '--bogus'], ['install', '--user']]) assert.equal(parseServiceCommand(args).ok, false, JSON.stringify(args));
  });
});

interface Call {
  file: string;
  args: readonly string[];
}

let home = '';
let daemonsDir = '';
let calls: Call[] = [];
let failing: Set<string> = new Set();
let chowned: string[] = [];

function recordingRunner(answers: Record<string, Partial<CommandResult>> = {}): CommandRunner {
  return async (file, args) => {
    calls.push({ file, args });
    const key = `${file} ${args.join(' ')}`;
    const answer = Object.entries(answers).find(([prefix]) => key.startsWith(prefix))?.[1];
    const ok = answer?.ok ?? !failing.has(key.split(' ').slice(0, 3).join(' '));
    return { ok, exitCode: ok ? 0 : 1, stdout: '', stderr: '', isTimedOut: false, ...answer };
  };
}

function createDeps(overrides: Partial<ServiceDeps> = {}): ServiceDeps {
  return {
    runner: recordingRunner(),
    platform: 'linux',
    uid: 1000,
    accountName: 'runner',
    homeDir: home,
    nodePath: '/opt/node/bin/node',
    launchDaemonsDir: daemonsDir,
    chown: (filePath) => { chowned.push(filePath); },
    resolveAccount: async (name): Promise<TargetAccount | null> => (name === 'runner' ? { name, uid: 501, gid: 20, homeDir: home } : name === 'root' ? { name, uid: 0, gid: 0, homeDir: '/var/root' } : null),
    ...overrides,
  };
}

function pair(): void {
  const runnerPaths = getRunnerHomePaths(home);
  const config: RunnerConfig = {
    runnerId: 'abcdef012345',
    name: 'mac',
    hub: { host: 'host.example', port: 22, user: 'hubuser', hostKey: generateEd25519KeyPair('h').publicKey, publicKey: generateEd25519KeyPair('p').publicKey, label: '@ExampleBot' },
    packageId: null,
    pairedAtMs: 1,
  };
  fs.mkdirSync(runnerPaths.root, { recursive: true });
  writeRunnerConfig(runnerPaths, config);
}

function commandLines(): string[] {
  return calls.map((call) => `${call.file} ${call.args.join(' ')}`);
}

describe('installing and removing the services', () => {
  let runnerPaths: RunnerHomePaths;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-'));
    daemonsDir = path.join(home, 'LaunchDaemons');
    runnerPaths = getRunnerHomePaths(home);
    calls = [];
    failing = new Set();
    chowned = [];
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('Linux: two user units, queue first, enabled and started; lingering switched on; the kind is written', async () => {
    pair();
    const result = await installService({ isSystem: false, userName: null }, createDeps({ runner: recordingRunner({ 'loginctl show-user': { stdout: 'Linger=no\n' } }) }));
    assert.equal(result.ok, true, result.lines.join('\n'));
    const serviceNames = getServiceNames(runnerPaths.root);
    const unitDir = path.join(home, '.config', 'systemd', 'user');
    assert.ok(fs.readFileSync(path.join(unitDir, serviceNames.systemdLink), 'utf8').includes('KillMode=process'));
    assert.ok(fs.existsSync(path.join(unitDir, serviceNames.systemdPueued)));
    assert.deepEqual(commandLines(), [
      'systemctl --user daemon-reload',
      `systemctl --user enable --now ${serviceNames.systemdPueued} ${serviceNames.systemdLink}`,
      'loginctl show-user runner -p Linger',
      'loginctl enable-linger',
    ]);
    assert.match(result.lines.join('\n'), /Lingering switched on/);
    assert.equal(readServiceKind(runnerPaths), 'user-service');
  });

  it('Linux: lingering that is already on is left alone; one that needs an admin prints the sudo line and still installs', async () => {
    pair();
    const already = await installService({ isSystem: false, userName: null }, createDeps({ runner: recordingRunner({ 'loginctl show-user': { stdout: 'Linger=yes\n' } }) }));
    assert.match(already.lines.join('\n'), /Lingering is on/);
    assert.ok(!commandLines().includes('loginctl enable-linger'));

    calls = [];
    const denied = await installService({ isSystem: false, userName: null }, createDeps({ runner: recordingRunner({ 'loginctl show-user': { stdout: 'Linger=no\n' }, 'loginctl enable-linger': { ok: false } }) }));
    assert.equal(denied.ok, true);
    assert.match(denied.lines.join('\n'), /sudo loginctl enable-linger runner/);
    assert.equal(readServiceKind(runnerPaths), 'user-service');
  });

  it('Linux: without a user session the message says what to do; --system is for macOS; an unpaired account is told to pair first', async () => {
    pair();
    const noSession = await installService({ isSystem: false, userName: null }, createDeps({ runner: recordingRunner({ 'systemctl --user daemon-reload': { ok: false } }) }));
    assert.equal(noSession.ok, false);
    assert.match(noSession.lines.join('\n'), /cannot reach a user session/);
    assert.equal(readServiceKind(runnerPaths), null);
    const system = await installService({ isSystem: true, userName: 'runner' }, createDeps());
    assert.equal(system.ok, false);
    assert.match(system.lines.join('\n'), /--system is for macOS/);
    fs.rmSync(runnerPaths.config);
    const unpaired = await installService({ isSystem: false, userName: null }, createDeps());
    assert.equal(unpaired.ok, false);
    assert.match(unpaired.lines.join('\n'), /not paired yet/);
  });

  it('Linux: uninstall disables both, deletes the units and the kind, and reloads', async () => {
    pair();
    await installService({ isSystem: false, userName: null }, createDeps());
    calls = [];
    const result = await uninstallService({ isSystem: false, userName: null }, createDeps());
    const serviceNames = getServiceNames(runnerPaths.root);
    assert.equal(result.ok, true);
    assert.deepEqual(commandLines(), [`systemctl --user disable --now ${serviceNames.systemdLink} ${serviceNames.systemdPueued}`, 'systemctl --user daemon-reload']);
    assert.equal(fs.existsSync(path.join(home, '.config', 'systemd', 'user', serviceNames.systemdLink)), false);
    assert.equal(readServiceKind(runnerPaths), null);
  });

  it('macOS: two LaunchAgents in the user domain, queue first; nothing needs an admin', async () => {
    pair();
    const result = await installService({ isSystem: false, userName: null }, createDeps({ platform: 'darwin', uid: 501 }));
    assert.equal(result.ok, true, result.lines.join('\n'));
    const serviceNames = getServiceNames(runnerPaths.root);
    const agentDir = path.join(home, 'Library', 'LaunchAgents');
    const pueuedPlist = path.join(agentDir, `${serviceNames.launchdPueued}.plist`);
    const linkPlist = path.join(agentDir, `${serviceNames.launchdLink}.plist`);
    assert.deepEqual(commandLines(), [
      `launchctl bootout gui/501/${serviceNames.launchdPueued}`,
      `launchctl bootstrap gui/501 ${pueuedPlist}`,
      `launchctl bootout gui/501/${serviceNames.launchdLink}`,
      `launchctl bootstrap gui/501 ${linkPlist}`,
    ]);
    assert.ok(!fs.readFileSync(linkPlist, 'utf8').includes('UserName'));
    assert.equal(readServiceKind(runnerPaths), 'user-service');
    assert.match(result.lines.join('\n'), /sudo .*service install --system --user runner/);
  });

  it('macOS: an admin installs two LaunchDaemons that run as the account, owned by root, with the state files given back to the account', async () => {
    pair();
    const result = await installService({ isSystem: true, userName: 'runner' }, createDeps({ platform: 'darwin', uid: 0, accountName: 'root' }));
    assert.equal(result.ok, true, result.lines.join('\n'));
    const serviceNames = getServiceNames(runnerPaths.root);
    const linkPlist = path.join(daemonsDir, `${serviceNames.launchdLink}.plist`);
    assert.ok(fs.readFileSync(linkPlist, 'utf8').includes('<key>UserName</key><string>runner</string>'));
    assert.equal(fs.statSync(linkPlist).mode & 0o777, 0o644);
    assert.ok(chowned.includes(linkPlist), 'the plist is handed to root:wheel, as launchd demands');
    assert.ok(chowned.includes(runnerPaths.serviceMarker) && chowned.includes(runnerPaths.logsDir), 'what the account will read and write is the account\'s');
    assert.ok(commandLines().includes(`launchctl bootstrap system ${linkPlist}`));
    assert.equal(readServiceKind(runnerPaths), 'system-service');
  });

  it('macOS: a system service needs root, --user must name a standard account, and a user service of the same runner is not stepped on', async () => {
    pair();
    const notRoot = await installService({ isSystem: true, userName: 'runner' }, createDeps({ platform: 'darwin', uid: 501 }));
    assert.equal(notRoot.ok, false);
    assert.match(notRoot.lines.join('\n'), /sudo .*service install --system --user runner/);
    const stranger = await installService({ isSystem: true, userName: 'nobody-here' }, createDeps({ platform: 'darwin', uid: 0 }));
    assert.match(stranger.lines.join('\n'), /no account named «nobody-here»/);
    const root = await installService({ isSystem: true, userName: 'root' }, createDeps({ platform: 'darwin', uid: 0 }));
    assert.match(root.lines.join('\n'), /not as root/);

    await installService({ isSystem: false, userName: null }, createDeps({ platform: 'darwin', uid: 501 }));
    const clash = await installService({ isSystem: true, userName: 'runner' }, createDeps({ platform: 'darwin', uid: 0 }));
    assert.equal(clash.ok, false);
    assert.match(clash.lines.join('\n'), /user service \(LaunchAgent\) is installed/);
  });

  it('macOS: uninstall boots both jobs out and deletes their files', async () => {
    pair();
    await installService({ isSystem: false, userName: null }, createDeps({ platform: 'darwin', uid: 501 }));
    calls = [];
    const serviceNames = getServiceNames(runnerPaths.root);
    const result = await uninstallService({ isSystem: false, userName: null }, createDeps({ platform: 'darwin', uid: 501 }));
    assert.equal(result.ok, true);
    assert.deepEqual(commandLines(), [`launchctl bootout gui/501/${serviceNames.launchdLink}`, `launchctl bootout gui/501/${serviceNames.launchdPueued}`]);
    assert.deepEqual(fs.readdirSync(path.join(home, 'Library', 'LaunchAgents')), []);
    assert.equal(readServiceKind(runnerPaths), null);
  });

  it('refuses a platform with neither systemd nor launchd', async () => {
    const result = await installService({ isSystem: false, userName: null }, createDeps({ platform: 'freebsd' }));
    assert.equal(result.ok, false);
    assert.match(result.lines.join('\n'), /not on freebsd/);
  });
});
