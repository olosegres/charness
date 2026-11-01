import { runnerServiceKinds, type RunnerServiceKind } from '../runners/hubRegistry';
import { serviceKindLabels } from '../runners/runnersList';

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
}

const megabytesPerGigabyte = 1024;

function readNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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

/** The line of a paired runner under its capabilities: the charness it runs and how it is kept running. Nothing for a hand-made one. */
function formatRunnerProgram(probe: RunnerProbe): string[] {
  const parts = [
    ...(probe.runnerVersion === null ? [] : [`charness-runner ${probe.runnerVersion}`]),
    ...(probe.serviceKind === null ? [] : [serviceKindLabels[probe.serviceKind]]),
  ];
  return parts.length === 0 ? [] : [`  ${parts.join(' · ')}`];
}

/** @description The lines under a runner's heading: hardware, jobs and groups, capabilities, and for a paired runner its program and service. */
export function formatRunnerDetails(probe: RunnerProbe, groupLimits: Readonly<Record<string, number>>): string[] {
  const groups = Object.entries(groupLimits).map(([groupName, parallel]) => `${groupName} ${parallel}`).join(', ');
  const jobs = `jobs: ${probe.jobsRunning} running, ${probe.jobsQueued} queued, ${probe.jobsProjects} ${probe.jobsProjects === 1 ? 'project' : 'projects'}`;
  return [
    `  ${formatCpu(probe)} · RAM ${formatGigabytes(probe.ramTotalMb)}, ${formatGigabytes(probe.ramFreeMb)} free · disk ${formatGigabytes(probe.diskFreeMb)} free (work dir)`,
    `  ${jobs}${groups === '' ? '' : ` · groups: ${groups}`}${probe.pueueVersion === null ? ' · Pueue: MISSING (install it, see docs/remote-run.md)' : ''}`,
    `  can: ${formatCapabilities(probe).join(' · ')}`,
    ...formatRunnerProgram(probe),
  ];
}

/** @name RunnerReport @description What `runners` knows of one runner after probing: live, or the last snapshot with why it is offline. */
export type RunnerReport =
  | { name: string; status: 'online'; probe: RunnerProbe; groupLimits: Record<string, number>; isPausedByHub: boolean }
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

/** @description The block `remote-run runners` prints for one runner. An offline one shows its last snapshot, marked as old. */
export function formatRunnerBlock(report: RunnerReport): string {
  const pauseTags = formatPauseTags(report).map((tag) => ` · ${tag}`).join('');
  if (report.status === 'online') {
    return [`${report.name} — online${pauseTags} · ${formatSystem(report.probe)}`, ...formatRunnerDetails(report.probe, report.groupLimits)].join('\n');
  }
  const lastSeen = report.lastSeenAtMs === null ? 'never seen' : `last seen ${formatLastSeen(report.lastSeenAtMs)}`;
  if (report.lastProbe === null) return `${report.name} — offline (${report.reason})${pauseTags} · ${lastSeen}`;
  return [
    `${report.name} — offline (${report.reason})${pauseTags} · ${lastSeen} — as it was then: ${formatSystem(report.lastProbe)}`,
    ...formatRunnerDetails(report.lastProbe, report.groupLimits),
  ].join('\n');
}
