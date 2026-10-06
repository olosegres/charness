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
import { topicViewOptions } from '../utils/topicView';
import {
  buildTopicRequestHeader,
  checkShouldOpenTopicRequest,
  getTopicRequesterId,
  getTopicRequestOrigin,
  scheduledRunRequester,
  topicRequestSourceAttribute,
  type TopicRequestSource,
} from '../utils/topicRequest';
import { requestRequesterAttribute } from '../requests/requestGroup';

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
