import type { OpenRequestState, OpenRequestUpdate, RequestAlertReason, RequestWakeUpReason } from './types';
import {
  checkIsAnswerOwed,
  checkIsHeldBetweenTurns,
  checkIsUnansweredFireRequest,
  checkIsWaitingAtTurnEnd,
  checkIsWaitingBetweenTurns,
  type RequestScheduleWait,
} from './scheduleWait';
import { getMinutesOverrideMs } from '../utils/minutesOverride';
import { pendingWorkHoldDefaultMs } from '../utils/jsonStreamPendingWork';

/**
 * @description The wake-up rules of the request/answer core (S4), as pure
 * decisions over an open request and what the session looks like right now:
 *
 *   turn ends, request still open
 *     └─ the turn sent NO answer      → silent-turn counter +1
 *          counter < 2                → wake the same session at once
 *          counter = 2                → alert a person, stop waking
 *     └─ the turn sent a progress     → counters = 0, wake again after 15 min;
 *                                       a request open 12 h: no follow-up armed,
 *                                       only the backstop below
 *   cap: 10 wake-ups in a row with no  → alert, stop waking (loop guard)
 *        answer to them
 *   backstop: nothing seen working on it for 90 min (a dead process, tracking
 *             lost across a restart or a watch that never saw its turn end)
 *                                     → resume / wake the session
 *
 * A wake-up never interrupts a live turn and never starts while the session is
 * blocked on something that is not a turn end (a pending native question, a
 * compaction, an armed API-error retry or usage-limit wait). After the alert or
 * the cap nothing wakes the request again until it closes or is superseded.
 *
 * A request WAITS FOR ITS SCHEDULE while a job armed under it counts (`scheduleWait.ts`): the agent that launched a worker,
 * armed its watch and ended its turn is not prodded — at the end of a watched turn it is not silent while the request owes nobody
 * an answer (counter 0, no follow-up, no wake), between turns and at a restart nothing wakes the request while a watch that is not
 * failing holds it and it owes nobody an answer. What a request owes (`checkIsAnswerOwed`) is read from the persisted request,
 * never from the kind of the turn; the owed reading plus the schedule wait decide, and the one turn input is a SCHEDULED RUN: its
 * turn that ends without an answer is not silent either, while nothing is owed — a woken agent with nothing to report stays quiet.
 * A scheduler fire is never a wake-up of these rules, so it never counts against the cap. The complete table is
 * `src/requests/README.md` § Wake-ups.
 *
 * A TRACKER's rules (a Jira issue, {@link WakeUpRuleSet}) have no clock: where a topic's progress note with nothing armed starts the
 * 15-minute follow-up, a tracker's gets ONE nudge at once (`nothingArmed`: finish, ask, or arm a watch for what it waits on), and the
 * next turn end in a row that leaves the request open with nothing armed — another note, or a silent turn — gives it up
 * (`stalledTurnCount`). The agent's OWN pending work (a background command or sub-agent, a `ScheduleWakeup`) holds the turn open
 * while the request owes nobody an answer, for at most {@link ownWorkHoldMaxMs} after its last activity ({@link checkIsHeldByOwnWork}):
 * no nudge, no give-up while it runs, and the turn end is decided once nothing of the agent's own is pending (the stall count then
 * starts again: the agent's work ended by itself) or once the bound lapsed (it does not). A turn end the request's schedule holds
 * starts the stall count again (the engine clears it too when a person's words reach the agent). Everything else is the same table.
 */

/**
 * @name WakeUpRuleSet
 * @description Which rules end a conversation's turns: `topic` (a Telegram topic) follows a progress note with nothing armed up after
 * {@link progressFollowUpDelayMs}; `tracker` (a Jira issue) reminds nobody on a clock — such a note gets one nudge, the next stall the
 * give-up (a silent turn counts as a stall too), and the agent's own pending work holds its turn open. The rest of the table is the same.
 */
export type WakeUpRuleSet = 'topic' | 'tracker';

