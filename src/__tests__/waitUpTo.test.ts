/**
 * `utils/waitUpTo.ts` — wait for a task, but never longer than a budget: the task keeps running when the budget
 * ends, its late failure is not an unhandled rejection, and the budget's timer never outlives the call.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { waitUpTo } from '../utils/waitUpTo';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('waitUpTo', () => {
  it('says true when the task finishes inside the budget', async () => {
    assert.equal(await waitUpTo(sleep(5), 500), true);
  });

  it('says false when the budget ends first, and the task goes on to finish by itself', async () => {
    let isFinished = false;
    const task = sleep(40).then(() => { isFinished = true; });
    assert.equal(await waitUpTo(task, 10), false);
    assert.equal(isFinished, false);
    await task;
    assert.equal(isFinished, true);
  });

  it('passes a failure inside the budget on to the caller', async () => {
    await assert.rejects(waitUpTo(Promise.reject(new Error('boom')), 500), /boom/);
  });

  it('does not turn a failure that comes after the budget into an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const lateFailure = sleep(30).then(() => { throw new Error('too late to matter'); });
      assert.equal(await waitUpTo(lateFailure, 5), false);
      await sleep(60);
      assert.deepEqual(unhandled, []);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
