/**
 * The ports every Telegram command module takes from `bot.ts`: the telegraf instance, the neutral command
 * registrar, the topic send helpers and the few cross-cutting calls a handler makes. A module asks for the
 * members it uses (`Pick<BotCore, …>`), and `bot.ts` builds the one object that satisfies them all.
 */
import type { Context, NarrowedContext, Telegraf } from 'telegraf';
import type { Message, Update } from 'telegraf/typings/core/types/typegram';
import type { InboundCommand } from '../../../platform/inbound';
import type { SessionKey } from '../../../sessionKey';
import type { StateStore } from '../../../state';

/** The Telegram context a command handler receives — a text message, always. */
export type CommandContext = NarrowedContext<Context, Update.MessageUpdate<Message.TextMessage>>;

/** Register a command handler on the neutral router. */
export type RegisterCommand = (
  name: string | string[],
  handler: (ctx: CommandContext, key: SessionKey, parsed: InboundCommand) => Promise<void> | void,
) => void;

export interface BotCore {
  bot: Telegraf;
  command: RegisterCommand;
  /**
   * The state store, assigned when the bot boots — after the handlers are registered. Read it through this
   * getter each time a handler RUNS; a copy taken at registration would be `undefined`.
   */
  getState: () => StateStore;
  /** Send into the topic (paced, tracked for `/clear_messages`); the sent message id, or `null` when the send failed. */
  replyToThread: (key: SessionKey, text: string, extra?: object, options?: { unpaced?: boolean }) => Promise<number | null>;
  /** Edit a message of the topic in place; `false` when the edit failed. */
  editThreadMessage: (key: SessionKey, messageId: number, text: string, extra?: object) => Promise<boolean>;
  deleteThreadMessage: (key: SessionKey, messageId: number) => Promise<void>;
  /** Gate a callback or message to an admin of the served group; the topic's key, or `null` when it is refused. */
  authoriseContext: (ctx: Context) => Promise<SessionKey | null>;
  /** Run `fn` with the topic's resolved locale for `t(…)`. */
  withThreadLocale: <TResult>(key: SessionKey, fn: () => TResult) => TResult;
  checkIsGeneral: (key: SessionKey) => boolean;
  /** Refresh (or create) the topic's pinned status banner. */
  updatePinnedStatus: (key: SessionKey) => Promise<void>;
  /** Close the topic's open request as cancelled (the conversation was cancelled or ended). */
  cancelConversationRequest: (key: SessionKey) => void;
  /**
   * Wake the topic's SLEEPING conversation (process stopped, session kept) before a command that needs a live
   * agent. The notice to post (a resume that failed and a fresh start), `''` for a silent resume, `null` when
   * nothing slept.
   */
  wakeSleepingSession: (key: SessionKey) => Promise<string | null>;
}
