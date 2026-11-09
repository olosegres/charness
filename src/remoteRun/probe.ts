import { runnerServiceKinds, type RunnerServiceKind } from '../runners/hubRegistry';
import { serviceKindLabels } from '../runners/runnersList';
import { defaultPueueGroup } from './runnersConfig';

/**
 * @description What a runner says about itself (`runner.sh probe`), parsed, and the short block `remote-run runners` prints for it.
 * The runner prints `key=value` lines; an unknown key is ignored (a newer runner script, an older main box) and a missing one is
 * "unknown", never a guess.
 */

export const runnerCapabilities = ['android', 'ios', 'docker', 'playwright'] as const;
export type RunnerCapability = (typeof runnerCapabilities)[number];

/** @name CapabilityReport @description One capability: whether the runner can do it and, in plain words, how / why not. */
export interface CapabilityReport {
  isAvailable: boolean;
  detail: string;
}

/** What the runner's own iOS Simulator boot check found (`ios-check.json`, written by the runner utility's service): it booted one, it could not, or nothing has run the check. */
export const iosBootStatuses = ['ok', 'failed', 'unchecked'] as const;
export type IosBootStatus = (typeof iosBootStatuses)[number];

/** @name RunnerProbe @description The facts of one probe. Numbers are `null` when the runner did not report them. */
export interface RunnerProbe {
  os: string;
  osName: string;
  osVersion: string;
  kernel: string;
  arch: string;
  cpuModel: string;
  cpuCores: number | null;
  cpuThreads: number | null;
  load: number | null;
  ramTotalMb: number | null;
  ramFreeMb: number | null;
  diskFreeMb: number | null;
  /** The free space the runner wants kept on its work disk (the smaller of 60 GB and 15 % of the disk, or its config's number); `null` when the runner did not say, `0` when it wants none. */
  diskMinFreeMb: number | null;
  /**
   * The project copies on the runner: how many, how much they take as last measured (measuring runs detached, so `unmeasuredCount` copies have no fresh figure yet), and how many of them share disk blocks with another (a copy
   * seeded from a sibling is a clone: `du` counts what clones share in full, so `sizeMb` is more than the disk holds when `clonedCount` is not 0); `null` when the runner did not say.
   */
  copies: { count: number; sizeMb: number; unmeasuredCount: number; clonedCount: number } | null;
  /** The Pueue version, `null` when Pueue is missing on the runner. */
  pueueVersion: string | null;
  jobsRunning: number;
  jobsQueued: number;
  jobsProjects: number;
  capabilities: Record<RunnerCapability, CapabilityReport>;
  /** Paused on the runner itself (`charness-runner pause`): no job is sent to it while it is. */
  isPaused: boolean;
  /** How the runner utility is kept running; `null` for a hand-made runner (and for an older script that did not say). */
  serviceKind: RunnerServiceKind | null;
  /** The charness version a paired runner runs; `null` for a hand-made one. */
  runnerVersion: string | null;
  /** The runner's iOS Simulator boot check; `null` when the runner did not report one. */
  iosBoot: { status: IosBootStatus; detail: string } | null;
  /**
   * How the runner's link keeps its machine awake (`runnerUtility/keepAwake.ts`): by `caffeinate` / `systemd-inhibit`, or not (`method: null`, and why).
   * `null` when the runner did not say (a hand-made one, a link of an older version).
   */
  keepsAwake: { method: KeepAwakeMethod } | { method: null; reason: string } | null;
  /**
   * The Node and yarn a job runs with (`--version` under the probe's own PATH, which is a job's): a version, `none` (not on the PATH: a job that calls
   * it ends with exit 127) or `unknown` (there, but no answer in time). `null` when the runner's script did not report them (an older one).
   */
  jobTools: { node: string; yarn: string } | null;
  /**
   * The Simulator runtimes of this Mac that have a NEWER one of the same platform and major (`iOS 26.4` while `iOS 26.5` is installed), with the devices each still has: information for the operator (they take disk;
   * removing them is Xcode's Settings ▸ Platforms, never remote-run's). Empty = none, or the runner did not say (not a Mac, an older script).
   */
  olderSimulators: Array<{ runtime: string; deviceCount: number }>;
}

