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
 *   armed     — every counting job is a failing check: a watch that just fired. Only the END of a turn a FIRE started reads it
 *               as waiting (the agent that handled the wake is not silent; any other turn reads it as `none`); between turns a
 *               failing check nobody handled (the agent died in the wake) must not hold the request forever, so it does not count there
 *
 * Platform-neutral: a Telegram topic in a view with requests gets the same reading from the jobs its agent armed.
 *
 * A reading never decides alone: between turns it holds a request only while the request owes nobody an answer
 * (`checkIsHeldBetweenTurns`), and at a turn's end it quiets a turn only while nothing is owed (`decideTurnEnd`) — the owed reading
 * and the schedule wait decide, whatever the kind of the turn. The complete table is `src/requests/README.md` § Wake-ups.
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

/**
 * @description Whether the end of a watched turn reads the request as waiting for its schedule. `watching` always does. `armed` — a
 * watch that fired and was not re-armed — does only for the turn a fire of the request's OWN job started (`isRequestFire`: a scheduled
 * run whose job is armed under the request, a «continue» of it included): the agent that handled the wake is not silent. A fire of
 * another job that only rides the request did not handle that watch (a check forwards only at its first failure, so every later fire
 * on an `armed` request is another job's). A reminder's or a person's turn is not the alarm: nothing else will ever wake the agent
 * on a request whose watch is gone, so for them `armed` reads as `none` — a silent reminder is a silent turn, and the chain ends in
 * the give-up instead of ten backstop reminders ninety minutes apart.
 */
export function checkIsWaitingAtTurnEnd(wait: RequestScheduleWait, isRequestFire: boolean): boolean {
  return wait === 'watching' || (wait === 'armed' && isRequestFire);
}

/** @description Whether, between turns, nothing may wake the request: only a watch that is not failing holds it. */
export function checkIsWaitingBetweenTurns(wait: RequestScheduleWait): boolean {
  return wait === 'watching';
}

/**
 * @description Whether the request owes a person an answer — what a watch must never hide. It does while a silent turn is pending
 * (`silentTurnCount`), while a person's words reached the agent after the last answer (`isPersonInputUnanswered`, persisted), and
 * for a person's request that was never answered at all. The scheduler's request (`scheduledRun`) is no person's, so it owes nobody
 * their words. Everything here is read from the persisted request, so it survives a restart that loses the engine's
 * in-memory watches.
 */
export function checkIsAnswerOwed(
  request: Pick<OpenRequestState, 'silentTurnCount' | 'isPersonInputUnanswered' | 'progressAnswerCount' | 'origin'>,
): boolean {
  if (request.silentTurnCount > 0 || request.isPersonInputUnanswered === true) return true;
  return request.origin.kind !== 'scheduledRun' && request.progressAnswerCount === 0;
}

/**
 * @description Whether `request` is the scheduler's request (a Telegram topic's `scheduledRun`) the agent NEVER answered: nobody was told
 * anything about it and nobody is owed its answer, so any turn of it that ends without an answer closes it without a word
 * (`decideTurnEnd`). Once the operator was told «working on it» it is an ordinary answered request and a later silence is chased. Nothing
 * else reads a request to decide what its turns are: a turn's kind is said by its forward (`src/requests/README.md` § Scheduled runs).
 */
export function checkIsUnansweredFireRequest(request: Pick<OpenRequestState, 'origin' | 'progressAnswerCount'>): boolean {
  return request.origin.kind === 'scheduledRun' && request.progressAnswerCount === 0;
}

/**
 * @description Whether, between turns, the request is held by its schedule: a watch that is not failing holds it, but only while it
 * owes nobody an answer. A person's turn whose watch was lost (a restart, a dead process) is then taken back by the backstop,
 * as it is without a watch.
 */
export function checkIsHeldBetweenTurns(
  request: Pick<OpenRequestState, 'silentTurnCount' | 'isPersonInputUnanswered' | 'progressAnswerCount' | 'origin'>,
  wait: RequestScheduleWait,
): boolean {
  return checkIsWaitingBetweenTurns(wait) && !checkIsAnswerOwed(request);
}

/**
 * @description The request a job `schedule_create` arms now is armed under — the one the agent is WORKING ON, which is what must
 * wait for the job. Tiers, the first that has a request wins: a request whose turn the engine watches because a forward of its OWN
 * started the watch (`ownForwardRequestIds`, OLDEST first: its prompt, an update, a fire riding it, a reminder for it) — the first is
 * the request whose forward STARTED the running turn, which is what the agent works on, whoever's words or fire joined the turn later;
 * a request whose turn is watched only because a conversation-wide forward carried it along (a «continue» nudge, a restart wake —
 * those watch EVERY open request, which says nothing about the one the agent works on); the open requests. Inside those last two
 * tiers the newest wins, a tracker HAND-OVER (`trackerEvent`) before a mention (`trackerMention`): a mention hands nothing over and
 * long work belongs to the hand-over. The scheduler's request (`scheduledRun`: a Telegram topic's) counts in the first tier — the
 * watch an agent arms while handling the alarm that started the turn belongs to that alarm — and is passed over for any other in the
 * two tiers that do not know the turn: a person's work outlives an alarm. (A watch's own fire rides the request the watch was armed
 * under, so re-arming in that turn keeps the job where it was.) `undefined` when no request is open (a topic's stream view has none).
 * `openRequests` is oldest first, as `RequestLedger.listOpenRequestsOf` returns it: the newest of a list is its last.
 */
export function pickRequestToArmUnder(
  openRequests: readonly OpenRequestState[],
  watchedRequestIds: readonly string[],
  ownForwardRequestIds: readonly string[] = [],
): string | undefined {
  const isWorkRequest = (request: OpenRequestState): boolean => request.origin.kind !== 'scheduledRun';
  const getNewestPreferringHandOver = (requests: readonly OpenRequestState[]): OpenRequestState | undefined =>
    requests.filter((request) => request.origin.kind === 'trackerEvent').at(-1) ?? requests.at(-1);
  const workRequests = openRequests.filter(isWorkRequest);
  const watched = workRequests.filter((request) => watchedRequestIds.includes(request.id));
  // The starter of the running turn: the first own-forward id (the engine lists them oldest first) that is an open request.
  const turnStarter = ownForwardRequestIds.map((id) => openRequests.find((request) => request.id === id)).find((request) => request !== undefined);
  return (turnStarter ?? getNewestPreferringHandOver(watched) ?? getNewestPreferringHandOver(workRequests) ?? openRequests.at(-1))?.id;
}
