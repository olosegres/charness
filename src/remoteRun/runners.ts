import * as fs from 'fs';
import * as path from 'path';
import { getRunnerLinkStatus } from '../runners/linkControl';
import {
  checkHasCapability,
  checkIsRunnerPaused,
  formatRunnerBlock,
  lidClosedNote,
  parseProbeOutput,
  type RunnerCapability,
  type RunnerProbe,
  type RunnerReport,
} from './probe';
import { RemoteRunError, RunnerUnreachableError } from './remoteRunError';
import { remoteRunExitCodes } from './exitCodes';
import { describeSshFailure, notConnectedReason, type RunnerClient } from './runnerClient';
import type { RunnerConfig, RunnersConfig } from './runnersConfig';

/**
 * @description Which runners exist right now: probe them (in parallel, bounded), remember each one's last answer so an offline runner
 * still shows what it was, and pick the one a command should use — the named one, or the first in the catalog (`runners.json` entries,
 * then the paired runners) that answers, is not paused and, with `--needs`, has the capability.
 */

/** The whole probing of all runners ends by then (a dead host costs its ssh connect timeout, once, in parallel with the others). */
export const probeAllTimeoutMs = 20 * 1000;
const probeFileSuffix = '.probe.json';
const probeFailureFileSuffix = '.probe-failed.json';
const millisecondsPerSecond = 1000;

interface StoredProbe {
  seenAtMs: number;
  /** The runner's own `key=value` text, parsed again on read so the format has one parser. */
  text: string;
}

function getStoredProbePath(cacheDir: string, runnerName: string): string {
  return path.join(cacheDir, `${runnerName}${probeFileSuffix}`);
}

function getProbeFailurePath(cacheDir: string, runnerName: string): string {
  return path.join(cacheDir, `${runnerName}${probeFailureFileSuffix}`);
}

/**
 * @description A probe of a runner that got no answer, remembered so that a quick look (`charness runners ls`) does not wait for the same
 * silence again and again: when it was made, and since when the runner's link had been up (`null` = not known) — a link that began anew is
 * a different situation and deserves a new question.
 */
export interface ProbeFailure {
  attemptedAtMs: number;
  linkSinceMs: number | null;
}

/** @description The remembered failed probe of `runnerName`, `null` if there is none or it was made before `notBeforeMs` (it belongs to an earlier machine of that name, as for {@link readLastProbe}). */
export function readProbeFailure(cacheDir: string, runnerName: string, notBeforeMs: number = 0): ProbeFailure | null {
  try {
    const stored: ProbeFailure = JSON.parse(fs.readFileSync(getProbeFailurePath(cacheDir, runnerName), 'utf8'));
    if (typeof stored.attemptedAtMs !== 'number' || (stored.linkSinceMs !== null && typeof stored.linkSinceMs !== 'number')) return null;
    return stored.attemptedAtMs < notBeforeMs ? null : { attemptedAtMs: stored.attemptedAtMs, linkSinceMs: stored.linkSinceMs };
  } catch {
    return null;
  }
}

/** @description Remember that a probe of `runnerName` got no answer. */
export function writeProbeFailure(cacheDir: string, runnerName: string, failure: ProbeFailure): void {
  fs.writeFileSync(getProbeFailurePath(cacheDir, runnerName), JSON.stringify(failure), { mode: 0o600 });
}

/**
 * @description The last report of runner `runnerName`, `null` if there is none. The file is named by the runner's NAME, and a name outlives
 * the machine: one that was removed hands it on to the next that gets it. A paired runner therefore passes the moment it was paired as
 * `notBeforeMs`, and a report taken before that is not its own and is not read.
 */
export function readLastProbe(cacheDir: string, runnerName: string, notBeforeMs: number = 0): { seenAtMs: number; probe: RunnerProbe } | null {
  try {
    const stored: StoredProbe = JSON.parse(fs.readFileSync(getStoredProbePath(cacheDir, runnerName), 'utf8'));
    if (typeof stored.seenAtMs !== 'number' || typeof stored.text !== 'string') return null;
    if (stored.seenAtMs < notBeforeMs) return null;
    return { seenAtMs: stored.seenAtMs, probe: parseProbeOutput(stored.text) };
  } catch {
    return null;
  }
}

/** @description Forget the last report of `runnerName`, and the failed probe it may have left (a removed runner's: the name is free for the next machine). What is not there is nothing to forget. */
export function removeLastProbe(cacheDir: string, runnerName: string): void {
  fs.rmSync(getStoredProbePath(cacheDir, runnerName), { force: true });
  fs.rmSync(getProbeFailurePath(cacheDir, runnerName), { force: true });
}

