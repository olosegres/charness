/**
 * @description The reader of the topic renames that wait for the bot (`connectors/telegram/waitingTopicRenames.ts`), which a COLD start
 * runs before the launch drops every waiting update: it asks for service messages only and never holds a poll open, keeps only the
 * `forum_topic_edited` updates that carry a new name — an icon-only edit, a plain message and any other update are not renames —, in
 * order, reads further pages by `offset` while a page is full, stops at the page cap, and — when a call fails — hands back what it
 * has and reports the failure instead of throwing.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Update } from 'telegraf/typings/core/types/typegram';
import type { UpdateType } from 'telegraf/typings/telegram-types';
import {
  getWaitingTopicRename,
  readWaitingTopicRenames,
  waitingUpdatesMaxPages,
  waitingUpdatesPageSize,
  type WaitingUpdatesRequest,
} from '../connectors/telegram/waitingTopicRenames';

const chat = { id: -1001111111111, type: 'supergroup' as const, title: 'ExampleGroup', is_forum: true as const };
/** The bot's own subscription (`botAllowedUpdates`): Telegram remembers the list a call names, so the read must hand the whole of it back. */
const allowedUpdates: UpdateType[] = ['message', 'edited_message', 'callback_query', 'my_chat_member', 'chat_member'];
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };

function renameUpdate(updateId: number, threadId: number, name: string | undefined): Update {
  return { update_id: updateId, message: { message_id: updateId, date: 1, chat, from: operator, message_thread_id: threadId, is_topic_message: true, forum_topic_edited: name === undefined ? { icon_custom_emoji_id: '5' } : { name } } };
}

function textUpdate(updateId: number): Update {
  return { update_id: updateId, message: { message_id: updateId, date: 1, chat, from: operator, text: 'hello' } };
}

function callbackUpdate(updateId: number): Update {
  return { update_id: updateId, callback_query: { id: 'c', from: operator, chat_instance: 'i', data: 'x' } };
}

describe('getWaitingTopicRename', () => {
  it('is the service message of a rename that carries a name, and nothing else', () => {
    assert.equal(getWaitingTopicRename(renameUpdate(1, 11, 'Deploy 2'))?.forum_topic_edited.name, 'Deploy 2');
    assert.equal(getWaitingTopicRename(renameUpdate(2, 11, undefined)), null, 'an icon-only edit has no name');
    assert.equal(getWaitingTopicRename(renameUpdate(3, 11, '')), null);
    assert.equal(getWaitingTopicRename(textUpdate(4)), null);
    assert.equal(getWaitingTopicRename(callbackUpdate(5)), null);
  });
});

describe('readWaitingTopicRenames', () => {
  it('asks with the bot\'s whole list of update types — never a partial one Telegram would remember — and never holds the poll open', async () => {
    const requests: WaitingUpdatesRequest[] = [];
    await readWaitingTopicRenames(async (request) => { requests.push(request); return []; }, () => undefined, allowedUpdates);
    assert.deepEqual(requests, [{ limit: waitingUpdatesPageSize, timeout: 0, allowed_updates: allowedUpdates }]);
  });

  it('keeps the renames of every topic in order and drops everything else, the other update types of the list included', async () => {
    const renames = await readWaitingTopicRenames(
      async () => [textUpdate(1), renameUpdate(2, 11, 'Deploy 2'), callbackUpdate(3), renameUpdate(4, 22, 'Research'), renameUpdate(5, 11, 'Deploy 3'), renameUpdate(6, 33, undefined)],
      () => undefined,
      allowedUpdates,
    );
    assert.deepEqual(renames.map((rename) => [rename.message_thread_id, rename.forum_topic_edited.name]), [[11, 'Deploy 2'], [22, 'Research'], [11, 'Deploy 3']]);
  });

  it('reads the next page past the last update while a page is full, and stops at the first that is not', async () => {
    const fullPage = Array.from({ length: waitingUpdatesPageSize }, (_, index) => textUpdate(index + 1));
    const requests: WaitingUpdatesRequest[] = [];
    const pages: Update[][] = [fullPage, [...fullPage.map((update) => ({ ...update, update_id: update.update_id + waitingUpdatesPageSize })).slice(0, 5), renameUpdate(9_999, 11, 'Late')]];
    const renames = await readWaitingTopicRenames(async (request) => { requests.push(request); return pages[requests.length - 1] ?? []; }, () => undefined, allowedUpdates);
    assert.deepEqual(requests.map((request) => request.offset), [undefined, waitingUpdatesPageSize + 1], 'the second page starts after the first one\'s last update');
    assert.deepEqual(renames.map((rename) => rename.forum_topic_edited.name), ['Late']);
  });

  it('stops at the page cap even when every page is full', async () => {
    let calls = 0;
    await readWaitingTopicRenames(async () => {
      calls += 1;
      return Array.from({ length: waitingUpdatesPageSize }, (_, index) => textUpdate(calls * 1000 + index));
    }, () => undefined, allowedUpdates);
    assert.equal(calls, waitingUpdatesMaxPages);
  });

  it('hands back what it read and reports the failure when a call fails', async () => {
    const errors: unknown[] = [];
    let calls = 0;
    const renames = await readWaitingTopicRenames(async () => {
      calls += 1;
      if (calls === 2) throw new Error('Conflict: terminated by other getUpdates request');
      return Array.from({ length: waitingUpdatesPageSize - 1 }, (_, index) => textUpdate(index + 1)).concat([renameUpdate(500, 11, 'Before the failure')]);
    }, (error) => errors.push(error), allowedUpdates);
    assert.deepEqual(renames.map((rename) => rename.forum_topic_edited.name), ['Before the failure']);
    assert.equal(errors.length, 1);
    assert.match(String(errors[0]), /Conflict/);
  });
});
