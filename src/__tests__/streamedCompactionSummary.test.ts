/**
 * @description The compaction summary a backend STREAMS (OpenCode), tail by tail, before it reaches the topic
 * (`utils/streamedCompactionSummary.ts`): what a SHOWN summary looks like once the scaffolding (the marker lines, the «none»
 * line) is taken out and the agent-mistakes section is labelled — however the tails cut the lines — and when a HIDDEN summary
 * yields its section: once per summary, keyed on the summary's message id, never for a compaction the bot issued itself.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  compactionClosingEndMarker,
  compactionClosingStartMarker,
  compactionGapsEndMarker,
  compactionGapsStartMarker,
  compactionNoGapsLine,
  formatCompactionSummaryForTopic,
} from '../utils/compactOnIdle';
import {
  createStreamedSummaryDisplay,
  createStreamedSummaryTracker,
  type StreamedSummaryTail,
} from '../utils/streamedCompactionSummary';

const gapsHeader = '💡 HEADER:';
const sectionText = '1. Mistake (repeated): pushed without asking. Change: add a rule to CLAUDE.md.\n2. Mistake: skipped lint. Change: a lint line in the commit skill.';

function buildSummary(sectionBody: string): string {
  return [
    '## Goals',
    '- finish the refactor',
    compactionGapsStartMarker,
    sectionBody,
    compactionGapsEndMarker,
    '1. load these skills: commit',
    '2. run the suite',
    compactionClosingStartMarker,
    'Next: run the suite.',
    compactionClosingEndMarker,
  ].join('\n');
}

function sliceEvery(text: string, size: number): string[] {
  const slices: string[] = [];
  for (let at = 0; at < text.length; at += size) slices.push(text.slice(at, at + size));
  return slices;
}

// ── the display of a SHOWN summary ──

test('createStreamedSummaryDisplay: however the tails cut the lines, what is shown is the summary the bot would post whole', () => {
  for (const sectionBody of [sectionText, compactionNoGapsLine, '']) {
    const summary = buildSummary(sectionBody);
    const expected = formatCompactionSummaryForTopic(summary, gapsHeader);
    for (const size of [1, 2, 3, 5, 7, 11, 25, 64, summary.length]) {
      const display = createStreamedSummaryDisplay(gapsHeader);
      const shown = sliceEvery(summary, size).map((tail) => display.push(tail)).join('');
      assert.equal(shown.trim(), expected, `tails of ${size} characters, section ${JSON.stringify(sectionBody.slice(0, 12))}`);
      assert.ok(!shown.includes('<<<') && !shown.includes(compactionNoGapsLine), `no scaffolding reaches the topic (tails of ${size})`);
    }
  }
});

test('createStreamedSummaryDisplay: a line that is not a marker is shown at once, not held until its newline', () => {
  const display = createStreamedSummaryDisplay(gapsHeader);
  assert.equal(display.push('## Goals\n- finish the ref'), '## Goals\n- finish the ref');
  assert.equal(display.push('actor\n'), 'actor\n');
});

test('createStreamedSummaryDisplay: a fragment that could still be a marker waits for the rest, and a half marker is never shown', () => {
  const display = createStreamedSummaryDisplay(gapsHeader);
  assert.equal(display.push(`intro\n${compactionGapsStartMarker.slice(0, 8)}`), 'intro\n', 'only the complete line goes out');
  assert.equal(display.push(`${compactionGapsStartMarker.slice(8)}\n`), '', 'the start marker completes and waits for the section\'s first line');
  assert.equal(display.push('1. Mistake: a.\n'), `${gapsHeader}\n1. Mistake: a.\n`);
});

test('createStreamedSummaryDisplay: a text line that begins like a marker is shown as soon as it stops looking like one', () => {
  const display = createStreamedSummaryDisplay(gapsHeader);
  assert.equal(display.push('N'), '', 'N may be the start of the none line');
  assert.equal(display.push('ext: run the suite.\n'), 'Next: run the suite.\n');
});

// ── the tracker: SHOWN ──

function tail(text: string, overrides: Partial<StreamedSummaryTail> = {}): StreamedSummaryTail {
  return { text, isContinuation: false, summaryId: 'msg_s1', isBotIssued: false, ...overrides };
}

const shownView = { isSummaryShown: true, isInstructionGapsEnabled: true, gapsHeader };
const hiddenView = { isSummaryShown: false, isInstructionGapsEnabled: true, gapsHeader };
const hiddenNoMistakesView = { isSummaryShown: false, isInstructionGapsEnabled: false, gapsHeader };

test('tracker, shown: tails go to the topic with the scaffolding out, and a continuation stays one only after something was shown', () => {
  const tracker = createStreamedSummaryTracker();
  // The first tail is nothing but a marker line: nothing to show yet, and the NEXT tail must not continue a message that
  // was never started (it would append to whatever the topic's last message was).
  const first = tracker.push('t', tail(`${compactionGapsStartMarker}\n`), shownView);
  assert.deepEqual(first, { shown: null, instructionGaps: null });
  const second = tracker.push('t', tail('1. Mistake: a.\n', { isContinuation: true }), shownView);
  assert.deepEqual(second, { shown: { text: `${gapsHeader}\n1. Mistake: a.\n`, isContinuation: false }, instructionGaps: null });
  const third = tracker.push('t', tail(`${compactionGapsEndMarker}\n2. run the suite\n`, { isContinuation: true }), shownView);
  assert.deepEqual(third, { shown: { text: '2. run the suite\n', isContinuation: true }, instructionGaps: null });
});

test('tracker, shown: a tail that leaves only blank space to show shows nothing and starts no message', () => {
  const tracker = createStreamedSummaryTracker();
  assert.deepEqual(tracker.push('t', tail(`${compactionClosingStartMarker}\n`), shownView), { shown: null, instructionGaps: null });
  assert.deepEqual(
    tracker.push('t', tail('## Goals\n', { isContinuation: true }), shownView),
    { shown: { text: '## Goals\n', isContinuation: false }, instructionGaps: null },
  );
});

test('tracker, shown: a newline that only closes a line is not lost when the tail that carried it shows nothing else — the topic reads the summary the bot would post whole', () => {
  // The debounce cuts a tail in the middle of a line; the next one is the newline plus a marker line. The display gives back
  // the newline alone, and the bot appends a continuation verbatim: dropping it glues the next line onto the one before.
  const tails = ['body line', '\n<<<INSTRUCTION_GAPS>>>\n', '1. Mistake\n'];
  const tracker = createStreamedSummaryTracker();
  const shown = tails.map((text, index) => tracker.push('t', tail(text, { isContinuation: index > 0 }), shownView).shown);
  assert.deepEqual(shown[0], { text: 'body line', isContinuation: false });
  assert.equal(shown[1], null, 'a tail that shows only a newline sends nothing of its own');
  assert.deepEqual(shown[2], { text: `\n${gapsHeader}\n1. Mistake\n`, isContinuation: true }, 'the newline goes out in front of the next text');
  assert.equal(
    shown.map((outcome) => outcome?.text ?? '').join('').trim(),
    formatCompactionSummaryForTopic(tails.join(''), gapsHeader),
  );
});

test('tracker, shown: the blank space a dropped none line leaves behind is kept too, however the tails cut — never shown ahead of the first text of a message', () => {
  const summary = ['body line', compactionGapsStartMarker, compactionNoGapsLine, compactionGapsEndMarker, '1. load these skills: commit'].join('\n');
  for (const size of [1, 2, 3, 4, 5, 7, 11, 16, 32, summary.length]) {
    const tracker = createStreamedSummaryTracker();
    const shown = sliceEvery(summary, size)
      .map((text, index) => tracker.push('t', tail(text, { isContinuation: index > 0 }), shownView).shown)
      .map((outcome) => outcome?.text ?? '')
      .join('');
    assert.equal(shown, formatCompactionSummaryForTopic(summary, gapsHeader), `tails of ${size} characters`);
  }
  const leading = createStreamedSummaryTracker();
  assert.equal(leading.push('t', tail('\n'), shownView).shown, null);
  assert.equal(leading.push('t', tail('first\n', { isContinuation: true }), shownView).shown?.text, 'first\n', 'blank space before anything was shown is not carried into the message');
});

test('tracker, shown: a first tail that is shown keeps isContinuation false, and a bot-issued summary is shown too', () => {
  const tracker = createStreamedSummaryTracker();
  assert.deepEqual(
    tracker.push('t', tail('## Goals\n', { isBotIssued: true }), shownView),
    { shown: { text: '## Goals\n', isContinuation: false }, instructionGaps: null },
  );
});

test('tracker, shown: a new summary (another message id) starts a fresh display — a held fragment of the old one is not glued to it', () => {
  const tracker = createStreamedSummaryTracker();
  tracker.push('t', tail('old\n<<<INSTR'), shownView);
  const next = tracker.push('t', tail('new summary\n', { summaryId: 'msg_s2', isContinuation: true }), shownView);
  assert.deepEqual(next, { shown: { text: 'new summary\n', isContinuation: false }, instructionGaps: null });
});

// ── the tracker: HIDDEN ──

test('tracker, hidden: the section comes out once, the moment its end marker has arrived, whatever the tails cut', () => {
  const tracker = createStreamedSummaryTracker();
  const summary = buildSummary(sectionText);
  const outcomes = sliceEvery(summary, 9).map((slice, index) => tracker.push('t', tail(slice, { isContinuation: index > 0 }), hiddenView));
  assert.ok(outcomes.every((outcome) => outcome.shown === null), 'a hidden summary shows nothing');
  assert.deepEqual(outcomes.filter((outcome) => outcome.instructionGaps !== null).map((outcome) => outcome.instructionGaps), [sectionText], 'the section once');
  const postedAt = outcomes.findIndex((outcome) => outcome.instructionGaps !== null);
  assert.ok(sliceEvery(summary, 9).slice(0, postedAt + 1).join('').includes(compactionGapsEndMarker), 'at the tail that completed the end marker line');
});

test('tracker, hidden, `/compact_mistakes` OFF: a section that does arrive is not collected and not posted — the same summary posts it with the switch ON', () => {
  const summaryTails = [`body\n${compactionGapsStartMarker}\n1. Mistake: a.\n`, `${compactionGapsEndMarker}\n`];
  const posted = (view: typeof hiddenView): Array<string | null> => {
    const tracker = createStreamedSummaryTracker();
    return summaryTails.map((text, index) => tracker.push('t', tail(text, { isContinuation: index > 0 }), view).instructionGaps);
  };
  assert.deepEqual(posted(hiddenView), [null, '1. Mistake: a.'], 'ON: posted once the end marker arrived');
  assert.deepEqual(posted(hiddenNoMistakesView), [null, null], 'OFF: nothing is posted, and nothing was collected for it');
});

test('tracker, hidden: after the section is out the summary\'s later tails — and an answer that continues it — are not collected', () => {
  const tracker = createStreamedSummaryTracker();
  tracker.push('t', tail(`${compactionGapsStartMarker}\n${sectionText}\n${compactionGapsEndMarker}\n`), hiddenView);
  // The same buffer goes on carrying the turn's answer, still flagged as the summary, and even a second section of it.
  const later = tracker.push('t', tail(`more\n${compactionGapsStartMarker}\nrestated\n${compactionGapsEndMarker}\n`, { isContinuation: true }), hiddenView);
  assert.deepEqual(later, { shown: null, instructionGaps: null });
});

test('tracker, hidden: a section that says «none» posts nothing and the summary is not collected any further', () => {
  const tracker = createStreamedSummaryTracker();
  const outcome = tracker.push('t', tail(`${compactionGapsStartMarker}\n${compactionNoGapsLine}\n${compactionGapsEndMarker}\n`), hiddenView);
  assert.deepEqual(outcome, { shown: null, instructionGaps: null });
  assert.deepEqual(tracker.push('t', tail(`${compactionGapsStartMarker}\nx\n${compactionGapsEndMarker}\n`, { isContinuation: true }), hiddenView), { shown: null, instructionGaps: null });
});

test('tracker, hidden: a SECOND summary in the same session posts its section even when its first tail is a continuation', () => {
  const tracker = createStreamedSummaryTracker();
  const first = tracker.push('t', tail(buildSummary(sectionText)), hiddenView);
  assert.equal(first.instructionGaps, sectionText);
  // The server compacts again mid-turn, after the agent already streamed text: every tail of that summary is a continuation.
  const second = tracker.push('t', tail(buildSummary('1. Mistake: another. Change: another.'), { summaryId: 'msg_s2', isContinuation: true }), hiddenView);
  assert.equal(second.instructionGaps, '1. Mistake: another. Change: another.');
});

test('tracker, hidden: a compaction the bot issued is left to the bot, which reads the section itself and in order', () => {
  const tracker = createStreamedSummaryTracker();
  const outcome = tracker.push('t', tail(buildSummary(sectionText), { isBotIssued: true }), hiddenView);
  assert.deepEqual(outcome, { shown: null, instructionGaps: null });
});

test('tracker, hidden: without a message id a first tail starts a summary and a continuation goes on with it', () => {
  const tracker = createStreamedSummaryTracker();
  const idless = (text: string, isContinuation: boolean): StreamedSummaryTail => ({ text, isContinuation, summaryId: null, isBotIssued: false });
  assert.equal(tracker.push('t', idless(`${compactionGapsStartMarker}\n${sectionText}\n`, false), hiddenView).instructionGaps, null);
  assert.equal(tracker.push('t', idless(`${compactionGapsEndMarker}\n`, true), hiddenView).instructionGaps, sectionText);
});

test('tracker: each thread has its own summary, and clear forgets one', () => {
  const tracker = createStreamedSummaryTracker();
  tracker.push('a', tail(`${compactionGapsStartMarker}\n${sectionText}\n`), hiddenView);
  assert.equal(tracker.push('b', tail(`${compactionGapsEndMarker}\n`, { isContinuation: true }), hiddenView).instructionGaps, null, 'the end marker of another thread completes nothing');
  tracker.clear('a');
  assert.equal(tracker.push('a', tail(`${compactionGapsEndMarker}\n`, { isContinuation: true }), hiddenView).instructionGaps, null, 'a cleared thread starts over');
});
