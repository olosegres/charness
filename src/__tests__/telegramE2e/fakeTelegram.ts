/**
 * @description A fake Telegram Bot API on loopback for the process-level
 * Telegram tests (request/answer plan S6–S9): charness is pointed at it with
 * `TELEGRAM_API_ROOT` and runs its real telegraf client against it — long
 * polling, sends, edits, pins, callback answers — while the test plays the
 * operator: it pushes messages, voice notes and button taps as updates and reads
 * back what the bot posted, edited, pinned and unpinned in each topic. A voice
 * note's file is served the way Telegram serves it (`getFile`, then a download from
 * `/file/bot<token>/<path>`), so the whole voice path can run against a fake engine.
 * A long poll held by a stopped bot's dead connection takes no update, so a flow
 * can restart the bot and keep pushing.
 *
 * Only what the flow needs is modelled: ONE forum supergroup with the operator
 * as its creator (plus any further admins a flow names, who may write too) —
 * and, for a flow about which group the bot serves, further forum supergroups,
 * each with a creator and admins of its own —,
 * numbered topics, message ids in one sequence (operator and
 * bot messages alike, as on Telegram), the pin state of every message, and
 * every call in order. A method the fake does not model answers `true` and is
 * recorded, so a new call the bot starts making shows up in `calls` instead of
 * failing the flow for a reason unrelated to what it tests.
 *
 * Nothing leaves the machine: the server listens on 127.0.0.1 only.
 */

import * as http from 'http';
import type { AddressInfo, Socket } from 'net';
import type { InlineKeyboardButton } from 'telegraf/typings/core/types/typegram';

/**
 * The forum's General topic. Telegram delivers an operator's message there with thread id 1, and a bot send WITHOUT
 * `message_thread_id` (which is how the bot addresses General — an explicit 1 is refused) lands in it.
 */
export const generalTopicThreadId = 1;

/**
 * Where the fake's ONE message sequence (messages and the ids of topics it creates) starts: above every thread id a flow
 * hard-codes. A topic's id is the id of its root message, and the bot rightly ignores a reply to that root (a reply "in the
 * topic"), so a flow's message whose id happened to equal the hard-coded id of its topic lost its reply quote — which of the
 * messages that was depended on how many the bot had sent before, so a full run met it once in a while
 * (`fakeTelegramMessageIds.test.ts` keeps the two ranges apart).
 */
export const fakeTelegramFirstMessageId = 100_000;

/** The most characters the Bot API accepts in the notification of `answerCallbackQuery`. */
const callbackToastMaxLength = 200;

/** The Bot API's own shape of a successful answer. */
interface ApiOk { ok: true; result: unknown }
interface ApiError { ok: false; error_code: number; description: string }

/** What the Bot API answers to an `answerCallbackQuery` sent after the query's time ran out. */
const expiredCallbackQueryError: ApiError = {
  ok: false,
  error_code: 400,
  description: 'Bad Request: query is too old and response timeout expired or query ID is invalid',
};

/** The statuses the fake reports for the bot's own membership (`my_chat_member`). */
export type BotMembershipStatus = 'left' | 'kicked' | 'member' | 'administrator';

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: 'supergroup';
  title: string;
  is_forum: true;
}

/** A private chat of the bot with one person: its id is the person's user id, and it has no topics (a message in it carries no `message_thread_id`). */
interface FakePrivateChat {
  id: number;
  type: 'private';
  first_name: string;
}

/** A button of an inline keyboard: a tap (`callback_data`) or a link (`url`), as the Bot API types it. */
export type FakeTelegramInlineButton = InlineKeyboardButton;

/** A message as the fake stores it: the fields the flow reads back. */
export interface FakeTelegramMessage {
  message_id: number;
  date: number;
  chat: TelegramChat | FakePrivateChat;
  /** Absent in a private chat. */
  message_thread_id?: number;
  is_topic_message?: true;
  from: TelegramUser;
  text: string;
  entities?: Array<{ type: 'bot_command'; offset: number; length: number } | { type: 'text_mention'; offset: number; length: number; user: TelegramUser }>;
  /** A voice note: its message carries no `text` on the wire (the stored `text` is just ''). */
  voice?: FakeTelegramVoice;
  reply_markup?: { inline_keyboard: Array<Array<FakeTelegramInlineButton>> };
  /** The `disable_notification` the send carried (bot messages only). */
  isSilent?: boolean;
  /** The `parse_mode` the send carried (bot messages only): the stored `text` is the raw markup, the fake renders none of it. */
  parseMode?: string;
  isDeleted?: boolean;
  /**
   * When the fake stored the message (ms since the epoch, the test process's clock): the time of the event at its source, which a
   * test's own polling cannot give — a test that reads it later would measure its own delay.
   */
  createdAtMs: number;
  /** When the fake applied the deletion (same clock): set together with `isDeleted`. */
  deletedAtMs?: number;
}

/** A message embedded as another one's `reply_to_message`: a voice note has no `text` on the wire, a topic's creation message only its `forum_topic_created`. */
export type FakeRepliedMessage = Omit<FakeTelegramMessage, 'text'> & { text?: string; forum_topic_created?: { name: string; icon_color: number } };

/** The wire fields of an operator message that arrives as a reply and/or a forward. */
interface OperatorMessageContext {
  reply_to_message?: FakeRepliedMessage;
  forward_origin?: FakeForwardOrigin;
  sender_chat?: { id: number; type: 'channel' | 'supergroup'; title: string };
}

/** The origin of a forwarded message, in the four shapes the Bot API reports (`date` is the original send time, unix seconds). */
export type FakeForwardOrigin =
  | { type: 'user'; sender_user: TelegramUser; date: number }
  | { type: 'hidden_user'; sender_user_name: string; date: number }
  | { type: 'chat'; sender_chat: { id: number; type: 'supergroup'; title: string }; author_signature?: string; date: number }
  | { type: 'channel'; chat: { id: number; type: 'channel'; title: string }; message_id: number; author_signature?: string; date: number };

/** How the operator's message arrives besides its content: as a reply to a message already in the topic, and/or forwarded from elsewhere. */
export interface FakeOperatorMessageOptions {
  /** Who sends it: the operator by default; another person (an admin, a talker, a stranger) when set. */
  from?: TelegramUser;
  /** The album this message is one item of (`media_group_id`): files sent together share one. */
  mediaGroupId?: string;
  /** A person picked from the member list inside the text: Telegram sends a `text_mention` entity that carries the user. */
  textMention?: { user: TelegramUser; offset: number; length: number };
  /** The message is a post made AS a chat (a linked channel's, an anonymous admin's): `from` is then only a service user. */
  senderChat?: { id: number; type: 'channel' | 'supergroup'; title: string };
  /** The id of the message in the topic this one replies to (the bot's or a person's). */
  replyToMessageId?: number;
  /** Where the message was first written. */
  forwardOrigin?: FakeForwardOrigin;
}

