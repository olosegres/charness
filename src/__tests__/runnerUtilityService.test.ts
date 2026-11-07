/**
 * @description `runnerUtility/serviceUnits.ts` + `serviceManager.ts`: the two services of a runner (the link and Pueue). The systemd units and
 * launchd property lists as text; the lingering plan; the `service` command line; and install / uninstall against a recording command
 * runner and a temp home, on Linux (user units), macOS (LaunchAgents) and macOS as an admin (LaunchDaemons that run as the account).
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { CommandResult, CommandRunner } from '../selfUpdate/commandRunner';
import { writeRunnerConfig, type RunnerConfig } from '../runnerUtility/runnerConfig';
import { getRunnerHomePaths, type RunnerHomePaths } from '../runnerUtility/runnerHome';
import { readGuiAgentInstallFailure, writeGuiAgentInstallFailure } from '../runnerUtility/guiAgentHeal';
import { createServiceDeps, installService, parseServiceCommand, readServiceKind, runSystemStep, systemServiceRemovalPointer, uninstallService, type ServiceDeps } from '../runnerUtility/serviceManager';
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
import { launchdOwnPathKeys, parseLaunchdPlist } from './launchdPlistKit';

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

  it('a LaunchDaemon names no path in the account\'s folder for anything launchd opens or enters itself — its output is /dev/null, it has no working directory, and its program starts through the account\'s own shell', () => {
    for (const job of [daemonJobs.link, daemonJobs.pueued]) {
      const parsed = parseLaunchdPlist(renderLaunchdPlist(job));
      assert.equal(parsed.strings.get('StandardOutPath'), '/dev/null');
      assert.equal(parsed.strings.get('StandardErrorPath'), '/dev/null');
      assert.ok(!parsed.keys.includes('WorkingDirectory'), 'launchd would enter the home itself');
      for (const key of launchdOwnPathKeys) {
        const value = parsed.strings.get(key);
        assert.ok(value === undefined || !value.startsWith(paths.homeDir), `${key} = ${value ?? ''}`);
      }
      assert.deepEqual(parsed.programArguments.slice(0, 2), ['/bin/sh', '-c'], 'the first thing launchd starts is a system program');
      assert.deepEqual(parsed.programArguments.slice(3, 5), [job.logPath, paths.homeDir], 'the log and the home are the shell\'s arguments, opened and entered by the account');
      assert.deepEqual(parsed.programArguments.slice(5), job.programArguments);
    }
  });

  it('the daemon\'s shell, started as the account, enters the home, runs the program and puts both its output and its errors in the log', () => {
    const accountHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dmn-'));
    try {
      const logPath = path.join(accountHome, 'logs', 'link.log');
      const parsed = parseLaunchdPlist(renderLaunchdPlist({ ...daemonJobs.link, programArguments: ['/bin/sh', '-c', 'pwd; echo to-stderr >&2'], homeDir: accountHome, logPath }));
      const [shell, ...args] = parsed.programArguments;
      const result = spawnSync(shell, args, { encoding: 'utf8', cwd: '/' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.readFileSync(logPath, 'utf8'), `${fs.realpathSync(accountHome)}\nto-stderr\n`);
      assert.equal(result.stdout + result.stderr, '', 'what launchd itself holds (/dev/null) gets nothing');
      assert.equal(spawnSync(shell, args, { encoding: 'utf8', cwd: '/' }).status, 0);
      assert.equal(fs.readFileSync(logPath, 'utf8').split('\n').length, 5, 'a second start appends');
      // The folder is gone (the account cleaned it): the shell makes it again instead of failing without a word into /dev/null.
      fs.rmSync(path.dirname(logPath), { recursive: true });
      assert.equal(spawnSync(shell, args, { encoding: 'utf8', cwd: '/' }).status, 0);
      assert.equal(fs.readFileSync(logPath, 'utf8'), `${fs.realpathSync(accountHome)}\nto-stderr\n`);
    } finally {
      fs.rmSync(accountHome, { recursive: true, force: true });
    }
  });

  it('a LaunchAgent still logs to the file it is told and enters the home itself — it is launchd\'s job in the account\'s own domain', () => {
    const parsed = parseLaunchdPlist(renderLaunchdPlist(jobs.link));
    assert.equal(parsed.strings.get('StandardOutPath'), path.join(paths.logsDir, 'link.log'));
    assert.equal(parsed.strings.get('WorkingDirectory'), paths.homeDir);
    assert.deepEqual(parsed.programArguments, [paths.launcher, 'run']);
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

/** What the machine says unless a test says otherwise: no Pueue daemon answers, and no launchd job is loaded. */
const unansweredCommands = ['status --json', 'launchctl print'];

function recordingRunner(answers: Record<string, Partial<CommandResult>> = {}): CommandRunner {
  return async (file, args) => {
    calls.push({ file, args });
    const key = `${file} ${args.join(' ')}`;
    const answer = Object.entries(answers).find(([fragment]) => key.includes(fragment))?.[1];
    const ok = answer?.ok ?? !unansweredCommands.some((fragment) => key.includes(fragment));
    return { ok, exitCode: ok ? 0 : 1, stdout: '', stderr: '', isTimedOut: false, ...answer };
  };
}

/**
 * A launchd that tears a job down slowly: after `bootout` the job still shows in `print` for `teardownPrints` more looks, and a
 * `bootstrap` of a job that is still being torn down fails (error 5) — what a reload right after an unload meets. The bootstrap calls
 * numbered in `failingBootstraps` (1-based) fail whatever the state; everything else answers like the default runner.
 */