/** Silent turns in a row that make the rules give up. */
export const maxSilentTurns = 2;
/**
 * Wake-ups in a row one request may receive with no progress note answering them before the loop guard gives up. A
 * reminder the agent answers with a progress note starts the count again: an agent that reports while it waits on a
 * long run is working, and an alert saying it gave no answer would be false.
 */
export const maxWakeUpsPerRequest = 10;
/** After a progress answer, how long before the agent is reminded again. */
export const progressFollowUpDelayMs = 15 * 60 * 1000;
/**
 * How long a request gets a reminder 15 min after each progress note: the bound on an agent that only ever reports progress.
 * Past it no follow-up is armed, and nothing else changes: the request is NOT given up (no alert — the agent did answer — and
 * `isWakeStopped` stays false), so it keeps its task-agent slot and its issue updates, and the backstop still wakes it once
 * nothing was seen working on it for the backstop window (a process that died, an agent that went quiet).
 */
export const progressFollowUpMaxAgeMs = 12 * 60 * 60 * 1000;
/**
 * After a request's prompt could not be posted (no session, a forward that
 * failed), when to try again (R28): soon, then less soon — these retries are not
 * wake-ups of a silent agent, so they do not count against the wake-up cap.
 */
export const postRetryDelaysMs = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000] as const;

/**
 * @description The next post retry after a failed post (R28), or `null` once the
 * retries are spent — the normal backstop / alert rules take the request then.
 * `firstDelayMs` replaces the first delay only (a test instance's shorter one).
 */
export function getPostRetryUpdate(request: OpenRequestState, nowMs: number, firstDelayMs?: number): OpenRequestUpdate | null {
  const retryCount = request.postRetryCount ?? 0;
  const delayMs = retryCount === 0 && firstDelayMs !== undefined ? firstDelayMs : postRetryDelaysMs[retryCount];
  return delayMs === undefined ? null : { postRetryCount: retryCount + 1, nextPostRetryAt: nowMs + delayMs };
}

/** Default backstop: open with nothing seen working on it for this long. */
export const defaultRequestBackstopMs = 90 * 60 * 1000;

/**
 * @description The backstop window, honouring the `REQUEST_BACKSTOP_MINUTES`
 * override (a live test shortens it to finish a killed-process scenario in
 * minutes). A missing, non-numeric or non-positive value keeps the default.
 */
export function getRequestBackstopMs(overrideMinutes: string | undefined): number {
  return getMinutesOverrideMs(overrideMinutes, defaultRequestBackstopMs);
}

/**
 * @name SessionTurnProbe
 * @description What the session of a conversation looks like right now.
 * `hasUnconsumedInput` is `null` for a backend that cannot tell (tmux Claude).
 */
export interface SessionTurnProbe {
  isActive: boolean;
  isBusy: boolean;
  hasUnconsumedInput: boolean | null;
  /**
   * A pending native question, a compaction, an armed retry / limit wait, a
   * wedged-turn recovery in flight, a retry whose "continue" nudge is on its way,
   * an API error the bot still handles, a re-spawn, or a session start under way.
   */
  isTurnEndBlocked: boolean;
  /**
   * The busy session runs, or is about to start, a turn the CLI started by itself — a finished background task's, a session job's —
   * that no write of the bot started (`AgentAdapter.checkIsCliOwnTurn`): its busy time is no request's activity. Absent: the bot's
   * own turn, or a backend that cannot tell.
   */
  isCliOwnTurn?: boolean;
  /**
   * The live process a prompt written now goes to (`AgentAdapter.getProcessGeneration`; `unnumberedProcessGeneration` (`types.ts`) on a backend
   * that cannot tell its processes apart). Absent while a start's or a stop's window is open (a prompt forwarded then waits in the
   * buffer, for the process the replay writes it to) or with no live process.
   */
  processGeneration?: number;
  /**
   * A start's or a stop's window is open: a prompt forwarded now waits in its buffer, for the process its replay writes it to. Absent
   * without one. It tells a prompt that waits for its replay from one whose process went down after its write (review 22 nit 2).
   */
  isWindowOpen?: boolean;
  /**
   * The agent's own pending work, whose end starts its next turn by itself: a background command or sub-agent, a session job (a
   * `ScheduleWakeup`, a `CronCreate`), a finished task's turn on its way (`utils/workingSignals.ts`). Absent: none, or a backend that
   * cannot tell. Only a tracker's rules read it ({@link checkIsHeldByOwnWork}).
   */
  hasOwnPendingWork?: boolean;
}

