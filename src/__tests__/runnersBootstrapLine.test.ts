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
import { buildAdminBootstrapLine, buildBootstrapLine, checkIsAccountName, defaultRunnerAccount, renderNodePickSteps } from '../runners/bootstrapLine';
import { checkIsAdminAccount, linuxAdminGroups, macAdminGroup } from '../runnerUtility/adminCheck';
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
  // The stand-in programs say where they run from and, for the admin line, how the root-made folder looks to another account.
  const runnerCli = [
    'const fs = require("fs"); const path = require("path");',
    'const packageDir = path.resolve(__dirname, "..", "..");',
    'const mode = (file) => (fs.statSync(file).mode & 0o777).toString(8);',
    'console.log("RUNNER_CLI " + process.argv.slice(2).join(" "));',
    'console.log("RUNNER_CLI_FROM " + packageDir);',
    'console.log("MODES folder=" + mode(path.dirname(packageDir)) + " package=" + mode(packageDir) + " key=" + mode(path.join(path.dirname(packageDir), "key")));',
    'if (process.env.STUB_PAIR_FAILS) process.exit(1);',
    '',
  ].join('\n');
  const rootServiceCli = [
    'const fs = require("fs"); const path = require("path");',
    'const packageDir = path.resolve(__dirname, "..", "..");',
    'const mode = (file) => (fs.statSync(file).mode & 0o777).toString(8);',
    'console.log("ROOT_SERVICE " + process.argv.slice(2).join(" "));',
    'console.log("ROOT_SERVICE_FROM " + packageDir);',
    'console.log("MODES folder=" + mode(path.dirname(packageDir)) + " package=" + mode(packageDir) + " key=" + mode(path.join(path.dirname(packageDir), "key")));',
    'if (process.env.STUB_ROOT_STEP_FAILS) process.exit(3);',
    '',
  ].join('\n');
  const archive = gzipSync(createTarArchive([
    { path: 'dist/runnerUtility/runnerCli.js', content: Buffer.from(runnerCli), mode: 0o644 },
    { path: 'dist/runnerUtility/rootServiceCli.js', content: Buffer.from(rootServiceCli), mode: 0o644 },
  ]));
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
    for (const expected of ['-T', '-F /dev/null', 'BatchMode=yes', 'IdentitiesOnly=yes', 'IdentityAgent=none', 'StrictHostKeyChecking=yes', 'GlobalKnownHostsFile=/dev/null', 'HostKeyAlias=hub', '-p 2222', 'hubuser@hub.example bootstrap']) {
      assert.ok(sshArgs.includes(expected), expected);
    }
    assert.ok(!sshArgs.includes('StrictHostKeyChecking=no'));

    const body = (text: string): string => text.replace(/-----(BEGIN|END) OPENSSH PRIVATE KEY-----/g, '').replace(/\s+/g, '');
    assert.equal(body(fs.readFileSync(path.join(workDir, 'key.copy'), 'utf8')), body(payload.privateKey));
    assert.match(fs.readFileSync(path.join(workDir, 'key.copy'), 'utf8'), /^-----BEGIN OPENSSH PRIVATE KEY-----\n[^\n]{1,70}\n/);
    assert.equal(fs.readFileSync(path.join(workDir, 'known_hosts.copy'), 'utf8'), `hub ${payload.hostKey}\n`);
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

  it('says what it is doing before the long step, on stdout: «downloading the package from the hub», and only then the runner utility takes over', () => {
    installStubSsh(path.join(workDir, 'bin'));
    createBootstrapAnswer();
    const result = runLine();
    assert.equal(result.status, 0, String(result.stderr));
    const lines = String(result.stdout).split('\n');
    assert.equal(lines[0], 'charness-runner: downloading the package from the hub');
    assert.ok(lines.findIndex((line) => line.startsWith('RUNNER_CLI ')) > 0, 'the runner utility starts after the step line');
  });

  it('names the download step also when the hub then refuses it: the step on stdout, the refusal on stderr', () => {
    installStubSsh(path.join(workDir, 'bin'));
    fs.writeFileSync(path.join(workDir, 'bin', 'ssh'), '#!/bin/sh\necho "Permission denied" >&2\nexit 255\n', { mode: 0o755 });
    const result = runLine();
    assert.notEqual(result.status, 0);
    assert.equal(String(result.stdout), 'charness-runner: downloading the package from the hub\n');
    assert.match(String(result.stderr), /charness-runner: the hub refused or did not answer/);
  });

  it('stops with a clear line when the answer has no marker (an expired line, a refusal), and cleans up', () => {
    installStubSsh(path.join(workDir, 'bin'));
    fs.writeFileSync(path.join(workDir, 'answer.bin'), 'Welcome to the hub!\n');
    const result = runLine();
    assert.notEqual(result.status, 0);
    assert.match(String(result.stderr), /no package from the hub: expired or used line\?/);
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
    assert.match(result.stderr, /the hub refused or did not answer: expired or used line\? see the ssh message above/, 'and the line says what it probably means, which `set -e` used to cut off');
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

/** The accounts of a stand-in machine: `<name>` → `{ uid, groups }`; `groupsFail` makes `id -Gn <name>` fail the way a broken directory service does. */
interface StubAccount {
  uid: number;
  groups: readonly string[];
  groupsFail?: boolean;
}

const stubUserLine = 'sudo-stub';

/**
 * Stand-ins for what the admin line asks the machine: `id` (who is running, which accounts exist and in which groups), `uname`, and `sudo`
 * (`-u <account> -H <command>` runs the command with that account's HOME). The real `id` answers nothing here: a test cannot create an
 * account. Every `sudo` call is logged to `stub.log` with the program it starts and that program's first argument — so the pairing and any
 * other call as the account are told apart by what they run, not by how many there are.
 */
function installAdminStubs(binDir: string, options: { runnerUid: number; os: string; accounts: Record<string, StubAccount> }): void {
  fs.mkdirSync(binDir, { recursive: true });
  const accountsDir = path.join(workDir, 'accounts');
  fs.mkdirSync(accountsDir, { recursive: true });
  for (const [name, account] of Object.entries(options.accounts)) {
    fs.writeFileSync(path.join(accountsDir, name), `${account.uid} ${account.groupsFail === true ? 'FAIL' : account.groups.join(' ')}\n`);
    fs.mkdirSync(path.join(workDir, 'homes', name), { recursive: true });
  }
  fs.writeFileSync(path.join(binDir, 'id'), [
    '#!/bin/sh',
    `if [ "$1" = -u ] && [ -z "$2" ]; then echo ${options.runnerUid}; exit 0; fi`,
    `f="${accountsDir}/$2"`,
    '[ -f "$f" ] || { echo "id: $2: no such user" >&2; exit 1; }',
    'read uid groups < "$f"',
    'case "$1" in',
    '  -u) echo "$uid";;',
    '  -Gn) if [ "$groups" = FAIL ]; then echo "id: cannot get groups" >&2; exit 1; fi; echo "$groups";;',
    '  *) exit 2;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, 'uname'), `#!/bin/sh\necho ${options.os}\n`, { mode: 0o755 });
  // A Node outside every home folder, for the line to pick: a small program that hands over to the Node running this test (the test's own is
  // in somebody's `~/.nvm`, which the line rightly refuses), and says it was started.
  fs.writeFileSync(path.join(binDir, 'node'), `#!/bin/sh\necho started >> "${workDir}/node.log"\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, 'sudo'), [
    '#!/bin/sh',
    // sudo -u <account> [-H] <command> …: the command runs as the real user, with the account's home
    `echo "${stubUserLine} $1 $2 $3 $(basename -- "$4") $(basename -- "$5") $6" >> "${workDir}/stub.log"`,
    '[ "$1" = -u ] || exit 99',
    'user=$2; shift 2',
    '[ "$1" = -H ] && shift',
    `exec env HOME="${workDir}/homes/$user" USER="$user" LOGNAME="$user" "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
}

/** The sudo calls that RAN something as an account: the shell's probes of the Node (`sudo -u <account> test -x …`) execute nothing of the account's and are left out. */
function readAccountRuns(): string[] {
  return readStubLog().filter((line) => !/^sudo-stub -u \S+ test /.test(line));
}

function readStubLog(): string[] {
  try {
    return fs.readFileSync(path.join(workDir, 'stub.log'), 'utf8').split('\n').filter((line) => line !== '');
  } catch {
    return [];
  }
}

function runAdminLine(account: string = defaultRunnerAccount, extraEnv: NodeJS.ProcessEnv = {}, payload = createPairCodePayload()): ReturnType<typeof spawnSync> {
  return spawnSync('sh', ['-c', buildAdminBootstrapLine(payload, account).replace(/^sudo /, '')], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${path.join(workDir, 'bin')}:${process.env.PATH}`, TMPDIR: path.join(workDir, 'tmp'), ...extraEnv },
  });
}

function splitAdminLine(line: string): { script: string; account: string } {
  const match = /^sudo sh -c '([^']*)' sh (\S+)$/.exec(line);
  if (match === null) throw new Error('not an admin line');
  return { script: match[1], account: match[2] };
}

describe('admin bootstrap line: how it is built', () => {
  it('is one line: sudo, the script, then the account as the LAST word («runner» unless named)', () => {
    const payload = createPairCodePayload();
    const line = buildAdminBootstrapLine(payload);
    assert.ok(!line.includes('\n'));
    const parts = splitAdminLine(line);
    assert.equal(parts.account, defaultRunnerAccount);
    assert.equal(defaultRunnerAccount, 'runner');
    assert.equal(splitAdminLine(buildAdminBootstrapLine(payload, 'ci.runner-2')).account, 'ci.runner-2');
    assert.equal(parts.script.split(encodePairCode(payload)).length, 2, 'the code is in the script once');
    assert.equal(spawnSync('sh', ['-n', '-c', parts.script]).status, 0, 'valid sh');
  });

  it('the root copy is made BY ROOT in a folder of its own that the account can read, without taking owners from the archive; the plain line has none of that', () => {
    const payload = createPairCodePayload();
    const { script } = splitAdminLine(buildAdminBootstrapLine(payload));
    assert.ok(script.includes('d=$(mktemp -d "/tmp/charness-runner.XXXXXXXX")'), 'not the admin\'s own private $TMPDIR, which the account could not enter');
    assert.ok(script.includes('chmod 755 "$d"'));
    assert.ok(script.includes('umask 022; tail -c'), 'the archive and the package are readable — after the key files were made private');
    assert.ok(script.includes('tar --no-same-owner -xzf'), 'root\'s copy stays root\'s');
    const plain = /^sh -c '(.*)'$/.exec(buildBootstrapLine(payload))?.[1] ?? '';
    for (const forAccountOnly of ['chmod 755', 'umask 022', '--no-same-owner', '"/tmp/charness-runner']) assert.ok(!plain.includes(forAccountOnly), forAccountOnly);
    assert.ok(plain.includes('${TMPDIR:-/tmp}/charness-runner.'));
  });

  it('runs the root step from that copy — never from the account\'s folder — and hands it the pairing: the shell has no `sudo -u` of its own, so nothing of the account\'s runs outside the root step\'s terminal-less runner', () => {
    const { script } = splitAdminLine(buildAdminBootstrapLine(createPairCodePayload()));
    assert.match(script, /; "\$n" "\$d\/pkg\/dist\/runnerUtility\/rootServiceCli\.js" install "\$a" --bootstrap "\$d\/pkg" --archive "\$d\/package\.tgz" --package-id "\$\{t##\*id=\}" cr1\./);
    assert.equal(script.split('sudo -u').length, 2, 'the one `sudo -u` is the probe of the Node (below): no step of the account\'s is run by the shell, with the admin\'s terminal attached');
    assert.ok(script.includes('sudo -u "$a" test -x "$r" || continue'));
    assert.ok(!script.includes('runnerCli.js'), 'the account\'s pairing program is started by the root step');
    assert.ok(!script.includes('.charness-runner'), 'root is never pointed at the account\'s state folder or launcher');
    assert.ok(!script.includes('service install'), 'and never asked to run the account\'s `service install`');
  });

  it('carries no value that could end its quoting, and the account is checked before it is written', () => {
    const line = buildAdminBootstrapLine(createPairCodePayload());
    assert.equal(line.split("'").length, 3, 'exactly the two quotes that wrap the script');
    for (const bad of ['', '-n', 'a b', 'x;y', '$(id)', 'a\'b', 'a`b', 'a\\b', 'a\nb', 'ä']) {
      assert.equal(checkIsAccountName(bad), false, JSON.stringify(bad));
      assert.throws(() => buildAdminBootstrapLine(createPairCodePayload(), bad), /plain account name/);
    }
    for (const good of ['runner', 'ci-runner', 'ci.runner', 'Runner_2', '_svc', '9lives']) assert.equal(checkIsAccountName(good), true, good);
  });
});

describe('admin bootstrap line: the checks as root, the root-owned copy, the switch, the root step', () => {
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

  function readPrinted(result: ReturnType<typeof spawnSync>, label: string): string {
    return new RegExp(`^${label} (.*)$`, 'm').exec(String(result.stdout))?.[1] ?? '';
  }

  it('fetches ONE copy as root and runs the root step from it, handing it the pairing — the shell itself runs nothing as the account', () => {
    installAdminStubs(path.join(workDir, 'bin'), { runnerUid: 0, os: 'Linux', accounts: { runner: standardAccount } });
    const result = runAdminLine();
    assert.equal(result.status, 0, String(result.stderr));
    assert.match(String(result.stdout), /^ROOT_SERVICE install runner --bootstrap \S+\/pkg --archive \S+\/package\.tgz --package-id 0123456789abcdef cr1\./m, 'one program does the pairing and then the service: it is handed the pairing');
    const pairedFrom = readPrinted(result, 'ROOT_SERVICE_FROM');
    assert.match(pairedFrom, /^\/tmp\/charness-runner\.[A-Za-z0-9]{8}\/pkg$/, 'a folder of root\'s own in /tmp');
    assert.ok(!pairedFrom.startsWith(path.join(workDir, 'homes')), 'nothing runs from the account\'s home');
    assert.equal(readFileLines(path.join(workDir, 'ssh.args')).length, 1, 'the package was downloaded once');
    assert.equal(fs.existsSync(pairedFrom), false, 'and the copy is gone when the line ends');
  });

  it('names each step as it goes, on stdout: the account check (naming the account), then the download — before the root step, which prints its own', () => {
    installAdminStubs(path.join(workDir, 'bin'), { runnerUid: 0, os: 'Linux', accounts: { runner: standardAccount } });
    const result = runAdminLine();
    assert.equal(result.status, 0, String(result.stderr));
    const output = String(result.stdout);
    const positions = ['charness-runner: checking the account runner\n', 'charness-runner: downloading the package from the hub\n', 'ROOT_SERVICE install'].map((text) => output.indexOf(text));
    assert.ok(positions.every((position) => position >= 0), output);
    assert.deepEqual([...positions].sort((left, right) => left - right), positions, 'in that order');
  });

  it('a refused account has said its check step and never reaches the download', () => {
    installAdminStubs(path.join(workDir, 'bin'), { runnerUid: 0, os: 'Linux', accounts: { someoneelse: standardAccount } });
    const result = runAdminLine('runner');
    assert.notEqual(result.status, 0);
    assert.equal(String(result.stdout), 'charness-runner: checking the account runner\n');
    assert.match(String(result.stderr), /no account runner here/);
  });

  it('calls sudo not at all: everything that runs as the account is the root step\'s, which runs it with no terminal (`isolatedCommand.ts`) — a call for anything else would show', () => {
    installAdminStubs(path.join(workDir, 'bin'), { runnerUid: 0, os: 'Darwin', accounts: { runner: standardAccount } });
    const result = runAdminLine();
    assert.equal(result.status, 0, String(result.stderr));
    assert.deepEqual(readAccountRuns(), []);
  });

  it('shows the root-made folder to another account as readable, and the key as private — the root copy is world-readable, never writable, the key is not', () => {
    installAdminStubs(path.join(workDir, 'bin'), { runnerUid: 0, os: 'Linux', accounts: { runner: standardAccount } });
    const result = runAdminLine();
    assert.equal(result.status, 0, String(result.stderr));
    assert.equal(readPrinted(result, 'MODES'), 'folder=755 package=755 key=600');
  });

  it('works for the account named last, whatever it is called', () => {
    installAdminStubs(path.join(workDir, 'bin'), { runnerUid: 0, os: 'Darwin', accounts: { 'ci.runner': standardAccount } });
    const result = runAdminLine('ci.runner');
    assert.equal(result.status, 0, String(result.stderr));
    assert.match(String(result.stdout), /^ROOT_SERVICE install ci\.runner --bootstrap /m);
    assert.deepEqual(readAccountRuns(), []);
  });

  it('a failed root step (its own words say whether the pairing or the service failed) fails the line with the step\'s own status, and the copy is gone', () => {
    for (const systemName of ['Darwin', 'Linux']) {
      installAdminStubs(path.join(workDir, 'bin'), { runnerUid: 0, os: systemName, accounts: { runner: standardAccount } });
      const result = runAdminLine(defaultRunnerAccount, { STUB_ROOT_STEP_FAILS: '1' });
      assert.equal(result.status, 3, systemName);
      assert.equal(fs.existsSync(readPrinted(result, 'ROOT_SERVICE_FROM')), false, 'the root-made copy is removed on the way out');
    }
  });

  it('stops with a clear line when the hub refuses the download — before the account is touched — and cleans up', () => {
    installAdminStubs(path.join(workDir, 'bin'), { runnerUid: 0, os: 'Linux', accounts: { runner: standardAccount } });
    fs.writeFileSync(path.join(workDir, 'bin', 'ssh'), '#!/bin/sh\necho "Permission denied" >&2\nexit 255\n', { mode: 0o755 });
    const result = runAdminLine();
    assert.notEqual(result.status, 0);
    assert.match(String(result.stderr), /the hub refused or did not answer/);
    assert.deepEqual(readAccountRuns(), [], 'nothing ran as the account');
  });

  it('refuses to run without root, before anything is fetched', () => {
    installAdminStubs(path.join(workDir, 'bin'), { runnerUid: 1000, os: 'Linux', accounts: { runner: standardAccount } });
    const result = runAdminLine();
    assert.notEqual(result.status, 0);
    assert.match(String(result.stderr), /run this line with sudo/);
    assertNothingFetched();
  });

  it('stops on an account that does not exist — names it, creates nothing, fetches nothing, pairs nothing', () => {
    installAdminStubs(path.join(workDir, 'bin'), { runnerUid: 0, os: 'Linux', accounts: { someoneelse: standardAccount } });
    const result = runAdminLine('runner');
    assert.notEqual(result.status, 0);
    assert.match(String(result.stderr), /no account runner here: create a standard user or fix the last word/);
    assertNothingFetched();
    assert.ok(!fs.existsSync(path.join(workDir, 'homes', 'runner')), 'no account or home was made');
  });

  it('refuses root as the account', () => {
    installAdminStubs(path.join(workDir, 'bin'), { runnerUid: 0, os: 'Linux', accounts: { root: { uid: 0, groups: ['root'] } } });
    const result = runAdminLine('root');
    assert.notEqual(result.status, 0);
    assert.match(String(result.stderr), /root is root: use a standard user/);
    assertNothingFetched();
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
    assertNothingFetched();
  });

  it('refuses a system that is neither macOS nor Linux', () => {
    installAdminStubs(path.join(workDir, 'bin'), { runnerUid: 0, os: 'FreeBSD', accounts: { runner: standardAccount } });
    const result = runAdminLine();
    assert.notEqual(result.status, 0);
    assert.match(String(result.stderr), /only macOS and Linux/);
    assertNothingFetched();
  });

  it('refuses when the account\'s groups cannot be read — a failing `id -Gn` must not pass as «not an admin»', () => {
    installAdminStubs(path.join(workDir, 'bin'), { runnerUid: 0, os: 'Linux', accounts: { runner: { uid: 4242, groups: ['sudo'], groupsFail: true } } });
    const result = runAdminLine();
    assert.notEqual(result.status, 0);
    assert.match(String(result.stderr), /^charness-runner: no groups for runner$/m);
    assertNothingFetched();
  });

  it('picks the Node it runs everything under — outside every home — before anything is fetched, and starts the root step with it', () => {
    installAdminStubs(path.join(workDir, 'bin'), { runnerUid: 0, os: 'Linux', accounts: { runner: standardAccount } });
    const result = runAdminLine();
    assert.equal(result.status, 0, String(result.stderr));
    assert.ok(readFileLines(path.join(workDir, 'node.log')).length >= 2, 'the version check and the root step both ran under the picked Node');
    assert.match(String(result.stdout), /^ROOT_SERVICE install runner --bootstrap /m);
  });

  it('refuses, before anything is fetched, when sudo finds no usable Node at all — with the way out — and names the plain line\'s own wording for its own case', () => {
    installAdminStubs(path.join(workDir, 'bin'), { runnerUid: 0, os: 'Linux', accounts: { runner: standardAccount } });
    fs.rmSync(path.join(workDir, 'bin', 'node'));
    const toolsBin = path.join(workDir, 'tools');
    fs.mkdirSync(toolsBin);
    for (const tool of ['sh', 'mktemp', 'rm', 'chmod', 'cat', 'cp', 'tar', 'fold', 'mkdir', 'head', 'grep', 'tail', 'readlink', 'env', 'test', 'dirname', 'basename']) {
      const resolved = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
      if (resolved.startsWith('/')) fs.symlinkSync(resolved, path.join(toolsBin, tool));
    }
    const result = spawnSync('/bin/sh', ['-c', buildAdminBootstrapLine(createPairCodePayload()).replace(/^sudo /, '')], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${path.join(workDir, 'bin')}:${toolsBin}`, TMPDIR: path.join(workDir, 'tmp') },
    });
    assert.notEqual(result.status, 0);
    assert.match(String(result.stderr), /^charness-runner: no Node\.js 22\.12\+ outside home folders: install one system-wide \(macOS: brew install node\), paste again$/m);
    assertNothingFetched();
    assert.ok(/Node\.js 22\.12 or newer is needed on this machine/.test(buildBootstrapLine(createPairCodePayload())), 'the plain line keeps its own wording');
  });

  /** Nothing was downloaded, nothing ran as an account: the hub was not asked and `sudo` was not called. */
  function assertNothingFetched(): void {
    assert.ok(!fs.existsSync(path.join(workDir, 'ssh.args')), 'the hub was not asked for the package');
    assert.deepEqual(readAccountRuns(), [], 'nothing ran as the account');
  }

  /** Every combination of system, uid and groups the runner-side check knows: the line and `checkIsAdminAccount` must say the same. */
  const adminFacts: Array<{ platform: NodeJS.Platform; os: string; groups: string[] }> = [
    ...['staff', 'wheel', 'sudo', 'admin', 'admin staff', 'staff _developer'].map((groups) => ({ platform: 'darwin' as const, os: 'Darwin', groups: groups.split(' ') })),
    ...['users', 'sudo', 'wheel', 'admin', 'users sudo', 'docker', 'runner users'].map((groups) => ({ platform: 'linux' as const, os: 'Linux', groups: groups.split(' ') })),
  ];
  for (const facts of adminFacts) {
    it(`${facts.os} with groups «${facts.groups.join(' ')}»: the line refuses exactly what checkIsAdminAccount calls admin`, () => {
      installAdminStubs(path.join(workDir, 'bin'), { runnerUid: 0, os: facts.os, accounts: { runner: { uid: 4242, groups: facts.groups } } });
      const isAdmin = checkIsAdminAccount({ platform: facts.platform, uid: 4242, groups: facts.groups });
      const result = runAdminLine();
      if (isAdmin) {
        assert.notEqual(result.status, 0);
        assert.match(String(result.stderr), /runner is an admin: the agents code runs with its rights/);
        assertNothingFetched();
      } else {
        assert.equal(result.status, 0, String(result.stderr));
      }
    });
  }

  it('the admin groups of the line are the runner utility\'s own lists', () => {
    const { script } = splitAdminLine(buildAdminBootstrapLine(createPairCodePayload()));
    assert.ok(script.includes(`Darwin) g="${macAdminGroup}"`));
    assert.ok(script.includes(`Linux) g="${linuxAdminGroups.join(' ')}"`));
  });
});

function readFileLines(file: string): string[] {
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line !== '');
}

describe('admin bootstrap line: the Node it runs under', () => {
  let pickDir = '';
  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-'));
    pickDir = path.join(workDir, 'work');
    fs.mkdirSync(path.join(workDir, 'bin'), { recursive: true });
    fs.mkdirSync(pickDir);
    installAdminStubs(path.join(workDir, 'bin'), { runnerUid: 0, os: 'Linux', accounts: { runner: { uid: 4242, groups: ['runner', 'staff'] } } });
    fs.rmSync(path.join(workDir, 'bin', 'node'));
  });
  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  /** A fake `node` of `version`: it answers the version check (`node -e …`) by its exit status, as the real one would. */
  function writeNode(file: string, version: string, isExecutable = true): string {
    const [major, minor] = version.split('.').map(Number);
    const isNewEnough = major > 22 || (major === 22 && minor >= 12);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `#!/bin/sh\n# fake node ${version}\nexit ${isNewEnough ? 0 : 1}\n`, { mode: isExecutable ? 0o755 : 0o644 });
    return file;
  }

  /** The pick steps for real, in `sh`, as the admin script runs them (account `runner`, `f` that refuses): where does `n` end up? */
  function pick(options: { onPath?: string; candidates?: string[]; homes?: string[] }): { status: number | null; picked: string; error: string } {
    const homePatterns = (options.homes ?? [path.join(workDir, 'home', '*')]);
    const steps = renderNodePickSteps(homePatterns, options.candidates ?? []);
    const script = ['set -eu', 'a=runner', 'f() { echo "$*" >&2; exit 1; }', ...steps, 'echo "PICKED=$n"'].join('; ');
    const result = spawnSync('sh', ['-c', script], {
      encoding: 'utf8',
      cwd: pickDir,
      env: { PATH: [path.join(workDir, 'bin'), ...(options.onPath === undefined ? [] : [options.onPath]), '/usr/bin', '/bin'].join(':'), HOME: pickDir },
    });
    return { status: result.status, picked: /^PICKED=(.*)$/m.exec(result.stdout)?.[1] ?? '', error: result.stderr.trim() };
  }

  it('takes the Node of sudo\'s own PATH when it is outside the homes and new enough', () => {
    const system = writeNode(path.join(workDir, 'system', 'node'), '22.12.0');
    const result = pick({ onPath: path.dirname(system) });
    assert.deepEqual([result.status, result.picked], [0, system]);
  });

  it('skips a Node that lives in a home — also when it is first on the PATH — and takes the next candidate outside the homes', () => {
    const inHome = writeNode(path.join(workDir, 'home', 'alice', '.nvm', 'bin', 'node'), '22.20.0');
    const system = writeNode(path.join(workDir, 'system', 'node'), '22.12.0');
    const result = pick({ onPath: path.dirname(inHome), candidates: [system] });
    assert.deepEqual([result.status, result.picked], [0, system]);
  });

  it('judges a Node by where it REALLY is: a link outside the homes that leads into one is a home Node too', () => {
    const inHome = writeNode(path.join(workDir, 'home', 'alice', '.nvm', 'bin', 'node'), '22.20.0');
    const link = path.join(workDir, 'system', 'node');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(inHome, link);
    const refused = pick({ candidates: [link] });
    assert.equal(refused.status, 1);
    assert.match(refused.error, /^no Node\.js 22\.12\+ outside home folders: install one system-wide \(macOS: brew install node\), paste again$/);
    assert.equal(refused.picked, '');
  });

  it('refuses when only Nodes in homes exist, saying how to install one', () => {
    const inHome = writeNode(path.join(workDir, 'home', 'alice', 'node'), '24.0.0');
    const result = pick({ onPath: path.dirname(inHome) });
    assert.equal(result.status, 1);
    assert.match(result.error, /brew install node/);
  });

  it('skips a Node that is too old, or that the account cannot run (no execute right), and takes one that fits', () => {
    const tooOld = writeNode(path.join(workDir, 'old', 'node'), '22.11.9');
    const notRunnable = writeNode(path.join(workDir, 'locked', 'node'), '24.0.0', false);
    const fits = writeNode(path.join(workDir, 'fits', 'node'), '22.12.0');
    assert.deepEqual([pick({ candidates: [tooOld, notRunnable] }).status, pick({ candidates: [tooOld, notRunnable] }).picked], [1, '']);
    const result = pick({ candidates: [tooOld, notRunnable, fits] });
    assert.deepEqual([result.status, result.picked], [0, fits]);
  });

  it('runs nothing as the account but `test -x` — the shell executes no program of the account\'s, only asks whether it may run the Node', () => {
    const system = writeNode(path.join(workDir, 'system', 'node'), '22.12.0');
    pick({ onPath: path.dirname(system) });
    const asAccount = readStubLog().filter((line) => line.startsWith(stubUserLine));
    assert.equal(asAccount.length, 1);
    assert.match(asAccount[0], /^sudo-stub -u runner test /);
  });

  it('the line\'s own patterns name the places people\'s homes are: /Users/<name>, /home/<name>, and root\'s', () => {
    const { script } = splitAdminLine(buildAdminBootstrapLine(createPairCodePayload()));
    assert.ok(script.includes('case $r in /Users/*|/home/*|*/root/*) continue;; esac'));
    assert.ok(script.includes('/opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node'));
  });
});

