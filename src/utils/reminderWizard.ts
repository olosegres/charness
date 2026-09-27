/**
 * @description Pure core of the `/reminders` wizard — the bot-LOCAL reminder
 * feature: an inline-button flow that produces a {@link ScheduleSpec} with ZERO
 * agent involvement (the `/schedule` path, by contrast, hands free text to the
 * agent and lets it call the `schedule_*` MCP tools).
 *
 * Everything here is pure: no I/O, no `Date.now()` (every entry point takes the
 * caller's `nowMs`), no telegraf, no `t()`. It returns STRUCTURED data —
 * keyboard PLANS carrying i18n KEY names plus `callback_data`, and structured
 * schedule descriptors — which `bot.ts` maps onto `Markup.inlineKeyboard` and
 * `t(...)`. The split is mandatory rather than stylistic: user-facing text lives
 * behind the ASYNC `t()` in 12 locales, so a pure layer that emitted prose could
 * neither be localized nor unit-tested, and `bot.ts` itself cannot be imported
 * by a test (its module-scope `parseEnv()` exits the process).
 *
 * Time math is HOST-LOCAL on purpose: the instance-wide `/timezone` setting is
 * applied to `process.env.TZ` at boot, so plain `Date` arithmetic already IS the
 * operator's clock and threading a zone through here would create a second
 * source of truth.
 */

import type { ScheduleSpec } from '../scheduler/types';
import { paginateList } from './paginateList';

// ─── vocabularies ────────────────────────────────────────────────────

/**
 * @name ReminderRepeatKind
 * @description How often a reminder fires. `once` is an absolute instant; the
 * other four map onto the exactly four cron shapes `describeCron`
 * (`scheduler/recurrence.ts`) renders as words — deliberate, so a
 * wizard-created job never shows up as a raw cron expression anywhere.
 */
export const reminderRepeatKinds = ['once', 'daily', 'weekdays', 'weekly', 'monthly'] as const;
export type ReminderRepeatKind = (typeof reminderRepeatKinds)[number];

export function checkIsReminderRepeatKind(value: string): value is ReminderRepeatKind {
  return (reminderRepeatKinds as readonly string[]).includes(value);
}

/**
 * @name ReminderWizardStep
 * @description Which screen the wizard is on. `dateGrid`, `dayOfMonthGrid`,
 * `hour` and `minute` are the "other …" expansions of their quick-pick steps —
 * separate steps rather than modes so `back` has one unambiguous meaning
 * everywhere.
 */
export const reminderWizardSteps = [
  'repeat',
  'date',
  'dateGrid',
  'weekday',
  'dayOfMonth',
  'dayOfMonthGrid',
  'time',
  'hour',
  'minute',
  'text',
] as const;
export type ReminderWizardStep = (typeof reminderWizardSteps)[number];

/** One wall-clock time of day, the wizard's time pick. */
export interface ReminderTimeOfDay {
  hour: number;
  minute: number;
}

/** Quick-pick times offered on the time step, in render order. */
export const reminderQuickTimes: readonly ReminderTimeOfDay[] = [
  { hour: 9, minute: 0 },
  { hour: 12, minute: 0 },
  { hour: 18, minute: 0 },
  { hour: 21, minute: 0 },
];

/**
 * Granularity of the custom-minute grid. Five minutes keeps the grid at 12
 * buttons (4 rows of 3) — a full 0–59 grid would need 60, which is past
 * Telegram's comfortable keyboard size and unreadable on a phone.
 */
export const reminderMinuteStep = 5;

/** Cron `dow` values in Monday-first DISPLAY order (Sunday is `0` in cron). */
export const reminderWeekdayDisplayOrder: readonly number[] = [1, 2, 3, 4, 5, 6, 0];

/** Quick-pick days of the month, laid out as rendered (3 per row). */
const reminderQuickDayOfMonthRows: readonly (readonly number[])[] = [
  [1, 5, 10],
  [15, 20, 25],
];

/** Repeat buttons, laid out as rendered. */
const reminderRepeatKindRows: readonly (readonly ReminderRepeatKind[])[] = [
  ['once', 'daily'],
  ['weekdays', 'weekly'],
  ['monthly'],
];

/** Weekday buttons per row on the weekday step (Mon Tue Wed / Thu Fri Sat / Sun). */
const reminderWeekdayColumns = 3;
/** Date buttons per row in the "other date" grid (`DD.MM` labels). */
const reminderDateGridColumns = 4;
/** Day buttons per row in the full 1–31 grid. */
const reminderDayOfMonthGridColumns = 7;
/** Hour buttons per row in the custom-hour grid. */
const reminderHourGridColumns = 4;
/** Minute buttons per row in the custom-minute grid. */
const reminderMinuteGridColumns = 3;

/**
 * First day offered by the "other date" grid. `0` (today) and `1` (tomorrow)
 * already have their own buttons on the date step, so the grid starts after
 * them instead of repeating two entries.
 */
const reminderDateGridStartOffsetDays = 2;
/** How many days the "other date" grid offers (4 full rows of 4). */
const reminderDateGridDayCount = 16;

/** Highest day-of-month a cron `dom` field accepts. */
const maxDayOfMonth = 31;
const hoursPerDay = 24;
const minutesPerHour = 60;
const maxWeekdayValue = 6;
/** Field count of a 5-field cron expression (`min hour dom mon dow`). */
const cronFieldCount = 5;
/** Cron `dow` field for Monday–Friday — the shape `describeCron` calls "weekdays". */
const weekdaysCronDayOfWeek = '1-5';
/** Cron wildcard for an unconstrained field. */
const cronWildcard = '*';

// ─── label keys ──────────────────────────────────────────────────────

/**
 * @description i18n keys the keyboard plans reference. Collected in one object
 * so the strings exist exactly once (and so the i18n scope has a single list to
 * mirror into every locale); the pure layer never resolves them.
 */
export const reminderLabelKeys = {
  hubAdd: 'reminders.addButton',
  hubList: 'reminders.listButton',
  repeatOnce: 'reminders.repeatOnceButton',
  repeatDaily: 'reminders.repeatDailyButton',
  repeatWeekdays: 'reminders.repeatWeekdaysButton',
  repeatWeekly: 'reminders.repeatWeeklyButton',
  repeatMonthly: 'reminders.repeatMonthlyButton',
  dateToday: 'reminders.dateTodayButton',
  dateTomorrow: 'reminders.dateTomorrowButton',
  dateOther: 'reminders.dateOtherButton',
  dayOfMonthOther: 'reminders.dayOfMonthOtherButton',
  timeOther: 'reminders.timeOtherButton',
  back: 'reminders.backButton',
  cancel: 'reminders.cancelButton',
  listPrev: 'reminders.listPrevButton',
  listNext: 'reminders.listNextButton',
  listBackToHub: 'reminders.listBackToHubButton',
  cardDelete: 'reminders.cardDeleteButton',
  cardBackToList: 'reminders.cardBackToListButton',
} as const;

/**
 * Weekday button label keys, indexed by CRON `dow` value (Sunday = 0) so the
 * display order and the stored value never drift apart.
 */
export const reminderWeekdayLabelKeys: readonly string[] = [
  'reminders.weekdaySundayButton',
  'reminders.weekdayMondayButton',
  'reminders.weekdayTuesdayButton',
  'reminders.weekdayWednesdayButton',
  'reminders.weekdayThursdayButton',
  'reminders.weekdayFridayButton',
  'reminders.weekdaySaturdayButton',
];

/**
 * Repeat-kind → its button label key. Exported because the wizard's running
 * summary ("Repeat: Every day") must name the pick with the SAME word its button
 * carried — a second wording would read as a different option.
 */