function writeLastProbe(cacheDir: string, runnerName: string, text: string, seenAtMs: number): void {
  const stored: StoredProbe = { seenAtMs, text };
  fs.writeFileSync(getStoredProbePath(cacheDir, runnerName), JSON.stringify(stored), { mode: 0o600 });
}

/**
 * @description Probe one runner: its report is `online` with what it said, `lid-closed` (its link is up, its Mac's lid is shut: no probe is made), or
 * `offline` with why and the last snapshot taken when it was seen. `signal` is the deadline of the whole view (see {@link probeRunners}): when it fires the ssh calls in flight are killed and the
 * runner is reported offline — with the snapshot, like any other way of not answering.
 */
export async function probeRunner(client: RunnerClient, nowMs: number = Date.now(), signal?: AbortSignal, deadlineMs: number = probeAllTimeoutMs): Promise<RunnerReport> {
  const runner = client.runner;
  const groupLimits = { ...(runner.groups ?? {}) };
  const isPausedByHub = runner.paired?.isPausedByHub ?? false;
  const offline = (reason: string, linkLastSeenMs: number | null = null): RunnerReport => {
    const last = readLastProbe(client.cacheDir, runner.name, runner.paired?.pairedAtMs);
    return {
      name: runner.name,
      status: 'offline',
      reason: signal?.aborted === true ? `no answer within ${Math.round(deadlineMs / millisecondsPerSecond)} s` : reason,
      // The link's own heartbeat is the better «last seen» of a paired runner: the last probe may be hours older than its last connection.
      lastSeenAtMs: linkLastSeenMs ?? last?.seenAtMs ?? null,
      lastProbe: last?.probe ?? null,
      groupLimits,
      isPausedByHub,
    };
  };
  if (runner.paired !== undefined) {
    // A paired runner is online when its link accepts a connection; asking is cheaper than an ssh call that fails through the proxy.
    const link = await getRunnerLinkStatus(runner.paired.hubDir, runner.paired.runnerId);
    if (!link.isOnline) return offline(notConnectedReason, link.lastSeenMs);
    // A Mac with its lid shut is about to sleep, or has woken for a minute to do its housekeeping: it takes no new job, and is not even asked (the call may hang
    // as the machine falls asleep). Jobs it already runs are not looked at here at all — they are reached by their own id.
    if (link.isLidClosed) {
      const last = readLastProbe(client.cacheDir, runner.name, runner.paired.pairedAtMs);
      return { name: runner.name, status: 'lid-closed', lastSeenAtMs: link.lastSeenMs ?? last?.seenAtMs ?? null, lastProbe: last?.probe ?? null, groupLimits, isPausedByHub };
    }
  }
  try {
    await client.ensureScript(signal);
  } catch (error) {
    if (error instanceof RunnerUnreachableError) return offline(error.reason);
    return offline(error instanceof Error ? error.message : 'could not prepare the runner');
  }
  const result = await client.call('probe', [], { timeoutMs: deadlineMs, signal });
  if (result.exitCode !== 0) return offline(describeSshFailure(result));
  writeLastProbe(client.cacheDir, runner.name, result.stdout, nowMs);
  return { name: runner.name, status: 'online', probe: parseProbeOutput(result.stdout), groupLimits, isPausedByHub };
}

/**
 * @description Probe every client at once under ONE deadline (20 s): a runner that has not answered by then is reported offline with its
 * last snapshot and its ssh calls are killed, so the view ends on time and nothing keeps the process alive afterwards. The others are not
 * held back by it. `stop` ends the same ssh calls from outside — the user interrupted the command that asked.
 */
export async function probeRunners(clients: readonly RunnerClient[], nowMs: number = Date.now(), deadlineMs: number = probeAllTimeoutMs, stop?: AbortSignal): Promise<RunnerReport[]> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), deadlineMs);
  const signal = stop === undefined ? deadline.signal : AbortSignal.any([deadline.signal, stop]);
  try {
    return await Promise.all(clients.map((client) => probeRunner(client, nowMs, signal, deadlineMs)));
  } finally {
    clearTimeout(timer);
  }
}

export type RunnerPick = { ok: true; runnerName: string } | { ok: false; message: string; exitCode: number };

/** The `runners` view of why nothing fits, one block per runner. */
export function formatRunnersView(reports: readonly RunnerReport[]): string {
  return reports.map(formatRunnerBlock).join('\n\n');
}

function checkIsUsable(report: RunnerReport): report is Extract<RunnerReport, { status: 'online' }> {
  return report.status === 'online' && report.probe.pueueVersion !== null && !checkIsRunnerPaused(report);
}

