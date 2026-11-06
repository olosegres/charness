import { checkIsRateLimitedError } from '../../rateLimiter';
import { checkIsApiError, getErrorCode } from '../../sendErrorClassifier';
import { checkIsNetworkError, checkIsRetryableTelegramError } from '../../utils/telegramError';

/**
 * @description Whether an unpin that failed with `error` may succeed later. A Bot API answer is judged by its code (429 and 5xx
 * pass, any other is final); the pacer's own «rate limit survived the wait» error passes too; with no answer at all only the
 * NETWORK may be at fault (Telegram unreachable or silent). Anything else — a bug in our code, a TypeError, a thrown string — is
 * final: the same exception would come back at every run of the check, for ever, and one log line each time.
 */
function checkShouldTryUnpinAgain(error: unknown): boolean {
  if (checkIsRateLimitedError(error)) return true;
  if (checkIsApiError(error) && getErrorCode(error) !== undefined) return checkIsRetryableTelegramError(error);
  return checkIsNetworkError(error);
}

/**
 * @description Unpin messages one by one and resolve with the ids still pinned that are WORTH ANOTHER TRY — the contract of
 * the scheduler's `unpinMessages` port. A failure the Bot API answered for good is final: the message is gone, was never
 * pinned (Telegram answers «message to unpin not found»), the bot lost the right to pin, the chat is gone — a retry changes
 * nothing, so the id counts as released and the caller forgets it. So is an error that is neither the network's nor a Bot API
 * answer (a bug of ours): it would repeat at every run. Only a failure that may pass is reported back: Telegram never answered
 * (a dropped connection, a timeout), an exhausted rate-limit wait, a 429, or a 5xx (`checkShouldTryUnpinAgain`). There is no cap
 * on the tries of a retryable id: the outage that causes one ends. Never rejects; `onFailure` is told every failure, final or
 * not, to log it.
 */
export async function unpinMessagesReportingRetryable(
  messageIds: readonly number[],
  unpinOne: (messageId: number) => Promise<void>,
  onFailure: (messageId: number, error: unknown) => void,
): Promise<number[]> {
  const idsToTryAgain: number[] = [];
  for (const messageId of messageIds) {
    try {
      await unpinOne(messageId);
    } catch (error) {
      onFailure(messageId, error);
      if (checkShouldTryUnpinAgain(error)) idsToTryAgain.push(messageId);
    }
  }
  return idsToTryAgain;
}
