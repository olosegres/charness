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
import { probeAllTimeoutMs } from './probeTiming';
import { checkIsSshTimeout, describeSshFailure, notConnectedReason, type RunnerClient } from './runnerClient';
import type { RunnerConfig, RunnersConfig } from './runnersConfig';
import { sshFailureExitCode } from './ssh';

/**
 * @description Which runners exist right now: probe them (in parallel, bounded), remember each one's last answer so an offline runner
 * still shows what it was, and pick the one a command should use — the named one, or the first in the catalog (`runners.json` entries,
 * then the paired runners) that answers, is not paused and, with `--needs`, has the capability.
 */

/**
 * @name ProbeOptions
 * @description `isPruneAllowed`: the probe is a VIEW of the runners (`remote-run runners`, the bot's `/runners`) and may start the runner's background prune when its disk is short. The probe that picks a runner
 * for a run or an `exec` never does (the default): that prune has no copy to keep, and the project about to be used is typically the least recently used one — the very copy it would take before the job's own
 * `prepare`, which keeps its slug, arrives.
 */
export interface ProbeOptions {
  isPruneAllowed?: boolean;
  /**
   * Has the shared deadline of the view fired? Set by {@link probeRunners}: only the DEADLINE makes a runner `busy` (it ran out of time), never the user's own stop (`stop`) — a view they interrupted
   * has no use for a report. Absent (a single probe called by hand), the signal's own state is what is asked.
   */
  hasDeadlinePassed?: () => boolean;
}

/** The word that lets `runner.sh probe` start the background prune of a short disk (see {@link ProbeOptions}). */
const probePruneArgument = 'prune';
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

/** Why a Mac with its lid shut is not called (a shared wording: `clean` says it, the probe\'s `lid-closed` report is the same fact). */
export const lidClosedReason = 'its Mac has the lid closed';

/**
 * @name RunnerReachability
 * @description Whether a runner can be called at all right now: `offline` (a paired one whose link is down, or one whose script cannot be looked for over ssh: `reason` is the short cause), `lid-closed` (its link is up but its
 * Mac\'s lid is shut: it may be falling asleep, so it is not called), `broken` (its script could not be put there for a reason that is not a lost connection) — or `reachable`, with the script in place.
 * `isLinkUp` (of `offline`): a paired runner whose link was up when it was asked — it is THERE, so an ssh call of it that got no answer in time says «slow», not «gone»; `isSshTimeout`: that call failed because
 * ssh itself ran out of patience (`checkIsSshTimeout`: its own connect / banner timeout, which is shorter than the view's deadline), not because the connection was refused or dropped.
 */
export type RunnerReachability =
  | { kind: 'reachable' }
  | { kind: 'offline'; reason: string; lastSeenMs: number | null; isLinkUp: boolean; isSshTimeout: boolean }
  | { kind: 'lid-closed'; lastSeenMs: number | null }
  | { kind: 'broken'; message: string };

/**
 * @description The gate before any call to a runner (the probe, `clean`): a paired runner is asked at its link first (cheaper than an ssh call that fails through the proxy, and a Mac with its lid shut is not asked at all), then
 * the script is looked for — and put there when missing. `signal` ends that ssh call from outside (a shared deadline).
 */
export async function checkRunnerReachability(client: RunnerClient, signal?: AbortSignal): Promise<RunnerReachability> {
  const paired = client.runner.paired;
  if (paired !== undefined) {
    const link = await getRunnerLinkStatus(paired.hubDir, paired.runnerId);
    if (!link.isOnline) return { kind: 'offline', reason: notConnectedReason, lastSeenMs: link.lastSeenMs, isLinkUp: false, isSshTimeout: false };
    if (link.isLidClosed) return { kind: 'lid-closed', lastSeenMs: link.lastSeenMs };
  }
  try {
    await client.ensureScript(signal);
  } catch (error) {
    if (error instanceof RunnerUnreachableError) return { kind: 'offline', reason: error.reason, lastSeenMs: null, isLinkUp: paired !== undefined, isSshTimeout: checkIsSshTimeout(error.reason) };
    return { kind: 'broken', message: error instanceof Error ? error.message : 'could not prepare the runner' };
  }
  return { kind: 'reachable' };
}

/**
 * @description Probe one runner: its report is `online` with what it said, `lid-closed` (its link is up, its Mac's lid is shut: no probe is made), `busy` (it is there — linked, or its ssh answered —
 * but the probe did not finish in time: the last snapshot is shown, marked as old), or `offline` with why and the last snapshot taken when it was seen. `signal` is the deadline of the whole view (see {@link probeRunners}): when it fires the ssh calls in flight are killed and the
 * runner is reported `busy` when it was known to be there (see `probeRunner`) and offline otherwise — with the snapshot, like any other way of not answering.
 */
