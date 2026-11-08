/**
 * @description `runners/bootstrapLine.ts`: the `sh` lines the operator pastes on the runner machine. They are run here by a real `sh`
 * with a stand-in `ssh` that serves a package: the key and the pinned host key reach ssh as files, ssh is called with strict host key
 * checking and nothing else to log in with, the package is unpacked, the runner utility is handed the code — and the temp folder is gone.
 * The line is ONE script with two ways, chosen by who runs it (stand-ins for `id`, `uname` and `sudo` — a second real account is not available to a
 * test): without root (the line minus its `sudo`, in the runner account's own terminal) it pairs THAT account from a private copy, and the last word
 * must be the account's own name; as root (`sudo sh -c '<script>' sh <account>`) the checks refuse a missing, root or admin account BEFORE anything is
 * fetched, the root step runs from a root-made copy, and the account is paired and its service installed by that step only.
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
import { buildAdminBootstrapLine, checkIsAccountName, defaultRunnerAccount } from '../runners/bootstrapLine';
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

/**
 * The package's `remoteRun/ensureNode.sh` as these tests have it: a stand-in that records how the line called it and prints a Node to run under — the
 * logging `node` of the admin stand-ins in `root` mode, the Node running this test in `own` mode. The real script is `runnersEnsureNode.test.ts`'s; here only
 * the line's way of calling it and of using its answer is under test. `STUB_ENSURE_NODE_FAILS` makes it fail the way a download that cannot be made does.
 */
const ensureNodeStand = [
  '#!/bin/sh',
  'echo "$*" >> "$STUB_WORK_DIR/ensure-node.args"',
  '[ -z "$STUB_ENSURE_NODE_FAILS" ] || { echo "charness-runner: could not download Node.js (stand-in)" >&2; exit 1; }',
  'case $1 in',
  '  root) echo "$STUB_WORK_DIR/bin/node";;',
  '  own) echo "$STUB_NODE";;',
  'esac',
  '',
].join('\n');

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
    { path: 'remoteRun/ensureNode.sh', content: Buffer.from(ensureNodeStand), mode: 0o755 },
    { path: 'dist/runnerUtility/runnerCli.js', content: Buffer.from(runnerCli), mode: 0o644 },
    { path: 'dist/runnerUtility/rootServiceCli.js', content: Buffer.from(rootServiceCli), mode: 0o644 },
  ]));
  const answer = Buffer.concat([Buffer.from(noise), Buffer.from(formatGateAnswerHead('bootstrap', { id: '0123456789abcdef' })), archive]);
  fs.writeFileSync(path.join(workDir, 'answer.bin'), answer);
  return answer;
}

