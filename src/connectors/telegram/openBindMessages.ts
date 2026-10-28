/**
 * The messages the bot has open in a topic that offer a bind or ask for a folder's name: a `/bind` picker, the «not bound»
 * reply that carries one, the «send the folder name» prompt of «create new folder». A leaf module (no `bot.ts`, no
 * environment), so a test can reach it.
 */

/** How many are kept per topic: the oldest is dropped past it, so a topic nobody ever binds cannot grow the list. */
export const openBindMessagesPerTopicLimit = 50;

/** How long a bot's message can be deleted, per the Bot API's `deleteMessage` («less than 48 hours ago»). */
export const telegramDeleteWindowMs = 48 * 60 * 60 * 1000;

/**
 * The most keyboards one sweep of a topic's open messages strips: each strip is a paced send of the bot's ONE global gate, so a
 * topic with dozens of pickers must not queue dozens of them. The messages past the bound keep their buttons, and a tap on one
 * is refused instead (`BindPickerClaims.retire`).
 */
export const keyboardStripsPerSweepLimit = 10;

/** A remembered message and when the bot sent it. */
export interface OpenBindMessage {
  messageId: number;
  sentAtMs: number;
}

/**
 * Every plain message in an unbound topic posts a picker of its own, and each stays there with live buttons; any bind or
 * leave makes all of them untrue («not bound, pick from the list») and a tap on a stale one would rebind the topic. The bot
 * remembers them here, per topic, to delete them together when the topic is bound or left.
 */
export class OpenBindMessages {
  private readonly byTopic = new Map<string, Map<number, number>>();

  constructor(private readonly limitPerTopic: number = openBindMessagesPerTopicLimit) {}

  /** @description Remember a message the bot sent into the topic at `sentAtMs`. */
  remember(topicKey: string, messageId: number, sentAtMs: number): void {
    const sentAtByMessage = this.byTopic.get(topicKey) ?? new Map<number, number>();
    sentAtByMessage.delete(messageId);
    sentAtByMessage.set(messageId, sentAtMs);
    while (sentAtByMessage.size > this.limitPerTopic) {
      const oldest = sentAtByMessage.keys().next().value;
      if (oldest === undefined) break;
      sentAtByMessage.delete(oldest);
    }
    this.byTopic.set(topicKey, sentAtByMessage);
  }

  /** @description Forget one message (it is gone, or being deleted by whoever holds it). */
  forget(topicKey: string, messageId: number): void {
    this.byTopic.get(topicKey)?.delete(messageId);
  }

  /** @description Every message remembered for the topic, oldest first — and forget them: the caller closes them. */
  take(topicKey: string): OpenBindMessage[] {
    const entries = [...(this.byTopic.get(topicKey) ?? [])].map(([messageId, sentAtMs]) => ({ messageId, sentAtMs }));
    this.byTopic.delete(topicKey);
    return entries;
  }
}

/**
 * @description Split messages into those Telegram still lets the bot delete and those it no longer does: a message sent
 * `telegramDeleteWindowMs` ago or longer stays, whatever is asked, so for it only its buttons can go.
 */
export function splitByDeleteWindow(entries: readonly OpenBindMessage[], nowMs: number): { deletable: number[]; tooOld: number[] } {
  const deletable: number[] = [];
  const tooOld: number[] = [];
  for (const { messageId, sentAtMs } of entries) (nowMs - sentAtMs >= telegramDeleteWindowMs ? tooOld : deletable).push(messageId);
  return { deletable, tooOld };
}
