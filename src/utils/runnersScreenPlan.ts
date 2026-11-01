/**
 * @description Pure plan of the `/runners` screen (`connectors/telegram/commands/runners.ts`): the list of paired machines with
 * what they said about themselves, the buttons, the confirmation of a removal, the address step of the first pairing, the pairing
 * message and the texts that replace it once the code was used or expired. Everything here takes the facts in and gives text and
 * button data out, so the first render and every re-render can never drift apart, and the callback data is checked for Telegram's
 * 64-byte cap in one place.
 *
 * Buttons carry the registry revision AND the runner's position (`rnr_<rev>_<i>_<action>`): a keyboard left in the history acts
 * on the list it was drawn from or is refused, never on a neighbour that moved up.
 */

import type { Translate } from '../i18n';
import { formatGigabytes, runnerCapabilities, type RunnerProbe } from '../remoteRun/probe';
import type { PairedRunner, RunnerServiceKind } from '../runners/hubRegistry';

/** Telegram refuses callback data over 64 BYTES. */
export const maxCallbackDataBytes = 64;

export const runnersCallbackPrefix = 'rnr_';
export const runnersPairCallback = 'rnr_pair';
export const runnersRefreshCallback = 'rnr_refresh';
export const runnersAddressUseCallback = 'rnr_aduse';
export const runnersAddressOtherCallback = 'rnr_adother';

/** What a button next to a runner does. `remove` asks; `removeYes` / `removeNo` answer the question. */
export type RunnerAction = 'pause' | 'resume' | 'remove' | 'removeYes' | 'removeNo';

const actionCodes: Record<RunnerAction, string> = { pause: 'p', resume: 'r', remove: 'x', removeYes: 'xy', removeNo: 'xn' };
/** Matches `rnr_<rev>_<index>_<action code>`. */
export const runnerActionCallbackRe = /^rnr_(\d+)_(\d+)_(p|r|x|xy|xn)$/;

export type RunnersCallback =
  | { kind: 'pair' }
  | { kind: 'refresh' }
  | { kind: 'addressUse' }
  | { kind: 'addressOther' }
  | { kind: 'runner'; revision: number; index: number; action: RunnerAction };

export function buildRunnerActionCallback(revision: number, index: number, action: RunnerAction): string {
  return `${runnersCallbackPrefix}${revision}_${index}_${actionCodes[action]}`;
}

/** @description Read a button's callback data; `null` when it is not one of this screen's. */
export function parseRunnersCallback(data: string): RunnersCallback | null {
  if (data === runnersPairCallback) return { kind: 'pair' };
  if (data === runnersRefreshCallback) return { kind: 'refresh' };
  if (data === runnersAddressUseCallback) return { kind: 'addressUse' };
  if (data === runnersAddressOtherCallback) return { kind: 'addressOther' };
  const match = runnerActionCallbackRe.exec(data);
  if (match === null) return null;
  const action = (Object.keys(actionCodes) as RunnerAction[]).find((candidate) => actionCodes[candidate] === match[3]);
  return action === undefined ? null : { kind: 'runner', revision: Number(match[1]), index: Number(match[2]), action };
}

export interface ScreenButton {
  text: string;
  data: string;
}

/** @name RunnersScreen @description Text and keyboard rows of one render. */
export interface RunnersScreen {
  text: string;
  rows: ScreenButton[][];
}

/** @name RunnerScreenEntry @description One paired machine and everything known of it right now. */
export interface RunnerScreenEntry {
  runner: PairedRunner;
  isOnline: boolean;
  /** The last time the hub knew the link alive; `null` = never connected. */
  lastSeenMs: number | null;
  /** The live probe while online, else the last snapshot taken when the machine was seen; `null` = never probed. */
  probe: RunnerProbe | null;
}

export interface RunnersScreenModel {
  /** The registry revision the keyboard is built from. */
  revision: number;
  entries: readonly RunnerScreenEntry[];
  /** When each pairing code that is still open expires. */
  openPairingExpiries: readonly number[];
  /** A probe is running: the screen says so, and is re-rendered when it ends. */
  isChecking: boolean;
}

/** @description Formats an instant for the operator (`1 Nov 14:02`) in the bot's timezone and the topic's language. */
export type FormatTime = (epochMs: number) => string;

const serviceKindKeys: Record<RunnerServiceKind, string> = {
  foreground: 'runners.serviceForeground',
  'user-service': 'runners.serviceUserService',
  'system-service': 'runners.serviceSystemService',
  unknown: 'runners.serviceUnknown',
};

function describeSystem(entry: RunnerScreenEntry): string {
  const { probe, runner } = entry;
  if (probe === null || probe.osName === '') return `${runner.os} (${runner.arch})`;
  const name = [probe.osName, probe.osVersion].filter((part) => part !== '').join(' ');
  return probe.arch === '' ? name : `${name} (${probe.arch})`;
}

function describeCpu(probe: RunnerProbe, t: Translate, isLive: boolean): string {
  const model = probe.cpuModel === '' ? 'CPU' : probe.cpuModel;
  const shape =
    probe.cpuCores !== null
      ? t('runners.cpuCores', { model, cores: probe.cpuCores })
      : probe.cpuThreads !== null
        ? t('runners.cpuThreads', { model, threads: probe.cpuThreads })
        : model;
  return isLive && probe.load !== null ? `${shape}, ${t('runners.cpuLoad', { load: probe.load })}` : shape;
}

