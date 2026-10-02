import type { SessionKey } from '../sessionKey';
import { getAnswerSink, type AnswerSinks } from '../platform/answerSink';
import type { RequestLedger } from './requestLedger';
import type { RequestWakeUpEngine } from './wakeUpEngine';

/**
 * @description The bot's own answer to an open request when a usage/session
 * limit stops the agent (request/answer core S5): the requester learns the
 * answer is delayed and until when, instead of hearing nothing for hours.
 *
 * It is a `progress` answer delivered straight through the platform's sink —
 * deliberately NOT through `answer_request`: the agent did not send it, so it
 * does not count as the agent's progress note and starts no 15-minute follow-up.
 *
 * Deduplicated per REQUEST and per wait: every request open during a limit wait
 * hears about it once — the one open when the limit hit, and one opened later in
 * the same wait (a scheduled run, a tracker event: they do not cancel the wait).
 */

/**
 * @name UsageLimitWait
 * @description How the limit wait ends: after the provider's reset time, at the
 * bot's next attempt (the reset time is unknown), or not by itself at all
 * (`/auto_continue_limits` is off). `fireAt` is when the bot resumes.
 */
export type UsageLimitWait =
  | { kind: 'afterReset'; resetAt: number; fireAt: number }
  | { kind: 'nextAttempt'; fireAt: number }
  | { kind: 'autoResumeOff' };

/**
 * @description Identifies one limit wait across its repeated errors: an armed
 * wait by its resume instant (every arming gets a new one), the auto-resume-off
 * wait by its kind (it has no instant, and it ends only with the request).
 */
export function getUsageLimitWaitIdentity(wait: UsageLimitWait): string {
  return wait.kind === 'autoResumeOff' ? wait.kind : `resumeAt:${wait.fireAt}`;
}

/**
 * @name ArmedLimitWait
 * @description The topic's armed usage-limit resume, as the bot's retry manager
 * holds it. `wait` is absent for a resume re-armed from `state.json` at boot
 * (which keeps only the instant).
 */
export interface ArmedLimitWait {
  fireAt: number;
  wait?: UsageLimitWait;
}

/**
 * @name LimitEpisodeState
 * @description The topic's usage-limit situation when a request is opened.
 */
export interface LimitEpisodeState {
  armedLimitWait: ArmedLimitWait | null;
  /** A limit hit with auto-resume off, and the operator has not written since. */
  isAutoResumeOffNoticed: boolean;
  isAutoResumeOn: boolean;
}

/**
 * @description The limit wait a request opened right now falls into, or `null`
 * when the topic is not waiting out a limit. An operator message cancels the
 * wait BEFORE its request is opened, so only a request that does not cancel it
 * (a scheduled run, a tracker event) ever lands here.
 */
export function getLimitWaitForNewRequest(episode: LimitEpisodeState): UsageLimitWait | null {
  if (episode.armedLimitWait) {
    return episode.armedLimitWait.wait ?? { kind: 'nextAttempt', fireAt: episode.armedLimitWait.fireAt };
  }
  // Turning auto-resume back on ends the "I continue when you write" promise.
  if (episode.isAutoResumeOffNoticed && !episode.isAutoResumeOn) return { kind: 'autoResumeOff' };
  return null;
}

export interface LimitWaitAnswerDeps {
  ledger: Pick<RequestLedger, 'getOpenRequest' | 'updateOpenRequest'>;
  engine: Pick<RequestWakeUpEngine, 'stopWakingForLimitWait'>;
  answerSinks: AnswerSinks;
}

/**
 * @name LimitWaitAnswerOutcome
 * @description `notAnswered` (no open request, or the delivery failed) leaves the
 * caller's plain limit notice to say it; after `answered` or `alreadyAnswered`
 * the notice would say the same thing twice.
 */
export type LimitWaitAnswerOutcome = 'answered' | 'alreadyAnswered' | 'notAnswered';

/**
 * @description Tell the conversation's open request about a limit wait, once per
 * request and wait. With auto-resume off nothing will continue the work, so the
 * request also stops being woken (liftable: a later wait that ends with a resume
 * lifts it).
 */
export async function answerOpenRequestForLimitWait(
  deps: LimitWaitAnswerDeps,
  key: SessionKey,
  wait: UsageLimitWait,
  body: string,
): Promise<LimitWaitAnswerOutcome> {
  const request = deps.ledger.getOpenRequest(key);
  if (!request) return 'notAnswered';
  const identity = getUsageLimitWaitIdentity(wait);
  // The common repeat (another frame of the same error) costs no state write.
  if (request.limitWaitAnsweredFor === identity) return 'alreadyAnswered';
  // Claimed under the ledger lock: a repeated error and a request opened at the same moment must not answer twice.
  let isClaimed = false;
  const claimed = await deps.ledger.updateOpenRequest(request.id, (current) => {
    isClaimed = current.limitWaitAnsweredFor !== identity;
    return isClaimed ? { limitWaitAnsweredFor: identity } : {};
  });
  if (!claimed) return 'notAnswered';
  if (!isClaimed) return 'alreadyAnswered';
  if (wait.kind === 'autoResumeOff') await deps.engine.stopWakingForLimitWait(key);

  const lookup = getAnswerSink(deps.answerSinks, key);
  const result = lookup.ok
    ? await lookup.sink.deliverAnswer(key, {
      requestId: request.id,
      kind: 'progress',
      body,
      origin: request.origin,
      isRequestOpen: true,
    })
    : lookup;
  if (!result.ok) {
    console.warn(`[requests] limit answer for ${request.id} not delivered: ${result.error}`);
    // Unclaimed, so the next error of this wait tries again.
    await deps.ledger.updateOpenRequest(request.id, (current) =>
      current.limitWaitAnsweredFor === identity ? { limitWaitAnsweredFor: undefined } : {},
    );
    return 'notAnswered';
  }
  if (result.warning) console.warn(`[requests] limit answer for ${request.id} delivered partly: ${result.warning}`);
  return 'answered';
}
