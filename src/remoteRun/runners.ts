import * as fs from 'fs';
import * as path from 'path';
import {
  checkHasCapability,
  formatRunnerBlock,
  parseProbeOutput,
  type RunnerCapability,
  type RunnerProbe,
  type RunnerReport,
} from './probe';
import { RemoteRunError, RunnerUnreachableError } from './remoteRunError';
import { remoteRunExitCodes } from './exitCodes';
import { describeSshFailure, type RunnerClient } from './runnerClient';
import type { RunnerConfig, RunnersConfig } from './runnersConfig';

/**
 * @description Which runners exist right now: probe them (in parallel, bounded), remember each one's last answer so an offline runner
 * still shows what it was, and pick the one a command should use — the named one, or the first in `runners.json` that answers and, with
 * `--needs`, has the capability.
 */

/** The whole probing of all runners ends by then (a dead host costs its ssh connect timeout, once, in parallel with the others). */
export const probeAllTimeoutMs = 20 * 1000;
const probeFileSuffix = '.probe.json';

interface StoredProbe {
  seenAtMs: number;
  /** The runner's own `key=value` text, parsed again on read so the format has one parser. */
  text: string;
}

function getStoredProbePath(cacheDir: string, runnerName: string): string {
  return path.join(cacheDir, `${runnerName}${probeFileSuffix}`);
}

export function readLastProbe(cacheDir: string, runnerName: string): { seenAtMs: number; probe: RunnerProbe } | null {
  try {
    const stored: StoredProbe = JSON.parse(fs.readFileSync(getStoredProbePath(cacheDir, runnerName), 'utf8'));
    if (typeof stored.seenAtMs !== 'number' || typeof stored.text !== 'string') return null;
    return { seenAtMs: stored.seenAtMs, probe: parseProbeOutput(stored.text) };
  } catch {
    return null;
  }
}

function writeLastProbe(cacheDir: string, runnerName: string, text: string, seenAtMs: number): void {
  const stored: StoredProbe = { seenAtMs, text };
  fs.writeFileSync(getStoredProbePath(cacheDir, runnerName), JSON.stringify(stored), { mode: 0o600 });
}

/** @description Probe one runner: its report is `online` with what it said, or `offline` with why and the last snapshot. */
export async function probeRunner(client: RunnerClient, nowMs: number = Date.now()): Promise<RunnerReport> {
  const runner = client.runner;
  const groupLimits = { ...(runner.groups ?? {}) };
  const offline = (reason: string): RunnerReport => {
    const last = readLastProbe(client.cacheDir, runner.name);
    return { name: runner.name, status: 'offline', reason, lastSeenAtMs: last?.seenAtMs ?? null, lastProbe: last?.probe ?? null, groupLimits };
  };
  try {
    await client.ensureScript();
  } catch (error) {
    if (error instanceof RunnerUnreachableError) return offline(error.reason);
    return offline(error instanceof Error ? error.message : 'could not prepare the runner');
  }
  const result = await client.call('probe', [], { timeoutMs: probeAllTimeoutMs });
  if (result.exitCode !== 0) return offline(describeSshFailure(result));
  writeLastProbe(client.cacheDir, runner.name, result.stdout, nowMs);
  return { name: runner.name, status: 'online', probe: parseProbeOutput(result.stdout), groupLimits };
}

/** @description Probe every client at once; one that does not answer inside the bound is reported offline, the others are not held back. */
export async function probeRunners(clients: readonly RunnerClient[], nowMs: number = Date.now()): Promise<RunnerReport[]> {
  return Promise.all(clients.map(async (client) => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<RunnerReport>((resolve) => {
      timer = setTimeout(() => resolve({ name: client.runner.name, status: 'offline', reason: 'no answer in time', lastSeenAtMs: null, lastProbe: null, groupLimits: { ...(client.runner.groups ?? {}) } }), probeAllTimeoutMs);
    });
    try {
      return await Promise.race([probeRunner(client, nowMs), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }));
}

export type RunnerPick = { ok: true; runnerName: string } | { ok: false; message: string; exitCode: number };

/** The `runners` view of why nothing fits, one block per runner. */
export function formatRunnersView(reports: readonly RunnerReport[]): string {
  return reports.map(formatRunnerBlock).join('\n\n');
}

function checkIsUsable(report: RunnerReport): report is Extract<RunnerReport, { status: 'online' }> {
  return report.status === 'online' && report.probe.pueueVersion !== null;
}

/**
 * @description The runner a command should use. `wanted.runner` names one (it must exist, answer and have Pueue); otherwise the first
 * runner in `config` order that answers, has Pueue and — with `wanted.needs` — the capability. None: the reason and the `runners`
 * view, exit 125.
 */
export function pickRunner(config: RunnersConfig, reports: readonly RunnerReport[], wanted: { runner: string | null; needs: RunnerCapability | null }): RunnerPick {
  if (wanted.runner !== null) {
    const report = reports.find((candidate) => candidate.name === wanted.runner);
    if (report === undefined) {
      return { ok: false, exitCode: remoteRunExitCodes.usage, message: `no runner named "${wanted.runner}" in runners.json (configured: ${config.runners.map((runner) => runner.name).join(', ')})` };
    }
    if (report.status === 'offline') return { ok: false, exitCode: remoteRunExitCodes.failed, message: `runner "${wanted.runner}" is offline (${report.reason})\n${formatRunnersView([report])}` };
    if (!checkIsUsable(report)) return { ok: false, exitCode: remoteRunExitCodes.failed, message: `runner "${wanted.runner}" has no Pueue (install it there, see docs/remote-run.md)\n${formatRunnersView([report])}` };
    if (wanted.needs !== null && !checkHasCapability(report.probe, wanted.needs)) {
      return { ok: false, exitCode: remoteRunExitCodes.failed, message: `runner "${wanted.runner}" cannot do "${wanted.needs}"\n${formatRunnersView([report])}` };
    }
    return { ok: true, runnerName: report.name };
  }
  for (const runner of config.runners) {
    const report = reports.find((candidate) => candidate.name === runner.name);
    if (report === undefined || !checkIsUsable(report)) continue;
    if (wanted.needs === null || checkHasCapability(report.probe, wanted.needs)) return { ok: true, runnerName: runner.name };
  }
  const reason = wanted.needs === null ? 'no runner is online' : `no online runner can do "${wanted.needs}"`;
  return { ok: false, exitCode: remoteRunExitCodes.failed, message: `${reason}\n${formatRunnersView(reports)}` };
}

/** @description The runner of a job id, from the config: an id of a runner that is no longer listed is an error. */
export function findRunnerOfJob(config: RunnersConfig, runnerName: string): RunnerConfig {
  const runner = config.runners.find((candidate) => candidate.name === runnerName);
  if (runner === undefined) throw new RemoteRunError(`the job belongs to runner "${runnerName}", which is not in runners.json any more`);
  return runner;
}
