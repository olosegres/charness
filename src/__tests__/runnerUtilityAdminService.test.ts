/**
 * @description `runnerUtility/adminService.ts`: the ROOT step of the admin pairing line, against a recording command runner and a temp
 * folder as «/Library/LaunchDaemons». What these tests hold to: root writes only into the daemons folder and calls `launchctl` /
 * `loginctl`; everything of the account's — its launcher, Pueue, the record, its own user service — is reached only through
 * `sudo -u <account> -H`, never executed, read or written by root itself (the account runs the agents' code, so a link or a swapped
 * program in its folder must reach nothing of root's). Also the account lookups the step relies on.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { CommandResult, CommandRunner } from '../selfUpdate/commandRunner';
import { createAdminServiceDeps, installServiceForAccount, pairAccountFromPackage, type AdminServiceDeps, type PairRequest } from '../runnerUtility/adminService';
import { runCommandIsolated, type IsolatedCommandRunner } from '../runnerUtility/isolatedCommand';
import { formatSystemStepAnswer, resolveLinuxAccount, resolveMacAccount, type SystemStepAnswer, type TargetAccount } from '../runnerUtility/serviceCommon';
import { getRunnerHomePaths, type RunnerHomePaths } from '../runnerUtility/runnerHome';
import { getServiceNames } from '../runnerUtility/serviceUnits';
import { launchdOwnPathKeys, parseLaunchdPlist } from './launchdPlistKit';

interface Call {
  file: string;
  args: readonly string[];
}

let home = '';
let daemonsDir = '';
let calls: Call[] = [];
let given: Array<[string, number, number]> = [];
let accountPaths: RunnerHomePaths;
/** The output sinks the steps handed to the runner (a step that wants its output relayed passes one). */
let onOutputSeen: Array<NonNullable<Parameters<IsolatedCommandRunner>[2]['onOutput']>> = [];
let written: Array<[string, string]> = [];

const accountUid = 501;
const installedLines = 'Installed two user services: a (the link) and b (the queue).\nLingering is on: they run without a login and start at boot.\n';

function commandLines(): string[] {
  return calls.map((call) => `${call.file} ${call.args.join(' ')}`);
}

/** The step command of the account's launcher, as the admin step must spell it. */
function stepCommand(step: 'prepare' | 'abandon'): string {
  return `sudo -u runner -H ${accountPaths.launcher} service system-step ${step}`;
}

function answer(overrides: Partial<CommandResult> = {}): CommandResult {
  return { ok: true, exitCode: 0, stdout: '', stderr: '', isTimedOut: false, ...overrides };
}

/**
 * A runner that records every call and answers by fragment of the command line (first match wins): the account's preparation says
 * `prepared`, launchd has no job loaded unless a `launchctl print` answer says otherwise.
 */
function createRunner(answers: Record<string, Partial<CommandResult>> = {}, prepared: SystemStepAnswer | string = { ok: true, hadService: false }): IsolatedCommandRunner {
  return async (file, args, options) => {
    calls.push({ file, args });
    if (options.onOutput !== undefined) onOutputSeen.push(options.onOutput);
    const key = `${file} ${args.join(' ')}`;
    const matched = Object.entries(answers).find(([fragment]) => key.includes(fragment))?.[1];
    if (matched !== undefined) return answer({ ok: matched.ok ?? true, exitCode: (matched.ok ?? true) ? 0 : 1, ...matched });
    if (key.includes('system-step prepare')) return answer({ stdout: typeof prepared === 'string' ? prepared : formatSystemStepAnswer(prepared) });
    const isUnloaded = key.startsWith('launchctl print');
    return answer({ ok: !isUnloaded, exitCode: isUnloaded ? 113 : 0 });
  };
}

