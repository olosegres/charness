/**
 * @description `runners/gateLink.ts` + `linkControl.ts` + `runnerProxy.ts`: the hub end of a runner's link against a stand-in runner (an
 * `ssh2` server that reads the marker line, checks the hub key, and turns every `direct-tcpip` channel into an ssh server of its
 * own — what the runner utility does). The link carries an ordinary ssh session from the socket; the newest link takes the socket
 * over and the older gate leaves; a runner with another host key, or one removed from the registry, gets no link; the runner side can
 * open no channel back; `runner-proxy` joins stdio to the socket.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { PassThrough } from 'stream';
import { Client, Server, utils, type AuthContext } from 'ssh2';
import { runGateLink, type GateLinkTimings } from '../runners/gateLink';
import { readUntilGateMarker, type GateMarker } from '../runners/gateProtocol';
import { getRunnerLinkPaths } from '../runners/hubPaths';
import { createPairing, redeemPairing, removePairedRunner } from '../runners/hubPairing';
import { readHubKey } from '../runners/hubKey';
import { checkIsGateProcessOf, cutRunnerLink, getRunnerLinkStatus, probeSocket, readLinkState } from '../runners/linkControl';
import { runRunnerProxy } from '../runners/runnerProxy';
import { parsePublicKey, generateEd25519KeyPair, type SshKeyPair } from '../runners/sshKeys';
import { createCollector, createHubFixture, createRedeemFixture, injectStreamIntoSshServer, waitUntil, type HubFixture } from './runnersTestKit';

const startMs = Date.UTC(2026, 10, 1, 12, 0, 0);
const fastTimings: Partial<GateLinkTimings> = { checkIntervalMs: 100 };
const gateWaitMs = 8000;

let fixture: HubFixture;
let teardown: Array<() => void> = [];

interface PairedRunnerFixture {
  runnerId: string;
  hubPublicKey: string;
  serverKey: SshKeyPair;
}

async function pairRunner(serverKey: SshKeyPair = generateEd25519KeyPair('runner-server')): Promise<PairedRunnerFixture> {
  const pairing = await createPairing(fixture.ctx, { host: 'host.example', port: 22, hostKey: serverKey.publicKey, label: 'x', nowMs: startMs, sshUser: 'hubuser' });
  const redeem = createRedeemFixture({ hostKey: serverKey.publicKey });
  const reply = await redeemPairing(fixture.ctx, pairing.pairId, redeem.request, startMs);
  if (!reply.ok) throw new Error(reply.reason);
  return { runnerId: reply.runnerId, hubPublicKey: reply.hubPublicKey, serverKey };
}

interface StandInRunner {
  /** A fresh connection to it: the gate's stdin and stdout. */
  connect: () => Promise<net.Socket>;
  markers: GateMarker[];
  /** What the runner side got when it tried to open a channel back to the gate. */
  openBackResults: Array<Error | undefined>;
}

