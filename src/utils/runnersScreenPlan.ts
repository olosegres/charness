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
import { getJobsAtOnce, jobsAtOnceChoices, pairingJobsAtOnceChoices } from '../remoteRun/runnersConfig';
import { checkIsDiskLow, formatGigabytes, formatOlderSimulators, jobToolNone, jobToolUnknown, runnerCapabilities, type RunnerProbe } from '../remoteRun/probe';
import type { PairedRunner, RunnerServiceKind } from '../runners/hubRegistry';
import { unconfirmedRemovalStopAfterHours } from '../runners/removalTiming';
import { getCurrentServiceKind } from '../runners/runnerServiceKind';
import type { LinkConcern } from '../runners/linkConcern';
import type { RunnerJobsStop } from '../runners/runnerRemoval';
import type { RunnerGroupsOutcome } from '../runners/runnerGroups';

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

/** What a button next to a runner does. `remove` asks; `removeYes` / `removeNo` answer the question; `jobsPick` opens the «jobs at once» picker. */
export type RunnerAction = 'pause' | 'resume' | 'remove' | 'removeYes' | 'removeNo' | 'jobsPick';

const actionCodes: Record<RunnerAction, string> = { pause: 'p', resume: 'r', remove: 'x', removeYes: 'xy', removeNo: 'xn', jobsPick: 'j' };
/** The code of the button that sets «jobs at once» to a number: `j` and the digit. */
const jobsSetCodePrefix = 'j';
/** Matches `rnr_<rev>_<index>_<action code>`; `j` opens the picker, `j<n>` sets the number. */
export const runnerActionCallbackRe = /^rnr_(\d+)_(\d+)_(p|r|x|xy|xn|j[1-8]?)$/;
/** The info button that stands as the label of the pairing message's «jobs at once» row. */
export const runnersPairingJobsInfoCallback = 'rnr_pjinfo';
/** Matches `rnr_pj_<pairId>_<n>`: a number chosen on the pairing message of code `pairId` (12 hex digits). 7 + 12 + 1 + 1 = 21 bytes. */
export const runnersPairingJobsCallbackRe = /^rnr_pj_([0-9a-f]{12})_([1-8])$/;

export type RunnersCallback =
  | { kind: 'pair' }
  | { kind: 'refresh' }
  | { kind: 'addressUse' }
  | { kind: 'addressOther' }
  | { kind: 'page'; page: number }
  | { kind: 'runner'; revision: number; index: number; action: RunnerAction }
  | { kind: 'runnerJobs'; revision: number; index: number; jobsAtOnce: number }
  | { kind: 'pairingJobs'; pairId: string; jobsAtOnce: number }
  | { kind: 'pairingJobsInfo' };

export function buildRunnersPageCallback(page: number): string {
  return `${runnersCallbackPrefix}pg_${page}`;
}

export function buildRunnerActionCallback(revision: number, index: number, action: RunnerAction): string {
  return `${runnersCallbackPrefix}${revision}_${index}_${actionCodes[action]}`;
}

/** @description The button of the picker that sets the runner at `index` to run `jobsAtOnce` jobs at once. */
export function buildRunnerJobsCallback(revision: number, index: number, jobsAtOnce: number): string {
  return `${runnersCallbackPrefix}${revision}_${index}_${jobsSetCodePrefix}${jobsAtOnce}`;
}

/** @description The button of the pairing message of code `pairId` that picks `jobsAtOnce` for the runner it will make. */
export function buildPairingJobsCallback(pairId: string, jobsAtOnce: number): string {
  return `${runnersCallbackPrefix}pj_${pairId}_${jobsAtOnce}`;
}

