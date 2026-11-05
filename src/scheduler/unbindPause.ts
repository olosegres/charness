import type { StateStore } from '../state';
import type { SessionKey } from '../sessionKey';
import { clearCheckStatusLine, type ScheduleDeliveryDeps } from './delivery';
import { getUnboundPausableSchedules } from './deliveryKind';

/**
 * @description What leaving a folder (`/unbind`) does to the topic's schedules (S8): the AGENT-PROMPT jobs and checks are
 * flagged `isPaused` with reason `'unbound'` and disarmed (they never fire again until the next `/bind` resumes them), and ONE
 * notice names the count. Reminders are exempt ({@link getUnboundPausableSchedules}): they post and pin with no agent and no
 * folder. A thread holding only reminders pauses nothing and posts no notice. Scheduler pins are not touched (pins accumulate).
 *
 * A parked check never runs again, so nothing would ever take its status line away: the pause deletes it (best effort, through
 * the one {@link clearCheckStatusLine}) — otherwise a «⏳ works 45 min» line would stay frozen under a watch that no longer
 * watches. Lives apart from `bot.ts` (a test cannot import it) over ports; the engine stays generic.
 */

/** @name UnbindPauseDeps @description What the pause needs from the bot. */
export interface UnbindPauseDeps {
  store: Pick<StateStore, 'getThreadSchedules' | 'setSchedulePaused'>;
  /** Stop the job's timer. */
  disarmJob: (jobId: string) => void;
  /** The ports the one status-line clearing runs over (the same the scheduler's delivery uses). */
  statusLinePorts: Pick<ScheduleDeliveryDeps, 'recordStatusLine' | 'deleteMessage'>;
  /** Post the one «paused» notice into the topic. */
  announcePaused: (count: number) => Promise<unknown>;
}

/** @description Pause the topic's pausable schedules for an unbind; resolves with how many were paused. */
export async function pauseSchedulesOnUnbind(deps: UnbindPauseDeps, key: SessionKey): Promise<number> {
  const records = getUnboundPausableSchedules(deps.store.getThreadSchedules(key));
  if (records.length === 0) return 0;
  for (const record of records) {
    await deps.store.setSchedulePaused(record.id, true, 'unbound');
    deps.disarmJob(record.id);
    await clearCheckStatusLine(deps.statusLinePorts, record);
  }
  await deps.announcePaused(records.length);
  return records.length;
}
