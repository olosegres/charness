/**
 * @description A runner paired on a SYSTEM Node.js moves to its own with nobody doing anything, and an own Node keeps up with its line — at PROCESS level: the
 * hub is a loopback `sshd` and a copy of the built charness, the runner machine a temp HOME (`runnerLinkE2e/runnerLinkFlowKit.ts`), the REAL pasted line pairs it
 * (on the Node running this flow, which is not the runner's own), the REAL `charness-runner run` holds the link. What a flow cannot have is stood in for:
 * nodejs.org is a local mirror (copies of the Node running the flow, `nodeMirrorKit.ts`) that the install reads through its test seam. In order:
 *
 *   a download that does not match its checksum → the link comes up on the Node it had, the log says why, nothing is installed and the failure is written down
 *   a start within the day → nothing is asked of the mirror again, and the log says when it will be
 *   a day later → the link is UP first, THEN the verified build is installed in `~/.charness-runner/node`, the launcher is rewritten, and the link — when no
 *   command runs — leaves and comes back RUNNING ON IT; the log names the Node it left; the failure record is gone
 *   a job over the link sees that Node first on its PATH and an npm prefix and a Corepack home inside the account's state folder
 *   a newer release of the same line appears → the runner moves up to it (not to a newer major); the release it left is kept for a week (the moment it stopped
 *   being the runner's Node is on record) and removed after it
 *   a command is held over the link while an even newer release is put in place → the link does NOT leave until the command ends
 *   a Pueue task runs while the next release is put in place → the link does NOT leave until the task is over (a job keeps the PATH it was queued with)
 *
 * Needs sshd, ssh, ssh-keyscan, rsync, Pueue, tar and the built CLI (`yarn build`): a local run without them is SKIPPED with the reason, CI fails without.
 * No registry and no network is used. Test case: N/A — Charness has no Jira tracker.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { countActivePueueTasks, pueueUnfinishedStatuses } from '../runnerUtility/pueueDaemon';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getRunnerLinkStatus } from '../runners/linkControl';
import { checkLauncherIsFor, readLauncherNodePath } from '../runnerUtility/launcher';
import { ensureNodeScriptRelativePath, testKeepNodeEnvName, testNodeDistEnvName } from '../runnerUtility/managedNode';
import { nodeMoveRetryMs, readNodeFailure } from '../runnerUtility/nodeUpkeep';
import { getRunnerHomePaths } from '../runnerUtility/runnerHome';
import type { RunnerStatus } from '../runnerUtility/runnerConfig';
import { mirrorRelease, writeNodeMirror } from './nodeMirrorKit';
import {
  createRunnerLinkLayout,
  destroyRunnerLinkLayout,
  getMissingTools,
  isCi,
  makePairingLine,
  placeRealNodeInstaller,
  readJson,
  runPairingLine,
  sshThroughLink,
  startRunner,
  startSshThroughLink,
  stopRunner,
  waitUntil,
  type RunnerLinkLayout,
} from './runnerLinkE2e/runnerLinkFlowKit';

const missingTools = getMissingTools();
const skipReason = missingTools.length > 0 && !isCi ? `missing: ${missingTools.join(', ')}` : false;
const linkTimeoutMs = 90_000;
const moveTimeoutMs = 150_000;
/** The linked runner asks the hub for its package every 2 s and a Mac looks at its lid every second (as in every flow); it looks after its Node every 3 s instead of every day. */
const flowTimings = JSON.stringify({ runnerVersionPollMs: 2000, runnerLidPollMs: 1000, runnerNodeUpkeepMs: 3000 });
const heldCommandSeconds = 25;
const pueueTaskSeconds = 25;
const dayMs = 24 * 60 * 60 * 1000;
const finalRelease = 'v22.102.0';
const newerRelease = 'v22.100.0';
const newestRelease = 'v22.101.0';
const futureMajorRelease = 'v24.99.0';

