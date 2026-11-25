import type { SessionKey } from '../sessionKey';
import { getNextRunAt } from './recurrence';
import type { ScheduleRecord } from './types';

/**
 * @name RebindResumeAction
 * @description What to do with one unbound-paused job when its thread is rebound
 * (plan S8 "rebind: resume paused-for-unbound jobs, nextRunAt recomputed from
 * now — no catch-up for deliberate pauses"):
 *  - `resume` — the spec still has a future occurrence: clear the pause, set
 *    `nextRunAt` to that occurrence, re-arm.
 *  - `remove` — the spec is exhausted (a one-shot whose instant already passed
 *    while unbound, or a finished cron): there is nothing left to fire, so the
 *    record is dropped rather than left as a permanently-paused husk. This is
 *    the honest semantic — a past one-shot cannot be resumed.
 */
export type RebindResumeAction =
  | { kind: 'resume'; nextRunAt: number }
  | { kind: 'remove' };

/**
 * @description Decide the rebind action for ONE paused job, recomputing its next
 * occurrence strictly from `nowMs` (deliberate pause ⇒ no catch-up replay of the
 * missed window). Pure: the caller injects `nowMs` and applies the persistence
 * (un-pause + upsert + arm, or remove + disarm) per the returned action.
 */
export function getRebindResumeAction(record: ScheduleRecord, nowMs: number): RebindResumeAction {
  const nextRunAt = getNextRunAt(record.spec, nowMs);
  if (nextRunAt === null) return { kind: 'remove' };
  return { kind: 'resume', nextRunAt };
}

/**
 * @name RebindResumePorts
 * @description What resuming a conversation's unbound-paused jobs needs from the bot: the store, the engine's timers and the
 * way the resume is told. `announceResumed` is the platform's: a Telegram topic gets one notice with the count, a tracker
 * conversation a log line (the bot posts nothing on an issue).
 */
export interface RebindResumePorts {
  listThreadSchedules: (key: SessionKey) => ScheduleRecord[];
  removeSchedule: (jobId: string) => Promise<void>;
  upsertSchedule: (record: ScheduleRecord) => Promise<void>;
  armJob: (record: ScheduleRecord) => void;
  disarmJob: (jobId: string) => void;
  announceResumed: (count: number) => Promise<void>;
  now: () => number;
}

/**
 * @description Resume the jobs paused for `'unbound'` on `key` when the conversation's folder is usable again (S8): a Telegram
 * topic after `/bind`, a Jira issue at the request whose bind step found its folder. Each `nextRunAt` is recomputed FROM NOW (no
 * catch-up for a deliberate pause), then the job is either un-paused and re-armed, or — a one-shot whose instant passed while
 * unbound — dropped (a past one-shot has no future occurrence, so it cannot be resumed). Announces ONCE with the resumed count
 * (only when > 0). Jobs paused for other reasons (none exist in v1) are left alone. Resolves with the resumed count.
 */
export async function resumeSchedulesPausedForUnbound(ports: RebindResumePorts, key: SessionKey): Promise<number> {
  const paused = ports.listThreadSchedules(key).filter((record) => record.isPaused && record.pauseReason === 'unbound');
  if (paused.length === 0) return 0;

  const nowMs = ports.now();
  let resumed = 0;
  for (const record of paused) {
    const action = getRebindResumeAction(record, nowMs);
    if (action.kind === 'remove') {
      await ports.removeSchedule(record.id);
      ports.disarmJob(record.id);
      continue;
    }
    const updated: ScheduleRecord = { ...record, nextRunAt: action.nextRunAt, updatedAt: new Date(nowMs).toISOString() };
    delete updated.isPaused;
    delete updated.pauseReason;
    await ports.upsertSchedule(updated);
    ports.armJob(updated);
    resumed += 1;
  }
  if (resumed > 0) await ports.announceResumed(resumed);
  return resumed;
}
