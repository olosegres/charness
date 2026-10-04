import type { ScheduleRecord } from './types';

/**
 * @description Pure decisions that depend on a schedule's {@link
 * ScheduleRecord.deliveryKind}: the discriminator predicate itself, and the ONE
 * policy that has to read it outside the fire path — which of a thread's jobs an
 * unbound-topic pause applies to.
 *
 * The pause filter lives here rather than in `bot.ts` because `bot.ts` cannot be
 * imported by a test (its module-scope `parseEnv()` exits the process), and this
 * rule is the load-bearing half of the reminder feature: a reminder needs neither
 * a bound folder nor an agent, so pausing it when the topic leaves its folder
 * would silently stop the one job kind that could still have run.
 */

/**
 * @description Whether a record is a bot-local reminder (post + pin, no agent).
 * Takes only the field it reads so a caller can ask about a partial record.
 */
export function checkIsReminderSchedule(record: Pick<ScheduleRecord, 'deliveryKind'>): boolean {
  return record.deliveryKind === 'reminder';
}

/** @description Whether a record is a watchdog check (the bot runs its command; a failure wakes the agent). */
export function checkIsCheckSchedule(record: Pick<ScheduleRecord, 'deliveryKind'>): boolean {
  return record.deliveryKind === 'check';
}

/**
 * @description The jobs an UNBOUND topic must pause: the agent-prompt jobs and the
 * checks (a check runs in the bound folder and wakes the agent), reminders left
 * out so they stay armed. The caller must therefore count what this
 * returns rather than the thread's whole list — a thread holding only reminders
 * yields an empty array, i.e. nothing paused and no notice to post.
 */
export function getUnboundPausableSchedules(
  records: readonly ScheduleRecord[],
): ScheduleRecord[] {
  return records.filter((record) => !checkIsReminderSchedule(record));
}
