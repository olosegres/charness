/**
 * @description The «accounts note» an orchestrating agent gets about the limits of its accounts, as PURE decisions and
 * texts — no clock, no state, no I/O: the caller hands in the report, the record, the clock and the setting.
 *
 * Two shapes of one note, both agent-facing English and never posted to the topic:
 *   • `reminder` — which account the next new Claude worker goes to and why, the next one or two, the ChatGPT window, and
 *     «call `claude_profiles` right before your next launch or resume». Scheduled: due once the interval has passed since the
 *     conversation's last note (any shape) or its agent's last `claude_profiles` call.
 *   • `summary` — one line of the same figures, only when the limits picture CHANGED since the last note, at most once per
 *     {@link limitNoteSummaryFloorMs}, and only at a moment the agent messages the user or wakes up.
 *
 * A note is a passenger, never a cause (README § Lifecycle safety): nothing here may stamp activity, write to an agent or wake a
 * session — that is why this module takes plain values and returns plain values.
 */

import { formatUsd } from '../utils/claudeApiSpend';
import {
  claudeLaunchSessionCeilingPercent,
  describeClaudeLaunchOutcome,
  formatClaudeUsageRelativeReset,
  getClaudeUsageBucket,
  getClaudeUsagePercentAsOf,
  type ClaudeProfileReportEntry,
  type ClaudeProfilesReport,
  type ClaudeRelativeResetWords,
  type ClaudeUsageBucket,
  type ClaudeUsageSnapshot,
} from '../utils/claudeUsage';
import { chatGptProviderId, type OpenCodeProviderUsageRecord } from '../utils/openCodeUsage';
import { formatReminderTime } from '../utils/reminderWizard';
import { getZonedWallClock } from '../utils/timezone';

/** What the poller recorded per OpenCode provider (`state.json` `openCodeProviderUsage`); the ChatGPT subscription's figures are read from it. */
export type OpenCodeProviderUsages = Readonly<Record<string, OpenCodeProviderUsageRecord>>;

const msPerMinute = 60 * 1000;
const msPerDay = 24 * 60 * msPerMinute;

// ── windows and names ──

/** What a note text starts with (`[Accounts · 14:05] …`): the bot cuts a send tool's result from it, and the resume readers strip it. */
export const limitNoteMarker = '[Accounts';

/** A session quiet for this long «woke up»: its next turn start may carry the summary. */
export const limitNoteMinQuietMs = 30 * msPerMinute;

/** The least time between two notes of the summary shape. */
export const limitNoteSummaryFloorMs = 30 * msPerMinute;

/** A conversation that called `claude_profiles` or armed a worker watch within this long orchestrates workers. */
export const limitNoteOrchestrationWindowMs = 7 * msPerDay;

/** @name LimitNoteWindows @description The three windows, injectable so a flow can shorten them (`CHARNESS_TEST_TIMINGS`). */
export interface LimitNoteWindows {
  /** How long a session must have been quiet for a turn start to carry the summary. */
  minQuietMs: number;
  /** The least time between two summaries. */
  summaryFloorMs: number;
  /** How long after its last `claude_profiles` call / worker watch a conversation still counts as orchestrating. */
  orchestrationWindowMs: number;
}

export const defaultLimitNoteWindows: LimitNoteWindows = {
  minQuietMs: limitNoteMinQuietMs,
  summaryFloorMs: limitNoteSummaryFloorMs,
  orchestrationWindowMs: limitNoteOrchestrationWindowMs,
};

/** A weekly figure moves the fingerprint in steps this wide: a note is not worth its tokens for a point or two. */
const fingerprintPercentStep = 10;

/** How many accounts one note names after the pick (three Claude accounts in all). */
const limitNoteNextAccountCount = 2;

/** The relative reset in the note's own words: `1 d 19 h`, `5 d`, `3 h`, `30 min`. */
const limitNoteResetWords: ClaudeRelativeResetWords = { pattern: '{time}', day: ' d', hour: ' h', minute: ' min' };

// ── the record and the decision ──

/**
 * @name LimitNoteRecord
 * @description What the bot remembers per conversation (`state.json` `limitNotes`), epoch ms: when the last note of either shape
 * reached the agent, the fingerprint of the picture it showed (absent = the agent holds none, e.g. a fresh context), when the agent
 * last called `claude_profiles` or armed a worker watch (it orchestrates), and when it last called `claude_profiles` (it looked).
 */
export interface LimitNoteRecord {
  lastNoteAt?: number;
  fingerprint?: string;
  lastOrchestratedAt?: number;
  lastProfilesCallAt?: number;
}