/** The runner utility's side of the link, as far as the gate can tell: marker, ssh server, a second ssh server per channel. */
async function startStandInRunner(runner: PairedRunnerFixture, options: { shouldTryOpenBack?: boolean } = {}): Promise<StandInRunner> {
  const hubBlob = parsePublicKey(runner.hubPublicKey)?.blob;
  const hubKey = utils.parseKey(runner.hubPublicKey);
  if (hubBlob === undefined || hubKey instanceof Error) throw new Error('the hub key does not parse');
  const markers: GateMarker[] = [];
  const openBackResults: Array<Error | undefined> = [];
  const authenticate = (auth: AuthContext): void => {
    if (auth.method !== 'publickey' || auth.key.algo !== 'ssh-ed25519' || !auth.key.data.equals(hubBlob)) {
      auth.reject();
      return;
    }
    // The first, signature-less request asks "would this key do?"; the signed one proves the client holds it.
    if (auth.signature === undefined) {
      auth.accept();
      return;
    }
    if (auth.blob !== undefined && hubKey.verify(auth.blob, auth.signature, auth.hashAlgo)) auth.accept();
    else auth.reject();
  };
  const sessionServer = new Server({ hostKeys: [runner.serverKey.privateKey] }, (connection) => {
    connection.on('error', () => undefined);
    connection.on('authentication', authenticate);
    connection.on('ready', () => {
      connection.on('session', (accept) => {
        const session = accept();
        session.on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec();
          stream.write(`ran:${info.command}\n`);
          stream.exit(0);
          stream.end();
        });
      });
    });
  });
  const linkServer = new Server({ hostKeys: [runner.serverKey.privateKey] }, (connection) => {
    connection.on('error', () => undefined);
    connection.on('authentication', authenticate);
    connection.on('ready', () => {
      connection.on('tcpip', (accept) => {
        injectStreamIntoSshServer(sessionServer, accept());
      });
      if (options.shouldTryOpenBack === true) {
        connection.forwardOut('127.0.0.1', 22, '127.0.0.1', 1, (error) => openBackResults.push(error));
      }
    });
  });
  const listener = net.createServer((socket) => {
    socket.on('error', () => undefined);
    void readUntilGateMarker(socket).then((read) => {
      if (read === null) {
        socket.destroy();
        return;
      }
      markers.push(read.marker);
      socket.unshift(read.rest);
      linkServer.injectSocket(socket);
      socket.resume();
    });
  });
  const standInPath = path.join(fixture.root, `s${Math.random().toString(36).slice(2, 8)}.sock`);
  await new Promise<void>((resolve) => { listener.listen(standInPath, resolve); });
  const sockets = new Set<net.Socket>();
  teardown.push(() => {
    for (const socket of sockets) socket.destroy();
    listener.close();
    linkServer.close();
    sessionServer.close();
  });
  return {
    markers,
    openBackResults,
    connect: () => new Promise<net.Socket>((resolve, reject) => {
      const socket = net.connect(standInPath);
      sockets.add(socket);
      socket.once('connect', () => resolve(socket));
      socket.once('error', reject);
    }),
  };
}

interface RunningGate {
  done: Promise<number>;
  logs: string[];
  transport: net.Socket;
}

async function startGate(runnerId: string, standIn: StandInRunner): Promise<RunningGate> {
  const transport = await standIn.connect();
  const logs: string[] = [];
  const done = runGateLink({ ctx: fixture.ctx, runnerId, input: transport, output: transport, packageId: '0123456789abcdef', log: (line) => logs.push(line), timings: fastTimings });
  return { done, logs, transport };
}

/** Run `command` over an ssh session whose transport is the link socket, as the hub's `ssh` would. */
async function execOverLink(runnerId: string, command: string): Promise<string> {
  const hubKey = readHubKey(fixture.ctx.dir);
  if (hubKey === null) throw new Error('no hub key');
  const transport = net.connect(getRunnerLinkPaths(fixture.ctx.dir, runnerId).socket);
  await new Promise<void>((resolve, reject) => { transport.once('connect', resolve); transport.once('error', reject); });
  const client = new Client();
  try {
    return await new Promise<string>((resolve, reject) => {
      client.on('error', reject);
      client.on('ready', () => {
        client.exec(command, (error, stream) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          let output = '';
          stream.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
          stream.on('close', () => resolve(output));
        });
      });
      client.connect({ sock: transport, username: 'hub', privateKey: hubKey.privateKey, hostVerifier: () => true });
    });
  } finally {
    client.end();
    transport.destroy();
  }
}

function settleWithin(done: Promise<number>, description: string): Promise<number> {
  return Promise.race([done, new Promise<number>((_resolve, reject) => { setTimeout(() => reject(new Error(`timed out: ${description}`)), gateWaitMs); })]);
}

