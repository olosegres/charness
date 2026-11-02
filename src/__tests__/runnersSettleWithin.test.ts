/**
 * @description `settleWithin` of the hub test kit: it gives the promise's own result (or failure) when that comes first, fails with the
 * description when the time is up first, and in every case leaves no timer behind — a leftover 10-second timer kept every test file that
 * used the plain `Promise.race` form alive for 10 seconds after its last test.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { settleWithin } from './runnersTestKit';

const longTimeoutMs = 60_000;
const shortTimeoutMs = 30;

function countActiveTimers(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;
}

describe('settleWithin', () => {
  it('gives the result of a promise that settles in time, and clears its timer at once', async () => {
    const before = countActiveTimers();
    assert.equal(await settleWithin(Promise.resolve('done'), 'the promise', longTimeoutMs), 'done');
    assert.equal(countActiveTimers(), before, 'no timer is left running for the rest of the long timeout');
  });

  it('passes on the failure of a promise that fails in time, and clears its timer too', async () => {
    const before = countActiveTimers();
    await assert.rejects(settleWithin(Promise.reject(new Error('its own failure')), 'the promise', longTimeoutMs), /its own failure/);
    assert.equal(countActiveTimers(), before);
  });

  it('fails with the description when the time is up first', async () => {
    const never = new Promise<void>(() => undefined);
    await assert.rejects(settleWithin(never, 'a thing that never happens', shortTimeoutMs), /timed out: a thing that never happens/);
  });
});
