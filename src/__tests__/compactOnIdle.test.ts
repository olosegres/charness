/**
 * @description Unit coverage for the pure compact-on-idle helpers (F2):
 * enable resolution (per-thread override vs default-on), the idle-fire guard,
 * and the sentinel-based closing-section extractor. These are the branch-level
 * decisions the bot's idle watchdog + notice rely on.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  idleCompactMs,
  getIdleCompactionArmDecision,
  compactIdleOverdueMinDelayMs,
  compactIdleOverdueSpreadMs,
  resolveCompactOnIdleEnabled,
  checkShouldFireIdleCompaction,
  checkIsBusyForRealTurn,
  buildCompactionInstruction,
  compactionSummaryGuidance,
  extractCompactionClosingSection,
  formatTokenCount,
  compactionClosingStartMarker,
  compactionClosingEndMarker,
} from '../utils/compactOnIdle';

/** The all-conditions-met base for the idle-fire guard (D1/D2). */
const fireBase = {
  isEnabled: true,
  isSessionActive: true,
  isBusyForRealTurn: false,
  isLatched: false,
  hasCompletedTurnSinceCompaction: true,
} as const;

test('idleCompactMs is 55 minutes', () => {
  assert.equal(idleCompactMs, 55 * 60 * 1000);
});

// ── getIdleCompactionArmDecision (the restart-safe countdown) ──

/** Placeholder thread keys (the repo is public — never a real chat/topic id). */
const threadKeyA = '-1001111111111:57';
const threadKeyB = '-1001111111111:218';
const now = 1_800_000_000_000;

/** 3h idle — comfortably past the 55-min window, i.e. overdue. */
const overdueLastActivityAt = now - 3 * 60 * 60 * 1000;

test('getIdleCompactionArmDecision: no persisted history → the full idle window', () => {
  // A fresh session, or a state file written before the tracking existed: behave
  // exactly as the pre-persistence code did.
  assert.deepEqual(
    getIdleCompactionArmDecision({ threadKeyString: threadKeyA, lastActivityAt: 0, now }),
    { delayMs: idleCompactMs, kind: 'fullWindow' },
  );
});

test('getIdleCompactionArmDecision: a restart mid-window arms the REMAINDER, not a fresh 55 min', () => {
  // THE reported bug: the bot hot-reloads on every code change, and re-arming a
  // flat `idleCompactMs` on every re-adopt meant no topic ever reached the
  // threshold. 40 minutes elapsed ⇒ 15 minutes left.
  const fortyMinutesMs = 40 * 60 * 1000;
  const decision = getIdleCompactionArmDecision({
    threadKeyString: threadKeyA,
    lastActivityAt: now - fortyMinutesMs,
    now,
  });
  assert.deepEqual(decision, { delayMs: 15 * 60 * 1000, kind: 'remainder' });
  assert.notEqual(decision.delayMs, idleCompactMs, 'a restart must not restart the countdown');
});

test('getIdleCompactionArmDecision: a future lastActivityAt is clamped to the full window', () => {
  // A backward wall-clock step (an NTP correction on a VPS) future-dates the stamp.
  // Unclamped the thread would wait the whole window PLUS the skew, and a skew over
  // ~24.8 days overflows `setTimeout` — which fires IMMEDIATELY with a
  // `TimeoutOverflowWarning`, i.e. the opposite of waiting.
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  assert.deepEqual(
    getIdleCompactionArmDecision({ threadKeyString: threadKeyA, lastActivityAt: now + thirtyDaysMs, now }),
    { delayMs: idleCompactMs, kind: 'remainder' },
  );
  // A one-second skew is clamped by the same rule, not special-cased.
  assert.deepEqual(
    getIdleCompactionArmDecision({ threadKeyString: threadKeyA, lastActivityAt: now + 1_000, now }),
    { delayMs: idleCompactMs, kind: 'remainder' },
  );
});

test('getIdleCompactionArmDecision: an overdue thread arms inside the stagger band', () => {
  // Idle across one or more restarts (3h > 55min): fire soon, but never instantly
  // at boot and never in lockstep with every other overdue topic.
  const { delayMs, kind } = getIdleCompactionArmDecision({
    threadKeyString: threadKeyA,
    lastActivityAt: overdueLastActivityAt,
    now,
  });
  assert.equal(kind, 'overdue');
  assert.ok(delayMs >= compactIdleOverdueMinDelayMs, 'never fires instantly at boot');
  assert.ok(delayMs < compactIdleOverdueMinDelayMs + compactIdleOverdueSpreadMs, 'stays inside the spread');
});