describe('the gate\'s link', () => {
  beforeEach(() => {
    fixture = createHubFixture();
    teardown = [];
  });
  afterEach(() => {
    for (const step of teardown) step();
    fixture.cleanup();
  });

  it('carries an ssh session from the socket to the runner, and tells the runner the package id', async () => {
    const runner = await pairRunner();
    const standIn = await startStandInRunner(runner);
    const gate = await startGate(runner.runnerId, standIn);
    const paths = getRunnerLinkPaths(fixture.ctx.dir, runner.runnerId);
    await waitUntil(() => fs.existsSync(paths.socket), 'the link socket');
    assert.deepEqual(standIn.markers.map((marker) => ({ request: marker.request, fields: marker.fields })), [{ request: 'link', fields: { package: '0123456789abcdef' } }]);
    assert.equal(fs.statSync(paths.socket).mode & 0o777, 0o600);
    assert.equal(await execOverLink(runner.runnerId, 'hello'), 'ran:hello\n');
    assert.equal(await execOverLink(runner.runnerId, 'again'), 'ran:again\n', 'a second connection rides the same link');
    const state = readLinkState(fixture.ctx.dir, runner.runnerId);
    assert.equal(state?.pid, process.pid);
    assert.equal(state?.endedAtMs, null);
    const status = await getRunnerLinkStatus(fixture.ctx.dir, runner.runnerId);
    assert.equal(status.isOnline, true);
    gate.transport.destroy();
    await settleWithin(gate.done, 'the gate to end with its transport');
  });

  it('when the runner goes away the socket no longer accepts, the status says when, and the runner reads offline', async () => {
    const runner = await pairRunner();
    const standIn = await startStandInRunner(runner);
    const gate = await startGate(runner.runnerId, standIn);
    const paths = getRunnerLinkPaths(fixture.ctx.dir, runner.runnerId);
    await waitUntil(() => fs.existsSync(paths.socket), 'the link socket');
    gate.transport.destroy();
    assert.equal(await settleWithin(gate.done, 'the gate to end'), 0);
    assert.equal(await probeSocket(paths.socket), false, 'nothing accepts any more');
    assert.notEqual(readLinkState(fixture.ctx.dir, runner.runnerId)?.endedAtMs, null);
    const status = await getRunnerLinkStatus(fixture.ctx.dir, runner.runnerId);
    assert.equal(status.isOnline, false);
    assert.notEqual(status.lastSeenMs, null);
  });

  it('newest link wins: a second gate takes the socket, the first leaves, and the socket keeps working', async () => {
    const runner = await pairRunner();
    const standIn = await startStandInRunner(runner);
    const first = await startGate(runner.runnerId, standIn);
    const paths = getRunnerLinkPaths(fixture.ctx.dir, runner.runnerId);
    await waitUntil(() => fs.existsSync(paths.socket), 'the first link socket');
    const firstInode = fs.statSync(paths.socket).ino;

    const second = await startGate(runner.runnerId, standIn);
    assert.equal(await settleWithin(first.done, 'the replaced gate to leave'), 0);
    assert.ok(first.logs.some((line) => line.includes('another link took over')), first.logs.join('\n'));
    assert.equal(fs.existsSync(paths.socket), true, 'the replaced gate must not delete its successor\'s socket');
    assert.notEqual(fs.statSync(paths.socket).ino, firstInode);
    assert.equal(await execOverLink(runner.runnerId, 'via-second'), 'ran:via-second\n');

    second.transport.destroy();
    await settleWithin(second.done, 'the second gate to end');
    assert.equal(await probeSocket(paths.socket), false);
  });

  it('an ending gate never deletes the file at the link path: a socket another gate published meanwhile survives', async () => {
    const runner = await pairRunner();
    const standIn = await startStandInRunner(runner);
    const gate = await startGate(runner.runnerId, standIn);
    const paths = getRunnerLinkPaths(fixture.ctx.dir, runner.runnerId);
    await waitUntil(() => fs.existsSync(paths.socket), 'the link socket');

    // A successor publishes its socket the way a gate does: bind under its own name, rename onto the path.
    const successorPath = `${paths.socket}.successor`;
    const successor = net.createServer((connection) => { connection.end('successor'); });
    await new Promise<void>((resolve) => { successor.listen(successorPath, resolve); });
    teardown.push(() => successor.close());
    fs.renameSync(successorPath, paths.socket);

    gate.transport.destroy();
    await settleWithin(gate.done, 'the replaced gate to end');
    assert.equal(await probeSocket(paths.socket), true, 'the successor is still reachable after the older gate left');
  });

  it('a gate that ends leaves its socket file behind, which only refuses connections — and the next link renames over it', async () => {
    const runner = await pairRunner();
    const standIn = await startStandInRunner(runner);
    const first = await startGate(runner.runnerId, standIn);
    const paths = getRunnerLinkPaths(fixture.ctx.dir, runner.runnerId);
    await waitUntil(() => fs.existsSync(paths.socket), 'the link socket');
    first.transport.destroy();
    await settleWithin(first.done, 'the first gate to end');
    assert.equal(fs.existsSync(paths.socket), true);
    assert.equal(await probeSocket(paths.socket), false);

    const second = await startGate(runner.runnerId, standIn);
    await waitUntil(() => probeSocket(paths.socket), 'the new link over the leftover file');
    assert.equal(await execOverLink(runner.runnerId, 'again'), 'ran:again\n');
    second.transport.destroy();
    await settleWithin(second.done, 'the second gate to end');
  });

  it('a leftover file at the socket path (a gate that was killed) does not block a new link', async () => {
    const runner = await pairRunner();
    const standIn = await startStandInRunner(runner);
    const paths = getRunnerLinkPaths(fixture.ctx.dir, runner.runnerId);
    fs.mkdirSync(path.dirname(paths.socket), { recursive: true });
    fs.writeFileSync(paths.socket, 'leftover');
    assert.equal(await probeSocket(paths.socket), false, 'a dead file is not an online runner');
    const gate = await startGate(runner.runnerId, standIn);
    await waitUntil(() => probeSocket(paths.socket), 'the link to come up over the leftover file');
    assert.equal(await execOverLink(runner.runnerId, 'ok'), 'ran:ok\n');
    gate.transport.destroy();
    await settleWithin(gate.done, 'the gate to end');
  });

  it('gives no link to a runner that answers with another host key', async () => {
    const runner = await pairRunner();
    const impostor: PairedRunnerFixture = { ...runner, serverKey: generateEd25519KeyPair('impostor') };
    const standIn = await startStandInRunner(impostor);
    const gate = await startGate(runner.runnerId, standIn);
    assert.equal(await settleWithin(gate.done, 'the gate to give up'), 1);
    assert.equal(fs.existsSync(getRunnerLinkPaths(fixture.ctx.dir, runner.runnerId).socket), false);
    assert.equal(readLinkState(fixture.ctx.dir, runner.runnerId), null);
  });

  it('ends when its runner is removed from the registry, and removing cuts the link at once', async () => {
    const runner = await pairRunner();
    const standIn = await startStandInRunner(runner);
    const gate = await startGate(runner.runnerId, standIn);
    const paths = getRunnerLinkPaths(fixture.ctx.dir, runner.runnerId);
    await waitUntil(() => fs.existsSync(paths.socket), 'the link socket');
    await removePairedRunner(fixture.ctx, runner.runnerId, startMs);
    cutRunnerLink(fixture.ctx.dir, runner.runnerId);
    assert.equal(fs.existsSync(paths.socket), false, 'cutting deletes the socket file');
    assert.equal(await settleWithin(gate.done, 'the gate of a removed runner to leave'), 0);
    assert.ok(gate.logs.some((line) => line.includes('another link took over') || line.includes('removed')), gate.logs.join('\n'));
  });

  it('refuses at once a runner that is not paired', async () => {
    const runner = await pairRunner();
    const standIn = await startStandInRunner(runner);
    const transport = await standIn.connect();
    const logs: string[] = [];
    const code = await runGateLink({ ctx: fixture.ctx, runnerId: 'ffffffffffff', input: transport, output: transport, packageId: null, log: (line) => logs.push(line), timings: fastTimings });
    assert.equal(code, 1);
    assert.equal(standIn.markers.length, 0, 'nothing was said to the runner');
    transport.destroy();
  });

  it('refuses every channel the runner side tries to open back', async () => {
    const runner = await pairRunner();
    const standIn = await startStandInRunner(runner, { shouldTryOpenBack: true });
    const gate = await startGate(runner.runnerId, standIn);
    await waitUntil(() => standIn.openBackResults.length === 1, 'the runner side to hear back about its channel');
    assert.ok(standIn.openBackResults[0] instanceof Error, 'the gate\'s client rejected the channel');
    gate.transport.destroy();
    await settleWithin(gate.done, 'the gate to end');
  });
});

