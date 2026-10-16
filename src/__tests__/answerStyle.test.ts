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
  it('is exactly the owner-given sentence', () => {
    assert.equal(answerStyleInstruction, 'Prefer to write each answer like for a manager or QA, brief and to the point.');
  });

  it('is one short sentence on one line, ready to join onto a surface\'s own text', () => {
    assert.ok(!answerStyleInstruction.includes('\n'));
    assert.ok(answerStyleInstruction.endsWith('.'));
    assert.ok(answerStyleInstruction.length <= answerStyleInstructionMaxLength, `${answerStyleInstruction.length} chars`);
    assert.equal(answerStyleInstruction, answerStyleInstruction.trim());
  });
});
