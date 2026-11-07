import { buildPairedRunnerConfig, PairedRunnerSetupError } from '../remoteRun/pairedRunners';
import { probeAllTimeoutMs, probeRunners, readLastProbe, readProbeFailure, writeProbeFailure } from '../remoteRun/runners';
import { createRunnerClient } from '../remoteRun/runnerClient';
import { ensureRemoteRunCacheDir } from '../remoteRun/ssh';
import type { RunnerReport } from '../remoteRun/probe';
import type { RunnerScreenEntry } from '../utils/runnersScreenPlan';
import type { HubContext } from './hubPaths';
import { readPairedFile, readPendingFile, type PairedRunner } from './hubRegistry';
import { getRunnerLinkStatus } from './linkControl';

/**
 * @description What the `/runners` screen shows, read in two steps so it can open at once: {@link readRunnersOverview} is the registry,
 * the links (does the socket accept?) and the last snapshot each machine left — no ssh, milliseconds — and
 * {@link probeRunnersOverview} asks the machines that are online what they are like right now (one shared 20 s deadline, the phase-1
 * probe), keeping the snapshot of a machine that does not answer.
 */

/** A one-shot listing is a quick look: a machine that does not answer within this is shown as it was last known (the screen's own probe waits longer). */
export const staleRefreshDeadlineMs = 8 * 1000;
/** A machine that did not answer a listing is not asked again by one for this long, unless its link began anew — a silent machine must not cost a wait at every listing. */
export const probeRetryAfterMs = 10 * 60 * 1000;

/**
 * One machine of the overview. `isSnapshotStale`: it is online (its link is up) and its last report is older than that link — or it has none —
 * so what the report says (above all how it is kept running: a service installed after the report began the link anew) may no longer be true;
 * a machine that did not answer a listing's probe lately is not stale again until its link begins anew or {@link probeRetryAfterMs} passes.
 * `isReportDoubtful`: it is online and its report is still older than its link (or missing) — it was not refreshed, because it did not answer
 * or was not asked lately — so the listing says so beside its row instead of presenting the report as how things are now.
 * `linkSinceMs`: since when its link has been up, as its status file says (`null` = not known).
 */
export type OverviewEntry = RunnerScreenEntry & { isSnapshotStale?: boolean; isReportDoubtful?: boolean; linkSinceMs?: number | null };

export interface RunnersOverview {
  /** The registry revision (`paired.json` `rev`): what a keyboard built from this overview is valid for. */
  revision: number;
  entries: OverviewEntry[];
  /** Expiry of every pairing code that is still open. */
  openPairingExpiries: number[];
}

async function readEntry(ctx: HubContext, runner: PairedRunner, cacheDir: string, nowMs: number): Promise<OverviewEntry> {
  const status = await getRunnerLinkStatus(ctx.dir, runner.id);
  // Only a report taken since this machine was paired is its own: its name may have belonged to a machine that was removed.
  const snapshot = readLastProbe(cacheDir, runner.name, runner.pairedAtMs);
  const failure = readProbeFailure(cacheDir, runner.name, runner.pairedAtMs);
  const isRecentlySilent = failure !== null && failure.linkSinceMs === status.sinceMs && nowMs - failure.attemptedAtMs < probeRetryAfterMs;
  const isReportOutOfDate = status.isOnline && (snapshot === null || (status.sinceMs !== null && snapshot.seenAtMs < status.sinceMs));
  return {
    runner,
    isOnline: status.isOnline,
    lastSeenMs: status.lastSeenMs ?? snapshot?.seenAtMs ?? null,
    probe: snapshot?.probe ?? null,
    isSnapshotStale: isReportOutOfDate && !isRecentlySilent,
    isReportDoubtful: isReportOutOfDate,
    linkSinceMs: status.sinceMs,
    linkConcern: status.concern,
    isLidClosed: status.isOnline && status.isLidClosed,
  };
}

/** @description The overview without any ssh call: the registry, which links are up, the last snapshots. */
export async function readRunnersOverview(ctx: HubContext, cacheDir: string, nowMs: number): Promise<RunnersOverview> {
  const paired = readPairedFile(ctx.dir);
  return {
    revision: paired.rev,
    entries: await Promise.all(paired.runners.map((runner) => readEntry(ctx, runner, cacheDir, nowMs))),
    openPairingExpiries: readPendingFile(ctx.dir).pending.filter((pairing) => pairing.expiresAtMs > nowMs).map((pairing) => pairing.expiresAtMs),
  };
}

