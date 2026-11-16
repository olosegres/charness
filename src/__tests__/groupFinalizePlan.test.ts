/**
 * @description S2 — pure decision behind the GROUP output transport's
 * `finalizeInFlight` reconcile (`utils/groupFinalizePlan`). At a settle/teardown
 * boundary the bot must force-deliver the coalesced-but-unsent remainder (so the
 * agent's final answer is never discarded) but must NOT double-post a turn that
 * already fully landed.
 *
 * Load-bearing per `rules/tests.md`: the assertions prove the remainder
 * semantics (what text is sent, and its continuation flag), not just "no crash".
 * The group queue already separates landed (`lastMessageText`) from pending
 * (the pending segments), so the remainder IS the pending segments — these tests pin that a
 * pending buffer drains exactly once, segment by segment as it was queued, and a delivered turn is a no-op.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { getGroupFinalizePlan } from '../utils/groupFinalizePlan';
import type { PendingOutputSegment } from '../connectors/telegram/outputFlushPlan';

function createSegment(output: string, flags: Partial<Omit<PendingOutputSegment, 'output'>> = {}): PendingOutputSegment {
  return { output, isContinuation: false, startsNewMessage: false, ...flags };
}

test('fully-delivered turn (no pending remainder) → noop, no duplicate post', () => {
  assert.deepEqual(getGroupFinalizePlan({ pendingSegments: [] }), { action: 'noop' });
});

test('segments holding only whitespace → noop (a blank send would only earn a Telegram error)', () => {
  assert.deepEqual(getGroupFinalizePlan({ pendingSegments: [createSegment('   \n\t')] }), { action: 'noop' });
});

test('a turn whose last landed text lags → finalize sends exactly the pending remainder', () => {
  const segment = createSegment('the tail that never flushed', { isContinuation: true });
  assert.deepEqual(getGroupFinalizePlan({ pendingSegments: [segment] }), { action: 'send', segments: [segment] });
});

test('a fresh (non-continuation) remainder finalizes as a new message', () => {
  const segment = createSegment('the settled final answer');
  assert.deepEqual(getGroupFinalizePlan({ pendingSegments: [segment] }), { action: 'send', segments: [segment] });
});

test('text queued on both sides of a turn boundary drains as two segments, in order, each with its own mark', () => {
  const beforeBoundary = createSegment('the previous turn\'s tail', { isContinuation: true });
  const afterBoundary = createSegment('the next turn\'s first text', { isContinuation: true, startsNewMessage: true });
  assert.deepEqual(
    getGroupFinalizePlan({ pendingSegments: [beforeBoundary, createSegment('  '), afterBoundary] }),
    { action: 'send', segments: [beforeBoundary, afterBoundary] },
  );
});
