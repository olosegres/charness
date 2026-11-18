/**
 * @description What the fake Bot API puts in `reply_to_message` of a message the operator sends, as a real client does: a plain message
 * typed in a forum topic carries the topic's ROOT message («post in this topic»), General — which has no creation message — carries
 * nothing, and an explicit reply carries the message replied to. A flow's bot is tested against exactly these shapes: a bot that
 * mistakes the topic root for a genuine reply shows in every flow, and one that reads «has a reply» in General would be tested against
 * a message Telegram never sends.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeTelegram, generalTopicThreadId } from './telegramE2e/fakeTelegram';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake accepts any `/bot<token>/` path. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const topicThreadId = 111;

interface WireMessage {
  message_id: number;
  message_thread_id?: number;
  reply_to_message?: { message_id: number; forum_topic_created?: { name: string } };
}

describe('the fake Bot API\'s reply_to_message', () => {
  let fakeTelegram: FakeTelegram;
  let apiRoot: string;

  before(async () => {
    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    apiRoot = await fakeTelegram.start();
  });

  after(async () => {
    await fakeTelegram.stop();
  });

  /** The messages the bot would receive from the updates queued so far. */
  async function takeQueuedMessages(): Promise<WireMessage[]> {
    const response = await fetch(`${apiRoot}/bot${fakeBotToken}/getUpdates`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ timeout: 0 }), signal: AbortSignal.timeout(10_000) });
    const body = await response.json() as { result: Array<{ update_id: number; message?: WireMessage }> };
    return body.result.flatMap((update) => (update.message ? [update.message] : []));
  }

  it('a plain message in a topic carries the topic\'s root message — its creation service message, whose id is the topic\'s', async () => {
    const sentId = fakeTelegram.pushOperatorMessage(topicThreadId, 'a plain message');
    const message = (await takeQueuedMessages()).find((candidate) => candidate.message_id === sentId);

    assert.ok(message, 'the message was queued');
    assert.equal(message.reply_to_message?.message_id, topicThreadId);
    assert.ok(message.reply_to_message?.forum_topic_created, 'the creation service message');
  });

  it('a plain message in General carries no reply at all: General has no creation message', async () => {
    const sentId = fakeTelegram.pushOperatorMessage(generalTopicThreadId, 'a plain message in General');
    const message = (await takeQueuedMessages()).find((candidate) => candidate.message_id === sentId);

    assert.ok(message, 'the message was queued');
    assert.equal('reply_to_message' in message, false);
  });

  it('an explicit reply carries the message replied to, in a topic and in General alike', async () => {
    const earlierInTopic = fakeTelegram.pushOperatorMessage(topicThreadId, 'earlier in the topic');
    const earlierInGeneral = fakeTelegram.pushOperatorMessage(generalTopicThreadId, 'earlier in General');
    const topicReply = fakeTelegram.pushOperatorMessage(topicThreadId, 'a reply', { replyToMessageId: earlierInTopic });
    const generalReply = fakeTelegram.pushOperatorMessage(generalTopicThreadId, 'a reply in General', { replyToMessageId: earlierInGeneral });
    const messages = await takeQueuedMessages();

    assert.equal(messages.find((candidate) => candidate.message_id === topicReply)?.reply_to_message?.message_id, earlierInTopic);
    assert.equal(messages.find((candidate) => candidate.message_id === generalReply)?.reply_to_message?.message_id, earlierInGeneral);
  });
});
