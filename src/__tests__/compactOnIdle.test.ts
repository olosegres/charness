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
  compactionChecklistGuidance,
  compactionGapsGuidance,
  compactionGapsStartMarker,
  compactionGapsEndMarker,
  compactionNoGapsLine,
  compactionResumeGuidance,
  formatCompactionSummaryForTopic,
  parseCompactionSummaryLine,
  checkCouldBecomeCompactionScaffoldingLine,
  createCompactionSummaryLineFilter,
  parseCompactionInstructionGaps,
  extractCompactionInstructionGaps,
  checkShouldPostCompactionSummary,
  checkShouldPostInstructionGaps,
  checkShouldAnnounceCompactionStart,
  buildIdleCompactionNoticeParts,
  formatTokenCount,
  compactionClosingStartMarker,
  compactionClosingEndMarker,
  getPendingWorkRecheckDelayMs,
  pendingWorkRecheckMarginMs,
} from '../utils/compactOnIdle';
import { t } from '../i18n';

type IdleFireInput = Parameters<typeof getIdleFireDecision>[0];

/** The all-conditions-met base for the idle-fire decision (D1/D2, L3): compact AND stop. */
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

test('buildCompactionInstruction: Claude backends get the D3 + resume guidance, closing last', () => {
  const closing = 'CLOSING';
  const claude = buildCompactionInstruction({
    bakesSummaryGuidance: false,
    summaryGuidance: compactionSummaryGuidance,
    bakesResumeGuidance: false,
    resumeGuidance: compactionResumeGuidance,
    closingSectionInstruction: closing,
  });
  assert.ok(claude);
  assert.ok(claude.includes(compactionSummaryGuidance), 'D3 guidance rides the Claude instruction');
  assert.ok(claude.includes(compactionResumeGuidance), 'resume guidance rides the Claude instruction');
  assert.ok(claude.includes(closing), 'closing section is appended too');
  assert.ok(
    claude.indexOf(compactionSummaryGuidance) < claude.indexOf(compactionResumeGuidance),
    'D3 guidance before resume guidance',
  );
  // The closing directive says "write nothing after the end marker", so it must
  // be the last instruction the model reads.
  assert.ok(claude.indexOf(compactionResumeGuidance) < claude.indexOf(closing), 'closing comes last');
});

test('buildCompactionInstruction: a compaction with no closing section (manual, agent-armed) ends with the checklist guidance', () => {
  // `/compact` and `compact_conversation` ask for no closing section: the checklist then ends the summary,
  // so it must be the last thing the model reads.
  const claude = buildCompactionInstruction({
    bakesSummaryGuidance: false,
    summaryGuidance: compactionSummaryGuidance,
    bakesResumeGuidance: false,
    resumeGuidance: compactionResumeGuidance,
  });
  assert.equal(claude, `${compactionSummaryGuidance}\n\n${compactionResumeGuidance}`);
  assert.ok(claude.endsWith(compactionChecklistGuidance));
});

test('buildCompactionInstruction: the idle compaction asks for the checklist as the last part of the closing section', () => {
  // The real per-locale closing text, as `getCompactionInstruction` composes it: the resume guidance (skills
  // sentence + checklist) first, then the section whose last part, right before the end marker, is that checklist.
  const closing = t('compact.closingSectionInstruction', {
    startMarker: compactionClosingStartMarker,
    endMarker: compactionClosingEndMarker,
  });
  const instruction = buildCompactionInstruction({
    bakesSummaryGuidance: false,
    summaryGuidance: compactionSummaryGuidance,
    bakesResumeGuidance: false,
    resumeGuidance: compactionResumeGuidance,
    closingSectionInstruction: closing,
  });
  assert.ok(instruction);
  assert.ok(instruction.includes(compactionChecklistGuidance), 'the checklist guidance rides the idle compaction');
  assert.ok(
    instruction.indexOf(compactionChecklistGuidance) < instruction.indexOf(compactionClosingStartMarker),
    'the checklist is asked for before the section it lands in',
  );
  assert.ok(
    instruction.includes(`as the LAST part of the section, right before ${compactionClosingEndMarker}, the numbered what-to-do-next checklist`),
    'the section names the checklist as its last part',
  );
  assert.ok(instruction.endsWith(`Write nothing after ${compactionClosingEndMarker}.`), 'nothing follows the end marker');
});

