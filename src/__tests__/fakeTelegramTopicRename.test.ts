/**
 * @description The topic renames of the fake Bot API (`telegramE2e/fakeTelegram.ts`) as the flows about the status marks need them: a name
 * is stored as asked by default, and a flow can ask the fake to drop an ENDING the way Telegram drops a trailing ✅ (measured live): the
 * stored name loses it, the call answers ok when that changes the title and TOPIC_NOT_MODIFIED when it does not, and the bot's own
 * «renamed» line carries the stored name.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeTelegram } from './telegramE2e/fakeTelegram';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };

interface BotApiAnswer {
  ok: boolean;
  description?: string;
}

describe('the fake Bot API\'s topic renames', () => {
  let fake: FakeTelegram;
  let apiRoot: string;
  let threadId: number;

  beforeEach(async () => {
    fake = new FakeTelegram({ botUser, operator, group });
    fake.isOwnTopicRenameDelivered = true;
    apiRoot = await fake.start();
    threadId = fake.pushTopicCreated('Deploy');
  });

  afterEach(async () => {
    await fake.stop();
  });

  async function rename(name: string): Promise<BotApiAnswer> {
    const response = await fetch(`${apiRoot}/bot1000000001:fake/editForumTopic`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: group.id, message_thread_id: threadId, name }),
    });
    return (await response.json()) as BotApiAnswer;
  }

  /** The name the newest «renamed» line of the topic carries, read by a short poll (it only peeks). */
  async function getLastRenameLineName(): Promise<string | undefined> {
    const response = await fetch(`${apiRoot}/bot1000000001:fake/getUpdates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timeout: 0, limit: 100 }),
    });
    const answer = (await response.json()) as { result: Array<{ message?: { forum_topic_edited?: { name?: string } } }> };
    return answer.result.map((update) => update.message?.forum_topic_edited?.name).filter((name) => name !== undefined).at(-1);
  }

  it('stores a name as asked, and answers «not modified» for the name it already has', async () => {
    assert.equal((await rename('Deploy 🟢')).ok, true);
    assert.equal(fake.getTopicName(threadId), 'Deploy 🟢');
    assert.match((await rename('Deploy 🟢')).description ?? '', /TOPIC_NOT_MODIFIED/);
  });

  it('drops a configured ending: ok when it changes the title, «not modified» when the title already reads so — and the line carries the stored name', async () => {
    fake.strippedTopicNameEndings = ['✅'];
    assert.equal((await rename('Deploy 💤')).ok, true);
    const lineCountBefore = fake.ownRenameLineIds.length;
    assert.equal((await rename('Deploy ✅')).ok, true, 'a change: the title goes from «Deploy 💤» to «Deploy»');
    assert.equal(fake.getTopicName(threadId), 'Deploy', 'the ending is gone');
    assert.equal(fake.ownRenameLineIds.length, lineCountBefore + 1);
    assert.equal(await getLastRenameLineName(), 'Deploy', 'the bot\'s own line says what Telegram stored, not what was asked');
    assert.match((await rename('Deploy ✅')).description ?? '', /TOPIC_NOT_MODIFIED/, 'no change: the title already reads «Deploy»');
    assert.equal((await rename('Deploy 🟢')).ok, true, 'an ending that is not configured is kept');
    assert.equal(fake.getTopicName(threadId), 'Deploy 🟢');
  });

  it('drops the ending only at the END and only after a space', async () => {
    fake.strippedTopicNameEndings = ['✅'];
    assert.equal((await rename('✅ Deploy')).ok, true);
    assert.equal(fake.getTopicName(threadId), '✅ Deploy');
    assert.equal((await rename('Deploy✅')).ok, true);
    assert.equal(fake.getTopicName(threadId), 'Deploy✅');
  });
});