/** Who paused a runner and the way back, for the message of a pick that refused it. */
function describePause(report: RunnerReport): string {
  const probe = report.status === 'online' ? report.probe : report.lastProbe;
  return [
    ...(report.isPausedByHub ? [`from the hub — \`charness runners resume ${report.name}\``] : []),
    ...(probe?.isPaused === true ? ['on the runner — `charness-runner resume` there'] : []),
  ].join(' and ');
}

/** « (paused, so not used: mac)» for the online runners a pick skipped only because they are paused (only those that could have done the job), else nothing. */
function describeSkippedPaused(reports: readonly RunnerReport[], needs: RunnerCapability | null): string {
  const names = reports
    .filter((report): report is Extract<RunnerReport, { status: 'online' }> => report.status === 'online' && report.probe.pueueVersion !== null && checkIsRunnerPaused(report) && (needs === null || checkHasCapability(report.probe, needs)))
    .map((report) => report.name);
  return names.length === 0 ? '' : ` (paused, so not used: ${names.join(', ')})`;
}

/** « (lid closed, so not used: mac)» for the runners whose link is up and whose Mac has the lid shut, when they are all that kept the job from running (only those that could have done it), else nothing. */
function describeSkippedLidClosed(reports: readonly RunnerReport[], needs: RunnerCapability | null): string {
  const names = reports
    .filter((report) => report.status === 'lid-closed' && !checkIsRunnerPaused(report) && (needs === null || (report.lastProbe !== null && checkHasCapability(report.lastProbe, needs))))
    .map((report) => report.name);
  return names.length === 0 ? '' : ` (lid closed, so not used: ${names.join(', ')})`;
}

/**
 * @description The runner a command should use. `wanted.runner` names one (it must exist, answer, have Pueue and not be paused);
 * otherwise the first runner in `config` order that answers, has Pueue, is not paused and — with `wanted.needs` — the capability. None:
 * the reason and the `runners` view, exit 125.
 */
export function pickRunner(config: RunnersConfig, reports: readonly RunnerReport[], wanted: { runner: string | null; needs: RunnerCapability | null }): RunnerPick {
  if (wanted.runner !== null) {
    const report = reports.find((candidate) => candidate.name === wanted.runner);
    if (report === undefined) {
      return { ok: false, exitCode: remoteRunExitCodes.usage, message: `no runner named "${wanted.runner}" (configured: ${config.runners.map((runner) => runner.name).join(', ')})` };
    }
    if (report.status === 'offline') return { ok: false, exitCode: remoteRunExitCodes.failed, message: `runner "${wanted.runner}" is offline (${report.reason})\n${formatRunnersView([report])}` };
    if (report.status === 'lid-closed') return { ok: false, exitCode: remoteRunExitCodes.failed, message: `runner "${wanted.runner}" has its lid closed (${lidClosedNote})\n${formatRunnersView([report])}` };
    if (report.probe.pueueVersion === null) return { ok: false, exitCode: remoteRunExitCodes.failed, message: `runner "${wanted.runner}" has no Pueue (install it there, see docs/remote-run.md)\n${formatRunnersView([report])}` };
    if (checkIsRunnerPaused(report)) return { ok: false, exitCode: remoteRunExitCodes.failed, message: `runner "${wanted.runner}" is paused ${describePause(report)}\n${formatRunnersView([report])}` };
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
  return { ok: false, exitCode: remoteRunExitCodes.failed, message: `${reason}${describeSkippedPaused(reports, wanted.needs)}${describeSkippedLidClosed(reports, wanted.needs)}\n${formatRunnersView(reports)}` };
}

/**
 * @description The runner `exec` goes to. `exec` runs in the runner's copy "as the last job left it", so without `--runner` that is the
 * runner of this project's last job (`lastRunnerName`), not the first one that answers — with several runners the first could hold no copy
 * of the project, or an old one. No job yet: `null` (any online runner); a last runner that left `runners.json`: `null` and a note.
 */
export function chooseExecRunnerName(config: RunnersConfig, named: string | null, lastRunnerName: string | null): { runnerName: string | null; note: string | null } {
  if (named !== null || lastRunnerName === null) return { runnerName: named, note: null };
  if (config.runners.some((runner) => runner.name === lastRunnerName)) return { runnerName: lastRunnerName, note: null };
  return { runnerName: null, note: `the runner of this project's last job, "${lastRunnerName}", is not a configured runner any more (not in runners.json, not paired) — using the first online runner` };
}

/** @description The runner of a job id, from the config: an id of a runner that is no longer listed is an error. */
export function findRunnerOfJob(config: RunnersConfig, runnerName: string): RunnerConfig {
  const runner = config.runners.find((candidate) => candidate.name === runnerName);
  if (runner === undefined) throw new RemoteRunError(`the job belongs to runner "${runnerName}", which is not a configured runner any more (not in runners.json, not paired)`);
  return runner;
}
