import { checkIsRateLimitedError } from '../../rateLimiter';
import { checkIsApiError, checkIsForbiddenError, getErrorCode } from '../../sendErrorClassifier';
import { checkIsNetworkError, checkIsRetryableTelegramError } from '../../utils/telegramError';
import type { ThreadSendOutcome } from './sendOutcome';

/**
 * @description Whether a Bot API call that failed with `error` may succeed if made again later. A Bot API answer is judged by its
 * code (429 and 5xx pass, any other is final: the topic is closed, the message is gone, the bot lost its right, the chat is
 * gone); the pacer's own «rate limit survived the wait» error passes too; with no answer at all only the NETWORK may be at fault
 * (Telegram unreachable or silent). Anything else — a bug in our code, a TypeError, a thrown string — is final: the same
 * exception would come back at every try, for ever.
 */
export function checkIsTelegramFailureRetryable(error: unknown): boolean {
  if (checkIsRateLimitedError(error)) return true;
  if (checkIsApiError(error) && getErrorCode(error) !== undefined) return checkIsRetryableTelegramError(error);
  return checkIsNetworkError(error);
}

/**
 * @description The outcome of a send that FAILED with `error`: whether trying again later may help ({@link checkIsTelegramFailureRetryable}) and — set
 * only when true — that Telegram answered 403, so the bot may not write to that chat at all (a person who never opened a private chat with it, or blocked it).
 */
export function getFailedSendOutcome(error: unknown): Extract<ThreadSendOutcome, { kind: 'failed' }> {
  return { kind: 'failed', isRetryable: checkIsTelegramFailureRetryable(error), ...(checkIsForbiddenError(error) ? { isForbidden: true } : {}) };
}
