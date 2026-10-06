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
  getAgentIdleMs,
  getIdleFireDecision,
  checkIsBusyForRealTurn,
  checkIsWorkingAtIdle,
  buildCompactionInstruction,
  compactionSummaryGuidance,
  compactionSkillsGuidance,
  stripCompactionClosingMarkers,
  checkShouldPostCompactionSummary,
  checkShouldAnnounceCompactionStart,
  buildIdleCompactionNoticeParts,
  formatTokenCount,
  compactionClosingStartMarker,
  compactionClosingEndMarker,
} from '../utils/compactOnIdle';

/** The all-conditions-met base for the idle-fire decision (D1/D2, L3): compact AND stop. */
type IdleFireInput = Parameters<typeof getIdleFireDecision>[0];

const fireBase = {
  isSessionActive: true,
  isWorking: false,
  isEnabled: true,
  isLatched: false,
  hasCompletedTurnSinceCompaction: true,
  isLimitWaitArmed: false,
  canSuspend: true,
} as const;

test('idleCompactMs is 55 minutes', () => {
  assert.equal(idleCompactMs, 55 * 60 * 1000);
});

// ── getIdleCompactionArmDecision (the restart-safe countdown) ──

/** Placeholder thread keys (the repo is public — never a real chat/topic id). */
const threadKeyA = '-1001111111111:57';
const threadKeyB = '-1001111111111:234';
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
  const keys = [threadKeyA, threadKeyB, '-1001111111111:2345', '-1001111111111:1', '-1002222222222:57'];
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

test('getAgentIdleMs: the default window, or the AGENT_IDLE_MINUTES override (L-D9); junk keeps the default', () => {
  assert.equal(getAgentIdleMs(undefined), idleCompactMs);
  assert.equal(getAgentIdleMs(''), idleCompactMs);
  assert.equal(getAgentIdleMs('1'), 60 * 1000);
  assert.equal(getAgentIdleMs('0.5'), 30 * 1000);
  assert.equal(getAgentIdleMs('0'), idleCompactMs);
  assert.equal(getAgentIdleMs('-3'), idleCompactMs);
  assert.equal(getAgentIdleMs('soon'), idleCompactMs);
});

test('getIdleCompactionArmDecision: the override window is the one armed and the one the remainder is measured against', () => {
  const idleWindowMs = 60 * 1000;
  assert.deepEqual(getIdleCompactionArmDecision({ threadKeyString: threadKeyA, lastActivityAt: 0, now, idleWindowMs }), { delayMs: idleWindowMs, kind: 'fullWindow' });
  assert.deepEqual(getIdleCompactionArmDecision({ threadKeyString: threadKeyA, lastActivityAt: now - 20_000, now, idleWindowMs }), { delayMs: 40_000, kind: 'remainder' });
  assert.equal(getIdleCompactionArmDecision({ threadKeyString: threadKeyA, lastActivityAt: now - 90_000, now, idleWindowMs }).kind, 'overdue');
});

test('getIdleFireDecision: idle, enabled, unlatched, with a turn to compress, no limit wait → compact AND stop (L-D1)', () => {
  assert.deepEqual(getIdleFireDecision({ ...fireBase }), { shouldCompact: true, compactionSkipReasons: [], shouldSuspend: true, suspendSkipReasons: [] });
});

test('getIdleFireDecision: no session or WORKING (L-D2) → nothing happens, neither compaction nor stop', () => {
  for (const input of [{ ...fireBase, isSessionActive: false }, { ...fireBase, isWorking: true }]) {
    const decision = getIdleFireDecision(input);
    assert.equal(decision.shouldCompact, false);
    assert.equal(decision.shouldSuspend, false, 'a working process is never stopped');
    assert.deepEqual(decision.suspendSkipReasons, decision.compactionSkipReasons);
  }
  assert.deepEqual(getIdleFireDecision({ ...fireBase, isWorking: true }).suspendSkipReasons, ['working']);
});

test('getIdleFireDecision: each compaction guard skips the compaction but the stop still happens (L-D1, L-D6)', () => {
  const cases: Array<[Partial<IdleFireInput>, string]> = [
    [{ isEnabled: false }, 'disabled'],
    [{ isLatched: true }, 'latched (D2)'],
    [{ hasCompletedTurnSinceCompaction: false }, 'nothing to compress'],
    [{ isLimitWaitArmed: true }, 'a usage-limit wait is armed (L-D6)'],
  ];
  for (const [override, reason] of cases) {
    const decision = getIdleFireDecision({ ...fireBase, ...override });
    assert.equal(decision.shouldCompact, false, reason);
    assert.deepEqual(decision.compactionSkipReasons, [reason]);
    assert.equal(decision.shouldSuspend, true, `${reason}: the stop happens regardless`);
  }
});