test('getIdleCompactionArmDecision: the reported kind matches the branch the delay came from', () => {
  // The kind is part of the contract, not a hint: the diagnostic log prints what it
  // is GIVEN, so a kind that disagreed with its own delay would make the log lie.
  const full = getIdleCompactionArmDecision({ threadKeyString: threadKeyA, lastActivityAt: 0, now });
  assert.equal(full.kind, 'fullWindow');
  assert.equal(full.delayMs, idleCompactMs);

  const remainder = getIdleCompactionArmDecision({
    threadKeyString: threadKeyA,
    lastActivityAt: now - 1_000,
    now,
  });
  assert.equal(remainder.kind, 'remainder');
  assert.ok(remainder.delayMs > 0 && remainder.delayMs < idleCompactMs);

  const overdue = getIdleCompactionArmDecision({
    threadKeyString: threadKeyA,
    lastActivityAt: overdueLastActivityAt,
    now,
  });
  assert.equal(overdue.kind, 'overdue');
  assert.ok(overdue.delayMs < idleCompactMs, 'an overdue arm is short, never a fresh window');
});

test('getIdleCompactionArmDecision: the overdue stagger is deterministic per thread', () => {
  // Deterministic in the key — which is what makes it testable and what lets two
  // processes agree without coordinating.
  const first = getIdleCompactionArmDecision({
    threadKeyString: threadKeyA,
    lastActivityAt: overdueLastActivityAt,
    now,
  });
  const second = getIdleCompactionArmDecision({
    threadKeyString: threadKeyA,
    lastActivityAt: overdueLastActivityAt,
    now,
  });
  assert.deepEqual(first, second);
});

test('getIdleCompactionArmDecision: overdue threads are spread, not bunched', () => {
  // The point of the stagger: the boot reattach adopts every live session at once,
  // so a shared delay would start every compaction turn in the same instant.
  const keys = [threadKeyA, threadKeyB, '-1001111111111:1487', '-1001111111111:1', '-1002222222222:57'];
  const delays = keys.map(
    (threadKeyString) =>
      getIdleCompactionArmDecision({ threadKeyString, lastActivityAt: overdueLastActivityAt, now }).delayMs,
  );
  assert.equal(new Set(delays).size, keys.length, 'each thread gets its own offset');
});

test('getIdleCompactionArmDecision: exactly at the threshold counts as overdue', () => {
  // The boundary must not arm a zero-delay timer that fires during reattach — and
  // the reported kind must name that same branch.
  const { delayMs, kind } = getIdleCompactionArmDecision({
    threadKeyString: threadKeyA,
    lastActivityAt: now - idleCompactMs,
    now,
  });
  assert.equal(kind, 'overdue');
  assert.ok(delayMs >= compactIdleOverdueMinDelayMs);
});

test('resolveCompactOnIdleEnabled: default is ON when nothing is set', () => {
  assert.equal(resolveCompactOnIdleEnabled(undefined, undefined), true);
});

test('resolveCompactOnIdleEnabled: an explicit global default false is honored', () => {
  assert.equal(resolveCompactOnIdleEnabled(false, undefined), false);
  assert.equal(resolveCompactOnIdleEnabled(true, undefined), true);
});

test('resolveCompactOnIdleEnabled: a per-thread override always wins over the default', () => {
  assert.equal(resolveCompactOnIdleEnabled(true, false), false);
  assert.equal(resolveCompactOnIdleEnabled(false, true), true);
});

test('checkShouldFireIdleCompaction: fires only when enabled+active+idle+unlatched+has-turn', () => {
  assert.equal(checkShouldFireIdleCompaction({ ...fireBase }), true);
});

test('checkShouldFireIdleCompaction: every negated condition blocks the fire', () => {
  assert.equal(checkShouldFireIdleCompaction({ ...fireBase, isEnabled: false }), false);
  assert.equal(checkShouldFireIdleCompaction({ ...fireBase, isSessionActive: false }), false);
  assert.equal(
    checkShouldFireIdleCompaction({ ...fireBase, isBusyForRealTurn: true }),
    false,
    'a session running a real turn is never compacted',
  );
  assert.equal(
    checkShouldFireIdleCompaction({ ...fireBase, isLatched: true }),
    false,
    'D2: a spent latch fires at most once per user-active period',
  );
  assert.equal(
    checkShouldFireIdleCompaction({ ...fireBase, hasCompletedTurnSinceCompaction: false }),
    false,
    'nothing to compress → skip',
  );
});

test('checkIsBusyForRealTurn: a pending question is NOT a real-turn busy (D1 fires)', () => {
  // The whole D1 pivot: a question-blocked (idle-waiting) session reports busy,
  // but that must NOT block idle compaction — only a genuinely running turn does.
  assert.equal(checkIsBusyForRealTurn({ isBusy: true, hasPendingQuestion: true }), false);
  assert.equal(checkIsBusyForRealTurn({ isBusy: true, hasPendingQuestion: false }), true);
  assert.equal(checkIsBusyForRealTurn({ isBusy: false, hasPendingQuestion: true }), false);
  assert.equal(checkIsBusyForRealTurn({ isBusy: false, hasPendingQuestion: false }), false);
});

test('checkShouldFireIdleCompaction: a pending question at idle still fires (D1)', () => {
  // A question pending → checkIsBusyForRealTurn is false → the guard fires so the
  // watchdog can reject + compact + re-ask.
  const isBusyForRealTurn = checkIsBusyForRealTurn({ isBusy: true, hasPendingQuestion: true });
  assert.equal(checkShouldFireIdleCompaction({ ...fireBase, isBusyForRealTurn }), true);
});

