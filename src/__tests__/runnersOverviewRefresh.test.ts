/**
 * @description `runners/runnersOverview.ts` for a one-shot listing: a machine is STALE when it is online and its last report is older than its
 * link — a service installed after the pairing starts the link anew, and the report taken before says «run by hand» — or it has none; only stale
 * machines are asked (a listing that finds every report fresh makes no ssh call), the answer replaces their report, and «online» stays what the
 * link says: a probe that fails never turns a linked machine offline in the list. The wait is short, and a machine that gave no answer is
 * remembered (until its link begins anew, or for a while) so that a listing never waits for the same silence twice.
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
import { writeLidState, writeLinkState } from '../runners/linkControl';
import { readProbeFailure, removeLastProbe, writeProbeFailure } from '../remoteRun/runners';
import { formatRunnerList } from '../runners/runnersList';
import { probeRunnersOverview } from '../runners/runnersOverview';
import { probeRetryAfterMs, readRunnersOverview, refreshStaleSnapshots, staleRefreshDeadlineMs, type RunnersOverview } from '../runners/runnersOverview';
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

describe('where a machine\'s link comes from', () => {
  it('the overview carries what is worth telling about it — read from the link\'s own status — and nothing for a link that never changed address', async () => {
    pairBoth();
    await putLinkUp('a1b2c3d4e5f6', linkStartMs);
    await putLinkUp(secondRunnerId, linkStartMs);
    writeLinkState(hub.ctx.dir, 'a1b2c3d4e5f6', {
      pid: process.pid,
      sinceMs: linkStartMs,
      lastBeatMs: nowMs,
      endedAtMs: null,
      source: '203.0.113.9',
      sourceChanges: [{ fromSource: '198.51.100.7', toSource: '203.0.113.9', atMs: nowMs - 60 * 1000, isLiveReplacement: true }],
    });
    writeLinkState(hub.ctx.dir, secondRunnerId, { pid: process.pid, sinceMs: linkStartMs, lastBeatMs: nowMs, endedAtMs: null, source: '198.51.100.7', sourceChanges: [] });
    const overview = await readRunnersOverview(hub.ctx, cacheDir, nowMs);
    assert.deepEqual(overview.entries.map((entry) => entry.linkConcern), [
      { kind: 'sourceChanged', fromSource: '198.51.100.7', toSource: '203.0.113.9', atMs: nowMs - 60 * 1000, isLiveReplacement: true },
      null,
    ]);
    const text = formatRunnerList(overview.entries, [], nowMs);
    assert.match(text.split('\n')[0], /\(its link now comes from 203\.0\.113\.9, before from 198\.51\.100\.7, [\d-]+ [\d:]+, taking the place of a link that was still up/);
    assert.doesNotMatch(text.split('\n')[1], /its link now comes from/);
  });
});

describe('a machine whose Mac has its lid closed', () => {
  const closed = { isClosed: true, reportedAtMs: nowMs - 1000 };

  it('the overview says so from the link\'s own record — with no ssh call — for a machine that is online, and for no other: an offline machine is offline, whatever it said last', async () => {
    pairBoth();
    await putLinkUp('a1b2c3d4e5f6', linkStartMs);
    writeLidState(hub.ctx.dir, 'a1b2c3d4e5f6', closed);
    writeLidState(hub.ctx.dir, secondRunnerId, closed);
    const overview = await readRunnersOverview(hub.ctx, cacheDir, nowMs);
    assert.deepEqual(overview.entries.map((entry) => [entry.runner.name, entry.isOnline, entry.isLidClosed]), [['mac', true, true], ['box', false, false]]);
  });

  it('a machine that said its lid is open again is just online', async () => {
    pairBoth();
    await putLinkUp('a1b2c3d4e5f6', linkStartMs);
    writeLidState(hub.ctx.dir, 'a1b2c3d4e5f6', closed);
    writeLidState(hub.ctx.dir, 'a1b2c3d4e5f6', { isClosed: false, reportedAtMs: nowMs });
    assert.equal((await readRunnersOverview(hub.ctx, cacheDir, nowMs)).entries[0].isLidClosed, false);
  });

  it('the `ls` line says «lid closed» where it would say «online», with what that means', async () => {
    pairBoth();
    await putLinkUp('a1b2c3d4e5f6', linkStartMs);
    writeLidState(hub.ctx.dir, 'a1b2c3d4e5f6', closed);
    const text = formatRunnerList((await readRunnersOverview(hub.ctx, cacheDir, nowMs)).entries, [], nowMs);
    assert.match(text.split('\n')[0], /^mac — lid closed \(takes no new jobs until its lid is opened \(a job already running there goes on\)\) · /);
    assert.doesNotMatch(text.split('\n')[0], /— online/);
  });

  it('the screen\'s probe does not ask it (the report is «lid closed», no ssh call) and keeps the snapshot the entry holds — a fresh read of the same file would pass for an answer', async () => {
    pairBoth();
    await putLinkUp('a1b2c3d4e5f6', linkStartMs);
    saveReport('mac', linkStartMs + 1, byHandReport);
    writeLidState(hub.ctx.dir, 'a1b2c3d4e5f6', closed);
    const overview = await readRunnersOverview(hub.ctx, cacheDir, nowMs);
    const probed = await probeRunnersOverview(hub.ctx, overview, cacheDir, nowMs, 5000);
    assert.equal(probed.entries[0].isOnline, true);
    assert.equal(probed.entries[0].isLidClosed, true);
    assert.equal(probed.entries[0].probe, overview.entries[0].probe, 'the snapshot the entry held, not a new reading of it');
    assert.equal(probed.entries[0].probe?.serviceKind, 'foreground');
  });

  it('a listing\'s refresh of a stale machine whose lid is closed leaves its report doubtful: nothing was asked, so nothing was answered', async () => {
    pairBoth();
    await putLinkUp('a1b2c3d4e5f6', linkStartMs);
    saveReport('mac', linkStartMs - 1000, byHandReport);
    writeLidState(hub.ctx.dir, 'a1b2c3d4e5f6', closed);
    const refreshed = await refreshStaleSnapshots(hub.ctx, await readRunnersOverview(hub.ctx, cacheDir, nowMs), cacheDir, nowMs);
    assert.equal(refreshed.entries[0].isLidClosed, true);
    assert.equal(refreshed.entries[0].isReportDoubtful, true);
    assert.equal(refreshed.entries[0].probe?.serviceKind, 'foreground');
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

describe('a machine that does not answer a listing', () => {
  const aFewSecondsMs = 10 * 1000;

  /** A probe that records who it was asked about and with what deadline, and answers as the real one does when the ssh call fails: the machine «offline», its last report kept. */
  function createSilentProbe(): { asked: string[]; deadlines: Array<number | undefined>; probe: Parameters<typeof refreshStaleSnapshots>[4] } {
    const asked: string[] = [];
    const deadlines: Array<number | undefined> = [];
    return {
      asked,
      deadlines,
      probe: async (_ctx, overview, _cacheDir, _nowMs, deadlineMs): Promise<RunnersOverview> => {
        asked.push(...overview.entries.map((entry) => entry.runner.name));
        deadlines.push(deadlineMs);
        return { ...overview, entries: overview.entries.map((entry) => ({ ...entry, isOnline: false })) };
      },
    };
  }

  /** One listing the way `charness runners ls` makes it: read, then refresh the stale ones. */
  async function list(probe: Parameters<typeof refreshStaleSnapshots>[4], atMs: number): Promise<RunnersOverview> {
    return refreshStaleSnapshots(hub.ctx, await readRunnersOverview(hub.ctx, cacheDir, atMs), cacheDir, atMs, probe);
  }

  async function arrangeStaleMac(): Promise<void> {
    pairBoth();
    await putLinkUp('a1b2c3d4e5f6', linkStartMs);
    saveReport('mac', linkStartMs - 1000, byHandReport);
  }

  it('is waited for only a few seconds — the listing asks with its own short deadline, not the screen\'s 20 s', async () => {
    await arrangeStaleMac();
    const { deadlines, probe } = createSilentProbe();
    await list(probe, nowMs);
    assert.deepEqual(deadlines, [staleRefreshDeadlineMs]);
    assert.ok(staleRefreshDeadlineMs <= aFewSecondsMs, `${staleRefreshDeadlineMs} ms is not «a few seconds»`);
  });

  it('is asked ONCE: the next listings show it as it was last known at once, without asking again', async () => {
    await arrangeStaleMac();
    const { asked, probe } = createSilentProbe();
    await list(probe, nowMs);
    assert.deepEqual(readProbeFailure(cacheDir, 'mac'), { attemptedAtMs: nowMs, linkSinceMs: linkStartMs }, 'the silence is remembered with the link it was met on');
    const second = await list(probe, nowMs + 60 * 1000);
    const third = await list(probe, nowMs + 5 * 60 * 1000);
    assert.deepEqual(asked, ['mac'], 'one question for three listings');
    assert.equal(second.entries[0].probe?.serviceKind, 'foreground', 'it is shown as last known');
    assert.equal(third.entries[0].isOnline, true, 'and still online, as its link says');
  });

  it('is asked again when its link began anew — a service installed or a restart is a new situation', async () => {
    await arrangeStaleMac();
    const { asked, probe } = createSilentProbe();
    await list(probe, nowMs);
    // The link restarts: the socket still accepts (the same server), its status file now says it began later.
    writeLinkState(hub.ctx.dir, 'a1b2c3d4e5f6', { pid: process.pid, sinceMs: linkStartMs + 5 * 60 * 1000, lastBeatMs: nowMs, endedAtMs: null });
    await list(probe, nowMs + 10 * 1000);
    assert.deepEqual(asked, ['mac', 'mac']);
    assert.equal(readProbeFailure(cacheDir, 'mac')?.linkSinceMs, linkStartMs + 5 * 60 * 1000, 'the new silence is remembered with the new link');
  });

  it('is asked again after a while on the same link, so that a machine that was only slow is not left unrefreshed for good', async () => {
    await arrangeStaleMac();
    const { asked, probe } = createSilentProbe();
    await list(probe, nowMs);
    await list(probe, nowMs + probeRetryAfterMs - 1);
    assert.deepEqual(asked, ['mac'], 'still remembered just before the time is up');
    await list(probe, nowMs + probeRetryAfterMs);
    assert.deepEqual(asked, ['mac', 'mac'], 'asked again once it is');
  });

  it('a machine that answered leaves no memory of silence, and a silence remembered for an earlier machine of that name is not this one\'s', async () => {
    await arrangeStaleMac();
    writeProbeFailure(cacheDir, 'mac', { attemptedAtMs: 1, linkSinceMs: linkStartMs });
    const answering = { asked: [] as string[] };
    const probe: Parameters<typeof refreshStaleSnapshots>[4] = async (_ctx, overview) => {
      answering.asked.push(...overview.entries.map((entry) => entry.runner.name));
      return { ...overview, entries: overview.entries.map((entry) => ({ ...entry, probe: parseProbeOutput(systemServiceReport) })) };
    };
    const refreshed = await list(probe, nowMs);
    assert.deepEqual(answering.asked, ['mac'], 'the old silence (before this machine was paired) did not keep it from being asked');
    assert.equal(refreshed.entries[0].isSnapshotStale, false);
    assert.deepEqual(readProbeFailure(cacheDir, 'mac'), { attemptedAtMs: 1, linkSinceMs: linkStartMs }, 'an answer writes no silence of its own');
  });

  it('is forgotten with the runner\'s last report when the runner is removed', () => {
    saveReport('mac', linkStartMs, byHandReport);
    writeProbeFailure(cacheDir, 'mac', { attemptedAtMs: nowMs, linkSinceMs: null });
    removeLastProbe(cacheDir, 'mac');
    assert.equal(readProbeFailure(cacheDir, 'mac'), null);
    assert.ok(!fs.existsSync(path.join(cacheDir, 'mac.probe.json')));
    removeLastProbe(cacheDir, 'mac');
  });

  describe('what the listing says beside it', () => {
    const doubtfulNote = '(last report from before its link started; it did not answer)';

    it('names the doubt on the row of an online machine whose report predates its link and that did not answer — at that listing and at every later one that does not ask again', async () => {
      await arrangeStaleMac();
      const { probe } = createSilentProbe();
      const first = await list(probe, nowMs);
      const later = await list(probe, nowMs + 60 * 1000);
      for (const overview of [first, later]) {
        const rows = formatRunnerList(overview.entries, [], nowMs).split('\n');
        assert.match(rows[0], /^mac — online · .* · run by hand · .*/, 'the row still says what is last known');
        assert.ok(rows[0].endsWith(doubtfulNote), rows[0]);
        assert.ok(!rows[1].includes('did not answer'), `a machine that is not online carries no note: ${rows[1]}`);
      }
    });

    it('says «no report yet» for an online machine that has never reported and did not answer', async () => {
      pairBoth();
      await putLinkUp('a1b2c3d4e5f6', linkStartMs);
      const { probe } = createSilentProbe();
      const refreshed = await list(probe, nowMs);
      assert.ok(formatRunnerList(refreshed.entries, [], nowMs).split('\n')[0].endsWith('(no report yet; it did not answer)'));
    });

    it('is silent when the machine answered, when its report is newer than its link, and when it is offline', async () => {
      pairBoth();
      await putLinkUp('a1b2c3d4e5f6', linkStartMs);
      await putLinkUp(secondRunnerId, linkStartMs);
      saveReport('mac', linkStartMs - 1000, byHandReport);
      saveReport('box', linkStartMs + 1, byHandReport);
      const answers: Parameters<typeof refreshStaleSnapshots>[4] = async (_ctx, overview) => ({ ...overview, entries: overview.entries.map((entry) => ({ ...entry, probe: parseProbeOutput(systemServiceReport) })) });
      const text = formatRunnerList((await list(answers, nowMs)).entries, [], nowMs);
      assert.ok(!text.includes('did not answer'), text);
      assert.ok(text.split('\n')[0].includes('system service'), 'the refreshed report is the one shown');
    });

    it('is also named for a machine the probe could not ask at all (it returns the entry as it was): that is no answer either', async () => {
      await arrangeStaleMac();
      const unasked: Parameters<typeof refreshStaleSnapshots>[4] = async (_ctx, overview) => overview;
      const refreshed = await list(unasked, nowMs);
      assert.ok(formatRunnerList(refreshed.entries, [], nowMs).split('\n')[0].endsWith(doubtfulNote));
    });
  });
});