test('getIdleFireDecision: a backend that cannot be suspended keeps its process (L-D8) — the compaction alone', () => {
  const decision = getIdleFireDecision({ ...fireBase, canSuspend: false });
  assert.equal(decision.shouldCompact, true);
  assert.equal(decision.shouldSuspend, false);
  assert.deepEqual(decision.suspendSkipReasons, ['the backend is not suspended']);
});

test('checkIsBusyForRealTurn: a pending question is NOT a real-turn busy (D1 fires)', () => {
  // The whole D1 pivot: a question-blocked (idle-waiting) session reports busy,
  // but that must NOT block idle compaction — only a genuinely running turn does.
  assert.equal(checkIsBusyForRealTurn({ isBusy: true, hasPendingQuestion: true }), false);
  assert.equal(checkIsBusyForRealTurn({ isBusy: true, hasPendingQuestion: false }), true);
  assert.equal(checkIsBusyForRealTurn({ isBusy: false, hasPendingQuestion: true }), false);
  assert.equal(checkIsBusyForRealTurn({ isBusy: false, hasPendingQuestion: false }), false);
});

test('checkIsWorkingAtIdle: a pending question excuses the turn alone — over a background task the process is working (L-D2)', () => {
  // The L3 review case: question pending AND a background task running. The old probe masked the
  // whole adapter "working" reading behind the question and would compact, re-ask, then stop — killing the task.
  assert.equal(checkIsWorkingAtIdle({ isBusy: true, hasPendingQuestion: true, hasBackgroundWork: true }), true);
  assert.equal(checkIsWorkingAtIdle({ isBusy: true, hasPendingQuestion: true, hasBackgroundWork: false }), false, 'the question alone: idle-waiting (D1 fires)');
  assert.equal(checkIsWorkingAtIdle({ isBusy: true, hasPendingQuestion: false, hasBackgroundWork: false }), true, 'a real turn');
  assert.equal(checkIsWorkingAtIdle({ isBusy: false, hasPendingQuestion: false, hasBackgroundWork: true }), true, 'a background task between turns');
  assert.equal(checkIsWorkingAtIdle({ isBusy: false, hasPendingQuestion: false, hasBackgroundWork: false }), false);
  const decision = getIdleFireDecision({ ...fireBase, isWorking: checkIsWorkingAtIdle({ isBusy: true, hasPendingQuestion: true, hasBackgroundWork: true }) });
  assert.equal(decision.shouldCompact, false);
  assert.equal(decision.shouldSuspend, false, 'never stopped: the stop would kill the task');
});

test('a pending question at idle still fires (D1): it is not "working"', () => {
  // A question pending → checkIsBusyForRealTurn is false → the decision fires so the
  // watchdog can reject + compact + re-ask.
  const isWorking = checkIsBusyForRealTurn({ isBusy: true, hasPendingQuestion: true });
  assert.equal(getIdleFireDecision({ ...fireBase, isWorking }).shouldCompact, true);
});

test('buildCompactionInstruction: Claude backends get the D3 + skills guidance, closing last', () => {
  const closing = 'CLOSING';
  const claude = buildCompactionInstruction({
    bakesSummaryGuidance: false,
    summaryGuidance: compactionSummaryGuidance,
    bakesSkillsGuidance: false,
    skillsGuidance: compactionSkillsGuidance,
    closingSectionInstruction: closing,
  });
  assert.ok(claude);
  assert.ok(claude.includes(compactionSummaryGuidance), 'D3 guidance rides the Claude instruction');
  assert.ok(claude.includes(compactionSkillsGuidance), 'skills guidance rides the Claude instruction');
  assert.ok(claude.includes(closing), 'closing section is appended too');
  assert.ok(
    claude.indexOf(compactionSummaryGuidance) < claude.indexOf(compactionSkillsGuidance),
    'D3 guidance before skills guidance',
  );
  // The closing directive says "write nothing after the end marker", so it must
  // be the last instruction the model reads.
  assert.ok(claude.indexOf(compactionSkillsGuidance) < claude.indexOf(closing), 'closing comes last');
});

