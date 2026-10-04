/**
 * @description Telegram request intake decisions (`utils/topicRequest.ts`,
 * request/answer plan S7): a prompt opens a request only in a view with
 * requests on and only when it is not a slash command forwarded to the agent;
 * the origin names the entry point; the header tells the agent its plain text
 * is hidden exactly in the answers-only view. Load-bearing: `bot.ts` applies
 * these at every entry point, so a wrong answer opens requests nobody sees
 * answered, or forwards `/compact` as work the agent owes an answer to.
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { topicViewOptions } from '../utils/topicView';
import {
  buildTopicRequestHeader,
  checkShouldOpenTopicRequest,
  getTopicRequestOrigin,
  topicRequestSourceAttribute,
  type TopicRequestSource,
} from '../utils/topicRequest';

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
    assert.equal(getTopicRequestOrigin('scheduledRun').kind, 'scheduledRun');
    for (const source of sources.filter((candidate) => candidate !== 'scheduledRun')) {
      assert.equal(getTopicRequestOrigin(source).kind, 'message', source);
    }
  });

  it('records the entry point in the attributes', () => {
    for (const source of sources) assert.equal(getTopicRequestOrigin(source).attributes[topicRequestSourceAttribute], source);
  });
});

describe('buildTopicRequestHeader', () => {
  it('names the request id and the entry point, and ends before the prompt text', () => {
    const header = buildTopicRequestHeader('req_abc', 'voice', 'streamAnswers');
    assert.match(header, /^\[Request req_abc · from: a voice message in this topic\]\n/);
    assert.match(header, /answer_request/);
    assert.ok(header.endsWith('\n\n'));
  });

  it('tells the agent its plain text is not shown ONLY in the answers-only view', () => {
    const hiddenLine = /does not see your plain text/;
    assert.match(buildTopicRequestHeader('req_abc', 'text', 'answers'), hiddenLine);
    assert.doesNotMatch(buildTopicRequestHeader('req_abc', 'text', 'streamAnswers'), hiddenLine);
    assert.doesNotMatch(buildTopicRequestHeader('req_abc', 'text', 'stream'), hiddenLine);
  });

  it('every entry point has its own description', () => {
    const descriptions = new Set(sources.map((source) => /from: ([^\]]+)\]/.exec(buildTopicRequestHeader('req_abc', source, 'answers'))?.[1]));
    assert.equal(descriptions.size, sources.length);
    assert.ok(!descriptions.has(undefined));
  });
});