function describeCapabilities(probe: RunnerProbe, t: Translate): string {
  // What the machine can do first, then what it cannot and why.
  const available: string[] = [];
  const unavailable: string[] = [];
  for (const name of runnerCapabilities) {
    const report = probe.capabilities[name];
    if (report.isAvailable) available.push(report.detail === '' ? name : `${name} (${report.detail})`);
    else unavailable.push(report.detail === '' ? t('runners.capabilityNo', { name }) : t('runners.capabilityNoWhy', { name, detail: report.detail }));
  }
  return t('runners.capabilitiesLine', { list: [...available, ...unavailable].join(' · ') });
}

function buildEntryBlock(entry: RunnerScreenEntry, t: Translate, formatTime: FormatTime): string {
  const { runner, probe } = entry;
  const status = entry.isOnline
    ? t('runners.statusOnline')
    : entry.lastSeenMs === null
      ? t('runners.statusNeverSeen')
      : t('runners.statusOffline', { time: formatTime(entry.lastSeenMs) });
  const heading = [status, ...(runner.isPaused ? [t('runners.pausedMark')] : []), describeSystem(entry), t(serviceKindKeys[runner.serviceKind])].join(' · ');
  const lines = [`${runner.name} — ${heading}`];
  if (probe === null) return lines.join('\n');
  if (entry.isOnline) {
    lines.push(
      `  ${t('runners.hardwareLine', { cpu: describeCpu(probe, t, true), ramTotal: formatGigabytes(probe.ramTotalMb), ramFree: formatGigabytes(probe.ramFreeMb), disk: formatGigabytes(probe.diskFreeMb) })}`,
      `  ${t('runners.jobsLine', { running: probe.jobsRunning, queued: probe.jobsQueued, projects: probe.jobsProjects })}${probe.pueueVersion === null ? ` · ${t('runners.pueueMissing')}` : ''}`,
      `  ${describeCapabilities(probe, t)}`,
    );
  } else {
    lines.push(`  ${t('runners.hardwareOldLine', { cpu: describeCpu(probe, t, false), ramTotal: formatGigabytes(probe.ramTotalMb), disk: formatGigabytes(probe.diskFreeMb) })}`);
  }
  return lines.join('\n');
}

/** @description The list screen: the machines, a button to pair another, a Pause/Resume and a Remove per machine, Refresh. */
export function buildRunnersScreen(model: RunnersScreenModel, t: Translate, formatTime: FormatTime): RunnersScreen {
  const sections = [
    t('runners.title'),
    ...(model.entries.length === 0 ? [t('runners.emptyText')] : model.entries.map((entry) => buildEntryBlock(entry, t, formatTime))),
    ...(model.openPairingExpiries.length === 0 ? [] : [model.openPairingExpiries.map((expiresAtMs) => t('runners.pendingCodeLine', { time: formatTime(expiresAtMs) })).join('\n')]),
    ...(model.isChecking ? [t('runners.checkingNote')] : []),
  ];
  const rows: ScreenButton[][] = [[{ text: t('runners.pairButton'), data: runnersPairCallback }]];
  model.entries.forEach((entry, index) => {
    const { name, isPaused } = entry.runner;
    rows.push([
      isPaused
        ? { text: t('runners.resumeButton', { name }), data: buildRunnerActionCallback(model.revision, index, 'resume') }
        : { text: t('runners.pauseButton', { name }), data: buildRunnerActionCallback(model.revision, index, 'pause') },
      { text: t('runners.removeButton', { name }), data: buildRunnerActionCallback(model.revision, index, 'remove') },
    ]);
  });
  rows.push([{ text: t('runners.refreshButton'), data: runnersRefreshCallback }]);
  return { text: sections.join('\n\n'), rows };
}

/** @description The question a Remove button turns the screen into. */
export function buildRemoveConfirmation(runnerName: string, revision: number, index: number, t: Translate): RunnersScreen {
  return {
    text: t('runners.removeConfirmText', { name: runnerName }),
    rows: [[
      { text: t('runners.removeConfirmButton'), data: buildRunnerActionCallback(revision, index, 'removeYes') },
      { text: t('runners.removeCancelButton'), data: buildRunnerActionCallback(revision, index, 'removeNo') },
    ]],
  };
}

/**
 * @description The address step of the first pairing. With a proposal (an address of this machine that answered with its own
 * sshd) it offers «Use …» and «Enter another address»; without one only the second, and says no address was found.
 */
export function buildAddressStep(proposedAddress: string | null, t: Translate): RunnersScreen {
  if (proposedAddress === null) {
    return {
      text: `${t('runners.addressIntro')}\n\n${t('runners.addressNotFound')}`,
      rows: [[{ text: t('runners.addressOtherButton'), data: runnersAddressOtherCallback }]],
    };
  }
  return {
    text: `${t('runners.addressIntro')}\n\n${t('runners.addressFound', { address: proposedAddress })}`,
    rows: [[
      { text: t('runners.addressUseButton', { address: proposedAddress }), data: runnersAddressUseCallback },
      { text: t('runners.addressOtherButton'), data: runnersAddressOtherCallback },
    ]],
  };
}

/** @description The pairing message's text parts: what stands above the line and below it. The line itself sits between them. */
export function buildPairingMessageParts(pairingLifetimeMinutes: number, t: Translate): { intro: string; outro: string } {
  return { intro: t('runners.pairingIntro', { minutes: pairingLifetimeMinutes }), outro: t('runners.pairingOutro') };
}

/** @description What the pairing message becomes once the code was used. */
export function buildPairedText(runnerName: string, pairedAtMs: number, t: Translate, formatTime: FormatTime): string {
  return t('runners.pairedText', { name: runnerName, time: formatTime(pairedAtMs) });
}

/** @description What the pairing message becomes once the code expired unused. */
export function buildExpiredText(t: Translate): string {
  return t('runners.expiredText');
}
