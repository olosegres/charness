/**
 * @description The note of the first answered long poll (`connectors/telegram/firstUpdateBatchNote.ts`): false until a `getUpdates` call
 * has been ANSWERED — an empty batch counts, a call still waiting or one that failed does not, and every other method is no poll — and
 * every call and answer passes through unchanged.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CallApiHost } from '../outputTrace';
import { installFirstUpdateBatchNote } from '../connectors/telegram/firstUpdateBatchNote';

/** A host whose answers the test releases one by one. */
function createHost(): { host: CallApiHost; calls: string[]; answer: (index: number, result: object | boolean) => void; fail: (index: number, error: Error) => void } {
  const calls: string[] = [];
  const pending: Array<{ resolve: (result: object | boolean) => void; reject: (error: Error) => void }> = [];
  const host: CallApiHost = {
    callApi: (method) => {
      calls.push(method);
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
  };
  return { host, calls, answer: (index, result) => pending[index].resolve(result), fail: (index, error) => pending[index].reject(error) };
}

describe('installFirstUpdateBatchNote', () => {
  it('is false until a getUpdates call has been answered, and true after an empty batch too', async () => {
    const { host, answer } = createHost();
    const note = installFirstUpdateBatchNote(host);
    assert.equal(note.checkIsFirstBatchFetched(), false);
    const poll = host.callApi('getUpdates', { timeout: 50 });
    assert.equal(note.checkIsFirstBatchFetched(), false, 'the poll is still waiting');
    answer(0, []);
    assert.deepEqual(await poll, []);
    assert.equal(note.checkIsFirstBatchFetched(), true);
  });

  it('another method answered is no poll, and a poll that failed is not an answer', async () => {
    const { host, answer, fail } = createHost();
    const note = installFirstUpdateBatchNote(host);
    const send = host.callApi('sendMessage', { text: 'x' });
    answer(0, { message_id: 1 });
    await send;
    assert.equal(note.checkIsFirstBatchFetched(), false);
    const failedPoll = host.callApi('getUpdates', {});
    fail(1, new Error('socket hang up'));
    await assert.rejects(failedPoll, /socket hang up/);
    assert.equal(note.checkIsFirstBatchFetched(), false);
  });

  it('passes the method, the payload and the options through and hands the answer back as it is', async () => {
    const calls: unknown[][] = [];
    const host: CallApiHost = { callApi: async (...args) => { calls.push(args); return true; } };
    installFirstUpdateBatchNote(host);
    assert.equal(await host.callApi('getUpdates', { offset: 5 }, { signal: 'x' }), true);
    assert.deepEqual(calls, [['getUpdates', { offset: 5 }, { signal: 'x' }]]);
  });
});
