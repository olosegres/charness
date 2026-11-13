import type { AnswerSink } from '../../platform/answerSink';
import type { RequestAlertReason } from '../../requests/types';
import { keyToString, type SessionKey } from '../../sessionKey';
import { KeyLock } from '../../state';
import type { SendMessagesToThread } from '../../utils/messageSendService';

/**
 * @name TelegramAnswerSinkDeps
 * @description The bot primitives the sink drives. `postAlert` sends the
 * localized alert text and resolves its message id (`null` when the send
 * failed); the pin helpers swallow their own failures and `pinMessage` pins WITH
 * a notification; the answer-pin store remembers the latest pinned answer per
 * conversation across restarts.
 */
export interface TelegramAnswerSinkDeps {
  sendMessages: SendMessagesToThread;
  postAlert: (key: SessionKey, requestId: string, reason: RequestAlertReason) => Promise<number | null>;
  pinMessage: (key: SessionKey, messageId: number) => Promise<boolean>;
  unpinMessage: (key: SessionKey, messageId: number) => Promise<void>;
  getAnswerPinMessageId: (key: SessionKey) => number | undefined;
  setAnswerPinMessageId: (key: SessionKey, messageId: number) => Promise<void>;
}

/**
 * @description Telegram's answer sink (core S3, pins S8): an answer is posted as
 * its own message (split over the message cap) through the same paced, recorded
 * send path as `send_messages_to_user`, which reports whether it landed. A
 * partial delivery (some of the split messages failed) still counts as
 * delivered but comes back as a warning, so the agent knows part of the answer is
 * missing.
 *
 * Every delivered answer is PINNED with a notification — the operator runs
 * topics muted and a pin is what notifies — and only the LATEST answer of a
 * conversation stays pinned: the previous answer's pin is released silently, the
 * message itself stays in the chat. The record of the pinned answer is persisted,
 * so an answer after a restart still releases the one before. A pin that fails
 * leaves the previous record as it is — nothing was replaced. Native question
 * pins and scheduled-run pins are separate records and never touched here. Of a
 * split answer the FIRST message is pinned: the notification previews its start.
 * The pin hand-over is serialized per conversation: two answers delivered at once
 * (parallel `answer_request` calls) would otherwise both read the same previous
 * pin and leave the earlier of them pinned for good.
 *
 * An answer whose delivery outcome is unknown (Telegram did not answer within the send
 * queue's deadline) is reported delivered with a warning, never as an error: the agent
 * would send it again, and the topic could get it twice.
 *
 * The answer is the last thing of its turn in the topic: the shared message sender
 * lands the text the agent streamed before calling `answer_request` (held back for
 * a moment by the adapter and the per-topic output debounce) before it posts the
 * answer.
 *
 * The wake-up alert (core S4) is a bot message naming the request, PINNED with a
 * notification and unpinned when that request closes. Its message id is the
 * alert handle.
 */
/** What the agent is told when Telegram did not confirm its answer in time. */
export const answerDeliveryUnknownWarning =
  'Telegram did not confirm this answer in time: it may or may not be in the topic, and it is not pinned. Do not send it again.';

export function createTelegramAnswerSink(deps: TelegramAnswerSinkDeps): AnswerSink {
  const answerPinLock = new KeyLock();

  function pinLatestAnswer(key: SessionKey, messageId: number): Promise<void> {
    return answerPinLock.withLock(keyToString(key), async () => {
      const previousMessageId = deps.getAnswerPinMessageId(key);
      if (previousMessageId === messageId) return;
      const isPinned = await deps.pinMessage(key, messageId);
      if (!isPinned) return;
      // The new pin is up; the previous answer leaves the pinned bar quietly.
      if (previousMessageId !== undefined) await deps.unpinMessage(key, previousMessageId);
      await deps.setAnswerPinMessageId(key, messageId);
    });
  }

  return {
    async deliverAnswer(key, delivery) {
      const result = await deps.sendMessages(keyToString(key), { messages: [delivery.body] });
      // The answer may be in the topic: reported as delivered, so the agent does not send it again (a duplicate pinned answer),
      // with a warning; it cannot be pinned — its message id is not known.
      if (!result.ok && 'kind' in result && result.kind === 'deliveryUnknown') return { ok: true, warning: answerDeliveryUnknownWarning };
      if (!result.ok) return { ok: false, error: result.error };
      const [firstMessageId] = result.sentMessageIds;
      if (firstMessageId !== undefined) await pinLatestAnswer(key, firstMessageId);
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