test('buildCompactionInstruction: OpenCode omits the baked D3 guidance but still gets the skills guidance', () => {
  // OpenCode bakes D3 into its fork prompt, so re-sending it would duplicate the
  // text. The skills guidance is baked nowhere, so even a plain manual /compact
  // (no closing) carries it.
  assert.equal(
    buildCompactionInstruction({
      bakesSummaryGuidance: true,
      summaryGuidance: compactionSummaryGuidance,
      bakesSkillsGuidance: false,
      skillsGuidance: compactionSkillsGuidance,
      closingSectionInstruction: undefined,
    }),
    compactionSkillsGuidance,
  );
  const withClosing = buildCompactionInstruction({
    bakesSummaryGuidance: true,
    summaryGuidance: compactionSummaryGuidance,
    bakesSkillsGuidance: false,
    skillsGuidance: compactionSkillsGuidance,
    closingSectionInstruction: 'CLOSING',
  });
  assert.equal(withClosing, `${compactionSkillsGuidance}\n\nCLOSING`, 'skills guidance, then the closing section');
});

test('buildCompactionInstruction: an OpenCode server with the compaction plugin gets neither guidance', () => {
  // The plugin adds the skills guidance to every compaction prompt and cannot see
  // this instruction, so sending it here as well would duplicate it.
  const base = {
    bakesSummaryGuidance: true,
    summaryGuidance: compactionSummaryGuidance,
    bakesSkillsGuidance: true,
    skillsGuidance: compactionSkillsGuidance,
  };
  assert.equal(buildCompactionInstruction({ ...base, closingSectionInstruction: 'CLOSING' }), 'CLOSING');
  assert.equal(buildCompactionInstruction(base), undefined);
});

test('buildCompactionInstruction: nothing to append → undefined', () => {
  assert.equal(
    buildCompactionInstruction({
      bakesSummaryGuidance: true,
      summaryGuidance: compactionSummaryGuidance,
      bakesSkillsGuidance: false,
      skillsGuidance: '  ',
      closingSectionInstruction: '   ',
    }),
    undefined,
    'whitespace-only skills guidance and closing are ignored',
  );
});

test('compactionSkillsGuidance: names the loaded skills and says to load them again', () => {
  assert.match(compactionSkillsGuidance, /skill/);
  assert.match(compactionSkillsGuidance, /exact name/);
  assert.match(compactionSkillsGuidance, /MUST load each of these skills again and follow it/);
});