/**
 * How long the agent's own pending work may hold a tracker request's turn open, counted from the request's last activity: the same
 * 6 h the json-stream adapter lets that work hold the process after its last turn (`utils/jsonStreamPendingWork.ts`). The adapter
 * counts from ANY turn end, so work that renews itself — a recurring `CronCreate`, a `ScheduleWakeup` re-armed at every wake — keeps
 * its process for as long as it loops. The request counts from its own activity, which a turn the CLI starts by itself never is
 * (upstream's rule for the backstop), and neither is a progress note (the owner's decision: a loop that posts notes would hold the
 * request for good, unseen — a note edits one comment and notifies nobody): such work cannot renew the hold. Past it the turn is
 * decided like any other — a stall, woken as `ownWorkHoldLapsed`, and the give-up at the next — which bounds a request a loop would
 * keep open for good.
 */
export const ownWorkHoldMaxMs = pendingWorkHoldDefaultMs;

/**
 * @description Whether, under a tracker's rules, the agent's own pending work holds the request's turn open: the turn is NOT over
 * while that work runs — its end starts the agent's next turn by itself, and the turn's end is decided once nothing of its own is
 * pending. Never while the request owes the requester an answer (`checkIsAnswerOwed`: its first turn ended without a word, a
 * requester's comment is unanswered, a silent turn is pending): a bot watch never hides that either, and neither does the agent's
 * own work. And at most {@link ownWorkHoldMaxMs} after the request's last activity. So a background command, sub-agent or
 * `ScheduleWakeup` holds off the nudge and the give-up, and the watch never goes stale meanwhile.
 */
export function checkIsHeldByOwnWork(request: OpenRequestState, probe: SessionTurnProbe, rules: WakeUpRuleSet, nowMs: number): boolean {
  if (rules !== 'tracker' || probe.hasOwnPendingWork !== true || checkIsAnswerOwed(request)) return false;
  return nowMs - (request.lastTurnActivityAt ?? request.createdAt) < ownWorkHoldMaxMs;
}

/**
 * @name WakeUpDecision
 * @description What to do for an open request, and the bookkeeping to persist
 * with it (`update`, applied before the action runs).
 */
export type WakeUpDecision =
  | { kind: 'none' }
  | { kind: 'wake'; reason: RequestWakeUpReason; update: OpenRequestUpdate }
  | { kind: 'followUpLater'; update: OpenRequestUpdate }
  /**
   * The turn ended without anything to do about the request (it waits for its schedule, or a scheduled run had nothing to report):
   * bookkeeping only. `isRequestSettled` — the request is the scheduler's (a Telegram topic's `scheduledRun`) and the agent NEVER
   * answered it (`checkIsUnansweredFireRequest`): nobody was told anything and nothing waits for it, so it closes silently instead of
   * waiting for the backstop — at the end of ANY turn of it. One the agent answered `progress` is no such request: the operator was told
   * «working on it».
   */
  | { kind: 'quiet'; update: OpenRequestUpdate; isRequestSettled?: boolean }
  | { kind: 'alert'; reason: RequestAlertReason; update: OpenRequestUpdate };

/**
 * @description Whether anything may still wake the request: the rules' own
 * give-up (`isWakeStopped`, for good) and a limit stop (`isLimitStopped`, until a
 * limit wait ends with a resume) both say no.
 */
export function checkIsWakingStopped(request: OpenRequestState): boolean {
  return request.isWakeStopped || request.isLimitStopped === true;
}

/** The update that stops every further wake-up of a request. */
const stopWakingUpdate: OpenRequestUpdate = { isWakeStopped: true, nextWakeAt: undefined };

