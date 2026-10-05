/**
 * @description Idle-watchdog decision for the `claude-json-stream` adapter's
 * `isBusy` flag (`utils/jsonStreamBusyWatchdog`). `isBusy` clears in exactly one
 * place — a processed terminal `result` — so a single missed `result` hangs the
 * native "typing…" indicator forever (live: an idle topic firing
 * `sendChatAction('typing')` every 4s for an hour+). The watchdog is the bounded
 * safety net.
 *
 * Load-bearing intent (per `.claude/rules/tests.md`): the watchdog fires ONLY on
 * genuine silence-with-nothing-in-flight, and EVERY in-flight signal (tool /
 * sub-agent / question / batched answer) vetoes it, so a legitimately long turn
 * (a long silent Bash, a long delegation, extended thinking, an unanswered
 * question) is never truncated. Silence — not wall-clock since turn start — is
 * the trigger.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  checkShouldClearBusyOnIdle,
  busyIdleWatchdogMs,
  getCompactionTimeoutOutcome,
  getCompactionWaitVerdict,
  compactionSilenceTimeoutMs,
  compactionAbsoluteTimeoutMs,
  type BusyIdleWatchdogInput,
} from '../utils/jsonStreamBusyWatchdog';

/** A busy, silent, nothing-in-flight session — the exact stuck-busy case. */
function stuck(overrides: Partial<BusyIdleWatchdogInput> = {}): BusyIdleWatchdogInput {
  return {
    isBusy: true,
    msSinceStdoutActivity: busyIdleWatchdogMs + 1,
    idleTimeoutMs: busyIdleWatchdogMs,
    outstandingToolCount: 0,
    subagentActive: false,
    hasPendingQuestion: false,
    hasUnflushedAnswer: false,
    ...overrides,
  };
}

test('fires: busy + silent past threshold + nothing in flight (the stuck-busy / missed-result case)', () => {
  assert.equal(checkShouldClearBusyOnIdle(stuck()), true);
});

test('does NOT fire while the session is not busy (nothing to clear)', () => {
  assert.equal(checkShouldClearBusyOnIdle(stuck({ isBusy: false })), false);
});

test('does NOT fire before the silence threshold (a brief inter-token gap)', () => {
  assert.equal(checkShouldClearBusyOnIdle(stuck({ msSinceStdoutActivity: busyIdleWatchdogMs - 1 })), false);
});

test('VETO: an outstanding tool (long silent Bash) keeps the turn alive', () => {
  assert.equal(checkShouldClearBusyOnIdle(stuck({ outstandingToolCount: 1 })), false);
});

test('VETO: an active sub-agent delegation keeps the turn alive', () => {
  assert.equal(checkShouldClearBusyOnIdle(stuck({ subagentActive: true })), false);
});

test('VETO: a pending user question keeps the turn alive (user just hasn\'t answered yet)', () => {
  assert.equal(checkShouldClearBusyOnIdle(stuck({ hasPendingQuestion: true })), false);
});

test('VETO: answer text still un-emitted in the batch is not "idle"', () => {
  assert.equal(checkShouldClearBusyOnIdle(stuck({ hasUnflushedAnswer: true })), false);
});

test('exactly at the threshold is treated as reached (>=)', () => {
  assert.equal(checkShouldClearBusyOnIdle(stuck({ msSinceStdoutActivity: busyIdleWatchdogMs })), true);
});

test('the default threshold is bounded well under the reported hour+ hang', () => {
  assert.ok(busyIdleWatchdogMs >= 30_000 && busyIdleWatchdogMs <= 5 * 60_000, `unexpected threshold: ${busyIdleWatchdogMs}`);
});

// ─── compaction wait (same silence signal, different consumer) ──────────────

/**
 * The bug these cover: the compaction wait used to cap TOTAL elapsed time at
 * 3 minutes, so a real 3 min 15.6 s compaction (measured:
 * `compact_metadata.duration_ms: 195649`) was declared failed while the CLI was
 * succeeding — and the idle-compaction notice was never posted. That is the
 * operator's "it compacts but never says so". Load-bearing intent: a compaction
 * that is still heartbeating is NEVER cut off by elapsed time alone.
 */
function waiting(overrides: Partial<Parameters<typeof getCompactionWaitVerdict>[0]> = {}) {
  return {
    msSinceStdoutActivity: 1_000,
    msSinceCompactionStarted: 10_000,
    silenceTimeoutMs: compactionSilenceTimeoutMs,
    absoluteTimeoutMs: compactionAbsoluteTimeoutMs,
    ...overrides,
  };
}

test('compaction wait: THE regression — a 195.6s compaction that keeps heartbeating is still waited for', () => {
  // The exact measured case, against the old 180s cap it lost to.
  const measuredDurationMs = 195_649;
  assert.equal(
    getCompactionWaitVerdict(waiting({ msSinceCompactionStarted: measuredDurationMs, msSinceStdoutActivity: 3_000 })),
    'keepWaiting',
  );
});

test('compaction wait: silence past the threshold means the process is gone', () => {
  assert.equal(
    getCompactionWaitVerdict(waiting({ msSinceStdoutActivity: compactionSilenceTimeoutMs })),
    'timedOutSilent',
  );
});

test('compaction wait: a CLI that talks forever without finishing still hits the absolute backstop', () => {
  assert.equal(
    getCompactionWaitVerdict(waiting({ msSinceStdoutActivity: 500, msSinceCompactionStarted: compactionAbsoluteTimeoutMs })),
    'timedOutTotal',
  );
});

test('compaction wait: silence wins over the backstop when both are exceeded', () => {
  // Reporting "still talking but never finished" for a dead process would be a lie.
  assert.equal(
    getCompactionWaitVerdict(waiting({
      msSinceStdoutActivity: compactionSilenceTimeoutMs + 1,
      msSinceCompactionStarted: compactionAbsoluteTimeoutMs + 1,
    })),
    'timedOutSilent',
  );
});

test('compaction wait: the backstop is far above any plausible compaction, the silence bound far below it', () => {
  assert.ok(compactionAbsoluteTimeoutMs >= 10 * 60_000, `backstop too tight: ${compactionAbsoluteTimeoutMs}`);
  assert.ok(
    compactionSilenceTimeoutMs < compactionAbsoluteTimeoutMs,
    'silence must be the bound that normally decides, not the backstop',
  );
});

test('compaction timeout: a compaction that already reported success is reported as SUCCESS, not failure', () => {
  // `compact_status success` arrived and only the token-count frame never did.
  // Calling that a failure would suppress the notice over an ALREADY-compacted
  // session — the exact silence this change removes.
  assert.deepEqual(
    getCompactionTimeoutOutcome({ verdict: 'timedOutSilent', sawSuccess: true }),
    { kind: 'succeededWithoutTokenCounts' },
  );
  assert.deepEqual(
    getCompactionTimeoutOutcome({ verdict: 'timedOutTotal', sawSuccess: true }),
    { kind: 'succeededWithoutTokenCounts' },
  );
});

test('compaction timeout: with no success signal, the verdict decides which failure is reported', () => {
  assert.deepEqual(
    getCompactionTimeoutOutcome({ verdict: 'timedOutSilent', sawSuccess: false }),
    { kind: 'failed', reason: 'silent' },
  );
  assert.deepEqual(
    getCompactionTimeoutOutcome({ verdict: 'timedOutTotal', sawSuccess: false }),
    { kind: 'failed', reason: 'total' },
  );
});