/** The `voice` object of a voice-note message. */
export interface FakeTelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type: 'audio/ogg';
}

/** One Bot API call charness made, in order. */
export interface FakeTelegramCall {
  method: string;
  payload: Record<string, unknown>;
  /** When the call reached the fake (ms since the epoch, the test process's clock). */
  receivedAtMs: number;
}

/** One pin or unpin, in order. `isSilent` is the pin's `disable_notification`. */
export interface FakeTelegramPinEvent {
  kind: 'pin' | 'unpin';
  messageId: number;
  isSilent: boolean;
}

/** A group the fake knows: its chat, its creator and its further administrators. */
interface FakeGroupMembers {
  chat: TelegramChat;
  creator: TelegramUser;
  admins: TelegramUser[];
}

/** A forum supergroup besides the flow's own: who created it and who else administers it. */
export interface FakeTelegramOtherGroup {
  id: number;
  title: string;
  creator: TelegramUser;
  admins?: TelegramUser[];
}

export interface FakeTelegramOptions {
  botUser: TelegramUser;
  operator: TelegramUser;
  /** Further group administrators (the bot serves every admin); the operator is always one. */
  admins?: TelegramUser[];
  group: { id: number; title: string };
  /** Further forum supergroups the bot is a member of (a flow about which group it serves); the flow's own is `group`. */
  otherGroups?: FakeTelegramOtherGroup[];
  /**
   * How long (ms) the fake keeps an idle keep-alive connection before it closes it, as the real Bot API does after a while
   * (Node adds about a second to this). 0, the default, never closes one by itself — a flow that is not about closing
   * must not meet a connection closed under it (see {@link FakeTelegram.start}).
   */
  keepAliveTimeoutMs?: number;
}

/** How long a `getUpdates` long poll is held when nothing arrives, unless a flow sets another (telegraf asks for 50 s; shorter keeps the stop quick). */
const defaultLongPollHoldMs = 2_000;
/** The cap the Bot API enforces on `getUpdates` `limit`. */
const maxUpdatesPerPoll = 100;
/** The most characters a message text holds (the Bot API documents 1-4096): a longer one is refused, as it is for real. */
const telegramTextMaxLength = 4096;
/** The most ids one `deleteMessages` call takes (the Bot API documents 1-100). */
const maxDeleteMessagesPerCall = 100;
/** The icon colour every topic made in the fake group has (Telegram's first preset). */
const topicIconColor = 0x6FB9F0;

/** The private chat of the bot with `user`. */
function getPrivateChat(user: TelegramUser): FakePrivateChat {
  return { id: user.id, type: 'private', first_name: user.first_name };
}

/** A stored message as the Bot API embeds it in a reply: a voice note without `text`. */
function embedAsReplied(message: FakeTelegramMessage): FakeRepliedMessage {
  if (!message.voice) return message;
  const { text: _noText, ...voiceOnly } = message;
  return voiceOnly;
}

/** `/command args` → the `bot_command` entity Telegram attaches to a typed command. */
function getCommandEntities(text: string): FakeTelegramMessage['entities'] {
  const match = /^\/[A-Za-z0-9_]+(?:@[A-Za-z0-9_]+)?/.exec(text);
  return match ? [{ type: 'bot_command', offset: 0, length: match[0].length }] : undefined;
}

