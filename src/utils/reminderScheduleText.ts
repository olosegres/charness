/**
 * @description THE localized rendering of a reminder's schedule — the one text
 * every reminder surface shows: the list row BUTTONS, the card, the created-screen,
 * and the fire announcement `scheduler/delivery.ts` posts into the topic.
 *
 * It exists because `describeSchedule` (`scheduler/recurrence.ts`) cannot serve
 * these screens: that one is English-ONLY by design (it is interpolated into i18n
 * templates as a value), while the reminder UI exists in 12 locales. Rendering
 * the list in the operator's language and the announcement of the SAME reminder
 * in English would be two descriptions of one thing, so both go through here.
 *
 * The split of labour: `getReminderScheduleDescriptor` (pure, no i18n) decomposes
 * the spec; this module is the ONLY place that turns a descriptor into words. It
 * may import `t` because i18n has no env dependency — unlike `bot.ts`, whose
 * module-scope `parseEnv()` exits the process, so it can be unit-tested directly.
 */

import { t } from '../i18n';
import type { ScheduleSpec } from '../scheduler/types';
import {
  formatReminderDateIso,
  formatReminderTime,
  getLocalDateAtDayOffset,
  getReminderScheduleDescriptor,
  getShortenedText,
  reminderWeekdayLabelKeys,
  type ReminderScheduleDescriptor,
} from './reminderWizard';

/**
 * i18n keys the descriptor → words mapping resolves, one per descriptor kind.
 * Collected so the set of strings the translation scope owes has a single list.
 */
export const reminderScheduleTextKeys: Readonly<Record<ReminderScheduleDescriptor['kind'], string>> = {
  daily: 'reminders.scheduleDaily',
  weekdays: 'reminders.scheduleWeekdays',
  weekly: 'reminders.scheduleWeekly',
  monthly: 'reminders.scheduleMonthly',
  once: 'reminders.scheduleOnce',
  raw: 'reminders.scheduleRaw',
};

/**
 * @description Render an already-decomposed descriptor as localized words. The
 * `weekly` case reuses the weekday BUTTON label (`Sun`) rather than a second set
 * of full weekday names: the operator picked the reminder on that button, so a
 * different wording here would read as a different day.
 *
 * `raw` renders the bare cron expression verbatim — it is the honest fallback for
 * a shape the wizard cannot create (an agent-made job, an N-times budget), and
 * dressing it up as a plain recurring reminder would hide what it really is.
 */
export function getReminderScheduleDescriptorText(descriptor: ReminderScheduleDescriptor): string {
  const key = reminderScheduleTextKeys[descriptor.kind];
  switch (descriptor.kind) {
    case 'daily':
    case 'weekdays':
      return t(key, { time: descriptor.time });
    case 'weekly':
      return t(key, {
        weekday: t(reminderWeekdayLabelKeys[descriptor.weekday]),
        time: descriptor.time,
      });
    case 'monthly':
      return t(key, { dayOfMonth: descriptor.dayOfMonth, time: descriptor.time });
    case 'once':
      return t(key, { date: descriptor.dateIso, time: descriptor.time });
    case 'raw':
      return t(key, { text: descriptor.text });
  }
}

/** Render a persisted spec as localized words (descriptor + {@link getReminderScheduleDescriptorText}). */
export function getReminderScheduleText(spec: ScheduleSpec): string {
  return getReminderScheduleDescriptorText(getReminderScheduleDescriptor(spec));
}

/** The template a list row is composed from: `🔔 {name} · {schedule}`. */
const reminderRowLabelKey = 'reminders.listRow';

/**
 * Longest list-row BUTTON caption. This is a READABILITY bound, not an API one: the
 * Bot API documents no maximum for a button label (the 64-BYTE cap is on
 * `callback_data`, not on the text), while the caption must still read as one line
 * on a phone — and the reminder NAME it carries is operator-controlled free text.
 */
export const reminderRowLabelMaxLength = 64;

/**
 * @description One list-row button caption: the reminder's name plus the SAME
 * localized schedule wording its card shows, so a row and a card can never describe
 * one reminder differently.
 *
 * Past the cap the NAME gives way, never the schedule: the schedule is what the row
 * exists to communicate, whereas the name is already an excerpt of the reminder
 * text. The overhead is measured against the ACTIVE locale (composing with an empty
 * name) instead of assumed from the en template, so a longer translated row shrinks
 * the name rather than blowing the budget.
 */
export function getReminderRowLabel(name: string, descriptor: ReminderScheduleDescriptor): string {
  const schedule = getReminderScheduleDescriptorText(descriptor);
  const label = t(reminderRowLabelKey, { name, schedule });
  if (label.length <= reminderRowLabelMaxLength) return label;
  const overheadLength = t(reminderRowLabelKey, { name: '', schedule }).length;
  const nameBudget = Math.max(0, reminderRowLabelMaxLength - overheadLength);
  return t(reminderRowLabelKey, { name: getShortenedText(name, nameBudget), schedule });
}

/**
 * @name ReminderNextRunDescriptor
 * @description The next fire instant, decomposed for localized rendering.
 * `today` / `tomorrow` are separate kinds rather than a formatted date because
 * "today at 21:00" is what the operator can act on — a bare date makes them work
 * out which day it is.
 */
export type ReminderNextRunDescriptor =
  | { kind: 'today'; time: string }
  | { kind: 'tomorrow'; time: string }
  | { kind: 'date'; dateIso: string; time: string };

/**
 * @description Decompose the next fire instant against the caller's clock. The
 * comparison is on the local CALENDAR DATE (not an hours-apart delta), so an
 * instant 20 hours away is "tomorrow" when it falls on the next day and "today"
 * when it does not — which is how the operator reads it.
 */
export function getReminderNextRunDescriptor(nextRunAtMs: number, nowMs: number): ReminderNextRunDescriptor {
  const at = new Date(nextRunAtMs);
  const time = formatReminderTime({ hour: at.getHours(), minute: at.getMinutes() });
  const dateIso = formatReminderDateIso(at);
  if (dateIso === formatReminderDateIso(getLocalDateAtDayOffset(nowMs, 0))) return { kind: 'today', time };
  if (dateIso === formatReminderDateIso(getLocalDateAtDayOffset(nowMs, 1))) return { kind: 'tomorrow', time };
  return { kind: 'date', dateIso, time };
}

/**
 * @description Localized "Next: …" value. `null` (an exhausted / unarmed job) is
 * rendered as the explicit none-marker rather than an empty string, so the row
 * never looks like a failed substitution.
 */
export function getReminderNextRunText(nextRunAtMs: number | null, nowMs: number): string {
  if (nextRunAtMs === null) return t('reminders.nextRunNone');
  const descriptor = getReminderNextRunDescriptor(nextRunAtMs, nowMs);
  switch (descriptor.kind) {
    case 'today':
      return t('reminders.nextRunToday', { time: descriptor.time });
    case 'tomorrow':
      return t('reminders.nextRunTomorrow', { time: descriptor.time });
    case 'date':
      return t('reminders.nextRunOnDate', { date: descriptor.dateIso, time: descriptor.time });
  }
}
