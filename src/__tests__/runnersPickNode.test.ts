/**
 * @description `remoteRun/pickNode.sh`: the script the admin pairing line runs as ROOT, from its root-owned copy of the package, to choose the Node.js
 * that root and the runner's service run under — run here for real in `sh` with a stand-in `sudo` (`sudo -u <account> test …` is all it asks, so the
 * account's rights are the test's to say). A Node qualifies only when its real path is outside every home folder (a program in a home is the other
 * user's to change, and the runner stops the day that home is closed), the account can run it and can write neither it nor a folder above it (root
 * must never run what the account — who runs the agents' code — can change), and it is 22.12 or newer. Also: how it finds the real path on a Mac
 * without `readlink -f` (before macOS 12.3), and that its default home places are the ones `homeFolders.ts` knows.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findHomeContaining } from '../runnerUtility/homeFolders';

const scriptPath = path.resolve(__dirname, '..', '..', 'remoteRun', 'pickNode.sh');
const refusal = /^charness-runner: no Node\.js 22\.12\+ outside home folders that runner cannot write: install one system-wide \(macOS: brew install node\), paste again$/;

let workDir = '';

/** A `node` of `version`: it answers the version check (`node -e …`) by its exit status, as the real one would. */
function writeNode(file: string, version: string, isExecutable = true): string {
  const [major, minor] = version.split('.').map(Number);
  const isNewEnough = major > 22 || (major === 22 && minor >= 12);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n# fake node ${version}\nexit ${isNewEnough ? 0 : 1}\n`, { mode: isExecutable ? 0o755 : 0o644 });
  return fs.realpathSync(file);
}

/** `sudo -u <account> <command>`: the command runs as the real user, except `test -w <path>`, which says «the account can write it» only for a path listed in `writable`. Every call is logged. */
function installSudo(binDir: string): void {
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'sudo'), [
    '#!/bin/sh',
    `echo "$*" >> "${workDir}/sudo.log"`,
    '[ "$1" = -u ] || exit 99',
    'shift 2',
    `if [ "$1" = test ] && [ "$2" = -w ]; then [ -f "${workDir}/writable" ] && grep -qxF "$3" "${workDir}/writable"; exit $?; fi`,
    'exec "$@"',
    '',
  ].join('\n'), { mode: 0o755 });
}

/** A `readlink` that does not know `-f`, as before macOS 12.3. */
function installReadlinkWithoutF(binDir: string): void {
  const real = spawnSync('sh', ['-c', 'command -v readlink'], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(binDir, 'readlink'), `#!/bin/sh\n[ "$1" = -f ] && { echo "readlink: illegal option -- f" >&2; exit 1; }\nexec "${real}" "$@"\n`, { mode: 0o755 });
}

function readSudoCalls(): string[] {
  try {
    return fs.readFileSync(path.join(workDir, 'sudo.log'), 'utf8').split('\n').filter((line) => line !== '');
  } catch {
    return [];
  }
}

interface Pick {
  status: number | null;
  picked: string;
  error: string;
}

/** The script for account `runner`, `onPath` ahead of the system's folders; `homes` and `candidates` are the test seam (the line passes neither). */
function pick(options: { onPath?: string; homes?: string; candidates?: string; withoutReadlinkF?: boolean } = {}): Pick {
  const binDir = path.join(workDir, 'bin');
  if (options.withoutReadlinkF === true) installReadlinkWithoutF(binDir);
  const args = [scriptPath, 'runner', ...(options.homes === undefined ? [] : [options.homes, options.candidates ?? ''])];
  const result = spawnSync('sh', args, {
    encoding: 'utf8',
    cwd: workDir,
    env: { PATH: [binDir, ...(options.onPath === undefined ? [] : [options.onPath]), '/usr/bin', '/bin'].join(':'), HOME: workDir },
  });
  return { status: result.status, picked: result.stdout.trim(), error: result.stderr.trim() };
}