export class FakeTelegram {
  /** Every call in order, the token already stripped from the path. */
  readonly calls: FakeTelegramCall[] = [];
  /** Every pin and unpin in order. */
  readonly pinEvents: FakeTelegramPinEvent[] = [];
  /** Every `answerCallbackQuery` text, in order. */
  readonly callbackAnswers: string[] = [];
  /**
   * While set, every `answerCallbackQuery` is refused the way the Bot API refuses an answer that came too late (a tap whose
   * handler worked longer than Telegram keeps the query open): the tap's spinner never gets its toast.
   */
  isCallbackAnswerExpired = false;
  /**
   * While set, `deleteMessage` is refused the way the Bot API refuses a message it will not delete any more (older than
   * 48 hours): the message stays.
   */
  isMessageDeletionRefused = false;
  /** Whether the bot may create topics (`can_manage_topics`); while unset, `createForumTopic` is refused as the Bot API refuses it. */
  canManageTopics = true;
  /** Whether `getChatMember` answers for the bot as a group administrator with the rights it asks for; unset (the default): as a plain member. */
  isBotAdmin = false;
  /** Whether the bot's privacy mode is on, as `getMe` reports it (`can_read_all_group_messages` false). Off by default. */
  isBotPrivacyModeOn = false;
  /**
   * While set, a send to a person who has not opened a private chat with the bot ({@link openPrivateChat}, or by writing to it with
   * {@link pushPrivateMessage}) is refused the way the Bot API refuses it — 403 «bot can't initiate conversation with a user» —, and
   * a send to one who has lands in that private chat ({@link listPrivateBotMessages}). Unset (the default): a send to a user id that
   * is no registered private chat lands in the flow's group, which is where the owner's startup status has always gone in the flows
   * that never model a private chat.
   */
  isPrivateChatStartRequired = false;
  /**
   * While set, the topic the bot creates also reaches it as the `forum_topic_created` service message (`from` is the bot
   * itself): whether Telegram delivers a bot its own service messages is not documented, so a flow can make it so.
   */
  isOwnTopicEventDelivered = false;
  /** The topics the bot created, in order: the id of each (the id of its creation service message) and its name. */
  readonly createdTopics: Array<{ threadId: number; name: string }> = [];
  /**
   * While set, the bot's own `editForumTopic` also reaches it as the `forum_topic_edited` service message (`from` is the bot itself),
   * stored in the topic so the bot may delete it: the live Bot API does this (measured on the test topic, 2026-11-18).
   */
  isOwnTopicRenameDelivered = false;
  /**
   * Whether `deleteWebhook` with `drop_pending_updates` — what a COLD launch sends — empties the updates that wait, as Telegram does. Off by
   * default: a flow that pushes updates before its first boot (itself a cold one) expects to get them.
   */
  isPendingDroppedByLaunch = false;
  /**
   * Endings Telegram drops from a topic name — measured live on 2026-11-19: a trailing ✅ never shows. A rename asking for `<name> <ending>`
   * stores `<name>`; the call answers ok when that changes the title and TOPIC_NOT_MODIFIED when the title already reads so, and the
   * bot's own «renamed» line carries the stored name. Empty by default: a flow that wants a name kept must not meet this.
   */
  strippedTopicNameEndings: string[] = [];
  /** How long a `getUpdates` long poll is held when nothing arrives (telegraf asks for 50 s; the default is shorter to keep a stop quick). */
  longPollHoldMs = defaultLongPollHoldMs;
  /** The ids of the «renamed the topic» service lines the fake made of the bot's own renames, in order. */
  readonly ownRenameLineIds: number[] = [];
  /** What each topic is called NOW (by thread id): the name the flow gave it or the last rename. */
  private readonly topicNames = new Map<number, string>();
  /** The name each topic was CREATED with: what the root message a client attaches to a plain post in it carries, whatever it is called now. */
  private readonly topicCreationNames = new Map<number, string>();
  /** The responses {@link holdNextResponse} still has to hold, in the order they were asked for. */
  private readonly responseHolds: Array<{ method: string; release: Promise<unknown> | number; isMatch: (payload: Record<string, unknown>) => boolean }> = [];
  private readonly callFailures: Array<{ method: string; description: string; errorCode: number; isMatch: (payload: Record<string, unknown>) => boolean }> = [];
  /** The `file_path` of every file the bot downloaded from the file endpoint, in order. */
  readonly downloadedFilePaths: string[] = [];
  /** While {@link holdFileDownloads} holds them: the downloads asked for meanwhile, each served when the hold is released. */
  private heldFileDownloads: Array<() => void> | null = null;
  /** The methods of the requests {@link dropNextReusedConnectionRequest} still has to hang up on, in the order asked for. */
  private readonly pendingConnectionDrops: string[] = [];
  /** The method of every request the fake hung up on instead of processing, in order: none of them is in {@link calls}. */
  readonly droppedRequests: string[] = [];
  /** The connections that have served a request: a later request on one of them rides a REUSED (pooled) connection. */
  private readonly servedSockets = new WeakSet<Socket>();
  /** How many connections the fake has accepted: a client that found its pooled connection gone has opened another. */
  private acceptedConnections = 0;
  /** The files `getFile` knows, by file id. */
  private readonly files = new Map<string, { filePath: string; bytes: Buffer }>();
  private readonly messages = new Map<number, FakeTelegramMessage>();
  /** The people who opened a private chat with the bot, by user id: the bot may write to them. */
  private readonly privateChatUsers = new Map<number, TelegramUser>();
  private readonly pinnedMessageIds = new Set<number>();
  private readonly pendingUpdates: Array<Record<string, unknown>> = [];
  /** One waker per held long poll: a restarted bot leaves its dead predecessor's poll hanging for a moment. */
  private readonly pollWakers = new Set<() => void>();
  private nextMessageId = fakeTelegramFirstMessageId;
  private nextUpdateId = 1;
  private nextCallbackQueryId = 1;
  private server: http.Server | null = null;
  private readonly chat: TelegramChat;
  /** Every group by id — the flow's own and the others —, with its creator and further admins. */
  private readonly groups = new Map<number, FakeGroupMembers>();
  private readonly ownGroup: FakeGroupMembers;

  constructor(private readonly options: FakeTelegramOptions) {
    this.chat = { id: options.group.id, type: 'supergroup', title: options.group.title, is_forum: true };
    this.ownGroup = { chat: this.chat, creator: options.operator, admins: options.admins ?? [] };
    this.groups.set(this.chat.id, this.ownGroup);
    for (const other of options.otherGroups ?? []) {
      this.groups.set(other.id, { chat: { id: other.id, type: 'supergroup', title: other.title, is_forum: true }, creator: other.creator, admins: other.admins ?? [] });
    }
  }

  /** The group a request names (`chat_id`), the flow's own when it names none or one the fake does not know (the owner's DM, say). */
  private getGroup(payload: Record<string, unknown>): FakeGroupMembers {
    return this.groups.get(Number(payload.chat_id)) ?? this.ownGroup;
  }

  /** The groups the fake answers for no more ({@link deleteGroup}). */
  private readonly deletedGroupIds = new Set<number>();

  /** @description Group `groupId` is gone (deleted, or the bot was removed from it): reads of it fail as the Bot API's do. */
  deleteGroup(groupId: number): void {
    this.deletedGroupIds.add(groupId);
  }

  /** @description How many connections the fake has accepted so far. */
  get acceptedConnectionCount(): number {
    return this.acceptedConnections;
  }

