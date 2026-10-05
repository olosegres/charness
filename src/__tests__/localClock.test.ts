/**
 * @description The instance-local clock of bot notices (`utils/localClock.ts`):
 * a usage-limit reset on another day names its date.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatLocalClock, formatLocalClockWithDateIfNotToday } from '../utils/localClock';

const nowMs = new Date(2026, 9, 2, 20, 15).getTime();

describe('formatLocalClock', () => {
  it('renders HH:MM with leading zeros', () => {
    assert.equal(formatLocalClock(new Date(2026, 9, 2, 7, 5).getTime()), '07:05');
  });
});

describe('formatLocalClockWithDateIfNotToday', () => {
  it('a time later today is the clock alone', () => {
    assert.equal(formatLocalClockWithDateIfNotToday(new Date(2026, 9, 2, 23, 59).getTime(), nowMs), '23:59');
  });

  it('a time on another day carries its date — tomorrow included', () => {
    assert.equal(formatLocalClockWithDateIfNotToday(new Date(2026, 9, 3, 0, 10).getTime(), nowMs), '2026-10-03 00:10');
    assert.equal(formatLocalClockWithDateIfNotToday(new Date(2026, 9, 9, 22, 50).getTime(), nowMs), '2026-10-09 22:50');
  });
});
