/**
 * @description Platform-seam S2 — the Telegram connector's inbound translation.
 *
 * Two things are load-bearing here and both would fail silently:
 *
 *  1. **Command recognition must stay byte-for-byte telegraf's rule.** Routing
 *     every command through the neutral router replaced ~60 `bot.command(...)`
 *     registrations with one trigger, so any divergence changes which messages
 *     count as commands — a command addressed to another bot in the same group
 *     would start answering, or `/status` would stop working.
 *  2. **The argument split must reproduce the ad-hoc parsing it replaced.**
 *     Handlers used to do `text.split(' ').slice(1).join(' ').trim()`; commands
 *     that take prose (a session title) must keep the user's inner spacing.
 *
 * Also covers the membership mapping that let `accessControl.ts` drop its
 * telegraf type import.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type { ChatMember, Message, User } from 'telegraf/typings/core/types/typegram';
import {
  checkShouldInvalidateAdminCache,
  createTelegramConnectorInbound,
  getInboundEvent,
  getNormalizedAttachments,
  getPlatformMembers,
  getTelegramCommand,
  getTelegramReplyQuoteBlock,
} from '../connectors/telegram/inbound';
import type { InboundEvent } from '../platform/inbound';
import { AdminCache } from '../accessControl';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';

const identity = { username: 'myCodeBot', userId: 1000 };

function makeUser(id: number, overrides: Partial<User> = {}): User {
  return { id, is_bot: false, first_name: `u${id}`, ...overrides };
}

/** A text message with the `bot_command` entity Telegram really sends. */
function makeCommandMessage(text: string, entityLength?: number): Message.TextMessage {
  const length = entityLength ?? (text.split(' ')[0] ?? text).length;
  return {
    message_id: 1,
    date: 0,
    chat: { id: -1001234567890, type: 'supergroup', title: 'g' },
    from: makeUser(7),
    text,
    entities: [{ type: 'bot_command', offset: 0, length }],
  } as Message.TextMessage;
}

function makePlainMessage(text: string): Message.TextMessage {
  return {
    message_id: 2,
    date: 0,
    chat: { id: -1001234567890, type: 'supergroup', title: 'g' },
    from: makeUser(7),
    text,
  } as Message.TextMessage;
}

// ─── command recognition ────────────────────────────────────────────────

test('getTelegramCommand: a plain command yields its name and empty args', () => {
  const parsed = getTelegramCommand(makeCommandMessage('/status'), identity);
  assert.deepEqual(parsed, { name: 'status', args: [], argsText: '' });
});

test('getTelegramCommand: arguments split on whitespace, empties dropped', () => {
  const parsed = getTelegramCommand(makeCommandMessage('/trace  on   verbose'), identity);
  assert.deepEqual(parsed?.args, ['on', 'verbose']);
});

test('getTelegramCommand: argsText preserves the user inner spacing verbatim', () => {
  // `/rename_session` caps and stores this text as-is — collapsing the double
  // space would silently rewrite the user's title.
  const parsed = getTelegramCommand(makeCommandMessage('/rename_session my  long  title'), identity);
  assert.equal(parsed?.argsText, 'my  long  title');
  // The pre-seam expression this replaced, for comparison.
  assert.equal(parsed?.argsText, '/rename_session my  long  title'.split(' ').slice(1).join(' ').trim());
});

test('getTelegramCommand: a command addressed to THIS bot is accepted, case-insensitively', () => {
  const parsed = getTelegramCommand(makeCommandMessage('/status@MYCODEBOT now'), identity);
  assert.equal(parsed?.name, 'status');
  assert.equal(parsed?.argsText, 'now');
});

test('getTelegramCommand: a command addressed to ANOTHER bot is not ours', () => {
  // The group-with-several-bots case: answering here would hijack the other bot.
  assert.equal(getTelegramCommand(makeCommandMessage('/status@someOtherBot'), identity), null);
});