  /** @description Listen on a free loopback port; resolves the API root to put in `TELEGRAM_API_ROOT`. */
  async start(): Promise<string> {
    const server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
    // Node's server closes a connection that sat idle for ~6 s (`keepAliveTimeout` plus its buffer). A client that was
    // starved of CPU past that between two requests (a loaded host: a boot, a stop and a restart in a row) writes its
    // next request onto a pooled connection the server has already closed: «socket hang up». The fake closes none by
    // itself unless a test asks (`keepAliveTimeoutMs`), so that a flow that is about something else never meets such a
    // connection; `stop()` closes them all. The bot's retry of exactly this failure is proven with the option set
    // (`botApiConnectionStall.test.ts`) and with `dropNextReusedConnectionRequest` (`staleConnectionRetryE2e.test.ts`).
    server.keepAliveTimeout = this.options.keepAliveTimeoutMs ?? 0;
    server.on('connection', () => {
      this.acceptedConnections += 1;
    });
    this.server = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.wakeAllPolls();
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // ─── what the operator does ───────────────────────────────────────

  /** @description The operator writes `text` in topic `threadId` (as a reply or a forward, when `options` say so); resolves the message id. */
  pushOperatorMessage(threadId: number, text: string, options: FakeOperatorMessageOptions = {}): number {
    return this.pushUserMessage(threadId, text, options.from ?? this.options.operator, options);
  }

  /** @description `from` writes `text` in topic `threadId` (another admin, say); resolves the message id. */
  pushUserMessage(threadId: number, text: string, from: TelegramUser, options: FakeOperatorMessageOptions = {}): number {
    const commandEntities = getCommandEntities(text) ?? [];
    const mentionEntities = options.textMention ? [{ type: 'text_mention' as const, offset: options.textMention.offset, length: options.textMention.length, user: options.textMention.user }] : [];
    const entities = [...commandEntities, ...mentionEntities];
    const message = this.storeMessage(threadId, text, from, { ...(entities.length > 0 ? { entities } : {}) });
    this.pushUpdate({ message: { ...message, ...this.getContext(options, threadId) } });
    return message.message_id;
  }

  /** @description `user` opened a private chat with the bot (pressed Start): the bot may write to them, and what it sends them lands in {@link listPrivateBotMessages}. */
  openPrivateChat(user: TelegramUser): void {
    this.privateChatUsers.set(user.id, user);
  }

  /**
   * @description `from` writes `text` to the bot in their private chat (a command, say) — which opens the chat, as writing to a bot does;
   * resolves the message id. The message carries no topic.
   */
  pushPrivateMessage(from: TelegramUser, text: string): number {
    this.openPrivateChat(from);
    const commandEntities = getCommandEntities(text);
    const message = this.storeMessage(null, text, from, { ...(commandEntities ? { entities: commandEntities } : {}) }, getPrivateChat(from));
    this.pushUpdate({ message });
    return message.message_id;
  }

  /** @description `from` writes `text` in topic `threadId` of the group `groupId` (one of `otherGroups`, or the flow's own); resolves the message id. */
  pushGroupMessage(groupId: number, threadId: number, text: string, from: TelegramUser): number {
    const group = this.groups.get(groupId);
    if (!group) throw new Error(`no group ${groupId} in this fake`);
    const message = this.storeMessage(threadId, text, from, { entities: getCommandEntities(text) }, group.chat);
    this.pushUpdate({ message });
    return message.message_id;
  }

  /**
   * @description `from` (the operator by default) makes a topic named `name` by hand: the bot gets its `forum_topic_created`
   * service message, the way a person creating a topic in the group app does. Resolves the topic's id.
   */
  pushTopicCreated(name: string, from: TelegramUser = this.options.operator): number {
    const threadId = this.nextMessageId++;
    this.topicNames.set(threadId, name);
    this.topicCreationNames.set(threadId, name);
    this.pushTopicCreatedEvent(threadId, name, from);
    return threadId;
  }

  /**
   * @description Name the topic the flow uses for a thread the bot never saw created (the operator's own topic, bound with `/bind`): its
   * CURRENT name and the name its root message carries, which a client attaches to the operator's plain posts in it.
   */
  setTopicCreationName(threadId: number, name: string): void {
    this.topicNames.set(threadId, name);
    this.topicCreationNames.set(threadId, name);
  }

  /** @description What the topic is called now — the last name the bot or the operator gave it; `undefined` for a topic the fake knows no name of. */
  getTopicName(threadId: number): string | undefined {
    return this.topicNames.get(threadId);
  }

  /**
   * @description The operator (or `from`) renames topic `threadId` to `name`: the topic is called so from now on and the bot gets the
   * `forum_topic_edited` service message, the way the group app does. Resolves the service message's id.
   */
  pushTopicRenamed(threadId: number, name: string, from: TelegramUser = this.options.operator): number {
    this.topicNames.set(threadId, name);
    return this.pushTopicEditedEvent(threadId, name, from);
  }

  /** @description Make a file downloadable: `getFile` answers its path, the file endpoint serves `bytes`. */
  registerFile(fileId: string, bytes: Buffer): void {
    this.files.set(fileId, { filePath: `voice/${fileId}.oga`, bytes });
  }

  /**
   * @description The operator sends a voice note (a file registered with {@link registerFile}) in topic `threadId` — as a reply
   * or a forward, when `options` say so; resolves the message id.
   */
  pushOperatorVoice(threadId: number, fileId: string, durationSeconds: number, options: FakeOperatorMessageOptions = {}): number {
    if (!this.files.has(fileId)) throw new Error(`register the voice file ${fileId} first`);
    const voice: FakeTelegramVoice = { file_id: fileId, file_unique_id: `unique-${fileId}`, duration: durationSeconds, mime_type: 'audio/ogg' };
    const message = this.storeMessage(threadId, '', options.from ?? this.options.operator, { voice });
    // On the wire a voice note has no `text` at all; an empty one would still match the bot's text handler.
    const { text: _text, ...wireMessage } = message;
    this.pushUpdate({ message: { ...wireMessage, ...this.getContext(options, threadId) } });
    return message.message_id;
  }

  /**
   * @description The operator sends a document or a photo (a file registered with {@link registerFile}) in topic `threadId`,
   * with a caption, as a reply or a forward when `options` say so; resolves the message id. The message is stored without the
   * file object (a reply to it embeds none); on the wire it carries the field the Bot API gives that kind.
   */
  pushOperatorFile(threadId: number, kind: 'document' | 'photo', fileId: string, options: FakeOperatorMessageOptions & { caption?: string; fileName?: string } = {}): number {
    const file = this.files.get(fileId);
    if (!file) throw new Error(`register the file ${fileId} first`);
    const message = this.storeMessage(threadId, '', options.from ?? this.options.operator);
    // On the wire a file message has no `text`, only its file and its caption.
    const { text: _text, ...wireMessage } = message;
    const fileFields = kind === 'document'
      ? { document: { file_id: fileId, file_unique_id: `unique-${fileId}`, file_name: options.fileName ?? `${fileId}.bin`, mime_type: 'application/octet-stream', file_size: file.bytes.length } }
      : { photo: [{ file_id: fileId, file_unique_id: `unique-${fileId}`, width: 90, height: 60, file_size: file.bytes.length }] };
    this.pushUpdate({ message: { ...wireMessage, ...fileFields, ...(options.caption ? { caption: options.caption } : {}), ...(options.mediaGroupId ? { media_group_id: options.mediaGroupId } : {}), ...this.getContext(options, threadId) } });
    return message.message_id;
  }

  /**
   * @description Hold every file download from now on: the bot's request to the file endpoint gets no answer until the returned
   * release runs, which serves the held ones at once. A flow makes the download the long await between a file's arrival and its
   * prompt (`getHeldFileDownloadCount` says the bot is in it).
   */
  holdFileDownloads(): () => void {
    const held: Array<() => void> = [];
    this.heldFileDownloads = held;
    return () => {
      if (this.heldFileDownloads === held) this.heldFileDownloads = null;
      for (const serve of held.splice(0)) serve();
    };
  }

  /** @description How many file downloads wait for the release of {@link holdFileDownloads}. */
  getHeldFileDownloadCount(): number {
    return this.heldFileDownloads?.length ?? 0;
  }

  /** @description `from` (the operator by default) taps the button carrying `callbackData` on the bot's message `messageId`. */
  pushCallback(messageId: number, callbackData: string, from: TelegramUser = this.options.operator): void {
    const message = this.messages.get(messageId);
    if (!message) throw new Error(`no message ${messageId} to tap a button on`);
    this.pushUpdate({
      callback_query: {
        id: (this.nextCallbackQueryId++).toString(),
        from,
        message,
        chat_instance: 'fake-chat-instance',
        data: callbackData,
      },
    });
  }

  /**
   * @description The service message the group posts when `user` joined or left: no text, `from` is that person, and (as in a
   * forum group) it carries no topic id — it lands in General. Nobody WROTE anything: a bot must not take it for a message. Resolves its id.
   */
  pushMembershipServiceMessage(user: TelegramUser, kind: 'joined' | 'left'): number {
    const messageId = this.nextMessageId++;
    this.pushUpdate({
      message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: this.chat,
        from: user,
        ...(kind === 'joined' ? { new_chat_members: [user] } : { left_chat_member: user }),
      },
    });
    return messageId;
  }

