/**
 * @description Pure plan of the `/runners` screen (`connectors/telegram/commands/runners.ts`): the list of paired machines with
 * what they said about themselves, the buttons, the confirmation of a removal, the address step of the first pairing, the pairing
 * message and the texts that replace it once the code was used or expired. Everything here takes the facts in and gives text and
 * button data out, so the first render and every re-render can never drift apart, and the callback data is checked for Telegram's
 * 64-byte cap in one place.
 *
 * Buttons carry the registry revision AND the runner's position in the WHOLE list (`rnr_<rev>_<i>_<action>`): a keyboard left in the
 * history acts on the list it was drawn from or is refused, never on a neighbour that moved up — whichever page it stands on.
 *
 * The text is BOUNDED: Telegram refuses a message over 4096 characters, and what a machine reports about itself (CPU model, capability
 * details) has no length of its own, so every reported string is clipped and the machines are split over pages of at most
 * {@link maxScreenTextChars}. A page holds at least one machine; a list that fits is one page with no navigation.
 */

import type { Translate } from '../i18n';
import { formatGigabytes, runnerCapabilities, type RunnerProbe } from '../remoteRun/probe';
import type { PairedRunner, RunnerServiceKind } from '../runners/hubRegistry';
import { unconfirmedRemovalStopAfterHours } from '../runners/removalTiming';
import type { RunnerJobsStop } from '../runners/runnerRemoval';

/** Telegram refuses callback data over 64 BYTES. */
export const maxCallbackDataBytes = 64;
/** The most characters a screen's text may have: Telegram's limit is 4096, the rest is the margin for the title, notes and the page line. */
export const maxScreenTextChars = 3600;
/** The longest a string a machine reported about itself (CPU model, a capability's detail, its OS name) is shown. */
export const maxReportedTextChars = 80;
/** What the page line («Page 2 of 3») and the separators around it may take of the budget. */
const pageLineReserveChars = 60;
const sectionSeparator = '\n\n';

export const runnersCallbackPrefix = 'rnr_';
export const runnersPairCallback = 'rnr_pair';
export const runnersRefreshCallback = 'rnr_refresh';
export const runnersAddressUseCallback = 'rnr_aduse';
export const runnersAddressOtherCallback = 'rnr_adother';
/** Matches `rnr_pg_<page>` (0-based): a view change that acts on nothing, so it carries no revision. */
export const runnersPageCallbackRe = /^rnr_pg_(\d+)$/;

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
  | { kind: 'page'; page: number }
  | { kind: 'runner'; revision: number; index: number; action: RunnerAction };

export function buildRunnersPageCallback(page: number): string {
  return `${runnersCallbackPrefix}pg_${page}`;
}

export function buildRunnerActionCallback(revision: number, index: number, action: RunnerAction): string {
  return `${runnersCallbackPrefix}${revision}_${index}_${actionCodes[action]}`;
}

