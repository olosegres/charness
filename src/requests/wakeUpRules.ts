import type { OpenRequestState, OpenRequestUpdate, RequestAlertReason, RequestWakeUpReason } from './types';
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
 */
export function getPostRetryUpdate(request: OpenRequestState, nowMs: number): OpenRequestUpdate | null {
  const retryCount = request.postRetryCount ?? 0;
  const delayMs = postRetryDelaysMs[retryCount];
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
 * @description The decision at the end of a turn the request's message started.
 * `progressCountAtTurnStart` is the request's progress-answer count when the
 * turn began, so an increase means this turn sent a progress note (a `question`
 * or `final` would have closed the request — there is nothing to decide then).
 */
export function decideTurnEnd(request: OpenRequestState, progressCountAtTurnStart: number, nowMs: number): WakeUpDecision {
  if (checkIsWakingStopped(request)) return { kind: 'none' };
  if (request.progressAnswerCount > progressCountAtTurnStart) {
    return {
      kind: 'followUpLater',
      update: { silentTurnCount: 0, nextWakeAt: nowMs + progressFollowUpDelayMs, lastTurnActivityAt: nowMs },
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
 * backstop back (the caller records it).
 */
export function decideUnwatchedRequest(
  request: OpenRequestState,
  probe: SessionTurnProbe,
  nowMs: number,
  backstopMs: number,
): WakeUpDecision {
  if (checkIsWakingStopped(request) || probe.isBusy || probe.isTurnEndBlocked) return { kind: 'none' };
  if (request.nextPostRetryAt !== undefined) {
    // R28: outside the wake-up cap — the agent never saw the request, it is not looping.
    return nowMs >= request.nextPostRetryAt
      ? { kind: 'wake', reason: 'postRetry', update: { nextPostRetryAt: undefined, lastTurnActivityAt: nowMs } }
      : { kind: 'none' };
  }
  if (request.nextWakeAt !== undefined) {
    return nowMs >= request.nextWakeAt ? getWakeOrCapDecision(request, 'progressFollowUp', {}) : { kind: 'none' };
  }
  const lastSeenAt = request.lastTurnActivityAt ?? request.createdAt;
  return nowMs - lastSeenAt >= backstopMs
    ? getWakeOrCapDecision(request, 'backstop', { lastTurnActivityAt: nowMs })
    : { kind: 'none' };
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