  /**
   * @description A membership change of `user` in the group, as the Bot API reports it to a bot that asked for `chat_member`
   * updates: a member who `left`, was `kicked`, or joined (`member`).
   */
  pushChatMember(user: TelegramUser, oldStatus: 'member' | 'left' | 'kicked', newStatus: 'member' | 'left' | 'kicked'): void {
    const asMember = (status: 'member' | 'left' | 'kicked') => ({ status, user, ...(status === 'kicked' ? { until_date: 0 } : {}) });
    this.pushUpdate({
      chat_member: {
        chat: this.chat,
        from: this.options.operator,
        date: Math.floor(Date.now() / 1000),
        old_chat_member: asMember(oldStatus),
        new_chat_member: asMember(newStatus),
      },
    });
  }

  /**
   * @description The bot's OWN membership in the group changed, as the Bot API reports it to a bot that asked for `my_chat_member`
   * updates: `user` is the bot itself (the default — «the bot was added» is `left` → `member` or `administrator`); another user
   * is an update that is not about the bot.
   */
  pushMyChatMember(oldStatus: BotMembershipStatus, newStatus: BotMembershipStatus, user: TelegramUser = this.options.botUser): void {
    const asMember = (status: BotMembershipStatus) => ({
      status,
      user,
      // The rights an administrator carries on the wire; the bot reads the status only.
      ...(status === 'administrator' ? { can_be_edited: false, is_anonymous: false, can_manage_chat: true, can_delete_messages: true, can_manage_topics: true, can_pin_messages: true } : {}),
      ...(status === 'kicked' ? { until_date: 0 } : {}),
    });
    this.pushUpdate({
      my_chat_member: {
        chat: this.chat,
        from: this.options.operator,
        date: Math.floor(Date.now() / 1000),
        old_chat_member: asMember(oldStatus),
        new_chat_member: asMember(newStatus),
      },
    });
  }

  // ─── what the test reads back ─────────────────────────────────────

  /** @description The bot's messages in topic `threadId` (of the group `groupId`, the flow's own by default) that are not deleted, oldest first, with their CURRENT text. */
  listBotMessages(threadId: number, groupId: number = this.chat.id): FakeTelegramMessage[] {
    return [...this.messages.values()]
      .filter((message) => message.chat.id === groupId && message.message_thread_id === threadId && message.from.id === this.options.botUser.id && !message.isDeleted && !this.ownRenameLineIds.includes(message.message_id))
      .sort((a, b) => a.message_id - b.message_id);
  }

  /** @description The bot's messages in its private chat with user `userId` that are not deleted, oldest first, with their CURRENT text. */
  listPrivateBotMessages(userId: number): FakeTelegramMessage[] {
    return [...this.messages.values()]
      .filter((message) => message.chat.type === 'private' && message.chat.id === userId && message.from.id === this.options.botUser.id && !message.isDeleted)
      .sort((a, b) => a.message_id - b.message_id);
  }

  /** @description Every message the fake stores — the operator's, the bot's, deleted ones too — oldest first, with its CURRENT text (read-only: the walkthrough recorder's view of the chat). */
  listAllMessages(): FakeTelegramMessage[] {
    return [...this.messages.values()].sort((a, b) => a.message_id - b.message_id);
  }

  getMessage(messageId: number): FakeTelegramMessage | undefined {
    return this.messages.get(messageId);
  }

  /** @description The ids currently pinned, oldest pin first. */
  listPinnedMessageIds(): number[] {
    return [...this.pinnedMessageIds];
  }

  /**
   * @description A bot message that is ALREADY pinned, as one an earlier version of the bot left behind: stored in the topic and
   * pinned without a pin event (the pin predates the test). Resolves its id.
   */
  seedPinnedBotMessage(threadId: number, text: string): number {
    const message = this.storeMessage(threadId, text, this.options.botUser);
    this.pinnedMessageIds.add(message.message_id);
    return message.message_id;
  }

  /** @description The calls of one method, in order. */
  listCalls(method: string): FakeTelegramCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  // ─── the Bot API ──────────────────────────────────────────────────

  private pushUpdate(body: Record<string, unknown>): void {
    this.pendingUpdates.push({ update_id: this.nextUpdateId++, ...body });
    this.wakeAllPolls();
  }

  private wakeAllPolls(): void {
    for (const wake of [...this.pollWakers]) wake();
  }

  /**
   * The reply, forward and sender-chat fields of a message the operator sends into topic `threadId`. A message that replies to
   * nothing in particular still carries the topic's ROOT message as its `reply_to_message` — what a real client sends for a plain
   * message typed in a topic («post in this topic») — so a bot that mistakes it for a genuine reply shows in every flow. General has
   * no creation message, so a plain message there carries no `reply_to_message` at all.
   */
  private getContext(options: FakeOperatorMessageOptions, threadId: number): OperatorMessageContext {
    const replied = options.replyToMessageId === undefined ? undefined : this.messages.get(options.replyToMessageId);
    if (options.replyToMessageId !== undefined && !replied) throw new Error(`no message ${options.replyToMessageId} to reply to`);
    const repliedMessage = replied ? embedAsReplied(replied) : threadId === generalTopicThreadId ? undefined : this.getTopicRootMessage(threadId);
    return {
      ...(repliedMessage ? { reply_to_message: repliedMessage } : {}),
      ...(options.forwardOrigin ? { forward_origin: options.forwardOrigin } : {}),
      ...(options.senderChat ? { sender_chat: options.senderChat } : {}),
    };
  }

