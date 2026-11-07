/**
 * @description A runner paired on a SYSTEM Node.js (what every runner was until the runner got a Node of its own) moves to its own at the first start of its
 * link on the new program — the start right after the self-update that brought it — with nobody doing anything, at PROCESS level: the hub is a loopback
 * `sshd` and a copy of the built charness, the runner machine a temp HOME (`runnerLinkE2e/runnerLinkFlowKit.ts`), the REAL pasted line pairs it (on the Node
 * running this flow, which is not the runner's own), the REAL `charness-runner run` holds the link. What a flow cannot have is stood in for: nodejs.org is
 * a local mirror (a copy of the Node running the flow, `nodeMirrorKit.ts`) that the move reads through its test seam. In order:
 *
 *   a download that does not match its checksum → the move fails, says why in the link's log, installs nothing and the link comes up on the Node it had
 *   a good mirror → the package's script puts the verified build in `~/.charness-runner/node`, the launcher is rewritten to name it, the link leaves for a
 *   start of the new launcher and comes back RUNNING ON IT; a job over the link sees that Node first on its PATH and an npm prefix and a Corepack home inside the
 *   account's state folder (never the Node's own folder)
 *   a second start → nothing is downloaded or rewritten again
 *
 * Needs sshd, ssh, ssh-keyscan, rsync, Pueue, tar and the built CLI (`yarn build`): a local run without them is SKIPPED with the reason, CI fails without.
 * No registry and no network is used. Test case: N/A — Charness has no Jira tracker.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getRunnerLinkStatus } from '../runners/linkControl';
import { checkLauncherIsFor } from '../runnerUtility/launcher';
import { testKeepNodeEnvName, testNodeDistEnvName } from '../runnerUtility/managedNode';
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
  stopRunner,
  waitUntil,
  type RunnerLinkLayout,
} from './runnerLinkE2e/runnerLinkFlowKit';

const missingTools = getMissingTools();
const skipReason = missingTools.length > 0 && !isCi ? `missing: ${missingTools.join(', ')}` : false;
const linkTimeoutMs = 90_000;

describe('a runner on a system Node moves to its own (process level)', { skip: skipReason }, () => {
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
    placeRealNodeInstaller(path.join(paths.currentApp, 'remoteRun', 'ensureNode.sh'));
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

  async function startMovingRunner(distDir: string): Promise<void> {
    runnerOutput = '';
    runner = startRunner(layout, layout.runnerHome, { [testKeepNodeEnvName]: '', [testNodeDistEnvName]: `file://${distDir}` });
    for (const stream of [runner.stdout, runner.stderr]) stream?.on('data', (chunk: Buffer) => { runnerOutput += chunk.toString(); });
    await waitUntil(() => readStatus()?.state === 'linked', 'the runner to report a linked state', linkTimeoutMs);
  }

  async function stopMovingRunner(): Promise<void> {
    if (runner !== null) await stopRunner(layout, runner);
    runner = null;
    fs.rmSync(paths.status, { force: true });
  }

  it('a download that does not match its checksum moves nothing: the link comes up on the Node it had, and the log says why', async () => {
    const badMirror = writeNodeMirror(path.join(layout.root, 'bad-dist'), path.join(layout.root, 'bad-stage'), { nodeFrom: process.execPath, isChecksumWrong: true });
    await startMovingRunner(badMirror);
    assert.match(runnerOutput, /this runner runs on Node\.js \S+ at \S+, not on a Node\.js of its own, and could not get one: .*does not match nodejs\.org's SHASUMS256\.txt/s);
    assert.equal(checkLauncherIsFor(paths, process.execPath), true, 'the launcher still names the Node it had');
    assert.deepEqual(fs.readdirSync(paths.ownNodeDir), [], 'nothing was installed, nothing is left half-way');
    await stopMovingRunner();
  });

  it('a good mirror: the verified build is installed in the account\'s Node folder, the launcher names it, and the link comes back running ON it', async () => {
    const goodMirror = writeNodeMirror(path.join(layout.root, 'good-dist'), path.join(layout.root, 'good-stage'), { nodeFrom: process.execPath });
    await startMovingRunner(goodMirror);
    const ownNode = path.join(fs.realpathSync(paths.ownNodeDir), mirrorRelease, 'bin', 'node');
    assert.equal(fs.existsSync(ownNode), true);
    assert.match(runnerOutput, new RegExp(`this runner now has its own Node\\.js \\(${ownNode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`));
    assert.equal(checkLauncherIsFor(paths, ownNode), true, 'the launcher names the runner\'s own Node');
    const linkPid = readStatus()?.pid;
    assert.notEqual(linkPid, undefined);
    if (process.platform === 'linux') assert.equal(fs.realpathSync(`/proc/${linkPid}/exe`), fs.realpathSync(ownNode), 'and the link that is up runs on it');
    // «linked» is the runner's word, when the gate's marker arrives; the hub counts it online a moment later, when its own handshake to the runner is done.
    await waitUntil(async () => (await getRunnerLinkStatus(layout.hubDir, runnerId)).isOnline, 'the hub to see the link on the runner\'s own Node', linkTimeoutMs);
  });

  it('a job over the link finds that Node first and writes what it installs into the account\'s state folder, never into the Node\'s own', async () => {
    const ownNode = path.join(fs.realpathSync(paths.ownNodeDir), mirrorRelease, 'bin', 'node');
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

  it('a start on its own Node downloads and rewrites nothing', async () => {
    await stopMovingRunner();
    const launcherBefore = fs.statSync(paths.launcher).ino;
    const installedBefore = fs.readdirSync(paths.ownNodeDir);
    // No mirror at all this time: a runner that were to download again would fail here, and say so.
    await startMovingRunner(path.join(layout.root, 'no-such-dist'));
    assert.doesNotMatch(runnerOutput, /could not get one|now has its own Node/);
    assert.equal(fs.statSync(paths.launcher).ino, launcherBefore);
    assert.deepEqual(fs.readdirSync(paths.ownNodeDir), installedBefore);
  });
});