test('buildCompactionInstruction: OpenCode omits the baked D3 guidance but still gets the resume guidance', () => {
  // OpenCode bakes D3 into its fork prompt, so re-sending it would duplicate the
  // text. The resume guidance is baked nowhere, so even a plain manual /compact
  // (no closing) carries it.
  assert.equal(
    buildCompactionInstruction({
      bakesSummaryGuidance: true,
      summaryGuidance: compactionSummaryGuidance,
      bakesResumeGuidance: false,
      resumeGuidance: compactionResumeGuidance,
      closingSectionInstruction: undefined,
    }),
    compactionResumeGuidance,
  );
  const withClosing = buildCompactionInstruction({
    bakesSummaryGuidance: true,
    summaryGuidance: compactionSummaryGuidance,
    bakesResumeGuidance: false,
    resumeGuidance: compactionResumeGuidance,
    closingSectionInstruction: 'CLOSING',
  });
  assert.equal(withClosing, `${compactionResumeGuidance}\n\nCLOSING`, 'resume guidance, then the closing section');
});

test('buildCompactionInstruction: an OpenCode server with the compaction plugin gets neither guidance', () => {
  // The plugin adds the resume guidance to every compaction prompt and cannot see
  // this instruction, so sending it here as well would duplicate it.
  const base = {
    bakesSummaryGuidance: true,
    summaryGuidance: compactionSummaryGuidance,
    bakesResumeGuidance: true,
    resumeGuidance: compactionResumeGuidance,
  };
  assert.equal(buildCompactionInstruction({ ...base, closingSectionInstruction: 'CLOSING' }), 'CLOSING');
  assert.equal(buildCompactionInstruction(base), undefined);
});

test('buildCompactionInstruction: nothing to append → undefined', () => {
  assert.equal(
    buildCompactionInstruction({
      bakesSummaryGuidance: true,
      summaryGuidance: compactionSummaryGuidance,
      bakesResumeGuidance: false,
      resumeGuidance: '  ',
      closingSectionInstruction: '   ',
    }),
    undefined,
    'whitespace-only resume guidance and closing are ignored',
  );
});

test('compactionSkillsGuidance: names the loaded skills and says to load them again', () => {
  assert.match(compactionSkillsGuidance, /skill/);
  assert.match(compactionSkillsGuidance, /exact name/);
  assert.match(compactionSkillsGuidance, /MUST load each of these skills again and follow it/);
});

test('compactionChecklistGuidance: a skills-first numbered next-steps list that ends the summary, with no invented steps', () => {
  assert.match(compactionChecklistGuidance, /numbered checklist \(1\., 2\., 3\., one short item per line\) of what the continuing session does next, as the very LAST thing/);
  assert.match(compactionChecklistGuidance, /Item 1 is 'load these skills' followed by the exact name of every skill that was loaded/);
  assert.match(compactionChecklistGuidance, /if none was loaded, leave that item out/);
  assert.match(compactionChecklistGuidance, /next steps this summary already records, in order: invent no new steps/);
  assert.match(compactionChecklistGuidance, /closing section between two marker lines, the checklist is the last part of that section, right before its end marker/);
});

test('compactionGapsGuidance: asks for the agent mistakes (repeated ones above all) an instruction change could prevent, with the change and where it goes', () => {
  assert.match(compactionGapsGuidance, /mistakes the agent made in this session, especially REPEATED ones/);
  assert.match(compactionGapsGuidance, /standing instructions \(rules, skills, CLAUDE\.md \/ AGENTS\.md\) could prevent/);
  assert.match(compactionGapsGuidance, /the concrete instruction change that would prevent it and where that change would go/);
});

