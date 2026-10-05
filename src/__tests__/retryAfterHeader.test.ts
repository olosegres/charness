/**
 * @description The shared `Retry-After` header reading behind the Jira client
 * and the voice transcription retry: delay-seconds or an HTTP date, never a
 * negative wait, `null` when there is nothing usable.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getRetryAfterHeaderMs } from '../utils/retryAfterHeader';

describe('getRetryAfterHeaderMs', () => {
  const nowMs = Date.parse('2026-10-02T12:00:00Z');

  it('reads delay-seconds (fractions too) and an HTTP date; a past date waits 0', () => {
    assert.equal(getRetryAfterHeaderMs('5', nowMs), 5_000);
    assert.equal(getRetryAfterHeaderMs('1.5', nowMs), 1_500);
    assert.equal(getRetryAfterHeaderMs('Fri, 02 Oct 2026 12:00:30 GMT', nowMs), 30_000);
    assert.equal(getRetryAfterHeaderMs('Fri, 02 Oct 2026 11:00:00 GMT', nowMs), 0);
    assert.equal(getRetryAfterHeaderMs('-3', nowMs), 0);
  });

  it('absent, blank or unreadable → null (the caller falls back to its backoff)', () => {
    for (const headerValue of [null, undefined, '', '  ', 'soon']) {
      assert.equal(getRetryAfterHeaderMs(headerValue, nowMs), null, `${headerValue}`);
    }
  });
});
