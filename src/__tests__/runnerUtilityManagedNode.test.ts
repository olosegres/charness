/**
 * @description `runnerUtility/managedNode.ts`: a runner runs on its OWN Node.js. Which Nodes count as the runner's own (the shared folder the admin line
 * installs into, the account's `~/.charness-runner/node`, by REAL path); what the move off a system Node asks of the package's `ensureNode.sh` and what it
 * accepts back; and — with the real script and a local mirror of nodejs.org — that a runner on a system Node ends up with the verified build in its own folder.
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
import { moveToOwnNodeIfNeeded } from '../runnerUtility/runnerCommands';
import { ensureLauncher } from '../runnerUtility/launcher';
import { checkIsManagedNode, createNodeMoveDeps, ensureNodeScriptRelativePath, moveToOwnNode, testKeepNodeEnvName, testNodeDistEnvName, type NodeMoveDeps } from '../runnerUtility/managedNode';
import { getRunnerHomePaths } from '../runnerUtility/runnerHome';
import { sharedNodeBase } from '../runnerUtility/serviceCommon';
import { mirrorRelease, nodeThatIsTooOld, nodeThatRuns, writeNodeMirror } from './nodeMirrorKit';

const repoRoot = path.resolve(__dirname, '..', '..');
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
});

describe('moving a runner off a system Node', () => {
  interface Call { file: string; args: readonly string[]; options: CommandOptions }

  function createDeps(answer: Partial<CommandResult>, overrides: Partial<NodeMoveDeps> = {}): { deps: NodeMoveDeps; calls: Call[] } {
    const calls: Call[] = [];
    const runner: CommandRunner = async (file, args, options) => {
      calls.push({ file, args, options });
      return { ok: true, exitCode: 0, stdout: '', stderr: '', isTimedOut: false, ...answer };
    };
    return { deps: { runner, currentNodePath: '/opt/homebrew/bin/node', scriptPath: '/app/remoteRun/ensureNode.sh', distUrl: null, sharedBase: path.join(root, 'shared'), checkScriptExists: () => true, ...overrides }, calls };
  }

  it('does nothing on a Node that is the runner\'s own already — the script is not even started', async () => {
    const own = writeFile(path.join(paths.ownNodeDir, 'v22.99.0', 'bin', 'node'));
    const { deps, calls } = createDeps({}, { currentNodePath: own });
    assert.deepEqual(await moveToOwnNode(paths, deps), { kind: 'managed' });
    assert.deepEqual(calls, []);
  });

  it('asks the package\'s script, in `own` mode, for a Node in the account\'s Node folder — with a deadline — and takes the path it prints, and its words for the log', async () => {
    const installed = path.join(paths.ownNodeDir, 'v22.99.0', 'bin', 'node');
    const { deps, calls } = createDeps({ stdout: `${installed}\n`, stderr: 'charness-runner: installing Node.js v22.99.0\n' });
    assert.deepEqual(await moveToOwnNode(paths, deps), { kind: 'moved', nodePath: installed, log: 'charness-runner: installing Node.js v22.99.0' });
    assert.equal(calls.length, 1);
    assert.deepEqual([calls[0].file, calls[0].args], ['sh', ['/app/remoteRun/ensureNode.sh', 'own', paths.ownNodeDir]]);
    assert.ok(calls[0].options.timeoutMs > 0, 'a finite child has a deadline');
  });

  it('hands the script a flow\'s own mirror to download from, when the test seam names one — and only then', async () => {
    const installed = path.join(paths.ownNodeDir, 'v22.99.0', 'bin', 'node');
    const withMirror = createDeps({ stdout: `${installed}\n` }, { distUrl: 'file:///mirror' });
    await moveToOwnNode(paths, withMirror.deps);
    assert.deepEqual(withMirror.calls[0].args, ['/app/remoteRun/ensureNode.sh', 'own', paths.ownNodeDir, 'file:///mirror']);
    assert.equal(createNodeMoveDeps('/app', runCommand, { [testNodeDistEnvName]: 'file:///m' }).distUrl, 'file:///m');
    assert.equal(createNodeMoveDeps('/app', runCommand, {}).distUrl, null);
    assert.equal(createNodeMoveDeps('/app', runCommand, { [testNodeDistEnvName]: '' }).distUrl, null);
    assert.equal(createNodeMoveDeps('/app', runCommand, {}).scriptPath, path.join('/app', ensureNodeScriptRelativePath));
  });

  it('fails — with the script\'s last words — when the script does, and never throws; the runner stays on the Node it has', async () => {
    const failed = createDeps({ ok: false, exitCode: 1, stderr: 'charness-runner: could not download\ncharness-runner: nothing was installed\n' });
    assert.deepEqual(await moveToOwnNode(paths, failed.deps), { kind: 'failed', reason: 'charness-runner: could not download\ncharness-runner: nothing was installed' });
    const timedOut = createDeps({ ok: false, exitCode: null, isTimedOut: true });
    const outcome = await moveToOwnNode(paths, timedOut.deps);
    assert.equal(outcome.kind, 'failed');
    assert.match(outcome.kind === 'failed' ? outcome.reason : '', /did not finish within 15 minutes/);
    const silent = createDeps({ ok: false, exitCode: 3 });
    const silentOutcome = await moveToOwnNode(paths, silent.deps);
    assert.match(silentOutcome.kind === 'failed' ? silentOutcome.reason : '', /failed \(exit 3\)/);
  });

  it('fails when the package has no script (a hub that does not ship it), without starting anything', async () => {
    const { deps, calls } = createDeps({}, { checkScriptExists: () => false });
    const outcome = await moveToOwnNode(paths, deps);
    assert.equal(outcome.kind, 'failed');
    assert.deepEqual(calls, []);
  });

  it('does not take a path outside the runner\'s Node folders for an answer — a script that prints a system Node, or nothing, has not moved the runner', async () => {
    for (const stdout of ['/opt/homebrew/bin/node\n', '\n', 'relative/bin/node\n']) {
      const outcome = await moveToOwnNode(paths, createDeps({ stdout }).deps);
      assert.equal(outcome.kind, 'failed', JSON.stringify(stdout));
    }
  });
});

describe('moving a runner off a system Node, for real: the package\'s script and a local mirror of nodejs.org', () => {
  it('puts the verified build in the account\'s own folder, and a runner that is there already is left alone', async () => {
    const distDir = writeNodeMirror(path.join(root, 'dist'), path.join(root, 'stage'), { nodeScript: nodeThatRuns });
    const deps: NodeMoveDeps = { ...createNodeMoveDeps(repoRoot, runCommand, { [testNodeDistEnvName]: `file://${distDir}` }), currentNodePath: '/opt/homebrew/bin/node' };
    const moved = await moveToOwnNode(paths, deps);
    assert.deepEqual(moved.kind === 'moved' ? moved.nodePath : moved, path.join(paths.ownNodeDir, mirrorRelease, 'bin', 'node'));
    assert.match(moved.kind === 'moved' ? moved.log : '', /installing Node\.js v22\.99\.0 for the runner into /);
    assert.deepEqual(await moveToOwnNode(paths, { ...deps, currentNodePath: moved.kind === 'moved' ? moved.nodePath : '' }), { kind: 'managed' });
  });

  it('with an archive that does not match its checksum, fails and installs nothing — the runner keeps its Node', async () => {
    const distDir = writeNodeMirror(path.join(root, 'dist'), path.join(root, 'stage'), { isChecksumWrong: true });
    const deps: NodeMoveDeps = { ...createNodeMoveDeps(repoRoot, runCommand, { [testNodeDistEnvName]: `file://${distDir}` }), currentNodePath: '/opt/homebrew/bin/node' };
    const outcome = await moveToOwnNode(paths, deps);
    assert.equal(outcome.kind, 'failed');
    assert.match(outcome.kind === 'failed' ? outcome.reason : '', /does not match nodejs\.org's SHASUMS256\.txt/);
    assert.deepEqual(fs.readdirSync(paths.ownNodeDir), []);
  });

  it('with a build that is too old for the runner, fails the same way', async () => {
    const distDir = writeNodeMirror(path.join(root, 'dist'), path.join(root, 'stage'), { nodeScript: nodeThatIsTooOld });
    const deps: NodeMoveDeps = { ...createNodeMoveDeps(repoRoot, runCommand, { [testNodeDistEnvName]: `file://${distDir}` }), currentNodePath: '/opt/homebrew/bin/node' };
    assert.equal((await moveToOwnNode(paths, deps)).kind, 'failed');
  });
});

describe('the link\'s decision to leave for its own Node (moveToOwnNodeIfNeeded)', () => {
  const systemNode = '/opt/homebrew/bin/node';

  function createIo(): { io: { stdout: (text: string) => void; stderr: (text: string) => void }; stdout: string[]; stderr: string[] } {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return { io: { stdout: (text) => { stdout.push(text); }, stderr: (text) => { stderr.push(text); } }, stdout, stderr };
  }

  /** Move deps whose script is a stand-in that prints `nodePath` (or fails), and counts its runs. */
  function createDeps(answer: { nodePath?: string; fails?: boolean }, currentNodePath: string = systemNode): { deps: NodeMoveDeps; runs: () => number } {
    let runs = 0;
    const runner: CommandRunner = async () => {
      runs += 1;
      if (answer.fails === true) return { ok: false, exitCode: 1, stdout: '', stderr: 'charness-runner: could not download Node.js\n', isTimedOut: false };
      return { ok: true, exitCode: 0, stdout: `${answer.nodePath ?? ''}\n`, stderr: 'charness-runner: installing Node.js v22.99.0\n', isTimedOut: false };
    };
    return { deps: { runner, currentNodePath, scriptPath: '/app/remoteRun/ensureNode.sh', distUrl: null, sharedBase: path.join(root, 'shared'), checkScriptExists: () => true }, runs: () => runs };
  }

  it('leaves for a restart when the Node has been put in place: the launcher is rewritten to name it, and the log says so', async () => {
    const installed = writeFile(path.join(paths.ownNodeDir, 'v22.99.0', 'bin', 'node'));
    ensureLauncher(paths, systemNode);
    const { io, stdout, stderr } = createIo();
    const { deps } = createDeps({ nodePath: installed });
    assert.equal(await moveToOwnNodeIfNeeded(paths, io, deps, {}), 'restart');
    assert.equal(fs.readFileSync(paths.launcher, 'utf8').includes(`NODE='${installed}'`), true);
    assert.match(stdout.join(''), new RegExp(`this runner now has its own Node\\.js \\(${installed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\) and leaves ${systemNode.replace(/\./g, '\\.')}`));
    assert.match(stderr.join(''), /installing Node\.js v22\.99\.0/, 'the script\'s own words reach the log');
  });

  it('does NOT leave — and leaves the launcher alone — when the launcher already names that Node but this link still runs on another (an old launcher process that has not been restarted, or a Node that could not start): leaving would loop, rewriting it for the running Node would undo the move', async () => {
    const installed = writeFile(path.join(paths.ownNodeDir, 'v22.99.0', 'bin', 'node'));
    ensureLauncher(paths, installed);
    const inode = fs.statSync(paths.launcher).ino;
    const { io, stderr } = createIo();
    assert.equal(await moveToOwnNodeIfNeeded(paths, io, createDeps({ nodePath: installed }).deps, {}), 'keep-launcher');
    assert.match(stderr.join(''), /the launcher already names \S+, but this link still runs on Node\.js \S+ at \/opt\/homebrew\/bin\/node: start the launcher again to use it/);
    assert.equal(fs.statSync(paths.launcher).ino, inode, 'and the launcher is left as it is');
  });

  it('stays where it is, and says why and that it tries again, when the Node cannot be got — the launcher is not touched', async () => {
    ensureLauncher(paths, systemNode);
    const before = fs.readFileSync(paths.launcher, 'utf8');
    const { io, stderr } = createIo();
    assert.equal(await moveToOwnNodeIfNeeded(paths, io, createDeps({ fails: true }).deps, {}), 'continue');
    assert.match(stderr.join(''), /^charness-runner: this runner runs on Node\.js \S+ at \/opt\/homebrew\/bin\/node, not on a Node\.js of its own, and could not get one: charness-runner: could not download Node\.js\. It tries again at its next start\.\n$/);
    assert.equal(fs.readFileSync(paths.launcher, 'utf8'), before);
  });

  it('asks for nothing on a link that already runs on its own Node, and on a flow\'s runner that is told to keep the Node it has', async () => {
    const own = writeFile(path.join(paths.ownNodeDir, 'v22.99.0', 'bin', 'node'));
    const onOwn = createDeps({ nodePath: own }, own);
    assert.equal(await moveToOwnNodeIfNeeded(paths, createIo().io, onOwn.deps, {}), 'continue');
    assert.equal(onOwn.runs(), 0);
    const kept = createDeps({ nodePath: own });
    assert.equal(await moveToOwnNodeIfNeeded(paths, createIo().io, kept.deps, { [testKeepNodeEnvName]: '1' }), 'continue');
    assert.equal(kept.runs(), 0, 'the seam skips the move before the script is asked');
  });
});
