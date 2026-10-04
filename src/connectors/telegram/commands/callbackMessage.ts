/**
 * The message a callback button sits on.
 */
import type { Context } from 'telegraf';

/**
 * @description Id of the message a callback button sits on, or `null` when
 * Telegram did not attach one (a very old message). Callbacks that resolve an
 * INDEX against a per-message snapshot need it to reject a stale keyboard
 * rather than resolve against another message's list.
 */
export function getCallbackMessageId(ctx: Context): number | null {
  return ctx.callbackQuery?.message?.message_id ?? null;
}
