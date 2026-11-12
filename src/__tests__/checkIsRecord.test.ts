/**
 * @description `utils/checkIsRecord.ts`: the parse-boundary guard for data the bot does not control. A plain object is the only
 * thing that passes — `null` and an array are objects to `typeof` and would let a malformed payload through.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkIsRecord } from '../utils/checkIsRecord';

describe('checkIsRecord', () => {
  it('accepts a plain object, empty or not', () => {
    assert.equal(checkIsRecord({}), true);
    assert.equal(checkIsRecord({ name: 'server' }), true);
  });

  it('rejects null and an array although `typeof` calls both an object', () => {
    assert.equal(checkIsRecord(null), false);
    assert.equal(checkIsRecord([]), false);
    assert.equal(checkIsRecord([{ name: 'server' }]), false);
  });

  it('rejects every primitive and a missing value', () => {
    for (const value of ['server', 3, true, undefined]) assert.equal(checkIsRecord(value), false, `${typeof value}`);
  });
});
