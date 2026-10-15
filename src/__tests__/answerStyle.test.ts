/**
 * @description The shared answer-style sentence (`requests/answerStyle.ts`): the
 * one text every surface that asks the agent to answer through `answer_request`
 * carries. The surfaces' own tests assert they include THIS constant; this test
 * pins what the constant says, so they cannot all agree on an empty or changed
 * sentence.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { answerStyleInstruction } from '../requests/answerStyle';

/** A sentence the agent can keep in mind on every request — not a style guide. */
const answerStyleInstructionMaxLength = 250;

describe('answerStyleInstruction', () => {
  it('addresses a manager or QA, asks for short plain words and no back-story', () => {
    assert.match(answerStyleInstruction, /for a manager or QA/);
    assert.match(answerStyleInstruction, /non-technical/);
    assert.match(answerStyleInstruction, /short, plain words/);
    assert.match(answerStyleInstruction, /no back-story/);
  });

  it('asks for status and next steps as a short numbered who-does-what list, and a question on one line', () => {
    assert.match(answerStyleInstruction, /status and next steps as a short numbered list of who does what/);
    assert.match(answerStyleInstruction, /each question one line/);
  });

  it('is one short sentence on one line, ready to join onto a surface\'s own text', () => {
    assert.ok(!answerStyleInstruction.includes('\n'));
    assert.ok(answerStyleInstruction.endsWith('.'));
    assert.ok(answerStyleInstruction.length <= answerStyleInstructionMaxLength, `${answerStyleInstruction.length} chars`);
    assert.equal(answerStyleInstruction, answerStyleInstruction.trim());
  });
});
