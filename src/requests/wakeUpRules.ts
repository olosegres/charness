import type { OpenRequestState, OpenRequestUpdate, RequestAlertReason, RequestWakeUpReason } from './types';
import { checkIsAnswerOwed, checkIsHeldBetweenTurns, checkIsWaitingAtTurnEnd, type RequestScheduleWait } from './scheduleWait';
import { getMinutesOverrideMs } from '../utils/minutesOverride';

/**
 * @description The wake-up rules of the request/answer core (S4), as pure
 * decisions over an open request and what the session looks like right now:
 *
 *   turn ends, request still open
 *     └─ the turn sent NO answer      → silent-turn counter +1
 *          counter < 2                → wake the same session at once
 *          counter = 2                → alert a person, stop waking
 *     └─ the turn sent a progress     → counter = 0, wake again after 15 min
 *   cap: 10 wake-ups per request      → alert, stop waking (loop guard)
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
 * armed its watch and ended its turn is not prodded — at the end of a watched turn it is not silent, unless that turn carried a
 * person's words (counter 0, no follow-up, no wake), between turns and at a restart nothing wakes the request while a watch that is not failing holds
 * it. A turn a SCHEDULED RUN started that ends without an answer is not silent either: a woken agent with nothing to
 * report stays quiet. A scheduler fire is never a wake-up of these rules, so it never counts against the cap.
 */

