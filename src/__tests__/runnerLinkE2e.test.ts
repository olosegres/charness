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
import { readPairedFile, writePairedFile } from '../runners/hubRegistry';
import { getRunnerLinkStatus } from '../runners/linkControl';
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
  startImpostorSshd,
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
  /** The second machine (made by the lost-answer case) and where its state is. */
  let secondHome = '';

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

  /**
   * The runner reports «linked» when the gate's marker arrives; the hub counts it online a moment later, when the gate's own ssh handshake to the
   * runner is done and its socket is published. A command sent through the link in between finds no socket.
   */
  async function waitForHubToSeeLink(id: string): Promise<void> {
    await waitUntil(async () => (await getRunnerLinkStatus(layout.hubDir, id)).isOnline, 'the hub to see the link (its socket accepts)', linkTimeoutMs);
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

  /** Connect to `localPort` (a forward the runner's key asked ssh for) and report whether anything came back. */
  function probeForward(localPort: number): Promise<string> {
    return new Promise((resolve) => {
      const socket = net.connect(localPort, '127.0.0.1');
      let received = '';
      socket.on('data', (chunk) => { received += chunk.toString('utf8'); });
      socket.on('close', () => resolve(received));
      socket.on('error', () => resolve(received));
      setTimeout(() => { socket.destroy(); resolve(received); }, 3000);
    });
  }

  /** A listener the test owns: `listen` is a TCP port or a unix socket path; it counts every connection that reaches it. */
  async function listenCounting(listenOn: number | string): Promise<{ count: () => number; close: () => void }> {
    let connections = 0;
    const server = net.createServer((socket) => {
      connections += 1;
      socket.end('reached');
    });
    await new Promise<void>((resolve) => { server.listen(listenOn, resolve); });
    return { count: () => connections, close: () => { server.close(); } };
  }

  /** ssh -N -L with the runner's key: the connection stays up, so a refusal is the server's answer to the forward and not the end of the session. */
  async function assertLocalForwardRefused(target: string, owner: { count: () => number }): Promise<void> {
    const localPort = await getFreePort();
    const forwarder = spawn('ssh', [
      '-F', '/dev/null', '-N', '-p', String(layout.sshPort), '-i', runnerPaths.clientKey, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=no', '-o', `UserKnownHostsFile=${path.join(layout.root, 'known_hosts.scratch')}`,
      '-L', `127.0.0.1:${localPort}:${target}`, `${os.userInfo().username}@127.0.0.1`,
    ], { stdio: 'ignore' });
    try {
      await waitUntil(() => spawnSync('bash', ['-c', `exec 3<>/dev/tcp/127.0.0.1/${localPort}`], { stdio: 'ignore' }).status === 0, 'the local forward to listen', 20_000);
      assert.equal(forwarder.exitCode, null, 'the session stays up: only the forward is refused');
      const received = await probeForward(localPort);
      assert.equal(received, '', 'nothing came back through the forward');
      assert.equal(owner.count(), 0, `${target} was never reached`);
    } finally {
      forwarder.kill('SIGKILL');
    }
  }

  it('the runner\'s own key on the hub: no shell, no pty, no remote forward, no forward to a TCP port or to a unix socket the hub owns', async () => {
    const wrongWord = sshToHubWithRunnerKey(layout, [], 'id');
    assert.notEqual(wrongWord.status, 0);
    assert.match(wrongWord.stderr, /refused: this key may only be used by charness-runner/);
    assert.ok(!wrongWord.stdout.includes('uid='));
    const shellLogin = sshToHubWithRunnerKey(layout, [], null);
    assert.notEqual(shellLogin.status, 0);
    assert.match(shellLogin.stderr, /refused: this key may only be used by charness-runner/);

    // A word the gate DOES serve (it answers without the pty), so the only thing that can fail the forced pty is the pty itself. What the client
    // does after the refusal depends on its version — OpenSSH 10 ends the session (255, the command never runs), older ones run the command anyway
    // — so the proof is the server's refusal, which every version prints.
    const served = sshToHubWithRunnerKey(layout, [], 'version');
    assert.equal(served.status, 0, served.stderr);
    assert.match(served.stdout, /--charness-gate-1-- version package=/);
    const pty = sshToHubWithRunnerKey(layout, ['-tt'], 'version');
    assert.match(pty.stderr, /PTY allocation request failed/);

    // `-N`: no command runs, the session stays up, so an exit with 255 is the server refusing the forward itself.
    const remoteTcp = sshToHubWithRunnerKey(layout, ['-N', '-R', '0:127.0.0.1:22', '-o', 'ExitOnForwardFailure=yes'], null);
    assert.equal(remoteTcp.status, 255, remoteTcp.stderr);
    assert.match(remoteTcp.stderr, /forward/i);
    const stolenSocket = path.join(layout.root, 'stolen.sock');
    const remoteSocket = sshToHubWithRunnerKey(layout, ['-N', '-R', `${stolenSocket}:127.0.0.1:22`, '-o', 'ExitOnForwardFailure=yes'], null);
    assert.equal(remoteSocket.status, 255, remoteSocket.stderr);
    assert.match(remoteSocket.stderr, /forward/i);
    assert.equal(fs.existsSync(stolenSocket), false);

    const tcpPort = await getFreePort();
    const tcpOwner = await listenCounting(tcpPort);
    const botLikeSocket = path.join(layout.root, 'bot-like.sock');
    const socketOwner = await listenCounting(botLikeSocket);
    try {
      await assertLocalForwardRefused(`127.0.0.1:${tcpPort}`, tcpOwner);
      await assertLocalForwardRefused(botLikeSocket, socketOwner);
    } finally {
      tcpOwner.close();
      socketOwner.close();
    }
  });

  it('refuses a pasted line once its code has expired, and registers nothing', async () => {
    const pairedBefore = readHubPaired().runners.length;
    const line = makePairingLine(layout, { CHARNESS_TEST_TIMINGS: JSON.stringify({ pairingLifetimeMs: 5000 }) });
    await new Promise((resolve) => { setTimeout(resolve, 7000); });
    const result = runPairingLine(layout, line);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Permission denied/, 'sshd itself refuses the expired key');
    assert.equal(readHubPaired().runners.length, pairedBefore);
    assert.doesNotMatch(runHubCli(layout, ['runners', 'ls']).stdout, /Pairing code open/, 'the expired code is swept');
  });

  it('refuses a pasted line that reaches a server with another host key, and spends nothing', async () => {
    const impostor = await startImpostorSshd(layout);
    const line = makePairingLine(layout);
    const redirected = line.replace(`p="${layout.sshPort}"`, `p="${impostor.port}"`);
    assert.notEqual(redirected, line, 'the line names the hub\'s port');
    const result = runPairingLine(layout, redirected);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /host key verification failed|identification has changed/i);
    assert.match(runHubCli(layout, ['runners', 'ls']).stdout, /Pairing code open/, 'the code was never presented to the hub');
  });

  it('a runner whose hub answers with another host key does not link, and says so', async () => {
    assert.ok(runner !== null);
    await stopRunner(layout, runner);
    const impostor = await startImpostorSshd(layout);
    const original = readJson<RunnerConfig>(runnerPaths.config);
    fs.writeFileSync(runnerPaths.config, JSON.stringify({ ...original, hub: { ...original.hub, port: impostor.port } }));
    fs.rmSync(runnerPaths.status, { force: true });
    runner = startRunner(layout);
    await waitUntil(() => readStatus()?.state === 'error', 'the runner to refuse the impostor', linkTimeoutMs);
    assert.match(readStatus()?.lastError ?? '', /host key is not the one pinned/);
    assert.notEqual(readStatus()?.state, 'linked');
    await stopRunner(layout, runner);
    fs.writeFileSync(runnerPaths.config, JSON.stringify(original));
    runner = startRunner(layout);
    await waitForLink();
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

  /**
   * A job that writes the pid of the process that stays alive (the `exec`), as ONE string for `pueue add` — the way the runner script submits a
   * job: Pueue joins separate arguments with plain spaces, so `sh -c 'echo $$ > f; …'` would redirect the outer command and leave the file empty.
   */
  function backgroundJobCommand(pidFile: string): string {
    return `echo $$ > ${pidFile}; exec sleep 300`;
  }

  function isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  it('after the hub removes the machine its link is cut, it says so, and the background job the hub\'s agents left running there is stopped', async () => {
    const name = readHubPaired().runners[0].name;
    // A background job, as `remote-run --bg` leaves one: it runs in the runner\'s Pueue, which outlives any link.
    const jobPidFile = path.join(layout.root, 'background-job.pid');
    const started = sshThroughLink(layout, runnerId, `${path.join(runnerPaths.binDir, 'pueue')} --config ${runnerPaths.pueueConfig} add --immediate -- '${backgroundJobCommand(jobPidFile)}'`);
    assert.equal(started.status, 0, started.stderr);
    await waitUntil(() => fs.existsSync(jobPidFile) && fs.readFileSync(jobPidFile, 'utf8').trim() !== '', 'the background job to start', linkTimeoutMs);
    const jobPid = Number(fs.readFileSync(jobPidFile, 'utf8'));
    assert.equal(isProcessAlive(jobPid), true);

    const removal = runHubCli(layout, ['runners', 'remove', name]);
    assert.equal(removal.status, 0, removal.stderr);
    assert.notEqual(sshThroughLink(layout, runnerId, 'echo nope').status, 0);
    await waitUntil(() => readStatus()?.state === 'removed', 'the runner to learn it was removed', linkTimeoutMs);
    await waitUntil(() => !isProcessAlive(jobPid), 'the removed runner to stop the background job it was running', linkTimeoutMs);
    const status = spawnSync(process.execPath, [path.join(runnerPaths.currentApp, 'dist', 'runnerUtility', 'runnerCli.js'), 'status'], { encoding: 'utf8', env: { HOME: layout.runnerHome, PATH: process.env.PATH } });
    assert.match(status.stdout, /This runner was removed by @ExampleBot\. Pair again with a new line from \/runners\./);
    assert.equal(readHubPaired().runners.length, 0);
  });

  it('a key line that outlived its registry entry is a removal too: the real gate answers «not paired», the runner takes that for certain and stops the background job', async () => {
    const home = createExtraMachine(layout, 'machine-three');
    const paths = getRunnerHomePaths(home);
    const paired = runPairingLine(layout, makePairingLine(layout), home);
    assert.equal(paired.status, 0, `${paired.stderr}\n${paired.stdout}`);
    const thirdId = readJson<RunnerConfig>(paths.config).runnerId;
    const third = startRunner(layout, home);
    await waitUntil(() => readStatusAt(paths)?.state === 'linked', 'the third machine to link', linkTimeoutMs);
    await waitForHubToSeeLink(thirdId);
    const jobPidFile = path.join(layout.root, 'third-background-job.pid');
    const started = sshThroughLink(layout, thirdId, `${path.join(paths.binDir, 'pueue')} --config ${paths.pueueConfig} add --immediate -- '${backgroundJobCommand(jobPidFile)}'`);
    assert.equal(started.status, 0, started.stderr);
    await waitUntil(() => fs.existsSync(jobPidFile) && fs.readFileSync(jobPidFile, 'utf8').trim() !== '', 'the third machine\'s background job to start', linkTimeoutMs);
    const jobPid = Number(fs.readFileSync(jobPidFile, 'utf8'));
    assert.equal(isProcessAlive(jobPid), true);

    // The registry entry goes, the key line stays (no hub operation runs, so nothing rewrites authorized_keys): sshd lets the runner in,
    // the gate refuses `link` — and must still answer `identity`, or the runner sees only a failure and retries for ever.
    const registry = readPairedFile(layout.hubDir);
    writePairedFile(layout.hubDir, { ...registry, rev: registry.rev + 1, runners: registry.runners.filter((runner) => runner.id !== thirdId) });
    assert.match(fs.readFileSync(path.join(layout.hubHome, '.ssh', 'authorized_keys'), 'utf8'), new RegExp(`charness-runner:${thirdId}`), 'the key line is still there');
    process.kill(readJson<{ pid: number }>(path.join(layout.hubDir, 'link', `${thirdId}.json`)).pid, 'SIGKILL');
    await waitUntil(() => readStatusAt(paths)?.state === 'removed', 'the third machine to learn it was removed from the gate\'s answer', linkTimeoutMs);
    await waitUntil(() => !isProcessAlive(jobPid), 'the removed machine to stop its background job', linkTimeoutMs);
    await stopRunner(layout, third);
  });

  it('a pairing whose answer was lost is recovered with the machine\'s own key — the temporary key is spent, the code is gone', async () => {
    const home = createExtraMachine(layout, 'machine-two');
    secondHome = home;
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
  it('`unpair --local` on a linked runner stops its link for good: the former hub cannot run another command, and the link does not come back', async () => {
    assert.notEqual(secondHome, '', 'the lost-answer case made the second machine');
    const paths = getRunnerHomePaths(secondHome);
    const stalePid = readStatusAt(paths)?.pid ?? null;
    const second = startRunner(layout, secondHome);
    await waitUntil(() => readStatusAt(paths)?.state === 'linked' && readStatusAt(paths)?.pid !== stalePid, 'the second machine to link again', linkTimeoutMs);
    const secondRunnerId = readJson<RunnerConfig>(paths.config).runnerId;
    await waitForHubToSeeLink(secondRunnerId);
    const linkPid = readStatusAt(paths)?.pid ?? 0;
    assert.equal(sshThroughLink(layout, secondRunnerId, 'echo before').stdout.trim(), 'before');

    const unpair = spawnSync(process.execPath, [path.join(paths.currentApp, 'dist', 'runnerUtility', 'runnerCli.js'), 'unpair', '--local'], {
      encoding: 'utf8',
      env: { HOME: secondHome, PATH: process.env.PATH, CHARNESS_TEST_TIMINGS: '' },
      timeout: 60_000,
    });
    assert.equal(unpair.status, 0, unpair.stderr);
    assert.match(unpair.stdout, /Unpaired from charness @ExampleBot \(here only/);
    assert.equal(isProcessAlive(linkPid), false, 'the runner process is gone — checked, not assumed');
    assert.equal(fs.existsSync(paths.config), false);
    assert.equal(fs.existsSync(paths.keysDir), false);

    // The hub still lists the machine (it was not told) — and cannot reach it, now or later.
    assert.notEqual(sshThroughLink(layout, secondRunnerId, 'echo after').status, 0);
    await new Promise((resolve) => { setTimeout(resolve, 8000); });
    assert.notEqual(sshThroughLink(layout, secondRunnerId, 'echo later').status, 0, 'no link came back: nothing on the machine retains the pairing');
    assert.match(runHubCli(layout, ['runners', 'ls']).stdout, /machine-two — offline/);
    await stopRunner(layout, second);
  });
});