test('getTelegramCommand: text that only LOOKS like a command is not one', () => {
  // No `bot_command` entity → telegraf never treated it as a command either.
  assert.equal(getTelegramCommand(makePlainMessage('/status'), identity), null);
});

test('getTelegramCommand: a command not at offset 0 is not a command', () => {
  const message = makeCommandMessage('see /status', 7);
  message.entities = [{ type: 'bot_command', offset: 4, length: 7 }];
  assert.equal(getTelegramCommand(message, identity), null);
});

test('getTelegramCommand: a non-command first entity means no command', () => {
  const message = makeCommandMessage('/status');
  message.entities = [{ type: 'bold', offset: 0, length: 7 }];
  assert.equal(getTelegramCommand(message, identity), null);
});

// ─── event normalization ────────────────────────────────────────────────

const key = makeTelegramKey(-1001234567890, 42);

test('getInboundEvent: carries the author, the text and the parsed command', () => {
  const message = makeCommandMessage('/model sonnet');
  message.from = makeUser(7, { first_name: 'Ada', last_name: 'Lovelace' });
  const event = getInboundEvent(message, key, identity);

  assert.deepEqual(event.key, key);
  assert.deepEqual(event.author, { id: '7', displayName: 'Ada Lovelace' });
  assert.equal(event.text, '/model sonnet');
  assert.equal(event.command?.name, 'model');
  assert.equal(event.command?.argsText, 'sonnet');
  assert.equal(event.raw, message);
});

test('getInboundEvent: the author carries no admin flag', () => {
  // One source of admin truth: AdminCache. A per-event snapshot would disagree
  // with the cache after a demotion and give the policy two answers.
  const event = getInboundEvent(makePlainMessage('hi'), key, identity);
  assert.deepEqual(Object.keys(event.author).sort(), ['displayName', 'id']);
});

test('getInboundEvent: a reply folds the quoted text and its author in', () => {
  const message = makePlainMessage('and this?');
  message.reply_to_message = {
    message_id: 9,
    date: 0,
    chat: message.chat,
    from: makeUser(8, { first_name: 'Grace' }),
    text: 'the earlier line',
  } as Message.TextMessage;
  const event = getInboundEvent(message, key, identity);
  assert.deepEqual(event.replyTo, {
    text: 'the earlier line',
    author: { id: '8', displayName: 'Grace' },
    isFromAssistant: false,
  });
});

test('getInboundEvent: a highlighted partial quote wins over the full replied-to text', () => {
  // The operator pointed at a specific span; folding the whole message in
  // instead would bury what they actually asked about. Shared with the prompt
  // block via `extractReplyQuote` — a private copy here is how that regresses.
  const message = makePlainMessage('and this?');
  message.reply_to_message = {
    message_id: 9,
    date: 0,
    chat: message.chat,
    from: makeUser(8),
    text: 'a very long earlier answer',
  } as Message.TextMessage;
  message.quote = { text: 'long earlier', position: 2, is_manual: true };
  assert.equal(getInboundEvent(message, key, identity).replyTo?.text, 'long earlier');
});

test('getInboundEvent: a reply authored by this bot is attributed to the assistant', () => {
  const message = makePlainMessage('why?');
  message.reply_to_message = {
    message_id: 9,
    date: 0,
    chat: message.chat,
    from: makeUser(identity.userId, { is_bot: true }),
    text: 'the agent answer',
  } as Message.TextMessage;
  assert.equal(getInboundEvent(message, key, identity).replyTo?.isFromAssistant, true);
});

test('getInboundEvent: replying to the topic root is not a quote', () => {
  // Telegram models "post in this topic" as a reply to the topic-root message;
  // folding the topic title into every prompt would be noise.
  const message = makePlainMessage('start here');
  message.message_thread_id = 42;
  message.reply_to_message = {
    message_id: 42,
    date: 0,
    chat: message.chat,
    from: makeUser(8),
    text: 'Topic title',
  } as Message.TextMessage;
  assert.equal(getInboundEvent(message, key, identity).replyTo, undefined);
});

