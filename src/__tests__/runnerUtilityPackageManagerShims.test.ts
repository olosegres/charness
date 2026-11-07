/**
 * @description `runnerUtility/packageManagerShims.ts`: a job's PATH keeps `yarn` and `pnpm` whichever Node runs the link. A manager the Node's folder
 * and the system folders do not offer gets Corepack's shim in the runner's own `bin` (the real `corepack enable --install-directory` is asked for
 * it, and its argument contract is pinned against a stand-in AND the real Corepack when this machine has one); a manager that is offered again
 * loses its stale shim; a Node without Corepack, or a Corepack that fails, is a `missing` outcome that says why — never an exception.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getJobPathDirectories } from '../runnerUtility/execEnv';
import { createShimDeps, ensurePackageManagerShims, formatShimLine, renderCorepackWrapper, type ShimDeps } from '../runnerUtility/packageManagerShims';
import { getRunnerHomePaths } from '../runnerUtility/runnerHome';

const checkIsExecutableOnDisk = createShimDeps().checkIsExecutable;
let root = '';
let nodeDir = '';
let corepackDist = '';
let argumentsLog = '';
const executableMode = 0o755;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shims-')));
  nodeDir = path.join(root, 'node', 'bin');
  corepackDist = path.join(root, 'node', 'lib', 'node_modules', 'corepack', 'dist');
  argumentsLog = path.join(root, 'corepack-arguments.log');
  fs.mkdirSync(nodeDir, { recursive: true });
  fs.mkdirSync(corepackDist, { recursive: true });
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function getPaths() {
  return getRunnerHomePaths(path.join(root, 'home'));
}

function writeExecutable(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode: executableMode });
}

/** A Corepack that records what it was asked and makes the symlinks the real one makes (into a folder named `corepack`, as the real one's are). */
function installFakeCorepack(options: { exitCode?: number; stderr?: string } = {}): void {
  const names = ['yarn', 'yarnpkg', 'pnpm', 'pnpx'];
  for (const name of names) writeExecutable(path.join(corepackDist, `${name}.js`), '#!/bin/sh\nexit 0\n');
  writeExecutable(path.join(nodeDir, 'corepack'), [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> "${argumentsLog}"`,
    `printf 'PATH=%s\\n' "$PATH" >> "${argumentsLog}"`,
    ...(options.exitCode === undefined || options.exitCode === 0 ? [] : [`echo "${options.stderr ?? ''}" >&2`, `exit ${options.exitCode}`]),
    'dir=; names=; is_enable=',
    'while [ $# -gt 0 ]; do',
    '  case $1 in',
    '    enable) is_enable=1;;',
    '    --install-directory) dir=$2; shift ;;',
    '    --install-directory=*) dir=${1#*=} ;;',
    '    *) names="$names $1" ;;',
    '  esac',
    '  shift',
    'done',
    '[ -n "$is_enable" ] && [ -n "$dir" ] || exit 0',
    'for name in $names; do',
    `  ln -sf "${corepackDist}/$name.js" "$dir/$name"`,
    'done',
    '',
  ].join('\n'));
}

/**
 * Only a file the test itself put under its temp root is executable. The module also looks in the system folders of a job's PATH
 * (`/usr/local/bin`, Homebrew's): a machine that has its own `yarn` / `pnpm` there — the CI image carries Corepack's shims in `/usr/local/bin` —
 * would answer for the Node of the test that has none, and every case that expects a shim or a missing manager would see `offered`.
 */
function checkIsExecutableUnderRoot(candidate: string): boolean {
  return candidate.startsWith(`${root}${path.sep}`) && checkIsExecutableOnDisk(candidate);
}

function createDeps(overrides: Partial<ShimDeps> = {}): ShimDeps {
  return { ...createShimDeps(), nodeDir, environment: { PATH: '/usr/bin:/bin' }, checkIsExecutable: checkIsExecutableUnderRoot, ...overrides };
}

describe('the job PATH folders', () => {
  it('are the runner\'s bin first, then the bin of the jobs\' own npm prefix, then the Node\'s folder, then the system\'s — the order the environment of a job is built from', () => {
    const folders = getJobPathDirectories(getPaths(), nodeDir);
    assert.deepEqual(folders.slice(0, 3), [getPaths().binDir, path.join(getPaths().npmPrefix, 'bin'), nodeDir]);
    assert.ok(folders.includes('/usr/bin'));
  });
});

describe('the jobs\' global npm prefix', () => {
  it('never counts as OFFERING a manager: a yarn that one job installed with `npm i -g` does not replace Corepack\'s shim, which follows each project\'s `packageManager`', async () => {
    installFakeCorepack();
    const npmBin = path.join(getPaths().npmPrefix, 'bin');
    writeExecutable(path.join(npmBin, 'yarn'), '#!/bin/sh\n');
    writeExecutable(path.join(npmBin, 'pnpm'), '#!/bin/sh\n');
    const outcomes = await ensurePackageManagerShims(getPaths(), createDeps());
    assert.deepEqual(outcomes.map(({ manager, kind }) => [manager, kind]), [['yarn', 'shim'], ['pnpm', 'shim']]);
    // …and the next link start, with the global yarn still there, keeps the shims it made (it does not take them for stale).
    const again = await ensurePackageManagerShims(getPaths(), createDeps());
    assert.deepEqual(again.map(({ manager, kind }) => [manager, kind]), [['yarn', 'shim'], ['pnpm', 'shim']]);
    assert.equal(fs.readlinkSync(path.join(getPaths().binDir, 'yarn')), path.join(corepackDist, 'yarn.js'));
  });

  it('still lets the Node\'s own folder and the system\'s offer one — only the prefix a job writes is left out', async () => {
    installFakeCorepack();
    writeExecutable(path.join(nodeDir, 'yarn'), '#!/bin/sh\n');
    const outcomes = await ensurePackageManagerShims(getPaths(), createDeps());
    assert.deepEqual(outcomes.map(({ manager, kind }) => [manager, kind]), [['yarn', 'offered'], ['pnpm', 'shim']]);
  });
});

describe('ensurePackageManagerShims', () => {
  it('a Node that has no yarn or pnpm gets Corepack\'s shims in the runner\'s bin, asked for with the install directory and the names', async () => {
    installFakeCorepack();
    const outcomes = await ensurePackageManagerShims(getPaths(), createDeps());
    assert.deepEqual(outcomes.map(({ manager, kind }) => [manager, kind]), [['yarn', 'shim'], ['pnpm', 'shim']]);
    assert.equal(fs.readlinkSync(path.join(getPaths().binDir, 'yarn')), path.join(corepackDist, 'yarn.js'));
    const log = fs.readFileSync(argumentsLog, 'utf8');
    assert.match(log, new RegExp(`^enable --install-directory ${getPaths().binDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} yarn pnpm$`, 'm'));
    assert.ok(log.includes(`PATH=${nodeDir}:/usr/bin:/bin`), 'Corepack finds `node` in the Node\'s own folder first');
    assert.equal(formatShimLine(outcomes), '  package managers for jobs: yarn (Corepack shim) · pnpm (Corepack shim)');
  });

  it('only the manager that is missing is asked for: the Node\'s own yarn stays, pnpm gets a shim', async () => {
    installFakeCorepack();
    writeExecutable(path.join(nodeDir, 'yarn'), '#!/bin/sh\n');
    const outcomes = await ensurePackageManagerShims(getPaths(), createDeps());
    assert.deepEqual(outcomes.map((outcome) => [outcome.manager, outcome.kind]), [['yarn', 'offered'], ['pnpm', 'shim']]);
    assert.match(fs.readFileSync(argumentsLog, 'utf8'), /^enable --install-directory \S+ pnpm$/m);
    assert.equal(fs.existsSync(path.join(getPaths().binDir, 'yarn')), false);
  });

  it('a shim made for an earlier Node is removed once the Node or the system offers the manager — the Node\'s own is never shadowed — and a file that is not Corepack\'s is left alone', async () => {
    installFakeCorepack();
    await ensurePackageManagerShims(getPaths(), createDeps());
    writeExecutable(path.join(nodeDir, 'yarn'), '#!/bin/sh\n');
    writeExecutable(path.join(nodeDir, 'pnpm'), '#!/bin/sh\n');
    fs.rmSync(path.join(getPaths().binDir, 'pnpm'));
    writeExecutable(path.join(getPaths().binDir, 'pnpm'), '#!/bin/sh\necho the operator\'s own\n');
    const outcomes = await ensurePackageManagerShims(getPaths(), createDeps());
    assert.deepEqual(outcomes.map((outcome) => outcome.kind), ['offered', 'offered']);
    assert.equal(fs.existsSync(path.join(getPaths().binDir, 'yarn')), false, 'the stale Corepack shim is gone');
    assert.match(fs.readFileSync(path.join(getPaths().binDir, 'pnpm'), 'utf8'), /the operator's own/);
  });

  it('a manager the system folders offer (/usr/local/bin, Homebrew\'s) is used as it is — Corepack is not asked again, and the shim made before it appeared goes', async () => {
    installFakeCorepack();
    await ensurePackageManagerShims(getPaths(), createDeps());
    assert.equal(fs.readlinkSync(path.join(getPaths().binDir, 'yarn')), path.join(corepackDist, 'yarn.js'), 'precondition: the Node alone offers nothing, so both have a shim');
    const systemManagers = new Set(['/usr/local/bin/yarn', '/opt/homebrew/bin/pnpm']);
    const outcomes = await ensurePackageManagerShims(getPaths(), createDeps({ checkIsExecutable: (candidate) => systemManagers.has(candidate) || checkIsExecutableUnderRoot(candidate) }));
    assert.equal(formatShimLine(outcomes), '  package managers for jobs: yarn (/usr/local/bin) · pnpm (/opt/homebrew/bin)');
    for (const manager of ['yarn', 'pnpm']) assert.equal(fs.existsSync(path.join(getPaths().binDir, manager)), false, `the stale shim of ${manager} is gone`);
    assert.equal(fs.readFileSync(argumentsLog, 'utf8').split('\n').filter((line) => line.startsWith('enable ')).length, 1, 'Corepack was asked once, for the first run only');
  });

  it('a Node without Corepack: both are missing, with the reason and the way out; nothing is created', async () => {
    const outcomes = await ensurePackageManagerShims(getPaths(), createDeps());
    assert.deepEqual(outcomes.map((outcome) => outcome.kind), ['missing', 'missing']);
    const line = formatShimLine(outcomes);
    assert.match(line, /yarn: MISSING — the Node that runs the link \(.*\) has no Corepack — install yarn and pnpm for it \(`npm install -g yarn pnpm`\)/);
    assert.equal(fs.existsSync(getPaths().binDir), false);
  });

  it('a Corepack that fails is a missing outcome with its last error line — never an exception', async () => {
    installFakeCorepack({ exitCode: 1, stderr: 'Error: EACCES, permission denied' });
    const outcomes = await ensurePackageManagerShims(getPaths(), createDeps());
    assert.deepEqual(outcomes.map((outcome) => outcome.kind), ['missing', 'missing']);
    assert.match(formatShimLine(outcomes), /yarn: MISSING — `corepack enable` failed: Error: EACCES, permission denied/);
  });

  it('a Corepack that answers but makes no shim is a missing outcome that says so', async () => {
    writeExecutable(path.join(nodeDir, 'corepack'), '#!/bin/sh\nexit 0\n');
    const outcomes = await ensurePackageManagerShims(getPaths(), createDeps());
    assert.deepEqual(outcomes.map((outcome) => outcome.kind), ['missing', 'missing']);
    assert.match(formatShimLine(outcomes), /`corepack enable` made no shim for it/);
  });

  // The folder of the Node that RUNS this test, as the module itself takes it (`path.dirname(process.execPath)`). Not `which node`: under
  // `yarn test` that is yarn's own temporary shim folder, which holds a `node` wrapper and no Corepack.
  const realNodeDir = path.dirname(process.execPath);
  const realCorepack = spawnSync(path.join(realNodeDir, 'corepack'), ['--version'], { encoding: 'utf8' });
  it('the REAL Corepack\'s `enable --install-directory` makes the shims this module counts on (symlinks into its own `corepack` folder) — and they are then recognised and removed', { skip: realCorepack.status === 0 ? false : 'no Corepack in the folder of the Node that runs the tests' }, async () => {
    const corepackPath = fs.realpathSync(path.join(realNodeDir, 'corepack'));
    // The machine's own yarn or pnpm (in the Node's folder or the system's) must not hide the case: only `<bin>`'s shims count here.
    const isOwnManager = (candidate: string): boolean => ['yarn', 'pnpm'].some((manager) => path.basename(candidate) === manager && !candidate.startsWith(getPaths().binDir));
    const deps = createDeps({ nodeDir: realNodeDir, environment: { PATH: `${realNodeDir}:${process.env.PATH ?? ''}` }, checkIsExecutable: (candidate) => createShimDeps().checkIsExecutable(candidate) && !isOwnManager(candidate) });
    assert.ok(corepackPath.includes('corepack'));
    const outcomes = await ensurePackageManagerShims(getPaths(), deps);
    assert.deepEqual(outcomes.map((outcome) => outcome.kind), ['shim', 'shim'], outcomes.map((outcome) => JSON.stringify(outcome)).join(' '));
    for (const manager of ['yarn', 'pnpm']) assert.ok(fs.readlinkSync(path.join(getPaths().binDir, manager)).split(path.sep).includes('corepack'));
    const offeredDir = path.join(root, 'other-node', 'bin');
    writeExecutable(path.join(offeredDir, 'yarn'), '#!/bin/sh\n');
    writeExecutable(path.join(offeredDir, 'pnpm'), '#!/bin/sh\n');
    const offeredAgain = await ensurePackageManagerShims(getPaths(), createDeps({ nodeDir: offeredDir }));
    assert.deepEqual(offeredAgain.map((outcome) => outcome.kind), ['offered', 'offered']);
    for (const manager of ['yarn', 'pnpm']) assert.equal(fs.existsSync(path.join(getPaths().binDir, manager)), false, `the real shim of ${manager} was recognised as Corepack's and removed`);
  });
});

