/**
 * @description The runner link at PROCESS level, end to end: a hub made of a loopback `sshd` and a copy of the built charness, and a
 * runner machine made of a temp HOME (`runnerLinkE2e/runnerLinkFlowKit.ts`). The REAL pasted line is run on the machine, the REAL
 * `charness-runner run` holds the link, and the hub reaches the machine with plain `ssh` through `charness runner-proxy`, as remote-run
 * does. In order, each step on the state the one before left:
 *
 *   pair → the line registers the machine; the same line again is refused
 *   link → plain ssh works: output, exit code, a clean environment
 *   restart of the utility → the link returns with no new pairing
 *   gate killed on the hub (a dropped connection) → the link comes back
 *   the runner's own key on the hub → no shell, no pty, no remote or local forwarding, no unix-socket forwarding
 *   the hub's package changes → the idle runner updates itself and relinks
 *   remove → the link is cut, the machine says it was removed
 *
 * Needs sshd, ssh, ssh-keyscan, rsync, Pueue, tar and the built CLI (`yarn build`): a local run without them is SKIPPED with the reason, CI
 * fails without. No registry and no download is used. Test case: N/A — Charness has no Jira tracker.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { decodePairCode } from '../runners/pairCode';
import { redeemReplySchema, type RedeemRequest } from '../runners/gateProtocol';
import { connectToHub, HubConnectionError, requestGateJson } from '../runnerUtility/hubClient';
import { readRunnerConfig, writePairingInProgress } from '../runnerUtility/runnerConfig';
import { ensureRunnerKeys } from '../runnerUtility/runnerKeys';
import { getRunnerHomePaths } from '../runnerUtility/runnerHome';
import type { RunnerConfig, RunnerStatus } from '../runnerUtility/runnerConfig';
import { getFreePort } from './e2e/isolatedCharness';
import {
  createExtraMachine,
  createRunnerLinkLayout,
  destroyRunnerLinkLayout,
  getMissingTools,
  installRunnerApp,
  isCi,
  makePairingLine,
  readJson,
  runHubCli,
  runPairingLine,
  sshThroughLink,
  sshToHubWithRunnerKey,
  startRunner,
  stopRunner,
  waitUntil,
  type RunnerLinkLayout,
} from './runnerLinkE2e/runnerLinkFlowKit';

const missingTools = getMissingTools();
const skipReason = missingTools.length > 0 && !isCi ? `missing: ${missingTools.join(', ')}` : false;
const linkTimeoutMs = 90_000;
const updateTimeoutMs = 150_000;

describe('runner link (process level)', { skip: skipReason }, () => {
  let layout: RunnerLinkLayout;
  let runnerPaths: ReturnType<typeof getRunnerHomePaths>;
  let runnerId = '';
  let runner: ChildProcess | null = null;

  before(async () => {
    assert.deepEqual(missingTools, [], 'CI installs everything this flow needs');
    layout = await createRunnerLinkLayout();
    runnerPaths = getRunnerHomePaths(layout.runnerHome);
  });
  after(async () => {
    await destroyRunnerLinkLayout(layout);
  });

  function readStatusAt(paths: ReturnType<typeof getRunnerHomePaths>): RunnerStatus | null {
    try {
      return readJson<RunnerStatus>(paths.status);
    } catch {
      return null;
    }
  }

  function readStatus(): RunnerStatus | null {
    return readStatusAt(runnerPaths);
  }

  async function waitForLink(excludedPid: number | null = null): Promise<RunnerStatus> {
    const found: { status: RunnerStatus | null } = { status: null };
    await waitUntil(() => {
      const status = readStatus();
      if (status === null || status.state !== 'linked' || status.pid === excludedPid) return false;
      found.status = status;
      return true;
    }, 'the runner to report a linked state', linkTimeoutMs);
    if (found.status === null) throw new Error('no linked status');
    return found.status;
  }

  function readGatePid(): number {
    return readJson<{ pid: number }>(path.join(layout.hubDir, 'link', `${runnerId}.json`)).pid;
  }

  function readHubPaired(): { rev: number; runners: Array<{ id: string; name: string }> } {
    return readJson(path.join(layout.hubDir, 'paired.json'));
  }

  async function waitForSsh(command: string): Promise<string> {
    let output = '';
    await waitUntil(() => {
      const result = sshThroughLink(layout, runnerId, command);
      output = result.stdout;
      return result.status === 0;
    }, `ssh through the link to answer «${command}»`, linkTimeoutMs);
    return output;
  }

  it('pairs from the pasted line, once: the machine is registered and the same line again is refused', () => {
    const line = makePairingLine(layout);
    const result = runPairingLine(layout, line);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, new RegExp(`Paired with charness @ExampleBot \\(127\\.0\\.0\\.1:${layout.sshPort}\\) as runner “`));
    assert.match(result.stdout, /Keep it running:/);
    const paired = readHubPaired();
    assert.equal(paired.runners.length, 1);
    runnerId = paired.runners[0].id;
    assert.match(runHubCli(layout, ['runners', 'ls']).stdout, / — offline, never connected/);

    const again = runPairingLine(layout, line);
    assert.notEqual(again.status, 0, 'a used line is refused');
    assert.equal(readHubPaired().runners.length, 1);
    const status = spawnSync(process.execPath, [path.join(runnerPaths.currentApp, 'dist', 'runnerUtility', 'runnerCli.js'), 'status'], { encoding: 'utf8', env: { HOME: layout.runnerHome, PATH: process.env.PATH } });
    assert.match(status.stdout, /link: not running/);
  });

  it('holds the link: plain ssh from the hub runs commands on the machine, with a clean environment', async () => {
    runner = startRunner(layout);
    await waitForLink();
    assert.match(runHubCli(layout, ['runners', 'ls']).stdout, / — online/);
    assert.equal((await waitForSsh('echo from-runner')).trim(), 'from-runner');
    const environment = sshThroughLink(layout, runnerId, 'echo "[$FLOW_SECRET][$HOME]"');
    assert.equal(environment.stdout.trim(), `[][${layout.runnerHome}]`);
    assert.equal(sshThroughLink(layout, runnerId, 'exit 7').status, 7);
  });

  it('survives a restart of the utility with no new pairing', async () => {
    const before = await waitForLink();
    assert.ok(runner !== null);
    await stopRunner(layout, runner);
    runner = startRunner(layout);
    await waitForLink(before.pid);
    assert.equal((await waitForSsh('echo again')).trim(), 'again');
    assert.equal(readHubPaired().rev, 1);
  });

  it('comes back when the gate on the hub is killed', async () => {
    const oldGate = readGatePid();
    process.kill(oldGate, 'SIGKILL');
    await waitUntil(() => {
      try {
        return readGatePid() !== oldGate;
      } catch {
        return false;
      }
    }, 'a new gate to hold the link', linkTimeoutMs);
    assert.equal((await waitForSsh('echo relinked')).trim(), 'relinked');
  });

  it('the runner\'s own key on the hub: no shell, no pty, no forwarding of any kind', async () => {
    const shell = sshToHubWithRunnerKey(layout, [], 'id');
    assert.notEqual(shell.status, 0);
    assert.ok(!shell.stdout.includes('uid='));
    const pty = sshToHubWithRunnerKey(layout, ['-tt'], 'true');
    assert.notEqual(pty.status, 0);
    const remote = sshToHubWithRunnerKey(layout, ['-R', '0:127.0.0.1:22', '-o', 'ExitOnForwardFailure=yes'], 'true');
    assert.notEqual(remote.status, 0);
    const stolenSocket = path.join(layout.root, 'stolen.sock');
    const remoteSocket = sshToHubWithRunnerKey(layout, ['-R', `${stolenSocket}:127.0.0.1:22`, '-o', 'ExitOnForwardFailure=yes'], 'true');
    assert.notEqual(remoteSocket.status, 0);
    assert.equal(fs.existsSync(stolenSocket), false);

    const localPort = await getFreePort();
    const forwarder = spawn('ssh', [
      '-F', '/dev/null', '-N', '-p', String(layout.sshPort), '-i', runnerPaths.clientKey, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=no', '-o', `UserKnownHostsFile=${path.join(layout.root, 'known_hosts.scratch')}`,
      '-L', `127.0.0.1:${localPort}:127.0.0.1:${layout.sshPort}`, `${os.userInfo().username}@127.0.0.1`,
    ], { stdio: 'ignore' });
    try {
      await waitUntil(() => spawnSync('bash', ['-c', `exec 3<>/dev/tcp/127.0.0.1/${localPort}`], { stdio: 'ignore' }).status === 0, 'the local forward to listen', 20_000);
      const received = await new Promise<string>((resolve) => {
        const socket = net.connect(localPort, '127.0.0.1');
        let text = '';
        socket.on('data', (chunk) => { text += chunk.toString('utf8'); });
        socket.on('close', () => resolve(text));
        socket.on('error', () => resolve(text));
        setTimeout(() => { socket.destroy(); resolve(text); }, 4000);
      });
      assert.ok(!received.includes('SSH-2.0'), 'the forwarded connection reached nothing');
    } finally {
      forwarder.kill('SIGKILL');
    }
  });

  it('a linked, idle runner learns of the hub\'s new package by itself — the link is not touched — updates, and relinks', async () => {
    const before = readJson<RunnerConfig>(runnerPaths.config);
    const appBefore = fs.realpathSync(runnerPaths.currentApp);
    const statusBefore = await waitForLink();
    const gateBefore = readGatePid();
    fs.appendFileSync(path.join(layout.hubInstall, 'dist', 'runners', 'pairCode.js'), '\n// changed by the flow\n');
    await waitUntil(() => {
      const config = readJson<RunnerConfig>(runnerPaths.config);
      return config.packageId !== before.packageId && fs.realpathSync(runnerPaths.currentApp) !== appBefore;
    }, 'the runner to install the new package', updateTimeoutMs);
    await waitForLink(statusBefore.pid);
    assert.equal((await waitForSsh('echo updated')).trim(), 'updated');
    assert.notEqual(readGatePid(), gateBefore, 'the update restarted the link — nothing killed the old gate to make it happen');
    assert.equal(readHubPaired().rev, 1, 'an update is not a new pairing');
  });

  it('after the hub removes the machine its link is cut and it says so', async () => {
    const name = readHubPaired().runners[0].name;
    const removal = runHubCli(layout, ['runners', 'remove', name]);
    assert.equal(removal.status, 0, removal.stderr);
    assert.notEqual(sshThroughLink(layout, runnerId, 'echo nope').status, 0);
    await waitUntil(() => readStatus()?.state === 'removed', 'the runner to learn it was removed', linkTimeoutMs);
    const status = spawnSync(process.execPath, [path.join(runnerPaths.currentApp, 'dist', 'runnerUtility', 'runnerCli.js'), 'status'], { encoding: 'utf8', env: { HOME: layout.runnerHome, PATH: process.env.PATH } });
    assert.match(status.stdout, /This runner was removed by @ExampleBot\. Pair again with a new line from \/runners\./);
    assert.equal(readHubPaired().runners.length, 0);
  });
  it('a pairing whose answer was lost is recovered with the machine\'s own key — the temporary key is spent, the code is gone', async () => {
    const home = createExtraMachine(layout, 'machine-two');
    const paths = getRunnerHomePaths(home);
    installRunnerApp(layout, home);
    const line = makePairingLine(layout);
    const code = /cr1\.[A-Za-z0-9_-]+/.exec(line)?.[0] ?? '';
    const decoded = decodePairCode(code);
    assert.ok(decoded.ok);
    if (!decoded.ok) return;
    const payload = decoded.payload;
    const endpoint = { host: payload.host, port: payload.port, user: payload.user, hostKey: payload.hostKey };

    // What a runner does up to the redemption: keys, a note that a pairing is under way, the redemption itself — and then the answer is lost.
    const keys = ensureRunnerKeys(paths);
    writePairingInProgress(paths, { pairId: payload.pairId, ...endpoint, startedAtMs: Date.now(), packageId: null });
    const request: RedeemRequest = {
      suggestedName: 'machine-two',
      publicKey: keys.client.publicKey,
      hostKey: keys.server.publicKey,
      workDir: paths.workDir,
      os: 'Linux',
      arch: 'x86_64',
      version: 'flow',
      serviceKind: 'foreground',
    };
    const client = await connectToHub(endpoint, payload.privateKey);
    const lost = await requestGateJson(client, 'redeem', JSON.stringify(request), redeemReplySchema);
    client.end();
    assert.ok(lost.ok, 'the hub committed the pairing');
    assert.equal(readRunnerConfig(paths), null, 'the machine never got the answer');
    await assert.rejects(connectToHub(endpoint, payload.privateKey), (error: Error) => error instanceof HubConnectionError && error.failure === 'auth');

    // The way back is the machine's own key: `run` finds the half-done pairing and asks the hub who it is.
    const second = startRunner(layout, home);
    await waitUntil(() => readStatusAt(paths)?.state === 'linked', 'the recovered machine to link', linkTimeoutMs);
    assert.equal(readRunnerConfig(paths)?.runnerId, lost.ok ? lost.runnerId : '');
    assert.equal(fs.existsSync(paths.pairing), false, 'the half-done pairing is finished');
    assert.equal(readHubPaired().runners.length, 1);
    await stopRunner(layout, second);
  });
});