/** The moment a note may ride: a turn start the person or the scheduler makes, a Claude turn already running, the result of a bot send tool. */
export type LimitNoteMoment = 'turnStart' | 'midTurn' | 'sendResult';

export type LimitNoteShape = 'reminder' | 'summary';

/** @description Every reason a note is not delivered, named so a log line says why nothing came. */
export const limitNoteSkipReasons = {
  notOrchestrating: 'not orchestrating',
  off: 'off',
  noFreshUsage: 'no fresh usage',
  notDue: 'not due',
  noReminderAtMoment: 'a send result carries no reminder',
  noSummaryAtMoment: 'a running turn carries no summary',
  notQuiet: 'not quiet',
  unchanged: 'unchanged',
  summaryFloor: '30-min floor',
} as const;

/** @description What was decided: the shape to deliver, or `null` with every reason that applied. */
export interface LimitNoteDecision {
  shape: LimitNoteShape | null;
  skipReasons: string[];
}

/** When the agent last got a note or looked (`claude_profiles`) — the reminder clock's start; `null` = never. */
function getLastLookAtMs(record: LimitNoteRecord | undefined): number | null {
  const stamps = [record?.lastNoteAt, record?.lastProfilesCallAt].filter((stamp): stamp is number => stamp !== undefined);
  return stamps.length === 0 ? null : Math.max(...stamps);
}

function listReasons(candidates: readonly (string | false)[]): string[] {
  return candidates.filter((reason): reason is string => typeof reason === 'string');
}

/**
 * @description Which shape of the note the conversation gets at `moment`, if any.
 *
 * Gates for both shapes: the conversation orchestrates (`lastOrchestratedAt` within the window), the setting is not Off
 * (`intervalMs` null — the summary too), and the usage cache holds a fresh figure ({@link checkHasFreshLimitUsage}).
 *
 * `reminder` — at a turn start or mid-turn, once `intervalMs` has passed since the last note or `claude_profiles` call (never
 * either: due). A send result carries no reminder.
 *
 * `summary` — at a send result, or at a turn start after `windows.minQuietMs` of quiet; never mid-turn. Only when `fingerprint`
 * differs from the one the last note showed (none stored: the agent holds no picture, so it differs) and at least
 * `windows.summaryFloorMs` since the last note.
 *
 * Reminder and summary due together → the reminder alone. `quietMs` is how long the session was quiet before this turn
 * start (`null`: not a turn start, or unknown — counts as not quiet).
 */
export function decideLimitNote(input: {
  moment: LimitNoteMoment;
  record: LimitNoteRecord | undefined;
  /** The interval in ms; `null` = Off. */
  intervalMs: number | null;
  /** {@link buildLimitNoteFingerprint} of the figures now. */
  fingerprint: string;
  /** {@link checkHasFreshLimitUsage} of the report now. */
  hasFreshUsage: boolean;
  quietMs: number | null;
  nowMs: number;
  windows?: LimitNoteWindows;
}): LimitNoteDecision {
  const { moment, record, intervalMs, nowMs } = input;
  const windows = input.windows ?? defaultLimitNoteWindows;
  const gateReasons = listReasons([
    (record?.lastOrchestratedAt === undefined || nowMs - record.lastOrchestratedAt > windows.orchestrationWindowMs) && limitNoteSkipReasons.notOrchestrating,
    intervalMs === null && limitNoteSkipReasons.off,
    !input.hasFreshUsage && limitNoteSkipReasons.noFreshUsage,
  ]);
  if (gateReasons.length > 0 || intervalMs === null) return { shape: null, skipReasons: gateReasons };

  const lastLookAtMs = getLastLookAtMs(record);
  const lastNoteAtMs = record?.lastNoteAt;
  const reminderReasons = listReasons([
    moment === 'sendResult' && limitNoteSkipReasons.noReminderAtMoment,
    moment !== 'sendResult' && lastLookAtMs !== null && nowMs - lastLookAtMs < intervalMs && limitNoteSkipReasons.notDue,
  ]);
  if (reminderReasons.length === 0) return { shape: 'reminder', skipReasons: [] };

  const summaryReasons = listReasons([
    moment === 'midTurn' && limitNoteSkipReasons.noSummaryAtMoment,
    moment === 'turnStart' && (input.quietMs === null || input.quietMs < windows.minQuietMs) && limitNoteSkipReasons.notQuiet,
    record?.fingerprint === input.fingerprint && limitNoteSkipReasons.unchanged,
    lastNoteAtMs !== undefined && nowMs - lastNoteAtMs < windows.summaryFloorMs && limitNoteSkipReasons.summaryFloor,
  ]);
  if (summaryReasons.length === 0) return { shape: 'summary', skipReasons: [] };
  return { shape: null, skipReasons: [...reminderReasons, ...summaryReasons] };
}

