/**
 * @description The note of the first long poll (`connectors/telegram/firstUpdateBatchNote.ts`): the updates that waited while the bot was
 * down are handled once the first `getUpdates` was ANSWERED (an empty batch counts) and the dispatcher is empty — or once that first poll
 * has stayed open for the hold, which means Telegram had nothing for it. A poll that failed is no answer and starts no hold of its own
 * past the next call; every other method is no poll; every call and answer passes through unchanged.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CallApiHost } from '../outputTrace';
import { firstPollHoldMs, installFirstUpdateBatchNote } from '../connectors/telegram/firstUpdateBatchNote';

/** A host whose answers the test releases one by one, and a clock the test moves. */
function createHost(): {
  host: CallApiHost;
  calls: string[];
  answer: (index: number, result: object | boolean) => void;
  fail: (index: number, error: Error) => void;
  clock: { nowMs: number };
} {
  const calls: string[] = [];
  const pending: Array<{ resolve: (result: object | boolean) => void; reject: (error: Error) => void }> = [];
  const host: CallApiHost = {
    callApi: (method) => {
      calls.push(method);
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
  };
  return { host, calls, answer: (index, result) => pending[index].resolve(result), fail: (index, error) => pending[index].reject(error), clock: { nowMs: 1_000_000 } };
}

describe('installFirstUpdateBatchNote', () => {
  it('is not handled until a getUpdates call has been answered and the dispatcher is empty — an empty batch counts', async () => {
    const { host, answer, clock } = createHost();
    const note = installFirstUpdateBatchNote(host, { getNowMs: () => clock.nowMs });
    assert.equal(note.checkIsBacklogHandled(0), false, 'no poll was sent yet');
    const poll = host.callApi('getUpdates', { timeout: 50 });
    assert.equal(note.checkIsBacklogHandled(0), false, 'the poll is still waiting');
    answer(0, []);
    assert.deepEqual(await poll, []);
    assert.equal(note.checkIsBacklogHandled(0), true);
    assert.equal(note.checkIsBacklogHandled(2), false, 'the updates it brought are still queued');
  });

  it('a first poll that stays open for the hold means nothing waited: the backlog is handled without an answer', async () => {
    const { host, clock } = createHost();
    const note = installFirstUpdateBatchNote(host, { getNowMs: () => clock.nowMs });
    void host.callApi('getUpdates', { timeout: 50 });
    clock.nowMs += firstPollHoldMs - 1;
    assert.equal(note.checkIsBacklogHandled(0), false, 'a poll that is only a moment old may still be about to bring a batch');
    clock.nowMs += 1;
    assert.equal(note.checkIsBacklogHandled(0), true, 'Telegram answers at once when updates wait: this one did not');
  });

  it('a poll answered AFTER the hold with updates is judged by its batch, not by the hold', async () => {
    const { host, answer, clock } = createHost();
    const note = installFirstUpdateBatchNote(host, { getNowMs: () => clock.nowMs });
    const poll = host.callApi('getUpdates', { timeout: 50 });
    clock.nowMs += 2 * firstPollHoldMs;
    answer(0, [{ update_id: 1 }]);
    await poll;
    assert.equal(note.checkIsBacklogHandled(1), false, 'the answer brought an update the dispatcher still holds');
    assert.equal(note.checkIsBacklogHandled(0), true);
  });

  it('another method answered is no poll, and a poll that failed is no answer: the next poll starts its own hold', async () => {
    const { host, answer, fail, clock } = createHost();
    const note = installFirstUpdateBatchNote(host, { getNowMs: () => clock.nowMs });
    const send = host.callApi('sendMessage', { text: 'x' });
    clock.nowMs += 10 * firstPollHoldMs;
    assert.equal(note.checkIsBacklogHandled(0), false, 'a send that waits is no poll');
    answer(0, { message_id: 1 });
    await send;
    assert.equal(note.checkIsBacklogHandled(0), false);

    const failedPoll = host.callApi('getUpdates', {});
    clock.nowMs += 10 * firstPollHoldMs;
    fail(1, new Error('socket hang up'));
    await assert.rejects(failedPoll, /socket hang up/);
    assert.equal(note.checkIsBacklogHandled(0), false, 'the failed poll left no hold behind: updates may be waiting for the retry');
    void host.callApi('getUpdates', {});
    assert.equal(note.checkIsBacklogHandled(0), false, 'the retry holds from its own start');
    clock.nowMs += firstPollHoldMs;
    assert.equal(note.checkIsBacklogHandled(0), true);
  });

  it('passes the method, the payload and the options through and hands the answer back as it is', async () => {
    const calls: unknown[][] = [];
    const host: CallApiHost = { callApi: async (...args) => { calls.push(args); return true; } };
    installFirstUpdateBatchNote(host);
    assert.equal(await host.callApi('getUpdates', { offset: 5 }, { signal: 'x' }), true);
    assert.equal(await host.callApi('sendMessage', { text: 'x' }, { signal: 'y' }), true);
    assert.deepEqual(calls, [['getUpdates', { offset: 5 }, { signal: 'x' }], ['sendMessage', { text: 'x' }, { signal: 'y' }]]);
  });
});
