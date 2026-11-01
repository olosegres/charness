/**
 * @description `runnerUtility/pairingRecovery.ts` + the half-done pairing file: a runner whose `redeem` answer was lost asks the hub, with
 * its own permanent key, what it was told (`identity`); a hub that does not know the key means nothing was committed; a hub that cannot
 * be reached means try again. The hub here is an ssh server that speaks the gate's words.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Server } from 'ssh2';
import { formatGateAnswerHead, type RedeemReply } from '../runners/gateProtocol';
import { generateEd25519KeyPair } from '../runners/sshKeys';
import { readPairingInProgress, removePairingInProgress, RunnerConfigError, writePairingInProgress } from '../runnerUtility/runnerConfig';
import { getRunnerHomePaths, type RunnerHomePaths } from '../runnerUtility/runnerHome';
import { recoverPairing } from '../runnerUtility/pairingRecovery';
import { createHubAuthenticator } from '../runnerUtility/runnerServers';
import type { RunnerKeys } from '../runnerUtility/runnerKeys';

const runnerKeys: RunnerKeys = { client: generateEd25519KeyPair('c'), server: generateEd25519KeyPair('s') };
const hubKey = generateEd25519KeyPair('hub');

const knownReply: Extract<RedeemReply, { ok: true }> = {
  ok: true,
  runnerId: 'abcdef012345',
  name: 'mac',
  hubPublicKey: hubKey.publicKey,
  label: '@ExampleBot',
  host: 'host.example',
  port: 22,
  packageId: '0123456789abcdef',
};

interface StandInHub {
  endpoint: { host: string; port: number; user: string; hostKey: string };
  close: () => void;
}

async function startHub(options: { knownKey: string; reply: RedeemReply }): Promise<StandInHub> {
  const hostKey = generateEd25519KeyPair('hub-host');
  const authenticate = createHubAuthenticator(options.knownKey);
  const server = new Server({ hostKeys: [hostKey.privateKey] }, (connection) => {
    connection.on('error', () => undefined);
    connection.on('authentication', authenticate);
    connection.on('ready', () => {
      connection.on('session', (acceptSession) => {
        acceptSession().on('exec', (accept, reject, info) => {
          if (info.command !== 'identity') {
            reject();
            return;
          }
          const channel = accept();
          channel.write(formatGateAnswerHead('identity'));
          channel.write(`${JSON.stringify(options.reply)}\n`);
          channel.exit(options.reply.ok ? 0 : 1);
          channel.end();
        });
      });
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { endpoint: { host: '127.0.0.1', port: address.port, user: 'hubuser', hostKey: hostKey.publicKey }, close: () => { server.close(); } };
}

describe('recovering a pairing whose answer was lost', () => {
  const hubs: StandInHub[] = [];
  afterEach(() => {
    for (const hub of hubs.splice(0)) hub.close();
  });

  it('asks the hub with the runner\'s own key and gets back what redeem answered', async () => {
    const hub = await startHub({ knownKey: runnerKeys.client.publicKey, reply: knownReply });
    hubs.push(hub);
    assert.deepEqual(await recoverPairing(hub.endpoint, runnerKeys), { kind: 'recovered', reply: knownReply });
  });

  it('a hub that does not know the key committed nothing: not registered', async () => {
    const hub = await startHub({ knownKey: generateEd25519KeyPair('someone else').publicKey, reply: knownReply });
    hubs.push(hub);
    assert.deepEqual(await recoverPairing(hub.endpoint, runnerKeys), { kind: 'not-registered' });
  });

  it('a hub that knows the key but not the runner (removed meanwhile) is not registered either', async () => {
    const hub = await startHub({ knownKey: runnerKeys.client.publicKey, reply: { ok: false, reason: 'this runner is not paired here' } });
    hubs.push(hub);
    assert.deepEqual(await recoverPairing(hub.endpoint, runnerKeys), { kind: 'not-registered' });
  });

  it('a hub that cannot be reached, or whose host key is not the pinned one, says try again — it does not discard the half-done pairing', async () => {
    const hub = await startHub({ knownKey: runnerKeys.client.publicKey, reply: knownReply });
    hubs.push(hub);
    const closedPort = await startHub({ knownKey: runnerKeys.client.publicKey, reply: knownReply });
    closedPort.close();
    const unreachable = await recoverPairing(closedPort.endpoint, runnerKeys);
    assert.equal(unreachable.kind, 'unreachable');
    const impostor = await recoverPairing({ ...hub.endpoint, hostKey: generateEd25519KeyPair('impostor').publicKey }, runnerKeys);
    assert.equal(impostor.kind, 'unreachable');
  });
});

describe('the half-done pairing file', () => {
  let home = '';
  let paths: RunnerHomePaths;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-'));
    paths = getRunnerHomePaths(home);
    fs.mkdirSync(paths.root, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('holds the hub\'s address and the code\'s id — never the temporary key — and is private', () => {
    assert.equal(readPairingInProgress(paths), null);
    const pairing = { pairId: 'abcdef012345', host: 'host.example', port: 22, user: 'hubuser', hostKey: generateEd25519KeyPair('h').publicKey, startedAtMs: 1, packageId: '0123456789abcdef' };
    writePairingInProgress(paths, pairing);
    assert.deepEqual(readPairingInProgress(paths), pairing);
    assert.equal(fs.statSync(paths.pairing).mode & 0o777, 0o600);
    assert.ok(!fs.readFileSync(paths.pairing, 'utf8').includes('PRIVATE KEY'));
    removePairingInProgress(paths);
    assert.equal(readPairingInProgress(paths), null);
  });

  it('refuses a damaged file by naming it, not echoing it', () => {
    fs.writeFileSync(paths.pairing, JSON.stringify({ pairId: 'secret-looking-value' }));
    assert.throws(() => readPairingInProgress(paths), (error: Error) => error instanceof RunnerConfigError && /pairing\.json is invalid/.test(error.message) && !error.message.includes('secret-looking-value'));
  });
});