describe('link status and cutting', () => {
  beforeEach(() => {
    fixture = createHubFixture();
    teardown = [];
  });
  afterEach(() => {
    for (const step of teardown) step();
    fixture.cleanup();
  });

  it('a runner that never connected is offline with no last seen', async () => {
    assert.deepEqual(await getRunnerLinkStatus(fixture.ctx.dir, 'aaaaaaaaaaaa'), { isOnline: false, sinceMs: null, lastSeenMs: null });
  });

  it('probeSocket tells a listening socket from a missing or dead one', async () => {
    const socketPath = path.join(fixture.root, 'p.sock');
    assert.equal(await probeSocket(socketPath), false);
    const server = net.createServer();
    await new Promise<void>((resolve) => { server.listen(socketPath, resolve); });
    assert.equal(await probeSocket(socketPath), true);
    server.close();
  });

  it('a pid is only taken for a runner\'s gate when its command line says so', () => {
    assert.equal(checkIsGateProcessOf(process.pid, 'aaaaaaaaaaaa'), false);
    assert.equal(checkIsGateProcessOf(2 ** 22 + 12345, 'aaaaaaaaaaaa'), false);
  });

  it('cutting a link that never existed is harmless', () => {
    cutRunnerLink(fixture.ctx.dir, 'aaaaaaaaaaaa');
  });
});

