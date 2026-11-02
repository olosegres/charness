/**
 * @description `runners/bootstrapLine.ts`: the `sh` lines the operator pastes on the runner machine. They are run here by a real `sh`
 * with a stand-in `ssh` that serves a package: the key and the pinned host key reach ssh as files, ssh is called with strict host key
 * checking and nothing else to log in with, the package is unpacked, the runner utility is handed the code — and the temp folder is gone.
 * The ADMIN line (`sudo sh -c '<checks>' sh '<script>' <account>`) is run the same way with stand-ins for `id`, `uname` and `sudo` (a
 * second real account is not available to a test): the checks refuse a missing, root or admin account BEFORE anything is paired, the
 * pairing runs through `sudo -u <account> -H`, and the account's launcher installs the service only after a pairing that succeeded.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { gzipSync } from 'zlib';
import { buildAdminBootstrapLine, buildBootstrapLine, checkIsAccountName, defaultRunnerAccount } from '../runners/bootstrapLine';
import { checkIsAdminAccount, linuxAdminGroups, macAdminGroup } from '../runnerUtility/adminCheck';
import { launcherPathInHome } from '../runnerUtility/runnerHome';
import { formatGateAnswerHead } from '../runners/gateProtocol';
import { encodePairCode } from '../runners/pairCode';
import { createTarArchive } from '../runners/tarArchive';
import { createPairCodePayload } from './runnersTestKit';

let workDir = '';

/** A stand-in `ssh` that records what it was given and serves the file `answer.bin`. */
function installStubSsh(binDir: string): void {
  fs.mkdirSync(binDir, { recursive: true });
  const script = [
    '#!/bin/sh',
    `echo "$@" > "${workDir}/ssh.args"`,
    'while [ $# -gt 0 ]; do',
    '  case "$1" in',
    `    -i) cp "$2" "${workDir}/key.copy" ;;`,
    `    -o) case "$2" in UserKnownHostsFile=*) cp "\${2#UserKnownHostsFile=}" "${workDir}/known_hosts.copy" ;; esac ;;`,
    '  esac',
    '  shift',
    'done',
    `cat "${workDir}/answer.bin"`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(binDir, 'ssh'), script, { mode: 0o755 });
}

/** What the hub's `bootstrap` sends: whatever its shell printed first (`noise`), then the gate's marker and the archive. */
function createBootstrapAnswer(noise: string = ''): Buffer {
  const runnerCli = 'console.log("RUNNER_CLI " + process.argv.slice(2).join(" "));\n';
  const archive = gzipSync(createTarArchive([{ path: 'dist/runnerUtility/runnerCli.js', content: Buffer.from(runnerCli), mode: 0o644 }]));
  const answer = Buffer.concat([Buffer.from(noise), Buffer.from(formatGateAnswerHead('bootstrap', { id: '0123456789abcdef' })), archive]);
  fs.writeFileSync(path.join(workDir, 'answer.bin'), answer);
  return answer;
}