function createDeps(overrides: Partial<AdminServiceDeps> = {}): AdminServiceDeps {
  return {
    runner: createRunner(),
    write: (stream, text) => { written.push([stream, text]); },
    nodePath: '/opt/node/bin/node',
    runnerCliPath: '/tmp/charness-runner.abc/pkg/dist/runnerUtility/runnerCli.js',
    platform: 'darwin',
    uid: 0,
    nodeDir: '/opt/node/bin',
    launchDaemonsDir: daemonsDir,
    giveToRoot: (filePath, uid, gid) => { given.push([filePath, uid, gid]); },
    resolveAccount: async (name): Promise<TargetAccount | null> => (name === 'runner' ? { name, uid: accountUid, gid: 20, homeDir: home } : name === 'root' ? { name, uid: 0, gid: 0, homeDir: '/var/root' } : null),
    sleep: async () => undefined,
    ...overrides,
  };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'adm-'));
  daemonsDir = path.join(home, 'LaunchDaemons');
  accountPaths = getRunnerHomePaths(home);
  calls = [];
  given = [];
  onOutputSeen = [];
  written = [];
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('macOS: the daemons', () => {
  it('writes two LaunchDaemon definitions that run as the account, hands them to root:wheel without following a link, and loads them — the queue first', async () => {
    const result = await installServiceForAccount('runner', createDeps());
    assert.equal(result.ok, true, result.lines.join('\n'));
    const names = getServiceNames(accountPaths.root);
    const pueuedPlist = path.join(daemonsDir, `${names.launchdPueued}.plist`);
    const linkPlist = path.join(daemonsDir, `${names.launchdLink}.plist`);
    assert.deepEqual(commandLines(), [
      stepCommand('prepare'),
      `launchctl bootout system/${names.launchdPueued}`,
      `launchctl print system/${names.launchdPueued}`,
      `launchctl bootstrap system ${pueuedPlist}`,
      `launchctl bootout system/${names.launchdLink}`,
      `launchctl print system/${names.launchdLink}`,
      `launchctl bootstrap system ${linkPlist}`,
    ]);
    const plist = fs.readFileSync(linkPlist, 'utf8');
    assert.ok(plist.includes('<key>UserName</key><string>runner</string>'));
    assert.ok(plist.includes(accountPaths.launcher), 'the job runs the account\'s launcher — as the account');
    assert.equal(fs.statSync(linkPlist).mode & 0o777, 0o644);
    assert.deepEqual(given, [[pueuedPlist, 0, 0], [linkPlist, 0, 0]], 'only the definitions are given to root, and nothing of the account\'s');
    assert.deepEqual(result.lines, [`Installed two LaunchDaemons (${names.launchdLink}, ${names.launchdPueued}) that run as runner: always on, also logged out.`]);
  });

  it('the definitions root writes name nothing in the account\'s folder for anything launchd opens or enters itself (its output is /dev/null) — a link planted there reaches nothing of root\'s', async () => {
    const result = await installServiceForAccount('runner', createDeps());
    assert.equal(result.ok, true, result.lines.join('\n'));
    const files = fs.readdirSync(daemonsDir);
    assert.equal(files.length, 2);
    for (const file of files) {
      const parsed = parseLaunchdPlist(fs.readFileSync(path.join(daemonsDir, file), 'utf8'));
      assert.equal(parsed.strings.get('StandardOutPath'), '/dev/null', file);
      assert.equal(parsed.strings.get('StandardErrorPath'), '/dev/null', file);
      for (const key of launchdOwnPathKeys) assert.ok(!(parsed.strings.get(key) ?? '').startsWith(home), `${file}: ${key}`);
      assert.equal(parsed.programArguments[0], '/bin/sh');
    }
  });

  it('touches nothing of the account\'s but through the account: every call that names a path under its home is a `sudo -u <account> -H`, and root writes nothing there', async () => {
    const homeEntriesBefore = fs.readdirSync(home);
    await installServiceForAccount('runner', createDeps());
    for (const call of calls) {
      const mentionsAccountTree = call.args.some((argument) => argument.startsWith(accountPaths.root));
      if (mentionsAccountTree) assert.deepEqual([call.file, ...call.args.slice(0, 3)], ['sudo', '-u', 'runner', '-H'], `${call.file} ${call.args.join(' ')}`);
    }
    assert.deepEqual(fs.readdirSync(home).sort(), [...homeEntriesBefore, 'LaunchDaemons'].sort(), 'only the daemons folder was made');
    assert.equal(fs.existsSync(accountPaths.root), false, 'nothing under ~/.charness-runner');
    assert.equal(fs.existsSync(accountPaths.serviceMarker), false, 'the record is the account\'s to write');
  });

  it('renders the definitions from the account\'s name and home alone — an answer that says more decides nothing', async () => {
    const lying = JSON.stringify({ ok: true, hadService: false, UserName: 'root', lines: ['UserName root'], program: '/bin/sh' });
    const result = await installServiceForAccount('runner', createDeps({ runner: createRunner({}, lying) }));
    assert.equal(result.ok, true, result.lines.join('\n'));
    const programs: string[][] = [];
    for (const file of fs.readdirSync(daemonsDir)) {
      const plist = fs.readFileSync(path.join(daemonsDir, file), 'utf8');
      assert.ok(!plist.includes('<string>root</string>'), file);
      assert.ok(plist.includes('<key>UserName</key><string>runner</string>'), file);
      programs.push(parseLaunchdPlist(plist).programArguments.slice(5));
    }
    assert.deepEqual(programs.map((program) => path.basename(program[0])).sort(), ['charness-runner', 'pueued'], 'only the account\'s own launcher and queue, as the account\'s shell runs them');
  });

  it('stops with the account\'s own words when its preparation refuses, and loads nothing', async () => {
    const result = await installServiceForAccount('runner', createDeps({ runner: createRunner({}, { ok: false, lines: ['This account is not paired yet: run the line from /runners on this machine first, then install the service.'] }) }));
    assert.equal(result.ok, false);
    assert.deepEqual(result.lines, ['This account is not paired yet: run the line from /runners on this machine first, then install the service.']);
    assert.deepEqual(commandLines(), [stepCommand('prepare')]);
    assert.equal(fs.existsSync(daemonsDir), false);
  });

  it('stops when the account\'s program gives no answer it can read (not installed, crashed, a swapped program saying something else)', async () => {
    for (const output of ['', 'Segmentation fault', '{"ok":"yes"}', '{"ok":false}']) {
      calls = [];
      const result = await installServiceForAccount('runner', createDeps({ runner: createRunner({}, output) }));
      assert.equal(result.ok, false, output);
      assert.match(result.lines.join('\n'), /The account runner gave no answer to its preparation/);
      assert.deepEqual(commandLines(), [stepCommand('prepare')], output);
    }
    assert.equal(fs.existsSync(daemonsDir), false);
  });

  it('a first install that cannot load is rolled back — jobs stopped, definitions removed, the account asked to forget its record — and says nothing was left', async () => {
    const names = getServiceNames(accountPaths.root);
    const result = await installServiceForAccount('runner', createDeps({ runner: createRunner({ 'launchctl bootstrap': { ok: false, stderr: 'Bootstrap failed: 5\n' } }) }));
    assert.equal(result.ok, false);
    assert.match(result.lines.join('\n'), /launchctl bootstrap system failed for com\.charness\.runner\.pueued\.[0-9a-f]{8}: Bootstrap failed: 5/);
    assert.match(result.lines.join('\n'), /Nothing was left installed/);
    assert.deepEqual(fs.existsSync(daemonsDir) ? fs.readdirSync(daemonsDir) : [], []);
    assert.ok(commandLines().includes(stepCommand('abandon')), 'the account is asked to forget the record it wrote');
    assert.ok(commandLines().includes(`launchctl bootout system/${names.launchdLink}`));
  });

  it('a RE-install that cannot load puts the old definitions back, keeps the record, and names the way to try again: a fresh admin line', async () => {
    const names = getServiceNames(accountPaths.root);
    fs.mkdirSync(daemonsDir, { recursive: true });
    const pueuedPlist = path.join(daemonsDir, `${names.launchdPueued}.plist`);
    fs.writeFileSync(path.join(daemonsDir, `${names.launchdLink}.plist`), '<!-- the working link -->');
    fs.writeFileSync(pueuedPlist, '<!-- the working queue -->');
    const result = await installServiceForAccount('runner', createDeps({ runner: createRunner({ 'launchctl bootstrap': { ok: false, stderr: 'Bootstrap failed: 5\n' } }, { ok: true, hadService: true }) }));
    assert.equal(result.ok, false);
    assert.equal(fs.readFileSync(pueuedPlist, 'utf8'), '<!-- the working queue -->', 'the definition is back as it was');
    assert.match(result.lines.join('\n'), /could NOT be loaded again/);
    assert.match(result.lines.join('\n'), /paste a fresh admin line from \/runners/);
    assert.doesNotMatch(result.lines.join('\n'), /sudo/, 'no retry command that runs this account\'s program as root');
    assert.ok(!commandLines().includes(stepCommand('abandon')), 'a service that was there is not forgotten');
  });
});