test('compactionGapsGuidance: pins its own markers, the none line, the position and the language', () => {
  assert.ok(compactionGapsGuidance.includes(`a line containing only ${compactionGapsStartMarker} and a line containing only ${compactionGapsEndMarker}`), 'the exact marker lines');
  assert.ok(compactionGapsGuidance.includes(`write only the single line ${compactionNoGapsLine} between those two marker lines`), 'the one-line answer for "none"');
  assert.match(compactionGapsGuidance, /placed before the numbered checklist and before any closing section/);
  assert.match(compactionGapsGuidance, /in the language the user used in this conversation/);
});

test('compactionGapsGuidance: the continuing session only PROPOSES — it never writes instructions on its own', () => {
  assert.match(compactionGapsGuidance, /must only PROPOSE these changes to the user and wait for approval: it must never write or change instructions on its own/);
});

test('compactionGapsGuidance: its markers are distinct from the closing section\'s, so the two sections never collide', () => {
  assert.notEqual(compactionGapsStartMarker, compactionClosingStartMarker);
  assert.notEqual(compactionGapsEndMarker, compactionClosingEndMarker);
  assert.ok(!compactionGapsGuidance.includes(compactionClosingStartMarker) && !compactionGapsGuidance.includes(compactionClosingEndMarker));
});

