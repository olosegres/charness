import type { SessionKey } from '../sessionKey';
import type { AnswerSinks } from '../platform/answerSink';
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
 */

/**
 * @name UsageLimitWait
 * @description How the limit wait ends: after the provider's reset time, at the
 * bot's next attempt (the reset time is unknown), or not by itself at all
 * (`/auto_continue_limits` is off).
 */
export type UsageLimitWait =
  | { kind: 'afterReset'; resetAt: number }
  | { kind: 'nextAttempt'; fireAt: number }
  | { kind: 'autoResumeOff' };

export interface LimitWaitAnswerDeps {
  ledger: Pick<RequestLedger, 'getOpenRequest'>;
  engine: Pick<RequestWakeUpEngine, 'stopWakingForLimitWait'>;
  answerSinks: AnswerSinks;
}

/**
 * @description Tell the conversation's open request about a limit wait. With
 * auto-resume off nothing will continue the work, so the request also stops
 * being woken. Resolves `true` when the answer was delivered — the caller's plain
 * limit notice would then say the same thing twice — and `false` when there is no
 * open request or the delivery failed (the caller posts the plain notice).
 */
export async function answerOpenRequestForLimitWait(
  deps: LimitWaitAnswerDeps,
  key: SessionKey,
  wait: UsageLimitWait,
  body: string,
): Promise<boolean> {
  const request = deps.ledger.getOpenRequest(key);
  if (!request) return false;
  if (wait.kind === 'autoResumeOff') await deps.engine.stopWakingForLimitWait(key);
  const sink = deps.answerSinks.get(key.platform);
  if (!sink) return false;
  const result = await sink.deliverAnswer(key, {
    requestId: request.id,
    kind: 'progress',
    body,
    origin: request.origin,
    isRequestOpen: true,
  });
  if (!result.ok) console.warn(`[requests] limit answer for ${request.id} not delivered: ${result.error}`);
  return result.ok;
}