export const reminderRepeatLabelKeys: Readonly<Record<ReminderRepeatKind, string>> = {
  once: reminderLabelKeys.repeatOnce,
  daily: reminderLabelKeys.repeatDaily,
  weekdays: reminderLabelKeys.repeatWeekdays,
  weekly: reminderLabelKeys.repeatWeekly,
  monthly: reminderLabelKeys.repeatMonthly,
};

// ─── keyboard plan ───────────────────────────────────────────────────

/**
 * @name ReminderButtonLabel
 * @description A button's caption: either an i18n `key` (worded labels, which
 * must be translated) or a locale-neutral `literal` (clock times, dates,
 * numbers, a reminder's own name — translating those would be wrong).
 */
export type ReminderButtonLabel =
  | { kind: 'key'; key: string; vars?: Readonly<Record<string, string | number>> }
  | { kind: 'literal'; text: string }
  /**
   * A list row — `🔔 <name> · <localized schedule>`. Carried as its PARTS rather
   * than a `key` label because the schedule wording is itself a `t()` lookup, so
   * the caption can only be composed where `t` lives; a `key` label's `vars` must
   * already be resolved, which would force this layer to inline English.
   */
  | { kind: 'listRow'; name: string; descriptor: ReminderScheduleDescriptor };

/** One inline button, as a plan `bot.ts` turns into `Markup.button.callback`. */
export interface ReminderButtonPlan {
  label: ReminderButtonLabel;
  callbackData: string;
}

/** Rows of buttons — the plan form of `Markup.inlineKeyboard`. */
export type ReminderKeyboardPlan = ReminderButtonPlan[][];

function buildKeyButton(key: string, callbackData: string): ReminderButtonPlan {
  return { label: { kind: 'key', key }, callbackData };
}

function buildLiteralButton(text: string, callbackData: string): ReminderButtonPlan {
  return { label: { kind: 'literal', text }, callbackData };
}

/** Split a flat button list into rows of at most `columns` entries. */
function getButtonRows(buttons: readonly ReminderButtonPlan[], columns: number): ReminderKeyboardPlan {
  const rows: ReminderKeyboardPlan = [];
  for (let index = 0; index < buttons.length; index += columns) {
    rows.push(buttons.slice(index, index + columns));
  }
  return rows;
}

// ─── callback codec ──────────────────────────────────────────────────

/**
 * Wizard `callback_data` prefix. Every wizard button also bakes in the wizard
 * id, because an inline keyboard stays tappable forever: without it a tap on a
 * wizard the operator abandoned hours ago would feed picks into whatever wizard
 * is live now (the same class of bug the `/disconnect` picker's per-message
 * snapshot and `acl_skip_<fireAt>`'s baked instant guard against).
 */
export const reminderWizardCallbackPrefix = 'rw_';

/**
 * Max wizard-id length. Bounded so the longest producible `callback_data` is
 * provably inside Telegram's 64-byte cap, and so a malformed id can never make
 * the anchored matcher accept garbage.
 */
export const reminderWizardIdMaxLength = 12;

/** Short action tokens carried by a wizard callback (the wire vocabulary). */
const reminderWizardTokens = {
  repeat: 'r',
  dateGrid: 'dg',
  date: 'd',
  weekday: 'w',
  dayOfMonthGrid: 'mg',
  dayOfMonth: 'm',
  quickTime: 'q',
  hourGrid: 'hg',
  hour: 'h',
  minute: 'i',
  back: 'b',
  cancel: 'x',
} as const;

/** Digits in the compact `YYYYMMDD` date argument. */
const compactDateLength = 8;

/**
 * Anchored matcher for `bot.action(...)`. Built from the id-length constant so
 * the wire format has exactly one definition. The id charset excludes `_`
 * precisely because `_` is the field separator.
 */
export const reminderWizardCallbackRe = new RegExp(
  `^${reminderWizardCallbackPrefix}([A-Za-z0-9]{1,${reminderWizardIdMaxLength}})_([a-z]{1,2})(?:_(\\d{1,${compactDateLength}}))?$`,
);

/**
 * @name ReminderWizardAction
 * @description A decoded wizard tap. `pick*` commits a value, `open*` descends
 * into a custom grid, and `back`/`cancel` are valid on every step.
 */
export type ReminderWizardAction =
  | { kind: 'pickRepeat'; repeatKind: ReminderRepeatKind }
  | { kind: 'openDateGrid' }
  | { kind: 'pickDate'; dateIso: string }
  | { kind: 'pickWeekday'; weekday: number }
  | { kind: 'openDayOfMonthGrid' }
  | { kind: 'pickDayOfMonth'; dayOfMonth: number }
  | { kind: 'pickQuickTime'; hour: number; minute: number }
  | { kind: 'openHourGrid' }
  | { kind: 'pickHour'; hour: number }
  | { kind: 'pickMinute'; minute: number }
  | { kind: 'back' }
  | { kind: 'cancel' };

/** A decoded wizard callback: which wizard it belongs to, and what it asks for. */
export interface ReminderWizardCallback {
  wizardId: string;
  action: ReminderWizardAction;
}

/**
 * @description Mint a wizard id from the caller's clock: base36 of the epoch ms.
 * Pure (the instant is an argument), 8–9 chars, and monotonically increasing —
 * so a freshly opened wizard can never collide with the one it replaced, which
 * is the whole point of the stale-tap guard.
 */
export function createReminderWizardId(nowMs: number): string {
  return Math.floor(nowMs).toString(36);
}

function buildWizardCallback(wizardId: string, token: string, argument?: number | string): string {
  const suffix = argument === undefined ? '' : `_${argument}`;
  return `${reminderWizardCallbackPrefix}${wizardId}_${token}${suffix}`;
}

export function buildReminderRepeatCallback(wizardId: string, repeatKind: ReminderRepeatKind): string {
  return buildWizardCallback(wizardId, reminderWizardTokens.repeat, reminderRepeatKinds.indexOf(repeatKind));
}

export function buildReminderDateGridCallback(wizardId: string): string {
  return buildWizardCallback(wizardId, reminderWizardTokens.dateGrid);
}

export function buildReminderDateCallback(wizardId: string, dateIso: string): string {
  return buildWizardCallback(wizardId, reminderWizardTokens.date, encodeCompactDate(dateIso));
}

export function buildReminderWeekdayCallback(wizardId: string, weekday: number): string {
  return buildWizardCallback(wizardId, reminderWizardTokens.weekday, weekday);
}

export function buildReminderDayOfMonthGridCallback(wizardId: string): string {
  return buildWizardCallback(wizardId, reminderWizardTokens.dayOfMonthGrid);
}

export function buildReminderDayOfMonthCallback(wizardId: string, dayOfMonth: number): string {
  return buildWizardCallback(wizardId, reminderWizardTokens.dayOfMonth, dayOfMonth);
}

export function buildReminderQuickTimeCallback(wizardId: string, quickTimeIndex: number): string {
  return buildWizardCallback(wizardId, reminderWizardTokens.quickTime, quickTimeIndex);
}

export function buildReminderHourGridCallback(wizardId: string): string {
  return buildWizardCallback(wizardId, reminderWizardTokens.hourGrid);
}

export function buildReminderHourCallback(wizardId: string, hour: number): string {
  return buildWizardCallback(wizardId, reminderWizardTokens.hour, hour);
}

export function buildReminderMinuteCallback(wizardId: string, minute: number): string {
  return buildWizardCallback(wizardId, reminderWizardTokens.minute, minute);
}

export function buildReminderBackCallback(wizardId: string): string {
  return buildWizardCallback(wizardId, reminderWizardTokens.back);
}

export function buildReminderCancelCallback(wizardId: string): string {
  return buildWizardCallback(wizardId, reminderWizardTokens.cancel);
}