export async function probeRunner(client: RunnerClient, nowMs: number = Date.now(), signal?: AbortSignal, deadlineMs: number = probeAllTimeoutMs, options: ProbeOptions = {}): Promise<RunnerReport> {
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
  // A runner that is THERE but did not finish its probe in time is busy, never offline: its link is up (the gate's ssh keepalive was answered within the last minute), or its ssh answered the check of its script. A Mac under
  // iOS Simulators with load 129 once read «offline (no answer within 20 s)» while it ran a job — and a runner that reads offline is waited for or refused by the next submit.
  const hasDeadlinePassed = (): boolean => options.hasDeadlinePassed?.() ?? signal?.aborted === true;
  const busy = (stage: string): RunnerReport => {
    const last = readLastProbe(client.cacheDir, runner.name, runner.paired?.pairedAtMs);
    return {
      name: runner.name,
      status: 'busy',
      evidence: runner.paired === undefined ? 'ssh' : 'link',
      reason: `no answer within ${Math.round(deadlineMs / millisecondsPerSecond)} s (${stage})`,
      lastSeenAtMs: last?.seenAtMs ?? null,
      lastProbe: last?.probe ?? null,
      groupLimits,
      isPausedByHub,
    };
  };
  // A paired runner is online when its link accepts a connection; asking is cheaper than an ssh call that fails through the proxy. A Mac with its lid shut is about to sleep, or has woken for a minute to do its
  // housekeeping: it takes no new job, and is not even asked (the call may hang as the machine falls asleep). Jobs it already runs are not looked at here at all — they are reached by their own id.
  const reachability = await checkRunnerReachability(client, signal);
  // Its link is up and the call got no answer — the view's deadline fired, or ssh gave up on its own before it (its 15 s connect timeout is shorter than the deadline, and on a paired runner the ssh server is the link's own Node,
  // whose handshake is what a loaded machine is slow at): busy. A refused or dropped connection is the runner gone.
  if (reachability.kind === 'offline' && reachability.isLinkUp && (hasDeadlinePassed() || reachability.isSshTimeout)) return busy('its first call, the check of its script, was not answered');
  if (reachability.kind === 'offline') return offline(reachability.reason, reachability.lastSeenMs);
  // The script was NOT there and its upload was cut off by the deadline (the first probe after every update has to upload the new one): ssh answered the check, so the runner is there.
  if (reachability.kind === 'broken' && hasDeadlinePassed()) return busy('the upload of its script did not finish');
  if (reachability.kind === 'broken') return offline(reachability.message);
  if (reachability.kind === 'lid-closed') {
    const last = readLastProbe(client.cacheDir, runner.name, runner.paired?.pairedAtMs);
    return { name: runner.name, status: 'lid-closed', lastSeenAtMs: reachability.lastSeenMs ?? last?.seenAtMs ?? null, lastProbe: last?.probe ?? null, groupLimits, isPausedByHub };
  }
  const result = await client.call('probe', options.isPruneAllowed === true ? [probePruneArgument] : [], { timeoutMs: deadlineMs, signal });
  // The script was found a moment ago, so the runner answers ssh: a probe that ran out of time is a runner that is busy. Any other failure (the connection dropped) is the runner gone.
  // `isTimedOut` also says «cut off from outside» (the user's stop ends the call the same way), so inside a view only the shared deadline counts; a probe called by hand has no other clock than the call's own.
  // ssh's OWN timeout only: the stderr of a probe also holds what the runner script and the tools it calls print (`pueue`, `xcrun`), and a probe that failed by itself with a «timed out» line of theirs is a failed probe.
  const isOutOfTime = hasDeadlinePassed() || (options.hasDeadlinePassed === undefined && result.isTimedOut) || (result.exitCode === sshFailureExitCode && checkIsSshTimeout(result.stderr));
  if (result.exitCode !== 0 && isOutOfTime) return busy('its probe did not finish');
  if (result.exitCode !== 0) return offline(describeSshFailure(result));
  writeLastProbe(client.cacheDir, runner.name, result.stdout, nowMs);
  return { name: runner.name, status: 'online', probe: parseProbeOutput(result.stdout), groupLimits, isPausedByHub };
}

/**
 * @description Probe every client at once under ONE deadline (20 s): a runner that has not answered by then is reported offline with its
 * last snapshot and its ssh calls are killed, so the view ends on time and nothing keeps the process alive afterwards. The others are not
 * held back by it. `stop` ends the same ssh calls from outside — the user interrupted the command that asked.
 */