  /** The creation service message of topic `threadId` (its id IS the topic's id), as the Bot API embeds it in a reply. */
  private getTopicRootMessage(threadId: number): FakeRepliedMessage {
    const created = this.createdTopics.find((topic) => topic.threadId === threadId);
    return {
      message_id: threadId,
      message_thread_id: threadId,
      is_topic_message: true,
      createdAtMs: 0,
      date: 0,
      chat: this.chat,
      from: this.options.botUser,
      forum_topic_created: { name: this.topicCreationNames.get(threadId) ?? created?.name ?? `Topic ${threadId}`, icon_color: topicIconColor },
    };
  }

  /** `threadId` is `null` for a message of a private chat, which has no topics. */
  private storeMessage(
    threadId: number | null,
    text: string,
    from: TelegramUser,
    extra: Pick<FakeTelegramMessage, 'entities' | 'reply_markup' | 'isSilent' | 'parseMode' | 'voice'> = {},
    chat: TelegramChat | FakePrivateChat = this.chat,
  ): FakeTelegramMessage {
    const message: FakeTelegramMessage = {
      message_id: this.nextMessageId++,
      createdAtMs: Date.now(),
      date: Math.floor(Date.now() / 1000),
      chat,
      ...(threadId === null ? {} : { message_thread_id: threadId, is_topic_message: true as const }),
      from,
      text,
      ...(extra.entities ? { entities: extra.entities } : {}),
      ...(extra.voice ? { voice: extra.voice } : {}),
      ...(extra.reply_markup ? { reply_markup: extra.reply_markup } : {}),
      ...(extra.isSilent !== undefined ? { isSilent: extra.isSilent } : {}),
      ...(extra.parseMode !== undefined ? { parseMode: extra.parseMode } : {}),
    };
    this.messages.set(message.message_id, message);
    return message;
  }

  /** A topic's id is the id of its creation service message, so it comes from the one message sequence. */
  private createTopic(requestedName: string): { message_thread_id: number; name: string; icon_color: number } {
    const name = this.getStoredTopicName(requestedName);
    const threadId = this.nextMessageId++;
    this.createdTopics.push({ threadId, name });
    this.topicNames.set(threadId, name);
    this.topicCreationNames.set(threadId, name);
    if (this.isOwnTopicEventDelivered) this.pushTopicCreatedEvent(threadId, name, this.options.botUser);
    return { message_thread_id: threadId, name, icon_color: topicIconColor };
  }

  /** The `forum_topic_edited` service message of topic `threadId`, as `from` made it; stored in the topic like any message, so it can be deleted. Resolves its id. */
  private pushTopicEditedEvent(threadId: number, name: string, from: TelegramUser): number {
    const line = this.storeMessage(threadId, '', from);
    this.pushUpdate({
      message: {
        message_id: line.message_id,
        date: line.date,
        chat: this.chat,
        message_thread_id: threadId,
        is_topic_message: true,
        from,
        forum_topic_edited: { name },
      },
    });
    return line.message_id;
  }

  /** The `forum_topic_created` service message of topic `threadId`, as `from` made it. */
  private pushTopicCreatedEvent(threadId: number, name: string, from: TelegramUser): void {
    this.pushUpdate({
      message: {
        message_id: threadId,
        date: Math.floor(Date.now() / 1000),
        chat: this.chat,
        message_thread_id: threadId,
        is_topic_message: true,
        from,
        forum_topic_created: { name, icon_color: topicIconColor },
      },
    });
  }

  /** The message a request names, or the Bot API's own "message not found" error. */
  private getMessageOrError(payload: Record<string, unknown>): FakeTelegramMessage | ApiError {
    const messageId = Number(payload.message_id);
    const message = this.messages.get(messageId);
    return message && !message.isDeleted ? message : { ok: false, error_code: 400, description: 'Bad Request: message to edit not found' };
  }