/** Silent turns in a row that make the rules give up. */
export const maxSilentTurns = 2;
/** Wake-ups one request may receive before the loop guard gives up. */
export const maxWakeUpsPerRequest = 10;
/** After a progress answer, how long before the agent is reminded again. */
export const progressFollowUpDelayMs = 15 * 60 * 1000;
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
   * or a session start under way.
   */
  isTurnEndBlocked: boolean;
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
   * bookkeeping only. `isRequestSettled` — the request is one a scheduler fire opened (a Telegram topic's `scheduledRun`) and the
   * agent left it unanswered: nobody is owed its answer and nothing waits for it, so it closes silently instead of waiting for the backstop.
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
 * and the request's reading of its armed jobs (absent: it waits for nothing).
 */
export interface TurnEndContext {
  isScheduledRun?: boolean;
  scheduleWait?: RequestScheduleWait;
  /** The follow-up delay after a progress note, in place of {@link progressFollowUpDelayMs} (a test instance's shorter one). */
  progressFollowUpMs?: number;
}

/**
 * @description The decision at the end of a turn the request's message started.
 * `progressCountAtTurnStart` is the request's progress-answer count when the
 * turn began, so an increase means this turn sent a progress note (a `question`
 * or `final` would have closed the request — there is nothing to decide then).
 * A progress note schedules the follow-up unless the request waits for its schedule (then nothing is scheduled). A turn
 * without an answer is not silent when the turn was a scheduled run's, or when the request waits for its schedule, and in both
 * cases only while the request owes nobody an answer (`checkIsAnswerOwed`, read from the persisted request — never from the kind of
 * the turn, so a lost and rebuilt watch decides alike): a requester's message is never left unanswered because a watch is armed,
 * and the reminder that follows its silent turn keeps counting towards the give-up.
 * A request a scheduler fire opened (`origin.kind` `scheduledRun`) that its agent leaves with no answer at all settles at the quiet
 * end (`isRequestSettled`): it is the alarm's own request, and nobody is owed its answer. A fire's quiet end alone leaves a pending
 * silent-turn count as it is.
 */
export function decideTurnEnd(
  request: OpenRequestState,
  progressCountAtTurnStart: number,
  nowMs: number,
  context: TurnEndContext = {},
): WakeUpDecision {
  if (checkIsWakingStopped(request)) return { kind: 'none' };
  const isProgressSent = request.progressAnswerCount > progressCountAtTurnStart;
  const isWaitingForSchedule = checkIsWaitingAtTurnEnd(context.scheduleWait ?? 'none');
  if (isProgressSent && !isWaitingForSchedule) {
    return {
      kind: 'followUpLater',
      update: { silentTurnCount: 0, nextWakeAt: nowMs + (context.progressFollowUpMs ?? progressFollowUpDelayMs), lastTurnActivityAt: nowMs },
    };
  }
  // A request that owes a person an answer (a silent turn pending, a person's words not answered yet, a person's request never
  // answered): its turn ends silent whatever the turn's kind — a person's own, the reminder's that follows, a continuation of either —
  // or a watch that passes would wipe the count and the rules would never give up on a requester left unanswered. The answer is read
  // from the persisted request, so the same turn decides alike whether or not the engine's watch survived a restart.
  const isQuietWhileWaiting = isWaitingForSchedule && !checkIsAnswerOwed(request);
  // The follow-up is cleared only where a schedule holds the request. A fire's quiet end alone leaves it: a fire may ride a request
  // that waits for nothing (its own job's request is gone), and an unrelated alarm must not wipe that request's due follow-up.
  const isHeldBySchedule = isProgressSent || isQuietWhileWaiting;
  if (isHeldBySchedule || context.isScheduledRun === true) {
    // A fire's quiet end alone must not wipe a silent turn that is pending: the alarm is none of the requester's business, and the
    // count is what ends in the give-up if the agent keeps ignoring them.
    const isCountKept = !isHeldBySchedule && request.silentTurnCount > 0;
    return {
      kind: 'quiet',
      update: {
        lastTurnActivityAt: nowMs,
        ...(isCountKept ? {} : { silentTurnCount: 0 }),
        ...(isHeldBySchedule ? { nextWakeAt: undefined } : {}),
      },
      ...(request.origin.kind === 'scheduledRun' && !isProgressSent ? { isRequestSettled: true } : {}),
    };
  }
  const silentTurnCount = request.silentTurnCount + 1;
  if (silentTurnCount >= maxSilentTurns) {
    return { kind: 'alert', reason: 'silentTurns', update: { silentTurnCount, ...stopWakingUpdate } };
  }
  return getWakeOrCapDecision(request, 'silentTurn', { silentTurnCount, lastTurnActivityAt: nowMs });
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
 * the backstop. Nothing when the request already has its own next step — a post retry or a progress follow-up — or
 * nothing may wake it, or the session is working or blocked (a pending question, an armed retry or usage-limit wait, a
 * start under way), or a watch that is not failing holds it while it owes nobody an answer (`checkIsHeldBetweenTurns`: a restart
 * wakes nobody then, as in a topic).
 * It counts against the wake-up cap like any wake, and is seen activity: the backstop counts from it.
 */
export function decideRestartWake(
  request: OpenRequestState,
  probe: SessionTurnProbe,
  nowMs: number,
  scheduleWait: RequestScheduleWait = 'none',
): WakeUpDecision {
  if (checkIsWakingStopped(request) || probe.isBusy || probe.isTurnEndBlocked) return { kind: 'none' };
  if (request.nextPostRetryAt !== undefined || request.nextWakeAt !== undefined) return { kind: 'none' };
  if (checkIsHeldBetweenTurns(request, scheduleWait)) return { kind: 'none' };
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
  /** A scheduler fire started the turn: ending it without an answer is not silence (a woken agent with nothing to report). */
  isScheduledRun?: boolean;
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
 */
export type WatchedTurnState = 'running' | 'ended' | 'sessionGone';

/**
 * @description Has the backend taken in what was forwarded for this turn? Its own
 * signal when it has one (nothing written is still unread), else busy or output
 * seen since the forward.
 */
export function checkIsTurnInputConsumed(turn: WatchedTurn, probe: SessionTurnProbe): boolean {
  return probe.hasUnconsumedInput === null ? turn.hasSeenBusy || turn.hasSeenOutput : !probe.hasUnconsumedInput;
}

/**
 * @description Has the turn the request's message started ended? The backend
 * must first have TAKEN IN the message — otherwise an idle reported for the
 * earlier turn would read as this turn's end: a backend that tracks it says so
 * (`hasUnconsumedInput`), one that does not must have been seen busy or
 * producing output since the forward (the busy-onset race).
 */
export function getWatchedTurnState(turn: WatchedTurn, probe: SessionTurnProbe): WatchedTurnState {
  if (!probe.isActive) return probe.isTurnEndBlocked ? 'running' : 'sessionGone';
  if (!checkIsTurnInputConsumed(turn, probe) || probe.isBusy || probe.isTurnEndBlocked) return 'running';
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
): boolean {
  if (probe.isBusy || probe.isTurnEndBlocked) return false;
  return nowMs - (request.lastTurnActivityAt ?? request.createdAt) >= backstopMs;
}