const megabytesPerGigabyte = 1024;

function readNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export const jobToolNone = 'none';
export const jobToolUnknown = 'unknown';

/** One entry of the runner's `sim_older_runtimes=iOS 26.4:11,watchOS 11.0:2`: a platform, a version, a device count — anything else (it comes from the runner machine) is dropped. */
const olderSimulatorPattern = /^([A-Za-z]{2,12} [0-9]+(?:\.[0-9]+){0,2}):([0-9]{1,5})$/;

function parseOlderSimulators(fields: ReadonlyMap<string, string>): RunnerProbe['olderSimulators'] {
  const entries: RunnerProbe['olderSimulators'] = [];
  for (const item of (fields.get('sim_older_runtimes') ?? '').split(',')) {
    const match = olderSimulatorPattern.exec(item.trim());
    if (match !== null) entries.push({ runtime: match[1], deviceCount: Number(match[2]) });
  }
  return entries;
}

function parseJobTools(fields: ReadonlyMap<string, string>): RunnerProbe['jobTools'] {
  const node = fields.get('job_node');
  const yarn = fields.get('job_yarn');
  return node === undefined || yarn === undefined || node === '' || yarn === '' ? null : { node, yarn };
}

function parseCopies(fields: ReadonlyMap<string, string>): RunnerProbe['copies'] {
  const count = readNumber(fields.get('copies_count'));
  const sizeMb = readNumber(fields.get('copies_size_mb'));
  if (count === null || sizeMb === null) return null;
  return { count, sizeMb, unmeasuredCount: readNumber(fields.get('copies_unmeasured')) ?? 0, clonedCount: readNumber(fields.get('copies_cloned')) ?? 0 };
}

export type KeepAwakeMethod = 'caffeinate' | 'systemd-inhibit';
/**
 * How long one sleep-assertion holder of a runner's link lasts on its own (`runnerUtility/keepAwake.ts`): the longest a restart of the link may take without the machine
 * being left with no assertion, and the longest a holder outlives a link that was killed. Here because `runners` and the link's own words say it.
 */
export const keepAwakeHoldSeconds = 5 * 60;
const keepAwakeMethods: readonly KeepAwakeMethod[] = ['caffeinate', 'systemd-inhibit'];

/** @description What a method is, in the words every place that says how a machine is kept awake uses (the link's own start line, `runners`): the command, and that a closed lid still sleeps it. */
export function describeKeepAwakeMethod(method: KeepAwakeMethod): string {
  return `${method === 'caffeinate' ? 'caffeinate -i' : 'systemd-inhibit --what=idle'}; a closed lid still sleeps it`;
}

function parseKeepsAwake(fields: ReadonlyMap<string, string>): RunnerProbe['keepsAwake'] {
  const awake = fields.get('awake');
  const method = keepAwakeMethods.find((candidate) => candidate === awake);
  if (method !== undefined) return { method };
  return awake === 'no' ? { method: null, reason: fields.get('awake_detail') ?? '' } : null;
}