function runLine(payload = createPairCodePayload()): ReturnType<typeof spawnSync> {
  return spawnSync('sh', ['-c', buildBootstrapLine(payload)], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${path.join(workDir, 'bin')}:${process.env.PATH}`, TMPDIR: path.join(workDir, 'tmp') },
  });
}

describe('bootstrap line', () => {
  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-'));
    fs.mkdirSync(path.join(workDir, 'tmp'));
  });
  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('is one line of `sh -c` with the code in it, and the script is valid sh', () => {
    const payload = createPairCodePayload();
    const line = buildBootstrapLine(payload);
    assert.ok(line.startsWith("sh -c '") && line.endsWith("'"));
    assert.ok(!line.includes('\n'));
    assert.ok(line.includes(encodePairCode(payload)));
    const script = line.slice("sh -c '".length, -1);
    assert.ok(!script.includes("'"));
    assert.equal(spawnSync('sh', ['-n', '-c', script]).status, 0);
  });

  it('carries no value that could end its quoting', () => {
    const line = buildBootstrapLine(createPairCodePayload());
    const script = line.slice("sh -c '".length, -1);
    assert.ok(!/[`\\]/.test(script.replace(/\\"/g, '').replace(/\\n/g, '')), 'no backtick and no stray backslash');
  });

  it('fetches the package with the pairing\'s key, strict host key checking and no agent, then hands the code to the runner utility', () => {
    const payload = createPairCodePayload({ host: 'hub.example', port: 2222, user: 'hubuser' });
    installStubSsh(path.join(workDir, 'bin'));
    createBootstrapAnswer();
    const result = spawnSync('sh', ['-c', buildBootstrapLine(payload)], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${path.join(workDir, 'bin')}:${process.env.PATH}`, TMPDIR: path.join(workDir, 'tmp') },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`^RUNNER_CLI pair --bootstrap \\S+/pkg --archive \\S+/package\\.tgz --package-id 0123456789abcdef ${encodePairCode(payload).replace(/\./g, '\\.')}$`, 'm'));

    const sshArgs = fs.readFileSync(path.join(workDir, 'ssh.args'), 'utf8');
    for (const expected of ['-T', '-F /dev/null', 'BatchMode=yes', 'IdentitiesOnly=yes', 'IdentityAgent=none', 'StrictHostKeyChecking=yes', 'GlobalKnownHostsFile=/dev/null', 'HostKeyAlias=charness-hub', '-p 2222', 'hubuser@hub.example bootstrap']) {
      assert.ok(sshArgs.includes(expected), expected);
    }
    assert.ok(!sshArgs.includes('StrictHostKeyChecking=no'));

    const body = (text: string): string => text.replace(/-----(BEGIN|END) OPENSSH PRIVATE KEY-----/g, '').replace(/\s+/g, '');
    assert.equal(body(fs.readFileSync(path.join(workDir, 'key.copy'), 'utf8')), body(payload.privateKey));
    assert.match(fs.readFileSync(path.join(workDir, 'key.copy'), 'utf8'), /^-----BEGIN OPENSSH PRIVATE KEY-----\n[^\n]{1,70}\n/);
    assert.equal(fs.readFileSync(path.join(workDir, 'known_hosts.copy'), 'utf8'), `charness-hub ${payload.hostKey}\n`);
  });

  it('skips what the hub\'s shell printed before the gate ran — a banner, a line without its newline — and unpacks the archive byte for byte', () => {
    installStubSsh(path.join(workDir, 'bin'));
    createBootstrapAnswer('Welcome to the hub!\nLast login: Sat Nov  1 12:00:00 2026\nunterminated banner');
    const payload = createPairCodePayload();
    const result = runLine(payload);
    assert.equal(result.status, 0, String(result.stderr));
    assert.match(String(result.stdout), /^RUNNER_CLI pair --bootstrap /m);
    assert.match(String(result.stdout), /--package-id 0123456789abcdef /, 'the id the hub announced travels on');
  });

  it('stops with a clear line when the answer has no marker (an expired line, a refusal), and cleans up', () => {
    installStubSsh(path.join(workDir, 'bin'));
    fs.writeFileSync(path.join(workDir, 'answer.bin'), 'Welcome to the hub!\n');
    const result = runLine();
    assert.notEqual(result.status, 0);
    assert.match(String(result.stderr), /the hub did not send the package/);
    assert.ok(!String(result.stdout).includes('RUNNER_CLI'));
    assert.deepEqual(fs.readdirSync(path.join(workDir, 'tmp')), []);
  });

  it('leaves nothing behind in the temp folder, not even the key', () => {
    installStubSsh(path.join(workDir, 'bin'));
    createBootstrapAnswer();
    const result = spawnSync('sh', ['-c', buildBootstrapLine(createPairCodePayload())], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${path.join(workDir, 'bin')}:${process.env.PATH}`, TMPDIR: path.join(workDir, 'tmp') },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readdirSync(path.join(workDir, 'tmp')), []);
  });

  it('stops with a clear line when ssh cannot fetch the package — an expired or used line is a refused key, not an empty answer — and still cleans up', () => {
    installStubSsh(path.join(workDir, 'bin'));
    fs.writeFileSync(path.join(workDir, 'bin', 'ssh'), '#!/bin/sh\necho "Permission denied" >&2\nexit 255\n', { mode: 0o755 });
    const result = spawnSync('sh', ['-c', buildBootstrapLine(createPairCodePayload())], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${path.join(workDir, 'bin')}:${process.env.PATH}`, TMPDIR: path.join(workDir, 'tmp') },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Permission denied/, 'ssh\'s own message stays');
    assert.match(result.stderr, /the hub refused or did not answer \(has the line expired or been used already\?/, 'and the line says what it probably means, which `set -e` used to cut off');
    assert.ok(!result.stdout.includes('RUNNER_CLI'));
    assert.deepEqual(fs.readdirSync(path.join(workDir, 'tmp')), []);
  });

  it('says what is missing when node is absent or too old, and cleans up', () => {
    installStubSsh(path.join(workDir, 'bin'));
    createBootstrapAnswer();
    const toolsBin = path.join(workDir, 'tools');
    fs.mkdirSync(toolsBin);
    for (const tool of ['sh', 'mktemp', 'rm', 'cat', 'tar', 'fold', 'mkdir', 'cp']) {
      const resolved = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
      if (resolved.startsWith('/')) fs.symlinkSync(resolved, path.join(toolsBin, tool));
    }
    const oldNodeBin = path.join(workDir, 'oldnode');
    fs.mkdirSync(oldNodeBin);
    fs.writeFileSync(path.join(oldNodeBin, 'node'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    for (const pathValue of [toolsBin, `${oldNodeBin}:${toolsBin}`]) {
      const result = spawnSync('/bin/sh', ['-c', buildBootstrapLine(createPairCodePayload())], {
        encoding: 'utf8',
        env: { ...process.env, PATH: pathValue, TMPDIR: path.join(workDir, 'tmp') },
      });
      assert.notEqual(result.status, 0, pathValue);
      assert.match(result.stderr, /Node\.js 22\.12 or newer is needed/);
      assert.deepEqual(fs.readdirSync(path.join(workDir, 'tmp')), []);
    }
  });
});

/** The accounts of a stand-in machine: `<name>` → `{ uid, groups, home }`. */
interface StubAccount {
  uid: number;
  groups: readonly string[];
}

const stubUserLine = 'sudo-stub';

/**
 * Stand-ins for what the admin line asks the machine: `id` (who is running, which accounts exist and in which groups), `uname`, and `sudo`
 * (`-u <account> -H <command>` runs the command with that account's HOME; every call is logged). The real `id` answers nothing here: a
 * test cannot create an account. Calls are logged to `stub.log` in order.
 */
function installAdminStubs(binDir: string, options: { runnerUid: number; os: string; accounts: Record<string, StubAccount> }): void {
  fs.mkdirSync(binDir, { recursive: true });
  const accountsDir = path.join(workDir, 'accounts');
  fs.mkdirSync(accountsDir, { recursive: true });
  for (const [name, account] of Object.entries(options.accounts)) {
    fs.writeFileSync(path.join(accountsDir, name), `${account.uid} ${account.groups.join(' ')}\n`);
    fs.mkdirSync(path.join(workDir, 'homes', name), { recursive: true });
  }
  fs.writeFileSync(path.join(binDir, 'id'), [
    '#!/bin/sh',
    `if [ "$1" = -u ] && [ -z "$2" ]; then echo ${options.runnerUid}; exit 0; fi`,
    `f="${accountsDir}/$2"`,
    '[ -f "$f" ] || { echo "id: $2: no such user" >&2; exit 1; }',
    'read uid groups < "$f"',
    'case "$1" in -u) echo "$uid";; -Gn) echo "$groups";; *) exit 2;; esac',
    '',
  ].join('\n'), { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, 'uname'), `#!/bin/sh\necho ${options.os}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, 'sudo'), [
    '#!/bin/sh',
    `echo "${stubUserLine} $1 $2 $3 $4" >> "${workDir}/stub.log"`,
    '[ "$1" = -u ] && [ "$3" = -H ] || exit 99',
    'user=$2; shift 3',
    `exec env HOME="${workDir}/homes/$user" USER="$user" LOGNAME="$user" "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
}

/** The account's launcher: logs its arguments. */
function installStubLauncher(account: string, exitCode = 0): void {
  const launcher = path.join(workDir, 'homes', account, launcherPathInHome);
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(launcher, `#!/bin/sh\necho "launcher $*" >> "${workDir}/stub.log"\nexit ${exitCode}\n`, { mode: 0o755 });
}

function readStubLog(): string[] {
  try {
    return fs.readFileSync(path.join(workDir, 'stub.log'), 'utf8').split('\n').filter((line) => line !== '');
  } catch {
    return [];
  }
}

function runAdminLine(account: string = defaultRunnerAccount, payload = createPairCodePayload()): ReturnType<typeof spawnSync> {
  return spawnSync('sh', ['-c', buildAdminBootstrapLine(payload, account).replace(/^sudo /, '')], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${path.join(workDir, 'bin')}:${process.env.PATH}`, TMPDIR: path.join(workDir, 'tmp') },
  });
}

function splitAdminLine(line: string): { root: string; pairing: string; account: string } {
  const match = /^sudo sh -c '([^']*)' sh '([^']*)' (\S+)$/.exec(line);
  if (match === null) throw new Error('not an admin line');
  return { root: match[1], pairing: match[2], account: match[3] };
}

describe('admin bootstrap line: how it is built', () => {
  it('is one line: sudo, the checks, then the pairing script as an argument, then the account as the LAST word («runner» unless named)', () => {
    const payload = createPairCodePayload();
    const line = buildAdminBootstrapLine(payload);
    assert.ok(!line.includes('\n'));
    const parts = splitAdminLine(line);
    assert.equal(parts.account, defaultRunnerAccount);
    assert.equal(defaultRunnerAccount, 'runner');
    assert.equal(splitAdminLine(buildAdminBootstrapLine(payload, 'ci.runner-2')).account, 'ci.runner-2');
    assert.ok(parts.pairing.includes(encodePairCode(payload)), 'the pairing script carries the code');
    for (const script of [parts.root, parts.pairing]) assert.equal(spawnSync('sh', ['-n', '-c', script]).status, 0, 'valid sh');
    assert.ok(!parts.root.includes(encodePairCode(payload)), 'the root part never sees the code');
  });

  it('the pairing script is the plain line\'s script plus the one flag that tells the pairing a service follows — and nothing else differs', () => {
    const payload = createPairCodePayload();
    const plain = /^sh -c '(.*)'$/.exec(buildBootstrapLine(payload))?.[1] ?? '';
    const { pairing } = splitAdminLine(buildAdminBootstrapLine(payload));
    assert.ok(!plain.includes('--service-follows'));
    assert.equal(pairing.replace(' --service-follows', ''), plain);
    assert.match(pairing, /--package-id "\$\{t##\*id=\}" --service-follows cr1\./);
  });

  it('carries no value that could end its quoting, and the account is checked before it is written', () => {
    const line = buildAdminBootstrapLine(createPairCodePayload());
    assert.equal(line.split("'").length, 5, 'exactly the four quotes that wrap the two scripts');
    for (const bad of ['', '-n', 'a b', 'x;y', '$(id)', 'a\'b', 'a`b', 'a\\b', 'a\nb', 'ä']) {
      assert.equal(checkIsAccountName(bad), false, JSON.stringify(bad));
      assert.throws(() => buildAdminBootstrapLine(createPairCodePayload(), bad), /plain account name/);
    }
    for (const good of ['runner', 'ci-runner', 'ci.runner', 'Runner_2', '_svc', '9lives']) assert.equal(checkIsAccountName(good), true, good);
  });

});