function applyReport(entry: RunnerScreenEntry, report: RunnerReport | undefined): RunnerScreenEntry {
  if (report === undefined) return entry;
  if (report.status === 'online') return { ...entry, probe: report.probe };
  // Linked, but its Mac's lid is shut: it was not asked, so what is shown is the snapshot the entry already holds (a fresh one would pass for an answer).
  if (report.status === 'lid-closed') return { ...entry, isLidClosed: true, probe: entry.probe ?? report.lastProbe };
  // It answered the socket probe but not the ssh one: it is shown as it was, offline.
  return { ...entry, isOnline: false, lastSeenMs: report.lastSeenAtMs ?? entry.lastSeenMs, probe: report.lastProbe ?? entry.probe };
}

/** @description `overview` with the machines that are online asked for their live state, all under one `deadlineMs`. Offline ones are not called. */
export async function probeRunnersOverview(ctx: HubContext, overview: RunnersOverview, cacheDir: string, nowMs: number, deadlineMs: number = probeAllTimeoutMs): Promise<RunnersOverview> {
  const hub = { hubDir: ctx.dir, nodePath: ctx.nodePath, cliPath: ctx.cliPath };
  const clients = overview.entries
    .filter((entry) => entry.isOnline)
    .flatMap((entry) => {
      try {
        return [createRunnerClient(buildPairedRunnerConfig(entry.runner, hub), cacheDir)];
      } catch (error) {
        // A path of this machine that ssh cannot be given safely: that machine is shown as its last snapshot says, not probed.
        if (error instanceof PairedRunnerSetupError) return [];
        throw error;
      }
    });
  if (clients.length === 0) return overview;
  ensureRemoteRunCacheDir(cacheDir);
  const reports = await probeRunners(clients, nowMs, deadlineMs, undefined, { isPruneAllowed: true });
  return { ...overview, entries: overview.entries.map((entry) => applyReport(entry, reports.find((report) => report.name === entry.runner.name))) };
}

/** A failed note is no failure of the listing: the next listing then simply asks again. */
function rememberSilence(cacheDir: string, entry: OverviewEntry, nowMs: number): void {
  try {
    writeProbeFailure(cacheDir, entry.runner.name, { attemptedAtMs: nowMs, linkSinceMs: entry.linkSinceMs ?? null });
  } catch {
    // The cache folder cannot be written (the probe's own report could not be either): the cost is one more wait at the next listing.
  }
}

/**
 * @description The overview for a one-shot listing (`charness runners ls`): as read, with the machines whose report is stale (see
 * {@link OverviewEntry}) asked what they are like now — only those, so a listing that finds every report fresh makes no ssh call, and the report
 * that every probe leaves behind is refreshed for the next reader too. Only the REPORT is taken from the answer: whether a machine is online stays
 * what its link says, so a probe that fails (an ssh that cannot start, a slow machine) never turns a linked machine «offline» in the list.
 * The wait is short ({@link staleRefreshDeadlineMs}), and a machine that gave no answer is remembered ({@link probeRetryAfterMs}) so that the
 * next listing shows it as it was last known at once instead of waiting for the same silence.
 */
export async function refreshStaleSnapshots(ctx: HubContext, overview: RunnersOverview, cacheDir: string, nowMs: number, probe: typeof probeRunnersOverview = probeRunnersOverview): Promise<RunnersOverview> {
  const stale = overview.entries.filter((entry) => entry.isSnapshotStale === true);
  if (stale.length === 0) return overview;
  const asked = await probe(ctx, { ...overview, entries: stale }, cacheDir, nowMs, staleRefreshDeadlineMs);
  return {
    ...overview,
    entries: overview.entries.map((entry) => {
      const answer = asked.entries.find((candidate) => candidate.runner.id === entry.runner.id);
      if (answer === undefined) return entry;
      // An answer is a machine that is online AND handed back a report of its own: the probe returns an entry as it was when it could not
      // ask it (an ssh that cannot be started safely), and that is no answer either.
      const isAnswered = answer.isOnline && answer.probe !== entry.probe;
      if (!answer.isOnline) rememberSilence(cacheDir, entry, nowMs);
      return { ...entry, probe: answer.probe, isSnapshotStale: false, isReportDoubtful: !isAnswered };
    }),
  };
}
