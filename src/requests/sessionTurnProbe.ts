import type { SessionKey } from '../sessionKey';
import type { AgentAdapter } from '../types';
import type { SessionTurnProbe } from './wakeUpRules';

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
 *    would be a second recovery of the same turn.
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
    'checkIsActive' | 'checkIsBusy' | 'checkHasUnconsumedInput' | 'isQuestionPending' | 'isLoginPastePending'
  >;
  checkHasPendingQuestion: (keyString: string) => boolean;
  checkHasQuestionPin: (keyString: string) => boolean;
  checkIsCompacting: (keyString: string) => boolean;
  getApiRetryTimer: (keyString: string) => NodeJS.Timeout | null | undefined;
  checkIsWedgeRecoveryInFlight: (keyString: string) => boolean;
  serializeKey: (key: SessionKey) => string;
}

/** @description Build the probe the wake-up engine polls. */
export function createSessionTurnProbe(deps: SessionTurnProbeDeps): (key: SessionKey) => SessionTurnProbe {
  return (key) => {
    const keyString = deps.serializeKey(key);
    const adapter = deps.getAdapter(key);
    const isActive = adapter.checkIsActive(key);
    const isTurnEndBlocked =
      deps.checkHasPendingQuestion(keyString) ||
      deps.checkHasQuestionPin(keyString) ||
      (adapter.isQuestionPending?.(key) ?? false) ||
      (adapter.isLoginPastePending?.(key) ?? false) ||
      deps.checkIsCompacting(keyString) ||
      Boolean(deps.getApiRetryTimer(keyString)) ||
      deps.checkIsWedgeRecoveryInFlight(keyString);
    return {
      isActive,
      isBusy: isActive && (adapter.checkIsBusy?.(key) ?? false),
      hasUnconsumedInput: adapter.checkHasUnconsumedInput ? adapter.checkHasUnconsumedInput(key) : null,
      isTurnEndBlocked,
    };
  };
}
