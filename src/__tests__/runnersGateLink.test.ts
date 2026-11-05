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
import { spawn } from 'child_process';
import { PassThrough } from 'stream';
import { Client, Server } from 'ssh2';
import { createHubAuthenticator } from '../runnerUtility/runnerServers';
import { runGateLink, type GateLinkTimings } from '../runners/gateLink';
import { readUntilGateMarker, type GateMarker } from '../runners/gateProtocol';
import { getRunnerLinkPaths } from '../runners/hubPaths';
import { createPairing, redeemPairing, removePairedRunner, sweepExpiredPairings } from '../runners/hubPairing';
import { readPairedFile, writePairedFile } from '../runners/hubRegistry';
import { readHubKey } from '../runners/hubKey';
import { checkIsGateProcessOf, cutRunnerLink, getRunnerLinkStatus, probeSocket, readLidState, readLinkState, sweepOrphanLinkRecords, writeLidState, writeLinkState } from '../runners/linkControl';
import { runRunnerProxy } from '../runners/runnerProxy';
import { generateEd25519KeyPair, type SshKeyPair } from '../runners/sshKeys';
import { createCollector, createHubFixture, createRedeemFixture, injectStreamIntoSshServer, settleWithin as settleWithinKit, waitUntil, type HubFixture } from './runnersTestKit';

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
  const markers: GateMarker[] = [];
  const openBackResults: Array<Error | undefined> = [];
  const authenticate = createHubAuthenticator(runner.hubPublicKey);
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

