/**
 * @description `runners/runnersOverview.ts` for a one-shot listing: a machine is STALE when it is online and its last report is older than its
 * link — a service installed after the pairing starts the link anew, and the report taken before says «run by hand» — or it has none; only stale
 * machines are asked (a listing that finds every report fresh makes no ssh call), the answer replaces their report, and «online» stays what the
 * link says: a probe that fails never turns a linked machine offline in the list.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { parseProbeOutput } from '../remoteRun/probe';
import { getRunnerLinkPaths } from '../runners/hubPaths';
import { writePairedFile } from '../runners/hubRegistry';
import { writeLinkState } from '../runners/linkControl';
import { readRunnersOverview, refreshStaleSnapshots, type RunnersOverview } from '../runners/runnersOverview';
import { createPairedRunnerFixture } from './remoteRunPairedKit';
import { createHubFixture, type HubFixture } from './runnersTestKit';

const linkStartMs = Date.UTC(2026, 10, 3, 12, 0, 0);
const nowMs = linkStartMs + 60 * 60 * 1000;
const secondRunnerId = 'b1b2c3d4e5f6';
const byHandReport = 'os_name=macOS\nservice=foreground';
const systemServiceReport = 'os_name=macOS\nservice=system-service';

let hub: HubFixture;
let cacheDir: string;
const servers: net.Server[] = [];

function saveReport(name: string, seenAtMs: number, text: string): void {
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, `${name}.probe.json`), JSON.stringify({ seenAtMs, text }));
}

/** The machine's link is up since `sinceMs`: its socket accepts and its status file says when it began. */
async function putLinkUp(runnerId: string, sinceMs: number): Promise<void> {
  const paths = getRunnerLinkPaths(hub.ctx.dir, runnerId);
  fs.mkdirSync(path.dirname(paths.socket), { recursive: true });
  const server = net.createServer((connection) => connection.destroy());
  servers.push(server);
  await new Promise<void>((resolve) => { server.listen(paths.socket, resolve); });
  writeLinkState(hub.ctx.dir, runnerId, { pid: process.pid, sinceMs, lastBeatMs: nowMs, endedAtMs: null });
}

function pairBoth(): void {
  writePairedFile(hub.ctx.dir, {
    rev: 2,
    runners: [createPairedRunnerFixture({ name: 'mac', serviceKind: 'foreground' }), createPairedRunnerFixture({ id: secondRunnerId, name: 'box', serviceKind: 'foreground', pairId: '1123456789ab' })],
  });
}

beforeEach(() => {
  hub = createHubFixture();
  cacheDir = path.join(hub.root, 'c');
  servers.length = 0;
});
afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); })));
  hub.cleanup();
});

describe('which machines are stale', () => {
  it('an online machine with no report, or a report older than its link, is stale; one with a report taken since its link began is not; a machine that is not online never is', async () => {
    pairBoth();
    await putLinkUp('a1b2c3d4e5f6', linkStartMs);
    const staleOverview = await readRunnersOverview(hub.ctx, cacheDir, nowMs);
    assert.deepEqual(staleOverview.entries.map((entry) => [entry.runner.name, entry.isOnline, entry.isSnapshotStale]), [['mac', true, true], ['box', false, false]], 'no report yet / not online');
    saveReport('mac', linkStartMs - 1, byHandReport);
    assert.equal((await readRunnersOverview(hub.ctx, cacheDir, nowMs)).entries[0].isSnapshotStale, true, 'the report predates the link');
    saveReport('mac', linkStartMs, systemServiceReport);
    assert.equal((await readRunnersOverview(hub.ctx, cacheDir, nowMs)).entries[0].isSnapshotStale, false, 'the report was taken as the link began or later');
  });
});

describe('refreshing the stale ones for a listing', () => {
  /** A probe that records who it was asked about and answers for each as `answer` says. */
  function createProbe(answer: (name: string) => { isOnline: boolean; text: string }): { asked: string[]; probe: Parameters<typeof refreshStaleSnapshots>[4] } {
    const asked: string[] = [];
    return {
      asked,
      probe: async (_ctx, overview): Promise<RunnersOverview> => {
        asked.push(...overview.entries.map((entry) => entry.runner.name));
        return { ...overview, entries: overview.entries.map((entry) => ({ ...entry, isOnline: answer(entry.runner.name).isOnline, probe: parseProbeOutput(answer(entry.runner.name).text) })) };
      },
    };
  }

  it('asks only the stale machines and shows what they answer: «run by hand» from before the service becomes «system service»', async () => {
    pairBoth();
    await putLinkUp('a1b2c3d4e5f6', linkStartMs);
    await putLinkUp(secondRunnerId, linkStartMs);
    saveReport('mac', linkStartMs - 1000, byHandReport);
    saveReport('box', linkStartMs + 1000, byHandReport);
    const { asked, probe } = createProbe(() => ({ isOnline: true, text: systemServiceReport }));
    const refreshed = await refreshStaleSnapshots(hub.ctx, await readRunnersOverview(hub.ctx, cacheDir, nowMs), cacheDir, nowMs, probe);
    assert.deepEqual(asked, ['mac'], 'box has a report newer than its link: not asked');
    assert.deepEqual(refreshed.entries.map((entry) => [entry.runner.name, entry.probe?.serviceKind]), [['mac', 'system-service'], ['box', 'foreground']]);
    assert.equal(refreshed.entries[0].isSnapshotStale, false);
  });

  it('a listing that finds every report fresh makes no ssh call at all', async () => {
    pairBoth();
    await putLinkUp('a1b2c3d4e5f6', linkStartMs);
    saveReport('mac', linkStartMs + 1, byHandReport);
    const { asked, probe } = createProbe(() => ({ isOnline: true, text: systemServiceReport }));
    const overview = await readRunnersOverview(hub.ctx, cacheDir, nowMs);
    assert.equal(await refreshStaleSnapshots(hub.ctx, overview, cacheDir, nowMs, probe), overview);
    assert.deepEqual(asked, []);
  });

  it('a probe that finds the machine «offline» (its ssh failed) leaves it ONLINE in the list — the link says so — and keeps its last report', async () => {
    pairBoth();
    await putLinkUp('a1b2c3d4e5f6', linkStartMs);
    saveReport('mac', linkStartMs - 1000, byHandReport);
    // Like the real probe on a failure: the machine is demoted and shown with its last report.
    const probe: Parameters<typeof refreshStaleSnapshots>[4] = async (_ctx, overview) => ({ ...overview, entries: overview.entries.map((entry) => ({ ...entry, isOnline: false, lastSeenMs: 1, probe: entry.probe })) });
    const refreshed = await refreshStaleSnapshots(hub.ctx, await readRunnersOverview(hub.ctx, cacheDir, nowMs), cacheDir, nowMs, probe);
    assert.equal(refreshed.entries[0].isOnline, true);
    assert.notEqual(refreshed.entries[0].lastSeenMs, 1, 'and its last-seen is the link\'s own');
    assert.equal(refreshed.entries[0].probe?.serviceKind, 'foreground');
  });
});