/**
 * @description Decode one wizard `callback_data`, or `null` when it is not ours
 * / malformed / carries an out-of-range argument.
 *
 * Range and calendar validation happens HERE rather than at apply time so an
 * impossible value (weekday `9`, `2026-02-31`, a minute off the 5-minute grid)
 * can never reach the spec assembler — a forged or truncated callback is
 * indistinguishable from a stale one to the caller, and both must be inert.
 */
export function parseReminderWizardCallback(callbackData: string): ReminderWizardCallback | null {
  const match = reminderWizardCallbackRe.exec(callbackData);
  if (!match) return null;
  const wizardId = match[1];
  const token = match[2];
  const rawArgument = match[3];
  const action = getWizardAction(token, rawArgument);
  return action === null ? null : { wizardId, action };
}

function getWizardAction(token: string, rawArgument: string | undefined): ReminderWizardAction | null {
  switch (token) {
    case reminderWizardTokens.back:
      return rawArgument === undefined ? { kind: 'back' } : null;
    case reminderWizardTokens.cancel:
      return rawArgument === undefined ? { kind: 'cancel' } : null;
    case reminderWizardTokens.dateGrid:
      return rawArgument === undefined ? { kind: 'openDateGrid' } : null;
    case reminderWizardTokens.dayOfMonthGrid:
      return rawArgument === undefined ? { kind: 'openDayOfMonthGrid' } : null;
    case reminderWizardTokens.hourGrid:
      return rawArgument === undefined ? { kind: 'openHourGrid' } : null;
    case reminderWizardTokens.repeat: {
      const repeatKind = rawArgument === undefined ? undefined : reminderRepeatKinds[Number(rawArgument)];
      return repeatKind === undefined ? null : { kind: 'pickRepeat', repeatKind };
    }
    case reminderWizardTokens.date: {
      const dateIso = rawArgument === undefined ? null : decodeCompactDate(rawArgument);
      return dateIso === null ? null : { kind: 'pickDate', dateIso };
    }
    case reminderWizardTokens.weekday: {
      const weekday = getBoundedNumber(rawArgument, 0, maxWeekdayValue);
      return weekday === null ? null : { kind: 'pickWeekday', weekday };
    }
    case reminderWizardTokens.dayOfMonth: {
      const dayOfMonth = getBoundedNumber(rawArgument, 1, maxDayOfMonth);
      return dayOfMonth === null ? null : { kind: 'pickDayOfMonth', dayOfMonth };
    }
    case reminderWizardTokens.quickTime: {
      const index = getBoundedNumber(rawArgument, 0, reminderQuickTimes.length - 1);
      if (index === null) return null;
      const quickTime = reminderQuickTimes[index];
      return { kind: 'pickQuickTime', hour: quickTime.hour, minute: quickTime.minute };
    }
    case reminderWizardTokens.hour: {
      const hour = getBoundedNumber(rawArgument, 0, hoursPerDay - 1);
      return hour === null ? null : { kind: 'pickHour', hour };
    }
    case reminderWizardTokens.minute: {
      const minute = getBoundedNumber(rawArgument, 0, minutesPerHour - 1);
      if (minute === null || minute % reminderMinuteStep !== 0) return null;
      return { kind: 'pickMinute', minute };
    }
    default:
      return null;
  }
}