describe('Linux: lingering and the account\'s own user service', () => {
  const asRunner = '-u runner -H env XDG_RUNTIME_DIR=/run/user/501';
  const managerCheck = `sudo ${asRunner} systemctl --user is-system-running`;

  function createLinuxDeps(runner: CommandRunner, overrides: Partial<AdminServiceDeps> = {}): AdminServiceDeps {
    return createDeps({ runner, platform: 'linux', ...overrides });
  }

  /** A runner whose user manager answers `states` to the first looks (the last one stays), and whose install says `installed`. */
  function createSessionRunner(states: string[], installed: Partial<CommandResult> = { stdout: installedLines }): CommandRunner {
    let looks = 0;
    const base = createRunner({ 'service install': installed });
    return async (file, args, options) => {
      const result = await base(file, args, options);
      if (file === 'sudo' && args.includes('is-system-running')) {
        const state = states[Math.min(looks, states.length - 1)];
        looks += 1;
        return { ...result, ok: state === 'running', exitCode: state === 'running' ? 0 : 1, stdout: `${state}\n` };
      }
      return result;
    };
  }

  it('switches lingering on as root, waits for the account\'s user manager, then runs the plain install AS the account — and returns what it said; root reads nothing of the account\'s', async () => {
    const result = await installServiceForAccount('runner', createLinuxDeps(createSessionRunner(['running'])));
    assert.equal(result.ok, true, result.lines.join('\n'));
    assert.deepEqual(commandLines(), [
      'loginctl enable-linger runner',
      managerCheck,
      `sudo ${asRunner} ${accountPaths.launcher} service install`,
    ]);
    assert.deepEqual(result.lines, installedLines.trim().split('\n'));
    assert.equal(fs.existsSync(accountPaths.root), false, 'the account has no folder at all in this test, and root did not mind: it asks the account');
    assert.equal(fs.existsSync(path.join(home, '.config')), false, 'root writes no unit itself');
  });

  it('waits while the manager is starting (once a second, up to 20 times) and accepts a degraded one', async () => {
    const sleeps: number[] = [];
    const slowly = await installServiceForAccount('runner', createLinuxDeps(createSessionRunner(['', 'starting', 'degraded']), { sleep: async (ms) => { sleeps.push(ms); } }));
    assert.equal(slowly.ok, true, slowly.lines.join('\n'));
    assert.deepEqual(sleeps, [1000, 1000], 'two looks failed, one wait after each');
    assert.equal(commandLines().filter((line) => line === managerCheck).length, 3);
  });

  it('gives up on a manager that never comes up, and installs nothing', async () => {
    const sleeps: number[] = [];
    const result = await installServiceForAccount('runner', createLinuxDeps(createSessionRunner(['']), { sleep: async (ms) => { sleeps.push(ms); } }));
    assert.equal(result.ok, false);
    assert.equal(sleeps.length, 19, '20 looks, a wait between each');
    assert.match(result.lines.join('\n'), /The user manager of runner did not come up within 20 s/);
    assert.ok(!commandLines().some((line) => line.endsWith('service install')), 'the install did not run');
  });

  it('stops at once when lingering cannot be switched on', async () => {
    const result = await installServiceForAccount('runner', createLinuxDeps(createRunner({ 'loginctl enable-linger': { ok: false, stderr: 'Failed to enable linger: no systemd\n' } })));
    assert.equal(result.ok, false);
    assert.deepEqual(result.lines, ['`loginctl enable-linger runner` failed: Failed to enable linger: no systemd']);
    assert.deepEqual(commandLines(), ['loginctl enable-linger runner']);
  });

  it('a failed install by the account is reported with its own words — the account says whether it is paired, root does not look', async () => {
    const result = await installServiceForAccount('runner', createLinuxDeps(createSessionRunner(['running'], { ok: false, exitCode: 1, stdout: 'This account is not paired yet: run the line from /runners on this machine first, then install the service.\n' })));
    assert.equal(result.ok, false);
    assert.deepEqual(result.lines, ['This account is not paired yet: run the line from /runners on this machine first, then install the service.']);
    const silent = await installServiceForAccount('runner', createLinuxDeps(createSessionRunner(['running'], { ok: false, exitCode: 127, stdout: '', stderr: 'sudo: charness-runner: command not found\n' })));
    assert.match(silent.lines.join('\n'), /sudo: charness-runner: command not found/);
  });
});