/**
 * @description Wake the request now unless it already used up its wake-ups, in
 * which case the loop guard alerts instead. `update` adds to the wake's own
 * bookkeeping.
 */
function getWakeOrCapDecision(
  request: OpenRequestState,
  reason: RequestWakeUpReason,
  update: OpenRequestUpdate,
): WakeUpDecision {
  if (request.wakeCount >= maxWakeUpsPerRequest) {
    return { kind: 'alert', reason: 'wakeCap', update: { ...update, ...stopWakingUpdate } };
  }
  return {
    kind: 'wake',
    reason,
    update: { ...update, wakeCount: request.wakeCount + 1, nextWakeAt: undefined },
  };
}

/**
 * @name TurnEndContext
 * @description What the end of a watched turn is read against besides the request: whether the turn was a scheduled run's,
 * and the request's reading of its armed jobs (absent: it waits for nothing). `isRequestJob` — for a scheduled run's turn: the fire's
 * job is armed under the request (absent: it is). A fire of ANOTHER job only rode the request: it may end quietly, but it did not handle
 * the request's fired watch (`armed` does not count for it) and is not the request's activity (its quiet end changes nothing).
 */
export interface TurnEndContext {
  isScheduledRun?: boolean;
  isRequestJob?: boolean;
  scheduleWait?: RequestScheduleWait;
  /** The follow-up delay after a progress note, in place of {@link progressFollowUpDelayMs} (a test instance's shorter one). */
  progressFollowUpMs?: number;
  /** The conversation's rule set; absent: a topic's. */
  rules?: WakeUpRuleSet;
  /**
   * The agent's own pending work at this turn end (a tracker's rules): `ended` — the watch saw it outlive its turn (pending while no
   * turn ran, or a turn the CLI started by itself) and it ended by itself, so the agent arranged what woke it and a stall here is the first in a row again; `pending` — it still runs, so the hold no longer applies (the
   * request owes an answer, or {@link ownWorkHoldMaxMs} lapsed): the stall count goes on, and a wake for the lapse says the hold ran
   * out (`ownWorkHoldLapsed`), not that nothing is running. Absent: none.
   */
  ownWork?: 'ended' | 'pending';
}

/**
 * @description The decision at the end of a turn the request's message started.
 * `progressCountAtTurnStart` is the request's progress-answer count when the
 * turn began, so an increase means this turn sent a progress note (a `question`
 * or `final` would have closed the request — there is nothing to decide then).
 * A progress note schedules the follow-up unless a watch holds the request between turns (`watching`; then nothing is scheduled — a
 * watch that fired and was not re-armed, `armed`, holds nothing, so a note in its own fire's turn is followed up too). A turn
 * without an answer is not silent when the turn was a scheduled run's, or when the request waits for its schedule, and in both
 * cases only while the request owes nobody an answer (`checkIsAnswerOwed`, read from the persisted request — never from the kind of
 * the turn, so a lost and rebuilt watch decides alike): a requester's message is never left unanswered because a watch is armed or
 * an alarm fired, and the reminder that follows its silent turn keeps counting towards the give-up. A fire's turn on a request that
 * owes an answer is therefore an ordinary silent turn: the reminder names the request, and a second silence gives up.
 * A fire of ANOTHER job that only rode the request (`isRequestJob` false) ends quiet the same way, but the request's watch that fired is
 * not handled by it and its quiet end is no activity of the request: the follow-up and the backstop stand (decision 28's principle).
 * The scheduler's request (`origin.kind` `scheduledRun`) that its agent NEVER answered (`checkIsUnansweredFireRequest`) ends quiet and
 * settles (`isRequestSettled`) at the end of ANY of its turns without an answer — its fire's, a reminder's, a «continue»'s: nobody was told
 * anything, and nobody is owed its answer. Once answered it is read like any request: a fire's turn on it may end quietly, any other
 * silent turn is a silent turn. The turn's kind comes from the forward (`isScheduledRun`), never from the request.
 */
