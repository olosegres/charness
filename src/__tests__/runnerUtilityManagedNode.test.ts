/**
 * @description `runnerUtility/managedNode.ts`: a runner runs on its OWN Node.js. Which Nodes count as the runner's own (the shared folder the admin line
 * installs into, the account's `~/.charness-runner/node`, by REAL path); what looking after it asks of the package's `ensureNode.sh` and what it accepts back
 * (a move off a system Node, a newer release of the line an own Node is on, nothing for the shared one); the outer deadline against the script's own limits;
 * and — with the real script and a local mirror of nodejs.org — that a runner on a system Node ends up with the verified build in its own folder.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CommandOptions, CommandResult, CommandRunner } from '../selfUpdate/commandRunner';
import { runCommand } from '../selfUpdate/commandRunner';
import {
  checkIsManagedNode,
  createNodeMoveDeps,
  describeNode,
  ensureNodeScriptRelativePath,
  ensureOwnNode,
  formatScriptWords,
  getInstalledVersion,
  getOwnInstallFolder,
  moveDeadlineMs,
  testNodeDistEnvName,
  type NodeMoveDeps,
} from '../runnerUtility/managedNode';
import { getRunnerHomePaths } from '../runnerUtility/runnerHome';
import { sharedNodeBase } from '../runnerUtility/serviceCommon';
import { mirrorRelease, nodeThatIsTooOld, nodeThatRuns, writeNodeMirror } from './nodeMirrorKit';

const repoRoot = path.resolve(__dirname, '..', '..');
const scriptText = fs.readFileSync(path.join(repoRoot, ensureNodeScriptRelativePath), 'utf8');
let root = '';
let paths = getRunnerHomePaths('/home/runner');

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-node-')));
  paths = getRunnerHomePaths(path.join(root, 'home'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeFile(filePath: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '');
  return filePath;
}

describe('which Node is the runner\'s own', () => {
  it('is one inside the shared folder or the account\'s own Node folder — judged by its real path, so a link into a system Node does not count', () => {
    const sharedBase = path.join(root, 'shared');
    const shared = writeFile(path.join(sharedBase, 'v22.99.0', 'bin', 'node'));
    const own = writeFile(path.join(paths.ownNodeDir, 'v22.99.0', 'bin', 'node'));
    const system = writeFile(path.join(root, 'brew', 'bin', 'node'));
    assert.equal(checkIsManagedNode(shared, paths, sharedBase), true);
    assert.equal(checkIsManagedNode(own, paths, sharedBase), true);
    assert.equal(checkIsManagedNode(system, paths, sharedBase), false);
    const linkInside = path.join(paths.ownNodeDir, 'v22.1.0', 'bin', 'node');
    fs.mkdirSync(path.dirname(linkInside), { recursive: true });
    fs.symlinkSync(system, linkInside);
    assert.equal(checkIsManagedNode(linkInside, paths, sharedBase), false, 'it leads to a system Node');
    const linkOutside = path.join(root, 'usr-bin-node');
    fs.symlinkSync(shared, linkOutside);
    assert.equal(checkIsManagedNode(linkOutside, paths, sharedBase), true, 'it leads to the shared one');
  });

  it('is not the folder itself, nor a sibling that only shares its name as a prefix', () => {
    const sharedBase = path.join(root, 'shared');
    assert.equal(checkIsManagedNode(sharedBase, paths, sharedBase), false);
    assert.equal(checkIsManagedNode(`${sharedBase}-other/bin/node`, paths, sharedBase), false);
    assert.equal(checkIsManagedNode(`${paths.ownNodeDir}x/v1/bin/node`, paths, sharedBase), false);
  });

  it('knows the shared folder the admin line installs into', () => {
    assert.equal(sharedNodeBase, '/usr/local/lib/charness-runner/node');
    assert.equal(checkIsManagedNode(`${sharedNodeBase}/v22.23.4/bin/node`, paths), true);
    assert.equal(checkIsManagedNode('/opt/homebrew/bin/node', paths), false);
  });

  it('words what the script said without the prefix every line of it starts with — the log puts its own', () => {
    assert.equal(formatScriptWords('charness-runner: installing Node.js v24.1.0\n\ncharness-runner: Node.js v24.1.0 is installed\nplain words\n'), 'installing Node.js v24.1.0; Node.js v24.1.0 is installed; plain words');
    assert.equal(formatScriptWords(''), '');
  });

  it('names an install by its folder: the version, and the version folder of an own one', () => {
    const own = writeFile(path.join(paths.ownNodeDir, 'v24.22.2', 'bin', 'node'));
    assert.equal(getInstalledVersion(own), '24.22.2');
    assert.equal(getInstalledVersion('/opt/homebrew/bin/node'), 'unknown');
    assert.equal(getOwnInstallFolder(own, paths), path.join(paths.ownNodeDir, 'v24.22.2'));
    assert.equal(getOwnInstallFolder('/opt/homebrew/bin/node', paths), null);
    assert.equal(describeNode('/opt/homebrew/bin/node', '25.1.0'), 'Node.js 25.1.0 at /opt/homebrew/bin/node');
  });
});

describe('the outer deadline of an install', () => {
  it('is longer than the script\'s own limits put together (two small downloads and the archive), so the script ends by its own limits and says why', () => {
    const readSeconds = (name: string): number => Number(new RegExp(`^${name}=(\\d+)$`, 'm').exec(scriptText)?.[1]);
    const innerSeconds = 2 * readSeconds('shasums_timeout') + readSeconds('archive_timeout');
    assert.ok(Number.isInteger(innerSeconds) && innerSeconds > 0, 'the script names its limits');
    assert.ok(moveDeadlineMs / 1000 > innerSeconds, `${moveDeadlineMs / 1000} s must exceed ${innerSeconds} s`);
  });
});

describe('looking after the runner\'s own Node (ensureOwnNode)', () => {
  interface Call { file: string; args: readonly string[]; options: CommandOptions }

  function createDeps(answer: Partial<CommandResult>, overrides: Partial<NodeMoveDeps> = {}): { deps: NodeMoveDeps; calls: Call[] } {
    const calls: Call[] = [];
    const runner: CommandRunner = async (file, args, options) => {
      calls.push({ file, args, options });
      return { ok: true, exitCode: 0, stdout: '', stderr: '', isTimedOut: false, ...answer };
    };
    return {
      deps: { runner, currentNodePath: '/opt/homebrew/bin/node', currentNodeVersion: '25.1.0', scriptPath: '/app/remoteRun/ensureNode.sh', distUrl: null, sharedBase: path.join(root, 'shared'), checkScriptExists: () => true, ...overrides },
      calls,
    };
  }

  it('does nothing for the shared Node of an admin line — the script is not even started: only the next admin line refreshes it', async () => {
    const shared = writeFile(path.join(root, 'shared', 'v22.99.0', 'bin', 'node'));
    const { deps, calls } = createDeps({}, { currentNodePath: shared });
    assert.deepEqual(await ensureOwnNode(paths, deps), { kind: 'shared' });
    assert.deepEqual(calls, []);
  });

  it('on a system Node asks the package\'s script, in `own` mode, for a Node in the account\'s folder — with a deadline and NO line: the newest LTS — and takes the path it prints', async () => {
    const installed = path.join(paths.ownNodeDir, 'v24.99.0', 'bin', 'node');
    const { deps, calls } = createDeps({ stdout: `${installed}\n`, stderr: 'charness-runner: installing Node.js v24.99.0\n' });
    assert.deepEqual(await ensureOwnNode(paths, deps), { kind: 'installed', nodePath: installed, log: 'installing Node.js v24.99.0', isMove: true });
    assert.equal(calls.length, 1);
    assert.deepEqual([calls[0].file, calls[0].args], ['sh', ['/app/remoteRun/ensureNode.sh', 'own', paths.ownNodeDir]]);
    assert.equal(calls[0].options.timeoutMs, moveDeadlineMs);
  });

  it('on its own Node asks for the newest release of ITS line (the major it runs on) — a new major would change what every job runs — and is `current` when that is the Node it runs', async () => {
    const own = writeFile(path.join(paths.ownNodeDir, 'v22.20.0', 'bin', 'node'));
    const same = createDeps({ stdout: `${own}\n` }, { currentNodePath: own, currentNodeVersion: '22.20.0' });
    assert.deepEqual(await ensureOwnNode(paths, same.deps), { kind: 'current' });
    assert.deepEqual(same.calls[0].args, ['/app/remoteRun/ensureNode.sh', 'own', paths.ownNodeDir, '', '22']);
    const newer = path.join(paths.ownNodeDir, 'v22.23.4', 'bin', 'node');
    const found = createDeps({ stdout: `${newer}\n` }, { currentNodePath: own, currentNodeVersion: '22.20.0' });
    assert.deepEqual(await ensureOwnNode(paths, found.deps), { kind: 'installed', nodePath: newer, log: '', isMove: false });
  });

  it('hands the script a flow\'s own mirror to download from, when the test seam names one — and only then', async () => {
    const installed = path.join(paths.ownNodeDir, 'v22.99.0', 'bin', 'node');
    const withMirror = createDeps({ stdout: `${installed}\n` }, { distUrl: 'file:///mirror' });
    await ensureOwnNode(paths, withMirror.deps);
    assert.deepEqual(withMirror.calls[0].args, ['/app/remoteRun/ensureNode.sh', 'own', paths.ownNodeDir, 'file:///mirror']);
    const own = writeFile(path.join(paths.ownNodeDir, 'v22.20.0', 'bin', 'node'));
    const onOwn = createDeps({ stdout: `${installed}\n` }, { distUrl: 'file:///mirror', currentNodePath: own, currentNodeVersion: '22.20.0' });
    await ensureOwnNode(paths, onOwn.deps);
    assert.deepEqual(onOwn.calls[0].args, ['/app/remoteRun/ensureNode.sh', 'own', paths.ownNodeDir, 'file:///mirror', '22']);
    assert.equal(createNodeMoveDeps('/app', runCommand, { [testNodeDistEnvName]: 'file:///m' }).distUrl, 'file:///m');
    assert.equal(createNodeMoveDeps('/app', runCommand, {}).distUrl, null);
    assert.equal(createNodeMoveDeps('/app', runCommand, { [testNodeDistEnvName]: '' }).distUrl, null);
    assert.equal(createNodeMoveDeps('/app', runCommand, {}).scriptPath, path.join('/app', ensureNodeScriptRelativePath));
    assert.equal(createNodeMoveDeps('/app', runCommand, {}).currentNodeVersion, process.versions.node);
  });

  it('fails — with the script\'s last words — when the script does, and never throws; the runner stays on the Node it has', async () => {
    const failed = createDeps({ ok: false, exitCode: 1, stderr: 'charness-runner: could not download\ncharness-runner: nothing was installed\n' });
    assert.deepEqual(await ensureOwnNode(paths, failed.deps), { kind: 'failed', reason: 'could not download; nothing was installed' });
    const timedOut = await ensureOwnNode(paths, createDeps({ ok: false, exitCode: null, isTimedOut: true }).deps);
    assert.equal(timedOut.kind, 'failed');
    assert.match(timedOut.kind === 'failed' ? timedOut.reason : '', /did not finish within 25 minutes/);
    const silent = await ensureOwnNode(paths, createDeps({ ok: false, exitCode: 3 }).deps);
    assert.match(silent.kind === 'failed' ? silent.reason : '', /failed \(exit 3\)/);
  });

  it('fails when the package has no script (a hub that does not ship it), without starting anything', async () => {
    const { deps, calls } = createDeps({}, { checkScriptExists: () => false });
    assert.equal((await ensureOwnNode(paths, deps)).kind, 'failed');
    assert.deepEqual(calls, []);
  });

  it('does not take a path outside the runner\'s own Node folder for an answer — a script that prints a system Node, or nothing, has put nothing in place', async () => {
    for (const stdout of ['/opt/homebrew/bin/node\n', '\n', 'relative/bin/node\n']) {
      assert.equal((await ensureOwnNode(paths, createDeps({ stdout }).deps)).kind, 'failed', JSON.stringify(stdout));
    }
  });
});

describe('looking after the runner\'s own Node, for real: the package\'s script and a local mirror of nodejs.org', () => {
  const systemNode = { currentNodePath: '/opt/homebrew/bin/node', currentNodeVersion: '25.1.0' };

  function createRealDeps(distDir: string, overrides: Partial<NodeMoveDeps> = {}): NodeMoveDeps {
    return { ...createNodeMoveDeps(repoRoot, runCommand, { [testNodeDistEnvName]: `file://${distDir}` }), ...systemNode, ...overrides };
  }

  it('puts the verified build in the account\'s own folder, and a runner that is there already is left alone', async () => {
    const distDir = writeNodeMirror(path.join(root, 'dist'), path.join(root, 'stage'), { nodeScript: nodeThatRuns });
    const moved = await ensureOwnNode(paths, createRealDeps(distDir));
    assert.deepEqual(moved.kind === 'installed' ? moved.nodePath : moved, path.join(paths.ownNodeDir, mirrorRelease, 'bin', 'node'));
    assert.match(moved.kind === 'installed' ? moved.log : '', /installing Node\.js v22\.99\.0 for the runner into /);
    const nodePath = moved.kind === 'installed' ? moved.nodePath : '';
    assert.deepEqual(await ensureOwnNode(paths, createRealDeps(distDir, { currentNodePath: nodePath, currentNodeVersion: '22.99.0' })), { kind: 'current' });
  });

  it('on its own Node moves up within its line — to the newest release of that major, not to a newer major', async () => {
    const olderDist = writeNodeMirror(path.join(root, 'dist-old'), path.join(root, 'stage-old'), { releases: [{ version: 'v22.50.0', lts: 'Jod' }] });
    const first = await ensureOwnNode(paths, createRealDeps(olderDist));
    assert.equal(first.kind === 'installed' ? path.basename(path.dirname(path.dirname(first.nodePath))) : first.kind, 'v22.50.0');
    const newerDist = writeNodeMirror(path.join(root, 'dist-new'), path.join(root, 'stage-new'), { releases: [{ version: 'v22.99.0', lts: 'Jod' }, { version: 'v24.99.0', lts: 'Krypton' }] });
    const own = first.kind === 'installed' ? first.nodePath : '';
    const moved = await ensureOwnNode(paths, createRealDeps(newerDist, { currentNodePath: own, currentNodeVersion: '22.50.0' }));
    assert.equal(moved.kind === 'installed' ? path.basename(path.dirname(path.dirname(moved.nodePath))) : moved.kind, 'v22.99.0', 'the newer 22.x, not 24');
    assert.equal(moved.kind === 'installed' ? moved.isMove : null, false);
  });

  it('with an archive that does not match its checksum, fails and installs nothing — the runner keeps its Node', async () => {
    const distDir = writeNodeMirror(path.join(root, 'dist'), path.join(root, 'stage'), { isChecksumWrong: true });
    const outcome = await ensureOwnNode(paths, createRealDeps(distDir));
    assert.equal(outcome.kind, 'failed');
    assert.match(outcome.kind === 'failed' ? outcome.reason : '', /does not match nodejs\.org's SHASUMS256\.txt/);
    assert.deepEqual(fs.readdirSync(paths.ownNodeDir), []);
  });

  it('with a build that is too old for the runner, fails the same way', async () => {
    const distDir = writeNodeMirror(path.join(root, 'dist'), path.join(root, 'stage'), { nodeScript: nodeThatIsTooOld });
    assert.equal((await ensureOwnNode(paths, createRealDeps(distDir))).kind, 'failed');
  });
});
