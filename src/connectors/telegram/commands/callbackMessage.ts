/**
 * The message a callback button sits on.
 */
import type { Context } from 'telegraf';
import type { SessionKey } from '../../../sessionKey';

/**
 * @description Id of the message a callback button sits on, or `null` when
 * Telegram did not attach one (a very old message). Callbacks that resolve an
 * INDEX against a per-message snapshot need it to reject a stale keyboard
 * rather than resolve against another message's list.
 */
export function getCallbackMessageId(ctx: Context): number | null {
  return ctx.callbackQuery?.message?.message_id ?? null;
}

/**
 * @description The map key of a per-MESSAGE snapshot (the list a keyboard's indexes resolve against, the rung a
 * question waits to add). A Telegram message id is unique only within ONE chat, so the chat (`key.space`) is part of
 * the key: with several groups, or the DM and group transports side by side, two chats' messages never meet.
 */
export function buildMessageSnapshotKey(key: SessionKey, messageId: number): string {
  return `${key.platform}:${key.space}:${messageId}`;
}