test('getInboundEvent: a reply to a service message is not a quote', () => {
  const message = makePlainMessage('hm');
  message.reply_to_message = {
    message_id: 9,
    date: 0,
    chat: message.chat,
    from: makeUser(8),
    text: 'Topic created',
    forum_topic_created: { name: 'Topic', icon_color: 0 },
  } as unknown as Message.TextMessage;
  assert.equal(getInboundEvent(message, key, identity).replyTo, undefined);
});

test('getInboundEvent: a reply to a message with neither text nor caption is dropped', () => {
  const message = makePlainMessage('and this?');
  message.reply_to_message = {
    message_id: 9,
    date: 0,
    chat: message.chat,
    from: makeUser(8),
  } as Message.TextMessage;
  assert.equal(getInboundEvent(message, key, identity).replyTo, undefined);
});

// ─── reply-quote block (typed text, voice note, file) ───────────────────

/** The topic every message below is posted in (its root message id). */
const topicRootId = 42;

/** What a message's `reply_to_message` holds (telegraf does not export the name). */
type RepliedMessage = NonNullable<Message.VoiceMessage['reply_to_message']>;

/** The agent's earlier answer in the topic — what the operator replies to. */
const agentAnswer = {
  message_id: 77,
  date: 0,
  chat: { id: -1001234567890, type: 'supergroup', title: 'g' },
  from: makeUser(identity.userId, { is_bot: true }),
  message_thread_id: topicRootId,
  text: 'The build failed:\nAPI_URL is not set',
} as RepliedMessage;

/**
 * A voice note posted in the topic. Telegram sets `reply_to_message` on EVERY
 * topic message: the topic-root service message for a plain post, the replied-to
 * message for a REPLY.
 */
function makeTopicVoiceMessage(replyTo: RepliedMessage | undefined): Message.VoiceMessage {
  return {
    message_id: 80,
    date: 0,
    chat: { id: -1001234567890, type: 'supergroup', title: 'g' },
    from: makeUser(7),
    message_thread_id: topicRootId,
    is_topic_message: true,
    reply_to_message: replyTo,
    voice: { file_id: 'v1', file_unique_id: 'vu', duration: 3 },
  } as Message.VoiceMessage;
}

/** The topic-root service message a plain (non-reply) topic post points at. */
const topicRootMessage = {
  message_id: topicRootId,
  date: 0,
  chat: { id: -1001234567890, type: 'supergroup', title: 'g' },
  from: makeUser(7),
  forum_topic_created: { name: 'Topic', icon_color: 0 },
} as RepliedMessage;

test('getTelegramReplyQuoteBlock: a voice reply to the agent answer carries the quote block', () => {
  assert.equal(
    getTelegramReplyQuoteBlock(makeTopicVoiceMessage(agentAnswer), identity),
    ['[Replying to an earlier message · from: assistant]', '> The build failed:', '> API_URL is not set'].join('\n'),
  );
});

test('getTelegramReplyQuoteBlock: a voice reply gets exactly the block a typed reply to the same message does', () => {
  const typedReply = makePlainMessage('why?');
  typedReply.message_thread_id = topicRootId;
  typedReply.reply_to_message = agentAnswer;
  const typedBlock = getTelegramReplyQuoteBlock(typedReply, identity);
  assert.ok(typedBlock !== undefined);
  assert.equal(getTelegramReplyQuoteBlock(makeTopicVoiceMessage(agentAnswer), identity), typedBlock);
});

test('getTelegramReplyQuoteBlock: the highlighted part of the replied-to message wins for a voice reply too', () => {
  const message = makeTopicVoiceMessage(agentAnswer);
  message.quote = { text: 'API_URL', position: 31, is_manual: true };
  assert.equal(
    getTelegramReplyQuoteBlock(message, identity),
    ['[Replying to an earlier message · from: assistant]', '> API_URL'].join('\n'),
  );
});