/** A callback argument parsed as an in-range integer, or `null`. */
function getBoundedNumber(rawArgument: string | undefined, min: number, max: number): number | null {
  if (rawArgument === undefined) return null;
  const value = Number(rawArgument);
  if (!Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

// ─── hub / list / card codec ─────────────────────────────────────────

/** Hub → open the add wizard. */
export const reminderAddCallback = 'rmadd';
/** → the hub screen (from the list). */
export const reminderHubCallback = 'rmhub';
/**
 * Dismiss the reminders screen (hub / done card): the message is relabelled and
 * its keyboard dropped. Declared here with the other flat `rm*` ids so the whole
 * reminder callback namespace has ONE definition site and a future id cannot
 * silently collide; the row it sits on is composed by the screen builder.
 */
export const reminderCloseCallback = 'rmclose';

const reminderListPageCallbackPrefix = 'rmlp_';
const reminderCardCallbackPrefix = 'rmc_';
const reminderDeleteCallbackPrefix = 'rmdel_';

/** Anchored matchers for `bot.action(...)`, beside their builders. */
export const reminderListPageCallbackRe = /^rmlp_(\d+)$/;
export const reminderCardCallbackRe = /^rmc_(\d+)$/;
/**
 * The id charset mirrors `generateScheduleId` output — `slugify` lowercases and
 * collapses everything else to hyphens, so lowercase alnum + `-` is the full
 * alphabet a real reminder id can contain. A forged id still parses and simply
 * resolves to `notFound` (see {@link getReminderDeleteTarget}).
 */
export const reminderDeleteCallbackRe = /^rmdel_([a-z0-9-]+)$/;

export function buildReminderListPageCallback(page: number): string {
  return `${reminderListPageCallbackPrefix}${page}`;
}

/** A list row's button — the ABSOLUTE index into the thread's reminder list. */
export function buildReminderCardCallback(reminderIndex: number): string {
  return `${reminderCardCallbackPrefix}${reminderIndex}`;
}

/**
 * @description The card's delete button. Carries the reminder's OWN id, never a
 * positional index: deletion is destructive and an old keyboard stays tappable,
 * so an index resolved against a list that has since changed would delete a
 * DIFFERENT reminder. A schedule id is `slugify(name)` (≤40) + `-` + a 6-char
 * suffix, so prefix + id stays well inside the 64-byte cap.
 */
export function buildReminderDeleteCallback(reminderId: string): string {
  return `${reminderDeleteCallbackPrefix}${reminderId}`;
}

export function parseReminderListPageCallback(callbackData: string): number | null {
  const match = reminderListPageCallbackRe.exec(callbackData);
  return match ? Number(match[1]) : null;
}

export function parseReminderCardCallback(callbackData: string): number | null {
  const match = reminderCardCallbackRe.exec(callbackData);
  return match ? Number(match[1]) : null;
}

export function parseReminderDeleteCallback(callbackData: string): string | null {
  const match = reminderDeleteCallbackRe.exec(callbackData);
  return match ? match[1] : null;
}

// ─── wizard state ────────────────────────────────────────────────────

/**
 * @name ReminderWizardState
 * @description Everything the wizard has collected. `bot.ts` keeps one of these
 * per thread and re-renders the SAME message from it on every tap, so the whole
 * flow occupies exactly one Telegram message.
 *
 * Only ONE of `dateIso` / `weekday` / `dayOfMonth` is ever set — which one is
 * decided by `repeatKind` (`daily` and `weekdays` need none of them).
 */
export interface ReminderWizardState {
  wizardId: string;
  step: ReminderWizardStep;
  repeatKind: ReminderRepeatKind | null;
  /** Local calendar date `YYYY-MM-DD` for a `once` reminder. */
  dateIso: string | null;
  /** Cron `dow` (Sunday = 0) for a `weekly` reminder. */
  weekday: number | null;
  /** 1–31 for a `monthly` reminder. */
  dayOfMonth: number | null;
  /** Set on the `minute` step so its header can render `21:__`. */
  hour: number | null;
  minute: number | null;
  /**
   * The reminder text the operator already sent, retained so it is NEVER asked
   * for twice. It is set only when a `once` instant went stale while they were
   * typing: the wizard then re-asks the TIME alone (see
   * {@link getReminderStateForRetime}), and the next time pick creates the
   * reminder straight from this text.
   */
  text: string | null;
}

/** A fresh wizard, parked on the repeat step with nothing picked. */
export function createReminderWizardState(wizardId: string): ReminderWizardState {
  return {
    wizardId,
    step: 'repeat',
    repeatKind: null,
    dateIso: null,
    weekday: null,
    dayOfMonth: null,
    hour: null,
    minute: null,
    text: null,
  };
}

/**
 * @description The step that follows the repeat pick. `daily` and `weekdays`
 * need no second pick at all, so they SKIP straight to the time step — the one
 * reason this is a function of the state rather than a fixed sequence.
 */
export function getReminderStepAfterRepeat(repeatKind: ReminderRepeatKind): ReminderWizardStep {
  switch (repeatKind) {
    case 'once':
      return 'date';
    case 'weekly':
      return 'weekday';
    case 'monthly':
      return 'dayOfMonth';
    case 'daily':
    case 'weekdays':
      return 'time';
  }
}

/**
 * @description Where `back` lands, or `null` for "leave the wizard and show the
 * hub" (which is what back means on the first step).
 *
 * Reads the repeat kind because the step BEFORE the time step differs per kind
 * — and is the repeat step itself for `daily` / `weekdays`, which have no second
 * step to return to.
 */
export function getReminderPreviousStep(state: ReminderWizardState): ReminderWizardStep | null {
  switch (state.step) {
    case 'repeat':
      return null;
    case 'date':
    case 'weekday':
    case 'dayOfMonth':
      return 'repeat';
    case 'dateGrid':
      return 'date';
    case 'dayOfMonthGrid':
      return 'dayOfMonth';
    case 'time': {
      if (state.repeatKind === null) return 'repeat';
      const secondStep = getReminderStepAfterRepeat(state.repeatKind);
      return secondStep === 'time' ? 'repeat' : secondStep;
    }
    case 'hour':
      return 'time';
    case 'minute':
      return 'hour';
    case 'text':
      return 'time';
  }
}

/**
 * @description The state as it must look when the wizard RE-ENTERS `step`: the
 * picks owned by that step and by every later step are cleared, so stepping back
 * into a screen never silently keeps the value the operator came to change.
 *
 * The three date/weekday/day-of-month fields are cleared together because they
 * are mutually exclusive alternatives of the same (second) step.
 *
 * An already-captured `text` is the ONE thing no re-entry clears: the operator
 * types it exactly once, and re-picking the schedule is not a reason to ask again.
 */
export function getReminderStateForStep(
  state: ReminderWizardState,
  step: ReminderWizardStep,
): ReminderWizardState {
  switch (step) {
    case 'repeat':
      return { ...createReminderWizardState(state.wizardId), step: 'repeat', text: state.text };
    case 'date':
    case 'dateGrid':
    case 'weekday':
    case 'dayOfMonth':
    case 'dayOfMonthGrid':
      return { ...state, step, dateIso: null, weekday: null, dayOfMonth: null, hour: null, minute: null };
    case 'time':
    case 'hour':
      return { ...state, step, hour: null, minute: null };
    case 'minute':
      return { ...state, step, minute: null };
    case 'text':
      return { ...state, step };
  }
}

/**
 * @description The state to re-render when the reminder text is already in hand
 * but the picked `once` instant has gone by while the operator was typing: back on
 * the TIME step, with the text RETAINED.
 *
 * Retaining it is the whole point. The flow is buttons precisely so the operator
 * types exactly once, and re-entering the text step to collect the same sentence
 * again defeats that — so only the time is re-asked, and the next time pick creates
 * the reminder outright (see {@link getReminderActionAfterTime}).
 */
export function getReminderStateForRetime(
  state: ReminderWizardState,
  text: string,
): ReminderWizardState {
  return getReminderStateForStep({ ...state, text }, 'time');
}

// ─── transitions ─────────────────────────────────────────────────────

/**
 * @name ReminderWizardErrorCode
 * @description Machine-readable reasons a step cannot be completed, so `bot.ts`
 * picks the i18n key. `pastTime` is the load-bearing one: «today» plus a time
 * that has already gone by must SAY so on the time step, never silently roll the
 * reminder to tomorrow (a locked product decision — a silent roll means the
 * operator is reminded 24h off what they asked for).
 *
 * `invalidDate` and `invalidTime` are deliberately separate: a date that does not
 * exist sends the operator back to the DATE step, whereas a wall-clock time a DST
 * spring-forward skips happens on a perfectly good date and must send them back to
 * the TIME step — one code for both told them to re-pick a date that was fine.
 */
export const reminderWizardErrorCodes = [
  'pastTime',
  'invalidDate',
  'invalidTime',
  'textTooLong',
] as const;
export type ReminderWizardErrorCode = (typeof reminderWizardErrorCodes)[number];

/**
 * The subset a SPEC assembly can fail with. `textTooLong` is raised when the
 * reminder text is captured, long after the spec is decidable, so it is excluded
 * here rather than left representable in a result that can never carry it.
 */
export type ReminderSpecErrorCode = Exclude<ReminderWizardErrorCode, 'textTooLong'>;

/**
 * @name ReminderWizardTransition
 * @description What the caller must do after a tap.
 *  - `render`     — re-render `state.step` into the same message.
 *  - `awaitText`  — every pick is in; arm the "send me the reminder text" step
 *                   (a typed message or a voice note).
 *  - `createNow`  — every pick is in AND the text is already held (the operator
 *                   sent it before the picked instant went stale): create the
 *                   reminder immediately, without re-entering the text step.
 *  - `cancelled`  — terminal; drop the wizard.
 *  - `backToHub`  — leave the wizard, show the hub.
 *  - `error`      — re-render `state.step` WITH the error; nothing was committed.
 *  - `expired`    — a stale/foreign tap: answer "expired" and change NOTHING.
 */
export type ReminderWizardTransition =
  | { kind: 'render'; state: ReminderWizardState }
  | { kind: 'awaitText'; state: ReminderWizardState }
  | { kind: 'createNow'; state: ReminderWizardState; spec: ScheduleSpec; text: string }
  | { kind: 'cancelled' }
  | { kind: 'backToHub' }
  | { kind: 'error'; code: ReminderWizardErrorCode; state: ReminderWizardState }
  | { kind: 'expired' };

/**
 * @name ReminderAfterTimeAction
 * @description What the wizard does once a time pick has been validated: ASK for
 * the reminder text (step 4, the normal first pass), or CREATE straight away
 * because the state already carries it.
 */
export type ReminderAfterTimeAction =
  | { kind: 'askText' }
  | { kind: 'createNow'; text: string };

/**
 * @description Decide whether the text step is still owed. A state that HOLDS the
 * text is past it: the operator sent it, the picked `once` instant then went stale
 * while they typed, and this is the replacement time pick — so the reminder is
 * created from the text already in hand. Re-asking here would make them type the
 * same note twice, which is exactly what the button flow exists to avoid.
 */
export function getReminderActionAfterTime(state: ReminderWizardState): ReminderAfterTimeAction {
  return state.text === null ? { kind: 'askText' } : { kind: 'createNow', text: state.text };
}

/** Whether an action can legitimately arrive while the wizard shows `step`. */
function checkIsActionAllowedOnStep(
  actionKind: ReminderWizardAction['kind'],
  step: ReminderWizardStep,
): boolean {
  switch (actionKind) {
    case 'back':
    case 'cancel':
      return true;
    case 'pickRepeat':
      return step === 'repeat';
    case 'openDateGrid':
      return step === 'date';
    case 'pickDate':
      return step === 'date' || step === 'dateGrid';
    case 'pickWeekday':
      return step === 'weekday';
    case 'openDayOfMonthGrid':
      return step === 'dayOfMonth';
    case 'pickDayOfMonth':
      return step === 'dayOfMonth' || step === 'dayOfMonthGrid';
    case 'pickQuickTime':
    case 'openHourGrid':
      return step === 'time';
    case 'pickHour':
      return step === 'hour';
    case 'pickMinute':
      return step === 'minute';
  }
}

/**
 * @description Apply one tapped `callback_data` to a wizard state.
 *
 * Takes the RAW callback string (not a pre-parsed action) so the stale-tap guard
 * cannot be forgotten at a call site: a tap whose baked wizard id is not this
 * wizard's — or that belongs to a step this wizard has left — returns `expired`
 * and mutates nothing.
 */
export function applyReminderWizardCallback(input: {
  state: ReminderWizardState;
  callbackData: string;
  nowMs: number;
}): ReminderWizardTransition {
  const { state, nowMs } = input;
  const parsed = parseReminderWizardCallback(input.callbackData);
  if (parsed === null || parsed.wizardId !== state.wizardId) return { kind: 'expired' };

  const { action } = parsed;
  if (!checkIsActionAllowedOnStep(action.kind, state.step)) return { kind: 'expired' };

  switch (action.kind) {
    case 'cancel':
      return { kind: 'cancelled' };
    case 'back': {
      const previousStep = getReminderPreviousStep(state);
      if (previousStep === null) return { kind: 'backToHub' };
      return { kind: 'render', state: getReminderStateForStep(state, previousStep) };
    }
    case 'pickRepeat': {
      // A repeat change invalidates every later SCHEDULE pick, so restart from a
      // clean state — but an already-captured text survives it, exactly as it
      // survives a `back` to the repeat step.
      const fresh = createReminderWizardState(state.wizardId);
      return {
        kind: 'render',
        state: {
          ...fresh,
          text: state.text,
          repeatKind: action.repeatKind,
          step: getReminderStepAfterRepeat(action.repeatKind),
        },
      };
    }
    case 'openDateGrid':
      return { kind: 'render', state: { ...state, step: 'dateGrid' } };
    case 'pickDate':
      return { kind: 'render', state: { ...state, dateIso: action.dateIso, step: 'time' } };
    case 'pickWeekday':
      return { kind: 'render', state: { ...state, weekday: action.weekday, step: 'time' } };
    case 'openDayOfMonthGrid':
      return { kind: 'render', state: { ...state, step: 'dayOfMonthGrid' } };
    case 'pickDayOfMonth':
      return { kind: 'render', state: { ...state, dayOfMonth: action.dayOfMonth, step: 'time' } };
    case 'openHourGrid':
      return { kind: 'render', state: { ...state, step: 'hour' } };
    case 'pickHour':
      return { kind: 'render', state: { ...state, hour: action.hour, step: 'minute' } };
    case 'pickQuickTime':
      return getTimeCommitTransition({ state, hour: action.hour, minute: action.minute, nowMs });
    case 'pickMinute': {
      // The minute grid is only reachable after an hour pick; a minute tap with
      // no hour in state is therefore a forged/raced callback, not a real screen.
      if (state.hour === null) return { kind: 'expired' };
      return getTimeCommitTransition({ state, hour: state.hour, minute: action.minute, nowMs });
    }
  }
}

/**
 * @description Commit the time pick — the moment the whole schedule becomes
 * decidable, and therefore the only place the past-time error can arise (the guard
 * itself lives in {@link buildReminderSpec}, so it covers every `once` date the
 * wizard can offer, not just «today»). On error the time is NOT committed, so the
 * operator can simply pick again — with any held text still on the screen.
 *
 * Which screen they pick on differs by cause. `pastTime` re-renders the screen the
 * tap came from, where a later minute is a valid fix. A DST-skipped time is skipped
 * for the WHOLE transition hour, so re-picking a minute inside it could only fail
 * again: that one returns to the time step, where the hour itself can be changed.
 */
function getTimeCommitTransition(input: {
  state: ReminderWizardState;
  hour: number;
  minute: number;
  nowMs: number;
}): ReminderWizardTransition {
  const withTime: ReminderWizardState = { ...input.state, hour: input.hour, minute: input.minute };
  const picks = getReminderPicksFromState(withTime);
  // Unreachable through the keyboards (every earlier pick is committed before
  // the time step renders); an incomplete state means a forged callback.
  if (picks === null) return { kind: 'expired' };

  const result = buildReminderSpec({ picks, nowMs: input.nowMs });
  if (!result.ok) {
    const errorState =
      result.code === 'invalidTime' ? getReminderStateForStep(input.state, 'time') : input.state;
    return { kind: 'error', code: result.code, state: errorState };
  }

  const nextState: ReminderWizardState = { ...withTime, step: 'text' };
  const afterTime = getReminderActionAfterTime(withTime);
  if (afterTime.kind === 'createNow') {
    return { kind: 'createNow', state: nextState, spec: result.spec, text: afterTime.text };
  }
  return { kind: 'awaitText', state: nextState };
}

// ─── step keyboards ──────────────────────────────────────────────────

/** The `back` + `cancel` row every wizard step carries. */
function buildWizardNavigationRow(wizardId: string): ReminderButtonPlan[] {
  return [
    buildKeyButton(reminderLabelKeys.back, buildReminderBackCallback(wizardId)),
    buildKeyButton(reminderLabelKeys.cancel, buildReminderCancelCallback(wizardId)),
  ];
}

/**
 * @description Build the keyboard plan for the wizard's CURRENT step.
 *
 * One dispatcher rather than a builder per step because `bot.ts` renders
 * whatever `state.step` says after every transition — it never needs to know
 * which screen it is drawing. `nowMs` is required because the date step's
 * buttons are dated at RENDER time (see {@link buildReminderDateCallback}).
 */
export function buildReminderStepKeyboard(input: {
  state: ReminderWizardState;
  nowMs: number;
}): ReminderKeyboardPlan {
  const { state, nowMs } = input;
  const { wizardId } = state;
  const navigationRow = buildWizardNavigationRow(wizardId);

  switch (state.step) {
    case 'repeat': {
      const rows = reminderRepeatKindRows.map((row) =>
        row.map((repeatKind) =>
          buildKeyButton(reminderRepeatLabelKeys[repeatKind], buildReminderRepeatCallback(wizardId, repeatKind)),
        ),
      );
      return [...rows, navigationRow];
    }
    case 'date': {
      const todayIso = formatReminderDateIso(getLocalDateAtDayOffset(nowMs, 0));
      const tomorrowIso = formatReminderDateIso(getLocalDateAtDayOffset(nowMs, 1));
      return [
        [
          buildKeyButton(reminderLabelKeys.dateToday, buildReminderDateCallback(wizardId, todayIso)),
          buildKeyButton(reminderLabelKeys.dateTomorrow, buildReminderDateCallback(wizardId, tomorrowIso)),
        ],
        [buildKeyButton(reminderLabelKeys.dateOther, buildReminderDateGridCallback(wizardId))],
        navigationRow,
      ];
    }
    case 'dateGrid': {
      const buttons: ReminderButtonPlan[] = [];
      for (let offset = 0; offset < reminderDateGridDayCount; offset += 1) {
        const date = getLocalDateAtDayOffset(nowMs, reminderDateGridStartOffsetDays + offset);
        const dateIso = formatReminderDateIso(date);
        buttons.push(
          buildLiteralButton(formatReminderDayMonth(date), buildReminderDateCallback(wizardId, dateIso)),
        );
      }
      return [...getButtonRows(buttons, reminderDateGridColumns), navigationRow];
    }
    case 'weekday': {
      const buttons = reminderWeekdayDisplayOrder.map((weekday) =>
        buildKeyButton(reminderWeekdayLabelKeys[weekday], buildReminderWeekdayCallback(wizardId, weekday)),
      );
      return [...getButtonRows(buttons, reminderWeekdayColumns), navigationRow];
    }
    case 'dayOfMonth': {
      const rows = reminderQuickDayOfMonthRows.map((row) =>
        row.map((dayOfMonth) =>
          buildLiteralButton(dayOfMonth.toString(), buildReminderDayOfMonthCallback(wizardId, dayOfMonth)),
        ),
      );
      return [
        ...rows,
        [buildKeyButton(reminderLabelKeys.dayOfMonthOther, buildReminderDayOfMonthGridCallback(wizardId))],
        navigationRow,
      ];
    }
    case 'dayOfMonthGrid': {
      const buttons: ReminderButtonPlan[] = [];
      for (let dayOfMonth = 1; dayOfMonth <= maxDayOfMonth; dayOfMonth += 1) {
        buttons.push(
          buildLiteralButton(dayOfMonth.toString(), buildReminderDayOfMonthCallback(wizardId, dayOfMonth)),
        );
      }
      return [...getButtonRows(buttons, reminderDayOfMonthGridColumns), navigationRow];
    }
    case 'time': {
      const quickRow = reminderQuickTimes.map((quickTime, quickTimeIndex) =>
        buildLiteralButton(formatReminderTime(quickTime), buildReminderQuickTimeCallback(wizardId, quickTimeIndex)),
      );
      return [
        quickRow,
        [buildKeyButton(reminderLabelKeys.timeOther, buildReminderHourGridCallback(wizardId))],
        navigationRow,
      ];
    }
    case 'hour': {
      const buttons: ReminderButtonPlan[] = [];
      for (let hour = 0; hour < hoursPerDay; hour += 1) {
        buttons.push(buildLiteralButton(padTwo(hour), buildReminderHourCallback(wizardId, hour)));
      }
      return [...getButtonRows(buttons, reminderHourGridColumns), navigationRow];
    }
    case 'minute': {
      const buttons: ReminderButtonPlan[] = [];
      for (let minute = 0; minute < minutesPerHour; minute += reminderMinuteStep) {
        buttons.push(buildLiteralButton(`:${padTwo(minute)}`, buildReminderMinuteCallback(wizardId, minute)));
      }
      return [...getButtonRows(buttons, reminderMinuteGridColumns), navigationRow];
    }
    case 'text':
      return [navigationRow];
  }
}

// ─── spec assembly ───────────────────────────────────────────────────

/**
 * @name ReminderSchedulePicks
 * @description A COMPLETE pick set — what the wizard state holds once every
 * screen has been answered. A union discriminated by `repeatKind` rather than
 * one shape with optional fields, so "weekly without a weekday" is not a
 * representable state and the assembler needs no defensive branches.
 */
export type ReminderSchedulePicks =
  | { repeatKind: 'once'; dateIso: string; hour: number; minute: number }
  | { repeatKind: 'daily'; hour: number; minute: number }
  | { repeatKind: 'weekdays'; hour: number; minute: number }
  /** `weekday` is a cron `dow` value (Sunday = 0). */
  | { repeatKind: 'weekly'; weekday: number; hour: number; minute: number }
  | { repeatKind: 'monthly'; dayOfMonth: number; hour: number; minute: number };

/**
 * @description Lift a complete pick set out of a wizard state, or `null` when a
 * pick the chosen repeat kind needs is still missing.
 */
export function getReminderPicksFromState(state: ReminderWizardState): ReminderSchedulePicks | null {
  const { repeatKind, hour, minute } = state;
  if (repeatKind === null || hour === null || minute === null) return null;
  switch (repeatKind) {
    case 'once':
      return state.dateIso === null ? null : { repeatKind: 'once', dateIso: state.dateIso, hour, minute };
    case 'weekly':
      return state.weekday === null ? null : { repeatKind: 'weekly', weekday: state.weekday, hour, minute };
    case 'monthly':
      return state.dayOfMonth === null
        ? null
        : { repeatKind: 'monthly', dayOfMonth: state.dayOfMonth, hour, minute };
    case 'daily':
      return { repeatKind: 'daily', hour, minute };
    case 'weekdays':
      return { repeatKind: 'weekdays', hour, minute };
  }
}

/** Outcome of {@link buildReminderSpec} — a typed result, never a throw. */
export type ReminderSpecResult =
  | { ok: true; spec: ScheduleSpec }
  | { ok: false; code: ReminderSpecErrorCode };

/**
 * @description Turn a complete pick set into a {@link ScheduleSpec}.
 *
 * The four recurring kinds emit exactly the cron shapes `describeCron`
 * (`scheduler/recurrence.ts`) renders as words — `m h * * *`, `m h * * 1-5`,
 * `m h * * d`, `m h D * *`. That is why the wizard offers these five options and
 * no others: any further shape would surface to the operator as a raw cron
 * expression. None of them can fire more often than daily, so
 * `minFireIntervalMs` is unreachable by construction.
 *
 * `once` is assembled in HOST-LOCAL time (the operator's `/timezone` is already
 * applied to `process.env.TZ`) and stored as a UTC ISO instant, which
 * `new Date(...)` round-trips exactly.
 */
export function buildReminderSpec(input: {
  picks: ReminderSchedulePicks;
  nowMs: number;
}): ReminderSpecResult {
  const { picks, nowMs } = input;
  const { hour, minute } = picks;

  switch (picks.repeatKind) {
    case 'daily':
      return { ok: true, spec: { kind: 'cron', cronExpr: buildCronExpr(minute, hour, cronWildcard, cronWildcard) } };
    case 'weekdays':
      return {
        ok: true,
        spec: { kind: 'cron', cronExpr: buildCronExpr(minute, hour, cronWildcard, weekdaysCronDayOfWeek) },
      };
    case 'weekly':
      return {
        ok: true,
        spec: { kind: 'cron', cronExpr: buildCronExpr(minute, hour, cronWildcard, picks.weekday.toString()) },
      };
    case 'monthly':
      return {
        ok: true,
        spec: {
          kind: 'cron',
          cronExpr: buildCronExpr(minute, hour, picks.dayOfMonth.toString(), cronWildcard),
        },
      };
    case 'once': {
      const resolved = createReminderInstant(picks.dateIso, hour, minute);
      if (!resolved.ok) return { ok: false, code: resolved.code };
      // A past instant is reported, never rolled forward: the operator asked for
      // a specific day, and firing 24h later would be a different reminder.
      if (resolved.instant.getTime() <= nowMs) return { ok: false, code: 'pastTime' };
      return { ok: true, spec: { kind: 'once', onceAtIso: resolved.instant.toISOString() } };
    }
  }
}

function buildCronExpr(minute: number, hour: number, dayOfMonth: string, dayOfWeek: string): string {
  return `${minute} ${hour} ${dayOfMonth} ${cronWildcard} ${dayOfWeek}`;
}

// ─── localizable descriptor ──────────────────────────────────────────

/**
 * @name ReminderScheduleDescriptor
 * @description A persisted spec, decomposed into the parts a LOCALIZED
 * rendering needs (list rows, the card). `describeSchedule` in
 * `scheduler/recurrence.ts` cannot serve this UI: it is English-only by design
 * (it is interpolated INTO i18n templates), while the reminder screens exist in
 * 12 locales.
 *
 * `raw` is the honest fallback for anything the wizard cannot create — an
 * agent-made `schedule_*` job may carry any cron shape, including an N-times
 * budget this descriptor has no field for. Its `text` is the bare cron
 * expression, rendered verbatim rather than mistranslated into a shape it is not.
 */
export type ReminderScheduleDescriptor =
  | { kind: 'daily'; time: string }
  | { kind: 'weekdays'; time: string }
  | { kind: 'weekly'; weekday: number; time: string }
  | { kind: 'monthly'; dayOfMonth: number; time: string }
  | { kind: 'once'; dateIso: string; time: string }
  | { kind: 'raw'; text: string };

/** Decompose a spec for localized rendering; see {@link ReminderScheduleDescriptor}. */
export function getReminderScheduleDescriptor(spec: ScheduleSpec): ReminderScheduleDescriptor {
  if (spec.kind === 'once') {
    const at = new Date(spec.onceAtIso);
    if (Number.isNaN(at.getTime())) return { kind: 'raw', text: spec.onceAtIso };
    return {
      kind: 'once',
      dateIso: formatReminderDateIso(at),
      time: formatReminderTime({ hour: at.getHours(), minute: at.getMinutes() }),
    };
  }

  const rawDescriptor: ReminderScheduleDescriptor = { kind: 'raw', text: spec.cronExpr };
  // An N-times job has a run budget no wizard shape carries; describing it as a
  // plain recurring reminder would hide that it expires.
  if (typeof spec.remainingRuns === 'number') return rawDescriptor;

  const fields = spec.cronExpr.trim().split(/\s+/);
  if (fields.length !== cronFieldCount) return rawDescriptor;
  const [minuteField, hourField, dayOfMonthField, monthField, dayOfWeekField] = fields;
  if (monthField !== cronWildcard) return rawDescriptor;

  const minute = getCronFieldNumber(minuteField, 0, minutesPerHour - 1);
  const hour = getCronFieldNumber(hourField, 0, hoursPerDay - 1);
  if (minute === null || hour === null) return rawDescriptor;
  const time = formatReminderTime({ hour, minute });

  if (dayOfMonthField === cronWildcard) {
    if (dayOfWeekField === cronWildcard) return { kind: 'daily', time };
    if (dayOfWeekField === weekdaysCronDayOfWeek) return { kind: 'weekdays', time };
    const weekday = getCronFieldNumber(dayOfWeekField, 0, maxWeekdayValue);
    return weekday === null ? rawDescriptor : { kind: 'weekly', weekday, time };
  }

  if (dayOfWeekField !== cronWildcard) return rawDescriptor;
  const dayOfMonth = getCronFieldNumber(dayOfMonthField, 1, maxDayOfMonth);
  return dayOfMonth === null ? rawDescriptor : { kind: 'monthly', dayOfMonth, time };
}

/** A plain-integer cron field within `[min, max]`, or `null` (step/range/list). */
function getCronFieldNumber(field: string, min: number, max: number): number | null {
  if (!/^\d{1,2}$/.test(field)) return null;
  const value = Number(field);
  return value >= min && value <= max ? value : null;
}

// ─── text shortening and name derivation ─────────────────────────────

/**
 * Longest reminder TEXT accepted from the operator. The text is interpolated into
 * the fire announcement and, alongside the schedule and next-run lines, into the
 * card and the created-screen — all of which are single Telegram messages under the
 * 4096-character cap. The bound therefore has to leave generous headroom for the
 * surrounding template in ANY of the 12 locales, which is why it sits far below
 * that cap rather than just under it. Past it the text is REJECTED, never
 * truncated: it is the operator's own words, and this all-buttons flow exists so
 * they type it exactly once.
 */
export const reminderTextMaxLength = 1000;

/**
 * Longest reminder name kept, INCLUDING the ellipsis. Matches `slugify`'s
 * `slugMaxLength` so the derived name and the id minted from it stay in step.
 */
export const reminderNameMaxLength = 40;

/**
 * Name used when the body text carries no letter or digit (whitespace only,
 * punctuation only, emoji only). A stable fallback rather than an empty row —
 * mirrors `slugify`'s `'job'` guarantee, which the id generator relies on.
 */
export const reminderNameFallback = 'reminder';

const reminderNameEllipsis = '…';

/**
 * Longest reminder text echoed back in the wizard's running summary. The summary
 * exists so the operator can SEE what was kept after a stale-instant retry — not to
 * reprint the whole note, which would push the step's question off the screen.
 */
export const reminderSummaryTextMaxLength = 80;

/**
 * @description `text` shortened to at most `maxLength` characters — the ellipsis
 * counted INSIDE that budget — cut on a word boundary when there is one. `''` when
 * the budget cannot even hold the ellipsis, leaving the caller to decide what an
 * empty result means.
 *
 * Shared by the derived reminder name, the wizard's text summary and the list-row
 * button caption, so they shorten identically instead of growing three slightly
 * different cuts.
 */
export function getShortenedText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const budget = maxLength - reminderNameEllipsis.length;
  if (budget <= 0) return '';
  const head = text.slice(0, budget);
  const lastSpaceIndex = head.lastIndexOf(' ');
  const cut = lastSpaceIndex > 0 ? head.slice(0, lastSpaceIndex) : head;
  return `${cut.trimEnd()}${reminderNameEllipsis}`;
}

/**
 * @description Derive a reminder's display name from its body text. The wizard
 * deliberately never ASKS for a name — one less typing step — so the list rows
 * and the card show the first words of the reminder itself.
 *
 * Whitespace is collapsed (a multi-line body must not render as a ragged row) and
 * the result never exceeds {@link reminderNameMaxLength}.
 */
export function getReminderNameFromText(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (!/[\p{L}\p{N}]/u.test(collapsed)) return reminderNameFallback;
  return getShortenedText(collapsed, reminderNameMaxLength);
}

// ─── hub, list and card plans ────────────────────────────────────────

/** Reminders listed per page. One row each, so the keyboard stays phone-sized. */
export const reminderListPageSize = 8;

/**
 * @name ReminderListRow
 * @description One reminder as the list/card screens consume it: its id (what a
 * delete tap carries), its derived display name, and its schedule decomposed for
 * localized rendering.
 */
export interface ReminderListRow {
  id: string;
  name: string;
  descriptor: ReminderScheduleDescriptor;
}

/**
 * @description The hub keyboard: «add» and «list» SIDE BY SIDE on one row (the
 * locked layout — «close» is a separate row the caller appends). «list» is drawn
 * only when there is something to list; a list button that opens an empty screen is
 * a dead end. The count rides as a label var so the caller can render "📋 List (3)".
 *
 * `isAddOffered` is the per-thread schedule CAP: at the cap there is nothing an
 * «add» tap could create, so the button is not drawn (same dead-end reasoning as
 * the list button). The caller owns that comparison — the cap lives in the
 * scheduler store, not here — and it defaults to offering «add».
 */
export function buildReminderHubKeyboard(
  reminderCount: number,
  options: { isAddOffered?: boolean } = {},
): ReminderKeyboardPlan {
  const actionRow: ReminderButtonPlan[] = [];
  if (options.isAddOffered !== false) {
    actionRow.push(buildKeyButton(reminderLabelKeys.hubAdd, reminderAddCallback));
  }
  if (reminderCount > 0) {
    actionRow.push({
      label: { kind: 'key', key: reminderLabelKeys.hubList, vars: { count: reminderCount } },
      callbackData: buildReminderListPageCallback(0),
    });
  }
  // Both suppressed at once (an empty thread under a non-positive cap): an EMPTY
  // row is not a keyboard Telegram accepts, so no row is emitted at all.
  return actionRow.length === 0 ? [] : [actionRow];
}

/**
 * @name ReminderListPlan
 * @description One rendered list page. `currentPage` is already CLAMPED by
 * {@link paginateList}, so a stale page index lands on the last real page
 * instead of rendering an empty body.
 */
export interface ReminderListPlan {
  /** The reminders visible on this page, in list order. */
  rows: ReminderListRow[];
  /** Zero-based, clamped. */
  currentPage: number;
  totalPages: number;
  hasPrev: boolean;
  hasNext: boolean;
  keyboard: ReminderKeyboardPlan;
}

/**
 * @description Build a list page: one row per reminder, then the prev/next
 * navigation (only the arrows the page can actually use), then back-to-hub.
 *
 * A row's CAPTION is the reminder's name plus its schedule — planned as a `listRow`
 * label, because the schedule has to be localized and only the caller holds `t`.
 * The whole list therefore rides the buttons, and the message text stays a short
 * header (the split the `/model` picker uses).
 *
 * Row buttons carry the ABSOLUTE index into `rows` — pagination is the one
 * index-based thing here, and opening a card is non-destructive. The card's
 * delete button carries the reminder's own id instead (see
 * {@link buildReminderDeleteCallback}).
 */
export function buildReminderListPlan(rows: readonly ReminderListRow[], page: number): ReminderListPlan {
  const { slice, currentPage, totalPages } = paginateList(rows, page, reminderListPageSize);
  const pageOffset = currentPage * reminderListPageSize;

  const keyboard: ReminderKeyboardPlan = slice.map((row, sliceIndex) => [
    {
      label: { kind: 'listRow', name: row.name, descriptor: row.descriptor },
      callbackData: buildReminderCardCallback(pageOffset + sliceIndex),
    },
  ]);

  const hasPrev = currentPage > 0;
  const hasNext = currentPage < totalPages - 1;
  const navigationRow: ReminderButtonPlan[] = [];
  if (hasPrev) {
    navigationRow.push(
      buildKeyButton(reminderLabelKeys.listPrev, buildReminderListPageCallback(currentPage - 1)),
    );
  }
  if (hasNext) {
    navigationRow.push(
      buildKeyButton(reminderLabelKeys.listNext, buildReminderListPageCallback(currentPage + 1)),
    );
  }
  if (navigationRow.length > 0) keyboard.push(navigationRow);
  keyboard.push([buildKeyButton(reminderLabelKeys.listBackToHub, reminderHubCallback)]);

  return { rows: slice, currentPage, totalPages, hasPrev, hasNext, keyboard };
}

/**
 * @description Resolve a tapped list row back to its reminder, or `null` when
 * the index no longer resolves (the list shrank between render and tap). Stale
 * keyboards stay tappable forever in Telegram, so an out-of-range index must
 * answer "expired" rather than open a neighbour — same contract as
 * `getTimezoneAt`.
 */
export function getReminderRowAt(
  rows: readonly ReminderListRow[],
  reminderIndex: number,
): ReminderListRow | null {
  if (!Number.isInteger(reminderIndex) || reminderIndex < 0) return null;
  return rows[reminderIndex] ?? null;
}

/**
 * @description The list page a row at `reminderIndex` was rendered on — what the
 * card's back button returns to. Derived from the index rather than carried in
 * the callback, so the card needs no extra state to come back to where it was
 * opened from.
 */
export function getReminderCardBackPage(reminderIndex: number): number {
  return Math.max(0, Math.floor(reminderIndex / reminderListPageSize));
}

/**
 * @name ReminderCardPlan
 * @description One reminder's card: the reminder itself plus a keyboard with
 * delete (id-bound) and a back button that returns to the LIST PAGE the row was
 * on — derived from its index, so no extra state has to be carried.
 */
export interface ReminderCardPlan {
  row: ReminderListRow;
  listPage: number;
  keyboard: ReminderKeyboardPlan;
}

/** Build a reminder's card, or `null` for a stale row index. */
export function buildReminderCardPlan(
  rows: readonly ReminderListRow[],
  reminderIndex: number,
): ReminderCardPlan | null {
  const row = getReminderRowAt(rows, reminderIndex);
  if (row === null) return null;
  const listPage = getReminderCardBackPage(reminderIndex);
  return {
    row,
    listPage,
    keyboard: [
      [buildKeyButton(reminderLabelKeys.cardDelete, buildReminderDeleteCallback(row.id))],
      [buildKeyButton(reminderLabelKeys.cardBackToList, buildReminderListPageCallback(listPage))],
    ],
  };
}

/**
 * @name ReminderDeleteResolution
 * @description Outcome of resolving a delete tap. `notFound` covers an already
 * deleted reminder (a double tap, or an old card left open) — the caller says
 * "gone" instead of deleting whatever now sits where it used to be.
 */
export type ReminderDeleteResolution =
  | { kind: 'found'; row: ReminderListRow }
  | { kind: 'notFound' };

/** Resolve a delete tap by the reminder ID baked into its `callback_data`. */
export function getReminderDeleteTarget(
  rows: readonly ReminderListRow[],
  reminderId: string,
): ReminderDeleteResolution {
  const row = rows.find((candidate) => candidate.id === reminderId);
  return row === undefined ? { kind: 'notFound' } : { kind: 'found', row };
}

// ─── date / time formatting ──────────────────────────────────────────

function padTwo(value: number): string {
  return value.toString().padStart(2, '0');
}

/** `{hour: 9, minute: 0}` → `"09:00"`. Locale-neutral, hence a literal label. */
export function formatReminderTime(time: ReminderTimeOfDay): string {
  return `${padTwo(time.hour)}:${padTwo(time.minute)}`;
}

/** A local `Date` → its calendar date as `YYYY-MM-DD` (never UTC-shifted). */
export function formatReminderDateIso(date: Date): string {
  return `${date.getFullYear()}-${padTwo(date.getMonth() + 1)}-${padTwo(date.getDate())}`;
}

/** Date-grid button label: `DD.MM` — digits only, so no locale is implied. */
export function formatReminderDayMonth(date: Date): string {
  return `${padTwo(date.getDate())}.${padTwo(date.getMonth() + 1)}`;
}

/**
 * @description The local calendar date `offsetDays` after the day containing
 * `nowMs`. Built from the date PARTS rather than by adding 24h so a DST
 * transition cannot shift the result into the neighbouring day.
 */
export function getLocalDateAtDayOffset(nowMs: number, offsetDays: number): Date {
  const base = new Date(nowMs);
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + offsetDays);
}

