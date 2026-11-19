/**
 * @description The topic renames that waited for the bot while it was down for longer than a hot reload. A COLD start drops every update
 * that waited (`dropPendingUpdates` — a flood of replies to old messages is worse), and with them an owner's rename of a topic: the bot
 * would then write the old name plus a mark over it. So before the drop the waiting updates are READ once, only the `forum_topic_edited`
 * service messages are kept, and the bot applies them through the same path as a live rename; everything else is dropped as before.
 *
 * Telegram keeps an unconfirmed update for up to 24 hours and hands out at most 100 per `getUpdates`; reading with `timeout: 0` returns at
 * once and an `offset` past a page confirms it, which is fine — the launch drops what is left. Telegram REMEMBERS `allowed_updates` between
 * calls, so the read asks for the bot's FULL list (a partial one would unsubscribe the rest until the launch's first poll resets it, and
 * for good if the process died in between) and keeps only the renames in code.
 */
import type { Message, Update } from 'telegraf/typings/core/types/typegram';
import type { UpdateType } from 'telegraf/typings/telegram-types';

/** A `forum_topic_edited` service message that carries a new name (an icon-only edit has none). */
export type WaitingTopicRename = Message.ForumTopicEditedMessage & { forum_topic_edited: { name: string } };

/** The `getUpdates` call the reader needs: it only ever reads (`timeout: 0`) and asks for the bot's own list of update types. */
export interface WaitingUpdatesRequest {
  offset?: number;
  limit: number;
  timeout: 0;
  allowed_updates: readonly UpdateType[];
}

/** How many updates one read takes — the most the Bot API gives. */
export const waitingUpdatesPageSize = 100;
/** How many pages are read at most: 5000 updates is more than a group produces in a day of downtime, and a stuck loop must end. */
export const waitingUpdatesMaxPages = 50;

function checkIsNamedTopicEdit(message: Message.ForumTopicEditedMessage): message is WaitingTopicRename {
  return typeof message.forum_topic_edited.name === 'string' && message.forum_topic_edited.name !== '';
}

/** @description The rename of a topic in `update`, if it is one. */
export function getWaitingTopicRename(update: Update): WaitingTopicRename | null {
  if (!('message' in update) || !('forum_topic_edited' in update.message)) return null;
  return checkIsNamedTopicEdit(update.message) ? update.message : null;
}

/**
 * @description Read what waits for the bot and keep the topic renames, oldest first (the last rename of a topic wins when they are applied
 * in order). `allowedUpdates` is the bot's own subscription, handed back to Telegram unchanged. Resolves what was read so far when a call
 * fails — a rename that is missed is the old behaviour, not a failed boot — and reports the failure through `onError`.
 */
export async function readWaitingTopicRenames(
  getUpdates: (request: WaitingUpdatesRequest) => Promise<readonly Update[]>,
  onError: (error: unknown) => void,
  allowedUpdates: readonly UpdateType[],
): Promise<WaitingTopicRename[]> {
  const renames: WaitingTopicRename[] = [];
  let offset: number | undefined;
  for (let pageIndex = 0; pageIndex < waitingUpdatesMaxPages; pageIndex += 1) {
    let page: readonly Update[];
    try {
      page = await getUpdates({ ...(offset === undefined ? {} : { offset }), limit: waitingUpdatesPageSize, timeout: 0, allowed_updates: allowedUpdates });
    } catch (error) {
      onError(error);
      return renames;
    }
    for (const update of page) {
      const rename = getWaitingTopicRename(update);
      if (rename) renames.push(rename);
    }
    const lastUpdate = page.at(-1);
    if (lastUpdate === undefined || page.length < waitingUpdatesPageSize) return renames;
    offset = lastUpdate.update_id + 1;
  }
  return renames;
}