test('getTelegramReplyQuoteBlock: a voice posted plainly in the topic carries no block', () => {
  // Its `reply_to_message` is the topic root — "post in this topic", not a quote.
  assert.equal(getTelegramReplyQuoteBlock(makeTopicVoiceMessage(topicRootMessage), identity), undefined);
});

test('getTelegramReplyQuoteBlock: a voice that replies to nothing carries no block', () => {
  assert.equal(getTelegramReplyQuoteBlock(makeTopicVoiceMessage(undefined), identity), undefined);
});

/** A photo or document posted in the topic, captioned like a real upload. */
function makeTopicFileMessage(kind: 'photo' | 'document', replyTo: RepliedMessage | undefined): Message {
  const base = {
    message_id: 81,
    date: 0,
    chat: { id: -1001234567890, type: 'supergroup', title: 'g' },
    from: makeUser(7),
    message_thread_id: topicRootId,
    is_topic_message: true,
    reply_to_message: replyTo,
    caption: 'here is the screen',
  };
  return kind === 'photo'
    ? ({ ...base, photo: [{ file_id: 'p1', file_unique_id: 'pu', width: 10, height: 10 }] } as Message.PhotoMessage)
    : ({ ...base, document: { file_id: 'd1', file_unique_id: 'du', file_name: 'build.log' } } as Message.DocumentMessage);
}

test('getTelegramReplyQuoteBlock: a photo or document sent as a reply carries the block a typed reply does', () => {
  // The file's own caption is the user's text, never the quote: the quote is the message replied to.
  const typedReply = makePlainMessage('why?');
  typedReply.message_thread_id = topicRootId;
  typedReply.reply_to_message = agentAnswer;
  const typedBlock = getTelegramReplyQuoteBlock(typedReply, identity);
  assert.ok(typedBlock !== undefined);
  for (const kind of ['photo', 'document'] as const) {
    assert.equal(getTelegramReplyQuoteBlock(makeTopicFileMessage(kind, agentAnswer), identity), typedBlock, kind);
  }
});

test('getTelegramReplyQuoteBlock: a file posted plainly in the topic carries no block', () => {
  for (const kind of ['photo', 'document'] as const) {
    assert.equal(getTelegramReplyQuoteBlock(makeTopicFileMessage(kind, topicRootMessage), identity), undefined, kind);
  }
});

test('getInboundEvent: a captioned photo surfaces as text plus an attachment', () => {
  const message = {
    message_id: 3,
    date: 0,
    chat: { id: -1001234567890, type: 'supergroup', title: 'g' },
    from: makeUser(7),
    caption: 'look at this',
    photo: [{ file_id: 'small', file_unique_id: 'su', width: 1, height: 1, file_size: 10 }],
  } as unknown as Message;
  const event = getInboundEvent(message, key, identity);
  assert.equal(event.text, 'look at this');
  assert.equal(event.command, undefined);
  assert.deepEqual(event.attachments, [
    {
      kind: 'photo',
      handle: 'small',
      uniqueId: 'su',
      fileName: null,
      sizeBytes: 10,
      caption: 'look at this',
    },
  ]);
});

test('getNormalizedAttachments: voice normalizes even though intake skips it', () => {
  // Voice goes to transcription, not file intake — but the core still has to
  // see that the message carried something.
  const message = {
    message_id: 4,
    date: 0,
    chat: { id: -1001234567890, type: 'supergroup', title: 'g' },
    from: makeUser(7),
    voice: { file_id: 'v1', file_unique_id: 'vu', duration: 3, file_size: 99 },
  } as unknown as Message;
  assert.deepEqual(getNormalizedAttachments(message), [
    { kind: 'voice', handle: 'v1', uniqueId: 'vu', fileName: null, sizeBytes: 99, caption: null },
  ]);
});