test('compactionSummaryGuidance: is maximally-complete + session-specific (D3)', () => {
  assert.match(compactionSummaryGuidance, /MAXIMALLY COMPLETE/);
  assert.match(compactionSummaryGuidance, /SESSION-SPECIFIC/);
  assert.match(compactionSummaryGuidance, /CLAUDE\.md \/ AGENTS\.md/);
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

// ── stripCompactionClosingMarkers (the summary posted to the topic) ──

test('stripCompactionClosingMarkers drops the marker LINES and keeps every line of prose', () => {
  const summary = [
    '## Objective',
    'Ship the compaction notice.',
    compactionClosingStartMarker,
    'We were fixing the login bug; next: run the e2e suite.',
    compactionClosingEndMarker,
  ].join('\n');

  const posted = stripCompactionClosingMarkers(summary);

  assert.ok(!posted.includes(compactionClosingStartMarker), 'the start marker is machine scaffolding');
  assert.ok(!posted.includes(compactionClosingEndMarker), 'the end marker is machine scaffolding');
  // The wrapped prose is real content — the operator must still read it.
  assert.ok(posted.includes('We were fixing the login bug; next: run the e2e suite.'));
  assert.ok(posted.includes('## Objective'));
  assert.ok(posted.includes('Ship the compaction notice.'));
  // Whole LINES go, so no blank gap is left where a marker stood.
  assert.equal(
    posted,
    '## Objective\nShip the compaction notice.\nWe were fixing the login bug; next: run the e2e suite.',
  );
});

test('stripCompactionClosingMarkers returns a marker-free summary unchanged', () => {
  const summary = '## Goals\n- keep going\n\n## State\n- green';
  assert.equal(stripCompactionClosingMarkers(summary), summary);
});

test('stripCompactionClosingMarkers keeps prose the model put on the marker line', () => {
  // The markers are an INSTRUCTION to a model, so a run of them sharing a line with
  // real prose is a shape that will happen. Dropping the whole line there would lose
  // the operator's recap; only the scaffolding may go. Load-bearing in the other
  // direction too: the prose must not come back with a stray marker fragment.
  const summary = `Objective: ship it.\n${compactionClosingStartMarker} we were mid-refactor\n${compactionClosingEndMarker}`;

  const posted = stripCompactionClosingMarkers(summary);

  assert.equal(posted, 'Objective: ship it.\nwe were mid-refactor');
  assert.ok(!posted.includes('<<<'), `no marker fragment may survive: "${posted}"`);
});

// ── checkShouldPostCompactionSummary (the whole gate, one rule) ──

test('checkShouldPostCompactionSummary: enabled + non-streaming backend + a real compaction → yes', () => {
  assert.equal(
    checkShouldPostCompactionSummary({ isEnabled: true, streamsOwnSummary: false, route: 'adapterCompact' }),
    true,
  );
});

test('checkShouldPostCompactionSummary: the setting off → no', () => {
  assert.equal(
    checkShouldPostCompactionSummary({ isEnabled: false, streamsOwnSummary: false, route: 'adapterCompact' }),
    false,
  );
});

test('checkShouldPostCompactionSummary: a backend that streams its own summary → no (never a second copy)', () => {
  assert.equal(
    checkShouldPostCompactionSummary({ isEnabled: true, streamsOwnSummary: true, route: 'adapterCompact' }),
    false,
  );
});

test('checkShouldPostCompactionSummary: a route the bot does not await → no summary of ours to post', () => {
  for (const route of ['forwardToAgent', 'notSupported'] as const) {
    assert.equal(
      checkShouldPostCompactionSummary({ isEnabled: true, streamsOwnSummary: false, route }),
      false,
      `route ${route} must not post a summary`,
    );
  }
});

// ── checkShouldAnnounceCompactionStart (the notice that precedes the wait) ──

test('checkShouldAnnounceCompactionStart: an awaited route with a live session → announce', () => {
  assert.equal(
    checkShouldAnnounceCompactionStart({ route: 'adapterCompact', isSessionActive: true }),
    true,
  );
});

test('checkShouldAnnounceCompactionStart: no live session → silence, even on the awaited route', () => {
  // The notice now goes out BEFORE the wait, so it can run ahead of the seam's own
  // first guard. Announcing "compacting the session context" and then answering "no
  // active session" is a promise retracted one message later — and `/compact` in a
  // bound topic whose agent was never started is exactly that case.
  assert.equal(
    checkShouldAnnounceCompactionStart({ route: 'adapterCompact', isSessionActive: false }),
    false,
  );
});

test('checkShouldAnnounceCompactionStart: a route the bot does not await → silence', () => {
  // The tmux TUI renders its own compaction progress, and a terminal never compacts.
  for (const route of ['forwardToAgent', 'notSupported'] as const) {
    assert.equal(
      checkShouldAnnounceCompactionStart({ route, isSessionActive: true }),
      false,
      `route ${route} must not announce a start`,
    );
  }
});

// ── buildIdleCompactionNoticeParts (§1.4 order, the notice stays one short line) ──

const reAskText = '❓ You still have a pending question.\n\nProceed?';

test('buildIdleCompactionNoticeParts: the notice is the short line alone, with or without a summary', () => {
  // The operator asked for an idle compaction to end in one short line: the notice
  // used to grow the summary's "Where we stopped" block whenever the summary was off.
  for (const summary of [null, '## Goals\n- finish the refactor']) {
    const parts = buildIdleCompactionNoticeParts({ noticeText: '🧹 Auto compacted on idle.', summary, questionText: null });
    assert.equal(parts.notice, '🧹 Auto compacted on idle.');
    assert.equal(parts.summary, summary);
  }
});

test('buildIdleCompactionNoticeParts: the re-asked question is its OWN part, never folded into the others', () => {
  // Load-bearing: the question carries inline option buttons. Joined behind a full
  // summary they are buried under a wall of text, which is why it is a separate
  // message and posted LAST.
  const parts = buildIdleCompactionNoticeParts({
    noticeText: '🧹 Auto compacted on idle.',
    summary: 'a very long summary',
    questionText: reAskText,
  });

  assert.equal(parts.question, reAskText);
  assert.ok(!(parts.notice ?? '').includes('Proceed?'), 'the question must not be glued into the notice');
  assert.ok(!(parts.summary ?? '').includes('Proceed?'), 'the question must not be glued into the summary');
});

test('buildIdleCompactionNoticeParts: a FAILED compaction yields the question only, no notice', () => {
  const parts = buildIdleCompactionNoticeParts({
    noticeText: null,
    summary: null,
    questionText: reAskText,
  });

  assert.equal(parts.notice, null, 'nothing was compacted, so nothing is announced');
  assert.equal(parts.summary, null);
  assert.equal(parts.question, reAskText, 'the question was already rejected — it must still be re-asked');
});

test('buildIdleCompactionNoticeParts: nothing to say → every part null (the caller posts no message)', () => {
  const parts = buildIdleCompactionNoticeParts({
    noticeText: null,
    summary: null,
    questionText: null,
  });
  assert.deepEqual(parts, { notice: null, summary: null, question: null });
});