/** @description Read a button's callback data; `null` when it is not one of this screen's. */
export function parseRunnersCallback(data: string): RunnersCallback | null {
  if (data === runnersPairCallback) return { kind: 'pair' };
  if (data === runnersRefreshCallback) return { kind: 'refresh' };
  if (data === runnersAddressUseCallback) return { kind: 'addressUse' };
  if (data === runnersAddressOtherCallback) return { kind: 'addressOther' };
  const pageMatch = runnersPageCallbackRe.exec(data);
  if (pageMatch !== null) return { kind: 'page', page: Number(pageMatch[1]) };
  if (data === runnersPairingJobsInfoCallback) return { kind: 'pairingJobsInfo' };
  const pairingJobsMatch = runnersPairingJobsCallbackRe.exec(data);
  if (pairingJobsMatch !== null) return { kind: 'pairingJobs', pairId: pairingJobsMatch[1], jobsAtOnce: Number(pairingJobsMatch[2]) };
  const match = runnerActionCallbackRe.exec(data);
  if (match === null) return null;
  const revision = Number(match[1]);
  const index = Number(match[2]);
  const jobsAtOnceCode = match[3].startsWith(jobsSetCodePrefix) ? match[3].slice(jobsSetCodePrefix.length) : '';
  if (jobsAtOnceCode !== '') return { kind: 'runnerJobs', revision, index, jobsAtOnce: Number(jobsAtOnceCode) };
  const action = (Object.keys(actionCodes) as RunnerAction[]).find((candidate) => actionCodes[candidate] === match[3]);
  return action === undefined ? null : { kind: 'runner', revision, index, action };
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
  /** What is worth telling about where its link comes from (the address changed, or two links fight: `runners/linkConcern.ts`); absent / `null` = nothing. */
  linkConcern?: LinkConcern | null;
  /** Online, but the Mac's lid is shut with nothing keeping it awake: it takes no new job (`runners/linkControl.ts`); `probe` is then the last snapshot, not a live answer. Absent = no. */
  isLidClosed?: boolean;
  /** Online (its link is up) but its probe did not finish in time — a machine under heavy load, not a machine that is gone; `probe` is then the last snapshot, not a live answer. Absent = no. */
  isBusy?: boolean;
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

/** How the link keeps the machine awake, one line (nothing when the runner did not say): a machine that sleeps under a job drops the link, so the answer is on the list. */
function describeKeepsAwake(probe: RunnerProbe, t: Translate): string[] {
  if (probe.keepsAwake === null) return [];
  const how = probe.keepsAwake.method === null
    ? t('runners.keepsAwakeNo', { reason: probe.keepsAwake.reason === '' ? t('runners.keepsAwakeNoReason') : clipReportedText(probe.keepsAwake.reason) })
    : probe.keepsAwake.method === 'caffeinate' ? t('runners.keepsAwakeCaffeinate') : t('runners.keepsAwakeInhibit');
  return [`  ${t('runners.keepsAwakeLine', { how })}`];
}

/** The Node and yarn a job runs with, one line (nothing when the runner's script did not report them): a Node that changed under a restarted link shows here. */
function describeJobTools(probe: RunnerProbe, t: Translate): string[] {
  if (probe.jobTools === null) return [];
  const describe = (version: string): string => (version === jobToolNone ? t('runners.jobToolNone') : version === jobToolUnknown ? t('runners.jobToolUnknown') : version);
  return [`  ${t('runners.jobToolsLine', { node: describe(probe.jobTools.node), yarn: describe(probe.jobTools.yarn) })}`];
}

/** @description The warning about a machine whose link comes from another place than it did, or whose links fight — under its block on the screen, and in the message that tells it once. */
export function buildLinkConcernNote(concern: LinkConcern, t: Translate, formatTime: FormatTime): string {
  if (concern.kind === 'fighting') return t('runners.linkFightNote', { sources: concern.sources.join(', '), count: concern.changeCount });
  const vars = { from: concern.fromSource, to: concern.toSource, time: formatTime(concern.atMs) };
  return t(concern.isLiveReplacement ? 'runners.linkSourceReplacedNote' : 'runners.linkSourceChangedNote', vars);
}

function buildEntryBlock(entry: RunnerScreenEntry, t: Translate, formatTime: FormatTime): string {
  const lines = buildEntryLines(entry, t, formatTime);
  if (entry.linkConcern != null) lines.push(`  ${buildLinkConcernNote(entry.linkConcern, t, formatTime)}`);
  return lines.join('\n');
}

/**
 * The project copies a runner keeps and what they take (`~` before the size while some figure is still being measured; the line says the clones are counted in full when some copy shares disk blocks with another — `du` cannot see
 * them shared); nothing when the runner did not say or has none.
 */
function describeProjectCopies(probe: RunnerProbe, t: Translate): string[] {
  if (probe.copies === null || probe.copies.count === 0) return [];
  const size = `${probe.copies.unmeasuredCount > 0 ? '~' : ''}${formatGigabytes(probe.copies.sizeMb)}`;
  return [`  ${t(probe.copies.clonedCount > 0 ? 'runners.copiesWithClonesLine' : 'runners.copiesLine', { count: probe.copies.count, size })}`];
}

/** ` — LOW …` for the end of the hardware line when the work disk is under what the runner wants kept free (the same test as the CLI's `runners`); nothing otherwise. */
function describeLowDisk(probe: RunnerProbe, t: Translate): string {
  return checkIsDiskLow(probe) ? ` — ${t('runners.diskLowNote', { minFree: formatGigabytes(probe.diskMinFreeMb) })}` : '';
}

/** The Simulator runtimes of a Mac that have a newer one of the same major (information only: the bot, like remote-run, removes nothing of them); nothing when there are none. */
function describeOlderSimulators(probe: RunnerProbe, t: Translate): string[] {
  if (probe.olderSimulators.length === 0) return [];
  return [`  ${t('runners.oldSimulatorsLine', { runtimes: formatOlderSimulators(probe) })}`];
}

function buildEntryLines(entry: RunnerScreenEntry, t: Translate, formatTime: FormatTime): string[] {
  const { runner, probe } = entry;
  const status = entry.isOnline
    ? t(entry.isLidClosed === true ? 'runners.statusLidClosed' : entry.isBusy === true ? 'runners.statusBusy' : 'runners.statusOnline')
    : entry.lastSeenMs === null
      ? t('runners.statusNeverSeen')
      : t('runners.statusOffline', { time: formatTime(entry.lastSeenMs) });
  const serviceKind = getCurrentServiceKind(runner, probe);
  const heading = [status, ...(runner.isPaused ? [t('runners.pausedMark')] : []), describeSystem(entry), t(serviceKindKeys[serviceKind])].join(' · ');
  const lines = [`${runner.name} — ${heading}`];
  if (probe === null) return lines;
  // A Mac with its lid shut is not asked, and a busy one did not answer: what is shown is the last snapshot, as for a machine that is offline.
  if (entry.isOnline && entry.isLidClosed !== true && entry.isBusy !== true) {
    lines.push(
      `  ${t('runners.hardwareLine', { cpu: describeCpu(probe, t, true), ramTotal: formatGigabytes(probe.ramTotalMb), ramFree: formatGigabytes(probe.ramFreeMb), disk: formatGigabytes(probe.diskFreeMb) })}${describeLowDisk(probe, t)}`,
      `  ${t('runners.jobsLine', { running: probe.jobsRunning, queued: probe.jobsQueued, projects: probe.jobsProjects })} · ${t('runners.jobsAtOnceNote', { count: getJobsAtOnce(runner) })}${probe.pueueVersion === null ? ` · ${t('runners.pueueMissing')}` : ''}`,
      ...describeProjectCopies(probe, t),
      `  ${describeCapabilities(probe, t)}`,
      ...describeOlderSimulators(probe, t),
      ...describeJobTools(probe, t),
      ...describeKeepsAwake(probe, t),
    );
  } else {
    lines.push(`  ${t('runners.hardwareOldLine', { cpu: describeCpu(probe, t, false), ramTotal: formatGigabytes(probe.ramTotalMb), disk: formatGigabytes(probe.diskFreeMb) })}${describeLowDisk(probe, t)}`);
    // A machine that does not answer and said it kept itself awake is most likely asleep — and no assertion wakes a sleeping machine: the row must not read as «it will be back by itself».
    if (!entry.isOnline && probe.keepsAwake !== null && probe.keepsAwake.method !== null) lines.push(`  ${t('runners.offlineKeptAwakeNote')}`);
  }
  return lines;
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
 * Pause/Resume and a Remove per machine on the page, and under them the «jobs at once» button that opens its picker, the page buttons when
 * there is more than one page, Refresh.
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
    ], [
      { text: t('runners.jobsAtOnceButton', { name, count: getJobsAtOnce(entry.runner) }), data: buildRunnerActionCallback(model.revision, index, 'jobsPick') },
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

/**
 * @description What the operator is told after removing a machine that runs as an always-on service: it keeps running there until an admin removes it
 * (nothing of charness runs as root), the commands — made by this hub, not by the machine — one per line.
 */
export function buildServiceRemovalText(runnerName: string, commands: readonly string[], t: Translate): string {
  return t('runners.removedServiceText', { name: runnerName, commands: commands.join('\n') });
}

/** An iOS end-to-end job (Xcode build + Simulator + Metro + Detox) peaks at about this much memory... */
const gigabytesPerJob = 12;
/** ...and keeps about this many cores busy. */
const coresPerJob = 4;
/** The picker never recommends more than this: past it the machine's disk and the builds' shared caches are the limit, not its cores. */
const maxRecommendedJobsAtOnce = 4;
const megabytesPerGigabyte = 1024;

/**
 * @description How many jobs at once a machine of this size is good for: the smaller of its memory and its cores counted in the size of one heavy job
 * ({@link gigabytesPerJob} GB, {@link coresPerJob} cores), at least 1 and at most {@link maxRecommendedJobsAtOnce}. `null` when the runner did not report its cores or its memory — no guess.
 */
export function getRecommendedJobsAtOnce(probe: RunnerProbe): number | null {
  if (probe.cpuCores === null || probe.ramTotalMb === null) return null;
  const byMemory = Math.floor(probe.ramTotalMb / megabytesPerGigabyte / gigabytesPerJob);
  const byCores = Math.floor(probe.cpuCores / coresPerJob);
  return Math.min(Math.max(Math.min(byMemory, byCores), 1), maxRecommendedJobsAtOnce);
}

/** The picker's line about what the machine's size suggests; nothing when the machine was never probed or did not report its cores or memory. */
function describeRecommendedJobsAtOnce(probe: RunnerProbe | null, t: Translate): string[] {
  if (probe === null || probe.cpuCores === null) return [];
  const count = getRecommendedJobsAtOnce(probe);
  return count === null ? [] : [t('runners.jobsAtOnceRecommended', { cores: probe.cpuCores, ram: formatGigabytes(probe.ramTotalMb), count })];
}

/**
 * @description The picker a «jobs at once» button turns the screen into: how many jobs the runner may run at once, what it is now, what its hardware suggests
 * (when it has said what it is), and one button per number — the current one marked, and always present even when it is a number the picker does not offer (an entry
 * edited by hand) — then Back, which is the list again. A tap on a number sets it and draws the list: the picker is one-shot.
 */
export function buildJobsAtOncePicker(entry: RunnerScreenEntry, revision: number, index: number, t: Translate): RunnersScreen {
  const current = getJobsAtOnce(entry.runner);
  const numbers = [...new Set([...jobsAtOnceChoices, current])].sort((first, second) => first - second);
  return {
    text: [t('runners.jobsAtOncePickerText', { name: entry.runner.name, count: current }), ...describeRecommendedJobsAtOnce(entry.probe, t)].join(sectionSeparator),
    rows: [
      numbers.map((count) => ({ text: count === current ? `${count} ✓` : count.toString(), data: buildRunnerJobsCallback(revision, index, count) })),
      [{ text: t('runners.jobsAtOnceBackButton'), data: runnersRefreshCallback }],
    ],
  };
}

/**
 * @description The keyboard of the pairing message: a label button of its own (it explains itself when tapped — five buttons in one row would cut the label short on a phone) and under it the
 * numbers a new machine may start with, the chosen one marked.
 */
export function buildPairingJobsAtOnceRows(pairId: string, current: number, t: Translate): ScreenButton[][] {
  return [
    [{ text: t('runners.pairingJobsAtOnceLabel'), data: runnersPairingJobsInfoCallback }],
    pairingJobsAtOnceChoices.map((count) => ({ text: count === current ? `${count} ✓` : count.toString(), data: buildPairingJobsCallback(pairId, count) })),
  ];
}

/** @description What a tap that set «jobs at once» says: the number was told to the machine, or it is saved and the machine will take it at its next job (it is offline, or did not answer in time). */
export function buildJobsAtOnceOutcomeToast(runnerName: string, jobsAtOnce: number, outcome: RunnerGroupsOutcome, t: Translate): string {
  const keyByOutcome: Record<RunnerGroupsOutcome, 'runners.jobsAtOnceAppliedToast' | 'runners.jobsAtOnceOfflineToast' | 'runners.jobsAtOnceFailedToast'> = {
    applied: 'runners.jobsAtOnceAppliedToast',
    offline: 'runners.jobsAtOnceOfflineToast',
    failed: 'runners.jobsAtOnceFailedToast',
  };
  return t(keyByOutcome[outcome], { name: runnerName, count: jobsAtOnce });
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

/**
 * @description The text above the pairing line — the ONE message a pairing is offered in: the lifetime, where to paste the line and what it does as root, which
 * word is the account (`account`, the one the line pairs unless its last word is changed) and what it must be, and how to pair without admin rights (the same line
 * from that account itself, without `sudo`). The line with this text must fit one Telegram message (4096 characters), in every language.
 */
export function buildPairingIntro(pairingLifetimeMinutes: number, account: string, t: Translate): string {
  return t('runners.pairingIntro', { minutes: pairingLifetimeMinutes, account });
}

/** @description What the pairing message becomes once the code was used: it says how many jobs the runner will run at once, and where that is changed. */
export function buildPairedText(runnerName: string, pairedAtMs: number, jobsAtOnce: number, t: Translate, formatTime: FormatTime): string {
  return `${t('runners.pairedText', { name: runnerName, time: formatTime(pairedAtMs) })}\n${t('runners.pairedJobsAtOnceNote', { count: jobsAtOnce })}`;
}

/** @description What the pairing message becomes once the code expired unused. */
export function buildExpiredText(t: Translate): string {
  return t('runners.expiredText');
}

/** @description What the pairing message becomes once its code was CLOSED unused: the line was pasted for a machine that was already paired, so it only installed the service. */
export function buildClosedText(t: Translate): string {
  return t('runners.closedText');
}
