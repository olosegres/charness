/**
 * The messages the bot has open in a topic that offer a bind or ask for a folder's name: a `/bind` picker, the «not bound»
 * reply that carries one, the «send the folder name» prompt of «create new folder». A leaf module (no `bot.ts`, no
 * environment), so a test can reach it.
 */

/** How many are kept per topic: the oldest is dropped past it, so a topic nobody ever binds cannot grow the list. */
export const openBindMessagesPerTopicLimit = 50;

/**
 * Every plain message in an unbound topic posts a picker of its own, and each stays there with live buttons; any bind or
 * leave makes all of them untrue («not bound, pick from the list») and a tap on a stale one would rebind the topic. The bot
 * remembers them here, per topic, to delete them together when the topic is bound or left.
 */
export class OpenBindMessages {
  private readonly byTopic = new Map<string, Set<number>>();

  constructor(private readonly limitPerTopic: number = openBindMessagesPerTopicLimit) {}

  /** @description Remember a message the bot just sent into the topic. */
  remember(topicKey: string, messageId: number): void {
    const messageIds = this.byTopic.get(topicKey) ?? new Set<number>();
    messageIds.delete(messageId);
    messageIds.add(messageId);
    while (messageIds.size > this.limitPerTopic) {
      const oldest = messageIds.values().next().value;
      if (oldest === undefined) break;
      messageIds.delete(oldest);
    }
    this.byTopic.set(topicKey, messageIds);
  }

  /** @description Forget one message (it is gone, or being deleted by whoever holds it). */
  forget(topicKey: string, messageId: number): void {
    this.byTopic.get(topicKey)?.delete(messageId);
  }

  /** @description Every message remembered for the topic, oldest first — and forget them: the caller closes them. */
  take(topicKey: string): number[] {
    const messageIds = [...(this.byTopic.get(topicKey) ?? [])];
    this.byTopic.delete(topicKey);
    return messageIds;
  }
}