describe('runner-proxy', () => {
  beforeEach(() => {
    fixture = createHubFixture();
    teardown = [];
  });
  afterEach(() => {
    for (const step of teardown) step();
    fixture.cleanup();
  });

  it('joins ssh\'s stdio to the socket in both directions and ends with the stream', async () => {
    const socketPath = path.join(fixture.root, 'proxy.sock');
    const server = net.createServer((connection) => { connection.pipe(connection); });
    await new Promise<void>((resolve) => { server.listen(socketPath, resolve); });
    teardown.push(() => server.close());
    const stdin = new PassThrough();
    const stdout = createCollector();
    const stderr = createCollector();
    const finished = runRunnerProxy(socketPath, { stdin, stdout: stdout.stream, stderr: stderr.stream });
    stdin.write('ping');
    await waitUntil(() => stdout.getText() === 'ping', 'the echo to come back');
    stdin.end();
    assert.equal(await settleWithin(finished, 'the proxy to end after stdin'), 0);
    assert.equal(stderr.getText(), '');
  });

  it('says the runner is not connected, and exits 255 like ssh does for a failed connection', async () => {
    const stderr = createCollector();
    const code = await runRunnerProxy(path.join(fixture.root, 'nothing.sock'), { stdin: new PassThrough(), stdout: createCollector().stream, stderr: stderr.stream });
    assert.equal(code, 255);
    assert.match(stderr.getText(), /runner is not connected/);
  });
});
