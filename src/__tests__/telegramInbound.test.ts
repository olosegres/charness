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
  getInboundEvent,
  getNormalizedAttachments,
  getPlatformMembers,
  getTelegramCommand,
} from '../connectors/telegram/inbound';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';

const botUsername = 'myCodeBot';

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
  const parsed = getTelegramCommand(makeCommandMessage('/status'), botUsername);
  assert.deepEqual(parsed, { name: 'status', args: [], argsText: '' });
});

test('getTelegramCommand: arguments split on whitespace, empties dropped', () => {
  const parsed = getTelegramCommand(makeCommandMessage('/trace  on   verbose'), botUsername);
  assert.deepEqual(parsed?.args, ['on', 'verbose']);
});

test('getTelegramCommand: argsText preserves the user inner spacing verbatim', () => {
  // `/rename_session` caps and stores this text as-is — collapsing the double
  // space would silently rewrite the user's title.
  const parsed = getTelegramCommand(makeCommandMessage('/rename_session my  long  title'), botUsername);
  assert.equal(parsed?.argsText, 'my  long  title');
  // The pre-seam expression this replaced, for comparison.
  assert.equal(parsed?.argsText, '/rename_session my  long  title'.split(' ').slice(1).join(' ').trim());
});

test('getTelegramCommand: a command addressed to THIS bot is accepted, case-insensitively', () => {
  const parsed = getTelegramCommand(makeCommandMessage('/status@MYCODEBOT now'), botUsername);
  assert.equal(parsed?.name, 'status');
  assert.equal(parsed?.argsText, 'now');
});

test('getTelegramCommand: a command addressed to ANOTHER bot is not ours', () => {
  // The group-with-several-bots case: answering here would hijack the other bot.
  assert.equal(getTelegramCommand(makeCommandMessage('/status@someOtherBot'), botUsername), null);
});

test('getTelegramCommand: text that only LOOKS like a command is not one', () => {
  // No `bot_command` entity → telegraf never treated it as a command either.
  assert.equal(getTelegramCommand(makePlainMessage('/status'), botUsername), null);
});

test('getTelegramCommand: a command not at offset 0 is not a command', () => {
  const message = makeCommandMessage('see /status', 7);
  message.entities = [{ type: 'bot_command', offset: 4, length: 7 }];
  assert.equal(getTelegramCommand(message, botUsername), null);
});

test('getTelegramCommand: a non-command first entity means no command', () => {
  const message = makeCommandMessage('/status');
  message.entities = [{ type: 'bold', offset: 0, length: 7 }];
  assert.equal(getTelegramCommand(message, botUsername), null);
});

// ─── event normalization ────────────────────────────────────────────────

const key = makeTelegramKey(-1001234567890, 42);

test('getInboundEvent: carries the author, the text and the parsed command', () => {
  const message = makeCommandMessage('/model sonnet');
  message.from = makeUser(7, { first_name: 'Ada', last_name: 'Lovelace' });
  const event = getInboundEvent(message, key, botUsername);

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
  const event = getInboundEvent(makePlainMessage('hi'), key, botUsername);
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
  const event = getInboundEvent(message, key, botUsername);
  assert.deepEqual(event.replyTo, {
    text: 'the earlier line',
    author: { id: '8', displayName: 'Grace' },
  });
});

test('getInboundEvent: a reply to a message with neither text nor caption is dropped', () => {
  const message = makePlainMessage('and this?');
  message.reply_to_message = {
    message_id: 9,
    date: 0,
    chat: message.chat,
    from: makeUser(8),
  } as Message.TextMessage;
  assert.equal(getInboundEvent(message, key, botUsername).replyTo, undefined);
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
  const event = getInboundEvent(message, key, botUsername);
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