const homesSeam = (): string => path.join(fs.realpathSync(workDir), 'home', '*');

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-'));
  installSudo(path.join(workDir, 'bin'));
});
afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('the Node the admin line picks', () => {
  it('is the `node` of sudo\'s own PATH when it is outside the homes, new enough, runnable and not writable by the account — printed by its real path', () => {
    const system = writeNode(path.join(workDir, 'system', 'node'), '22.12.0');
    const result = pick({ onPath: path.dirname(system), homes: homesSeam() });
    assert.deepEqual([result.status, result.picked], [0, system]);
  });

  it('skips a Node that lives in a home — also when it is first on the PATH — and takes the next candidate', () => {
    const inHome = writeNode(path.join(workDir, 'home', 'alice', '.nvm', 'bin', 'node'), '22.20.0');
    const system = writeNode(path.join(workDir, 'system', 'node'), '22.12.0');
    const result = pick({ onPath: path.dirname(inHome), homes: homesSeam(), candidates: system });
    assert.deepEqual([result.status, result.picked], [0, system]);
  });

  it('judges a Node by where it REALLY is: a link outside the homes that leads into one is a home Node too — with `readlink -f` and without it', () => {
    const inHome = writeNode(path.join(workDir, 'home', 'alice', '.nvm', 'bin', 'node'), '22.20.0');
    const link = path.join(workDir, 'system', 'node');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(inHome, link);
    for (const withoutReadlinkF of [false, true]) {
      const refused = pick({ homes: homesSeam(), candidates: link, withoutReadlinkF });
      assert.equal(refused.status, 1, `withoutReadlinkF=${withoutReadlinkF}`);
      assert.match(refused.error, refusal);
      assert.equal(refused.picked, '');
    }
  });

  it('without `readlink -f` follows relative links and chains by hand (Homebrew\'s `bin/node → ../Cellar/…`), and prints the physical path', () => {
    const cellar = writeNode(path.join(workDir, 'brew', 'Cellar', 'node', '22.12.0', 'bin', 'node'), '22.12.0');
    fs.mkdirSync(path.join(workDir, 'brew', 'bin'), { recursive: true });
    fs.symlinkSync('../Cellar/node/22.12.0/bin/node', path.join(workDir, 'brew', 'bin', 'node'));
    fs.mkdirSync(path.join(workDir, 'local'), { recursive: true });
    fs.symlinkSync(path.join(workDir, 'brew', 'bin', 'node'), path.join(workDir, 'local', 'node'));
    const result = pick({ homes: homesSeam(), candidates: path.join(workDir, 'local', 'node'), withoutReadlinkF: true });
    assert.deepEqual([result.status, result.picked], [0, cellar]);
    const intoHome = writeNode(path.join(workDir, 'home', 'bob', 'node'), '22.12.0');
    fs.mkdirSync(path.join(workDir, 'brew2', 'bin'), { recursive: true });
    fs.symlinkSync('../../home/bob/node', path.join(workDir, 'brew2', 'bin', 'node'));
    const refused = pick({ homes: homesSeam(), candidates: path.join(workDir, 'brew2', 'bin', 'node'), withoutReadlinkF: true });
    assert.equal(refused.status, 1, `a relative link into ${intoHome} is still a home Node`);
  });

  it('is never a Node the account can WRITE — root would run what the account, who runs the agents\' code, can change — nor one in a folder it can write', () => {
    const owned = writeNode(path.join(workDir, 'opt-node', 'bin', 'node'), '22.12.0');
    const fine = writeNode(path.join(workDir, 'system', 'node'), '22.12.0');
    fs.writeFileSync(path.join(workDir, 'writable'), `${owned}\n`);
    assert.deepEqual([pick({ homes: homesSeam(), candidates: `${owned} ${fine}` }).picked], [fine], 'the file itself');
    fs.writeFileSync(path.join(workDir, 'writable'), `${path.dirname(owned)}\n`);
    assert.deepEqual([pick({ homes: homesSeam(), candidates: `${owned} ${fine}` }).picked], [fine], 'its folder (it could be replaced by a rename)');
    fs.writeFileSync(path.join(workDir, 'writable'), `${path.join(workDir, 'opt-node')}\n`);
    assert.deepEqual([pick({ homes: homesSeam(), candidates: `${owned} ${fine}` }).picked], [fine], 'a folder further up');
    fs.writeFileSync(path.join(workDir, 'writable'), `${fs.realpathSync(os.tmpdir())}\n`);
    const result = pick({ homes: homesSeam(), candidates: owned });
    assert.equal(result.status, 1, 'any folder above it, all the way up');
    assert.match(result.error, refusal);
  });

  it('asks the account nothing but `test` — it executes no program of the account\'s — and checks the file and every folder above it for writing', () => {
    const system = writeNode(path.join(workDir, 'system', 'node'), '22.12.0');
    pick({ onPath: path.dirname(system), homes: homesSeam() });
    const calls = readSudoCalls();
    assert.ok(calls.every((call) => call.startsWith('-u runner test ')), calls.join('\n'));
    const writeChecks = calls.filter((call) => call.startsWith('-u runner test -w ')).map((call) => call.slice('-u runner test -w '.length));
    const expected: string[] = [];
    for (let folder = system; folder !== '/' && folder !== ''; folder = path.dirname(folder)) expected.push(folder);
    assert.deepEqual(writeChecks, expected);
    assert.ok(calls.includes(`-u runner test -x ${system}`));
  });

  it('skips a Node that is too old, or that the account cannot run (no execute right), and takes one that fits', () => {
    const tooOld = writeNode(path.join(workDir, 'old', 'node'), '22.11.9');
    const notRunnable = writeNode(path.join(workDir, 'locked', 'node'), '24.0.0', false);
    const fits = writeNode(path.join(workDir, 'fits', 'node'), '22.12.0');
    assert.equal(pick({ homes: homesSeam(), candidates: `${tooOld} ${notRunnable}` }).status, 1);
    const result = pick({ homes: homesSeam(), candidates: `${tooOld} ${notRunnable} ${fits}` });
    assert.deepEqual([result.status, result.picked], [0, fits]);
  });

  it('refuses with the way out — and prints nothing for the line to run — when only Nodes in homes exist, or none', () => {
    const inHome = writeNode(path.join(workDir, 'home', 'alice', 'node'), '24.0.0');
    const onlyHome = pick({ onPath: path.dirname(inHome), homes: homesSeam() });
    assert.deepEqual([onlyHome.status, onlyHome.picked], [1, '']);
    assert.match(onlyHome.error, refusal);
    const none = pick({ homes: homesSeam() });
    assert.deepEqual([none.status, none.picked], [1, '']);
    assert.match(none.error, refusal);
  });

  it('with its own places, picks an ordinary Node outside the folders people\'s homes are in — the line passes no seam', (context) => {
    if (findHomeContaining(fs.realpathSync(os.tmpdir())) !== null) context.skip('the temp folder is inside a home here');
    const system = writeNode(path.join(workDir, 'system', 'node'), '22.12.0');
    const result = pick({ onPath: path.dirname(system) });
    assert.deepEqual([result.status, result.picked], [0, system]);
  });
});

describe('the places the script calls homes', () => {
  /** The default home patterns, as the script writes them. */
  function readDefaultHomePatterns(): string[] {
    const match = /^homes=\$\{2:-"([^"]+)"\}$/m.exec(fs.readFileSync(scriptPath, 'utf8'));
    assert.notEqual(match, null, 'the script declares its default home places');
    return (match?.[1] ?? '').split(' ');
  }

  it('are the ones `homeFolders.ts` knows — the same paths are inside a home for both (the shell cannot import the TypeScript, so a table keeps them together)', () => {
    const patterns = readDefaultHomePatterns();
    const table = ['/Users/alice/.nvm/versions/node/v22/bin/node', '/home/bob/.local/bin/node', '/root/.nvm/bin/node', '/var/root/node', '/Users/Shared/tools/node', '/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node', '/opt/hostedtoolcache/node/22.12.0/x64/bin/node', '/Applications/node'];
    for (const candidate of table) {
      const matches = patterns.some((pattern) => spawnSync('sh', ['-c', `case "$1" in $2) exit 0;; *) exit 1;; esac`, 'sh', candidate, pattern]).status === 0);
      assert.equal(matches, findHomeContaining(candidate) !== null, candidate);
    }
  });
});