/** @description Read a button's callback data; `null` when it is not one of this screen's. */
export function parseRunnersCallback(data: string): RunnersCallback | null {
  if (data === runnersPairCallback) return { kind: 'pair' };
  if (data === runnersRefreshCallback) return { kind: 'refresh' };
  if (data === runnersAddressUseCallback) return { kind: 'addressUse' };
  if (data === runnersAddressOtherCallback) return { kind: 'addressOther' };
  const pageMatch = runnersPageCallbackRe.exec(data);
  if (pageMatch !== null) return { kind: 'page', page: Number(pageMatch[1]) };
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

/** @name RunnersListScreen @description The list as one page: which of how many it is. */
export interface RunnersListScreen extends RunnersScreen {
  /** 0-based, clamped into the list that exists. */
  page: number;
  pageCount: number;
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

/** @description `text` as a string a machine reported: no longer than {@link maxReportedTextChars}, cut with an ellipsis. */
export function clipReportedText(text: string): string {
  return text.length <= maxReportedTextChars ? text : `${text.slice(0, maxReportedTextChars - 1)}…`;
}

function describeSystem(entry: RunnerScreenEntry): string {
  const { probe, runner } = entry;
  if (probe === null || probe.osName === '') return clipReportedText(`${runner.os} (${runner.arch})`);
  const name = [probe.osName, probe.osVersion].filter((part) => part !== '').join(' ');
  return clipReportedText(probe.arch === '' ? name : `${name} (${probe.arch})`);
}

function describeCpu(probe: RunnerProbe, t: Translate, isLive: boolean): string {
  const model = probe.cpuModel === '' ? 'CPU' : clipReportedText(probe.cpuModel);
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
    const detail = clipReportedText(report.detail);
    if (report.isAvailable) available.push(detail === '' ? name : `${name} (${detail})`);
    else unavailable.push(detail === '' ? t('runners.capabilityNo', { name }) : t('runners.capabilityNoWhy', { name, detail }));
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
  // How it is kept running is what the probe reports (the last one, for an offline machine): the registry holds only what the runner said when it was
  // paired — «run by hand», since `service install` comes after — and never learns of the install. Its own word stands where the probe has none.
  const serviceKind = probe?.serviceKind ?? runner.serviceKind;
  const heading = [status, ...(runner.isPaused ? [t('runners.pausedMark')] : []), describeSystem(entry), t(serviceKindKeys[serviceKind])].join(' · ');
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

/**
 * @description Split the entry blocks over pages: each page takes blocks while the text stays within `budget` characters (blocks joined by
 * a blank line), and at least one block, so a block over the budget alone still has a page. Returns each page's first block and the
 * block after its last.
 */
export function paginateBlocks(blocks: readonly string[], budget: number): Array<{ start: number; end: number }> {
  const pages: Array<{ start: number; end: number }> = [];
  let start = 0;
  let used = 0;
  blocks.forEach((block, index) => {
    const cost = block.length + (index === start ? 0 : sectionSeparator.length);
    if (index > start && used + cost > budget) {
      pages.push({ start, end: index });
      start = index;
      used = 0;
    }
    used += index === start ? block.length : cost;
  });
  if (blocks.length > 0) pages.push({ start, end: blocks.length });
  return pages;
}

function buildOpenPairingsSection(expiries: readonly number[], t: Translate, formatTime: FormatTime): string[] {
  if (expiries.length === 0) return [];
  const lastExpiry = Math.max(...expiries);
  return [expiries.length === 1 ? t('runners.pendingCodeLine', { time: formatTime(lastExpiry) }) : t('runners.pendingCodesLine', { count: expiries.length, time: formatTime(lastExpiry) })];
}

/**
 * @description The list screen, page `page` (0-based; a page past the end is the last): the machines on it, a button to pair another, a
 * Pause/Resume and a Remove per machine on the page, the page buttons when there is more than one page, Refresh.
 */
export function buildRunnersScreen(model: RunnersScreenModel, t: Translate, formatTime: FormatTime, page = 0): RunnersListScreen {
  const title = t('runners.title');
  const openPairings = buildOpenPairingsSection(model.openPairingExpiries, t, formatTime);
  const checking = model.isChecking ? [t('runners.checkingNote')] : [];
  const blocks = model.entries.map((entry) => buildEntryBlock(entry, t, formatTime));
  const chromeChars = [title, ...openPairings, ...checking].join(sectionSeparator).length + sectionSeparator.length + pageLineReserveChars;
  const pages = paginateBlocks(blocks, maxScreenTextChars - chromeChars);
  const pageCount = Math.max(pages.length, 1);
  const shownPage = Math.min(Math.max(page, 0), pageCount - 1);
  const { start, end } = pages[shownPage] ?? { start: 0, end: 0 };
  const sections = [
    title,
    ...(pageCount > 1 ? [t('runners.pageLine', { page: shownPage + 1, pages: pageCount })] : []),
    ...(model.entries.length === 0 ? [t('runners.emptyText')] : blocks.slice(start, end)),
    ...openPairings,
    ...checking,
  ];
  const rows: ScreenButton[][] = [[{ text: t('runners.pairButton'), data: runnersPairCallback }]];
  model.entries.slice(start, end).forEach((entry, offset) => {
    const { name, isPaused } = entry.runner;
    const index = start + offset;
    rows.push([
      isPaused
        ? { text: t('runners.resumeButton', { name }), data: buildRunnerActionCallback(model.revision, index, 'resume') }
        : { text: t('runners.pauseButton', { name }), data: buildRunnerActionCallback(model.revision, index, 'pause') },
      { text: t('runners.removeButton', { name }), data: buildRunnerActionCallback(model.revision, index, 'remove') },
    ]);
  });
  if (pageCount > 1) {
    rows.push([
      ...(shownPage > 0 ? [{ text: t('runners.pagePreviousButton'), data: buildRunnersPageCallback(shownPage - 1) }] : []),
      ...(shownPage < pageCount - 1 ? [{ text: t('runners.pageNextButton'), data: buildRunnersPageCallback(shownPage + 1) }] : []),
    ]);
  }
  rows.push([{ text: t('runners.refreshButton'), data: runnersRefreshCallback }]);
  return { text: sections.join(sectionSeparator), rows, page: shownPage, pageCount };
}

/**
 * @description The message that says what a removal came to: the key is deleted in every case, and the jobs were stopped from the hub, or the
 * machine was offline (it stops them itself once its key has been refused for `unconfirmedRemovalStopAfterHours`), or they could not be stopped
 * from here (it does the same). Three outcomes, three texts — «offline» is not what «failed» means.
 */
export function buildRemovalOutcomeText(runnerName: string, jobs: RunnerJobsStop, t: Translate): string {
  const keyByOutcome: Record<RunnerJobsStop, 'runners.removedJobsStoppedText' | 'runners.removedJobsOfflineText' | 'runners.removedJobsFailedText'> = {
    stopped: 'runners.removedJobsStoppedText',
    offline: 'runners.removedJobsOfflineText',
    failed: 'runners.removedJobsFailedText',
  };
  return t(keyByOutcome[jobs], { name: runnerName, hours: unconfirmedRemovalStopAfterHours });
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
