/**
 * @description The screens of `/limits_reminders` (how often an agent that launches workers is told where the accounts' limits stand,
 * `limitNotes/`) as pure data: the picker of General and of a topic, the line that replaces it after a tap, the label of the row the
 * `/limits` board shows, and the codec of the picker's buttons. The words come from the caller's locale (`t`); what the setting holds
 * and which value is in force come from the caller too, so every rule is unit-tested. The command is
 * `connectors/telegram/commands/limitReminders.ts`.
 *
 * The picker is ONE-SHOT: a tap edits it into the confirmation and drops the buttons. The choice is the button's own data, so a keyboard
 * that has gone stale still means exactly what it says.
 */

import { t } from '../i18n';
import {
  limitReminderChoices,
  limitReminderIntervalOptions,
  limitReminderOffMinutes,
  resolveLimitRemindersMinutes,
  type LimitReminderChoice,
  type LimitReminderMinutes,
} from '../limitNotes/reminderChoices';

/** What a button picks: an interval, Off, or (a topic only) «as in General». */
export type LimitRemindersPick = LimitReminderChoice | 'general';

/** A button's caption and the data it carries. */
export interface LimitRemindersButton {
  label: string;
  data: string;
}

/** The picker of one scope: the message and its buttons, row by row. */
export interface LimitRemindersScreen {
  text: string;
  rows: LimitRemindersButton[][];
}

const callbackPrefix = 'lrm_';
/** The data of «as in General»: a topic's own choice is dropped. */
const generalToken = 'g';
const minutesPerHour = 60;
const currentMark = ' ✓';

/** Matches every button of the picker (`lrm_g`, `lrm_0` for Off, `lrm_60`, `lrm_120`, `lrm_240`). */
export const limitRemindersCallbackRe = new RegExp(`^${callbackPrefix}(${[generalToken, ...limitReminderChoices.map((choice) => choice.toString())].join('|')})$`);

/** @description The data of the button that picks `pick`. */
export function buildLimitRemindersCallbackData(pick: LimitRemindersPick): string {
  return `${callbackPrefix}${pick === 'general' ? generalToken : pick}`;
}

/** @description What `data` picks; `null` for anything that is no button of the picker. */
export function parseLimitRemindersCallbackData(data: string): LimitRemindersPick | null {
  const match = limitRemindersCallbackRe.exec(data);
  if (match === null) return null;
  if (match[1] === generalToken) return 'general';
  return limitReminderChoices.find((choice) => choice.toString() === match[1]) ?? null;
}

/** @description The interval in words: `every 2 h`, or `off`. */
export function formatLimitRemindersValue(minutes: LimitReminderMinutes | null): string {
  return minutes === null ? t('limitReminders.valueOff') : t('limitReminders.valueEvery', { hours: (minutes / minutesPerHour).toString() });
}

function buildChoiceButton(choice: LimitReminderChoice, isCurrent: boolean): LimitRemindersButton {
  const label = choice === limitReminderOffMinutes ? t('limitReminders.offButton') : t('limitReminders.hoursButton', { hours: (choice / minutesPerHour).toString() });
  return { label: `${label}${isCurrent ? currentMark : ''}`, data: buildLimitRemindersCallbackData(choice) };
}

/** The picker's buttons in the order it shows them: the intervals, then Off. */
const pickerChoices: readonly LimitReminderChoice[] = [...limitReminderIntervalOptions, limitReminderOffMinutes];

/** The intervals and Off as one row of buttons, the one that is `current` marked ✓. */
function buildChoiceRow(current: LimitReminderChoice | undefined): LimitRemindersButton[] {
  return pickerChoices.map((choice) => buildChoiceButton(choice, choice === current));
}

/** What the picker of one scope needs to know: where it is opened and what is stored. */
export interface LimitRemindersScreenInput {
  isGeneral: boolean;
  /** General's value as `settings.json` holds it; `null` = the file says nothing (the built-in default applies). */
  generalChoice: LimitReminderChoice | null;
  /** A topic's own choice; `undefined` = it follows General. Ignored in General. */
  ownChoice: LimitReminderChoice | undefined;
}

/** The interval General puts every topic without a choice of its own under: its value, else the default. */
function getGeneralMinutes(generalChoice: LimitReminderChoice | null): LimitReminderMinutes | null {
  return resolveLimitRemindersMinutes(generalChoice, undefined);
}

/**
 * @description The interval in force for a scope, in words — what the `/limits` row and the picker's «Now» line show: a topic's own
 * choice, else General's, else the default.
 */
export function getLimitRemindersEffectiveMinutes(input: Pick<LimitRemindersScreenInput, 'generalChoice' | 'ownChoice'>): LimitReminderMinutes | null {
  return resolveLimitRemindersMinutes(input.generalChoice, input.ownChoice);
}

/**
 * @description The picker: the title (General's, or the topic's), what the notes are, the value in force — a topic that follows General
 * says so with General's value, General says «(default)» while nothing was chosen — and the buttons with ✓ on the value in force. A
 * topic gets «As General» above the intervals (✓ while it has no choice of its own); General has none.
 */
export function buildLimitRemindersScreen(input: LimitRemindersScreenInput): LimitRemindersScreen {
  const generalMinutes = getGeneralMinutes(input.generalChoice);
  const own = input.isGeneral ? undefined : input.ownChoice;
  const now = input.isGeneral
    ? input.generalChoice === null
      ? t('limitReminders.valueDefaultMark', { value: formatLimitRemindersValue(generalMinutes) })
      : formatLimitRemindersValue(generalMinutes)
    : own === undefined
      ? t('limitReminders.valueAsGeneral', { value: formatLimitRemindersValue(generalMinutes) })
      : formatLimitRemindersValue(getLimitRemindersEffectiveMinutes({ generalChoice: input.generalChoice, ownChoice: own }));
  const text = [
    t(input.isGeneral ? 'limitReminders.titleGeneral' : 'limitReminders.titleTopic'),
    t('limitReminders.explanationText'),
    t('limitReminders.nowLine', { value: now }),
  ].join('\n\n');
  if (input.isGeneral) {
    // General's mark follows the value in force: with nothing chosen the default's own button carries it.
    const current = input.generalChoice ?? generalMinutes ?? limitReminderOffMinutes;
    return { text, rows: [buildChoiceRow(current)] };
  }
  return {
    text,
    rows: [
      [{ label: `${t('limitReminders.asGeneralButton')}${own === undefined ? currentMark : ''}`, data: buildLimitRemindersCallbackData('general') }],
      buildChoiceRow(own),
    ],
  };
}

/**
 * @description The line a tap turns the picker into: the value now in force and its scope — all topics without a choice of their own
 * (General), this topic, or this topic following General again (with General's value).
 */
export function buildLimitRemindersConfirmation(input: LimitRemindersScreenInput & { pick: LimitRemindersPick }): string {
  const value = formatLimitRemindersValue(getLimitRemindersEffectiveMinutes({ generalChoice: input.generalChoice, ownChoice: input.ownChoice }));
  if (input.isGeneral) return t('limitReminders.setGeneralConfirmation', { value });
  return t(input.pick === 'general' ? 'limitReminders.followGeneralConfirmation' : 'limitReminders.setTopicConfirmation', { value });
}

/** @description The label of the `/limits` board's row that opens the picker: `🔔 Reminders: every 1 h`. */
export function buildLimitRemindersRowLabel(input: Pick<LimitRemindersScreenInput, 'generalChoice' | 'ownChoice'>): string {
  return t('limits.remindersRowLabel', { value: formatLimitRemindersValue(getLimitRemindersEffectiveMinutes(input)) });
}
