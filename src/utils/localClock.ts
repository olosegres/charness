import { formatReminderDateIso, formatReminderTime, getLocalDateAtDayOffset } from './reminderWizard';

/**
 * @description The instance-local clock of an instant, for bot notices. "Local"
 * is the process timezone, which `/timezone` sets for the whole instance.
 */

/** `HH:MM` of an epoch-ms instant. */
export function formatLocalClock(epochMs: number): string {
  const at = new Date(epochMs);
  return formatReminderTime({ hour: at.getHours(), minute: at.getMinutes() });
}

/**
 * @description `HH:MM` when the instant falls on today's local calendar date,
 * else `YYYY-MM-DD HH:MM`: a usage-limit reset days away must not read as a time
 * later today.
 */
export function formatLocalClockWithDateIfNotToday(epochMs: number, nowMs: number): string {
  const dateIso = formatReminderDateIso(new Date(epochMs));
  return dateIso === formatReminderDateIso(getLocalDateAtDayOffset(nowMs, 0)) ? formatLocalClock(epochMs) : formatLocalDateAndClock(epochMs);
}

/** `YYYY-MM-DD HH:MM` of an instant — for a text read at an unknown later time. */
export function formatLocalDateAndClock(epochMs: number): string {
  return `${formatReminderDateIso(new Date(epochMs))} ${formatLocalClock(epochMs)}`;
}