describe('who may be served', () => {
  it('needs root, an existing standard account and a platform with a service manager — and says so before it runs anything', async () => {
    const notRoot = await installServiceForAccount('runner', createDeps({ uid: 501 }));
    assert.match(notRoot.lines.join('\n'), /This step is root's/);
    const stranger = await installServiceForAccount('nobody-here', createDeps());
    assert.match(stranger.lines.join('\n'), /There is no account named «nobody-here»/);
    const root = await installServiceForAccount('root', createDeps());
    assert.match(root.lines.join('\n'), /not as root/);
    const other = await installServiceForAccount('runner', createDeps({ platform: 'win32' }));
    assert.match(other.lines.join('\n'), /not on win32/);
    assert.deepEqual(commandLines(), []);
  });

  it('finds the account in the passwd database: its uid, gid and home — and nothing for a name it does not answer for', async () => {
    const answering = (stdout: string, ok = true): CommandRunner => async () => answer({ ok, exitCode: ok ? 0 : 2, stdout });
    assert.deepEqual(await resolveLinuxAccount('runner', answering('runner:x:1002:1003:Runner,,,:/home/runner:/bin/bash\n')), { name: 'runner', uid: 1002, gid: 1003, homeDir: '/home/runner' });
    assert.equal(await resolveLinuxAccount('ghost', answering('', false)), null);
    assert.equal(await resolveLinuxAccount('runner', answering('someone:x:1:1::/home/someone:/bin/sh\n')), null, 'an answer for another name is no answer');
    assert.equal(await resolveLinuxAccount('runner', answering('runner:x:abc:1003::/home/runner:/bin/sh\n')), null);
    assert.equal(await resolveLinuxAccount('runner', answering('runner:x:1002:1003:::/bin/sh\n')), null, 'no home folder recorded');
  });

  it('finds a Mac account from id and dscl — and refuses one whose home folder the directory service does not give, instead of guessing /Users/<name>', async () => {
    const mac = (answers: { uid?: boolean; dscl?: string | null }): CommandRunner => async (file, args) => {
      if (file === 'id') return answer({ ok: answers.uid !== false, stdout: args[0] === '-u' ? '501\n' : '20\n' });
      return answers.dscl === null || answers.dscl === undefined ? answer({ ok: false, exitCode: 56, stderr: 'DS Error: -14136 (eDSRecordNotFound)' }) : answer({ stdout: answers.dscl });
    };
    assert.deepEqual(await resolveMacAccount('runner', mac({ dscl: 'NFSHomeDirectory: /Users/runner\n' })), { name: 'runner', uid: 501, gid: 20, homeDir: '/Users/runner' });
    assert.deepEqual(await resolveMacAccount('runner', mac({ dscl: 'NFSHomeDirectory: /Volumes/Data/people/runner\n' })), { name: 'runner', uid: 501, gid: 20, homeDir: '/Volumes/Data/people/runner' }, 'the home is the directory service\'s word, wherever it is');
    assert.equal(await resolveMacAccount('runner', mac({ dscl: null })), null, 'no answer from dscl: no guess');
    assert.equal(await resolveMacAccount('runner', mac({ dscl: 'NFSHomeDirectory: relative/home\n' })), null);
    assert.equal(await resolveMacAccount('runner', mac({ dscl: 'something else\n' })), null);
    assert.equal(await resolveMacAccount('runner', mac({ uid: false, dscl: 'NFSHomeDirectory: /Users/runner\n' })), null);
    const refused = await installServiceForAccount('runner', createDeps({ resolveAccount: async () => null }));
    assert.match(refused.lines.join('\n'), /There is no account named «runner», or its home folder cannot be read from the directory service\./);
    assert.deepEqual(commandLines(), []);
  });

  it('the real dependencies are the real thing: root-owned folder for the daemons, lchown for the definitions', () => {
    const deps = createAdminServiceDeps();
    assert.equal(deps.launchDaemonsDir, '/Library/LaunchDaemons');
    assert.equal(deps.giveToRoot, fs.lchownSync, 'a link in the daemons folder is never followed');
    assert.equal(deps.uid, os.userInfo().uid);
  });
});

describe('the pairing of the account, run from root\'s copy of the package', () => {
  const request: PairRequest = { bootstrapDir: '/tmp/charness-runner.abc/pkg', archivePath: '/tmp/charness-runner.abc/package.tgz', packageId: '0123456789abcdef', code: 'cr1.exampleCode' };

  it('runs the copy\'s pairing program AS the account (`sudo -u <account> -H <node> <program> pair …`), told that the service follows — not a program of the account\'s own', async () => {
    const result = await pairAccountFromPackage('runner', request, createDeps());
    assert.deepEqual(result, { ok: true, lines: [] });
    assert.deepEqual(commandLines(), ['sudo -u runner -H /opt/node/bin/node /tmp/charness-runner.abc/pkg/dist/runnerUtility/runnerCli.js pair --bootstrap /tmp/charness-runner.abc/pkg --archive /tmp/charness-runner.abc/package.tgz --package-id 0123456789abcdef --service-follows cr1.exampleCode']);
    assert.ok(!commandLines()[0].includes(accountPaths.root), 'nothing under the account\'s state folder is run');
  });

  it('hands its output sink to the runner, so what the account prints is relayed as it arrives — through the deps\' writer, to stdout or stderr as it was said', async () => {
    await pairAccountFromPackage('runner', request, createDeps());
    assert.equal(onOutputSeen.length, 1);
    onOutputSeen[0]('charness-runner: pairing with the hub\n', 'stdout');
    onOutputSeen[0]('trouble\n', 'stderr');
    assert.deepEqual(written, [['stdout', 'charness-runner: pairing with the hub\n'], ['stderr', 'trouble\n']]);
  });

  it('a failed pairing is a failure that says so — and names no service: nothing is installed for an account that was not paired', async () => {
    const result = await pairAccountFromPackage('runner', request, createDeps({ runner: createRunner({ 'runnerCli.js pair': { ok: false, exitCode: 1 } }) }));
    assert.equal(result.ok, false);
    assert.match(result.lines.join(' '), /pairing of runner failed \(exit 1\); see above/);
    assert.deepEqual(commandLines().filter((line) => line.includes('launchctl') || line.includes('loginctl') || line.includes('system-step')), []);
  });

  it('says so when the pairing does not finish within its deadline, and when it did not run at all', async () => {
    const timedOut = await pairAccountFromPackage('runner', request, createDeps({ runner: createRunner({ 'runnerCli.js pair': { ok: false, exitCode: null, isTimedOut: true } }) }));
    assert.match(timedOut.lines.join(' '), /did not finish within 30 minutes/);
    const notRun = await pairAccountFromPackage('runner', request, createDeps({ runner: createRunner({ 'runnerCli.js pair': { ok: false, exitCode: null } }) }));
    assert.match(notRun.lines.join(' '), /did not run to its end/);
  });

  it('is root\'s, for a standard account that exists, on a platform with a service manager — like the service step — and runs nothing otherwise', async () => {
    for (const [overrides, pattern] of [
      [{ uid: 1000 }, /This step is root's/],
      [{ platform: 'win32' as const }, /Services are supported on Linux/],
    ] as const) {
      calls = [];
      const result = await pairAccountFromPackage('runner', request, createDeps(overrides));
      assert.match(result.lines.join(' '), pattern);
      assert.deepEqual(calls, []);
    }
    assert.match((await pairAccountFromPackage('ghost', request, createDeps())).lines.join(' '), /There is no account named «ghost»/);
    assert.match((await pairAccountFromPackage('root', request, createDeps())).lines.join(' '), /not as root/);
    assert.deepEqual(calls, []);
  });
});

describe('no step of the account\'s has a terminal', () => {
  it('the real dependencies run everything as the account through the terminal-less runner — the pairing, the preparation, the user manager, the install and the account lookups alike', () => {
    const deps = createAdminServiceDeps();
    assert.equal(deps.runner, runCommandIsolated);
    assert.equal(deps.nodePath, process.execPath);
    assert.equal(path.basename(deps.runnerCliPath), 'runnerCli.js');
    assert.equal(path.dirname(deps.runnerCliPath), path.dirname(path.resolve(__dirname, '..', 'runnerUtility', 'adminService.ts')), 'next to this step\'s own file in the copy');
  });
});
