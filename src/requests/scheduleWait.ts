import { checkIsReminderSchedule } from '../scheduler/deliveryKind';
import type { ScheduleRecord } from '../scheduler/types';
import type { OpenRequestState } from './types';

/**
 * @description «A request waits for its schedule»: the one neutral reading the wake-up rules take of an open request's
 * armed jobs, so an agent that launched a worker, armed its watch and ended its turn is not prodded by the engine
 * (a follow-up every 15 minutes, ten wake-ups, then «could not finish») — the watch wakes it when there is something to do.
 *
 * A job counts when it is armed under the request (`ScheduleRecord.requestId` is the request's id or the id of a request
 * this one replaced), is an agent job (a prompt job or a check; a reminder wakes nobody) and is not paused.
 *
 *   none      — no job counts: the normal rules apply
 *   watching  — a job counts and is not a failing check: between turns nothing wakes the request
 *   armed     — every counting job is a failing check: a watch that just fired. Only the END of a watched turn reads it as
 *               waiting (the agent that handled the wake is not silent); between turns a failing check nobody handled
 *               (the agent died in the wake) must not hold the request forever, so it does not count there
 *
 * Platform-neutral: a Telegram topic in a view with requests gets the same reading from the jobs its agent armed.
 */
export type RequestScheduleWait = 'none' | 'armed' | 'watching';

/** @description Whether `job` was armed under `request`: under it, or under a request it replaced. */
export function checkIsJobArmedUnderRequest(job: Pick<ScheduleRecord, 'requestId'>, request: Pick<OpenRequestState, 'id' | 'supersededRequestIds'>): boolean {
  if (job.requestId === undefined) return false;
  return job.requestId === request.id || (request.supersededRequestIds ?? []).includes(job.requestId);
}

/**
 * @description The reading of `request` over its conversation's jobs (`jobs` need not be filtered: every job of the
 * conversation may be passed).
 */
export function getRequestScheduleWait(jobs: readonly ScheduleRecord[], request: Pick<OpenRequestState, 'id' | 'supersededRequestIds'>): RequestScheduleWait {
  let wait: RequestScheduleWait = 'none';
  for (const job of jobs) {
    if (checkIsReminderSchedule(job) || job.isPaused === true || !checkIsJobArmedUnderRequest(job, request)) continue;
    if (job.isCheckFailing !== true) return 'watching';
    wait = 'armed';
  }
  return wait;
}

/** @description Whether the end of a watched turn reads the request as waiting for its schedule: `armed` and `watching` both do. */
export function checkIsWaitingAtTurnEnd(wait: RequestScheduleWait): boolean {
  return wait !== 'none';
}

/** @description Whether, between turns, nothing may wake the request: only a watch that is not failing holds it. */
export function checkIsWaitingBetweenTurns(wait: RequestScheduleWait): boolean {
  return wait === 'watching';
}