  private async readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw) return {};
    const contentType = request.headers['content-type'] ?? '';
    if (!contentType.includes('application/json')) {
      throw new Error(`the fake Telegram API reads JSON bodies only; got content-type "${contentType}"`);
    }
    return JSON.parse(raw);
  }

  /** `GET /file/bot<token>/<file_path>`: the bytes of a registered file. */
  private serveFile(request: http.IncomingMessage, response: http.ServerResponse): boolean {
    const fileMatch = /^\/file\/bot[^/]+\/(.+)$/.exec(request.url ?? '');
    if (!fileMatch) return false;
    const file = [...this.files.values()].find((candidate) => candidate.filePath === fileMatch[1]);
    if (!file) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error_code: 404, description: 'Not Found' }));
      return true;
    }
    const serve = (): void => {
      this.downloadedFilePaths.push(file.filePath);
      response.writeHead(200, { 'content-type': 'audio/ogg', 'content-length': file.bytes.length });
      response.end(file.bytes);
    };
    if (this.heldFileDownloads) this.heldFileDownloads.push(serve);
    else serve();
    return true;
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const isReusedConnection = this.servedSockets.has(request.socket);
    this.servedSockets.add(request.socket);
    if (this.serveFile(request, response)) return;
    const match = /^\/bot[^/]+\/([A-Za-z]+)$/.exec(request.url ?? '');
    if (!match) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error_code: 404, description: 'Not Found' }));
      return;
    }
    const method = match[1];
    const dropIndex = isReusedConnection ? this.pendingConnectionDrops.indexOf(method) : -1;
    if (dropIndex >= 0) {
      this.pendingConnectionDrops.splice(dropIndex, 1);
      this.droppedRequests.push(method);
      request.socket.destroy();
      return;
    }
    let payload: Record<string, unknown>;
    try {
      payload = await this.readJsonBody(request);
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error_code: 400, description: error instanceof Error ? error.message : String(error) }));
      return;
    }
    this.calls.push({ method, payload, receivedAtMs: Date.now() });
    const failureIndex = this.callFailures.findIndex((failure) => failure.method === method && failure.isMatch(payload));
    if (failureIndex >= 0) {
      const [failure] = this.callFailures.splice(failureIndex, 1);
      response.writeHead(failure.errorCode, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error_code: failure.errorCode, description: failure.description }));
      return;
    }
    const answer = await this.dispatch(method, payload, request.socket);
    const holdIndex = this.responseHolds.findIndex((hold) => hold.method === method && hold.isMatch(payload));
    if (holdIndex >= 0) {
      const [{ release }] = this.responseHolds.splice(holdIndex, 1);
      await (typeof release === 'number' ? new Promise<void>((resolve) => setTimeout(resolve, release)) : release);
    }
    response.writeHead(answer.ok ? 200 : answer.error_code, { 'content-type': 'application/json' });
    response.end(JSON.stringify(answer));
  }

  /**
   * @description Hang up on the NEXT `method` request that arrives on a REUSED connection (one that already served a request),
   * without processing it: the Bot API closed that connection a moment before the request landed on it. The client sees a
   * connection dropped before any answer; nothing was applied, so the request is in {@link droppedRequests}, not in
   * {@link calls}. A request on a fresh connection is processed and leaves the registration armed. One request per registration.
   */
  dropNextReusedConnectionRequest(method: string): void {
    this.pendingConnectionDrops.push(method);
  }

  /**
   * @description Hold the response to the NEXT `method` call whose payload `isMatch` until `release` settles — or, given a
   * number, for that many ms counted from the moment the call reached the fake (no observer in between, so the hold is as
   * long as asked however loaded the test process is): the call is handled at once (a sent message is in the topic, a toast
   * recorded), only the bot's await of it lasts that long — a slow Bot API round trip, which a test ends at a state it
   * observed, to put the bot's next step at a chosen moment.
   */
  holdNextResponse(method: string, release: Promise<unknown> | number, isMatch: (payload: Record<string, unknown>) => boolean = () => true): void {
    this.responseHolds.push({ method, release, isMatch });
  }

  /**
   * @description Refuse the NEXT `method` call whose payload `isMatch` with a 400 carrying `description` — the Bot API's
   * wording for it (`Bad Request: message is too long`, `Bad Request: can't parse entities: …`) —, applying nothing: the call
   * is recorded, the message stays as it was. `errorCode` is the answer's status (400 by default; a 5xx or a 429 is a failure a
   * later try can fix, a 400 one it cannot). One call per registration.
   */
  failNextCall(method: string, description: string, isMatch: (payload: Record<string, unknown>) => boolean = () => true, errorCode = 400): void {
    this.callFailures.push({ method, description, errorCode, isMatch });
  }

  private async dispatch(method: string, payload: Record<string, unknown>, socket: Socket): Promise<ApiOk | ApiError> {
    if (this.deletedGroupIds.has(Number(payload.chat_id))) return { ok: false, error_code: 400, description: 'Bad Request: chat not found' };
    switch (method) {
      case 'getMe':
        return { ok: true, result: { ...this.options.botUser, can_join_groups: true, can_read_all_group_messages: !this.isBotPrivacyModeOn, supports_inline_queries: false } };
      case 'getUpdates':
        return { ok: true, result: await this.getUpdates(payload, socket) };
      case 'deleteWebhook':
        if (this.isPendingDroppedByLaunch && payload.drop_pending_updates === true) this.pendingUpdates.length = 0;
        return { ok: true, result: true };
      case 'getChatAdministrators': {
        const group = this.getGroup(payload);
        return {
          ok: true,
          result: [
            { status: 'creator', user: group.creator, is_anonymous: false },
            ...group.admins.map((admin) => ({ status: 'administrator', user: admin, is_anonymous: false })),
          ],
        };
      }
      case 'getChatMember': {
        const group = this.getGroup(payload);
        const userId = Number(payload.user_id);
        const admin = group.admins.find((candidate) => candidate.id === userId);
        if (this.isBotAdmin && userId === this.options.botUser.id) {
          return { ok: true, result: { status: 'administrator', user: this.options.botUser, is_anonymous: false, can_manage_topics: true, can_delete_messages: true, can_pin_messages: true } };
        }
        if (group.creator.id === userId) return { ok: true, result: { status: 'creator', user: group.creator, is_anonymous: false } };
        if (admin) return { ok: true, result: { status: 'administrator', user: admin, is_anonymous: false } };
        return { ok: true, result: { status: 'member', user: { id: userId, is_bot: false, first_name: 'Member' } } };
      }
      case 'getChat':
        return { ok: true, result: this.getGroup(payload).chat };
      case 'createForumTopic': {
        if (!this.canManageTopics) return { ok: false, error_code: 400, description: 'Bad Request: not enough rights to create a topic' };
        return { ok: true, result: this.createTopic(String(payload.name)) };
      }
      case 'editForumTopic': {
        // The icon is the owner's: a rename that carries one fails the call, so a bot that sends it fails its flow.
        if ('icon_custom_emoji_id' in payload) return { ok: false, error_code: 400, description: 'Bad Request: the topic icon must not be sent (the fake refuses it)' };
        if (!this.canManageTopics) return { ok: false, error_code: 400, description: 'Bad Request: not enough rights to manage topics' };
        const threadId = Number(payload.message_thread_id);
        const name = this.getStoredTopicName(String(payload.name));
        if (this.topicNames.get(threadId) === name) return { ok: false, error_code: 400, description: 'Bad Request: TOPIC_NOT_MODIFIED' };
        this.topicNames.set(threadId, name);
        if (this.isOwnTopicRenameDelivered) this.ownRenameLineIds.push(this.pushTopicEditedEvent(threadId, name, this.options.botUser));
        return { ok: true, result: true };
      }
      case 'getFile': {
        const fileId = String(payload.file_id);
        const file = this.files.get(fileId);
        if (!file) return { ok: false, error_code: 400, description: 'Bad Request: invalid file_id' };
        return { ok: true, result: { file_id: fileId, file_unique_id: `unique-${fileId}`, file_size: file.bytes.length, file_path: file.filePath } };
      }
      case 'sendMessage': {
        if (String(payload.text).length > telegramTextMaxLength) return { ok: false, error_code: 400, description: 'Bad Request: message is too long' };
        const privateUser = this.privateChatUsers.get(Number(payload.chat_id));
        if (privateUser) {
          // A private chat has no topics: the Bot API refuses a send into one that names a topic.
          if (payload.message_thread_id !== undefined) return { ok: false, error_code: 400, description: 'Bad Request: message thread not found' };
          return { ok: true, result: this.storeMessage(null, String(payload.text), this.options.botUser, {
            reply_markup: payload.reply_markup as FakeTelegramMessage['reply_markup'],
            isSilent: payload.disable_notification === true,
            ...(typeof payload.parse_mode === 'string' ? { parseMode: payload.parse_mode } : {}),
          }, getPrivateChat(privateUser)) };
        }
        if (this.isPrivateChatStartRequired && Number(payload.chat_id) > 0) return { ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" };
        const message = this.storeMessage(Number(payload.message_thread_id ?? generalTopicThreadId), String(payload.text), this.options.botUser, {
          reply_markup: payload.reply_markup as FakeTelegramMessage['reply_markup'],
          isSilent: payload.disable_notification === true,
          ...(typeof payload.parse_mode === 'string' ? { parseMode: payload.parse_mode } : {}),
        }, this.getGroup(payload).chat);
        return { ok: true, result: message };
      }
      case 'editMessageText': {
        const message = this.getMessageOrError(payload);
        if ('ok' in message) return message;
        if (String(payload.text).length > telegramTextMaxLength) return { ok: false, error_code: 400, description: 'Bad Request: message is too long' };
        message.text = String(payload.text);
        // The real Bot API drops the inline keyboard of a message edited without one: that is how a one-shot picker is consumed.
        if (payload.reply_markup === undefined) delete message.reply_markup;
        else message.reply_markup = payload.reply_markup as FakeTelegramMessage['reply_markup'];
        return { ok: true, result: message };
      }
      case 'editMessageReplyMarkup': {
        const message = this.getMessageOrError(payload);
        if ('ok' in message) return message;
        message.reply_markup = payload.reply_markup as FakeTelegramMessage['reply_markup'];
        return { ok: true, result: message };
      }
      case 'deleteMessage': {
        if (this.isMessageDeletionRefused) return { ok: false, error_code: 400, description: 'Bad Request: message can\'t be deleted' };
        const message = this.messages.get(Number(payload.message_id));
        // The Bot API's own wording for a message that is not there (any more), which is not the one of an edit.
        if (!message || message.isDeleted) return { ok: false, error_code: 400, description: 'Bad Request: message to delete not found' };
        message.isDeleted = true;
        message.deletedAtMs = Date.now();
        this.pinnedMessageIds.delete(message.message_id);
        return { ok: true, result: true };
      }
      case 'deleteMessages': {
        if (this.isMessageDeletionRefused) return { ok: false, error_code: 400, description: 'Bad Request: message can\'t be deleted' };
        // «If some of the specified messages can't be found, they are skipped.» — the Bot API's own words.
        const messageIds = Array.isArray(payload.message_ids) ? payload.message_ids.map(Number) : [];
        if (messageIds.length < 1 || messageIds.length > maxDeleteMessagesPerCall) return { ok: false, error_code: 400, description: 'Bad Request: message identifiers are invalid' };
        for (const messageId of messageIds) {
          const message = this.messages.get(messageId);
          if (!message || message.isDeleted) continue;
          message.isDeleted = true;
          message.deletedAtMs = Date.now();
          this.pinnedMessageIds.delete(messageId);
        }
        return { ok: true, result: true };
      }
      case 'pinChatMessage': {
        const message = this.getMessageOrError(payload);
        if ('ok' in message) return message;
        this.pinnedMessageIds.add(message.message_id);
        this.pinEvents.push({ kind: 'pin', messageId: message.message_id, isSilent: payload.disable_notification === true });
        return { ok: true, result: true };
      }
      case 'unpinChatMessage': {
        const messageId = Number(payload.message_id);
        this.pinnedMessageIds.delete(messageId);
        this.pinEvents.push({ kind: 'unpin', messageId, isSilent: true });
        return { ok: true, result: true };
      }
      case 'answerCallbackQuery': {
        if (this.isCallbackAnswerExpired) return expiredCallbackQueryError;
        const toastText = String(payload.text ?? '');
        // The Bot API documents 0-200 characters for the notification and refuses a longer one: the tap then gets no feedback.
        if (toastText.length > callbackToastMaxLength) {
          return { ok: false, error_code: 400, description: `Bad Request: the notification text is too long (${toastText.length} characters, at most ${callbackToastMaxLength})` };
        }
        this.callbackAnswers.push(toastText);
        return { ok: true, result: true };
      }
      default:
        // deleteWebhook, setMyCommands, sendChatAction, … — accepted and recorded.
        return { ok: true, result: true };
    }
  }

  /** The name Telegram stores for a requested one: without an ending it drops (`strippedTopicNameEndings`), else as asked. */
  private getStoredTopicName(requestedName: string): string {
    const dropped = this.strippedTopicNameEndings.find((ending) => requestedName.endsWith(` ${ending}`));
    return dropped === undefined ? requestedName : requestedName.slice(0, requestedName.length - dropped.length - 1).trimEnd();
  }

  /**
   * `getUpdates`. An `offset` confirms the updates below it, as Telegram's does (telegraf sends one after every batch, so the updates it
   * got are gone already). `timeout: 0` is a short poll that only PEEKS — what waits, else an empty answer at once, never a held
   * connection, and nothing is taken: like Telegram, the fake keeps an update until a later call confirms it or a launch drops it
   * (`isPendingDroppedByLaunch`); the long poll below takes what it hands over.
   */
  private async getUpdates(payload: Record<string, unknown>, socket: Socket): Promise<Array<Record<string, unknown>>> {
    const limit = Number(payload.limit ?? maxUpdatesPerPoll);
    if (typeof payload.offset === 'number') {
      const firstUnconfirmedIndex = this.pendingUpdates.findIndex((update) => Number(update.update_id) >= Number(payload.offset));
      this.pendingUpdates.splice(0, firstUnconfirmedIndex === -1 ? this.pendingUpdates.length : firstUnconfirmedIndex);
    }
    if (Number(payload.timeout) === 0) return this.pendingUpdates.slice(0, Math.min(limit, maxUpdatesPerPoll));
    return this.takeUpdates(limit, socket, this.longPollHoldMs);
  }

  /**
   * The long poll: the pending updates at once, else held until one arrives or the hold passes. A poll whose
   * connection is gone (a stopped bot's last request) takes nothing: an update handed to a dead socket is lost.
   */
  private async takeUpdates(limit: number, socket: Socket, holdMs: number): Promise<Array<Record<string, unknown>>> {
    if (this.pendingUpdates.length === 0 && this.server) {
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          clearTimeout(timer);
          socket.off('close', wake);
          this.pollWakers.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, holdMs);
        socket.once('close', wake);
        this.pollWakers.add(wake);
      });
    }
    if (socket.destroyed) return [];
    return this.pendingUpdates.splice(0, Math.min(limit, maxUpdatesPerPoll));
  }
}
