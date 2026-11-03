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
import { createShimDeps, ensurePackageManagerShims, formatShimLine, type ShimDeps } from '../runnerUtility/packageManagerShims';
import { getRunnerHomePaths } from '../runnerUtility/runnerHome';

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
    'dir=; names=',
    'while [ $# -gt 0 ]; do',
    '  case $1 in',
    '    enable) ;;',
    '    --install-directory) dir=$2; shift ;;',
    '    *) names="$names $1" ;;',
    '  esac',
    '  shift',
    'done',
    'for name in $names; do',
    `  ln -sf "${corepackDist}/$name.js" "$dir/$name"`,
    'done',
    '',
  ].join('\n'));
}

function createDeps(overrides: Partial<ShimDeps> = {}): ShimDeps {
  return { ...createShimDeps(), nodeDir, environment: { PATH: '/usr/bin:/bin' }, ...overrides };
}

describe('the job PATH folders', () => {
  it('are the runner\'s bin first, then the Node\'s folder, then the system\'s — the order the environment of a job is built from', () => {
    const folders = getJobPathDirectories(getPaths(), nodeDir);
    assert.deepEqual(folders.slice(0, 2), [getPaths().binDir, nodeDir]);
    assert.ok(folders.includes('/usr/bin'));
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

  const realCorepack = spawnSync('corepack', ['--version'], { encoding: 'utf8' });
  it('the REAL Corepack\'s `enable --install-directory` makes the shims this module counts on (symlinks into its own `corepack` folder) — and they are then recognised and removed', { skip: realCorepack.status === 0 ? false : 'no Corepack on this machine' }, async () => {
    const corepackPath = fs.realpathSync(spawnSync('which', ['corepack'], { encoding: 'utf8' }).stdout.trim());
    const realNodeDir = path.dirname(spawnSync('which', ['node'], { encoding: 'utf8' }).stdout.trim());
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