describe('the `corepack` wrapper in the runner\'s bin', () => {
  const wrapperPath = (): string => path.join(getPaths().binDir, 'corepack');
  const readCalls = (): string[] => (fs.existsSync(argumentsLog) ? fs.readFileSync(argumentsLog, 'utf8').split('\n').filter((line) => !line.startsWith('PATH=') && line !== '') : []);

  /** The wrapper as a job runs it: `corepack <args>` through the file `ensurePackageManagerShims` wrote. */
  async function runWrapper(...args: string[]): Promise<void> {
    installFakeCorepack();
    await ensurePackageManagerShims(getPaths(), createDeps());
    fs.rmSync(argumentsLog, { force: true });
    fs.rmSync(path.join(getPaths().binDir, 'yarn'), { force: true });
    assert.equal(spawnSync(wrapperPath(), args, { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }).status, 0);
  }

  it('is written for a Node that has Corepack, executable, naming that Corepack and the runner\'s bin — and not rewritten when nothing changed', async () => {
    installFakeCorepack();
    await ensurePackageManagerShims(getPaths(), createDeps());
    assert.equal(fs.readFileSync(wrapperPath(), 'utf8'), renderCorepackWrapper(path.join(nodeDir, 'corepack'), getPaths().binDir));
    assert.equal(fs.statSync(wrapperPath()).mode & 0o777, 0o755);
    const inode = fs.statSync(wrapperPath()).ino;
    await ensurePackageManagerShims(getPaths(), createDeps());
    assert.equal(fs.statSync(wrapperPath()).ino, inode);
  });

  it('turns a bare `corepack enable` (what a project\'s install step runs) into one for the runner\'s bin — the Node\'s own folder is not the account\'s to write', async () => {
    await runWrapper('enable');
    assert.deepEqual(readCalls(), [`enable --install-directory ${getPaths().binDir}`]);
  });

  it('keeps the names the job gave, and does the same for `disable`', async () => {
    await runWrapper('enable', 'yarn', 'pnpm');
    assert.deepEqual(readCalls(), [`enable --install-directory ${getPaths().binDir} yarn pnpm`]);
    fs.rmSync(argumentsLog);
    assert.equal(spawnSync(wrapperPath(), ['disable'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }).status, 0);
    assert.deepEqual(readCalls(), [`disable --install-directory ${getPaths().binDir}`]);
  });

  it('leaves a job\'s own `--install-directory` alone, in both spellings and wherever it stands', async () => {
    const jobBin = path.join(root, 'job', 'bin');
    const otherBin = path.join(root, 'other', 'bin');
    fs.mkdirSync(jobBin, { recursive: true });
    fs.mkdirSync(otherBin, { recursive: true });
    await runWrapper('enable', '--install-directory', jobBin, 'yarn');
    assert.deepEqual(readCalls(), [`enable --install-directory ${jobBin} yarn`]);
    fs.rmSync(argumentsLog);
    assert.equal(spawnSync(wrapperPath(), ['enable', 'yarn', `--install-directory=${otherBin}`], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }).status, 0);
    assert.deepEqual(readCalls(), [`enable yarn --install-directory=${otherBin}`]);
    assert.equal(fs.existsSync(path.join(otherBin, 'yarn')), true, 'and it landed where the job said');
  });

  it('passes every other command through untouched (`prepare`, `install`, `--version`), and the real Corepack\'s exit status', async () => {
    await runWrapper('prepare', 'yarn@1.22.22', '--activate');
    assert.deepEqual(readCalls(), ['prepare yarn@1.22.22 --activate']);
    fs.rmSync(argumentsLog);
    assert.equal(spawnSync(wrapperPath(), ['--version'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }).status, 0);
    assert.deepEqual(readCalls(), ['--version']);
  });

  it('quotes its two paths, so a folder with a space or a quote in its name cannot become a command', () => {
    const text = renderCorepackWrapper("/opt/it's here/corepack", '/home/a b/bin');
    assert.ok(text.includes(`REAL='/opt/it'\\''s here/corepack'`));
    assert.ok(text.includes("INSTALL_DIRECTORY='/home/a b/bin'"));
    assert.equal(spawnSync('sh', ['-n', '-c', text]).status, 0);
  });

  it('is not made for a Node without Corepack; one made for an earlier Node is taken out; a `corepack` that is not ours is never touched', async () => {
    await ensurePackageManagerShims(getPaths(), createDeps());
    assert.equal(fs.existsSync(wrapperPath()), false, 'nothing to wrap');
    installFakeCorepack();
    await ensurePackageManagerShims(getPaths(), createDeps());
    assert.equal(fs.existsSync(wrapperPath()), true);
    fs.rmSync(path.join(nodeDir, 'corepack'));
    await ensurePackageManagerShims(getPaths(), createDeps());
    assert.equal(fs.existsSync(wrapperPath()), false, 'the Node it wrapped is gone');
    writeExecutable(wrapperPath(), '#!/bin/sh\necho the operator\'s own\n');
    installFakeCorepack();
    await ensurePackageManagerShims(getPaths(), createDeps());
    assert.equal(fs.readFileSync(wrapperPath(), 'utf8'), '#!/bin/sh\necho the operator\'s own\n');
    fs.rmSync(path.join(nodeDir, 'corepack'));
    await ensurePackageManagerShims(getPaths(), createDeps());
    assert.equal(fs.existsSync(wrapperPath()), true, 'and not removed either');
  });

  // The thing it is for: a Node whose folder the account cannot write (the runner's Node is root's), the real Corepack, a bare `corepack enable`.
  const realNodeDir = path.dirname(process.execPath);
  const realCorepackFile = path.join(realNodeDir, 'corepack');
  const skipReason = ((): string | false => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return 'root can write a read-only folder, so the case proves nothing';
    return spawnSync(realCorepackFile, ['--version'], { encoding: 'utf8' }).status === 0 ? false : 'no Corepack in the folder of the Node that runs the tests';
  })();
  it('with the REAL Corepack in a Node folder the account cannot write, a bare `corepack enable` through the wrapper puts the shims in the runner\'s bin — where it fails without the wrapper', { skip: skipReason }, async () => {
    const copiedNode = path.join(root, 'readonly-node');
    fs.mkdirSync(path.join(copiedNode, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(copiedNode, 'lib', 'node_modules'), { recursive: true });
    fs.cpSync(path.join(path.dirname(fs.realpathSync(realCorepackFile)), '..'), path.join(copiedNode, 'lib', 'node_modules', 'corepack'), { recursive: true });
    fs.symlinkSync(process.execPath, path.join(copiedNode, 'bin', 'node'));
    fs.symlinkSync('../lib/node_modules/corepack/dist/corepack.js', path.join(copiedNode, 'bin', 'corepack'));
    fs.chmodSync(path.join(copiedNode, 'lib', 'node_modules', 'corepack', 'dist', 'corepack.js'), 0o755);
    const run = (command: string, args: string[]): { status: number | null; output: string } => {
      const result = spawnSync(command, args, { encoding: 'utf8', env: { PATH: `${path.join(copiedNode, 'bin')}:/usr/bin:/bin`, HOME: path.join(root, 'home') } });
      return { status: result.status, output: `${result.stdout}${result.stderr}` };
    };
    const realNodeBin = path.join(copiedNode, 'bin');
    const writableModeOff = (folder: string): void => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        if (entry.isDirectory()) writableModeOff(path.join(folder, entry.name));
      }
      fs.chmodSync(folder, 0o555);
    };
    writableModeOff(path.join(copiedNode, 'bin'));
    try {
      const bare = run(path.join(realNodeBin, 'corepack'), ['enable']);
      assert.notEqual(bare.status, 0, 'without the wrapper the shims go into the Node\'s own folder, which the account cannot write');
      assert.match(bare.output, /EACCES|EPERM|permission denied/i);
      const deps = createDeps({ nodeDir: realNodeBin, checkIsExecutable: (candidate) => checkIsExecutableOnDisk(candidate) && candidate.startsWith(`${root}${path.sep}`), environment: { PATH: `${realNodeBin}:/usr/bin:/bin` } });
      await ensurePackageManagerShims(getPaths(), deps);
      fs.rmSync(path.join(getPaths().binDir, 'yarn'), { force: true });
      fs.rmSync(path.join(getPaths().binDir, 'pnpm'), { force: true });
      const wrapped = run(wrapperPath(), ['enable']);
      assert.equal(wrapped.status, 0, wrapped.output);
      for (const manager of ['yarn', 'pnpm']) assert.equal(fs.lstatSync(path.join(getPaths().binDir, manager)).isSymbolicLink(), true, manager);
    } finally {
      for (const folder of [path.join(copiedNode, 'bin'), path.join(copiedNode, 'lib')]) {
        spawnSync('chmod', ['-R', 'u+w', folder]);
      }
    }
  });
});
