/**
 * @description What a process-level Telegram test needs to play the operator in ONE
 * forum topic of the fake Bot API: read the bot's messages in the topic, wait for one,
 * type a message and await the bot's reply to it, tap a button, read a picker's labels.
 *
 * It knows nothing about a flow: the test owns the instance's layout, its env file and
 * its readiness line (`../e2e/isolatedCharness.ts`).
 */

import type { IsolatedCharness } from '../e2e/isolatedCharness';
import type { FakeTelegram, FakeTelegramMessage } from './fakeTelegram';

/** A command's reply: a poll round trip and the paced send. */
export const defaultReplyTimeoutMs = 20 * 1000;

export class TopicDriver {
  constructor(
    private readonly fakeTelegram: FakeTelegram,
    private readonly getCharness: () => IsolatedCharness,
    private readonly threadId: number,
    private readonly replyTimeoutMs: number = defaultReplyTimeoutMs,
  ) {}

  /** @description The bot's messages in the topic, oldest first, with their CURRENT text. */
  listMessages(): FakeTelegramMessage[] {
    return this.fakeTelegram.listBotMessages(this.threadId);
  }

  /** @description Wait for a bot message `check` accepts, newest first; resolves it. */
  async waitForMessage(description: string, check: (message: FakeTelegramMessage) => boolean): Promise<FakeTelegramMessage> {
    let found: FakeTelegramMessage | undefined;
    await this.getCharness().waitFor(description, this.replyTimeoutMs, () => {
      found = [...this.listMessages()].reverse().find(check);
      return found !== undefined;
    });
    if (!found) throw new Error(`no message for ${description}`);
    return found;
  }

  /** @description The operator types `text`; resolves the bot's next message containing `expectedText`. */
  async sendAndAwaitReply(text: string, expectedText: string): Promise<FakeTelegramMessage> {
    const sentMessageId = this.fakeTelegram.pushOperatorMessage(this.threadId, text);
    return this.waitForMessage(`a reply to "${text}" with "${expectedText}"`, (message) => message.message_id > sentMessageId && message.text.includes(expectedText));
  }

  /** @description Wait until `message`'s CURRENT text satisfies `check` (the bot edits a screen in place). */
  async waitForMessageText(description: string, message: FakeTelegramMessage, check: (text: string) => boolean): Promise<void> {
    await this.getCharness().waitFor(description, this.replyTimeoutMs, () => check(message.text));
  }

  /** @description The operator taps `callbackData` on `message` and waits for the callback to be answered. */
  async tapAndAwaitAnswer(message: FakeTelegramMessage, callbackData: string): Promise<string> {
    const answersBefore = this.fakeTelegram.callbackAnswers.length;
    this.fakeTelegram.pushCallback(message.message_id, callbackData);
    await this.getCharness().waitFor(`the tap on ${callbackData} to be answered`, this.replyTimeoutMs, () => this.fakeTelegram.callbackAnswers.length > answersBefore);
    return this.fakeTelegram.callbackAnswers[answersBefore];
  }

  /** @description The button labels of a message's keyboard, row by row. */
  getKeyboardLabels(message: FakeTelegramMessage): string[][] {
    return (message.reply_markup?.inline_keyboard ?? []).map((row) => row.map((button) => button.text));
  }

  /** @description The button callback data of a message's keyboard, row by row. */
  getKeyboardData(message: FakeTelegramMessage): string[][] {
    return (message.reply_markup?.inline_keyboard ?? []).map((row) => row.map((button) => button.callback_data));
  }
}