describe('admin bootstrap line: the checks as root, the switch, the service', () => {
  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abl-'));
    fs.mkdirSync(path.join(workDir, 'tmp'));
    installStubSsh(path.join(workDir, 'bin'));
    createBootstrapAnswer();
  });
  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  const standardAccount: StubAccount = { uid: 4242, groups: ['runner', 'staff'] };

  it('pairs AS the account and then installs its service — in that order — and the pairing is told a service follows', () => {
    installAdminStubs(path.join(workDir, 'bin'), { runnerUid: 0, os: 'Linux', accounts: { runner: standardAccount } });
    installStubLauncher('runner');
    const result = runAdminLine();
    assert.equal(result.status, 0, String(result.stderr));
    assert.match(String(result.stdout), /^RUNNER_CLI pair --bootstrap \S+\/pkg --archive \S+\/package\.tgz --package-id 0123456789abcdef --service-follows cr1\./m);
    assert.deepEqual(readStubLog(), [
      `${stubUserLine} -u runner -H cd&&pwd`.replace('cd&&pwd', 'sh'),
      `${stubUserLine} -u runner -H sh`,
      'launcher service install --system --user runner',
    ]);
    assert.deepEqual(fs.readdirSync(path.join(workDir, 'tmp')), [], 'the pairing script cleaned up');
  });

  it('works for the account named last, whatever it is called', () => {
    installAdminStubs(path.join(workDir, 'bin'), { runnerUid: 0, os: 'Darwin', accounts: { 'ci.runner': standardAccount } });
    installStubLauncher('ci.runner');
    const result = runAdminLine('ci.runner');
    assert.equal(result.status, 0, String(result.stderr));
    assert.equal(readStubLog().at(-1), 'launcher service install --system --user ci.runner');
  });

  it('does not install the service when the pairing failed (and says nothing more than the pairing said)', () => {
    installAdminStubs(path.join(workDir, 'bin'), { runnerUid: 0, os: 'Linux', accounts: { runner: standardAccount } });
    installStubLauncher('runner');
    fs.writeFileSync(path.join(workDir, 'bin', 'ssh'), '#!/bin/sh\necho "Permission denied" >&2\nexit 255\n', { mode: 0o755 });
    const result = runAdminLine();
    assert.notEqual(result.status, 0);
    assert.match(String(result.stderr), /the hub refused or did not answer/);
    assert.ok(!readStubLog().some((line) => line.startsWith('launcher')), 'no service for an account that was not paired');
    assert.deepEqual(fs.readdirSync(path.join(workDir, 'tmp')), []);
  });

  it('passes the failure of the service install on as its own exit status', () => {
    installAdminStubs(path.join(workDir, 'bin'), { runnerUid: 0, os: 'Linux', accounts: { runner: standardAccount } });
    installStubLauncher('runner', 3);
    assert.equal(runAdminLine().status, 3);
  });

  it('refuses to run without root, before touching anything', () => {
    installAdminStubs(path.join(workDir, 'bin'), { runnerUid: 1000, os: 'Linux', accounts: { runner: standardAccount } });
    const result = runAdminLine();
    assert.notEqual(result.status, 0);
    assert.match(String(result.stderr), /run this line with sudo/);
    assert.deepEqual(readStubLog(), []);
  });

  it('stops on an account that does not exist — names it, creates nothing, pairs nothing', () => {
    installAdminStubs(path.join(workDir, 'bin'), { runnerUid: 0, os: 'Linux', accounts: { someoneelse: standardAccount } });
    const result = runAdminLine('runner');
    assert.notEqual(result.status, 0);
    assert.match(String(result.stderr), /no account runner here: create a standard user, or end the line with the right name/);
    assert.deepEqual(readStubLog(), [], 'no sudo -u: nothing ran as anyone');
    assert.ok(!fs.existsSync(path.join(workDir, 'homes', 'runner')), 'no account or home was made');
    assert.ok(!String(result.stdout).includes('RUNNER_CLI'));
  });

  it('refuses root as the account', () => {
    installAdminStubs(path.join(workDir, 'bin'), { runnerUid: 0, os: 'Linux', accounts: { root: { uid: 0, groups: ['root'] } } });
    const result = runAdminLine('root');
    assert.notEqual(result.status, 0);
    assert.match(String(result.stderr), /root is root: use a standard user/);
    assert.deepEqual(readStubLog(), []);
  });

  it('refuses a name that is not an account name — also when the line was edited by hand — without running any of it', () => {
    installAdminStubs(path.join(workDir, 'bin'), { runnerUid: 0, os: 'Linux', accounts: { runner: standardAccount } });
    const line = buildAdminBootstrapLine(createPairCodePayload());
    const marker = path.join(workDir, 'pwned');
    for (const edited of ['', '-n', 'a b', 'x;y', '$(touch pwned)', 'runner;touch pwned']) {
      const result = spawnSync('sh', ['-c', `${line.slice(0, line.length - ' runner'.length).replace(/^sudo /, '')} '${edited}'`], {
        encoding: 'utf8',
        cwd: workDir,
        env: { ...process.env, PATH: `${path.join(workDir, 'bin')}:${process.env.PATH}`, TMPDIR: path.join(workDir, 'tmp') },
      });
      assert.notEqual(result.status, 0, JSON.stringify(edited));
      assert.match(String(result.stderr), /is not an account name/, JSON.stringify(edited));
    }
    assert.ok(!fs.existsSync(marker), 'nothing in the name was executed');
    assert.deepEqual(readStubLog(), []);
  });

  it('refuses a system that is neither macOS nor Linux', () => {
    installAdminStubs(path.join(workDir, 'bin'), { runnerUid: 0, os: 'FreeBSD', accounts: { runner: standardAccount } });
    const result = runAdminLine();
    assert.notEqual(result.status, 0);
    assert.match(String(result.stderr), /only macOS and Linux are supported/);
    assert.deepEqual(readStubLog(), []);
  });

  it('refuses an account without a home folder, before pairing it', () => {
    installAdminStubs(path.join(workDir, 'bin'), { runnerUid: 0, os: 'Linux', accounts: { runner: standardAccount } });
    fs.rmSync(path.join(workDir, 'homes', 'runner'), { recursive: true });
    const result = runAdminLine();
    assert.notEqual(result.status, 0);
    assert.ok(!String(result.stdout).includes('RUNNER_CLI'));
    assert.ok(!readStubLog().some((line) => line.startsWith('launcher')));
  });

  /** Every combination of system, uid and groups the runner-side check knows: the line and `checkIsAdminAccount` must say the same. */
  const adminFacts: Array<{ platform: NodeJS.Platform; os: string; groups: string[] }> = [
    ...['staff', 'wheel', 'sudo', 'admin', 'admin staff', 'staff _developer'].map((groups) => ({ platform: 'darwin' as const, os: 'Darwin', groups: groups.split(' ') })),
    ...['users', 'sudo', 'wheel', 'admin', 'users sudo', 'docker', 'runner users'].map((groups) => ({ platform: 'linux' as const, os: 'Linux', groups: groups.split(' ') })),
  ];
  for (const facts of adminFacts) {
    it(`${facts.os} with groups «${facts.groups.join(' ')}»: the line refuses exactly what checkIsAdminAccount calls admin`, () => {
      installAdminStubs(path.join(workDir, 'bin'), { runnerUid: 0, os: facts.os, accounts: { runner: { uid: 4242, groups: facts.groups } } });
      installStubLauncher('runner');
      const isAdmin = checkIsAdminAccount({ platform: facts.platform, uid: 4242, groups: facts.groups });
      const result = runAdminLine();
      if (isAdmin) {
        assert.notEqual(result.status, 0);
        assert.match(String(result.stderr), /runner is an admin account: the agents code would run with its rights/);
        assert.deepEqual(readStubLog(), [], 'refused before anything ran as the account');
      } else {
        assert.equal(result.status, 0, String(result.stderr));
      }
    });
  }

  it('the admin groups of the line are the runner utility\'s own lists', () => {
    const { root } = splitAdminLine(buildAdminBootstrapLine(createPairCodePayload()));
    assert.ok(root.includes(`Darwin) g="${macAdminGroup}"`));
    assert.ok(root.includes(`Linux) g="${linuxAdminGroups.join(' ')}"`));
  });
});