export async function probeRunners(clients: readonly RunnerClient[], nowMs: number = Date.now(), deadlineMs: number = probeAllTimeoutMs, stop?: AbortSignal, options: ProbeOptions = {}): Promise<RunnerReport[]> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), deadlineMs);
  const signal = stop === undefined ? deadline.signal : AbortSignal.any([deadline.signal, stop]);
  try {
    return await Promise.all(clients.map((client) => probeRunner(client, nowMs, signal, deadlineMs, { ...options, hasDeadlinePassed: () => deadline.signal.aborted })));
  } finally {
    clearTimeout(timer);
  }
}

export type RunnerPick = { ok: true; runnerName: string } | { ok: false; message: string; exitCode: number };

/** The `runners` view of why nothing fits, one block per runner. */
export function formatRunnersView(reports: readonly RunnerReport[]): string {
  return reports.map(formatRunnerBlock).join('\n\n');
}

/** What is known of a runner for choosing it: what it said just now, or — it is busy, its probe did not finish — what it said when last probed (`null` = never). */
function getProbeForPick(report: RunnerReport): RunnerProbe | null {
  if (report.status === 'online') return report.probe;
  return report.status === 'busy' ? report.lastProbe : null;
}

/** Is the runner there (online, or busy) with Pueue and nobody having paused it — as far as its (last) probe says? A busy one never probed has nothing to say: it is not picked for lack of it, but it is not offline. */
function checkIsUsable(report: RunnerReport): boolean {
  const probe = getProbeForPick(report);
  return probe !== null && probe.pueueVersion !== null && !checkIsRunnerPaused(report);
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
    .filter((report) => {
      const probe = getProbeForPick(report);
      return probe !== null && probe.pueueVersion !== null && checkIsRunnerPaused(report) && (needs === null || checkHasCapability(probe, needs));
    })
    .map((report) => report.name);
  return names.length === 0 ? '' : ` (paused, so not used: ${names.join(', ')})`;
}

/** « (busy and never probed, so not used: mac)» for the busy runners nothing is known of: they are there, but cannot be judged fit for the job — said, so the view below is not read as «offline». */
function describeSkippedBusy(reports: readonly RunnerReport[]): string {
  const names = reports.filter((report) => report.status === 'busy' && report.lastProbe === null && !checkIsRunnerPaused(report)).map((report) => report.name);
  return names.length === 0 ? '' : ` (busy and never probed, so not used: ${names.join(', ')})`;
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
    // A busy runner is judged by what it said when last probed; one never probed is taken as named (it is there, and the calls after this say what they find) unless a capability is wanted of it.
    const probe = getProbeForPick(report);
    if (probe !== null && probe.pueueVersion === null) return { ok: false, exitCode: remoteRunExitCodes.failed, message: `runner "${wanted.runner}" has no Pueue (install it there, see docs/remote-run.md)\n${formatRunnersView([report])}` };
    if (checkIsRunnerPaused(report)) return { ok: false, exitCode: remoteRunExitCodes.failed, message: `runner "${wanted.runner}" is paused ${describePause(report)}\n${formatRunnersView([report])}` };
    if (wanted.needs !== null && probe === null) {
      return { ok: false, exitCode: remoteRunExitCodes.failed, message: `runner "${wanted.runner}" is busy and was never probed, so it cannot be told to do "${wanted.needs}" — try again in a moment\n${formatRunnersView([report])}` };
    }
    if (wanted.needs !== null && probe !== null && !checkHasCapability(probe, wanted.needs)) {
      return { ok: false, exitCode: remoteRunExitCodes.failed, message: `runner "${wanted.runner}" cannot do "${wanted.needs}"\n${formatRunnersView([report])}` };
    }
    return { ok: true, runnerName: report.name };
  }
  for (const runner of config.runners) {
    const report = reports.find((candidate) => candidate.name === runner.name);
    if (report === undefined || !checkIsUsable(report)) continue;
    const probe = getProbeForPick(report);
    if (probe !== null && (wanted.needs === null || checkHasCapability(probe, wanted.needs))) return { ok: true, runnerName: runner.name };
  }
  const reason = wanted.needs === null ? 'no runner is online' : `no online runner can do "${wanted.needs}"`;
  return { ok: false, exitCode: remoteRunExitCodes.failed, message: `${reason}${describeSkippedPaused(reports, wanted.needs)}${describeSkippedBusy(reports)}${describeSkippedLidClosed(reports, wanted.needs)}\n${formatRunnersView(reports)}` };
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