export function decideTurnEnd(
  request: OpenRequestState,
  progressCountAtTurnStart: number,
  nowMs: number,
  context: TurnEndContext = {},
): WakeUpDecision {
  if (checkIsWakingStopped(request)) return { kind: 'none' };
  const isProgressSent = request.progressAnswerCount > progressCountAtTurnStart;
  const isOtherJobFire = context.isScheduledRun === true && context.isRequestJob === false;
  const scheduleWait = context.scheduleWait ?? 'none';
  const isWaitingForSchedule = checkIsWaitingAtTurnEnd(scheduleWait, context.isScheduledRun === true && !isOtherJobFire);
  // A progress note is followed up unless a watch HOLDS the request between turns (`watching`). `armed` excuses the fire's turn a
  // no-answer end only: a note leaves no silence to excuse, and a watch that fired and was not re-armed wakes nobody again — without
  // the follow-up only the 90-minute backstop would be left (as for a person's turn under `armed`, row 1).
  // A progress note answers the reminders before it: the loop guard's count starts again with the silent-turn count.
  if (isProgressSent && !checkIsWaitingBetweenTurns(scheduleWait)) {
    // A tracker reminds nobody on a clock: with nothing armed to wake the agent, nothing ever would — one nudge, then the give-up.
    if (context.rules === 'tracker') return decideTrackerStall(request, nowMs, true, context.ownWork);
    const answeredUpdate: OpenRequestUpdate = { silentTurnCount: 0, wakeCount: 0, lastTurnActivityAt: nowMs };
    if (nowMs - request.createdAt >= progressFollowUpMaxAgeMs) return { kind: 'followUpLater', update: { ...answeredUpdate, nextWakeAt: undefined } };
    return {
      kind: 'followUpLater',
      update: { ...answeredUpdate, nextWakeAt: nowMs + (context.progressFollowUpMs ?? progressFollowUpDelayMs) },
    };
  }
  // A request that owes a person an answer (a silent turn pending, a person's words not answered yet, a person's request never
  // answered): its turn ends silent whatever the turn's kind — a person's own, the reminder's that follows, a continuation of either —
  // or a watch that passes would wipe the count and the rules would never give up on a requester left unanswered. The answer is read
  // from the persisted request, so the same turn decides alike whether or not the engine's watch survived a restart.
  const isOwed = checkIsAnswerOwed(request);
  const isQuietWhileWaiting = isWaitingForSchedule && !isOwed;
  // The follow-up is cleared only where a schedule holds the request. A fire's quiet end alone leaves it: a fire may ride a request
  // that waits for nothing (its own job's request is gone), and an unrelated alarm must not wipe that request's due follow-up.
  const isHeldBySchedule = isProgressSent || isQuietWhileWaiting;
  // A fire's turn is the alarm's: a woken agent with nothing to report may stay silent — but not about a person's words it still
  // owes an answer to. Each fire's quiet end would also push the backstop 90 minutes ahead, and a recurring job would leave the
  // requester unanswered for as long as it lives. The scheduler's request the agent never answered ends quiet whatever the turn.
  const isUnansweredFireRequest = checkIsUnansweredFireRequest(request);
  if (isHeldBySchedule || ((context.isScheduledRun === true || isUnansweredFireRequest) && !isOwed)) {
    // Another job's fire that sent nothing is no activity of this request: its follow-up and backstop stand. Nothing is owed here,
    // so the silent-turn count is already 0.
    const isRequestUntouched = isOtherJobFire && !isProgressSent;
    return {
      kind: 'quiet',
      update: isRequestUntouched ? {} : {
        lastTurnActivityAt: nowMs,
        silentTurnCount: 0,
        ...(isProgressSent ? { wakeCount: 0 } : {}),
        ...(isHeldBySchedule ? { nextWakeAt: undefined } : {}),
        // A tracker's stall count starts again once the request's schedule holds it: the agent armed what wakes it.
        ...(isWaitingForSchedule && (request.stalledTurnCount ?? 0) > 0 ? { stalledTurnCount: undefined } : {}),
      },
      ...(isUnansweredFireRequest ? { isRequestSettled: true } : {}),
    };
  }
  if (context.rules === 'tracker') return decideTrackerStall(request, nowMs, false, context.ownWork);
  const silentTurnCount = request.silentTurnCount + 1;
  if (silentTurnCount >= maxSilentTurns) {
    return { kind: 'alert', reason: 'silentTurns', update: { silentTurnCount, ...stopWakingUpdate } };
  }
  return getWakeOrCapDecision(request, 'silentTurn', { silentTurnCount, lastTurnActivityAt: nowMs });
}

