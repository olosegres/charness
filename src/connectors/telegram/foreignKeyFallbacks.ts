import { defaultLocale, type Locale } from '../../i18n';
import type { PlatformId, SessionKey } from '../../sessionKey';
import { getServedConversations } from '../../platform/connectorSet';
import { checkIsTelegramKey, getTelegramChatId } from './sessionKeyCodec';

/**
 * @description What the Telegram side of `bot.ts` does with a conversation of
 * ANOTHER platform (Jira connector plan J2, D19). Every adapter event runs inside
 * a locale lookup and may reach a Telegram send; both read the Telegram chat id,
 * which throws for a foreign key — so without these a Jira session would throw on
 * its first output. A foreign key gets the fallback locale, no group title, and
 * every Telegram I/O primitive returns early.
 */

/** The per-chat locale settings `state.json` holds for Telegram chats. */
export interface TelegramChatLocaleStore {
  getChatLocaleOverride(chatId: number): Locale | null;
  getChatTelegramLocale(chatId: number): Locale | null;
}

/**
 * @description The locale a conversation's bot texts are written in: the chat's
 * `/language` override, else the Telegram locale last seen there, else the
 * default — which is also what a conversation of another platform gets.
 */
export function getTelegramConversationLocale(key: SessionKey, store: TelegramChatLocaleStore | null): Locale {
  if (!store || !checkIsTelegramKey(key)) return defaultLocale;
  const chatId = getTelegramChatId(key);
  return store.getChatLocaleOverride(chatId) ?? store.getChatTelegramLocale(chatId) ?? defaultLocale;
}

/** Where the preamble's `group:` label comes from. */
export interface PreambleGroupTitleSources {
  getCachedGroupTitle(chatId: number): string | undefined;
  checkIsDmKey(key: SessionKey): boolean;
  getBotName(): string | undefined;
}

/**
 * @description The `group:` label of the thread-context preamble: the cached
 * supergroup title; for the owner's DM (a private chat has no title) the bot's
 * own name; nothing for a conversation of another platform.
 */
export function getTelegramPreambleGroupTitle(key: SessionKey, sources: PreambleGroupTitleSources): string | undefined {
  if (!checkIsTelegramKey(key)) return undefined;
  const cached = sources.getCachedGroupTitle(getTelegramChatId(key));
  if (cached) return cached;
  return sources.checkIsDmKey(key) ? sources.getBotName() : undefined;
}

/** The platform set {@link getTelegramConversations} keeps. */
const telegramPlatforms: ReadonlySet<PlatformId> = new Set<PlatformId>(['telegram']);

/**
 * @description Only the Telegram conversations of a list. The binding store is
 * shared by every platform (a Jira issue binds its project folder too), while a
 * Telegram listing or check over it reads each key's chat or topic id — which
 * throws for a foreign key.
 */
export function getTelegramConversations<T extends { key: SessionKey }>(entries: readonly T[]): T[] {
  return getServedConversations(entries, telegramPlatforms);
}

/** Distinct (primitive, conversation) pairs remembered before the memory starts over. */
const reportedPrimitiveSkipsMaxSize = 1000;

/**
 * @description A guard for the Telegram I/O primitives (send / edit / delete /
 * typing / pin / pinned banner): `true` for a Telegram key, `false` for any
 * other — the primitive then returns early. The skip is logged ONCE per
 * primitive and conversation, since output arrives in many chunks.
 */
export function createTelegramPrimitiveGuard(
  warn: (line: string) => void = console.warn,
): (key: SessionKey, primitive: string) => boolean {
  const reported = new Set<string>();
  return (key, primitive) => {
    if (checkIsTelegramKey(key)) return true;
    const reportKey = [primitive, key.platform, key.space, key.thread].join('|');
    if (!reported.has(reportKey)) {
      if (reported.size >= reportedPrimitiveSkipsMaxSize) reported.clear();
      reported.add(reportKey);
      warn(`[telegram] ${primitive} skipped: ${key.platform} conversation ${key.space}/${key.thread} is not a Telegram chat`);
    }
    return false;
  };
}
