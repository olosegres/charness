/**
 * @description `remoteRun/ensureNode.sh`: the script that gives a runner its OWN Node.js — the official build from nodejs.org, checked against
 * `SHASUMS256.txt`, unpacked whole into `<base>/v<version>`. Run here for real in `sh` against a local mirror laid out like `nodejs.org/dist` (a tarball
 * with a stand-in `bin/node`, and the `latest-v22.x/SHASUMS256.txt` that names it): no network. In `root` mode (the admin line) it must also keep what
 * root requires of the Node it runs — a real path outside every home folder, runnable by the account, NOT writable by the account nor by any folder above
 * it — with a stand-in `sudo` (`sudo -u <account> test …` is all it asks, so the account's rights are the test's to say).
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
import { sharedNodeBase } from '../runnerUtility/serviceCommon';
import { architectureName, getArchiveName, mirrorRelease, nodeThatIsTooOld, nodeThatRuns, platformName, writeNodeMirror, type MirrorOptions } from './nodeMirrorKit';

const scriptPath = path.resolve(__dirname, '..', '..', 'remoteRun', 'ensureNode.sh');
const shellPath = '/bin/sh';
const systemToolFolders = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
/** What the script runs besides the shell's own builtins (and `cp`, for the stand-in `wget`); `curl` is linked for the cases that want it. Missing ones are skipped (`ldd`, `sysctl`, `chown` are not everywhere). */
const scriptTools = ['uname', 'grep', 'head', 'cut', 'sed', 'mktemp', 'mkdir', 'rm', 'mv', 'tar', 'gzip', 'chmod', 'chown', 'id', 'readlink', 'dirname', 'test', 'cat', 'cp', 'sha256sum', 'shasum', 'openssl', 'ldd', 'sysctl'];
const release = mirrorRelease;
const olderRelease = 'v22.50.0';

let workDir = '';

function findSystemTool(tool: string): string | null {
  return systemToolFolders.map((folder) => path.join(folder, tool)).find((candidate) => fs.existsSync(candidate)) ?? null;
}

