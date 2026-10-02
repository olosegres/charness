import type { AnswerSink } from '../../platform/answerSink';
import { keyToString } from '../../sessionKey';
import type { SendMessagesToThread } from '../../utils/messageSendService';

/**
 * @description Telegram's answer sink — the BASIC one of core S3: an answer is
 * posted as its own message (split over the message cap) through the same
 * paced, recorded send path as `send_messages_to_user`, which reports whether it
 * landed. Pinning the answer and keeping only the latest one pinned is core S8:
 * it needs the sent message ids back, which this path does not return.
 */
export function createTelegramAnswerSink(deps: { sendMessages: SendMessagesToThread }): AnswerSink {
  return {
    async deliverAnswer(key, delivery) {
      const result = await deps.sendMessages(keyToString(key), { messages: [delivery.body] });
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    },
  };
}