// ── the figures ──

/** The accounts the note speaks of: the ones the operator's `/limits` list lets agents use. */
function listOfferedEntries(report: ClaudeProfilesReport): ClaudeProfileReportEntry[] {
  return report.profiles.filter((entry) => entry.chainExclusion === null);
}

function getEntryBucket(entry: ClaudeProfileReportEntry, kind: ClaudeUsageBucket['kind']): ClaudeUsageBucket | null {
  return entry.buckets.find((bucket) => bucket.kind === kind) ?? null;
}

/** The used percent of the five-hour window as of `nowMs`; `null` when the entry has none. */
function getSessionPercent(entry: ClaudeProfileReportEntry, nowMs: number): number | null {
  const bucket = getEntryBucket(entry, 'session');
  return bucket === null ? null : getClaudeUsagePercentAsOf(bucket, nowMs);
}

/** Whether a NEW worker would not start on the account for want of room in its five-hour window (the launch ceiling). */
function checkIsSessionFull(entry: ClaudeProfileReportEntry, nowMs: number): boolean {
  const percent = getSessionPercent(entry, nowMs);
  return percent !== null && percent >= claudeLaunchSessionCeilingPercent;
}

/** A weekly window's used percent as of `nowMs` and the time to its reset (`null` when none is ahead). */
interface WeeklyFigure {
  percent: number;
  resetIn: string | null;
}

function getWeeklyFigure(bucket: ClaudeUsageBucket, nowMs: number): WeeklyFigure {
  const resetMs = bucket.resetsAt === null ? Number.NaN : Date.parse(bucket.resetsAt);
  const isResetAhead = Number.isFinite(resetMs) && resetMs > nowMs;
  return {
    percent: getClaudeUsagePercentAsOf(bucket, nowMs),
    // A window whose reset has passed shows no countdown: nothing says when its next period ends.
    resetIn: isResetAhead ? formatClaudeUsageRelativeReset(bucket.resetsAt, nowMs, limitNoteResetWords) : null,
  };
}

/** The account's weekly figure; `null` = «usage unknown» (a stale snapshot, no weekly window) and for an API account, which has none. */
function getEntryWeeklyFigure(entry: ClaudeProfileReportEntry, nowMs: number): WeeklyFigure | null {
  const bucket = entry.isUsageStale ? null : getEntryBucket(entry, 'weekly_all');
  return bucket === null ? null : getWeeklyFigure(bucket, nowMs);
}

/** The ChatGPT subscription's usage snapshot, when the poller recorded one. */
function getChatGptUsage(openCodeUsage: OpenCodeProviderUsages): ClaudeUsageSnapshot | undefined {
  return openCodeUsage[chatGptProviderId]?.usage;
}

/** The ChatGPT weekly figure; `null` = «usage unknown» (stale, no weekly window). Call only when {@link getChatGptUsage} found a snapshot. */
function getChatGptWeeklyFigure(usage: ClaudeUsageSnapshot, nowMs: number): WeeklyFigure | null {
  const bucket = usage.isStale === true ? null : getClaudeUsageBucket(usage, 'weekly_all');
  return bucket === null ? null : getWeeklyFigure(bucket, nowMs);
}

/**
 * @description Whether the usage cache holds a figure worth a note: some account the operator's list offers has a snapshot that was
 * re-read at its last poll, or is billed to API credits (no windows by design) AND is one a launch would really use (it is in
 * `launchOrder`: held by the `/limits` list, not held off agents, its credit not used up). Nothing fresh at all → no note (a note of
 * «usage unknown» only would tell the agent nothing the tool does not).
 */
export function checkHasFreshLimitUsage(report: ClaudeProfilesReport): boolean {
  return listOfferedEntries(report).some((entry) => entry.loggedIn !== false
    && (entry.billing === 'api' ? report.launchOrder.includes(entry.name) : !entry.isUsageStale && entry.buckets.length > 0));
}

const unknownStep = '?';
const noWindowStep = '-';

function getPercentStep(percent: number): string {
  return Math.floor(percent / fingerprintPercentStep).toString();
}

function getWeeklyStep(figure: WeeklyFigure | null): string {
  return figure === null ? unknownStep : getPercentStep(figure.percent);
}

