/**
 * @description The polling of the fake Bot API (`telegramE2e/fakeTelegram.ts`) as the flows that restart the bot need it: a poll with
 * `timeout: 0` answers at once whatever waits (a short poll, as the cold-start read of waiting updates makes), a long poll is held for
 * `longPollHoldMs`, and `deleteWebhook` with `drop_pending_updates` — what a cold launch sends — empties the waiting updates only when the
 * flow asked the fake to (`isPendingDroppedByLaunch`), so a flow that pushes updates before its first boot still gets them.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeTelegram } from './telegramE2e/fakeTelegram';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
const topicThreadId = 111;
/** A hold long enough to tell from an answer at once, short enough for a test. */
const testHoldMs = 400;
/**
 * The hold a short poll is checked against: a poll that is wrongly held takes this long. An absolute bound on the answer-at-once
 * has to sit far from it — a machine running the whole suite delays a loopback answer by hundreds of milliseconds, which made the
 * check fail when the bound was the (short) test hold itself.
 */
const wronglyHeldPollMs = 30_000;
/** What a short poll may take, however loaded the machine: far below {@link wronglyHeldPollMs}. */
const answerAtOnceLimitMs = 10_000;

interface UpdatesAnswer {
  ok: boolean;
  result: Array<{ update_id: number }>;
}

describe('the fake Bot API\'s polling', () => {
  let fake: FakeTelegram;
  let apiRoot: string;

  beforeEach(async () => {
    fake = new FakeTelegram({ botUser, operator, group });
    fake.longPollHoldMs = testHoldMs;
    apiRoot = await fake.start();
  });

  afterEach(async () => {
    await fake.stop();
  });

  async function callApi(method: string, payload: Record<string, unknown>): Promise<{ answer: UpdatesAnswer; elapsedMs: number }> {
    const startedAtMs = Date.now();
    const response = await fetch(`${apiRoot}/bot1000000001:fake/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    return { answer: (await response.json()) as UpdatesAnswer, elapsedMs: Date.now() - startedAtMs };
  }

  it('a poll with timeout 0 answers at once when nothing waits', async () => {
    fake.longPollHoldMs = wronglyHeldPollMs;
    const short = await callApi('getUpdates', { timeout: 0, limit: 100 });
    assert.deepEqual(short.answer.result, []);
    assert.ok(short.elapsedMs < answerAtOnceLimitMs, `the short poll took ${short.elapsedMs} ms`);
  });

  it('a long poll is held for the hold when nothing waits', async () => {
    const long = await callApi('getUpdates', { timeout: 50, limit: 100 });
    assert.deepEqual(long.answer.result, []);
    assert.ok(long.elapsedMs >= testHoldMs - 50, `the long poll took ${long.elapsedMs} ms`);
  });

  it('a poll with timeout 0 only PEEKS at what waits: the update stays until an offset confirms it, as in Telegram', async () => {
    fake.pushOperatorMessage(topicThreadId, 'waiting');
    const firstPeek = await callApi('getUpdates', { timeout: 0, limit: 100 });
    assert.equal(firstPeek.answer.result.length, 1);
    assert.equal((await callApi('getUpdates', { timeout: 0, limit: 100 })).answer.result.length, 1, 'nothing was taken');
    const updateId = firstPeek.answer.result[0].update_id;
    assert.equal((await callApi('getUpdates', { timeout: 0, limit: 100, offset: updateId })).answer.result.length, 1, 'an offset AT the update keeps it');
    assert.deepEqual((await callApi('getUpdates', { timeout: 0, limit: 100, offset: updateId + 1 })).answer.result, [], 'an offset past it confirms it');
  });

  it('a long poll takes what it hands over, and what a peek saw reaches the polling that follows', async () => {
    fake.pushOperatorMessage(topicThreadId, 'waiting');
    await callApi('getUpdates', { timeout: 0, limit: 100 });
    const long = await callApi('getUpdates', { timeout: 50, limit: 100 });
    assert.equal(long.answer.result.length, 1, 'the polling that follows the read still gets it');
    assert.deepEqual((await callApi('getUpdates', { timeout: 0, limit: 100 })).answer.result, [], 'and having handed it over, the fake does not hand it twice');
  });

  it('deleteWebhook with drop_pending_updates leaves the waiting updates alone unless the flow asked for the drop', async () => {
    fake.pushOperatorMessage(topicThreadId, 'waiting');
    await callApi('deleteWebhook', { drop_pending_updates: true });
    assert.equal((await callApi('getUpdates', { timeout: 0, limit: 100 })).answer.result.length, 1, 'by default the update is still there');

    fake.isPendingDroppedByLaunch = true;
    await callApi('deleteWebhook', { drop_pending_updates: false });
    assert.equal((await callApi('getUpdates', { timeout: 0, limit: 100 })).answer.result.length, 1, 'a deleteWebhook that does not ask for the drop keeps them');
    await callApi('deleteWebhook', { drop_pending_updates: true });
    assert.deepEqual((await callApi('getUpdates', { timeout: 0, limit: 100 })).answer.result, [], 'the cold launch dropped what waited');
  });
});
