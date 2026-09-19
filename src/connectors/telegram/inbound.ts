/**
 * @description The Telegram connector's inbound half — everything that turns a
 * raw Telegram update into the core's platform-neutral {@link InboundEvent},
 * plus the membership vocabulary the access policy used to import from telegraf
 * directly.
 *
 * Nothing here decides policy. It translates: Telegram's nine `ChatMember`
 * statuses become one `hasElevatedRights` boolean, its six media fields become
 * five {@link AttachmentKind}s, and its `/name@bot args` syntax becomes an
 * {@link InboundCommand} the neutral router can dispatch.
 */

import type { ChatMember, Message, User } from 'telegraf/typings/core/types/typegram';
import type { SessionKey } from '../../sessionKey';
import { splitCommandArgs } from '../../platform/commandRouter';
import type {
  AttachmentKind,
  ConnectorInbound,
  InboundAuthor,
  InboundCommand,
  InboundEvent,
  InboundEventHandler,
  InboundReplyTo,
  NormalizedAttachment,
  PlatformMember,
} from '../../platform/inbound';
import { getElevatedMemberIds } from '../../accessControl';
import { getTelegramFileMeta, type TelegramFileKind } from './fileIntake';
import { extractReplyQuote, type ReplyQuoteSource } from '../../utils/replyQuote';

/**
 * @description The two Telegram membership statuses that grant elevated rights
 * in a group. The core never sees these literals — that is the point of the
 * mapping below.
 */
const elevatedTelegramStatuses: ReadonlyArray<ChatMember['status']> = ['creator', 'administrator'];

function checkHasElevatedRights(status: ChatMember['status']): boolean {
  return elevatedTelegramStatuses.includes(status);
}

/**
 * @description The two facts about THIS bot that inbound normalization needs:
 * the username, to tell `/cmd@thisbot` from a command aimed at another bot in
 * the same group, and the user id, to attribute a quoted reply to the assistant
 * rather than to a person.
 */
export interface TelegramBotIdentity {
  username?: string;
  userId?: number;
}

/** A Telegram user's best available human-readable name. */
function getDisplayName(user: User): string {
  const full = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return full || user.username || user.id.toString();
}

/**
 * @description Reduce a `getChatAdministrators` response to the core's neutral
 * member shape. Bots are kept but flagged, so the policy's "real person" rule
 * stays in the policy instead of being silently pre-applied here.
 */
export function getPlatformMembers(members: ChatMember[]): PlatformMember[] {
  return members.map((member) => ({
    id: member.user.id.toString(),
    displayName: getDisplayName(member.user),
    isBot: member.user.is_bot,
    hasElevatedRights: checkHasElevatedRights(member.status),
  }));
}

/**
 * @description Should a `chat_member` status transition invalidate the cached
 * admin set? Only transitions that TOUCH elevated status matter — someone was
 * or becomes creator/administrator (promotion, demotion, an admin leaving).
 * Joins/leaves of regular members can't change the admin set, so they must not
 * trigger a `getChatAdministrators` refetch.
 *
 * Lives in the connector because the decision is expressed entirely in
 * Telegram's status vocabulary.
 */
export function checkShouldInvalidateAdminCache(
  oldStatus: ChatMember['status'],
  newStatus: ChatMember['status'],
): boolean {
  return checkHasElevatedRights(oldStatus) || checkHasElevatedRights(newStatus);
}

/**
 * @description Telegram's six ingestible media kinds collapsed onto the core's
 * five. `video_note` (a round video) and `animation` (a GIF) are Telegram UI
 * distinctions with no bearing on how the core treats the bytes.
 */
const attachmentKindByTelegramKind: Record<TelegramFileKind, AttachmentKind> = {
  photo: 'photo',
  document: 'document',
  video: 'video',
  video_note: 'video',
  animation: 'video',
  audio: 'audio',
};

