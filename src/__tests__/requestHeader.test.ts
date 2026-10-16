/**
 * @description The per-request header that rides inside a request's prompt
 * (`requests/requestHeader.ts`): names the id and how to answer, says the
 * plain text is not shown only when that is so, and names the same requester's
 * requests this one replaced so the agent answers only what THIS one adds (it
 * may already have answered them — Claude Code delivers a message written
 * mid-turn only after that turn ends); plus the re-post text of a
 * conversation's untaken prompts.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { answerStyleInstruction } from '../requests/answerStyle';
import {
  buildRequestHeader,
  buildSupersededRequestsLine,
  buildWakeUpReminder,
  getWakeUpMessage,
  joinPromptsNotTakenIn,
} from '../requests/requestHeader';
import type { OpenRequestState } from '../requests/types';

function createOpenRequest(id: string, prompt: string | undefined, isPromptTakenIn: boolean | undefined): OpenRequestState {
  return {
    id,
    origin: { kind: 'message', attributes: {} },
    createdAt: 1,
    progressAnswerCount: 0,
    silentTurnCount: 0,
    wakeCount: 0,
    isWakeStopped: false,
    ...(prompt !== undefined ? { prompt } : {}),
    ...(isPromptTakenIn !== undefined ? { isPromptTakenIn } : {}),
  };
}

describe('buildRequestHeader', () => {
  it('names the request, its origin and the answer_request call, then a blank line', () => {
    const header = buildRequestHeader({
      requestId: 'req_AbCd1234',
      originDescription: 'a message in this topic',
      isPlainTextHidden: false,
    });
    assert.ok(header.startsWith('[Request req_AbCd1234 · from: a message in this topic]\n'));
    assert.match(header, /answer_request tool \(requestId "req_AbCd1234"\)/);
    assert.doesNotMatch(header, /does not see your plain text|your thinking/);
    assert.ok(header.endsWith('\n\n'));
  });

  it('asks for an answer a manager or QA can read — the shared style sentence, right after the answer_request line', () => {
    for (const isPlainTextHidden of [false, true]) {
      const lines = buildRequestHeader({ requestId: 'req_AbCd1234', originDescription: 'a message in this topic', isPlainTextHidden }).split('\n');
      assert.match(lines[1], /^Answer it with the answer_request tool/);
      assert.equal(lines[2], answerStyleInstruction, `isPlainTextHidden ${isPlainTextHidden}`);
    }
  });

  it('warns that plain text and thinking are not shown when the requester cannot see them', () => {
    const header = buildRequestHeader({
      requestId: 'req_AbCd1234',
      originDescription: 'PROJ-123 assigned to you',
      isPlainTextHidden: true,
    });
    assert.match(header, /does not see your plain text output or your thinking — only what you send through answer_request reaches them\./);
  });

  it('names the replaced requests and asks for only what this one adds, honest in both timings', () => {
    const header = buildRequestHeader({
      requestId: 'req_Cccc3333',
      originDescription: 'a message in this topic',
      isPlainTextHidden: false,
      supersededRequestIds: ['req_Aaaa1111', 'req_Bbbb2222'],
    });
    const lines = header.trimEnd().split('\n');
    assert.equal(lines.length, 4);
    const supersededLine = lines[3];
    assert.equal(supersededLine, buildSupersededRequestsLine(['req_Aaaa1111', 'req_Bbbb2222']));
    assert.match(supersededLine, /earlier requests req_Aaaa1111, req_Bbbb2222\./);
    // The agent may have answered them already (a message written mid-turn reaches it only after the turn
    // ends) or not yet: the line must hold either way.
    assert.match(supersededLine, /If you already answered them, do not repeat that answer: reply only to what this message adds/);
    assert.match(supersededLine, /If it adds nothing new, say briefly that the answer is above/);
    assert.doesNotMatch(supersededLine, /still unanswered|one answer .* covers/, 'never claims the replaced requests are unanswered or that one answer covers all');
  });

  it('says nothing about replaced requests when there are none', () => {
    const header = buildRequestHeader({ requestId: 'req_AbCd1234', originDescription: 'a message in this topic', isPlainTextHidden: false, supersededRequestIds: [] });
    assert.doesNotMatch(header, /replaces/);
    assert.equal(buildSupersededRequestsLine([]), '');
  });

  it('the replaced-requests line uses the singular for one request', () => {
    assert.match(buildSupersededRequestsLine(['req_Aaaa1111']), /earlier request req_Aaaa1111\. If you already answered it, do not repeat that answer/);
  });
});

describe('buildWakeUpReminder', () => {
  it('names the open request and the reason, asks for answer_request, and carries the shared style sentence', () => {
    const lines = buildWakeUpReminder({ requestId: 'req_AbCd1234', reason: 'silentTurn' }).split('\n');
    assert.equal(lines[0], '[Reminder · request req_AbCd1234 is still open]');
    assert.equal(lines[1], 'Your last turn ended without answering it.');
    assert.match(lines[2], /^Answer it with answer_request \(requestId "req_AbCd1234"\): kind "final" if the work is done/);
    assert.equal(lines[3], answerStyleInstruction);
    assert.equal(lines.length, 4);
  });

  it('every reason\'s reminder carries the style sentence, and a request\'s own prompt (not a reminder) is forwarded untouched', () => {
    for (const reason of ['silentTurn', 'progressFollowUp', 'backstop', 'postRetry'] as const) {
      assert.ok(buildWakeUpReminder({ requestId: 'req_AbCd1234', reason }).includes(answerStyleInstruction), reason);
    }
    const reminder = getWakeUpMessage(createOpenRequest('req_1', undefined, undefined), 'backstop');
    assert.equal(reminder.isRequestPrompt, false);
    assert.ok(reminder.text.includes(answerStyleInstruction));
    const prompt = getWakeUpMessage(createOpenRequest('req_2', '[Request req_2] the prompt', false), 'postRetry');
    assert.equal(prompt.isRequestPrompt, true);
    assert.equal(prompt.text, '[Request req_2] the prompt');
  });
});

describe('joinPromptsNotTakenIn', () => {
  it('joins the untaken prompts in order and skips taken-in or promptless requests', () => {
    const joined = joinPromptsNotTakenIn([
      createOpenRequest('req_1', '[Request req_1] first', undefined),
      createOpenRequest('req_2', '[Request req_2] taken', true),
      createOpenRequest('req_3', undefined, undefined),
      createOpenRequest('req_4', '[Request req_4] fourth', false),
    ]);
    assert.equal(joined, '[Request req_1] first\n\n[Request req_4] fourth');
  });

  it('is undefined when nothing is left to post', () => {
    assert.equal(joinPromptsNotTakenIn([]), undefined);
    assert.equal(joinPromptsNotTakenIn([createOpenRequest('req_2', '[Request req_2] taken', true)]), undefined);
  });
});