/**
 * @description The limits picture as a short stable string; two notes differ in content only when two fingerprints differ: the
 * account that would be recommended; for every account the operator's list offers its weekly use in 10-point steps (`?` unknown,
 * `-` an API account), whether it is usable now (`u` / `x`) and whether its five-hour window is past the launch ceiling (`f` / `o`);
 * the ChatGPT weekly use in 10-point steps (`-` none recorded).
 */
export function buildLimitNoteFingerprint(report: ClaudeProfilesReport, openCodeUsage: OpenCodeProviderUsages, nowMs: number): string {
  const accounts = listOfferedEntries(report).map((entry) => {
    const weeklyStep = entry.billing === 'api' ? noWindowStep : getWeeklyStep(getEntryWeeklyFigure(entry, nowMs));
    return `${entry.name}:${weeklyStep}${entry.isEligible ? 'u' : 'x'}${checkIsSessionFull(entry, nowMs) ? 'f' : 'o'}`;
  });
  const chatGptUsage = getChatGptUsage(openCodeUsage);
  const chatGptStep = chatGptUsage === undefined ? noWindowStep : getWeeklyStep(getChatGptWeeklyFigure(chatGptUsage, nowMs));
  return [`rec=${report.recommended ?? 'none'}`, ...accounts, `gpt=${chatGptStep}`].join('|');
}

// ── the texts ──

/** The reminder's last line: the instruction the summary leaves out. */
const reminderInstructionLine = 'Call claude_profiles right before your next launch or resume — the pick moves as limits fill and reset. No reply is needed.';

const noWorkerAccountSentence = 'No Claude account can take a new worker now';
const noWorkerAccountClause = 'no Claude account can take a new worker now';

function getNoteHeader(shape: LimitNoteShape, nowMs: number, timezone: string): string {
  const suffix = shape === 'summary' ? ' · changed' : '';
  return `${limitNoteMarker} · ${formatReminderTime(getZonedWallClock(timezone, nowMs))}${suffix}]`;
}

/**
 * The accounts after the pick, in the order a launch prefers them — the report's `launchOrder`, the SAME order the pick is the head
 * of (API credit the list holds first, then the usable subscriptions by the soonest weekly reset), never a second ranking.
 */
function listNextAccountEntries(report: ClaudeProfilesReport): ClaudeProfileReportEntry[] {
  return report.launchOrder
    .filter((name) => name !== report.recommended)
    .slice(0, limitNoteNextAccountCount)
    .flatMap((name) => report.profiles.filter((entry) => entry.name === name));
}

const usageUnknownWords = 'usage unknown';

/** What the bot estimates is left of an API account's credit (`≈ $61.20 left`); `null` when the operator gave it no figure. */
function formatApiCreditLeft(entry: ClaudeProfileReportEntry): string | null {
  return entry.remainingEstimateUsd === null ? null : `≈ ${formatUsd(entry.remainingEstimateUsd)} left`;
}

function formatApiCreditWords(entry: ClaudeProfileReportEntry): string {
  const left = formatApiCreditLeft(entry);
  return left === null ? 'API credit' : `API credit (${left})`;
}

/** What the reminder says of the account the pick names after its reason: `week 62 % used, resets in 1 d 19 h; 5 h 30 %`; `null` for an API account with no credit figure (its reason says it all). */
function formatReminderPickFigures(entry: ClaudeProfileReportEntry, nowMs: number): string | null {
  if (entry.billing === 'api') return formatApiCreditLeft(entry);
  const weekly = getEntryWeeklyFigure(entry, nowMs);
  if (weekly === null) return usageUnknownWords;
  const session = getSessionPercent(entry, nowMs);
  return `week ${weekly.percent} % used${weekly.resetIn === null ? '' : `, resets in ${weekly.resetIn}`}${session === null ? '' : `; 5 h ${session} %`}`;
}

/** What the reminder says of an account after the pick: `week 20 %, resets in 5 d`. */
function formatReminderNextFigures(entry: ClaudeProfileReportEntry, nowMs: number): string {
  if (entry.billing === 'api') return formatApiCreditWords(entry);
  const weekly = getEntryWeeklyFigure(entry, nowMs);
  return weekly === null ? usageUnknownWords : `week ${weekly.percent} %${weekly.resetIn === null ? '' : `, resets in ${weekly.resetIn}`}`;
}

/**
 * The first line: where the next new worker goes, why (the wording of `describeClaudeLaunchOutcome`, the one `claude_profiles` opens
 * with) and its figures — or that nothing can take one and what frees up first.
 */