/**
 * A tracker's turn end where a topic's rules would arm the follow-up or call the turn silent: a progress note with nothing armed to
 * wake the agent (`isProgressSent`), or a silent turn (nothing armed, or an answer still owed). Both count as a stall
 * (`stalledTurnCount`, which no answer resets); a silent one counts as a silent turn too, as in a topic. The first stall in a row gets a
 * wake — the nudge `nothingArmed` after a note, the ordinary `silentTurn` after silence — and the second stall, or the second silent
 * turn, the give-up. A note answers the wake-ups before it, as in a topic: the loop guard counts the ones in a row no note answered.
 * `ownWork` ({@link TurnEndContext}): `ended` starts the count again, and with nothing owed the end is the nudge's case whether or not
 * the turn the work started sent a note — the agent had answered before it, a note held the turn open (a restart's re-watch counts
 * notes only from the restart: without this its end would read as silence); `pending` with nothing owed is the lapsed hold, woken as
 * `ownWorkHoldLapsed`.
 */
function decideTrackerStall(request: OpenRequestState, nowMs: number, isProgressSent: boolean, ownWork: TurnEndContext['ownWork']): WakeUpDecision {
  const isOwed = checkIsAnswerOwed(request);
  // A stall with the requester answered: a note now, or one before the agent's own work held the turn open and ended by itself.
  const isAnsweredStall = isProgressSent || (ownWork === 'ended' && !isOwed);
  const stalledTurnCount = (ownWork === 'ended' ? 0 : request.stalledTurnCount ?? 0) + 1;
  const silentTurnCount = isAnsweredStall ? 0 : request.silentTurnCount + 1;
  if (stalledTurnCount >= maxSilentTurns || silentTurnCount >= maxSilentTurns) {
    return { kind: 'alert', reason: 'silentTurns', update: { silentTurnCount, stalledTurnCount, ...stopWakingUpdate } };
  }
  const wakeCount = isProgressSent ? 0 : request.wakeCount;
  const isHoldLapsed = ownWork === 'pending' && !isOwed;
  const reason: RequestWakeUpReason = isHoldLapsed ? 'ownWorkHoldLapsed' : isAnsweredStall ? 'nothingArmed' : 'silentTurn';
  return getWakeOrCapDecision({ ...request, wakeCount }, reason, {
    silentTurnCount,
    stalledTurnCount,
    lastTurnActivityAt: nowMs,
  });
}

/**
 * @description The periodic decision for an open request whose turn is NOT being
 * watched: a due progress follow-up, or the backstop. Never while the session is
 * working or blocked — and a live turn counts as activity, which pushes the
 * backstop back (the caller records it). Nothing either while the request is held
 * by a watch that is not failing and owes nobody an answer (`checkIsHeldBetweenTurns`): the watch wakes the agent, a
 * follow-up would only prod it; a post retry still runs (the agent never saw the request); a request that owes a person
 * an answer — its turn's watch lost to a restart or a dead process — is taken back by the backstop as without a watch.
 */