/** @description Parse the `key=value` lines of `runner.sh probe`. */
export function parseProbeOutput(text: string): RunnerProbe {
  const fields = new Map<string, string>();
  for (const line of text.split('\n')) {
    const separator = line.indexOf('=');
    if (separator > 0) fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const readCapability = (name: RunnerCapability): CapabilityReport => ({
    isAvailable: fields.get(`cap_${name}`) === 'yes',
    detail: fields.get(`cap_${name}_detail`) ?? '',
  });
  const pueue = fields.get('pueue');
  const iosBootStatus = iosBootStatuses.find((status) => status === fields.get('ios_boot'));
  return {
    os: fields.get('os') ?? '',
    osName: fields.get('os_name') ?? fields.get('os') ?? '',
    osVersion: fields.get('os_version') ?? '',
    kernel: fields.get('kernel') ?? '',
    arch: fields.get('arch') ?? '',
    cpuModel: fields.get('cpu_model') ?? '',
    cpuCores: readNumber(fields.get('cpu_cores')),
    cpuThreads: readNumber(fields.get('cpu_threads')),
    load: readNumber(fields.get('load')),
    ramTotalMb: readNumber(fields.get('ram_total_mb')),
    ramFreeMb: readNumber(fields.get('ram_free_mb')),
    diskFreeMb: readNumber(fields.get('disk_free_mb')),
    diskMinFreeMb: readNumber(fields.get('disk_min_free_mb')),
    copies: parseCopies(fields),
    pueueVersion: pueue === undefined || pueue === 'missing' || pueue === '' ? null : pueue,
    jobsRunning: readNumber(fields.get('jobs_running')) ?? 0,
    jobsQueued: readNumber(fields.get('jobs_queued')) ?? 0,
    jobsProjects: readNumber(fields.get('jobs_projects')) ?? 0,
    capabilities: {
      android: readCapability('android'),
      ios: readCapability('ios'),
      docker: readCapability('docker'),
      playwright: readCapability('playwright'),
    },
    isPaused: fields.get('paused') === 'yes',
    serviceKind: runnerServiceKinds.find((kind) => kind === fields.get('service')) ?? null,
    runnerVersion: fields.get('runner_version') || null,
    iosBoot: iosBootStatus === undefined ? null : { status: iosBootStatus, detail: fields.get('ios_boot_detail') ?? '' },
    jobTools: parseJobTools(fields),
    olderSimulators: parseOlderSimulators(fields),
    keepsAwake: parseKeepsAwake(fields),
  };
}

/** @description Does the probed runner have `capability`? */
export function checkHasCapability(probe: RunnerProbe, capability: RunnerCapability): boolean {
  return probe.capabilities[capability].isAvailable;
}

export function formatGigabytes(megabytes: number | null): string {
  if (megabytes === null) return '?';
  const gigabytes = megabytes / megabytesPerGigabyte;
  return `${gigabytes >= 10 ? Math.round(gigabytes) : Math.round(gigabytes * 10) / 10} GB`;
}

/** `Ubuntu 24.04 (Linux 6.8, x86_64)` — the kernel trimmed to major.minor; the kernel's own name is left out when it is the system's name too. */
function formatSystem(probe: RunnerProbe): string {
  const kernel = probe.kernel.split('.').slice(0, 2).join('.');
  const system = [probe.osName, probe.osVersion].filter((part) => part !== '').join(' ');
  const kernelLabel = probe.osName === probe.os ? kernel : [probe.os, kernel].filter((part) => part !== '').join(' ');
  const details = [kernelLabel, probe.arch].filter((part) => part !== '').join(', ');
  return details === '' ? system : `${system} (${details})`;
}

function formatCpu(probe: RunnerProbe): string {
  const model = probe.cpuModel === '' ? 'CPU' : `CPU ${probe.cpuModel}`;
  const shape = probe.cpuCores === null ? '' : `, ${probe.cpuCores} cores / ${probe.cpuThreads ?? '?'} threads`;
  const load = probe.load === null ? '' : `, load ${probe.load}`;
  return `${model}${shape}${load}`;
}

/** The `can:` parts in plain words: what the runner can do first (`android (KVM, emulator)`), then what it cannot with why (`ios: no (Linux)`). */
function formatCapabilities(probe: RunnerProbe): string[] {
  const available: string[] = [];
  const unavailable: string[] = [];
  for (const name of runnerCapabilities) {
    const report = probe.capabilities[name];
    if (report.isAvailable) available.push(report.detail === '' ? name : `${name} (${report.detail})`);
    else unavailable.push(`${name}: no${report.detail === '' ? '' : ` (${report.detail})`}`);
  }
  return [...available, ...unavailable];
}

/** `jobs run with: Node v24.22.2 · yarn 1.22.22` — a changed Node shows here; a tool that is not there is said loudly, as the thing that makes a job end with exit 127. */
function formatJobTools(probe: RunnerProbe): string[] {
  if (probe.jobTools === null) return [];
  const describe = (name: string, version: string): string => {
    if (version === jobToolNone) return `${name}: NONE (a job that calls it ends with exit 127 — see docs/remote-run.md)`;
    if (version === jobToolUnknown) return `${name}: present, no answer in time`;
    return `${name} ${version}`;
  };
  return [`  jobs run with: ${describe('Node', probe.jobTools.node)} · ${describe('yarn', probe.jobTools.yarn)}`];
}

/**
 * @description `iOS 26.4 (11), watchOS 11.0 (2)` — the older Simulator runtimes of a Mac with their device counts, for the line under the capabilities (the bot's `/runners` puts the same list in its own words).
 * Empty when there are none.
 */
export function formatOlderSimulators(probe: RunnerProbe): string {
  return probe.olderSimulators.map((entry) => `${entry.runtime} (${entry.deviceCount})`).join(', ');
}

/** `simulators of older runtimes (devices in brackets; remote-run removes nothing of them): iOS 26.4 (11)` — only information: they take disk, and Xcode's Settings ▸ Platforms is where a runtime is removed. */
function formatOlderSimulatorsLine(probe: RunnerProbe): string[] {
  if (probe.olderSimulators.length === 0) return [];
  return [`  simulators of older runtimes (devices in brackets; remote-run removes nothing of them): ${formatOlderSimulators(probe)}`];
}

/** What `runners` adds to «it kept the machine awake» of a runner that does not answer: an assertion cannot wake a machine that sleeps (shared with the bot's `/runners`, localized: `runners.offlineKeptAwakeNote`). */
const asleepNote = 'if it is asleep now, nothing can wake it from here: a key press or opening the lid does';

/**
 * `keeps awake: yes (caffeinate -i)` — or `NO` with why: a Mac that sleeps under a job drops the link (the thing `runners` is there to show). Nothing when the runner did not say. For a runner that is
 * `offline` the line is what it said WHEN LAST SEEN, and says so: a runner that claims to keep its machine awake and does not answer is most likely asleep (a lid closed, a sleep that began anyway), and no
 * assertion wakes a sleeping machine — a «yes» there would read as «it will be back by itself».
 */
function formatKeepsAwake(probe: RunnerProbe, isLastSeen: boolean): string[] {
  if (probe.keepsAwake === null) return [];
  if (probe.keepsAwake.method === null) return [`  keeps awake: NO${probe.keepsAwake.reason === '' ? '' : ` — ${probe.keepsAwake.reason}`} (the machine may sleep when idle)`];
  if (isLastSeen) return [`  keeps awake: it did when last seen (${describeKeepAwakeMethod(probe.keepsAwake.method)}) — ${asleepNote}`];
  return [`  keeps awake: yes (${describeKeepAwakeMethod(probe.keepsAwake.method)})`];
}

/** @description Is the work disk under what the runner wants kept free (it frees itself by removing unused project copies, and refuses a job it cannot make room for)? Not when it wants none (`0`) or did not say. */
export function checkIsDiskLow(probe: RunnerProbe): boolean {
  return probe.diskFreeMb !== null && probe.diskMinFreeMb !== null && probe.diskMinFreeMb > 0 && probe.diskFreeMb < probe.diskMinFreeMb;
}

/** ` — LOW, the runner wants 60 GB kept free` (the bot's `/runners` says the same, localized: `runners.diskLowNote`). */
function formatLowDisk(probe: RunnerProbe): string {
  if (!checkIsDiskLow(probe) || probe.diskMinFreeMb === null) return '';
  return ` — LOW, the runner wants ${formatGigabytes(probe.diskMinFreeMb)} kept free`;
}

/** ` · 16 project copies, 290 GB` (the size as last measured, "so far" while a figure is still being measured, «clones counted in full» when some copy shares disk blocks with another: the bot's `/runners` says the same, localized: `runners.copiesWithClonesLine`); nothing while there is no copy. */
function formatCopies(probe: RunnerProbe): string {
  if (probe.copies === null || probe.copies.count === 0) return '';
  const { count, sizeMb, unmeasuredCount, clonedCount } = probe.copies;
  return ` · ${count} project ${count === 1 ? 'copy' : 'copies'}, ${formatGigabytes(sizeMb)}${unmeasuredCount > 0 ? ' so far (measuring)' : ''}${clonedCount > 0 ? ', clones counted in full' : ''}`;
}

/** The line of a paired runner under its capabilities: the charness it runs and how it is kept running. Nothing for a hand-made one. */
function formatRunnerProgram(probe: RunnerProbe): string[] {
  const parts = [
    ...(probe.runnerVersion === null ? [] : [`charness-runner ${probe.runnerVersion}`]),
    ...(probe.serviceKind === null ? [] : [serviceKindLabels[probe.serviceKind]]),
  ];
  return parts.length === 0 ? [] : [`  ${parts.join(' · ')}`];
}

/**
 * @description The lines under a runner's heading: hardware, jobs and groups, capabilities, and for a paired runner its program and service. `isLastSeen`: the probe is what an offline runner said when it was last
 * seen, not a live answer — the one line that would over-promise then (it keeps its machine awake) says so.
 */
export function formatRunnerDetails(probe: RunnerProbe, groupLimits: Readonly<Record<string, number>>, isLastSeen: boolean = false): string[] {
  const limits = Object.entries(groupLimits);
  // A runner whose only group is the default one (every paired runner) is told as «jobs at once»: that is what the one number means to the operator.
  const groups = limits.length === 1 && limits[0][0] === defaultPueueGroup ? `jobs at once: ${limits[0][1]}` : limits.length === 0 ? '' : `groups: ${limits.map(([groupName, parallel]) => `${groupName} ${parallel}`).join(', ')}`;
  const jobs = `jobs: ${probe.jobsRunning} running, ${probe.jobsQueued} queued, ${probe.jobsProjects} ${probe.jobsProjects === 1 ? 'project' : 'projects'}`;
  return [
    `  ${formatCpu(probe)} · RAM ${formatGigabytes(probe.ramTotalMb)}, ${formatGigabytes(probe.ramFreeMb)} free · disk ${formatGigabytes(probe.diskFreeMb)} free (work dir)${formatLowDisk(probe)}${formatCopies(probe)}`,
    `  ${jobs}${groups === '' ? '' : ` · ${groups}`}${probe.pueueVersion === null ? ' · Pueue: MISSING (install it, see docs/remote-run.md)' : ''}`,
    `  can: ${formatCapabilities(probe).join(' · ')}`,
    ...formatOlderSimulatorsLine(probe),
    ...formatJobTools(probe),
    ...formatKeepsAwake(probe, isLastSeen),
    ...formatRunnerProgram(probe),
  ];
}

/**
 * Why a runner whose link is up takes no new job: its Mac has the lid closed with nothing keeping it awake (no external display), so it is about to sleep —
 * and wakes for a minute or two every so often on power, in which a job would start and be cut (`runnerUtility/lidState.ts`).
 */
export const lidClosedNote = 'takes no new jobs until its lid is opened (a job already running there goes on)';

/** What says a busy runner is THERE: its link is up (a paired runner), or its ssh answered the check of its script (a hand-made one, which has no link). */
export type BusyEvidence = 'link' | 'ssh';

/**
 * @name RunnerReport @description What `runners` knows of one runner after probing: live; or — its link is up, but the Mac's lid is closed (`lid-closed`: the runner
 * is asked nothing, it may be falling asleep) — or `busy` (it is THERE — its link is up, or its ssh answered — but its probe did not finish in time: a Mac with load 129 under a job; the last snapshot,
 * with why) — or offline: the last snapshot, with why. A `lid-closed` or `offline` runner takes no new job; a `busy` one takes one as its last snapshot allows (a job in flight must never make the host think
 * the runner is gone).
 */
export type RunnerReport =
  | { name: string; status: 'online'; probe: RunnerProbe; groupLimits: Record<string, number>; isPausedByHub: boolean }
  | { name: string; status: 'busy'; evidence: BusyEvidence; reason: string; lastSeenAtMs: number | null; lastProbe: RunnerProbe | null; groupLimits: Record<string, number>; isPausedByHub: boolean }
  | { name: string; status: 'lid-closed'; lastSeenAtMs: number | null; lastProbe: RunnerProbe | null; groupLimits: Record<string, number>; isPausedByHub: boolean }
  | { name: string; status: 'offline'; reason: string; lastSeenAtMs: number | null; lastProbe: RunnerProbe | null; groupLimits: Record<string, number>; isPausedByHub: boolean };

/** @description Is the runner held back from new jobs — paused from the hub, or on the runner itself (what it said when it was last seen counts too)? */
export function checkIsRunnerPaused(report: RunnerReport): boolean {
  if (report.isPausedByHub) return true;
  const probe = report.status === 'online' ? report.probe : report.lastProbe;
  return probe?.isPaused === true;
}

/** `paused from the hub` / `paused on the runner`, for the heading. */
function formatPauseTags(report: RunnerReport): string[] {
  const probe = report.status === 'online' ? report.probe : report.lastProbe;
  return [...(report.isPausedByHub ? ['paused from the hub'] : []), ...(probe?.isPaused === true ? ['paused on the runner'] : [])];
}

/** @description `2026-10-30 14:02 UTC` */
export function formatLastSeen(timestampMs: number): string {
  return `${new Date(timestampMs).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** @description The block `remote-run runners` prints for one runner. An offline one, and one whose lid is closed, show their last snapshot, marked as old. */
export function formatRunnerBlock(report: RunnerReport): string {
  const pauseTags = formatPauseTags(report).map((tag) => ` · ${tag}`).join('');
  if (report.status === 'online') {
    return [`${report.name} — online${pauseTags} · ${formatSystem(report.probe)}`, ...formatRunnerDetails(report.probe, report.groupLimits)].join('\n');
  }
  if (report.status === 'lid-closed') {
    const heading = `${report.name} — lid closed${pauseTags} · ${lidClosedNote}`;
    if (report.lastProbe === null) return heading;
    return [`${heading} — as last probed: ${formatSystem(report.lastProbe)}`, ...formatRunnerDetails(report.lastProbe, report.groupLimits)].join('\n');
  }
  if (report.status === 'busy') {
    // The runner is there: «offline» would make a job's next submit wait for, or refuse, a machine that is merely busy.
    const heading = `${report.name} — online, busy${pauseTags} · ${report.reason}; ${report.evidence === 'link' ? 'it is linked' : 'its ssh answered'}, so it is not offline`;
    if (report.lastProbe === null) return `${heading} · never probed`;
    const probedAt = report.lastSeenAtMs === null ? '' : ` ${formatLastSeen(report.lastSeenAtMs)}`;
    return [`${heading} · details as last probed${probedAt}: ${formatSystem(report.lastProbe)}`, ...formatRunnerDetails(report.lastProbe, report.groupLimits)].join('\n');
  }
  const lastSeen = report.lastSeenAtMs === null ? 'never seen' : `last seen ${formatLastSeen(report.lastSeenAtMs)}`;
  if (report.lastProbe === null) return `${report.name} — offline (${report.reason})${pauseTags} · ${lastSeen}`;
  return [
    `${report.name} — offline (${report.reason})${pauseTags} · ${lastSeen} — as it was then: ${formatSystem(report.lastProbe)}`,
    ...formatRunnerDetails(report.lastProbe, report.groupLimits, true),
  ].join('\n');
}