function createLaunchdRunner(options: { failingBootstraps?: number[]; teardownPrints?: number } = {}): CommandRunner {
  const { failingBootstraps = [], teardownPrints = 0 } = options;
  const base = recordingRunner();
  const printsLeft = new Map<string, number>();
  let bootstrapCount = 0;
  const getLabel = (target: string): string => target.split('/').pop() ?? '';
  const refuse = (file: string, args: readonly string[], stderr: string, isOk: boolean): CommandResult => {
    calls.push({ file, args });
    return { ok: isOk, exitCode: isOk ? 0 : 1, stdout: '', stderr, isTimedOut: false };
  };
  return async (file, args, runOptions) => {
    if (file === 'launchctl' && args[0] === 'bootout') printsLeft.set(getLabel(args[1] ?? ''), teardownPrints);
    if (file === 'launchctl' && args[0] === 'print') {
      const left = printsLeft.get(getLabel(args[1] ?? '')) ?? 0;
      if (left > 0) {
        printsLeft.set(getLabel(args[1] ?? ''), left - 1);
        return refuse(file, args, '', true);
      }
    }
    if (file === 'launchctl' && args[0] === 'bootstrap') {
      bootstrapCount += 1;
      const isTearingDown = (printsLeft.get(path.basename(args[2] ?? '', '.plist')) ?? 0) > 0;
      if (failingBootstraps.includes(bootstrapCount) || isTearingDown) return refuse(file, args, 'Bootstrap failed: 5\n', false);
    }
    return base(file, args, runOptions);
  };
}

