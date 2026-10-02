import type { AnswerSink } from '../../platform/answerSink';
import type { RequestAlertReason } from '../../requests/types';
import { keyToString, type SessionKey } from '../../sessionKey';
import type { SendMessagesToThread } from '../../utils/messageSendService';

/**
 * @name TelegramAnswerSinkDeps
 * @description The bot primitives the sink drives. `postAlert` sends the
 * localized alert text and resolves its message id (`null` when the send
 * failed); the pin helpers swallow their own failures.
 */
export interface TelegramAnswerSinkDeps {
  sendMessages: SendMessagesToThread;
  postAlert: (key: SessionKey, requestId: string, reason: RequestAlertReason) => Promise<number | null>;
  pinMessage: (key: SessionKey, messageId: number) => Promise<boolean>;
  unpinMessage: (key: SessionKey, messageId: number) => Promise<void>;
}

/**
 * @description Telegram's answer sink — the BASIC one of core S3: an answer is
 * posted as its own message (split over the message cap) through the same
 * paced, recorded send path as `send_messages_to_user`, which reports whether it
 * landed. A partial delivery (some of the split messages failed) still counts as
 * delivered but comes back as a warning, so the agent knows part of the answer is
 * missing. Pinning the answer and keeping only the latest one pinned is core S8:
 * it needs the sent message ids back, which this path does not return.
 *
 * The wake-up alert (core S4) is a bot message naming the request, PINNED with a
 * notification — the operator runs topics muted and a pin is what notifies —
 * and unpinned when that request closes. Its message id is the alert handle.
 */
export function createTelegramAnswerSink(deps: TelegramAnswerSinkDeps): AnswerSink {
  return {
    async deliverAnswer(key, delivery) {
      const result = await deps.sendMessages(keyToString(key), { messages: [delivery.body] });
      if (!result.ok) return { ok: false, error: result.error };
      return result.undeliveredCount > 0 ? { ok: true, warning: result.summary } : { ok: true };
    },

    async deliverAlert(key, alert) {
      const messageId = await deps.postAlert(key, alert.requestId, alert.reason);
      if (messageId === null) return { ok: false, error: 'the alert message could not be sent' };
      const isPinned = await deps.pinMessage(key, messageId);
      // Unpinned it still stands in the topic; only a pinned one needs releasing.
      return isPinned ? { ok: true, alertRef: messageId.toString() } : { ok: true };
    },

    async releaseAlert(key, alertRef) {
      const messageId = Number(alertRef);
      if (Number.isInteger(messageId)) await deps.unpinMessage(key, messageId);
    },
  };
}