test('getNormalizedAttachments: Telegram video flavours collapse onto one kind', () => {
  const base = {
    message_id: 5,
    date: 0,
    chat: { id: -1001234567890, type: 'supergroup', title: 'g' },
    from: makeUser(7),
  };
  const videoNote = {
    ...base,
    video_note: { file_id: 'n1', file_unique_id: 'nu', length: 1, duration: 2 },
  } as unknown as Message;
  const animation = {
    ...base,
    animation: { file_id: 'a1', file_unique_id: 'au', width: 1, height: 1, duration: 2 },
  } as unknown as Message;
  assert.equal(getNormalizedAttachments(videoNote)[0]?.kind, 'video');
  assert.equal(getNormalizedAttachments(animation)[0]?.kind, 'video');
});

test('getNormalizedAttachments: a plain text message has none', () => {
  assert.deepEqual(getNormalizedAttachments(makePlainMessage('hi')), []);
});

// ─── membership mapping ─────────────────────────────────────────────────

function makeChatMember(status: ChatMember['status'], id: number, isBot = false): ChatMember {
  return { status, user: makeUser(id, { is_bot: isBot }) } as ChatMember;
}

test('getPlatformMembers: creator and administrator map to elevated rights', () => {
  const members = [
    makeChatMember('creator', 1),
    makeChatMember('administrator', 2),
    makeChatMember('administrator', 3, true),
    makeChatMember('member', 4),
    makeChatMember('left', 5),
  ];
  assert.deepEqual(
    getPlatformMembers(members).map((m) => [m.id, m.hasElevatedRights, m.isBot]),
    [
      ['1', true, false],
      ['2', true, false],
      ['3', true, true],
      ['4', false, false],
      ['5', false, false],
    ],
  );
});

test('getPlatformMembers: the display name prefers the real name, then the handle', () => {
  const named = makeChatMember('member', 1);
  named.user = makeUser(1, { first_name: 'Ada', last_name: 'Lovelace' });
  const handleOnly = makeChatMember('member', 2);
  handleOnly.user = { id: 2, is_bot: false, first_name: '', username: 'ada' } as User;

  assert.equal(getPlatformMembers([named])[0]?.displayName, 'Ada Lovelace');
  assert.equal(getPlatformMembers([handleOnly])[0]?.displayName, 'ada');
});

// ─── chat_member → cache invalidation ───────────────────────────────────

test('chat_member transitions touching admin status invalidate the cache', () => {
  // Promotion: a member becomes an admin → the admin set grew.
  assert.equal(checkShouldInvalidateAdminCache('member', 'administrator'), true);
  // Demotion: an admin becomes a regular member → must lose access NOW, not at TTL.
  assert.equal(checkShouldInvalidateAdminCache('administrator', 'member'), true);
  // An admin leaves / is kicked → the admin set shrank.
  assert.equal(checkShouldInvalidateAdminCache('administrator', 'left'), true);
  assert.equal(checkShouldInvalidateAdminCache('creator', 'member'), true);
});

test('chat_member transitions of regular members do not invalidate the cache', () => {
  // Join / leave / restriction of a non-admin can't change the admin set.
  assert.equal(checkShouldInvalidateAdminCache('left', 'member'), false);
  assert.equal(checkShouldInvalidateAdminCache('member', 'left'), false);
  assert.equal(checkShouldInvalidateAdminCache('member', 'restricted'), false);
});

// ─── the connector's inbound side ───────────────────────────────────────

function makeConnector(administrators: ChatMember[] = []) {
  const chatIdsAsked: number[] = [];
  const connector = createTelegramConnectorInbound({
    listAdministrators: async (chatId) => {
      chatIdsAsked.push(chatId);
      return administrators;
    },
    getIdentity: () => identity,
  });
  return { connector, chatIdsAsked };
}

test('deliver normalizes the message and forwards `raw` verbatim', async () => {
  const { connector } = makeConnector();
  const received: InboundEvent[] = [];
  await connector.start((event) => {
    received.push(event);
  });

  // `raw` is the escape hatch the not-yet-relocated command handlers read their
  // telegraf context off — it must arrive as given, NOT replaced by the message.
  const context = { message: makeCommandMessage('/status'), marker: 'the telegraf context' };
  await connector.deliver(context.message, key, context);

  assert.equal(received.length, 1);
  assert.equal(received[0].command?.name, 'status');
  assert.equal(received[0].raw, context);
});

