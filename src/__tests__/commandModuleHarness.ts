/**
 * @description What a unit test of a Telegram command module (`connectors/telegram/commands/`) needs: a
 * `BotCore` whose telegraf instance is REAL (its middleware chain runs, so a button tap goes through
 * `handleUpdate`) and talks to the fake Bot API, whose state is the REAL store, and whose topic sends are
 * recorders. The harness hands the module its ports and keeps what the module registered and what it sent.
 *
 * Matches neither the `*.test.ts` nor the `*.e2e.ts` runner globs, so it is never run as a test itself.
 */

import { Telegraf } from 'telegraf';
import type { BotCore, CommandContext, RegisterCommand } from '../connectors/telegram/commands/botCore';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import type { SessionKey } from '../sessionKey';
import { getStateStore, type StateStore } from '../state';
import { FakeTelegram } from './telegramE2e/fakeTelegram';

export const harnessGroup = { id: -1001111111111, title: 'ExampleGroup' };
export const harnessThreadId = 111;
export const harnessOperator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true as const, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
/** Where the ids of the messages the module sends start, clear of the fake Bot API's own sequence. */
const firstRecordedMessageId = 500;

/** One send or edit the module made through the topic helpers. */
export interface RecordedSend {
  messageId: number | null;
  text: string;
  extra: object | undefined;
}

type CommandHandler = Parameters<RegisterCommand>[1];

/** @description A command's context as far as the handlers read it: the typed message's id. */
function createCommandContext(messageId: number): CommandContext {
  return { message: { message_id: messageId } } as CommandContext;
}

/** The id of the operator's command message when a test does not name one. */
const defaultCommandMessageId = 1;

export class CommandHarness {
  readonly key: SessionKey = makeTelegramKey(harnessGroup.id, harnessThreadId);
  readonly replies: RecordedSend[] = [];
  readonly edits: RecordedSend[] = [];
  readonly deletedMessageIds: number[] = [];
  readonly cancelledRequestKeys: SessionKey[] = [];
  readonly pinnedStatusUpdateKeys: SessionKey[] = [];
  readonly registeredCommandNames: string[] = [];
  /** Every `bot.action` trigger, in registration order, as telegraf was given it (a regex as its source text). */
  readonly registeredActionPatterns: string[] = [];
  readonly core: BotCore;
  private readonly commandHandlers = new Map<string, CommandHandler>();
  private nextSentMessageId = firstRecordedMessageId;
  private callbackSequence = 0;

  constructor(
    readonly fakeTelegram: FakeTelegram,
    readonly state: StateStore,
    apiRoot: string,
  ) {
    const bot = new Telegraf(fakeBotToken, { telegram: { apiRoot } });
    bot.botInfo = { ...botUser, can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false };
    const originalAction = bot.action.bind(bot);
    bot.action = (...args: Parameters<Telegraf['action']>) => {
      this.registeredActionPatterns.push(String(args[0]));
      return originalAction(...args);
    };
    this.core = {
      bot,
      command: (name, handler) => {
        for (const commandName of [name].flat()) {
          this.registeredCommandNames.push(commandName);
          this.commandHandlers.set(commandName, handler);
        }
      },
      getState: () => this.state,
      replyToThread: async (_key, text, extra) => {
        const messageId = this.nextSentMessageId++;
        this.replies.push({ messageId, text, extra });
        return messageId;
      },
      editThreadMessage: async (_key, messageId, text, extra) => {
        this.edits.push({ messageId, text, extra });
        return true;
      },
      deleteThreadMessage: async (_key, messageId) => {
        this.deletedMessageIds.push(messageId);
      },
      authoriseContext: async () => this.key,
      withThreadLocale: (_key, run) => run(),
      checkIsGeneral: () => false,
      updatePinnedStatus: async (key) => {
        this.pinnedStatusUpdateKeys.push(key);
      },
      cancelConversationRequest: (key) => {
        this.cancelledRequestKeys.push(key);
      },
    };
  }

  /** @description Run the registered handler of `/name args` as the operator typing it in message `messageId`. */
  async runCommand(name: string, argsText = '', messageId = defaultCommandMessageId): Promise<void> {
    const handler = this.commandHandlers.get(name);
    if (!handler) throw new Error(`/${name} is not registered`);
    await handler(createCommandContext(messageId), this.key, { name, args: argsText ? argsText.split(' ') : [], argsText });
  }

  /** @description The operator taps `callbackData` on the bot's message `messageId`, through telegraf's middleware chain. */
  async tapButton(messageId: number, callbackData: string): Promise<void> {
    this.callbackSequence += 1;
    const message = this.fakeTelegram.getMessage(this.fakeTelegram.pushOperatorMessage(harnessThreadId, `screen ${messageId}`));
    if (!message) throw new Error('the fake Bot API lost the message it just stored');
    await this.core.bot.handleUpdate({
      update_id: this.callbackSequence,
      callback_query: {
        id: this.callbackSequence.toString(),
        from: harnessOperator,
        message: { ...message, message_id: messageId },
        chat_instance: 'fake-chat-instance',
        data: callbackData,
      },
    });
  }

  /** @description The inline keyboard a send or edit carried, as callback data row by row. */
  getKeyboardData(sent: RecordedSend | undefined): string[][] {
    const extra = sent?.extra;
    if (!extra || !('reply_markup' in extra)) return [];
    const markup = extra.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
    return markup.inline_keyboard.map((row) => row.map((button) => button.callback_data));
  }

  async stop(): Promise<void> {
    await this.fakeTelegram.stop();
  }
}

/** @description Start the fake Bot API and build a harness over it and the real state store. */
export async function createCommandHarness(): Promise<CommandHarness> {
  const fakeTelegram = new FakeTelegram({ botUser, operator: harnessOperator, group: harnessGroup });
  const apiRoot = await fakeTelegram.start();
  return new CommandHarness(fakeTelegram, await getStateStore(), apiRoot);
}

/**
 * @description A core whose members do nothing — for a test that exercises a module's pure decisions and never
 * reaches a port (its telegraf instance is real but never launched; the state is not available).
 */
export function createInertBotCore(): BotCore {
  return {
    bot: new Telegraf(fakeBotToken),
    command: () => {},
    getState: () => {
      throw new Error('this test did not set up a state store');
    },
    replyToThread: async () => null,
    editThreadMessage: async () => false,
    deleteThreadMessage: async () => {},
    authoriseContext: async () => null,
    withThreadLocale: (_key, run) => run(),
    checkIsGeneral: () => false,
    updatePinnedStatus: async () => {},
    cancelConversationRequest: () => {},
  };
}
