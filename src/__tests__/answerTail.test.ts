/**
 * @description The answer-tail rules (`requests/answerTail.ts`): what counts as
 * the agent's own text, how a tail is counted in messages, when it is worth a
 * reminder and when the reminder goes out.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addAnswerTailOutput,
  answerTailGraceMs,
  answerTailMessageGapMs,
  answerTailSilenceMs,
  buildAnswerTailReminder,
  checkIsAgentProseOutput,
  checkIsAnswerTailWorthReminder,
  createAnswerTail,
  decideAnswerTail,
  type AnswerTail,
} from '../requests/answerTail';
import type { SessionTurnProbe } from '../requests/wakeUpRules';

const answeredAt = 1_000_000_000;
const idle: SessionTurnProbe = { isActive: true, isBusy: false, hasUnconsumedInput: false, isTurnEndBlocked: false };
const busy: SessionTurnProbe = { ...idle, isBusy: true };
const stopped: SessionTurnProbe = { ...idle, isActive: false };

/** A tail with text at each of `offsetsMs` after the answer. */
function writeAt(offsetsMs: readonly number[]): AnswerTail {
  return offsetsMs.reduce((tail, offsetMs) => addAnswerTailOutput(tail, answeredAt + offsetMs), createAnswerTail('req_1', answeredAt));
}

describe('checkIsAgentProseOutput', () => {
  it('counts the agent\'s own text, not a sub-agent\'s, a summary, a question or a block the bot made', () => {
    assert.equal(checkIsAgentProseOutput('Done, pushed.', undefined), true);
    assert.equal(checkIsAgentProseOutput('Done, pushed.', { isFinal: true }), true);
    assert.equal(checkIsAgentProseOutput('  \n', undefined), false);
    assert.equal(checkIsAgentProseOutput('child text', { isSubagent: true }), false);
    assert.equal(checkIsAgentProseOutput('the summary', { isCompactionSummary: true }), false);
    assert.equal(checkIsAgentProseOutput('Pick one', { isQuestion: true }), false);
    assert.equal(checkIsAgentProseOutput('↩️ Resumed — last 3 messages', { isComplete: true }), false);
  });
});

describe('counting a tail', () => {
  it('chunks a fraction of a second apart are one message; a pause starts the next', () => {
    assert.equal(writeAt([1_000, 1_350, 1_700, 2_050]).messageCount, 1);
    assert.equal(writeAt([1_000, 1_000 + answerTailMessageGapMs + 1]).messageCount, 2);
  });

  it('a closing line right after the answer is no tail; a second message or a late one is', () => {
    assert.equal(checkIsAnswerTailWorthReminder(createAnswerTail('req_1', answeredAt)), false, 'nothing written');
    assert.equal(checkIsAnswerTailWorthReminder(writeAt([2_000, 2_300])), false, 'one closing line');
    assert.equal(checkIsAnswerTailWorthReminder(writeAt([2_000, 20_000])), true, 'two messages within the grace');
    assert.equal(checkIsAnswerTailWorthReminder(writeAt([answerTailGraceMs])), false, 'at the grace edge');
    assert.equal(checkIsAnswerTailWorthReminder(writeAt([answerTailGraceMs + 1])), true, 'one message after the grace');
  });
});

describe('decideAnswerTail', () => {
  const worthIt = writeAt([2_000, 20_000]);
  const notWorthIt = writeAt([2_000]);
  const lastOutputAt = answeredAt + 20_000;

  it('reminds once the turn ended: an idle session or one that stopped', () => {
    assert.equal(decideAnswerTail(worthIt, idle, lastOutputAt + 1_000), 'remind');
    assert.equal(decideAnswerTail(worthIt, stopped, lastOutputAt + 1_000), 'remind');
  });

  it('a turn still running waits, unless the agent has been quiet for 30 minutes', () => {
    assert.equal(decideAnswerTail(worthIt, busy, lastOutputAt + answerTailSilenceMs - 1), 'wait');
    assert.equal(decideAnswerTail(worthIt, busy, lastOutputAt + answerTailSilenceMs), 'remind');
  });

  it('a question, a compaction, a limit wait or a session start holds everything', () => {
    const blocked = { ...idle, isTurnEndBlocked: true };
    assert.equal(decideAnswerTail(worthIt, blocked, lastOutputAt + answerTailSilenceMs), 'wait');
    assert.equal(decideAnswerTail(notWorthIt, { ...blocked, isActive: false }, lastOutputAt), 'wait');
  });

  it('a tail not worth a reminder waits while the session lives and is dropped once it stopped', () => {
    assert.equal(decideAnswerTail(notWorthIt, idle, answeredAt + answerTailSilenceMs * 2), 'wait');
    assert.equal(decideAnswerTail(notWorthIt, busy, answeredAt + answerTailSilenceMs * 2), 'wait');
    assert.equal(decideAnswerTail(notWorthIt, stopped, answeredAt + 5_000), 'drop');
  });
});

describe('buildAnswerTailReminder', () => {
  it('names the answered request and asks for answer_request only if something matters', () => {
    const reminder = buildAnswerTailReminder('req_AbC');
    assert.match(reminder, /^\[Reminder · after your final answer to request req_AbC\]/);
    assert.match(reminder, /answer_request \(requestId "req_AbC", kind "final"\)/);
    assert.match(reminder, /If nothing new came of it, send nothing\./);
  });
});