export function decideUnwatchedRequest(
  request: OpenRequestState,
  probe: SessionTurnProbe,
  nowMs: number,
  backstopMs: number,
  scheduleWait: RequestScheduleWait = 'none',
): WakeUpDecision {
  if (checkIsWakingStopped(request) || probe.isBusy || probe.isTurnEndBlocked) return { kind: 'none' };
  if (request.nextPostRetryAt !== undefined) {
    // R28: outside the wake-up cap — the agent never saw the request, it is not looping.
    return nowMs >= request.nextPostRetryAt
      ? { kind: 'wake', reason: 'postRetry', update: { nextPostRetryAt: undefined, lastTurnActivityAt: nowMs } }
      : { kind: 'none' };
  }
  if (checkIsHeldBetweenTurns(request, scheduleWait)) return { kind: 'none' };
  if (request.nextWakeAt !== undefined) {
    return nowMs >= request.nextWakeAt ? getWakeOrCapDecision(request, 'progressFollowUp', {}) : { kind: 'none' };
  }
  const lastSeenAt = request.lastTurnActivityAt ?? request.createdAt;
  return nowMs - lastSeenAt >= backstopMs
    ? getWakeOrCapDecision(request, 'backstop', { lastTurnActivityAt: nowMs })
    : { kind: 'none' };
}

/**
 * @description The wake of an open request whose conversation's process was found gone (`restarted`): at once, not at
 * the backstop. Nothing when the request already has its own next step — a post retry, or a progress follow-up that can fire (one a
 * passing watch holds never fires, so it is no next step: a lost-work loss still wakes the request) — or nothing may wake it, or the session is working or blocked (a pending question, an armed retry or usage-limit wait, a
 * start under way), or a watch that is not failing holds it while it owes nobody an answer (`checkIsHeldBetweenTurns`: a BOOT
 * wakes nobody then, as in a topic). `isLostWork` — the process ended with the agent's OWN work pending (a build, a scheduled job it
 * had running) — is a different event: a topic resumes on it whatever is armed, so the hold does not apply and the request is woken
 * once, the lost-work note riding the wake.
 * It counts against the wake-up cap like any wake, and is seen activity: the backstop counts from it.
 */
export function decideRestartWake(
  request: OpenRequestState,
  probe: SessionTurnProbe,
  nowMs: number,
  scheduleWait: RequestScheduleWait = 'none',
  isLostWork = false,
): WakeUpDecision {
  if (checkIsWakingStopped(request) || probe.isBusy || probe.isTurnEndBlocked) return { kind: 'none' };
  // The request's own next step: a post retry (it always runs), a follow-up only while it can fire — a passing watch that holds the
  // request keeps a pending follow-up from ever firing (`decideUnwatchedRequest`), so it must not keep the lost-work wake away either.
  const isHeld = checkIsHeldBetweenTurns(request, scheduleWait);
  if (request.nextPostRetryAt !== undefined || (request.nextWakeAt !== undefined && !isHeld)) return { kind: 'none' };
  if (!isLostWork && isHeld) return { kind: 'none' };
  return getWakeOrCapDecision(request, 'restarted', { lastTurnActivityAt: nowMs });
}

/**
 * @name WatchedTurn
 * @description The in-memory view of a turn started by a request's message (or
 * by a wake-up reminder), until it ends.
 */
export interface WatchedTurn {
  requestId: string;
  progressCountAtTurnStart: number;
  /** Busy was observed since the forward (the backend started on it). */
  hasSeenBusy: boolean;
  /** The agent produced output since the forward. */
  hasSeenOutput: boolean;
  /** The turn carries the request's own prompt (not a reminder or a "continue" nudge) — R21. */
  isRequestPrompt: boolean;
  /** A scheduler fire started the turn: ending it without an answer is not silence (a woken agent with nothing to report) while nothing is owed. */
  isScheduledRun?: boolean;
  /**
   * The turn is the request's OWN (absent: it is): `false` only for a fire of another job that only rides the request — no person's
   * words, reminder or own job's fire joined it. Such a turn neither handles the request's fired watch nor counts as its activity.
   */
  isRequestJob?: boolean;
  /**
   * The process the request's prompt was written to (`SessionTurnProbe.processGeneration`), named by the forward that carried it — a
   * merge that carries it again names the process of that write, one that does not keeps it. Absent while the prompt waits in a start's
   * or a stop's buffer: the replay's write names it (`RequestWakeUpEngine.noteReplayedWrite`). A request-prompt watch with none named
   * while the probe names a process has not reached any process (its buffer was dropped): its input reads not taken in
   * ({@link checkIsTurnInputConsumed}). A prompt written to a backend that cannot number its processes names
   * `unnumberedProcessGeneration` (`types.ts`), so it never reads as unwritten once a numbering backend takes the conversation over.
   */
  writtenToProcess?: number;
}