describe('a runner on a system Node moves to its own, and keeps up with its line (process level)', { skip: skipReason }, () => {
  let layout: RunnerLinkLayout;
  let paths: ReturnType<typeof getRunnerHomePaths>;
  let runnerId = '';
  let runner: ChildProcess | null = null;
  let runnerOutput = '';

  before(async () => {
    assert.deepEqual(missingTools, [], 'CI installs everything this flow needs');
    layout = await createRunnerLinkLayout();
    paths = getRunnerHomePaths(layout.runnerHome);
    // Paired by the real line on the Node running this flow — a Node that is not inside the runner's own Node folder, as a system one is not.
    const result = runPairingLine(layout, makePairingLine(layout));
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    runnerId = readJson<{ runners: Array<{ id: string }> }>(path.join(layout.hubDir, 'paired.json')).runners[0].id;
    // The new program's copy of the package carries the real script (the flow's hub package carries a stand-in that downloads nothing).
    placeRealNodeInstaller(path.join(paths.currentApp, ensureNodeScriptRelativePath));
  });
  after(async () => {
    if (runner !== null) await stopRunner(layout, runner);
    await destroyRunnerLinkLayout(layout);
  });

  function readStatus(): RunnerStatus | null {
    try {
      return readJson<RunnerStatus>(paths.status);
    } catch {
      return null;
    }
  }

  const ownFolderOf = (version: string): string => path.join(fs.realpathSync(paths.ownNodeDir), version);
  const ownNodeOf = (version: string): string => path.join(ownFolderOf(version), 'bin', 'node');

  /** Which Node the link that is up runs on (Linux: the executable of its process). */
  function readLinkNode(): string | null {
    const pid = readStatus()?.pid;
    if (pid === undefined || process.platform !== 'linux') return null;
    try {
      return fs.realpathSync(`/proc/${pid}/exe`);
    } catch {
      return null;
    }
  }

  function writeMirrorWith(name: string, releases: Array<{ version: string; lts: string | false }>, isChecksumWrong = false): string {
    return writeNodeMirror(path.join(layout.root, `${name}-dist`), path.join(layout.root, `${name}-stage`), { nodeFrom: process.execPath, releases, isChecksumWrong });
  }

  async function startMovingRunner(distDir: string): Promise<void> {
    runnerOutput = '';
    runner = startRunner(layout, layout.runnerHome, { [testKeepNodeEnvName]: '', [testNodeDistEnvName]: `file://${distDir}`, CHARNESS_TEST_TIMINGS: flowTimings });
    for (const stream of [runner.stdout, runner.stderr]) stream?.on('data', (chunk: Buffer) => { runnerOutput += chunk.toString(); });
    await waitUntil(() => readStatus()?.state === 'linked', 'the runner to report a linked state', linkTimeoutMs);
  }

  async function stopMovingRunner(): Promise<void> {
    if (runner !== null) await stopRunner(layout, runner);
    runner = null;
    fs.rmSync(paths.status, { force: true });
  }

  /** `nodePath` is built on the real path of the runner's Node folder (`ownNodeOf`), which is what a process's executable is. */
  async function waitForLinkOn(nodePath: string): Promise<void> {
    await waitUntil(() => readStatus()?.state === 'linked' && readLinkNode() === nodePath, `the link to run on ${nodePath}`, moveTimeoutMs);
    await waitUntil(async () => (await getRunnerLinkStatus(layout.hubDir, runnerId)).isOnline, 'the hub to see the link on the runner\'s own Node', linkTimeoutMs);
  }

  it('a download that does not match its checksum installs nothing: the link comes up on the Node it had, the log says why, and the failure is written down', async () => {
    await startMovingRunner(writeMirrorWith('bad', [{ version: mirrorRelease, lts: 'Jod' }], true));
    await waitUntil(() => /could not get a Node\.js of its own or a newer one: .*does not match nodejs\.org's SHASUMS256\.txt/s.test(runnerOutput), 'the log to say the install failed', moveTimeoutMs);
    assert.match(runnerOutput, /It tries again after 24 hours or the next update of the program\./);
    assert.equal(checkLauncherIsFor(paths, process.execPath), true, 'the launcher still names the Node it had');
    assert.deepEqual(fs.readdirSync(paths.ownNodeDir), [], 'nothing was installed, nothing is left half-way');
    assert.match(readNodeFailure(paths)?.reason ?? '', /does not match nodejs\.org's SHASUMS256\.txt/);
    assert.notEqual(readNodeFailure(paths)?.appId, null, 'with the app copy it happened under');
    if (process.platform === 'linux') assert.equal(readLinkNode(), fs.realpathSync(process.execPath), 'and the link runs on that Node');
    await stopMovingRunner();
  });

  it('a start within the day does not ask for the Node again — a good mirror is there, and nothing is installed — and the log says so', async () => {
    await startMovingRunner(writeMirrorWith('good', [{ version: mirrorRelease, lts: 'Jod' }]));
    await waitUntil(() => /last attempt to get a Node\.js of its own \(or a newer one\) failed — .* — and is tried again after 24 hours or the next update of the program/s.test(runnerOutput), 'the log to say the attempt waits', moveTimeoutMs);
    assert.deepEqual(fs.readdirSync(paths.ownNodeDir), []);
    assert.equal(checkLauncherIsFor(paths, process.execPath), true);
    await stopMovingRunner();
  });

  it('a day later the link comes up FIRST, then the verified build is installed and the launcher rewritten, and the link — when no command runs — leaves and comes back running ON the new Node', async () => {
    const failure = readNodeFailure(paths);
    assert.notEqual(failure, null);
    fs.writeFileSync(paths.nodeFailure, JSON.stringify({ ...failure, failedAtMs: Date.now() - nodeMoveRetryMs - 60_000 }));
    await startMovingRunner(writeMirrorWith('good', [{ version: mirrorRelease, lts: 'Jod' }]));
    await waitForLinkOn(ownNodeOf(mirrorRelease));
    const ownNode = ownNodeOf(mirrorRelease);
    assert.equal(checkLauncherIsFor(paths, ownNode), true, 'the launcher names the runner\'s own Node');
    const servingAt = runnerOutput.indexOf('charness-runner: serving ');
    const movedAt = runnerOutput.indexOf('this runner now has its own Node.js');
    assert.ok(servingAt >= 0 && movedAt > servingAt, 'the runner was serving the hub before it put the Node in place');
    assert.match(runnerOutput, new RegExp(`this runner now has its own Node\\.js 22\\.99\\.0 at ${ownNode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} and leaves Node\\.js \\S+ at ${process.execPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: jobs will run the new one`));
    assert.match(runnerOutput, /nothing is under way \(no command over the link, no update, no Pueue task\): leaving for the launcher's new start/);
    assert.equal(readNodeFailure(paths), null, 'the failure of the day before is forgotten');
  });

  it('a job over the link finds that Node first and writes what it installs into the account\'s state folder, never into the Node\'s own', async () => {
    const ownNode = ownNodeOf(mirrorRelease);
    let output = '';
    await waitUntil(() => {
      const result = sshThroughLink(layout, runnerId, 'command -v node; echo "$NPM_CONFIG_PREFIX"; echo "$COREPACK_HOME"; echo "$PATH"');
      output = result.stdout;
      return result.status === 0;
    }, 'ssh through the link to answer', linkTimeoutMs);
    const [nodeOnPath, npmPrefix, corepackHome, jobPath] = output.split('\n');
    assert.equal(fs.realpathSync(nodeOnPath), fs.realpathSync(ownNode), 'a job\'s `node` is the runner\'s own');
    assert.equal(npmPrefix, paths.npmPrefix);
    assert.equal(corepackHome, paths.corepackHome);
    assert.deepEqual(jobPath.split(':').slice(0, 3), [paths.binDir, path.join(paths.npmPrefix, 'bin'), path.dirname(nodeOnPath)]);
  });

  it('a newer release of the same line appears: the runner moves up to it — not to the newer major that is also there — and the release it left is removed once nothing uses it', async () => {
    await stopMovingRunner();
    const newerMirror = writeMirrorWith('newer', [{ version: mirrorRelease, lts: 'Jod' }, { version: newerRelease, lts: 'Jod' }, { version: futureMajorRelease, lts: 'Krypton' }]);
    await startMovingRunner(newerMirror);
    await waitForLinkOn(ownNodeOf(newerRelease));
    assert.equal(checkLauncherIsFor(paths, ownNodeOf(newerRelease)), true);
    assert.match(runnerOutput, /a newer release of this runner's own Node\.js is in place: Node\.js 22\.100\.0 at \S+, replacing Node\.js \S+ at \S+\/v22\.99\.0\/bin\/node; the link starts again on it when no command, app update or Pueue task is under way/);
    // The release it left stays for a week: the moment it stopped being the runner's Node is on record, and nothing can be told of the jobs that may still use it.
    await waitUntil(() => fs.existsSync(paths.nodeCurrent) && mirrorRelease in readJson<{ lastCurrentMs: Record<string, number> }>(paths.nodeCurrent).lastCurrentMs, 'the record of when each version was current', moveTimeoutMs);
    assert.equal(fs.existsSync(ownFolderOf(mirrorRelease)), true, 'the release the link left is still there');
    assert.deepEqual(fs.readdirSync(paths.ownNodeDir).filter((name) => name.startsWith('v')).sort(), [newerRelease, mirrorRelease], 'and the newer MAJOR was never fetched');
    // A week later (the record says it was eight days ago) the next look removes it: Pueue has nothing running or queued.
    await waitUntil(() => {
      const record = readJson<{ lastCurrentMs: Record<string, number> }>(paths.nodeCurrent);
      if (fs.existsSync(ownFolderOf(mirrorRelease))) fs.writeFileSync(paths.nodeCurrent, JSON.stringify({ lastCurrentMs: { ...record.lastCurrentMs, [mirrorRelease]: Date.now() - 8 * dayMs } }));
      return !fs.existsSync(ownFolderOf(mirrorRelease));
    }, `${mirrorRelease} to be removed`, moveTimeoutMs);
    await waitUntil(() => /removed Node\.js 22\.99\.0, which the runner left more than 7 days ago/.test(runnerOutput), 'the log to say the old release was removed', linkTimeoutMs);
    assert.deepEqual(fs.readdirSync(paths.ownNodeDir).filter((name) => name.startsWith('v')), [newerRelease]);
  });

  it('while a command runs over the link, an even newer release is put in place and the launcher rewritten, but the link does NOT leave — it does when the command ends', async () => {
    await stopMovingRunner();
    // The mirror the runner reads is a link: it points at one with nothing newer until the command is running over the link, then at one with an even newer release.
    const without = writeMirrorWith('without', [{ version: newerRelease, lts: 'Jod' }]);
    const withNewest = writeMirrorWith('with', [{ version: newestRelease, lts: 'Jod' }, { version: newerRelease, lts: 'Jod' }]);
    const mirrorLink = path.join(layout.root, 'mirror-link');
    fs.symlinkSync(without, mirrorLink);
    await startMovingRunner(mirrorLink);
    await waitForLinkOn(ownNodeOf(newerRelease));
    const held = startSshThroughLink(layout, runnerId, `sleep ${heldCommandSeconds}`);
    const heldEnded = new Promise<void>((resolve) => { held.once('exit', () => { resolve(); }); });
    try {
      await waitUntil(() => spawnSync('ps', ['-axo', 'args='], { encoding: 'utf8' }).stdout.includes(`sleep ${heldCommandSeconds}`), 'the command to run on the runner', linkTimeoutMs);
      const switched = path.join(layout.root, 'mirror-link.next');
      fs.symlinkSync(withNewest, switched);
      fs.renameSync(switched, mirrorLink);
      await waitUntil(() => /a newer release of this runner's own Node\.js is in place: Node\.js 22\.101\.0/.test(runnerOutput), 'the newer release to be put in place', moveTimeoutMs);
      assert.equal(checkLauncherIsFor(paths, ownNodeOf(newestRelease)), true, 'the launcher already names it');
      const pidBefore = readStatus()?.pid;
      await new Promise((resolve) => { setTimeout(resolve, 3000); });
      assert.doesNotMatch(runnerOutput, /nothing is under way .*: leaving/, 'a command is running: the link stays');
      assert.equal(readStatus()?.pid, pidBefore);
      assert.equal(readLauncherNodePath(paths), ownNodeOf(newestRelease));
    } finally {
      held.kill('SIGKILL');
    }
    await heldEnded;
    await waitForLinkOn(ownNodeOf(newestRelease));
    assert.match(runnerOutput, /leaving for the launcher's new start/);
  });

  it('while a Pueue task runs, the next release is put in place and the launcher rewritten, but the link does NOT leave — it does when the task is over', async () => {
    await stopMovingRunner();
    const without = writeMirrorWith('p-without', [{ version: newestRelease, lts: 'Jod' }]);
    const withFinal = writeMirrorWith('p-with', [{ version: finalRelease, lts: 'Jod' }, { version: newestRelease, lts: 'Jod' }]);
    const mirrorLink = path.join(layout.root, 'pueue-mirror-link');
    fs.symlinkSync(without, mirrorLink);
    await startMovingRunner(mirrorLink);
    await waitForLinkOn(ownNodeOf(newestRelease));
    const pueue = path.join(paths.binDir, 'pueue');
    const readPueueTasks = (): number | null => countActivePueueTasks(spawnSync(pueue, ['--config', paths.pueueConfig, 'status', '--json'], { encoding: 'utf8' }).stdout, pueueUnfinishedStatuses);
    await waitUntil(() => readPueueTasks() !== null, 'the runner\'s Pueue to answer', linkTimeoutMs);
    // No command runs over the link — only a job the queue holds, which keeps the PATH it was queued with.
    assert.equal(spawnSync(pueue, ['--config', paths.pueueConfig, 'add', '--', 'sleep', String(pueueTaskSeconds)], { encoding: 'utf8' }).status, 0);
    const switched = path.join(layout.root, 'pueue-mirror-link.next');
    fs.symlinkSync(withFinal, switched);
    fs.renameSync(switched, mirrorLink);
    await waitUntil(() => /a newer release of this runner's own Node\.js is in place: Node\.js 22\.102\.0/.test(runnerOutput), 'the newer release to be put in place', moveTimeoutMs);
    assert.equal(checkLauncherIsFor(paths, ownNodeOf(finalRelease)), true, 'the launcher already names it');
    const pidBefore = readStatus()?.pid;
    await new Promise((resolve) => { setTimeout(resolve, 3000); });
    // The task must still be there at the moment we look, or the check proves nothing.
    assert.equal(readPueueTasks(), 1, 'the Pueue task is still running or queued');
    assert.doesNotMatch(runnerOutput, /nothing is under way \(no command over the link, no update, no Pueue task\): leaving/, 'a Pueue task is under way: the link stays');
    assert.equal(readStatus()?.pid, pidBefore);
    await waitForLinkOn(ownNodeOf(finalRelease));
    assert.match(runnerOutput, /nothing is under way \(no command over the link, no update, no Pueue task\): leaving for the launcher's new start/);
    assert.equal(readPueueTasks(), 0, 'the task was over by then');
  });
});