test('deliver falls back to the message when no `raw` is supplied', async () => {
  const { connector } = makeConnector();
  const received: InboundEvent[] = [];
  await connector.start((event) => {
    received.push(event);
  });

  const message = makePlainMessage('hello');
  await connector.deliver(message, key);
  assert.equal(received[0].raw, message);
});

test('deliver before start (or after stop) drops the event instead of buffering it', async () => {
  const { connector } = makeConnector();
  const received: InboundEvent[] = [];

  // Unarmed: there is no core to route to, and replaying it later would run
  // stale work at an arbitrary moment.
  await connector.deliver(makePlainMessage('too early'), key);
  assert.equal(received.length, 0);

  await connector.start((event) => {
    received.push(event);
  });
  await connector.deliver(makePlainMessage('armed'), key);
  assert.equal(received.length, 1);

  await connector.stop();
  await connector.deliver(makePlainMessage('too late'), key);
  assert.equal(received.length, 1);
});

test('listMembersWithElevatedRights reduces the roster to elevated humans', async () => {
  const { connector, chatIdsAsked } = makeConnector([
    makeChatMember('creator', 1),
    makeChatMember('administrator', 2),
    makeChatMember('administrator', 3, true), // a bot admin is never an operator
    makeChatMember('member', 4),
  ]);

  assert.deepEqual(await connector.listMembersWithElevatedRights('-1001234567890'), ['1', '2']);
  assert.deepEqual(chatIdsAsked, [-1001234567890]);
});

test('listMembersWithElevatedRights REJECTS a space that is not a chat id', async () => {
  // A foreign key reaching the Telegram connector is a wiring bug, not a
  // membership question. It must not call the API with NaN — and it must not
  // resolve `[]` either: to `AdminCache` that is a successful "this group has no
  // admins" fetch, which it caches. See the composition test below.
  const { connector, chatIdsAsked } = makeConnector([makeChatMember('creator', 1)]);
  await assert.rejects(() => connector.listMembersWithElevatedRights('ABC-123'), /not a chat id/);
  assert.deepEqual(chatIdsAsked, []);
});

test('a rejected membership lookup keeps the cached admins instead of locking everyone out', async () => {
  // The composition the two halves only break in TOGETHER: a lookup that fails
  // CLOSED (resolving `[]`) reaches `AdminCache.refresh` as a SUCCESS, which
  // stamps it fresh, clears the failure timestamp and denies every admin for the
  // whole TTL with no retry and nothing logged. Proven end to end against the
  // real connector and the real cache.
  const ttlMs = 60_000;
  const failureRetryMs = 5_000;
  const servedSpace = '-1001234567890';
  let space = servedSpace;
  let now = 0;
  let roster: ChatMember[] = [makeChatMember('creator', 1)];
  const connector = createTelegramConnectorInbound({
    listAdministrators: async () => roster,
    getIdentity: () => identity,
  });
  const cache = new AdminCache({
    fetchElevatedMemberIds: () => connector.listMembersWithElevatedRights(space),
    ttlMs,
    failureRetryMs,
    now: () => now,
  });

  assert.deepEqual([...(await cache.getAdminIds())], ['1']);

  // The lookup breaks while the cached set is stale → last-known survives.
  space = 'ABC-123';
  now += ttlMs + 1;
  assert.deepEqual(
    [...(await cache.getAdminIds())],
    ['1'],
    'a failed lookup must not empty the admin set',
  );

  // …and the failure was recorded as a FAILURE: the next read after the SHORT
  // backoff re-fetches and sees the promotion. Had the empty result been cached
  // as a success, `fetchedAt` would be fresh here and this would still be the
  // stale (empty) set.
  space = servedSpace;
  roster = [makeChatMember('creator', 1), makeChatMember('administrator', 2)];
  now += failureRetryMs + 1;
  assert.deepEqual([...(await cache.getAdminIds())].sort(), ['1', '2']);
});
