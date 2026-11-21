/**
 * @description The choices of the «limit reminders» setting (`/limits_reminders`) and the rule that picks one for a topic —
 * kept apart from `plan.ts` (the decisions and texts of the note) because the instance settings and the state store need only
 * these, and they load before any env file is read: this module imports nothing.
 */

/** The stored value of «Off» (`settings.json` and `state.json` keep minutes; `0` is no interval). */
export const limitReminderOffMinutes = 0;

/** The intervals the picker offers, in the order it shows them; «Off» is the picker's own button. */
export const limitReminderIntervalOptions = [60, 120, 240] as const;

/** @name LimitReminderMinutes @description One interval the `/limits_reminders` setting offers. */
export type LimitReminderMinutes = (typeof limitReminderIntervalOptions)[number];

/** @name LimitReminderChoice @description What the setting stores: an interval, or Off (`0`). */
export type LimitReminderChoice = LimitReminderMinutes | typeof limitReminderOffMinutes;

/** Every stored value the setting accepts, Off first: the values a picker's buttons write. */
export const limitReminderChoices: readonly LimitReminderChoice[] = [limitReminderOffMinutes, ...limitReminderIntervalOptions];

/** The interval nobody chose. */
export const limitReminderDefaultMinutes: LimitReminderMinutes = 60;

/** @description Whether a stored number is one of the offered intervals. */
export function checkIsLimitReminderMinutes(value: number | null | undefined): value is LimitReminderMinutes {
  return limitReminderIntervalOptions.some((option) => option === value);
}

/** @description Whether a stored number is a choice of the setting: an offered interval or Off (a hand-edited file may hold anything). */
export function checkIsLimitReminderChoice(value: number | null | undefined): value is LimitReminderChoice {
  return limitReminderChoices.some((choice) => choice === value);
}

/**
 * @description The interval a topic is under: its own choice, else General's, else {@link limitReminderDefaultMinutes}; `null` =
 * Off. `topic` / `general` are the stored values (`undefined` or `null` = no choice made; `0` = Off; a number that is no choice
 * counts as no choice). A topic's Off beats General's interval, a topic's interval beats General's Off.
 */
export function resolveLimitRemindersMinutes(general: number | null | undefined, topic: number | null | undefined): LimitReminderMinutes | null {
  for (const stored of [topic, general]) {
    if (stored === limitReminderOffMinutes) return null;
    if (checkIsLimitReminderMinutes(stored)) return stored;
  }
  return limitReminderDefaultMinutes;
}

const msPerMinute = 60 * 1000;

/** @description The interval in ms, or `null` when the reminder is off. `overrideMs` is the test-only timing seam (`CHARNESS_TEST_TIMINGS`); Off stays off. */
export function getLimitReminderIntervalMs(minutes: LimitReminderMinutes | null, overrideMs: number | undefined): number | null {
  return minutes === null ? null : overrideMs ?? minutes * msPerMinute;
}