/**
 * @name ReminderInstantResult
 * @description The resolved `once` instant, or WHICH of the two picks is at fault.
 * Two failure codes rather than one because they send the operator to different
 * screens (see {@link ReminderWizardErrorCode}).
 */
export type ReminderInstantResult =
  | { ok: true; instant: Date }
  | { ok: false; code: 'invalidDate' | 'invalidTime' };

/**
 * @description The local instant a `once` reminder fires at.
 *
 * The calendar date is probed on its OWN midnight instant, independently of the
 * picked time, so the two causes of failure stay distinguishable: `2026-02-31` is
 * no date at all (`invalidDate`), while `02:30` on a spring-forward day is a real
 * date whose wall clock simply skips that hour (`invalidTime`) — the JS `Date`
 * constructor silently shifts such a time forward instead of refusing it.
 */
export function createReminderInstant(
  dateIso: string,
  hour: number,
  minute: number,
): ReminderInstantResult {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateIso);
  if (!match) return { ok: false, code: 'invalidDate' };
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const dateProbe = new Date(year, month - 1, day);
  if (
    dateProbe.getFullYear() !== year ||
    dateProbe.getMonth() !== month - 1 ||
    dateProbe.getDate() !== day
  ) {
    return { ok: false, code: 'invalidDate' };
  }

  const instant = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (instant.getHours() !== hour || instant.getMinutes() !== minute) {
    return { ok: false, code: 'invalidTime' };
  }
  return { ok: true, instant };
}

/** `YYYY-MM-DD` → the compact `YYYYMMDD` a date callback carries. */
function encodeCompactDate(dateIso: string): string {
  return dateIso.split('-').join('');
}

/**
 * @description `YYYYMMDD` → `YYYY-MM-DD`, or `null` when the digits are not a
 * real calendar date (`20260231`). Validated here so an impossible date can
 * never reach the spec assembler.
 */
function decodeCompactDate(rawDate: string): string | null {
  if (rawDate.length !== compactDateLength || !/^\d+$/.test(rawDate)) return null;
  const year = Number(rawDate.slice(0, 4));
  const month = Number(rawDate.slice(4, 6));
  const day = Number(rawDate.slice(6, 8));
  const probe = new Date(year, month - 1, day);
  if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day) {
    return null;
  }
  return `${year.toString().padStart(4, '0')}-${padTwo(month)}-${padTwo(day)}`;
}