test('compactionResumeGuidance: the agent-mistakes section, then the skills sentence, then the checklist — the one text every compaction path carries', () => {
  // The older text was `${skills} ${checklist}` and a process started under it keeps a PreCompact hook that skips a
  // compaction by finding exactly that as a substring: the new sentence goes AHEAD of it, so the old text stays whole.
  assert.equal(compactionResumeGuidance, `${compactionGapsGuidance} ${compactionSkillsGuidance} ${compactionChecklistGuidance}`);
  assert.ok(compactionResumeGuidance.includes(`${compactionSkillsGuidance} ${compactionChecklistGuidance}`), 'the previous resume guidance is still a contiguous substring');
  assert.ok(compactionResumeGuidance.endsWith(compactionChecklistGuidance), 'the checklist closes the guidance');
  // The `PreCompact` hook matches it as a fixed string in the raw JSON on stdin: one line, nothing JSON would escape.
  assert.equal(JSON.stringify(compactionResumeGuidance), `"${compactionResumeGuidance}"`);
  assert.match(compactionResumeGuidance, /^[\x20-\x7e]+$/);
  // The new section is part of that text, ahead of the checklist, which stays the last thing it says.
  assert.ok(compactionResumeGuidance.includes(compactionGapsGuidance));
  assert.ok(compactionResumeGuidance.indexOf(compactionGapsGuidance) < compactionResumeGuidance.indexOf(compactionChecklistGuidance));
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

// ── formatCompactionSummaryForTopic (the full summary posted to the topic) ──

/** The label the bot puts where the agent-mistakes section starts in a summary it posts. */
const gapsHeader = '💡 HEADER:';

test('formatCompactionSummaryForTopic drops the marker LINES and keeps every line of prose', () => {
  const summary = [
    '## Objective',
    'Ship the compaction notice.',
    compactionClosingStartMarker,
    'We were fixing the login bug; next: run the e2e suite.',
    compactionClosingEndMarker,
  ].join('\n');

  const posted = formatCompactionSummaryForTopic(summary, gapsHeader);

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

test('formatCompactionSummaryForTopic returns a marker-free summary unchanged', () => {
  const summary = '## Goals\n- keep going\n\n## State\n- green';
  assert.equal(formatCompactionSummaryForTopic(summary, gapsHeader), summary);
});

test('formatCompactionSummaryForTopic keeps prose the model put on the marker line', () => {
  // The markers are an INSTRUCTION to a model, so a run of them sharing a line with
  // real prose is a shape that will happen. Dropping the whole line there would lose
  // the operator's recap; only the scaffolding may go. Load-bearing in the other
  // direction too: the prose must not come back with a stray marker fragment.
  const summary = `Objective: ship it.\n${compactionClosingStartMarker} we were mid-refactor\n${compactionClosingEndMarker}`;

  const posted = formatCompactionSummaryForTopic(summary, gapsHeader);

  assert.equal(posted, 'Objective: ship it.\nwe were mid-refactor');
  assert.ok(!posted.includes('<<<'), `no marker fragment may survive: "${posted}"`);
});

test('formatCompactionSummaryForTopic labels the agent-mistakes section with the header, so it reads as proposals and not as more next steps', () => {
  const summary = [
    '## Objective',
    'Ship it.',
    compactionGapsStartMarker,
    '1. Mistake: committed without tests. Change: add a rule to CLAUDE.md.',
    '2. Mistake: pushed unasked. Change: a rule.',
    compactionGapsEndMarker,
    '1. load these skills: commit',
    '2. run the suite',
    compactionClosingStartMarker,
    'Next: run the suite.',
    compactionClosingEndMarker,
  ].join('\n');

  assert.equal(
    formatCompactionSummaryForTopic(summary, gapsHeader),
    [
      '## Objective',
      'Ship it.',
      gapsHeader,
      '1. Mistake: committed without tests. Change: add a rule to CLAUDE.md.',
      '2. Mistake: pushed unasked. Change: a rule.',
      '1. load these skills: commit',
      '2. run the suite',
      'Next: run the suite.',
    ].join('\n'),
  );
});

test('formatCompactionSummaryForTopic: an empty section — the none line, nothing, or only blanks — leaves no header and no scaffolding', () => {
  for (const body of [[compactionNoGapsLine], [`${compactionNoGapsLine}.`], [], ['', '  ']]) {
    const summary = ['## Objective', compactionGapsStartMarker, ...body, compactionGapsEndMarker, 'Next: run the suite.'].join('\n');
    assert.equal(formatCompactionSummaryForTopic(summary, gapsHeader), '## Objective\nNext: run the suite.', `body ${JSON.stringify(body)}`);
  }
  // A line that merely mentions the none line in prose is content and stays.
  const prose = `The agent answered ${compactionNoGapsLine} to the question.`;
  assert.equal(formatCompactionSummaryForTopic(prose, gapsHeader), prose);
});

test('formatCompactionSummaryForTopic: a section that was never closed still gets its header, and CRLF lines and indented markers are read', () => {
  const unclosed = [compactionGapsStartMarker, '1. Mistake: a. Change: b.'].join('\n');
  assert.equal(formatCompactionSummaryForTopic(unclosed, gapsHeader), `${gapsHeader}\n1. Mistake: a. Change: b.`);
  const windows = ['a', `  ${compactionGapsStartMarker}  `, 'b', `${compactionGapsEndMarker}  `, 'c'].join('\r\n');
  assert.equal(formatCompactionSummaryForTopic(windows, gapsHeader), ['a', gapsHeader, 'b', 'c'].join('\n'));
});

// ── the single-line helper and the line filter (one pattern for the summary the bot reads and the one a backend streams) ──

test('parseCompactionSummaryLine: names the scaffolding a line starts with and returns the prose after it', () => {
  assert.deepEqual(parseCompactionSummaryLine(compactionGapsStartMarker), { kind: 'gapsStart', rest: '' });
  assert.deepEqual(parseCompactionSummaryLine(`  ${compactionGapsEndMarker}  `), { kind: 'gapsEnd', rest: '' });
  assert.deepEqual(parseCompactionSummaryLine(compactionClosingStartMarker), { kind: 'closingStart', rest: '' });
  assert.deepEqual(parseCompactionSummaryLine(compactionClosingEndMarker), { kind: 'closingEnd', rest: '' });
  assert.deepEqual(parseCompactionSummaryLine(compactionNoGapsLine), { kind: 'noGaps', rest: '' });
  assert.deepEqual(parseCompactionSummaryLine(`${compactionNoGapsLine}.`), { kind: 'noGaps', rest: '' });
  assert.deepEqual(parseCompactionSummaryLine(`${compactionClosingStartMarker} we were mid-refactor`), { kind: 'closingStart', rest: 'we were mid-refactor' });
});

test('parseCompactionSummaryLine: prose is not scaffolding, even prose that quotes it', () => {
  for (const line of ['Next: run the suite.', '', `The agent answered ${compactionNoGapsLine} to it.`, `see ${compactionGapsStartMarker} here`, `${compactionNoGapsLine}FOO`]) {
    assert.deepEqual(parseCompactionSummaryLine(line), { kind: null, rest: line }, `line "${line}"`);
  }
});

test('checkCouldBecomeCompactionScaffoldingLine: a streamed fragment is held back only while it could still be a marker line', () => {
  for (const fragment of ['', '  ', '<', '<<<INSTR', compactionGapsStartMarker, `${compactionGapsEndMarker} and prose`, 'NO_INST', compactionNoGapsLine, '<<<END_WHERE']) {
    assert.equal(checkCouldBecomeCompactionScaffoldingLine(fragment), true, `fragment "${fragment}" is held`);
  }
  for (const fragment of ['N', 'Ne', 'Next: run', '1. Mistake', '## Goals', '<b>', '  - item']) {
    // 'N' is the start of NO_INSTRUCTION_GAPS: held; the second letter decides.
    assert.equal(checkCouldBecomeCompactionScaffoldingLine(fragment), fragment === 'N', `fragment "${fragment}"`);
  }
});

test('createCompactionSummaryLineFilter: a line at a time, the header goes in only once the section has a first line', () => {
  const filter = createCompactionSummaryLineFilter(gapsHeader);
  assert.deepEqual(filter.pushLine('## Goals'), ['## Goals']);
  assert.deepEqual(filter.pushLine(compactionGapsStartMarker), [], 'the start marker waits for the section\'s first line');
  assert.deepEqual(filter.pushLine(''), [], 'blank lines before the first line are dropped');
  assert.deepEqual(filter.pushLine('1. Mistake: a.'), [gapsHeader, '1. Mistake: a.']);
  assert.deepEqual(filter.pushLine('2. Mistake: b.'), ['2. Mistake: b.']);
  assert.deepEqual(filter.pushLine(compactionGapsEndMarker), []);
  assert.deepEqual(filter.pushLine('1. load these skills: commit'), ['1. load these skills: commit']);
});

test('createCompactionSummaryLineFilter: a second section gets its own header, a stray end marker is just dropped', () => {
  const filter = createCompactionSummaryLineFilter(gapsHeader);
  assert.deepEqual(filter.pushLine(compactionGapsEndMarker), []);
  filter.pushLine(compactionGapsStartMarker);
  filter.pushLine('first');
  filter.pushLine(compactionGapsEndMarker);
  filter.pushLine(compactionGapsStartMarker);
  assert.deepEqual(filter.pushLine('second'), [gapsHeader, 'second']);
});

// ── extractCompactionInstructionGaps (the section the bot posts even when the summary is hidden) ──

const gapsText = '1. Mistake (repeated): pushed without asking. Change: add "never push without permission" to CLAUDE.md.\n2. Mistake: skipped the lint step. Change: a lint line in the commit skill.';

test('parseCompactionInstructionGaps: tells a section that is complete (even when empty) from one still being written', () => {
  assert.deepEqual(parseCompactionInstructionGaps(`${compactionGapsStartMarker}\n${gapsText}\n${compactionGapsEndMarker}`), { isComplete: true, text: gapsText });
  assert.deepEqual(parseCompactionInstructionGaps(`${compactionGapsStartMarker}\n${compactionNoGapsLine}\n${compactionGapsEndMarker}`), { isComplete: true, text: null });
  assert.deepEqual(parseCompactionInstructionGaps(`${compactionGapsStartMarker}\n${gapsText}`), { isComplete: false, text: null });
  assert.deepEqual(parseCompactionInstructionGaps('## Goals'), { isComplete: false, text: null });
});

test('extractCompactionInstructionGaps: lifts the text between the marker lines, trimmed', () => {
  const summary = ['## Goals', '- ship', compactionGapsStartMarker, '', gapsText, '', compactionGapsEndMarker, '1. load these skills: commit'].join('\n');
  assert.equal(extractCompactionInstructionGaps(summary), gapsText);
});

test('extractCompactionInstructionGaps: no markers, or an unfinished section, is null', () => {
  assert.equal(extractCompactionInstructionGaps('## Goals\n- ship'), null);
  assert.equal(extractCompactionInstructionGaps(`text\n${compactionGapsStartMarker}\n${gapsText}`), null, 'a stream that has not reached the end marker');
  assert.equal(extractCompactionInstructionGaps(`${gapsText}\n${compactionGapsEndMarker}`), null, 'an end marker with no start');
});

test('extractCompactionInstructionGaps: an empty section, or the none line, is null — nothing is posted for "no mistakes"', () => {
  for (const body of ['', '   ', compactionNoGapsLine, `${compactionNoGapsLine}.`, `  ${compactionNoGapsLine.toLowerCase()}  `]) {
    assert.equal(extractCompactionInstructionGaps(`${compactionGapsStartMarker}\n${body}\n${compactionGapsEndMarker}`), null, `body "${body}"`);
  }
  // A real section that merely mentions the none line in passing is still a section.
  assert.equal(
    extractCompactionInstructionGaps(`${compactionGapsStartMarker}\nNot ${compactionNoGapsLine}: ${gapsText}\n${compactionGapsEndMarker}`),
    `Not ${compactionNoGapsLine}: ${gapsText}`,
  );
});

test('extractCompactionInstructionGaps: a marker counts only ALONE on its line — the instruction quoted in prose is not a section', () => {
  const quoted = `The summary must sit between a line containing only ${compactionGapsStartMarker} and a line containing only ${compactionGapsEndMarker}.`;
  assert.equal(extractCompactionInstructionGaps(quoted), null);
  assert.equal(extractCompactionInstructionGaps(`${compactionGapsStartMarker} ${gapsText}\n${compactionGapsEndMarker}`), null);
  // An end marker mentioned in prose is no end: the section it would close is still unfinished.
  assert.equal(extractCompactionInstructionGaps(`${compactionGapsStartMarker}\n${gapsText}\nthe section ends at ${compactionGapsEndMarker}, as asked`), null);
});

test('extractCompactionInstructionGaps: the LAST pair wins, and CRLF lines and indented markers still match', () => {
  const summary = [compactionGapsStartMarker, 'first try', compactionGapsEndMarker, 'prose', `  ${compactionGapsStartMarker}  `, gapsText, `${compactionGapsEndMarker}  `].join('\r\n');
  assert.equal(extractCompactionInstructionGaps(summary), gapsText);
});

test('extractCompactionInstructionGaps: ignores the closing section\'s markers', () => {
  const summary = [compactionClosingStartMarker, 'Next: run it.', compactionClosingEndMarker].join('\n');
  assert.equal(extractCompactionInstructionGaps(summary), null);
});

// ── checkShouldPostInstructionGaps (the section is shown even in hide mode) ──

test('checkShouldPostInstructionGaps: the bot\'s own compaction with the summary HIDDEN → the section alone is posted, on every backend', () => {
  // A backend that streams its own summary included: with the summary hidden that stream is dropped, so the bot reads the
  // section itself and posts it in order — after its notice, before a re-asked question.
  for (const streamsOwnSummary of [false, true]) {
    assert.equal(
      checkShouldPostInstructionGaps({ isSummaryEnabled: false, streamsOwnSummary, isBotIssued: true, route: 'adapterCompact' }),
      true,
      `streams its own summary: ${streamsOwnSummary}`,
    );
  }
});

test('checkShouldPostInstructionGaps: the bot\'s own compaction with the summary SHOWN → no (the full summary carries it, never twice)', () => {
  for (const streamsOwnSummary of [false, true]) {
    assert.equal(
      checkShouldPostInstructionGaps({ isSummaryEnabled: true, streamsOwnSummary, isBotIssued: true, route: 'adapterCompact' }),
      false,
      `streams its own summary: ${streamsOwnSummary}`,
    );
  }
});

test('checkShouldPostInstructionGaps: a compaction the CLI ran by itself → yes in BOTH modes (nobody posts its summary)', () => {
  for (const isSummaryEnabled of [true, false]) {
    assert.equal(
      checkShouldPostInstructionGaps({ isSummaryEnabled, streamsOwnSummary: false, isBotIssued: false, route: 'adapterCompact' }),
      true,
      `summary enabled: ${isSummaryEnabled}`,
    );
  }
});

test('checkShouldPostInstructionGaps: a compaction a streaming backend ran by itself → no from this rule (its stream is the one channel)', () => {
  for (const isSummaryEnabled of [true, false]) {
    assert.equal(
      checkShouldPostInstructionGaps({ isSummaryEnabled, streamsOwnSummary: true, isBotIssued: false, route: 'adapterCompact' }),
      false,
      `summary enabled: ${isSummaryEnabled}`,
    );
  }
});

test('checkShouldPostInstructionGaps: a route the bot does not await → no summary of ours to read', () => {
  for (const route of ['forwardToAgent', 'notSupported'] as const) {
    assert.equal(
      checkShouldPostInstructionGaps({ isSummaryEnabled: false, streamsOwnSummary: false, isBotIssued: true, route }),
      false,
      `route ${route}`,
    );
  }
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
    const parts = buildIdleCompactionNoticeParts({ noticeText: '🧹 Auto compacted on idle.', summary, instructionGaps: null, questionText: null });
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
    instructionGaps: null,
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
    instructionGaps: null,
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
    instructionGaps: null,
    questionText: null,
  });
  assert.deepEqual(parts, { notice: null, summary: null, instructionGaps: null, question: null });
});

test('buildIdleCompactionNoticeParts: the agent-mistakes section is its OWN part, between the notice and the question', () => {
  const parts = buildIdleCompactionNoticeParts({
    noticeText: '🧹 Auto compacted on idle.',
    summary: null,
    instructionGaps: gapsText,
    questionText: reAskText,
  });
  assert.equal(parts.instructionGaps, gapsText);
  assert.equal(parts.summary, null, 'the full summary is hidden — only the section is posted');
  assert.ok(!(parts.notice ?? '').includes('Mistake'), 'the section must not be glued into the notice');
  assert.ok(!(parts.question ?? '').includes('Mistake'), 'the section must not be glued into the question');
  assert.equal(buildIdleCompactionNoticeParts({ noticeText: null, summary: null, instructionGaps: '', questionText: null }).instructionGaps, null, 'an empty section is no part');
});

test('getPendingWorkRecheckDelayMs: the next idle window, or just past the pending-work hold if that ends first', () => {
  const idleWindowMs = 55 * 60_000;
  assert.equal(getPendingWorkRecheckDelayMs({ idleWindowMs, holdRemainingMs: null }), idleWindowMs, 'no hold (a turn on its way, input not yet taken in): the window');
  assert.equal(getPendingWorkRecheckDelayMs({ idleWindowMs, holdRemainingMs: 6 * 60 * 60_000 }), idleWindowMs, 'a long hold left: the window');
  assert.equal(getPendingWorkRecheckDelayMs({ idleWindowMs, holdRemainingMs: 10 * 60_000 }), 10 * 60_000 + pendingWorkRecheckMarginMs, 'the hold ends first: just past its end');
  assert.equal(getPendingWorkRecheckDelayMs({ idleWindowMs, holdRemainingMs: 0 }), pendingWorkRecheckMarginMs, 'a spent hold: at once, after the margin');
});
