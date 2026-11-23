import type { SessionKey } from '../sessionKey';
import type { AgentAdapter } from '../types';
import { unnumberedProcessGeneration, type SessionTurnProbe } from './wakeUpRules';

/**
 * @description How the wake-up engine sees a conversation's session right now
 * (request/answer core S4), built from the adapter and the bot's per-thread
 * state. Kept out of `bot.ts` so each "not a turn end" rule is testable.
 *
 * What holds a turn open (a wake-up must not fire, a watched turn has not ended):
 *  - a pending native question — the bot's own pending state, the question pin,
 *    or the adapter reading a TUI selector / login code prompt off the pane (the
 *    pin exists only when pinning succeeded, so the adapter is the authority);
 *  - a running compaction;
 *  - an API-error retry or usage-limit wait still ARMED — a fired record stays
 *    for its grace window, and counting it would hold the turn until the next
 *    user message;
 *  - a wedged-turn recovery in flight: it restarts the session and replays the
 *    original prompt (which carries the request header), so a reminder on top
 *    would be a second recovery of the same turn;
 *  - an API-error retry or limit resume being KICKED: from the moment its timer
 *    fired until its "continue" nudge was forwarded the retry is no longer armed,
 *    yet the idle the error left behind is not a turn end either;
 *  - an API error the bot is still HANDLING with nothing armed («wait for reset» off,
 *    a used-up credit balance, an account refusal): the adapter reports the error right
 *    before the turn's end, and until the bot's stop, move or wait has landed that turn
 *    is no silent one — decided at once, its reminder would go into the limited or refused
 *    session and end on the same error, the give-up;
 *  - a RE-SPAWN of the process under way or about to start (`checkIsRespawnPending`: a model, effort
 *    or account change; an account switch deferred while the turn worked starts one tick after its
 *    end): the turn is decided once the new process is up, and its reminder goes into it — the process
 *    down for the re-spawn would otherwise read as a session gone (an ensure waits for the re-spawn:
 *    `waitForRespawn`);
 *  - a session START under way: a request's first post is starting the session it
 *    will run in, so nothing has gone quiet — without this the sweep reads the
 *    request as one nobody works on and wakes it (or raises an alert) once the
 *    backstop window is shorter than the start;
 *  - the REPLAY of the prompts buffered during that start: the window closes before
 *    the first replayed write, and a fresh session reports nothing unread, so without
 *    this every watch made while the session started reads as an ENDED turn at the
 *    replay's first write — a silent turn the agent never had.
 *
 * A session still starting has not taken in what was forwarded to it either: the
 * prompt waits in the startup buffer, while a backend may already report itself
 * active with nothing unread.
 */

/**
 * @name SessionTurnProbeDeps
 * @description The bot state the probe reads, per serialized conversation key.
 * `getApiRetryTimer` returns `undefined` when there is no record, `null` when the
 * record's timer already fired, the timer while it is armed.
 */
export interface SessionTurnProbeDeps {
  getAdapter: (key: SessionKey) => Pick<
    AgentAdapter,
    'checkIsActive' | 'checkIsBusy' | 'checkHasUnconsumedInput' | 'isQuestionPending' | 'isLoginPastePending' | 'checkIsRespawnPending'
    | 'checkIsTurnOnItsWay' | 'checkIsCliOwnTurn' | 'getProcessGeneration'
  >;
  checkHasPendingQuestion: (keyString: string) => boolean;
  checkHasQuestionPin: (keyString: string) => boolean;
  checkIsCompacting: (keyString: string) => boolean;
  getApiRetryTimer: (keyString: string) => NodeJS.Timeout | null | undefined;
  checkIsWedgeRecoveryInFlight: (keyString: string) => boolean;
  checkIsRetryKickInFlight: (keyString: string) => boolean;
  /** An API error that armed nothing is being handled: its stop, move or wait has not landed yet. */
  checkIsApiErrorInHandling: (keyString: string) => boolean;
  /** The session is in its startup window: prompts forwarded now are buffered, not written. */
  checkIsSessionStarting: (keyString: string) => boolean;
  /** The prompts buffered during the start are being written now (`StartupPromptBuffer.checkIsReplaying`): still the start. */
  checkIsReplayingBufferedPrompts: (keyString: string) => boolean;
  serializeKey: (key: SessionKey) => string;
}

/** @description Build the probe the wake-up engine polls. */
export function createSessionTurnProbe(deps: SessionTurnProbeDeps): (key: SessionKey) => SessionTurnProbe {
  return (key) => {
    const keyString = deps.serializeKey(key);
    const adapter = deps.getAdapter(key);
    const isActive = adapter.checkIsActive(key);
    const isWindowOpen = deps.checkIsSessionStarting(keyString);
    const isStarting = isWindowOpen || deps.checkIsReplayingBufferedPrompts(keyString);
    const isTurnEndBlocked =
      deps.checkHasPendingQuestion(keyString) ||
      deps.checkHasQuestionPin(keyString) ||
      (adapter.isQuestionPending?.(key) ?? false) ||
      (adapter.isLoginPastePending?.(key) ?? false) ||
      (adapter.checkIsRespawnPending?.(key) ?? false) ||
      deps.checkIsCompacting(keyString) ||
      Boolean(deps.getApiRetryTimer(keyString)) ||
      deps.checkIsWedgeRecoveryInFlight(keyString) ||
      deps.checkIsRetryKickInFlight(keyString) ||
      deps.checkIsApiErrorInHandling(keyString) ||
      isStarting;
    // A finished task's own turn on its way is busy already: the watched turn runs on into it (the agent may answer there).
    const isBusy = isActive && ((adapter.checkIsBusy?.(key) ?? false) || (adapter.checkIsTurnOnItsWay?.(key) ?? false));
    // The replay writes into the process the start brought up, so it is named during the replay; an open window names none. A backend
    // that cannot number its processes names its live one all the same: a prompt written there is never left unnamed (review 21 #1 b).
    const processGeneration = isActive && !isWindowOpen
      ? (adapter.getProcessGeneration ? adapter.getProcessGeneration(key) : unnumberedProcessGeneration)
      : undefined;
    return {
      isActive,
      isBusy,
      ...(isBusy && (adapter.checkIsCliOwnTurn?.(key) ?? false) ? { isCliOwnTurn: true } : {}),
      ...(processGeneration === undefined ? {} : { processGeneration }),
      ...(isWindowOpen ? { isWindowOpen: true } : {}),
      hasUnconsumedInput: isStarting
        ? true
        : adapter.checkHasUnconsumedInput ? adapter.checkHasUnconsumedInput(key) : null,
      isTurnEndBlocked,
    };
  };
}
