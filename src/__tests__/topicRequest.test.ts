/**
 * @description Telegram request intake decisions (`utils/topicRequest.ts`,
 * request/answer plan S7): a prompt opens a request only in a view with
 * requests on and only when it is not a slash command forwarded to the agent;
 * the origin names the entry point and the requester (the merge key's part the
 * topic does not carry); the header tells the agent its plain text is hidden
 * exactly in the answers-only view and names the requests it replaced.
 * Load-bearing: `bot.ts` applies
 * these at every entry point, so a wrong answer opens requests nobody sees
 * answered, or forwards `/compact` as work the agent owes an answer to.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { answerStyleInstruction } from '../requests/answerStyle';
import { topicViewOptions } from '../utils/topicView';
import {
  buildTopicRequestHeader,
  buildTopicRequestPrompt,
  checkShouldOpenTopicRequest,
  getTopicRequesterId,
  getTopicRequestOrigin,
  scheduledRunRequester,
  topicRequestSourceAttribute,
  type TopicRequestSource,
} from '../utils/topicRequest';
import { requestRequesterAttribute } from '../requests/requestGroup';
import { getWakeUpMessage, joinPromptsNotTakenIn } from '../requests/requestHeader';
import type { OpenRequestState } from '../requests/types';
import { getPromptWithMessageContext } from '../utils/messageContext';

const sources: readonly TopicRequestSource[] = ['text', 'voice', 'file', 'album', 'schedule', 'scheduledRun'];

describe('checkShouldOpenTopicRequest', () => {
  it('opens a request in the two views with requests on, never in the full stream', () => {
    assert.equal(checkShouldOpenTopicRequest('stream', false), false);
    assert.equal(checkShouldOpenTopicRequest('streamAnswers', false), true);
    assert.equal(checkShouldOpenTopicRequest('answers', false), true);
  });

  it('a slash command forwarded to the agent is never a request, whatever the view', () => {
    for (const view of topicViewOptions) assert.equal(checkShouldOpenTopicRequest(view, true), false, view);
  });
});

describe('getTopicRequestOrigin', () => {
  it('a scheduled run is its own origin kind; every operator entry point is a message', () => {
    assert.equal(getTopicRequestOrigin({ source: 'scheduledRun', requesterId: scheduledRunRequester }).kind, 'scheduledRun');
    for (const source of sources.filter((candidate) => candidate !== 'scheduledRun')) {
      assert.equal(getTopicRequestOrigin({ source, requesterId: '424242' }).kind, 'message', source);
    }
  });

  it('records the entry point and the requester in the attributes — the ledger merges by requester', () => {
    for (const source of sources) {
      const origin = getTopicRequestOrigin({ source, requesterId: '424242' });
      assert.equal(origin.attributes[topicRequestSourceAttribute], source);
      assert.equal(origin.attributes[requestRequesterAttribute], '424242');
    }
  });
});

describe('getTopicRequesterId', () => {
  it('is the sending user\'s id as text; a message without a sender has the empty requester', () => {
    assert.equal(getTopicRequesterId({ id: 424242 }), '424242');
    assert.equal(getTopicRequesterId(undefined), '');
  });

  it('the scheduler is a requester of its own, never a person', () => {
    assert.notEqual(scheduledRunRequester, '');
    assert.doesNotMatch(scheduledRunRequester, /^\d+$/);
  });
});

describe('buildTopicRequestHeader', () => {
  it('names the request id and the entry point, and ends before the prompt text', () => {
    const header = buildTopicRequestHeader('req_abc', 'voice', 'streamAnswers');
    assert.match(header, /^\[Request req_abc · from: a voice message in this topic\]\n/);
    assert.match(header, /answer_request/);
    assert.ok(header.endsWith('\n\n'));
  });

  it('carries the shared answer-style sentence in every view, whether the plain text is hidden or shown', () => {
    for (const view of ['answers', 'streamAnswers', 'stream'] as const) {
      assert.ok(buildTopicRequestHeader('req_abc', 'text', view).split('\n').includes(answerStyleInstruction), view);
    }
  });

  it('tells the agent its plain text and thinking are not shown ONLY in the answers-only view', () => {
    const hiddenLine = /does not see your plain text output or your thinking/;
    assert.match(buildTopicRequestHeader('req_abc', 'text', 'answers'), hiddenLine);
    assert.doesNotMatch(buildTopicRequestHeader('req_abc', 'text', 'streamAnswers'), hiddenLine);
    assert.doesNotMatch(buildTopicRequestHeader('req_abc', 'text', 'stream'), hiddenLine);
  });

  it('names the requests it replaced and asks for only what this one adds; silent when it replaced none', () => {
    const merged = buildTopicRequestHeader('req_c', 'text', 'streamAnswers', ['req_a', 'req_b']);
    assert.match(merged, /replaces the same requester's earlier requests req_a, req_b/);
    assert.match(merged, /reply only to what this message adds/);
    assert.doesNotMatch(buildTopicRequestHeader('req_c', 'text', 'streamAnswers'), /replaces/);
  });

  it('every entry point has its own description', () => {
    const descriptions = new Set(sources.map((source) => /from: ([^\]]+)\]/.exec(buildTopicRequestHeader('req_abc', source, 'answers'))?.[1]));
    assert.equal(descriptions.size, sources.length);
    assert.ok(!descriptions.has(undefined));
  });
});

describe('the prompt a topic request keeps', () => {
  const forwardedMark = '[Forwarded message · from: channel "Ops Alerts" · originally sent: 2026-11-06T14:20:00+04:00]';
  const quoteBlock = ['[Replying to an earlier message · from: assistant]', '> The build failed'].join('\n');
  const forwardedWords = 'ALERT: disk 91% on web-1';

  /** A request whose prompt the session never took in (a failed post, a restart, a usage-limit wait), as the ledger keeps it. */
  function createUntakenRequest(promptBody: string): OpenRequestState {
    return {
      id: 'req_abc',
      origin: { kind: 'message', attributes: {} },
      createdAt: 1,
      progressAnswerCount: 0,
      silentTurnCount: 0,
      wakeCount: 0,
      isWakeStopped: false,
      prompt: buildTopicRequestPrompt({ requestId: 'req_abc', source: 'text', view: 'streamAnswers', supersededRequestIds: [], promptBody }),
    };
  }

  it('is the header ahead of the body, and the body is exactly what is posted', () => {
    const prompt = buildTopicRequestPrompt({ requestId: 'req_abc', source: 'text', view: 'streamAnswers', supersededRequestIds: ['req_a'], promptBody: 'hello' });
    assert.equal(prompt, `${buildTopicRequestHeader('req_abc', 'text', 'streamAnswers', ['req_a'])}hello`);
  });

  it('a forwarded message re-posted from the ledger still carries its mark — a replay never turns it into the operator\'s own words', () => {
    const body = getPromptWithMessageContext(forwardedWords, { context: { block: forwardedMark, isForwarded: true }, isShellInput: false });
    const request = createUntakenRequest(body);
    for (const replayed of [joinPromptsNotTakenIn([request]), getWakeUpMessage(request, 'postRetry').text]) {
      assert.ok(replayed?.endsWith(`${forwardedMark}\n\n${forwardedWords}`), `the replayed prompt keeps the mark ahead of the words:\n${replayed}`);
    }
  });

  it('a reply re-posted from the ledger keeps its quote too', () => {
    const body = getPromptWithMessageContext('why?', { context: { block: quoteBlock, isForwarded: false }, isShellInput: false });
    assert.ok(joinPromptsNotTakenIn([createUntakenRequest(body)])?.endsWith(`${quoteBlock}\n\nwhy?`));
  });
});
