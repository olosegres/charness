/**
 * @description `runners/pairingTiming.ts`: a pairing code works for ten minutes, a test seam may only shorten that (to at least five
 * seconds — sshd compares `expiry-time` in whole seconds), and the lifetime is worded in minutes or, for a test's, seconds.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatLifetime, pairingLifetimeMinMs, pairingLifetimeMs, readPairingLifetimeMs } from '../runners/pairingTiming';

function withTimings(value: unknown): NodeJS.ProcessEnv {
  return { CHARNESS_TEST_TIMINGS: JSON.stringify({ pairingLifetimeMs: value }) };
}

describe('pairing lifetime', () => {
  it('is ten minutes unless the test seam shortens it within bounds', () => {
    assert.equal(pairingLifetimeMs, 10 * 60 * 1000);
    assert.equal(readPairingLifetimeMs({}), pairingLifetimeMs);
    assert.equal(readPairingLifetimeMs(withTimings(5000)), 5000);
    assert.equal(readPairingLifetimeMs(withTimings(pairingLifetimeMinMs)), pairingLifetimeMinMs);
    for (const bad of [pairingLifetimeMinMs - 1, pairingLifetimeMs + 1, 2.5, 'long']) assert.equal(readPairingLifetimeMs(withTimings(bad)), pairingLifetimeMs, String(bad));
    assert.equal(readPairingLifetimeMs({ CHARNESS_TEST_TIMINGS: '{broken' }), pairingLifetimeMs);
  });

  it('is worded in minutes, and in seconds below a minute', () => {
    assert.equal(formatLifetime(pairingLifetimeMs), '10 minutes');
    assert.equal(formatLifetime(5000), '5 seconds');
  });
});