function formatReminderPickLine(report: ClaudeProfilesReport, nowMs: number): string {
  const picked = report.profiles.find((entry) => entry.name === report.recommended);
  if (picked !== undefined) {
    const figures = formatReminderPickFigures(picked, nowMs);
    return `Next new Claude worker → ${picked.name} (${describeClaudeLaunchOutcome(report, null)})${figures === null ? '' : `: ${figures}`}.`;
  }
  const next = report.nextAvailable;
  return next === null ? `${noWorkerAccountSentence}.` : `${noWorkerAccountSentence}; ${next.profile} frees up in ${formatClaudeUsageRelativeReset(next.at, nowMs, limitNoteResetWords)}.`;
}

/** The reminder's ChatGPT sentence: `ChatGPT: week 40 %, resets in 3 d.`; `null` when no ChatGPT subscription usage is recorded. */
function formatReminderChatGptSentence(openCodeUsage: OpenCodeProviderUsages, nowMs: number): string | null {
  const usage = getChatGptUsage(openCodeUsage);
  if (usage === undefined) return null;
  const weekly = getChatGptWeeklyFigure(usage, nowMs);
  return `ChatGPT: ${weekly === null ? usageUnknownWords : `week ${weekly.percent} %${weekly.resetIn === null ? '' : `, resets in ${weekly.resetIn}`}`}.`;
}

function buildReminderText(report: ClaudeProfilesReport, openCodeUsage: OpenCodeProviderUsages, nowMs: number): string {
  const next = listNextAccountEntries(report).map((entry) => `${entry.name} (${formatReminderNextFigures(entry, nowMs)})`);
  const alsoSentences = [next.length === 0 ? null : `Then ${next.join(', ')}.`, formatReminderChatGptSentence(openCodeUsage, nowMs)].filter((sentence): sentence is string => sentence !== null);
  return [formatReminderPickLine(report, nowMs), ...(alsoSentences.length === 0 ? [] : [alsoSentences.join(' ')]), reminderInstructionLine].join('\n');
}

/** A weekly figure for the summary's one line: `71 % (resets in 1 d 16 h)` for the pick, `20 % (5 d)` for the rest. */
function formatSummaryFigure(figure: WeeklyFigure | null, isPick: boolean): string {
  if (figure === null) return usageUnknownWords;
  if (figure.resetIn === null) return `${figure.percent} %`;
  return `${figure.percent} % (${isPick ? `resets in ${figure.resetIn}` : figure.resetIn})`;
}

function formatSummaryEntry(entry: ClaudeProfileReportEntry, isPick: boolean, nowMs: number): string {
  const figures = entry.billing === 'api' ? formatApiCreditWords(entry) : formatSummaryFigure(getEntryWeeklyFigure(entry, nowMs), isPick);
  return `${entry.name} ${figures}${isPick ? ' → next new worker' : ''}`;
}

function buildSummaryText(report: ClaudeProfilesReport, openCodeUsage: OpenCodeProviderUsages, nowMs: number): string {
  const picked = report.profiles.find((entry) => entry.name === report.recommended);
  const chatGptUsage = getChatGptUsage(openCodeUsage);
  const items = [
    picked === undefined ? noWorkerAccountClause : formatSummaryEntry(picked, true, nowMs),
    ...listNextAccountEntries(report).map((entry) => formatSummaryEntry(entry, false, nowMs)),
    ...(chatGptUsage === undefined ? [] : [`ChatGPT ${formatSummaryFigure(getChatGptWeeklyFigure(chatGptUsage, nowMs), false)}`]),
  ];
  return `${items.join('; ')}.`;
}

/**
 * @description The note's text: `reminder` — three lines (the pick with its figures and why, the next one or two accounts and the
 * ChatGPT window, the instruction); `summary` — one line of the same figures. Both start with `[Accounts · HH:MM]` in `timezone`
 * (the summary adds `· changed`). The figures come from `report` (`buildClaudeProfilesCreditReport`: the SAME pick `claude_profiles`
 * gives) and `openCodeUsage` (`state.json` `openCodeProviderUsage`); a stale snapshot reads «usage unknown», a window whose reset has
 * passed 0 % with no countdown, an API account its credit estimate.
 */
export function buildLimitNoteText(
  shape: LimitNoteShape,
  report: ClaudeProfilesReport,
  openCodeUsage: OpenCodeProviderUsages,
  timezone: string,
  nowMs: number,
): string {
  const header = getNoteHeader(shape, nowMs, timezone);
  return shape === 'reminder'
    ? `${header} ${buildReminderText(report, openCodeUsage, nowMs)}`
    : `${header} ${buildSummaryText(report, openCodeUsage, nowMs)}`;
}