function createDeps(overrides: Partial<ServiceDeps> = {}): ServiceDeps {
  return {
    runner: recordingRunner(),
    platform: 'linux',
    uid: 1000,
    checkIsRunnerLink: () => false,
    accountName: 'runner',
    homeDir: home,
    nodePath: '/opt/node/bin/node',
    launchDaemonsDir: daemonsDir,
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

/** The first thing an install asks: is a Pueue daemon already answering on the runner's queue (taking it over must not kill its jobs). */
function queueStatusCommand(runnerPaths: RunnerHomePaths): string {
  return `${path.join(runnerPaths.binDir, 'pueue')} --config ${runnerPaths.pueueConfig} status --json`;
}

describe('installing and removing the services', () => {
  let runnerPaths: RunnerHomePaths;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-'));
    daemonsDir = path.join(home, 'LaunchDaemons');
    runnerPaths = getRunnerHomePaths(home);
    calls = [];
    fs.mkdirSync(runnerPaths.binDir, { recursive: true });
    fs.writeFileSync(path.join(runnerPaths.binDir, 'pueued'), '');
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
      queueStatusCommand(runnerPaths),
      'systemctl --user daemon-reload',
      `systemctl --user enable --now ${serviceNames.systemdPueued} ${serviceNames.systemdLink}`,
      'loginctl show-user runner -p Linger',
      'loginctl enable-linger',
    ]);
    assert.match(result.lines.join('\n'), /Lingering switched on/);
    assert.equal(readServiceKind(runnerPaths), 'user-service');
  });

  it('refuses to install a service that would run under a Node.js in ANOTHER user\'s home — it would stop working the day that home is closed — and installs under one in the account\'s own home or a system place', async () => {
    pair();
    for (const nodePath of ['/Users/alice/.nvm/versions/node/v22/bin/node', '/home/bob/.local/bin/node']) {
      calls = [];
      const refused = await installService({ isSystem: false, userName: null }, createDeps({ nodePath }));
      assert.equal(refused.ok, false, nodePath);
      assert.match(refused.lines.join(' '), /^The service would depend on the Node\.js at \S+, which lives in the home folder of another user \(\S+\)\. It stops working when that folder is closed.*Pair again with a fresh line from \/runners: it installs the runner its own Node\.js, then run this again\.$/, nodePath);
      assert.deepEqual(calls, [], 'nothing was asked of a service manager');
    }
    for (const nodePath of [path.join(home, '.nvm', 'bin', 'node'), '/opt/homebrew/bin/node', '/usr/bin/node']) {
      assert.equal((await installService({ isSystem: false, userName: null }, createDeps({ nodePath }))).ok, true, nodePath);
    }
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

  it('Linux: without a user session the message says what to do; an unpaired account is told to pair first', async () => {
    pair();
    const noSession = await installService({ isSystem: false, userName: null }, createDeps({ runner: recordingRunner({ 'systemctl --user daemon-reload': { ok: false } }) }));
    assert.equal(noSession.ok, false);
    assert.match(noSession.lines.join('\n'), /cannot reach a user session/);
    assert.equal(readServiceKind(runnerPaths), null);
    assert.equal(fs.existsSync(path.join(home, '.config', 'systemd', 'user', getServiceNames(runnerPaths.root).systemdLink)), false, 'nothing is left installed');
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
    assert.deepEqual(commandLines(), [
      `systemctl --user disable --now ${serviceNames.systemdLink} ${serviceNames.systemdPueued}`,
      `systemctl --user show -p ActiveState --value ${serviceNames.systemdLink}`,
      `systemctl --user show -p ActiveState --value ${serviceNames.systemdPueued}`,
      'systemctl --user daemon-reload',
    ]);
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
      queueStatusCommand(runnerPaths),
      `launchctl bootout gui/501/${serviceNames.launchdPueued}`,
      `launchctl print gui/501/${serviceNames.launchdPueued}`,
      `launchctl bootstrap gui/501 ${pueuedPlist}`,
      `launchctl bootout gui/501/${serviceNames.launchdLink}`,
      `launchctl print gui/501/${serviceNames.launchdLink}`,
      `launchctl bootstrap gui/501 ${linkPlist}`,
    ]);
    assert.ok(!fs.readFileSync(linkPlist, 'utf8').includes('UserName'));
    assert.equal(readServiceKind(runnerPaths), 'user-service');
    assert.match(result.lines.join('\n'), /for always-on \(also logged out\), an admin can paste a fresh admin line from \/runners/i);
    assert.doesNotMatch(result.lines.join('\n'), /sudo/, 'no command that would run this account\'s own program as root');
  });

  it('macOS: uninstall boots both jobs out and deletes their files', async () => {
    pair();
    await installService({ isSystem: false, userName: null }, createDeps({ platform: 'darwin', uid: 501 }));
    calls = [];
    const serviceNames = getServiceNames(runnerPaths.root);
    const result = await uninstallService({ isSystem: false, userName: null }, createDeps({ platform: 'darwin', uid: 501 }));
    assert.equal(result.ok, true);
    assert.deepEqual(commandLines(), [
      `launchctl bootout gui/501/${serviceNames.launchdLink}`,
      `launchctl print gui/501/${serviceNames.launchdLink}`,
      `launchctl bootout gui/501/${serviceNames.launchdPueued}`,
      `launchctl print gui/501/${serviceNames.launchdPueued}`,
    ]);
    assert.deepEqual(fs.readdirSync(path.join(home, 'Library', 'LaunchAgents')), []);
    assert.equal(readServiceKind(runnerPaths), null);
  });

  it('starts nothing before the queue\'s configuration exists and the service record is written — the queue must start with its configuration, and the link must know a service owns the queue', async () => {
    pair();
    const seenAtStart: Array<{ command: string; hasConfig: boolean; kind: string | null }> = [];
    const inner = recordingRunner();
    const runner: CommandRunner = async (file, args) => {
      const command = `${file} ${args.join(' ')}`;
      if (command.includes('enable --now')) seenAtStart.push({ command, hasConfig: fs.existsSync(runnerPaths.pueueConfig), kind: readServiceKind(runnerPaths) });
      return inner(file, args, { timeoutMs: 1 });
    };
    assert.equal((await installService({ isSystem: false, userName: null }, createDeps({ runner }))).ok, true);
    assert.equal(seenAtStart.length, 1);
    assert.deepEqual({ hasConfig: seenAtStart[0].hasConfig, kind: seenAtStart[0].kind }, { hasConfig: true, kind: 'user-service' });

    calls = [];
    fs.rmSync(runnerPaths.serviceMarker);
    fs.rmSync(runnerPaths.pueueDir, { recursive: true });
    seenAtStart.length = 0;
    const mac = await installService({ isSystem: false, userName: null }, createDeps({ platform: 'darwin', uid: 501, runner: async (file, args) => {
      if (args[0] === 'bootstrap') seenAtStart.push({ command: `${file} ${args.join(' ')}`, hasConfig: fs.existsSync(runnerPaths.pueueConfig), kind: readServiceKind(runnerPaths) });
      return inner(file, args, { timeoutMs: 1 });
    } }));
    assert.equal(mac.ok, true, mac.lines.join('\n'));
    assert.ok(seenAtStart.length === 2 && seenAtStart.every((seen) => seen.hasConfig && seen.kind === 'user-service'), 'both launchd jobs start into a prepared state');
  });

  it('refuses to install while a foreground `run` is linked — and changes nothing', async () => {
    pair();
    fs.writeFileSync(runnerPaths.status, JSON.stringify({ pid: 4242, state: 'linked', sinceMs: 1, updatedAtMs: 1, lastError: null, activeJobs: 0, packageId: null }));
    const result = await installService({ isSystem: false, userName: null }, createDeps({ checkIsRunnerLink: (pid) => pid === 4242 }));
    assert.equal(result.ok, false);
    assert.match(result.lines.join('\n'), /foreground `charness-runner run` is linked \(pid 4242\)/);
    assert.deepEqual(commandLines(), [], 'not a command was run');
    assert.equal(readServiceKind(runnerPaths), null);
    assert.equal(fs.existsSync(path.join(home, '.config', 'systemd')), false);
  });

  it('a pid left in status.json by an earlier run (a reboot, a pid since taken by another program) is not a linked `run` and blocks nothing', async () => {
    pair();
    // This test process is alive but is not `runnerCli.js run`: with the real check the install goes on, with a bare «is the pid alive» it was refused for ever.
    fs.writeFileSync(runnerPaths.status, JSON.stringify({ pid: process.pid, state: 'linked', sinceMs: 1, updatedAtMs: 1, lastError: null, activeJobs: 0, packageId: null }));
    const result = await installService({ isSystem: false, userName: null }, createDeps({ checkIsRunnerLink: createServiceDeps().checkIsRunnerLink }));
    assert.doesNotMatch(result.lines.join('\n'), /foreground `charness-runner run` is linked/);
  });

  it('refuses to take over a queue that is running jobs — Pueue kills them when it stops — and an unreadable one', async () => {
    pair();
    const busy = await installService({ isSystem: false, userName: null }, createDeps({ runner: recordingRunner({ 'status --json': { ok: true, stdout: JSON.stringify({ tasks: { 0: { status: { Running: {} } }, 1: { status: { Queued: {} } } } }) } }) }));
    assert.equal(busy.ok, false);
    assert.match(busy.lines.join('\n'), /running 1 job\(s\)/);
    assert.ok(!commandLines().some((line) => line.includes('shutdown') || line.startsWith('systemctl')), 'the daemon was not asked to stop and nothing was started');
    assert.equal(readServiceKind(runnerPaths), null);

    calls = [];
    const unreadable = await installService({ isSystem: false, userName: null }, createDeps({ runner: recordingRunner({ 'status --json': { ok: true, stdout: 'not json' } }) }));
    assert.equal(unreadable.ok, false);
    assert.match(unreadable.lines.join('\n'), /cannot be read/);
    assert.ok(!commandLines().some((line) => line.startsWith('systemctl')));
  });

  it('shuts an IDLE unmanaged daemon down first, so the managed one can take the socket', async () => {
    pair();
    let isDaemonUp = true;
    const runner: CommandRunner = async (file, args) => {
      const command = `${file} ${args.join(' ')}`;
      calls.push({ file, args });
      if (command.includes('status --json')) return { ok: isDaemonUp, exitCode: isDaemonUp ? 0 : 1, stdout: isDaemonUp ? JSON.stringify({ tasks: { 0: { status: { Done: {} } } } }) : '', stderr: '', isTimedOut: false };
      if (command.includes(' shutdown')) isDaemonUp = false;
      if (command.endsWith(' status')) return { ok: isDaemonUp, exitCode: isDaemonUp ? 0 : 1, stdout: '', stderr: '', isTimedOut: false };
      return { ok: true, exitCode: 0, stdout: '', stderr: '', isTimedOut: false };
    };
    const result = await installService({ isSystem: false, userName: null }, createDeps({ runner }));
    assert.equal(result.ok, true, result.lines.join('\n'));
    const lines = commandLines();
    assert.ok(lines.findIndex((line) => line.includes(' shutdown')) < lines.findIndex((line) => line.includes('enable --now')), 'the daemon was shut down before the services started');
  });

  it('a re-install leaves the queue alone — the daemon is the service\'s own, never shut down — and looks at it first: replacing the service while a job runs would cut the job, so it is refused until the jobs are done', async () => {
    pair();
    fs.writeFileSync(runnerPaths.serviceMarker, 'user-service\n');
    const result = await installService({ isSystem: false, userName: null }, createDeps());
    assert.equal(result.ok, true);
    assert.ok(commandLines().some((line) => line.includes('status --json')), 'the queue was looked at');
    assert.ok(!commandLines().some((line) => line.includes(' shutdown')), 'and never asked to stop');

    calls = [];
    const busy = await installService({ isSystem: false, userName: null }, createDeps({ runner: recordingRunner({ 'status --json': { ok: true, stdout: JSON.stringify({ tasks: { 0: { status: { Running: {} } }, 1: { status: { Running: {} } } } }) } }) }));
    assert.equal(busy.ok, false);
    assert.match(busy.lines.join('\n'), /running 2 job\(s\): replacing the service now would cut them\. Let them finish .* or stop them .*charness remote-run kill <id>/);
    assert.ok(!commandLines().some((line) => line.startsWith('systemctl') || line.includes('enable --now')), 'nothing of the service was touched');

    calls = [];
    const unreadable = await installService({ isSystem: false, userName: null }, createDeps({ runner: recordingRunner({ 'status --json': { ok: true, stdout: 'not json' } }) }));
    assert.equal(unreadable.ok, false);
    assert.match(unreadable.lines.join('\n'), /cannot be read, so it cannot be told apart from one with running jobs: replacing the service now could cut them/);
  });

  it('refuses when Pueue is not installed yet: a unit that cannot start would only restart in a loop', async () => {
    pair();
    fs.rmSync(path.join(runnerPaths.binDir, 'pueued'));
    const result = await installService({ isSystem: false, userName: null }, createDeps());
    assert.equal(result.ok, false);
    assert.match(result.lines.join('\n'), /charness-runner check/);
    assert.deepEqual(commandLines(), []);
  });

  it('a start that fails is rolled back: the services are stopped, their files and the record removed — nothing half-installed', async () => {
    pair();
    const serviceNames = getServiceNames(runnerPaths.root);
    const result = await installService({ isSystem: false, userName: null }, createDeps({ runner: recordingRunner({ 'enable --now': { ok: false, stderr: 'Failed to enable unit: boom\n' } }) }));
    assert.equal(result.ok, false);
    assert.match(result.lines.join('\n'), /enable failed: Failed to enable unit: boom/);
    assert.match(result.lines.join('\n'), /Nothing was left installed/);
    assert.ok(commandLines().some((line) => line.startsWith(`systemctl --user disable --now ${serviceNames.systemdLink}`)), 'what may have started is stopped');
    assert.equal(fs.existsSync(path.join(home, '.config', 'systemd', 'user', serviceNames.systemdLink)), false);
    assert.equal(readServiceKind(runnerPaths), null);

    calls = [];
    const mac = await installService({ isSystem: false, userName: null }, createDeps({ platform: 'darwin', uid: 501, runner: recordingRunner({ 'launchctl bootstrap': { ok: false, stderr: 'Bootstrap failed: 5\n' } }) }));
    assert.equal(mac.ok, false);
    assert.deepEqual(fs.readdirSync(path.join(home, 'Library', 'LaunchAgents')), []);
    assert.equal(readServiceKind(runnerPaths), null);
  });

  describe('a RE-install that fails', () => {
    const agentDir = (): string => path.join(home, 'Library', 'LaunchAgents');

    /** A working launchd service whose two definitions are then replaced by text that tells them apart; returns their file names. */
    async function installWorkingAgents(): Promise<string[]> {
      const installed = await installService({ isSystem: false, userName: null }, createDeps({ platform: 'darwin', uid: 501 }));
      assert.equal(installed.ok, true, installed.lines.join('\n'));
      const plists = fs.readdirSync(agentDir());
      assert.equal(plists.length, 2);
      for (const plist of plists) fs.writeFileSync(path.join(agentDir(), plist), `<!-- the working ${plist} -->\n`);
      calls = [];
      return plists;
    }

    it('Linux: puts the working definitions back and touches no unit — it is not torn down, and its record stays', async () => {
      pair();
      fs.writeFileSync(runnerPaths.serviceMarker, 'user-service\n');
      const serviceNames = getServiceNames(runnerPaths.root);
      const unitDir = path.join(home, '.config', 'systemd', 'user');
      fs.mkdirSync(unitDir, { recursive: true });
      fs.writeFileSync(path.join(unitDir, serviceNames.systemdLink), '# the working link unit\n');
      fs.writeFileSync(path.join(unitDir, serviceNames.systemdPueued), '# the working queue unit\n');
      const result = await installService({ isSystem: false, userName: null }, createDeps({ runner: recordingRunner({ 'enable --now': { ok: false, stderr: 'Failed to enable unit: boom\n' } }) }));
      assert.equal(result.ok, false);
      assert.match(result.lines.join('\n'), /left as it was/);
      assert.doesNotMatch(result.lines.join('\n'), /Nothing was left installed/);
      assert.equal(fs.readFileSync(path.join(unitDir, serviceNames.systemdLink), 'utf8'), '# the working link unit\n');
      assert.equal(fs.readFileSync(path.join(unitDir, serviceNames.systemdPueued), 'utf8'), '# the working queue unit\n');
      assert.ok(!commandLines().some((line) => line.includes('disable --now')), 'the working units were not stopped');
      assert.equal(readServiceKind(runnerPaths), 'user-service', 'the record of the working service stays');
    });

    it('Linux: a file this install made new (the record said a service existed, the file did not) goes away again, and a reload that fails is said', async () => {
      pair();
      fs.writeFileSync(runnerPaths.serviceMarker, 'user-service\n');
      const serviceNames = getServiceNames(runnerPaths.root);
      const unitDir = path.join(home, '.config', 'systemd', 'user');
      const result = await installService({ isSystem: false, userName: null }, createDeps({ runner: recordingRunner({ 'enable --now': { ok: false, stderr: 'boom\n' } }) }));
      assert.equal(result.ok, false);
      assert.equal(fs.existsSync(path.join(unitDir, serviceNames.systemdLink)), false, 'no definition is left that was not there before');
      assert.equal(fs.existsSync(path.join(unitDir, serviceNames.systemdPueued)), false);

      const unreadable = await installService({ isSystem: false, userName: null }, createDeps({ runner: recordingRunner({ 'enable --now': { ok: false, stderr: 'boom\n' }, 'daemon-reload': { ok: false, stderr: 'no user session\n' } }) }));
      assert.match(unreadable.lines.join('\n'), /could not be asked to read them again: run `systemctl --user daemon-reload`/);
      assert.doesNotMatch(unreadable.lines.join('\n'), /left as it was/);
    });

    it('Mac: only the jobs the failed pass reached are loaded again — the one it never touched keeps running — and the definitions come back', async () => {
      pair();
      const plists = await installWorkingAgents();
      const mac = await installService({ isSystem: false, userName: null }, createDeps({ platform: 'darwin', uid: 501, runner: createLaunchdRunner({ failingBootstraps: [1] }) }));
      assert.equal(mac.ok, false);
      assert.match(mac.lines.join('\n'), /loaded again as it was/);
      for (const plist of plists) assert.equal(fs.readFileSync(path.join(agentDir(), plist), 'utf8'), `<!-- the working ${plist} -->\n`);
      const names = getServiceNames(runnerPaths.root);
      const bootstraps = commandLines().filter((line) => line.startsWith('launchctl bootstrap gui/501'));
      assert.equal(bootstraps.filter((line) => line.endsWith(`${names.launchdPueued}.plist`)).length, 2, 'the queue job: the new definition that failed, then the old one again');
      // The queue's label starts with the link's, so the link is recognised by its exact label and by its own file.
      assert.ok(!commandLines().some((line) => line === `launchctl bootout gui/501/${names.launchdLink}` || line.endsWith(`${names.launchdLink}.plist`)), 'the link job, which the failed pass never reached, was not booted out or bootstrapped');
      assert.equal(readServiceKind(runnerPaths), 'user-service');
    });

    it('Mac: when the old job cannot be loaded again either, it says so — never «loaded again as it was»', async () => {
      pair();
      await installWorkingAgents();
      const mac = await installService({ isSystem: false, userName: null }, createDeps({ platform: 'darwin', uid: 501, runner: createLaunchdRunner({ failingBootstraps: [1, 2] }) }));
      assert.equal(mac.ok, false);
      assert.match(mac.lines.join('\n'), /could NOT be loaded again .*run `charness-runner service install` again/);
      assert.doesNotMatch(mac.lines.join('\n'), /loaded again as it was/);
      assert.equal(readServiceKind(runnerPaths), 'user-service', 'the record stays: the install can simply be run again');
    });

    it('Mac: when the queue job loaded its new definition and the link job then failed, both old jobs are unloaded, waited for and loaded again — a reload right after an unload meets a job still being torn down', async () => {
      pair();
      const plists = await installWorkingAgents();
      const mac = await installService({ isSystem: false, userName: null }, createDeps({ platform: 'darwin', uid: 501, runner: createLaunchdRunner({ failingBootstraps: [2], teardownPrints: 2 }) }));
      assert.equal(mac.ok, false);
      assert.match(mac.lines.join('\n'), /loaded again as it was/, mac.lines.join('\n'));
      for (const plist of plists) assert.equal(fs.readFileSync(path.join(agentDir(), plist), 'utf8'), `<!-- the working ${plist} -->\n`);
      const names = getServiceNames(runnerPaths.root);
      for (const label of [names.launchdPueued, names.launchdLink]) {
        const lines = commandLines();
        const lastBootout = lines.lastIndexOf(`launchctl bootout gui/501/${label}`);
        const lastBootstrap = lines.map((line, index) => (line.startsWith('launchctl bootstrap gui/501') && line.endsWith(`${label}.plist`) ? index : -1)).filter((index) => index > -1).at(-1) ?? -1;
        assert.ok(lastBootout > -1 && lastBootstrap > lastBootout, `${label}: unloaded, then loaded again`);
        const printsBetween = lines.slice(lastBootout, lastBootstrap).filter((line) => line === `launchctl print gui/501/${label}`).length;
        assert.ok(printsBetween >= 2, `${label}: the unload was waited for — it was looked at again while launchd was still tearing the job down (${printsBetween} looks)`);
      }
    });

    it('Mac: a definition this install made new (it had no earlier file) is removed again', async () => {
      pair();
      fs.writeFileSync(runnerPaths.serviceMarker, 'user-service\n');
      const mac = await installService({ isSystem: false, userName: null }, createDeps({ platform: 'darwin', uid: 501, runner: createLaunchdRunner({ failingBootstraps: [1] }) }));
      assert.equal(mac.ok, false);
      assert.deepEqual(fs.existsSync(agentDir()) ? fs.readdirSync(agentDir()) : [], [], 'no plist is left that was not there before');
    });
  });

  describe('removal that does not work', () => {
    it('Linux: when the units cannot be stopped, or systemd cannot be asked, nothing is reported removed — the files and the record stay', async () => {
      pair();
      await installService({ isSystem: false, userName: null }, createDeps());
      const serviceNames = getServiceNames(runnerPaths.root);
      const linkUnit = path.join(home, '.config', 'systemd', 'user', serviceNames.systemdLink);

      const stillActive = await uninstallService({ isSystem: false, userName: null }, createDeps({ runner: recordingRunner({ 'disable --now': { ok: false, stderr: 'Failed to stop\n' }, 'show -p ActiveState': { stdout: 'active\n' } }) }));
      assert.equal(stillActive.ok, false);
      assert.match(stillActive.lines.join('\n'), /not removed: .* is still running \(active\)/);
      assert.equal(fs.existsSync(linkUnit), true);
      assert.equal(readServiceKind(runnerPaths), 'user-service');

      const noManager = await uninstallService({ isSystem: false, userName: null }, createDeps({ runner: recordingRunner({ 'disable --now': { ok: false }, 'show -p ActiveState': { ok: false, stderr: 'Failed to connect to bus\n' } }) }));
      assert.equal(noManager.ok, false);
      assert.match(noManager.lines.join('\n'), /cannot be asked whether/);
      assert.equal(fs.existsSync(linkUnit), true);
      assert.equal(readServiceKind(runnerPaths), 'user-service');
    });

    it('Linux: units that are already gone (disable fails, nothing is active) count as removed', async () => {
      pair();
      await installService({ isSystem: false, userName: null }, createDeps());
      const result = await uninstallService({ isSystem: false, userName: null }, createDeps({ runner: recordingRunner({ 'disable --now': { ok: false, stderr: 'Unit file does not exist\n' }, 'show -p ActiveState': { stdout: 'inactive\n' } }) }));
      assert.equal(result.ok, true);
      assert.equal(readServiceKind(runnerPaths), null);
    });

    it('macOS: a job that is still loaded after the bootout is not removed; one that is not loaded counts as removed', async () => {
      pair();
      await installService({ isSystem: false, userName: null }, createDeps({ platform: 'darwin', uid: 501 }));
      const agentDir = path.join(home, 'Library', 'LaunchAgents');
      const stillLoaded = await uninstallService({ isSystem: false, userName: null }, createDeps({ platform: 'darwin', uid: 501, runner: recordingRunner({ 'launchctl bootout': { ok: false, stderr: 'Boot-out failed: 5\n' }, 'launchctl print': { ok: true } }) }));
      assert.equal(stillLoaded.ok, false);
      assert.match(stillLoaded.lines.join('\n'), /not removed: .* is still loaded in gui\/501/);
      assert.equal(fs.readdirSync(agentDir).length, 2);
      assert.equal(readServiceKind(runnerPaths), 'user-service');

      const gone = await uninstallService({ isSystem: false, userName: null }, createDeps({ platform: 'darwin', uid: 501, runner: recordingRunner({ 'launchctl bootout': { ok: false, stderr: 'Could not find service\n' } }) }));
      assert.equal(gone.ok, true);
      assert.deepEqual(fs.readdirSync(agentDir), []);
    });

    it('macOS: a job launchd is still tearing down is waited for — not reported «still loaded» at the first look — so the services are removed', async () => {
      pair();
      await installService({ isSystem: false, userName: null }, createDeps({ platform: 'darwin', uid: 501 }));
      const removed = await uninstallService({ isSystem: false, userName: null }, createDeps({ platform: 'darwin', uid: 501, runner: createLaunchdRunner({ teardownPrints: 2 }) }));
      assert.equal(removed.ok, true, removed.lines.join('\n'));
      assert.deepEqual(fs.readdirSync(path.join(home, 'Library', 'LaunchAgents')), []);
      assert.equal(readServiceKind(runnerPaths), null);
    });
  });

  describe('the always-on service is the admin line\'s, not this program\'s', () => {
    function daemonPlists(): string[] {
      const serviceNames = getServiceNames(runnerPaths.root);
      return [`${serviceNames.launchdLink}.plist`, `${serviceNames.launchdPueued}.plist`].map((name) => path.join(daemonsDir, name));
    }

    it('--system is refused for install and uninstall, with the way that works — nothing runs, nothing is written', async () => {
      pair();
      for (const platform of ['darwin', 'linux'] as const) {
        const install = await installService({ isSystem: true, userName: 'runner' }, createDeps({ platform, uid: 0 }));
        assert.equal(install.ok, false);
        assert.match(install.lines.join('\n'), /An always-on service is installed by an admin, through a pairing line: paste a fresh admin line from \/runners/);
        assert.match(install.lines.join('\n'), /because it would run this account's own files as root/);
        const uninstall = await uninstallService({ isSystem: true, userName: 'runner' }, createDeps({ platform, uid: 0 }));
        assert.equal(uninstall.ok, false);
        assert.match(uninstall.lines.join('\n'), /removed by an admin with plain `launchctl` commands \(no charness program runs as root\)/);
      }
      assert.deepEqual(commandLines(), []);
      assert.equal(readServiceKind(runnerPaths), null);
    });

    describe('system-step: the account\'s own side of the install', () => {
      const asAccount = { platform: 'darwin' as const, uid: 501 };

      it('prepare — as the account — does what a user service\'s install does first: Pueue\'s configuration and the record, and answers in a way the admin step can read', async () => {
        pair();
        const answer = await runSystemStep('prepare', createDeps(asAccount));
        assert.deepEqual(answer, { ok: true, hadService: false });
        assert.equal(readServiceKind(runnerPaths), 'system-service');
        assert.equal(fs.existsSync(runnerPaths.pueueConfig), true);
        assert.equal(fs.existsSync(runnerPaths.logsDir), true, 'the logs folder: the login session\'s agent, a LaunchAgent, logs into it');
        assert.deepEqual(commandLines(), [queueStatusCommand(runnerPaths)], 'only the account\'s own queue was asked');
        calls = [];
        assert.deepEqual(await runSystemStep('prepare', createDeps(asAccount)), { ok: true, hadService: true }, 'a second time it is a re-install, and leaves the queue alone');
        assert.deepEqual(commandLines(), [queueStatusCommand(runnerPaths)], 'a re-install looks at the queue (it is refused while jobs run), and only looks');
      });

      it('prepare writes the login session\'s agent\'s definition into the ACCOUNT\'S OWN LaunchAgents folder: a job in its GUI session only, back after a crash only, its steps taken down with it', async () => {
        pair();
        await runSystemStep('prepare', createDeps(asAccount));
        const serviceNames = getServiceNames(runnerPaths.root);
        const agentFile = path.join(home, 'Library', 'LaunchAgents', `${serviceNames.launchdGui}.plist`);
        const text = fs.readFileSync(agentFile, 'utf8');
        const parsed = parseLaunchdPlist(text);
        assert.equal(parsed.strings.get('Label'), serviceNames.launchdGui);
        assert.deepEqual(parsed.programArguments, [runnerPaths.launcher, 'gui-agent']);
        assert.equal(parsed.strings.get('LimitLoadToSessionType'), 'Aqua');
        assert.ok(text.includes('<key>KeepAlive</key>\n  <dict><key>SuccessfulExit</key><false/></dict>'), 'restarted after a crash or an update\'s restart code, not after a clean exit');
        assert.ok(!text.includes('AbandonProcessGroup'), 'the steps go down with the agent');
        assert.ok(!parsed.keys.includes('UserName'), 'a LaunchAgent: it runs as whoever is logged in, in that session');
        assert.equal(parsed.strings.get('StandardOutPath'), path.join(runnerPaths.logsDir, 'gui-agent.log'));
        assert.equal(fs.statSync(agentFile).mode & 0o777, 0o644);
      });

      it('prepare forgets why the link could not put the agent in place itself: the admin step loads it next, and says so itself when it cannot', async () => {
        pair();
        writeGuiAgentInstallFailure(runnerPaths, { cure: 'login', reason: 'launchctl bootstrap gui/501 failed (Bootstrap failed: 5)' });
        await runSystemStep('prepare', createDeps(asAccount));
        assert.equal(readGuiAgentInstallFailure(runnerPaths), null);
      });

      it('a re-install is refused while the queue is running jobs — nothing is rewritten, the record and the agent\'s definition stay as they were', async () => {
        pair();
        await runSystemStep('prepare', createDeps(asAccount));
        const serviceNames = getServiceNames(runnerPaths.root);
        const agentFile = path.join(home, 'Library', 'LaunchAgents', `${serviceNames.launchdGui}.plist`);
        fs.writeFileSync(agentFile, 'the definition of the earlier install');
        const busy = await runSystemStep('prepare', createDeps({ ...asAccount, runner: recordingRunner({ 'status --json': { ok: true, stdout: JSON.stringify({ tasks: { 0: { status: { Running: {} } } } }) } }) }));
        assert.equal(busy.ok, false);
        assert.match(busy.ok ? '' : busy.lines.join('\n'), /running 1 job\(s\): replacing the service now would cut them/);
        assert.equal(fs.readFileSync(agentFile, 'utf8'), 'the definition of the earlier install');
        assert.equal(readServiceKind(runnerPaths), 'system-service');
      });

      it('prepare refuses what a user service\'s install refuses — an unpaired account, a linked foreground run, a busy queue — and a LaunchAgent that would clash', async () => {
        const unpaired = await runSystemStep('prepare', createDeps(asAccount));
        assert.equal(unpaired.ok, false);
        assert.match(unpaired.ok ? '' : unpaired.lines.join('\n'), /not paired yet/);
        pair();
        const serviceNames = getServiceNames(runnerPaths.root);
        fs.mkdirSync(path.join(home, 'Library', 'LaunchAgents'), { recursive: true });
        fs.writeFileSync(path.join(home, 'Library', 'LaunchAgents', `${serviceNames.launchdLink}.plist`), '');
        const clash = await runSystemStep('prepare', createDeps(asAccount));
        assert.match(clash.ok ? '' : clash.lines.join('\n'), /user service \(LaunchAgent\) is installed/);
        fs.rmSync(path.join(home, 'Library'), { recursive: true });
        const busy = await runSystemStep('prepare', createDeps({ ...asAccount, runner: recordingRunner({ 'status --json': { ok: true, stdout: JSON.stringify({ tasks: { 0: { status: { Running: {} } } } }) } }) }));
        assert.match(busy.ok ? '' : busy.lines.join('\n'), /queue of this runner is running 1 job/);
        assert.equal(readServiceKind(runnerPaths), null, 'a refusal leaves no record');
      });

      it('is the account\'s own: it refuses to run as root (root\'s home is not the account\'s), off a Mac, and for a step it does not know', async () => {
        pair();
        const asRoot = await runSystemStep('prepare', createDeps({ platform: 'darwin', uid: 0 }));
        assert.match(asRoot.ok ? '' : asRoot.lines.join('\n'), /must not run as root/);
        const onLinux = await runSystemStep('prepare', createDeps({ platform: 'linux', uid: 1000 }));
        assert.match(onLinux.ok ? '' : onLinux.lines.join('\n'), /for macOS/);
        const unknown = await runSystemStep('explode', createDeps(asAccount));
        assert.match(unknown.ok ? '' : unknown.lines.join('\n'), /unknown step: explode/);
        assert.equal(readServiceKind(runnerPaths), null);
        assert.deepEqual(commandLines(), []);
      });

      it('abandon forgets the record that prepare wrote — and only that: a user service\'s record stays', async () => {
        pair();
        await runSystemStep('prepare', createDeps(asAccount));
        const agentFile = path.join(home, 'Library', 'LaunchAgents', `${getServiceNames(runnerPaths.root).launchdGui}.plist`);
        assert.ok(fs.existsSync(agentFile));
        assert.deepEqual(await runSystemStep('abandon', createDeps(asAccount)), { ok: true, hadService: false });
        assert.equal(readServiceKind(runnerPaths), null);
        assert.equal(fs.existsSync(agentFile), false, 'the agent\'s definition of an install that did not happen goes too');
        fs.writeFileSync(runnerPaths.serviceMarker, 'user-service\n');
        await runSystemStep('abandon', createDeps(asAccount));
        assert.equal(readServiceKind(runnerPaths), 'user-service');
      });
    });

    it('a user service is not installed over an always-on one', async () => {
      pair();
      fs.writeFileSync(runnerPaths.serviceMarker, 'system-service\n');
      const result = await installService({ isSystem: false, userName: null }, createDeps({ platform: 'darwin', uid: 501 }));
      assert.equal(result.ok, false);
      assert.match(result.lines.join('\n'), /runs as a system service already/);
      assert.deepEqual(commandLines(), []);
    });

    it('uninstall of an always-on service from the account prints NO command — it points at the hub for them — stops nothing and forgets nothing while the daemons are there', async () => {
      pair();
      fs.writeFileSync(runnerPaths.serviceMarker, 'system-service\n');
      fs.mkdirSync(daemonsDir, { recursive: true });
      for (const plist of daemonPlists()) fs.writeFileSync(plist, '');
      const result = await uninstallService({ isSystem: false, userName: null }, createDeps({ platform: 'darwin', uid: 501 }));
      assert.equal(result.ok, false);
      assert.deepEqual(result.lines.slice(0, 2), ['This runner runs as a system service (always on), which only an admin can stop.', systemServiceRemovalPointer]);
      assert.ok(!result.lines.join('\n').match(/launchctl|sudo|\/Library\/LaunchDaemons/), 'no command comes from the account\'s own program — the agents can change what it prints');
      assert.match(result.lines.at(-1) ?? '', /run `charness-runner service uninstall` again here, as this account/);
      assert.equal(readServiceKind(runnerPaths), 'system-service');
      assert.ok(!commandLines().some((line) => line.includes('bootout') || line.includes('bootstrap')), 'no job is stopped from the account');
      assert.ok(fs.existsSync(daemonPlists()[0]), 'and no definition is touched');
    });

    it('once the admin removed the daemons — files gone and not loaded — uninstall forgets the record; while one is still loaded it does not', async () => {
      pair();
      fs.writeFileSync(runnerPaths.serviceMarker, 'system-service\n');
      const stillLoaded = await uninstallService({ isSystem: false, userName: null }, createDeps({ platform: 'darwin', uid: 501, runner: recordingRunner({ 'launchctl print': { ok: true } }) }));
      assert.equal(stillLoaded.ok, false, 'no file left, but launchd still has a job');
      assert.equal(readServiceKind(runnerPaths), 'system-service');
      calls = [];
      const agentFile = path.join(home, 'Library', 'LaunchAgents', `${getServiceNames(runnerPaths.root).launchdGui}.plist`);
      fs.mkdirSync(path.dirname(agentFile), { recursive: true });
      fs.writeFileSync(agentFile, 'the agent');
      const gone = await uninstallService({ isSystem: false, userName: null }, createDeps({ platform: 'darwin', uid: 501 }));
      assert.equal(gone.ok, true, gone.lines.join('\n'));
      assert.equal(readServiceKind(runnerPaths), null);
      assert.equal(fs.existsSync(agentFile), false, 'the login session\'s agent goes with the service');
      assert.ok(commandLines().includes(`launchctl bootout gui/501/${getServiceNames(runnerPaths.root).launchdGui}`), 'and is asked to leave the account\'s session');
    });
  });

  it('refuses a platform with neither systemd nor launchd', async () => {
    const result = await installService({ isSystem: false, userName: null }, createDeps({ platform: 'freebsd' }));
    assert.equal(result.ok, false);
    assert.match(result.lines.join('\n'), /not on freebsd/);
  });
});