test('buildCompactionInstruction: Claude backends get the D3 summary guidance appended', () => {
  const closing = 'CLOSING';
  const claude = buildCompactionInstruction({
    bakesSummaryGuidance: false,
    summaryGuidance: compactionSummaryGuidance,
    closingSectionInstruction: closing,
  });
  assert.ok(claude);
  assert.ok(claude.includes(compactionSummaryGuidance), 'D3 guidance rides the Claude instruction');
  assert.ok(claude.includes(closing), 'closing section is appended too');
  assert.ok(claude.indexOf(compactionSummaryGuidance) < claude.indexOf(closing), 'guidance before closing');
});

test('buildCompactionInstruction: OpenCode omits the guidance (baked in fork)', () => {
  // OpenCode bakes D3 into its fork prompt, so re-sending it would duplicate the
  // text. A plain manual /compact (no closing) resolves to undefined → byte-identical.
  assert.equal(
    buildCompactionInstruction({
      bakesSummaryGuidance: true,
      summaryGuidance: compactionSummaryGuidance,
      closingSectionInstruction: undefined,
    }),
    undefined,
  );
  const withClosing = buildCompactionInstruction({
    bakesSummaryGuidance: true,
    summaryGuidance: compactionSummaryGuidance,
    closingSectionInstruction: 'CLOSING',
  });
  assert.equal(withClosing, 'CLOSING', 'OpenCode gets only the closing section');
});

test('buildCompactionInstruction: nothing to append → undefined', () => {
  assert.equal(
    buildCompactionInstruction({
      bakesSummaryGuidance: true,
      summaryGuidance: compactionSummaryGuidance,
      closingSectionInstruction: '   ',
    }),
    undefined,
    'whitespace-only closing is ignored',
  );
});

test('compactionSummaryGuidance: is maximally-complete + session-specific (D3)', () => {
  assert.match(compactionSummaryGuidance, /MAXIMALLY COMPLETE/);
  assert.match(compactionSummaryGuidance, /SESSION-SPECIFIC/);
  assert.match(compactionSummaryGuidance, /CLAUDE\.md \/ AGENTS\.md/);
});

test('extractCompactionClosingSection: pulls the text between the sentinel markers', () => {
  const summary = [
    '## Objective',
    '- do the thing',
    '',
    compactionClosingStartMarker,
    'We were fixing the login bug; next: run the e2e suite.',
    'Pending question: proceed? Options: yes / no.',
    compactionClosingEndMarker,
    'Continue the conversation from where it left off.',
  ].join('\n');
  const closing = extractCompactionClosingSection(summary);
  assert.ok(closing);
  assert.ok(closing.includes('login bug'));
  assert.ok(closing.includes('yes / no'));
  // Trailing boilerplate after the end marker must be excluded.
  assert.ok(!closing.includes('Continue the conversation'));
  // The markers themselves are stripped.
  assert.ok(!closing.includes(compactionClosingStartMarker));
  assert.ok(!closing.includes(compactionClosingEndMarker));
});

test('extractCompactionClosingSection: no start marker → null (notice omits the block)', () => {
  assert.equal(extractCompactionClosingSection('## Objective\n- do the thing'), null);
  assert.equal(extractCompactionClosingSection(''), null);
});

test('extractCompactionClosingSection: missing end marker → to end of text', () => {
  const summary = `intro\n${compactionClosingStartMarker}\nwhere we stopped: mid-refactor.`;
  assert.equal(extractCompactionClosingSection(summary), 'where we stopped: mid-refactor.');
});

test('extractCompactionClosingSection: an empty section → null (never a bare block)', () => {
  const summary = `${compactionClosingStartMarker}\n   \n${compactionClosingEndMarker}`;
  assert.equal(extractCompactionClosingSection(summary), null);
});

// ── formatTokenCount (the completion message's numbers) ──

test('formatTokenCount groups digits in threes with ONE locale-independent separator', () => {
  // The separator must NOT be a comma or a period: both are DECIMAL separators in
  // some of the bot's 12 locales, so `314,150` would read as `314.15` in a German
  // topic. A narrow no-break space is unambiguous in all of them.
  const formatted = formatTokenCount(314150);
  assert.equal(formatted, '314\u202F150');
  assert.ok(!formatted.includes(','), 'a comma reads as a decimal point in several locales');
  assert.ok(!formatted.includes('.'), 'a period reads as a decimal point in several locales');
  assert.equal(formatTokenCount(12883), '12\u202F883');
  assert.equal(formatTokenCount(1234567), '1\u202F234\u202F567');
});

test('formatTokenCount leaves a short count untouched — no leading separator', () => {
  // The `\\B` boundary is what stops a separator landing before the first digit;
  // a plain "every 3 chars" split would emit ",123".
  assert.equal(formatTokenCount(0), '0');
  assert.equal(formatTokenCount(7), '7');
  assert.equal(formatTokenCount(999), '999');
  assert.equal(formatTokenCount(1000), '1\u202F000');
});