/**
 * @name WatchedTurnState
 * @description Where a watched turn stands: still running (or not started on
 * our message yet), ended, or gone (the session is no longer active — the
 * backstop takes over). A session not active while something holds its turn
 * open — its START under way, a recovery restarting it — is coming, not gone:
 * the message forwarded to it waits in the startup buffer and replays once the
 * session is up, so the watch must survive to see THAT turn end. Dropped, the
 * replayed turn would run unwatched: a silent one would wait for the backstop
 * (90 min) instead of its wake-up, and a backstop wake re-posts the request.
 * Under a tracker's rules the agent's own pending work may keep the turn `running`
 * ({@link checkIsHeldByOwnWork}, read by the caller, which has the request): the
 * turn that work starts by itself belongs to it, and the watch decides only once
 * nothing of the agent's own is pending, or the hold no longer applies.
 */
export type WatchedTurnState = 'running' | 'ended' | 'sessionGone';

/**
 * @description Whether a watch's request prompt has reached no process: it names none while the backend names its live one — it waits
 * in a startup window still (its replay names it), or that window dropped it. Nothing the live process lists or does is about it.
 */
export function checkIsPromptNeverWritten(turn: WatchedTurn, probe: SessionTurnProbe): boolean {
  return turn.isRequestPrompt && turn.writtenToProcess === undefined && probe.processGeneration !== undefined;
}

/**
 * @description Has the backend taken in what was forwarded for this turn? Its own
 * signal when it has one (nothing written is still unread), else busy or output
 * seen since the forward. A request prompt that never reached a process
 * ({@link checkIsPromptNeverWritten}) is not taken in, so the turn is not decided and R21
 * marks nothing (the stale drop and the backstop re-post it).
 */
export function checkIsTurnInputConsumed(turn: WatchedTurn, probe: SessionTurnProbe): boolean {
  if (checkIsPromptNeverWritten(turn, probe)) return false;
  return probe.hasUnconsumedInput === null ? turn.hasSeenBusy || turn.hasSeenOutput : !probe.hasUnconsumedInput;
}

/**
 * @description Has the turn the request's message started ended? The backend
 * must first have TAKEN IN the message — otherwise an idle reported for the
 * earlier turn would read as this turn's end: a backend that tracks it says so
 * (`hasUnconsumedInput`), one that does not must have been seen busy or
 * producing output since the forward (the busy-onset race).
 */
export function getWatchedTurnState(turn: WatchedTurn, probe: SessionTurnProbe, isHeldByOwnWork = false): WatchedTurnState {
  if (!probe.isActive) return probe.isTurnEndBlocked ? 'running' : 'sessionGone';
  if (!checkIsTurnInputConsumed(turn, probe) || probe.isBusy || probe.isTurnEndBlocked || isHeldByOwnWork) return 'running';
  return 'ended';
}

/**
 * @description Has a watched turn that is still `running` lost its tracking? It
 * is idle, nothing holds it open, and nothing was seen working on the request
 * for the whole backstop window — so what keeps it `running` is a consumption
 * signal that never settled (an input counter left behind, a turn start never
 * seen). Dropping the watch hands the request to the backstop: a watch that
 * stayed forever would silence every wake-up and alert of the request.
 */
export function checkIsWatchedTurnStale(
  request: OpenRequestState,
  probe: SessionTurnProbe,
  nowMs: number,
  backstopMs: number,
  rules: WakeUpRuleSet = 'topic',
): boolean {
  if (probe.isBusy || probe.isTurnEndBlocked || checkIsHeldByOwnWork(request, probe, rules, nowMs)) return false;
  return nowMs - (request.lastTurnActivityAt ?? request.createdAt) >= backstopMs;
}
