import { checkIsRetryableTelegramError } from '../../utils/telegramError';

/**
 * @description Unpin messages one by one and resolve with the ids still pinned that are WORTH ANOTHER TRY — the contract of
 * the scheduler's `unpinMessages` port. A failure the Bot API answered for good is final: the message is gone, was never
 * pinned (Telegram answers «message to unpin not found»), the bot lost the right to pin, the chat is gone — a retry changes
 * nothing, so the id counts as released and the caller forgets it. Only a failure that may pass is reported back: Telegram
 * never answered (a dropped connection, a timeout, an exhausted rate-limit wait), asked the bot to slow down, or failed on its
 * side (`checkIsRetryableTelegramError`). Never rejects; `onFailure` is told every failure, final or not, to log it.
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
      if (checkIsRetryableTelegramError(error)) idsToTryAgain.push(messageId);
    }
  }
  return idsToTryAgain;
}