/** The script's tools, linked into a folder of their own: the PATH it runs with names no system folder, so the machine's own `node` or `curl` can never answer for a case. */
function installScriptTools(toolsDir: string, extraTools: readonly string[]): void {
  fs.mkdirSync(toolsDir, { recursive: true });
  for (const tool of [...scriptTools, ...extraTools]) {
    const systemTool = findSystemTool(tool);
    if (systemTool !== null) fs.symlinkSync(systemTool, path.join(toolsDir, tool));
  }
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

function readSudoCalls(): string[] {
  try {
    return fs.readFileSync(path.join(workDir, 'sudo.log'), 'utf8').split('\n').filter((line) => line !== '');
  } catch {
    return [];
  }
}

/** A `readlink` that does not know `-f`, as before macOS 12.3. */
function installReadlinkWithoutF(binDir: string): void {
  const real = findSystemTool('readlink');
  assert.notEqual(real, null);
  fs.writeFileSync(path.join(binDir, 'readlink'), `#!/bin/sh\n[ "$1" = -f ] && { echo "readlink: illegal option -- f" >&2; exit 1; }\nexec "${real}" "$@"\n`, { mode: 0o755 });
}

/** A `wget` that knows only what the script asks (`-q -T <s> -t <n> -O <file> <url>`) and serves `file://` urls. */
function installFakeWget(binDir: string): void {
  fs.writeFileSync(path.join(binDir, 'wget'), [
    '#!/bin/sh',
    `echo "wget $*" >> "${workDir}/fetch.log"`,
    'out=; url=',
    'while [ $# -gt 0 ]; do case $1 in -O) out=$2; shift;; -T|-t) shift;; -*) ;; *) url=$1;; esac; shift; done',
    'cp "${url#file://}" "$out"',
    '',
  ].join('\n'), { mode: 0o755 });
}

/** The mirror in `workDir/dist`. */
function writeMirror(options: MirrorOptions = {}): string {
  return writeNodeMirror(path.join(workDir, 'dist'), path.join(workDir, 'stage'), options);
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface RunOptions {
  /** `file://` url of the mirror; `null` = a place that does not exist. */
  dist?: string | null;
  homes?: string;
  withoutReadlinkF?: boolean;
  /** Extra folders ahead of the script's tools on the PATH. */
  onPath?: string[];
}

function runScript(args: string[], options: RunOptions = {}): Run {
  if (options.withoutReadlinkF === true) installReadlinkWithoutF(path.join(workDir, 'bin'));
  const result = spawnSync(shellPath, [scriptPath, ...args], {
    encoding: 'utf8',
    cwd: workDir,
    env: { PATH: [path.join(workDir, 'bin'), ...(options.onPath ?? []), path.join(workDir, 'tools')].join(':'), HOME: workDir },
  });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

const toUrl = (dist: string): string => `file://${dist}`;
const homesSeam = (): string => path.join(fs.realpathSync(workDir), 'home', '*');

/** `ensureNode.sh own <base> [<dist>]`. */
function runOwn(base: string, dist: string | null = toUrl(path.join(workDir, 'dist')), options: RunOptions = {}): Run {
  return runScript(['own', base, dist ?? toUrl(path.join(workDir, 'no-such-dist'))], options);
}

/** `ensureNode.sh root runner <base> <homes> <dist>`, the way the admin line's package runs it with the test seams. */
function runRoot(base: string, options: RunOptions = {}): Run {
  const dist = options.dist === null ? toUrl(path.join(workDir, 'no-such-dist')) : (options.dist ?? toUrl(path.join(workDir, 'dist')));
  return runScript(['root', 'runner', base, options.homes ?? homesSeam(), dist], options);
}

const ownBase = (): string => path.join(workDir, 'machine', '.charness-runner', 'node');
const systemBase = (): string => path.join(workDir, 'system', 'node');

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-node-'));
  installSudo(path.join(workDir, 'bin'));
  installScriptTools(path.join(workDir, 'tools'), ['curl']);
});
afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('the runner\'s own Node (own mode: the plain line, a runner that moves off a system Node)', () => {
  it('downloads the newest 22.x build for this machine, checks it against SHASUMS256.txt, and prints the real path of its `node`', () => {
    writeMirror();
    const result = runOwn(ownBase());
    const expected = path.join(fs.realpathSync(ownBase()), release, 'bin', 'node');
    assert.deepEqual([result.status, result.stdout], [0, expected], result.stderr);
    assert.match(result.stderr, new RegExp(`^charness-runner: installing Node\\.js ${release} for the runner into \\S+/${release} \\(the official build from nodejs\\.org, checksum checked\\)$`, 'm'));
    assert.ok(fs.existsSync(path.join(ownBase(), release, 'lib', 'other.txt')), 'the whole archive is unpacked, without its top folder');
    assert.deepEqual(fs.readdirSync(ownBase()), [release], 'and nothing is left next to it: no work folder');
  });

  it('reuses an install that is there — a second pairing downloads no archive (only the small list is asked) and prints the same path', () => {
    const distDir = writeMirror();
    const first = runOwn(ownBase());
    fs.rmSync(path.join(distDir, release), { recursive: true });
    const second = runOwn(ownBase());
    assert.deepEqual([second.status, second.stdout], [0, first.stdout], second.stderr);
    assert.match(second.stderr, new RegExp(`^charness-runner: Node\\.js ${release} for the runner is already in \\S+/${release}$`, 'm'));
    assert.doesNotMatch(second.stderr, /installing/);
  });

  it('installs a newer release next to an older one and leaves the older one in place — other accounts of the machine may still run on it', () => {
    writeMirror({ version: olderRelease });
    const older = runOwn(ownBase());
    writeMirror();
    const newer = runOwn(ownBase());
    assert.equal(newer.status, 0, newer.stderr);
    assert.match(newer.stdout, new RegExp(`/${release}/bin/node$`));
    assert.match(older.stdout, new RegExp(`/${olderRelease}/bin/node$`));
    assert.deepEqual(fs.readdirSync(ownBase()).sort(), [olderRelease, release]);
  });

  it('REFUSES an archive whose hash is not the one in SHASUMS256.txt — and unpacks, installs and leaves nothing', () => {
    writeMirror({ isChecksumWrong: true });
    const result = runOwn(ownBase());
    assert.deepEqual([result.status, result.stdout], [1, '']);
    assert.match(result.stderr, new RegExp(`^charness-runner: the download of ${getArchiveName(release).replace(/\./g, '\\.')} does not match nodejs\\.org's SHASUMS256\\.txt \\(got [0-9a-f]{64}, expected 0{64}\\): nothing was installed$`, 'm'));
    assert.deepEqual(fs.readdirSync(ownBase()), [], 'no install and no work folder');
  });

  it('says so when nodejs.org lists no build for this machine, and when the archive cannot be downloaded', () => {
    writeMirror({ isPlatformMissing: true });
    const noBuild = runOwn(ownBase());
    assert.equal(noBuild.status, 1);
    assert.match(noBuild.stderr, new RegExp(`has no build for ${platformName}-${architectureName}`));
    const distDir = writeMirror();
    fs.rmSync(path.join(distDir, release, getArchiveName(release)));
    const noArchive = runOwn(ownBase());
    assert.equal(noArchive.status, 1);
    assert.match(noArchive.stderr, /could not download \S+: nothing was installed/);
    assert.deepEqual(fs.readdirSync(ownBase()), []);
  });

  it('refuses a download that does not run on this machine, or is older than 22.12, and installs nothing', () => {
    writeMirror({ nodeScript: nodeThatIsTooOld });
    const result = runOwn(ownBase());
    assert.deepEqual([result.status, result.stdout], [1, '']);
    assert.match(result.stderr, /does not run on this machine: nothing was installed/);
    assert.deepEqual(fs.readdirSync(ownBase()), []);
  });

  it('replaces an install of that release that no longer runs (a broken folder is not «already installed»)', () => {
    writeMirror();
    fs.mkdirSync(path.join(ownBase(), release, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(ownBase(), release, 'bin', 'node'), nodeThatIsTooOld, { mode: 0o755 });
    const result = runOwn(ownBase());
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /installing Node\.js/);
    assert.equal(spawnSync(result.stdout, ['-e', '1']).status, 0, 'the broken one was replaced by the archive\'s');
  });

  it('with nodejs.org out of reach, uses the NEWEST install already in the folder — by number, not by text (22.50 is newer than 22.9) — and says so', () => {
    for (const version of ['v22.9.0', olderRelease, 'v21.0.0']) {
      fs.mkdirSync(path.join(ownBase(), version, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(ownBase(), version, 'bin', 'node'), nodeThatRuns, { mode: 0o755 });
    }
    fs.mkdirSync(path.join(ownBase(), 'vnotes'), { recursive: true });
    const result = runOwn(ownBase(), null);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`/${olderRelease}/bin/node$`));
    assert.match(result.stderr, /could not get the list of Node\.js releases from nodejs\.org: using the Node\.js v22\.50\.0 that is already installed in /);
  });

  it('with nodejs.org out of reach and nothing installed, fails with the way out', () => {
    const result = runOwn(ownBase(), null);
    assert.deepEqual([result.status, result.stdout], [1, '']);
    assert.match(result.stderr, /could not get the list of Node\.js releases from nodejs\.org \(see above\), and there is no Node\.js in \S+ to use instead: check this machine's connection to nodejs\.org and paste again$/m);
  });

  it('uses wget when there is no curl, and says what to install when there is neither', () => {
    fs.rmSync(path.join(workDir, 'tools', 'curl'));
    writeMirror();
    installFakeWget(path.join(workDir, 'bin'));
    const viaWget = runOwn(ownBase());
    assert.equal(viaWget.status, 0, viaWget.stderr);
    const wgetCalls = fs.readFileSync(path.join(workDir, 'fetch.log'), 'utf8');
    assert.match(wgetCalls, /-q -T 60 -t 2 -O \S+SHASUMS256\.txt file:\/\//, 'with timeouts');
    fs.rmSync(path.join(workDir, 'bin', 'wget'));
    fs.rmSync(ownBase(), { recursive: true });
    const neither = runOwn(ownBase());
    assert.equal(neither.status, 1);
    assert.match(neither.stderr, /^charness-runner: neither curl nor wget is on this machine, so Node\.js cannot be downloaded: install one of them and paste again$/m);
  });

  it('asks curl for timeouts and for https only after a redirect', () => {
    writeMirror();
    const real = findSystemTool('curl');
    assert.notEqual(real, null);
    fs.rmSync(path.join(workDir, 'tools', 'curl'));
    fs.writeFileSync(path.join(workDir, 'tools', 'curl'), `#!/bin/sh\necho "curl $*" >> "${workDir}/fetch.log"\nexec "${real}" "$@"\n`, { mode: 0o755 });
    assert.equal(runOwn(ownBase()).status, 0);
    const calls = fs.readFileSync(path.join(workDir, 'fetch.log'), 'utf8').split('\n').filter((line) => line !== '');
    assert.equal(calls.length, 2, 'the list and the archive');
    for (const call of calls) assert.match(call, /--proto-redir =https --connect-timeout 20 --max-time \d+ /);
  });

  it('works where `readlink -f` does not exist (macOS before 12.3)', () => {
    writeMirror();
    const result = runOwn(ownBase(), toUrl(path.join(workDir, 'dist')), { withoutReadlinkF: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, path.join(fs.realpathSync(ownBase()), release, 'bin', 'node'));
  });

  it('refuses musl libc (Alpine): the builds of nodejs.org are glibc builds', (context) => {
    if (platformName !== 'linux') context.skip('Linux only');
    writeMirror();
    fs.rmSync(path.join(workDir, 'tools', 'ldd'), { force: true });
    fs.writeFileSync(path.join(workDir, 'tools', 'ldd'), '#!/bin/sh\necho "musl libc (x86_64)" >&2\nexit 1\n', { mode: 0o755 });
    const result = runOwn(ownBase());
    assert.equal(result.status, 1);
    assert.match(result.stderr, /uses musl libc \(Alpine\)/);
    assert.equal(fs.existsSync(ownBase()), false, 'nothing was created');
  });
});

describe('the Node the admin line installs (root mode)', () => {
  it('installs into the shared folder, keeps nothing group- or world-writable, and prints the real path root and the service will run under', () => {
    writeMirror({ isWithOpenFile: true });
    // Root\'s tar keeps the rights the archive carries (what `-p` asks of any user); a user\'s tar would take the umask to them and hide what the script must do.
    const realTar = findSystemTool('tar');
    assert.notEqual(realTar, null);
    fs.rmSync(path.join(workDir, 'tools', 'tar'));
    fs.writeFileSync(path.join(workDir, 'tools', 'tar'), `#!/bin/sh\nexec "${realTar}" -p "$@"\n`, { mode: 0o755 });
    const result = runRoot(systemBase());
    const expected = path.join(fs.realpathSync(systemBase()), release, 'bin', 'node');
    assert.deepEqual([result.status, result.stdout], [0, expected], result.stderr);
    const writableByOthers: string[] = [];
    const walk = (folder: string): void => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const entryPath = path.join(folder, entry.name);
        if ((fs.lstatSync(entryPath).mode & 0o022) !== 0) writableByOthers.push(entryPath);
        if (entry.isDirectory()) walk(entryPath);
      }
    };
    walk(path.join(systemBase(), release));
    assert.deepEqual(writableByOthers, [], 'root\'s files are not the account\'s to change');
    assert.equal(fs.statSync(path.join(systemBase(), release)).mode & 0o777, 0o755, 'and the folder is open for the account to run the Node');
    assert.equal(fs.statSync(systemBase()).mode & 0o022, 0, 'the shared folder itself is not writable by others either');
  });

  it('unpacks as root WITHOUT taking the owner from the archive — the uid it was made with could be the account\'s', () => {
    writeMirror();
    const real = findSystemTool('tar');
    assert.notEqual(real, null);
    fs.rmSync(path.join(workDir, 'tools', 'tar'));
    fs.writeFileSync(path.join(workDir, 'tools', 'tar'), `#!/bin/sh\necho "tar $*" >> "${workDir}/tar.log"\nexec "${real}" "$@"\n`, { mode: 0o755 });
    assert.equal(runRoot(systemBase()).status, 0);
    assert.match(fs.readFileSync(path.join(workDir, 'tar.log'), 'utf8'), /^tar --no-same-owner -xzf \S+node\.tar\.gz -C \S+ --strip-components=1$/m);
  });

  it('is the folder the TypeScript side knows (`sharedNodeBase`) unless a test names another', () => {
    const match = /^default_root_base=(\S+)$/m.exec(fs.readFileSync(scriptPath, 'utf8'));
    assert.equal(match?.[1], sharedNodeBase);
  });

  it('asks the account nothing but `test` — it executes no program of the account\'s — and checks the shared folder (before root writes into it), then the Node and every folder above it, for writing', () => {
    writeMirror();
    const result = runRoot(systemBase());
    assert.equal(result.status, 0, result.stderr);
    const calls = readSudoCalls();
    assert.ok(calls.every((call) => call.startsWith('-u runner test ')), calls.join('\n'));
    const writeChecks = calls.filter((call) => call.startsWith('-u runner test -w ')).map((call) => call.slice('-u runner test -w '.length));
    const chainUp = (start: string): string[] => {
      const chain: string[] = [];
      for (let folder = start; folder !== '/' && folder !== ''; folder = path.dirname(folder)) chain.push(folder);
      return chain;
    };
    assert.deepEqual(writeChecks, [...chainUp(fs.realpathSync(systemBase())), ...chainUp(result.stdout)]);
    assert.ok(calls.includes(`-u runner test -x ${result.stdout}`));
    assert.ok(calls.indexOf(`-u runner test -x ${result.stdout}`) > calls.findIndex((call) => call.startsWith('-u runner test -w ')), 'the base was judged before anything was unpacked into it');
  });

  it('judges the shared folder BEFORE root writes anything into it: one the account can write (or a folder above it) gets no download, no unpacking, no leftovers', () => {
    writeMirror();
    fs.mkdirSync(systemBase(), { recursive: true });
    const logBefore = (): string[] => readSudoCalls();
    for (const writable of [fs.realpathSync(systemBase()), path.dirname(fs.realpathSync(systemBase()))]) {
      fs.writeFileSync(path.join(workDir, 'writable'), `${writable}\n`);
      const refused = runRoot(systemBase());
      assert.deepEqual([refused.status, refused.stdout], [1, ''], writable);
      assert.match(refused.stderr, /^charness-runner: runner can write \S+, and root runs this Node\.js: a folder only root can write is needed/m);
      assert.deepEqual(fs.readdirSync(systemBase()), [], `nothing was put into ${systemBase()}`);
    }
    assert.ok(logBefore().every((call) => !call.includes(' test -x ')), 'and the Node was never even asked about');
  });

  it('is never a Node the account can WRITE — nor one in a folder it can write, all the way up — also when the install was there already: it fails and prints no path', () => {
    writeMirror();
    const first = runRoot(systemBase());
    assert.equal(first.status, 0, first.stderr);
    const installedNode = first.stdout;
    for (const [what, writable] of [['the file itself', installedNode], ['its folder', path.dirname(installedNode)], ['the shared folder', fs.realpathSync(systemBase())], ['a folder further up', fs.realpathSync(os.tmpdir())]] as const) {
      fs.writeFileSync(path.join(workDir, 'writable'), `${writable}\n`);
      const refused = runRoot(systemBase());
      assert.deepEqual([refused.status, refused.stdout], [1, ''], what);
      assert.match(refused.stderr, new RegExp(`^charness-runner: runner can write ${writable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, and root runs this Node\\.js: a folder only root can write is needed \\(the default is ${sharedNodeBase.replace(/\./g, '\\.')}\\)$`, 'm'), what);
    }
  });

  it('is never a Node inside a home folder — judged by its real path, so a link that leads into one does not count', () => {
    writeMirror();
    const inHome = path.join(workDir, 'home', 'alice', 'node');
    const refused = runRoot(inHome);
    assert.deepEqual([refused.status, refused.stdout], [1, '']);
    assert.match(refused.stderr, /is inside a home folder: root runs nothing from somebody's home/);
    const linkBase = path.join(workDir, 'system-link');
    fs.mkdirSync(path.join(workDir, 'home', 'bob', 'real'), { recursive: true });
    fs.symlinkSync(path.join(workDir, 'home', 'bob', 'real'), linkBase);
    for (const withoutReadlinkF of [false, true]) {
      const viaLink = runRoot(linkBase, { withoutReadlinkF });
      assert.equal(viaLink.status, 1, `withoutReadlinkF=${withoutReadlinkF}: ${viaLink.stderr}`);
      assert.match(viaLink.stderr, /is inside a home folder/);
    }
  });

  it('follows relative links and chains by hand without `readlink -f`, and prints the physical path', () => {
    writeMirror();
    fs.mkdirSync(path.join(workDir, 'opt', 'real'), { recursive: true });
    fs.symlinkSync('real', path.join(workDir, 'opt', 'link'));
    const result = runRoot(path.join(workDir, 'opt', 'link', 'node'), { withoutReadlinkF: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, path.join(fs.realpathSync(workDir), 'opt', 'real', 'node', release, 'bin', 'node'));
  });

  it('refuses a Node that the account cannot run (no execute right on a folder on the way), with the reason', () => {
    writeMirror();
    fs.writeFileSync(path.join(workDir, 'bin', 'sudo'), '#!/bin/sh\n[ "$1" = -u ] || exit 99\nshift 2\n[ "$1" = test ] && [ "$2" = -x ] && exit 1\n[ "$1" = test ] && [ "$2" = -w ] && exit 1\nexec "$@"\n', { mode: 0o755 });
    const result = runRoot(systemBase());
    assert.deepEqual([result.status, result.stdout], [1, '']);
    assert.match(result.stderr, /^charness-runner: runner cannot run \S+: its folders must be open to everyone$/m);
  });

  it('with nodejs.org out of reach, runs on the install that is there — after the same checks', () => {
    writeMirror();
    const first = runRoot(systemBase());
    const again = runRoot(systemBase(), { dist: null });
    assert.deepEqual([again.status, again.stdout], [0, first.stdout], again.stderr);
    fs.writeFileSync(path.join(workDir, 'writable'), `${fs.realpathSync(systemBase())}\n`);
    assert.equal(runRoot(systemBase(), { dist: null }).status, 1, 'and an install the account could write is refused all the same');
  });

  it('is not given a test seam by the line: its own default places and the shared folder are what it uses', (context) => {
    if (findHomeContaining(fs.realpathSync(os.tmpdir())) !== null) context.skip('the temp folder is inside a home here');
    const source = fs.readFileSync(scriptPath, 'utf8');
    assert.ok(source.includes('default_dist=https://nodejs.org/dist'), 'the one place it downloads from');
    assert.ok(!/\$\{?(CHARNESS|TEST)_/.test(source), 'and no environment variable changes that: a seam of the root script is an argument');
  });
});

describe('the places the script calls homes', () => {
  /** The default home patterns, as the script writes them. */
  function readDefaultHomePatterns(): string[] {
    const match = /^ {4}homes=\$\{4:-"([^"]+)"\}$/m.exec(fs.readFileSync(scriptPath, 'utf8'));
    assert.notEqual(match, null, 'the script declares its default home places');
    return (match?.[1] ?? '').split(' ');
  }

  it('are the ones `homeFolders.ts` knows — the same paths are inside a home for both (the shell cannot import the TypeScript, so a table keeps them together)', () => {
    const patterns = readDefaultHomePatterns();
    const table = ['/Users/alice/.nvm/versions/node/v22/bin/node', '/home/bob/.local/bin/node', '/root/.nvm/bin/node', '/var/root/node', '/Users/Shared/tools/node', '/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/local/lib/charness-runner/node/v22.0.0/bin/node', '/usr/bin/node', '/opt/hostedtoolcache/node/22.12.0/x64/bin/node', '/Applications/node'];
    for (const candidate of table) {
      const matches = patterns.some((pattern) => spawnSync('sh', ['-c', `case "$1" in $2) exit 0;; *) exit 1;; esac`, 'sh', candidate, pattern]).status === 0);
      assert.equal(matches, findHomeContaining(candidate) !== null, candidate);
    }
  });
});
