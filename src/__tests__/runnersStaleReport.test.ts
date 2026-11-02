/**
 * @description A machine's last report is saved under its NAME (`<name>.probe.json`), and a name outlives the machine: a removed runner
 * hands it to the next one that gets it. The report must not travel with the name — `/runners` and `charness runners ls` read it first for
 * «how it is kept running» and «last seen», so an inherited one shows a new «run by hand» machine as an always-on system service that was
 * seen last month. Two guards: removing a runner deletes its report, and a report taken before the machine was paired is not read at all
 * (also when the removal went another way, or a probe wrote the file after it).
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { readLastProbe } from '../remoteRun/runners';
import { createPairing, redeemPairing } from '../runners/hubPairing';
import { removeRunnerAndEndItsWork, type RunnerRemovalDeps } from '../runners/runnerRemoval';
import { readRunnersOverview } from '../runners/runnersOverview';
import { formatRunnerList } from '../runners/runnersList';
import { generateEd25519KeyPair } from '../runners/sshKeys';
import { createHubFixture, createRedeemFixture, type HubFixture } from './runnersTestKit';

const firstPairingMs = Date.UTC(2026, 10, 1, 12, 0, 0);
const oldReportMs = firstPairingMs + 60 * 60 * 1000;
const removalMs = firstPairingMs + 2 * 60 * 60 * 1000;
const secondPairingMs = firstPairingMs + 3 * 60 * 60 * 1000;
const systemServiceReport = 'os_name=Ubuntu\nos_version=24.04\nservice=system-service';

let hub: HubFixture;
let cacheDir: string;
let logged: string[];

function getReportPath(name: string): string {
  return path.join(cacheDir, `${name}.probe.json`);
}

function saveReport(name: string, seenAtMs: number, text: string = systemServiceReport): void {
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(getReportPath(name), JSON.stringify({ seenAtMs, text }));
}

async function pairMachine(nowMs: number): Promise<string> {
  const hostKey = generateEd25519KeyPair('hub-host').publicKey;
  const pairing = await createPairing(hub.ctx, { host: 'host.example', port: 22, hostKey, label: 'x', nowMs, sshUser: 'hubuser' });
  const reply = await redeemPairing(hub.ctx, pairing.pairId, createRedeemFixture({ suggestedName: 'Mac Mini' }).request, nowMs);
  if (!reply.ok) throw new Error(reply.reason);
  return reply.name;
}

/** What `charness runners ls` prints: the screen's first step (no ssh) in the list's text. */
async function readList(nowMs: number): Promise<string> {
  const overview = await readRunnersOverview(hub.ctx, cacheDir, nowMs);
  return formatRunnerList(overview.entries, [], nowMs);
}

function createOfflineRemovalDeps(): RunnerRemovalDeps {
  return {
    isLinkOnline: async () => false,
    runSsh: async () => { throw new Error('an offline machine is not called'); },
    cacheDir,
    log: (line) => { logged.push(line); },
  };
}

beforeEach(() => {
  hub = createHubFixture();
  cacheDir = path.join(hub.root, 'cache');
  logged = [];
});
afterEach(() => {
  hub.cleanup();
});

describe('the saved report of a machine whose name is handed on', () => {
  it('a machine paired under the name of a removed one starts with «run by hand» and «never connected», not with the old one\'s report', async () => {
    const name = await pairMachine(firstPairingMs);
    saveReport(name, oldReportMs);
    assert.match(await readList(oldReportMs), /offline since .* · system service ·/, 'its own report, taken after it was paired, is read');

    await removeRunnerAndEndItsWork(hub.ctx, name, removalMs, createOfflineRemovalDeps());
    assert.equal(await pairMachine(secondPairingMs), name, 'the name is free again and goes to the next machine');

    const list = await readList(secondPairingMs);
    assert.match(list, new RegExp(`^${name} — offline, never connected · .* · run by hand ·`, 'm'));
    assert.doesNotMatch(list, /system service|offline since/);
  });

  it('removing a runner deletes its saved report', async () => {
    const name = await pairMachine(firstPairingMs);
    saveReport(name, oldReportMs);
    await removeRunnerAndEndItsWork(hub.ctx, name, removalMs, createOfflineRemovalDeps());
    assert.equal(fs.existsSync(getReportPath(name)), false);
  });

  it('removing a runner whose report is not there, or cannot be deleted, still removes it — the failure is logged', async () => {
    const name = await pairMachine(firstPairingMs);
    // A folder in the place of the file: deleting it as a file fails with EISDIR/EPERM, whatever the user's rights.
    fs.mkdirSync(getReportPath(name), { recursive: true });
    fs.writeFileSync(path.join(getReportPath(name), 'keep'), '');
    const removal = await removeRunnerAndEndItsWork(hub.ctx, name, removalMs, createOfflineRemovalDeps());
    assert.equal(removal?.runner.name, name);
    assert.ok(logged.some((line) => line.includes(`"${name}"`) && line.includes('saved report')), logged.join('\n'));
  });

  it('a report that is already there when the machine is paired — the removal went another way, or a probe wrote it after — is not read', async () => {
    const name = await pairMachine(firstPairingMs);
    await removeRunnerAndEndItsWork(hub.ctx, name, removalMs, createOfflineRemovalDeps());
    saveReport(name, oldReportMs);
    assert.equal(await pairMachine(secondPairingMs), name);
    const list = await readList(secondPairingMs);
    assert.match(list, /offline, never connected · .* · run by hand ·/);
    assert.doesNotMatch(list, /system service/);
    saveReport(name, secondPairingMs + 1000);
    assert.match(await readList(secondPairingMs + 2000), /offline since .* · system service ·/, 'a report taken after the pairing is the machine\'s own');
  });

  it('the reader: a report taken before `notBeforeMs` is nobody\'s here; one taken at that moment or later is read; without a floor every report is', () => {
    saveReport('box1', 5000);
    assert.equal(readLastProbe(cacheDir, 'box1', 5001), null);
    assert.equal(readLastProbe(cacheDir, 'box1', 5000)?.seenAtMs, 5000);
    assert.equal(readLastProbe(cacheDir, 'box1', 4000)?.seenAtMs, 5000);
    assert.equal(readLastProbe(cacheDir, 'box1')?.seenAtMs, 5000);
  });
});