/** `source`: the address sshd would have told the gate the link connects from (`SSH_CLIENT`); absent = sshd said nothing. */
async function startGate(runnerId: string, standIn: StandInRunner, source?: string, extra: Partial<Parameters<typeof runGateLink>[0]> = {}): Promise<RunningGate> {
  const transport = await standIn.connect();
  const logs: string[] = [];
  const done = runGateLink({ ctx: fixture.ctx, runnerId, input: transport, output: transport, packageId: '0123456789abcdef', source, log: (line) => logs.push(line), timings: fastTimings, ...extra });
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
  return settleWithinKit(done, description, gateWaitMs);
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
    const state = readLinkState(fixture.ctx.dir, runner.runnerId);
    assert.deepEqual(standIn.markers.map((marker) => ({ request: marker.request, fields: marker.fields })), [{ request: 'link', fields: { package: '0123456789abcdef', epoch: state?.sinceMs.toString() ?? '' } }], 'the marker names the package and the link\'s epoch: when this gate began');
    assert.equal(fs.statSync(paths.socket).mode & 0o777, 0o600);
    assert.equal(await execOverLink(runner.runnerId, 'hello'), 'ran:hello\n');
    assert.equal(await execOverLink(runner.runnerId, 'again'), 'ran:again\n', 'a second connection rides the same link');
    assert.equal(state?.pid, process.pid);
    assert.equal(state?.endedAtMs, null);
    const status = await getRunnerLinkStatus(fixture.ctx.dir, runner.runnerId);
    assert.equal(status.isOnline, true);
    gate.transport.destroy();
    await settleWithin(gate.done, 'the gate to end with its transport');
  });

  describe('the lid a runner connects with', () => {
    const olderRecord = { isClosed: false, reportedAtMs: startMs, linkEpochMs: startMs };

    it('is recorded BEFORE the link\'s socket exists — a runner is never online with the lid of the last time: closed over an \'open\' record, at the first moment of the gate', async () => {
      const runner = await pairRunner();
      writeLidState(fixture.ctx.dir, runner.runnerId, olderRecord);
      const standIn = await startStandInRunner(runner);
      const gate = await startGate(runner.runnerId, standIn, undefined, { lidIsClosed: true, now: () => startMs + 5000 });
      const paths = getRunnerLinkPaths(fixture.ctx.dir, runner.runnerId);
      assert.equal(fs.existsSync(paths.socket), false, 'no link yet — the socket is bound when the ssh handshake with the runner is done');
      assert.deepEqual(readLidState(fixture.ctx.dir, runner.runnerId), { isClosed: true, reportedAtMs: startMs + 5000, linkEpochMs: startMs + 5000 });
      const early = await getRunnerLinkStatus(fixture.ctx.dir, runner.runnerId);
      assert.equal(early.isOnline, false);
      assert.equal(early.isLidClosed, true);
      await waitUntil(() => fs.existsSync(paths.socket), 'the link socket');
      const online = await getRunnerLinkStatus(fixture.ctx.dir, runner.runnerId);
      assert.equal(online.isOnline && online.isLidClosed, true, 'online with the lid it connected with');
      assert.equal(standIn.markers[0].fields.epoch, (startMs + 5000).toString());
      assert.equal(standIn.markers[0].fields.lid, 'recorded', 'the marker says the lid is on record, so the runner does not tell it again');
      gate.transport.destroy();
      await settleWithin(gate.done, 'the gate to end with its transport');
    });

    it('an open lid in the request overrides a closed record: the Mac that closed its lid and has it open again is available the moment it is online', async () => {
      const runner = await pairRunner();
      writeLidState(fixture.ctx.dir, runner.runnerId, { isClosed: true, reportedAtMs: startMs, linkEpochMs: startMs });
      const standIn = await startStandInRunner(runner);
      const gate = await startGate(runner.runnerId, standIn, undefined, { lidIsClosed: false, now: () => startMs + 1000 });
      assert.equal(readLidState(fixture.ctx.dir, runner.runnerId)?.isClosed, false);
      gate.transport.destroy();
      await settleWithin(gate.done, 'the gate to end with its transport');
    });

    it('a link that says nothing about the lid (a runner that is not a Mac, or an older one) leaves the record as it was', async () => {
      const runner = await pairRunner();
      writeLidState(fixture.ctx.dir, runner.runnerId, { isClosed: true, reportedAtMs: startMs });
      const standIn = await startStandInRunner(runner);
      for (const lidIsClosed of [undefined, null]) {
        const gate = await startGate(runner.runnerId, standIn, undefined, { lidIsClosed });
        assert.deepEqual(readLidState(fixture.ctx.dir, runner.runnerId), { isClosed: true, reportedAtMs: startMs });
        await waitUntil(() => standIn.markers.length > (lidIsClosed === undefined ? 0 : 1), 'the marker');
        gate.transport.destroy();
        await settleWithin(gate.done, 'the gate to end with its transport');
      }
      assert.deepEqual(standIn.markers.map((marker) => marker.fields.lid), [undefined, undefined], 'a link that carried no lid claims none recorded');
    });

    it('a gate that began EARLIER than the one whose word is on record does not overwrite it (two links racing for one runner): the later link has the last word', async () => {
      const runner = await pairRunner();
      writeLidState(fixture.ctx.dir, runner.runnerId, { isClosed: true, reportedAtMs: startMs + 9000, linkEpochMs: startMs + 9000 });
      const standIn = await startStandInRunner(runner);
      const gate = await startGate(runner.runnerId, standIn, undefined, { lidIsClosed: false, now: () => startMs + 1000 });
      assert.deepEqual(readLidState(fixture.ctx.dir, runner.runnerId), { isClosed: true, reportedAtMs: startMs + 9000, linkEpochMs: startMs + 9000 });
      await waitUntil(() => standIn.markers.length > 0, 'the marker');
      assert.equal(standIn.markers[0].fields.lid, undefined, 'this link\'s lid was not recorded (a later link\'s word stands), and the marker does not say it was');
      gate.transport.destroy();
      await settleWithin(gate.done, 'the gate to end with its transport');
    });

    it('a record that cannot be written is a line in the log and the link comes up all the same, with the record of the link before', async () => {
      const runner = await pairRunner();
      fs.mkdirSync(path.join(fixture.ctx.dir, 'link'), { recursive: true });
      fs.mkdirSync(getRunnerLinkPaths(fixture.ctx.dir, runner.runnerId).lid);
      const standIn = await startStandInRunner(runner);
      const gate = await startGate(runner.runnerId, standIn, undefined, { lidIsClosed: true });
      assert.ok(gate.logs.some((line) => line.includes('cannot record the lid the runner reported')), gate.logs.join('\n'));
      await waitUntil(() => fs.existsSync(getRunnerLinkPaths(fixture.ctx.dir, runner.runnerId).socket), 'the link socket');
      assert.equal(standIn.markers[0].fields.lid, undefined, 'a record that could not be written is not claimed: the runner tells the lid itself at its first look');
      gate.transport.destroy();
      await settleWithin(gate.done, 'the gate to end with its transport');
    });
  });

  it('a clean end of the channel from the runner — EOF on the gate\'s stdin, as when the ssh session that carried it is gone — ends the gate at once, with no failed write or keepalive to tell it', async () => {
    const runner = await pairRunner();
    const standIn = await startStandInRunner(runner);
    const transport = await standIn.connect();
    // The gate's stdin and stdout are the two pipes of an ssh session, not one socket: the runner going away shows as EOF on the input alone.
    const input = new PassThrough();
    const output = new PassThrough();
    transport.pipe(input, { end: false });
    output.pipe(transport, { end: false });
    const done = runGateLink({ ctx: fixture.ctx, runnerId: runner.runnerId, input, output, packageId: '0123456789abcdef', log: () => undefined, timings: fastTimings });
    const paths = getRunnerLinkPaths(fixture.ctx.dir, runner.runnerId);
    await waitUntil(() => probeSocket(paths.socket), 'the link to accept connections');
    input.end();
    assert.equal(await settleWithin(done, 'the gate to end on the EOF of its input'), 0);
    assert.equal(await probeSocket(paths.socket), false, 'the runner reads offline');
    transport.destroy();
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

  describe('where the link comes from', () => {
    const homeAddress = '198.51.100.7';
    const otherAddress = '203.0.113.9';

    /** Start a gate from `source` and wait until it holds the link (its status file names its pid and the socket is there). */
    async function holdLink(runner: PairedRunnerFixture, standIn: StandInRunner, source?: string): Promise<RunningGate> {
      const gate = await startGate(runner.runnerId, standIn, source);
      await waitUntil(() => readLinkState(fixture.ctx.dir, runner.runnerId)?.endedAtMs === null && fs.existsSync(getRunnerLinkPaths(fixture.ctx.dir, runner.runnerId).socket), 'the link to be held');
      return gate;
    }

    it('is recorded in the link\'s status — and tells nothing while it stays the same', async () => {
      const runner = await pairRunner();
      const standIn = await startStandInRunner(runner);
      const gate = await holdLink(runner, standIn, homeAddress);
      const state = readLinkState(fixture.ctx.dir, runner.runnerId);
      assert.equal(state?.source, homeAddress);
      assert.deepEqual(state?.sourceChanges, []);
      const status = await getRunnerLinkStatus(fixture.ctx.dir, runner.runnerId);
      assert.equal(status.source, homeAddress);
      assert.equal(status.concern, null);
      gate.transport.destroy();
      await settleWithin(gate.done, 'the gate to end');
    });

    it('is nothing when sshd did not say — and a link from an unknown place never counts as a change', async () => {
      const runner = await pairRunner();
      const standIn = await startStandInRunner(runner);
      const first = await holdLink(runner, standIn, homeAddress);
      const second = await startGate(runner.runnerId, standIn);
      await settleWithin(first.done, 'the replaced gate to leave');
      await waitUntil(() => readLinkState(fixture.ctx.dir, runner.runnerId)?.source === null, 'the second link\'s status');
      assert.deepEqual(readLinkState(fixture.ctx.dir, runner.runnerId)?.sourceChanges, []);
      second.transport.destroy();
      await settleWithin(second.done, 'the second gate to end');
    });

    it('a link from ANOTHER address that takes the place of one still up is a change that says so — and the status says how to read it', async () => {
      const runner = await pairRunner();
      const standIn = await startStandInRunner(runner);
      const first = await holdLink(runner, standIn, homeAddress);
      const second = await startGate(runner.runnerId, standIn, otherAddress);
      await settleWithin(first.done, 'the replaced gate to leave');
      await waitUntil(() => readLinkState(fixture.ctx.dir, runner.runnerId)?.source === otherAddress, 'the second link\'s status');
      const state = readLinkState(fixture.ctx.dir, runner.runnerId);
      assert.deepEqual(state?.sourceChanges?.map((entry) => [entry.fromSource, entry.toSource, entry.isLiveReplacement]), [[homeAddress, otherAddress, true]]);
      const status = await getRunnerLinkStatus(fixture.ctx.dir, runner.runnerId);
      assert.deepEqual(status.concern && { ...status.concern, atMs: 0 }, { kind: 'sourceChanged', fromSource: homeAddress, toSource: otherAddress, atMs: 0, isLiveReplacement: true });
      second.transport.destroy();
      await settleWithin(second.done, 'the second gate to end');
    });

    it('a link from the SAME address that takes the place of the first is no change: the machine reconnected', async () => {
      const runner = await pairRunner();
      const standIn = await startStandInRunner(runner);
      const first = await holdLink(runner, standIn, homeAddress);
      const second = await startGate(runner.runnerId, standIn, homeAddress);
      await settleWithin(first.done, 'the replaced gate to leave');
      await waitUntil(() => readLinkState(fixture.ctx.dir, runner.runnerId)?.pid === process.pid && readLinkState(fixture.ctx.dir, runner.runnerId)?.endedAtMs === null, 'the second link\'s status');
      assert.deepEqual(readLinkState(fixture.ctx.dir, runner.runnerId)?.sourceChanges, []);
      second.transport.destroy();
      await settleWithin(second.done, 'the second gate to end');
    });

    it('a link from another address AFTER the first ended is a change that took no live link\'s place, and the record outlives the gate that wrote it', async () => {
      const runner = await pairRunner();
      const standIn = await startStandInRunner(runner);
      const first = await holdLink(runner, standIn, homeAddress);
      first.transport.destroy();
      await settleWithin(first.done, 'the first gate to end');
      const second = await holdLink(runner, standIn, otherAddress);
      assert.deepEqual(readLinkState(fixture.ctx.dir, runner.runnerId)?.sourceChanges?.map((entry) => entry.isLiveReplacement), [false]);
      second.transport.destroy();
      await settleWithin(second.done, 'the second gate to end');
      assert.equal((await getRunnerLinkStatus(fixture.ctx.dir, runner.runnerId)).concern?.kind, 'sourceChanged', 'still told once the runner is offline');
    });

    it('links that keep replacing each other from two addresses are a fight', async () => {
      const runner = await pairRunner();
      const standIn = await startStandInRunner(runner);
      let gate = await holdLink(runner, standIn, homeAddress);
      for (const source of [otherAddress, homeAddress, otherAddress]) {
        const next = await startGate(runner.runnerId, standIn, source);
        await settleWithin(gate.done, 'the replaced gate to leave');
        await waitUntil(() => readLinkState(fixture.ctx.dir, runner.runnerId)?.source === source, `the link from ${source}`);
        gate = next;
      }
      const concern = (await getRunnerLinkStatus(fixture.ctx.dir, runner.runnerId)).concern;
      assert.deepEqual(concern && { ...concern, atMs: 0 }, { kind: 'fighting', sources: [homeAddress, otherAddress], changeCount: 3, atMs: 0 });
      gate.transport.destroy();
      await settleWithin(gate.done, 'the last gate to end');
    });
  });

  it('an ending gate never deletes the file at the link path: a socket another gate published meanwhile survives', async () => {
    const runner = await pairRunner();
    const standIn = await startStandInRunner(runner);
    const gate = await startGate(runner.runnerId, standIn);
    const paths = getRunnerLinkPaths(fixture.ctx.dir, runner.runnerId);
    await waitUntil(() => fs.existsSync(paths.socket), 'the link socket');

    // A successor publishes its socket the way a gate does: bind under its own name, rename onto the path.
    const successorPath = `${paths.socket}.successor`;
    // It accepts and says nothing: the probe hangs up at once, and a greeting written into that is a reset nobody listens for.
    const successor = net.createServer((connection) => { connection.resume(); });
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

  it('leaves no link record of a removed runner behind — neither its socket nor the status it kept while it held the link', async () => {
    const runner = await pairRunner();
    const standIn = await startStandInRunner(runner);
    const gate = await startGate(runner.runnerId, standIn);
    const paths = getRunnerLinkPaths(fixture.ctx.dir, runner.runnerId);
    await waitUntil(() => readLinkState(fixture.ctx.dir, runner.runnerId) !== null, 'the gate to have written its status');
    // The runner leaves the registry WITHOUT a registry operation: those sweep the link files of unknown runners themselves (this gate's pid is
    // the test's, not a `runner-gate` command line, so the sweep would delete both files before the cut) — and then only the cut is under test.
    const paired = readPairedFile(fixture.ctx.dir);
    writePairedFile(fixture.ctx.dir, { ...paired, rev: paired.rev + 1, runners: paired.runners.filter((registered) => registered.id !== runner.runnerId) });
    assert.equal(fs.existsSync(paths.socket) && fs.existsSync(paths.state), true, 'both files are still there when the link is cut');
    cutRunnerLink(fixture.ctx.dir, runner.runnerId);
    await settleWithin(gate.done, 'the gate of a removed runner to leave');
    assert.equal(fs.existsSync(paths.state), false, 'the status file is gone, and the gate did not write it again as it left');
    assert.equal(fs.existsSync(paths.socket), false);
    assert.deepEqual(fs.readdirSync(path.dirname(paths.state)), []);
  });

  it('a gate that ends for any OTHER reason still records when the runner was last seen', async () => {
    const runner = await pairRunner();
    const standIn = await startStandInRunner(runner);
    const gate = await startGate(runner.runnerId, standIn);
    await waitUntil(() => readLinkState(fixture.ctx.dir, runner.runnerId) !== null, 'the gate to have written its status');
    gate.transport.destroy();
    await settleWithin(gate.done, 'the gate to end');
    assert.notEqual(readLinkState(fixture.ctx.dir, runner.runnerId)?.endedAtMs, null, 'offline since… needs it');
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
    assert.deepEqual(await getRunnerLinkStatus(fixture.ctx.dir, 'aaaaaaaaaaaa'), { isOnline: false, sinceMs: null, lastSeenMs: null, source: null, concern: null, isLidClosed: false });
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

  const linkState = { pid: 2 ** 22 + 12345, sinceMs: startMs, lastBeatMs: startMs, endedAtMs: null };

  function listLinkFolder(): string[] {
    return fs.readdirSync(getRunnerLinkPaths(fixture.ctx.dir, 'aaaaaaaaaaaa').state.replace(/[^/]+$/, '')).sort();
  }

  const expectNoProblem = (problem: string): void => { assert.fail(`the sweep reported a problem: ${problem}`); };

  /** A file where the link folder should be: listing it fails (ENOTDIR) for any user, root included. */
  function makeLinkFolderUnreadable(): void {
    const linkDir = path.join(fixture.ctx.dir, 'link');
    fs.mkdirSync(fixture.ctx.dir, { recursive: true });
    fs.rmSync(linkDir, { recursive: true, force: true });
    fs.writeFileSync(linkDir, 'not a folder');
  }

  function writeSocketFile(runnerId: string): void {
    fs.writeFileSync(getRunnerLinkPaths(fixture.ctx.dir, runnerId).socket, '');
  }

  it('cutting a link deletes the runner\'s status file with its socket, and only that runner\'s', () => {
    writeLinkState(fixture.ctx.dir, 'aaaaaaaaaaaa', linkState);
    writeLinkState(fixture.ctx.dir, 'bbbbbbbbbbbb', linkState);
    writeSocketFile('aaaaaaaaaaaa');
    writeSocketFile('bbbbbbbbbbbb');
    cutRunnerLink(fixture.ctx.dir, 'aaaaaaaaaaaa');
    assert.deepEqual(listLinkFolder(), ['bbbbbbbbbbbb.json', 'bbbbbbbbbbbb.sock']);
  });

  describe('the lid report', () => {
    const closed = { isClosed: true, reportedAtMs: startMs };

    it('is kept in a file of its own, so the gate rewriting the status every few seconds cannot lose it', () => {
      writeLidState(fixture.ctx.dir, 'aaaaaaaaaaaa', closed);
      writeLinkState(fixture.ctx.dir, 'aaaaaaaaaaaa', linkState);
      writeLinkState(fixture.ctx.dir, 'aaaaaaaaaaaa', { ...linkState, lastBeatMs: startMs + 10_000 });
      assert.deepEqual(readLidState(fixture.ctx.dir, 'aaaaaaaaaaaa'), closed);
      assert.equal(getRunnerLinkPaths(fixture.ctx.dir, 'aaaaaaaaaaaa').lid, path.join(fixture.ctx.dir, 'link', 'aaaaaaaaaaaa.lid'));
    });

    it('outlives the link: a runner whose gate has ended reads closed when it comes back, until it says otherwise — and an offline runner is offline whatever its lid', async () => {
      writeLinkState(fixture.ctx.dir, 'aaaaaaaaaaaa', { ...linkState, endedAtMs: startMs + 5000 });
      writeLidState(fixture.ctx.dir, 'aaaaaaaaaaaa', closed);
      const status = await getRunnerLinkStatus(fixture.ctx.dir, 'aaaaaaaaaaaa');
      assert.equal(status.isLidClosed, true);
      assert.equal(status.isOnline, false);
    });

    it('a damaged or foreign record reads as an open lid: a runner is never taken out of use by a file nobody can read', () => {
      fs.mkdirSync(path.join(fixture.ctx.dir, 'link'), { recursive: true });
      const file = getRunnerLinkPaths(fixture.ctx.dir, 'aaaaaaaaaaaa').lid;
      for (const text of ['{broken', '[]', '{"isClosed":"yes","reportedAtMs":1}', '{"isClosed":true,"reportedAtMs":1,"extra":1}', '']) {
        fs.writeFileSync(file, text);
        assert.equal(readLidState(fixture.ctx.dir, 'aaaaaaaaaaaa'), null, text);
      }
    });

    it('goes when the link is cut (a removal) — only that runner\'s — and is swept for a runner the registry does not know', () => {
      for (const runnerId of ['aaaaaaaaaaaa', 'bbbbbbbbbbbb']) {
        writeLinkState(fixture.ctx.dir, runnerId, { ...linkState, endedAtMs: startMs });
        writeLidState(fixture.ctx.dir, runnerId, closed);
      }
      cutRunnerLink(fixture.ctx.dir, 'aaaaaaaaaaaa');
      assert.deepEqual(listLinkFolder(), ['bbbbbbbbbbbb.json', 'bbbbbbbbbbbb.lid']);
      assert.deepEqual(sweepOrphanLinkRecords(fixture.ctx.dir, [], expectNoProblem).sort(), ['bbbbbbbbbbbb.json', 'bbbbbbbbbbbb.lid']);
      assert.deepEqual(listLinkFolder(), []);
    });
  });

  it('sweeps the link files of runners the registry does not know, and nothing else: registered runners, other files, a gate\'s pending socket stay', () => {
    for (const runnerId of ['aaaaaaaaaaaa', 'bbbbbbbbbbbb']) {
      writeLinkState(fixture.ctx.dir, runnerId, { ...linkState, endedAtMs: startMs });
      writeSocketFile(runnerId);
    }
    const linkDir = getRunnerLinkPaths(fixture.ctx.dir, 'aaaaaaaaaaaa').state.replace(/[^/]+$/, '');
    for (const foreign of ['notes.txt', 'bbbbbbbbbbbb.json.tmp', 'bbbbbbbbbbbb.sock.0123abcd', 'BBBBBBBBBBBB.json']) fs.writeFileSync(path.join(linkDir, foreign), '');
    assert.deepEqual(sweepOrphanLinkRecords(fixture.ctx.dir, ['aaaaaaaaaaaa'], expectNoProblem).sort(), ['bbbbbbbbbbbb.json', 'bbbbbbbbbbbb.sock']);
    assert.deepEqual(listLinkFolder(), ['BBBBBBBBBBBB.json', 'aaaaaaaaaaaa.json', 'aaaaaaaaaaaa.sock', 'bbbbbbbbbbbb.json.tmp', 'bbbbbbbbbbbb.sock.0123abcd', 'notes.txt']);
  });

  it('a folder that does not exist yet has nothing to sweep', () => {
    assert.deepEqual(sweepOrphanLinkRecords(path.join(fixture.root, 'no-such-hub'), [], expectNoProblem), []);
  });

  it('keeps the files of an unregistered runner whose gate is still running (cutting still needs its pid), and sweeps them once it is gone', async () => {
    const runnerId = 'cccccccccccc';
    // A process whose command line reads like that runner's gate: `ps` shows the name `exec -a` gives it.
    const decoy = spawn('bash', ['-c', `exec -a "charness runner-gate runner ${runnerId}" sleep 120`], { stdio: 'ignore' });
    teardown.push(() => { decoy.kill('SIGKILL'); });
    const decoyPid = decoy.pid;
    assert.notEqual(decoyPid, undefined);
    await waitUntil(() => decoyPid !== undefined && checkIsGateProcessOf(decoyPid, runnerId), 'the decoy to read as the runner\'s gate');
    writeLinkState(fixture.ctx.dir, runnerId, { ...linkState, pid: decoyPid ?? linkState.pid });
    writeSocketFile(runnerId);
    assert.deepEqual(sweepOrphanLinkRecords(fixture.ctx.dir, [], expectNoProblem), []);
    assert.deepEqual(listLinkFolder(), [`${runnerId}.json`, `${runnerId}.sock`]);
    decoy.kill('SIGKILL');
    await waitUntil(() => decoyPid !== undefined && !checkIsGateProcessOf(decoyPid, runnerId), 'the decoy to be gone');
    assert.deepEqual(sweepOrphanLinkRecords(fixture.ctx.dir, [], expectNoProblem).sort(), [`${runnerId}.json`, `${runnerId}.sock`]);
  });

  it('the sweep never throws: a link folder that cannot be listed is reported, not raised', () => {
    makeLinkFolderUnreadable();
    const problems: string[] = [];
    assert.deepEqual(sweepOrphanLinkRecords(fixture.ctx.dir, [], (problem) => problems.push(problem)), []);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /link folder could not be listed \(ENOTDIR\)/);
  });

  it('a leftover that cannot be listed or deleted never fails the registry operation that sweeps — the runner is still removed, the pairing still goes through', async () => {
    const runner = await pairRunner();
    makeLinkFolderUnreadable();
    const warnings: string[] = [];
    fixture.ctx.log = (line) => { warnings.push(line); };
    const removed = await removePairedRunner(fixture.ctx, runner.runnerId, startMs);
    assert.equal(removed?.id, runner.runnerId, 'removed although the link folder is unreadable');
    await pairRunner();
    assert.ok(warnings.some((line) => line.includes('link folder could not be listed')), 'the context\'s log is told: ' + warnings.join('\n'));
  });

  it('every registry operation sweeps them — a removal cut short, or a status written after it, is mended by whatever runs next', async () => {
    const runner = await pairRunner();
    writeLinkState(fixture.ctx.dir, runner.runnerId, { ...linkState, endedAtMs: startMs });
    writeLinkState(fixture.ctx.dir, 'dddddddddddd', { ...linkState, endedAtMs: startMs });
    writeSocketFile('dddddddddddd');
    await sweepExpiredPairings(fixture.ctx, startMs);
    assert.deepEqual(listLinkFolder(), [`${runner.runnerId}.json`], 'the registered runner keeps its record; the unknown one\'s files are gone');
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