/**
 * @description Normalize a message's media into the core's attachment shape.
 *
 * Voice is handled separately from {@link getTelegramFileMeta} because the bot
 * routes it to transcription rather than file intake — but the core still needs
 * to see that the message CARRIED something, so it is normalized here.
 */
export function getNormalizedAttachments(message: Message): NormalizedAttachment[] {
  if ('voice' in message && message.voice) {
    return [
      {
        kind: 'voice',
        handle: message.voice.file_id,
        uniqueId: message.voice.file_unique_id,
        fileName: null,
        sizeBytes: message.voice.file_size ?? null,
        caption: 'caption' in message ? (message.caption ?? null) : null,
      },
    ];
  }
  const meta = getTelegramFileMeta(message);
  if (!meta) return [];
  return [
    {
      kind: attachmentKindByTelegramKind[meta.kind],
      handle: meta.fileId,
      uniqueId: meta.fileUniqueId,
      fileName: meta.fileName ?? null,
      sizeBytes: meta.fileSize ?? null,
      caption: meta.caption ?? null,
    },
  ];
}

/**
 * @description Recognise Telegram's command syntax in a text message.
 *
 * Deliberately mirrors telegraf's own `Composer.command` matching rule so
 * routing commands through the neutral router cannot change which messages
 * count as commands:
 *
 *   - the message's FIRST entity must be a `bot_command` at offset 0;
 *   - `/name@someone` only counts when `someone` is this bot (case-insensitive),
 *     so a command addressed to another bot in the same group falls through;
 *   - everything after the command token is the argument remainder.
 *
 * Returns `null` when the message is not a command — the caller then treats it
 * as plain text.
 */
export function getTelegramCommand(
  message: Message.TextMessage,
  identity: TelegramBotIdentity,
): InboundCommand | null {
  const commandEntity = message.entities?.[0];
  if (commandEntity?.type !== 'bot_command' || commandEntity.offset > 0) return null;
  const [commandPart, addressee] = message.text.slice(0, commandEntity.length).split('@');
  if (!commandPart) return null;
  if (addressee && addressee.toLowerCase() !== identity.username?.toLowerCase()) return null;
  const name = commandPart.slice(1);
  if (!name) return null;
  return { name, ...splitCommandArgs(message.text.slice(commandEntity.length)) };
}

function getInboundAuthor(user: User | undefined): InboundAuthor {
  if (!user) return { id: '', displayName: '' };
  return { id: user.id.toString(), displayName: getDisplayName(user) };
}

/**
 * @description The replied-to message reduced to what the core renders into the
 * agent prompt.
 *
 * The candidate order and the exclusions (service message, forum topic-root
 * "post in this topic" reply, nothing quotable) are NOT restated here — they are
 * {@link extractReplyQuote}, the same pure helper the reply-quote prompt block
 * already uses. A second, subtly weaker copy is exactly how the highlighted
 * partial quote (`message.quote`) would silently stop winning.
 */
function getInboundReplyTo(
  message: Message,
  identity: TelegramBotIdentity,
): InboundReplyTo | undefined {
  const replied = 'reply_to_message' in message ? message.reply_to_message : undefined;
  if (!replied) return undefined;

  const isFromAssistant = identity.userId !== undefined && replied.from?.id === identity.userId;
  const source: ReplyQuoteSource = {
    manualQuoteText: 'quote' in message ? message.quote?.text : undefined,
    replyText: 'text' in replied ? replied.text : undefined,
    replyCaption: 'caption' in replied ? replied.caption : undefined,
    replyMessageId: replied.message_id,
    topicRootId: 'message_thread_id' in message ? message.message_thread_id : undefined,
    isServiceMessage: 'forum_topic_created' in replied,
    fromBot: isFromAssistant,
  };
  const quote = extractReplyQuote(source);
  if (!quote) return undefined;
  return {
    text: quote.quotedText,
    author: 'from' in replied ? getInboundAuthor(replied.from) : null,
    isFromAssistant: quote.fromBot,
  };
}