/** The environment a pasted line runs in: the stand-ins first on the PATH, and what the stand-in `ensureNode.sh` needs to answer. */
function createLineEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${path.join(workDir, 'bin')}:${process.env.PATH}`, TMPDIR: path.join(workDir, 'tmp'), STUB_WORK_DIR: workDir, STUB_NODE: process.execPath, ...extra };
}

/** The name the stand-in `id` gives the user who runs a line without root: the account the line is meant for (the last word is `runner` unless the test says otherwise). */
const ownAccountName = 'runner';

/** The line as the runner account itself pastes it, in its own terminal: the same line without its leading `sudo`. */
function buildOwnAccountLine(payload = createPairCodePayload(), account: string = ownAccountName): string {
  return buildAdminBootstrapLine(payload, account).replace(/^sudo /, '');
}

function runLine(payload = createPairCodePayload()): ReturnType<typeof spawnSync> {
  return spawnSync('sh', ['-c', buildOwnAccountLine(payload)], {
    encoding: 'utf8',
    env: createLineEnv(),
  });
}

describe('the line without sudo, in the runner account\'s own terminal', () => {
  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-'));
    fs.mkdirSync(path.join(workDir, 'tmp'));
    installAdminStubs(path.join(workDir, 'bin'), { runnerUid: 1000, userName: ownAccountName, os: 'Linux', accounts: {} });
  });
  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('is one line of `sh -c` with the code in it, and the script is valid sh', () => {
    const payload = createPairCodePayload();
    const line = buildOwnAccountLine(payload);
    assert.ok(line.startsWith("sh -c '") && line.endsWith(`' sh ${ownAccountName}`), 'the account it runs as is its last word');
    assert.ok(!line.includes('\n'));
    assert.ok(line.includes(encodePairCode(payload)));
    const script = line.slice("sh -c '".length, -`' sh ${ownAccountName}`.length);
    assert.ok(!script.includes("'"));
    assert.equal(spawnSync('sh', ['-n', '-c', script]).status, 0);
  });

  it('carries no value that could end its quoting', () => {
    const line = buildOwnAccountLine();
    const script = line.slice("sh -c '".length, -`' sh ${ownAccountName}`.length);
    assert.ok(!/[`\\]/.test(script.replace(/\\"/g, '').replace(/\\n/g, '')), 'no backtick and no stray backslash');
  });

  it('fetches the package with the pairing\'s key, strict host key checking and no agent, then hands the code to the runner utility', () => {
    const payload = createPairCodePayload({ host: 'hub.example', port: 2222, user: 'hubuser' });
    installStubSsh(path.join(workDir, 'bin'));
    createBootstrapAnswer();
    const result = spawnSync('sh', ['-c', buildOwnAccountLine(payload)], {
      encoding: 'utf8',
      env: createLineEnv(),
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

  it('says what it is doing before the long step, on stdout: «checking the account», «downloading the package from the hub», and only then the runner utility takes over', () => {
    installStubSsh(path.join(workDir, 'bin'));
    createBootstrapAnswer();
    const result = runLine();
    assert.equal(result.status, 0, String(result.stderr));
    const lines = String(result.stdout).split('\n');
    assert.deepEqual(lines.slice(0, 2), ['charness-runner: checking the account runner', 'charness-runner: downloading the package from the hub']);
    assert.ok(lines.findIndex((line) => line.startsWith('RUNNER_CLI ')) > 1, 'the runner utility starts after the step lines');
  });

  it('names the download step also when the hub then refuses it: the step on stdout, the refusal on stderr', () => {
    installStubSsh(path.join(workDir, 'bin'));
    fs.writeFileSync(path.join(workDir, 'bin', 'ssh'), '#!/bin/sh\necho "Permission denied" >&2\nexit 255\n', { mode: 0o755 });
    const result = runLine();
    assert.notEqual(result.status, 0);
    assert.equal(String(result.stdout), 'charness-runner: checking the account runner\ncharness-runner: downloading the package from the hub\n');
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
    const result = spawnSync('sh', ['-c', buildOwnAccountLine()], {
      encoding: 'utf8',
      env: createLineEnv(),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readdirSync(path.join(workDir, 'tmp')), []);
  });

  it('stops with a clear line when ssh cannot fetch the package — an expired or used line is a refused key, not an empty answer — and still cleans up', () => {
    installStubSsh(path.join(workDir, 'bin'));
    fs.writeFileSync(path.join(workDir, 'bin', 'ssh'), '#!/bin/sh\necho "Permission denied" >&2\nexit 255\n', { mode: 0o755 });
    const result = spawnSync('sh', ['-c', buildOwnAccountLine()], {
      encoding: 'utf8',
      env: createLineEnv(),
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Permission denied/, 'ssh\'s own message stays');
    assert.match(result.stderr, /the hub refused or did not answer: expired or used line\? see the ssh message above/, 'and the line says what it probably means, which `set -e` used to cut off');
    assert.ok(!result.stdout.includes('RUNNER_CLI'));
    assert.deepEqual(fs.readdirSync(path.join(workDir, 'tmp')), []);
  });

  it('needs no Node on the machine: the runner\'s own is installed by the package\'s script into the account\'s state folder, and the pairing runs under the one it prints', () => {
    installStubSsh(path.join(workDir, 'bin'));
    createBootstrapAnswer();
    const toolsBin = path.join(workDir, 'tools');
    fs.mkdirSync(toolsBin);
    for (const tool of ['sh', 'mktemp', 'rm', 'cat', 'tar', 'gzip', 'fold', 'mkdir', 'cp', 'head', 'grep', 'tail']) {
      const resolved = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
      if (resolved.startsWith('/')) fs.symlinkSync(resolved, path.join(toolsBin, tool));
    }
    const result = spawnSync('/bin/sh', ['-c', buildOwnAccountLine()], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${path.join(workDir, 'bin')}:${toolsBin}`, TMPDIR: path.join(workDir, 'tmp'), HOME: path.join(workDir, 'machine-home'), STUB_WORK_DIR: workDir, STUB_NODE: process.execPath },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^RUNNER_CLI pair --bootstrap /m);
    assert.deepEqual(readFileLines(path.join(workDir, 'ensure-node.args')), [`own ${path.join(workDir, 'machine-home', '.charness-runner', 'node')}`], 'the script was asked for the Node of the account\'s own state folder, as the account');
  });

  it('stops before the pairing when the Node cannot be installed — the script\'s own words on stderr, nothing run under a missing Node — and cleans up', () => {
    installStubSsh(path.join(workDir, 'bin'));
    createBootstrapAnswer();
    const result = spawnSync('sh', ['-c', buildOwnAccountLine()], { encoding: 'utf8', env: createLineEnv({ STUB_ENSURE_NODE_FAILS: '1' }) });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /^charness-runner: could not download Node\.js \(stand-in\)$/m);
    assert.ok(!result.stdout.includes('RUNNER_CLI'), 'the pairing never started');
    assert.deepEqual(fs.readdirSync(path.join(workDir, 'tmp')), []);
  });

  it('asks nothing of the machine\'s Node: no `node` is named in the line before the Node install, and the version check of the old line is gone', () => {
    const script = /^sh -c '(.*)' sh runner$/.exec(buildOwnAccountLine())?.[1] ?? '';
    assert.ok(!/(^|[ ;])node /.test(script), 'the pairing is started by the path the script printed, not by a `node` of the PATH');
    assert.ok(!script.includes('process.versions'), 'and no version of a system Node is judged by the line');
    assert.match(script, /; set -- --bootstrap "\$d\/pkg" --archive "\$d\/package\.tgz" --package-id "\$\{t##\*id=\}" cr1\./);
    assert.match(script, /else n=\$\(sh "\$d\/pkg\/remoteRun\/ensureNode\.sh" own "\$HOME\/\.charness-runner\/node"\); "\$n" "\$d\/pkg\/dist\/runnerUtility\/runnerCli\.js" pair "\$@"; fi$/);
  });

  it('pairs the account it runs as and nothing else: the pairing program runs from a PRIVATE copy in the account\'s own $TMPDIR, no root step runs, nothing is asked of sudo', () => {
    installStubSsh(path.join(workDir, 'bin'));
    createBootstrapAnswer();
    const result = runLine();
    assert.equal(result.status, 0, String(result.stderr));
    const output = String(result.stdout);
    assert.doesNotMatch(output, /ROOT_SERVICE/, 'the service step is root\'s: this way installs none');
    const pairedFrom = /^RUNNER_CLI_FROM (.*)$/m.exec(output)?.[1] ?? '';
    assert.ok(pairedFrom.startsWith(`${path.join(workDir, 'tmp')}${path.sep}charness-runner.`), `the copy is made in the account's own TMPDIR: ${pairedFrom}`);
    assert.match(output, /^MODES folder=700 package=700 key=600$/m, 'and stays private: nobody else can read the account\'s copy');
    assert.deepEqual(readAccountRuns(), [], 'no sudo');
    assert.equal(fs.existsSync(pairedFrom), false, 'and the copy is gone when the line ends');
  });

  it('refuses when its last word is not the account it runs as — before anything is fetched: a main account with a leftover «runner» at the end must not be paired by mistake, and the code stays unspent', () => {
    installStubSsh(path.join(workDir, 'bin'));
    createBootstrapAnswer();
    const result = spawnSync('sh', ['-c', buildOwnAccountLine(createPairCodePayload(), 'someoneelse')], { encoding: 'utf8', env: createLineEnv() });
    assert.notEqual(result.status, 0);
    assert.match(String(result.stderr), /^charness-runner: you are not someoneelse: run the line as someoneelse or with sudo$/m);
    assert.equal(String(result.stdout), 'charness-runner: checking the account someoneelse\n');
    assert.ok(!fs.existsSync(path.join(workDir, 'ssh.args')), 'the hub was not asked for the package');
    assert.deepEqual(readAccountRuns(), []);
    assert.deepEqual(fs.readdirSync(path.join(workDir, 'tmp')), [], 'and no copy was made');
  });

  it('judges the name before anything else in this way too — an edited last word that is no account name runs nothing', () => {
    installStubSsh(path.join(workDir, 'bin'));
    createBootstrapAnswer();
    const line = buildOwnAccountLine();
    const marker = path.join(workDir, 'pwned');
    for (const edited of ['-n', 'a b', 'x;y', '$(touch pwned)']) {
      const result = spawnSync('sh', ['-c', `${line.slice(0, line.length - ' runner'.length)} '${edited}'`], { encoding: 'utf8', cwd: workDir, env: createLineEnv() });
      assert.notEqual(result.status, 0, JSON.stringify(edited));
      assert.match(String(result.stderr), /is not an account name/, JSON.stringify(edited));
    }
    assert.ok(!fs.existsSync(marker) && !fs.existsSync(path.join(workDir, 'ssh.args')));
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
function installAdminStubs(binDir: string, options: { runnerUid: number; userName?: string; os: string; accounts: Record<string, StubAccount> }): void {
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
    // The name of the account that runs the line (what a line without root compares its last word with).
    `if [ "$1" = -un ]; then echo ${options.userName ?? 'root'}; exit 0; fi`,
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
    // `test -w <path>`: the account can write nothing — unless the test lists the path in `writable`
    `if [ "$1" = test ] && [ "$2" = -w ]; then [ -f "${workDir}/writable" ] && grep -qxF "$3" "${workDir}/writable"; exit $?; fi`,
    `exec env HOME="${workDir}/homes/$user" USER="$user" LOGNAME="$user" "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
}

/** The sudo calls that RAN something as an account: the Node pick's probes (`sudo -u <account> test -x|-w …`) execute nothing of the account's and are left out. */
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
    env: createLineEnv(extraEnv),
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

  it('the root copy is made BY ROOT in a folder of its own that the account can read, without taking owners from the archive; the account\'s own copy is private', () => {
    const { script } = splitAdminLine(buildAdminBootstrapLine(createPairCodePayload()));
    const [asRoot, asAccount] = script.split(/; else /);
    assert.ok(asRoot.includes('b=/tmp;'), 'not the admin\'s own private $TMPDIR, which the account could not enter');
    assert.ok(asAccount.includes('b=${TMPDIR:-/tmp};'), 'while the account\'s own copy is made in its own');
    assert.ok(script.includes('[ "$r" = 0 ] || { chmod 755 "$d"; umask 022; }'), 'readable for the account only in root\'s way, and only after the key files were made private');
    assert.ok(script.includes('tar --no-same-owner -xzf'), 'root\'s copy stays root\'s');
  });

  it('runs the root step from that copy — never from the account\'s folder — and hands it the pairing: the shell has no `sudo -u` of its own, so nothing of the account\'s runs outside the root step\'s terminal-less runner', () => {
    const { script } = splitAdminLine(buildAdminBootstrapLine(createPairCodePayload()));
    assert.match(script, /; set -- --bootstrap "\$d\/pkg" --archive "\$d\/package\.tgz" --package-id "\$\{t##\*id=\}" cr1\./);
    assert.ok(!script.includes('sudo -u'), 'no step of the account\'s is run by the line, with the admin\'s terminal attached — the Node install, in the package\'s script, asks the account nothing but `test`');
    // The two ways end in two programs: root's step for the account named, the account's own pairing for the account that runs the line.
    const [, finalSteps] = script.split('; if [ "$r" = 1 ]; then ');
    const [rootStep, accountStep] = finalSteps.split('; else ');
    assert.equal(rootStep, 'n=$(sh "$d/pkg/remoteRun/ensureNode.sh" root "$a"); "$n" "$d/pkg/dist/runnerUtility/rootServiceCli.js" install "$a" "$@"');
    assert.ok(!rootStep.includes('runnerCli.js') && !rootStep.includes('.charness-runner') && !rootStep.includes('service install'), 'root is never pointed at the account\'s state folder or launcher, nor asked to run the account\'s program');
    assert.ok(accountStep.startsWith('n=$(sh "$d/pkg/remoteRun/ensureNode.sh" own "$HOME/.charness-runner/node"); "$n" "$d/pkg/dist/runnerUtility/runnerCli.js" pair "$@"'));
    assert.ok(!accountStep.includes('rootServiceCli') && !accountStep.includes('sudo'), 'and the account\'s way has no root step and asks nothing of sudo');
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

  it('run by another user without sudo it is the account\'s way and refuses an account that is not the one it runs as — before anything is fetched', () => {
    installAdminStubs(path.join(workDir, 'bin'), { runnerUid: 1000, userName: 'alice', os: 'Linux', accounts: { runner: standardAccount } });
    const result = runAdminLine();
    assert.notEqual(result.status, 0);
    assert.match(String(result.stderr), /you are not runner: run the line as runner or with sudo/);
    assert.doesNotMatch(String(result.stdout), /ROOT_SERVICE/);
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
        env: createLineEnv(),
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

  it('has the package\'s script install the runner its own Node as root, for the account named last, and starts the root step with the Node it printed', () => {
    installAdminStubs(path.join(workDir, 'bin'), { runnerUid: 0, os: 'Linux', accounts: { runner: standardAccount } });
    const result = runAdminLine();
    assert.equal(result.status, 0, String(result.stderr));
    assert.deepEqual(readFileLines(path.join(workDir, 'ensure-node.args')), ['root runner'], 'asked once, in root mode, for the account');
    assert.equal(readFileLines(path.join(workDir, 'node.log')).length, 1, 'and the root step ran under the Node it printed');
    assert.match(String(result.stdout), /^ROOT_SERVICE install runner --bootstrap /m);
    assert.deepEqual(readAccountRuns(), [], 'the line itself asked the account nothing');
  });

  it('stops before anything runs when the Node cannot be installed — the script\'s own words, the way out is its own message — and the root step never starts', () => {
    installAdminStubs(path.join(workDir, 'bin'), { runnerUid: 0, os: 'Linux', accounts: { runner: standardAccount } });
    const result = runAdminLine(defaultRunnerAccount, { STUB_ENSURE_NODE_FAILS: '1' });
    assert.notEqual(result.status, 0);
    assert.match(String(result.stderr), /^charness-runner: could not download Node\.js \(stand-in\)$/m);
    assert.ok(!String(result.stdout).includes('ROOT_SERVICE'), 'the root step never ran');
    assert.deepEqual(readAccountRuns(), []);
    assert.deepEqual(fs.readdirSync(path.join(workDir, 'tmp')), [], 'the root-made copy is gone');
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
