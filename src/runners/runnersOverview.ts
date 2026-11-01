import { readLastProbe, probeRunners } from '../remoteRun/runners';
import { createRunnerClient } from '../remoteRun/runnerClient';
import { ensureRemoteRunCacheDir } from '../remoteRun/ssh';
import type { RunnerReport } from '../remoteRun/probe';
import type { RunnerScreenEntry } from '../utils/runnersScreenPlan';
import type { HubContext } from './hubPaths';
import { readPairedFile, readPendingFile, type PairedRunner } from './hubRegistry';
import { getRunnerLinkStatus } from './linkControl';
import { buildPairedRunnerConfig } from './pairedRunnerConfig';

/**
 * @description What the `/runners` screen shows, read in two steps so it can open at once: {@link readRunnersOverview} is the registry,
 * the links (does the socket accept?) and the last snapshot each machine left — no ssh, milliseconds — and
 * {@link probeRunnersOverview} asks the machines that are online what they are like right now (one shared 20 s deadline, the phase-1
 * probe), keeping the snapshot of a machine that does not answer.
 */

export interface RunnersOverview {
  /** The registry revision (`paired.json` `rev`): what a keyboard built from this overview is valid for. */
  revision: number;
  entries: RunnerScreenEntry[];
  /** Expiry of every pairing code that is still open. */
  openPairingExpiries: number[];
}

async function readEntry(ctx: HubContext, runner: PairedRunner, cacheDir: string): Promise<RunnerScreenEntry> {
  const status = await getRunnerLinkStatus(ctx.dir, runner.id);
  const snapshot = readLastProbe(cacheDir, runner.name);
  return { runner, isOnline: status.isOnline, lastSeenMs: status.lastSeenMs ?? snapshot?.seenAtMs ?? null, probe: snapshot?.probe ?? null };
}

/** @description The overview without any ssh call: the registry, which links are up, the last snapshots. */
export async function readRunnersOverview(ctx: HubContext, cacheDir: string, nowMs: number): Promise<RunnersOverview> {
  const paired = readPairedFile(ctx.dir);
  return {
    revision: paired.rev,
    entries: await Promise.all(paired.runners.map((runner) => readEntry(ctx, runner, cacheDir))),
    openPairingExpiries: readPendingFile(ctx.dir).pending.filter((pairing) => pairing.expiresAtMs > nowMs).map((pairing) => pairing.expiresAtMs),
  };
}

function applyReport(entry: RunnerScreenEntry, report: RunnerReport | undefined): RunnerScreenEntry {
  if (report === undefined) return entry;
  if (report.status === 'online') return { ...entry, probe: report.probe };
  // It answered the socket probe but not the ssh one: it is shown as it was, offline.
  return { ...entry, isOnline: false, lastSeenMs: report.lastSeenAtMs ?? entry.lastSeenMs, probe: report.lastProbe ?? entry.probe };
}

/** @description `overview` with the machines that are online asked for their live state. Offline ones are not called. */
export async function probeRunnersOverview(ctx: HubContext, overview: RunnersOverview, cacheDir: string, nowMs: number): Promise<RunnersOverview> {
  const online = overview.entries.filter((entry) => entry.isOnline);
  if (online.length === 0) return overview;
  ensureRemoteRunCacheDir(cacheDir);
  const reports = await probeRunners(online.map((entry) => createRunnerClient(buildPairedRunnerConfig(ctx, entry.runner), cacheDir)), nowMs);
  return { ...overview, entries: overview.entries.map((entry) => applyReport(entry, reports.find((report) => report.name === entry.runner.name))) };
}