/**
 * @description Turn one Telegram message into the core's {@link InboundEvent}.
 *
 * `key` is passed in rather than derived here because resolving it needs the
 * surface configuration (owner id, served group, chat mode) that lives in the
 * bot's routing layer, not in this translation step.
 *
 * `raw` overrides what lands on the event's connector-private escape hatch. It
 * exists because the not-yet-relocated command handlers still read Telegram
 * fields off the telegraf CONTEXT rather than off the bare message; once they
 * move into this directory the override goes away and `raw` is the message.
 */
export function getInboundEvent(
  message: Message,
  key: SessionKey,
  identity: TelegramBotIdentity,
  raw: unknown = message,
): InboundEvent {
  const text = ('text' in message ? message.text : undefined) ?? '';
  const caption = ('caption' in message ? message.caption : undefined) ?? '';
  const command =
    'text' in message
      ? (getTelegramCommand(message as Message.TextMessage, identity) ?? undefined)
      : undefined;
  return {
    key,
    author: getInboundAuthor('from' in message ? message.from : undefined),
    text: text || caption,
    attachments: getNormalizedAttachments(message),
    replyTo: getInboundReplyTo(message, identity),
    command,
    raw,
  };
}

/**
 * @description What the Telegram connector needs from the bot to serve the
 * inbound side. Injected so this module never imports `bot.ts` (which would be
 * a cycle) and so the connector is testable without Telegraf.
 */
export interface TelegramInboundDeps {
  /** `bot.telegram.getChatAdministrators` for one chat id. */
  listAdministrators: (chatId: number) => Promise<ChatMember[]>;
  /**
   * `bot.botInfo` reduced to the two facts normalization needs. Read lazily:
   * `botInfo` is only populated once telegraf has called `getMe` at launch,
   * which happens after this connector is constructed.
   */
  getIdentity: () => TelegramBotIdentity;
}

/**
 * @description The Telegram connector's inbound side.
 *
 * {@link deliver} is the connector-facing entry: the telegraf handlers call it
 * with a raw message and the resolved key, it normalizes, and the core's
 * registered handler receives a platform-neutral {@link InboundEvent}.
 *
 * `start` / `stop` arm and disarm that delivery. They deliberately do NOT own
 * the long-polling transport yet: `bot.launch` still lives in the bot's startup
 * sequence alongside the rest of the telegraf wiring, and moves in behind this
 * interface when that wiring relocates into this directory.
 */
export interface TelegramConnectorInbound extends ConnectorInbound {
  /**
   * Normalize one Telegram message and hand it to the registered core handler.
   * `raw` overrides the event's escape hatch — see {@link getInboundEvent}.
   */
  deliver(message: Message, key: SessionKey, raw?: unknown): Promise<void>;
}

export function createTelegramConnectorInbound(
  deps: TelegramInboundDeps,
): TelegramConnectorInbound {
  let onEvent: InboundEventHandler | null = null;

  return {
    async start(handler: InboundEventHandler): Promise<void> {
      onEvent = handler;
    },

    async stop(): Promise<void> {
      onEvent = null;
    },

    async listMembersWithElevatedRights(space: string): Promise<string[]> {
      const chatId = Number(space);
      if (!Number.isFinite(chatId)) return [];
      const members = getPlatformMembers(await deps.listAdministrators(chatId));
      return getElevatedMemberIds(members);
    },

    async deliver(message: Message, key: SessionKey, raw?: unknown): Promise<void> {
      // Dropped rather than queued when inbound is not armed: an event that
      // arrives before `start` (or after `stop`) has no core to route to, and
      // buffering it would replay stale work at an arbitrary later moment.
      if (!onEvent) return;
      await onEvent(getInboundEvent(message, key, deps.getIdentity(), raw ?? message));
    },
  };
}
