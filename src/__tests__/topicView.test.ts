/**
 * @description The per-topic view vocabulary (`utils/topicView.ts`,
 * request/answer plan S6): the three views in picker order, the locked
 * `stream` default (nothing changes until a topic is switched), the typed
 * `/verbosity` spellings, and the two decisions every reader of a view makes —
 * whether the agent's stream is shown and whether requests are on. Load-bearing:
 * the stream gates and the request intake both read these, so a wrong answer
 * here hides a topic's output or opens requests in a topic that never shows
 * their answers.
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkAreRequestsEnabled,
  checkIsStreamShown,
  checkIsTopicView,
  defaultTopicView,
  parseTopicView,
  topicViewArguments,
  topicViewOptions,
} from '../utils/topicView';

describe('topicViewOptions + default', () => {
  it('exactly three views in picker order: stream, streamAnswers, answers', () => {
    assert.deepEqual([...topicViewOptions], ['stream', 'streamAnswers', 'answers']);
  });

  it('the locked default is the full stream — a topic behaves as before until it is switched', () => {
    assert.equal(defaultTopicView, 'stream');
  });
});

describe('parseTopicView', () => {
  it('accepts the documented typed spellings', () => {
    assert.equal(parseTopicView('stream'), 'stream');
    assert.equal(parseTopicView('stream_answers'), 'streamAnswers');
    assert.equal(parseTopicView('answers'), 'answers');
  });

  it('accepts the persisted spelling a picker button carries', () => {
    for (const view of topicViewOptions) assert.equal(parseTopicView(view), view);
  });

  it('rejects anything else, including undefined and a detail level', () => {
    assert.equal(parseTopicView(undefined), null);
    assert.equal(parseTopicView(''), null);
    assert.equal(parseTopicView('minimal'), null);
    assert.equal(parseTopicView('Answers'), null);
  });

  it('every view has a typed spelling that parses back to it', () => {
    for (const view of topicViewOptions) assert.equal(parseTopicView(topicViewArguments[view]), view);
  });
});

describe('checkIsTopicView — the guard accepts only the persisted spelling', () => {
  it('accepts every view and rejects the typed spelling of stream_answers', () => {
    for (const view of topicViewOptions) assert.equal(checkIsTopicView(view), true, view);
    assert.equal(checkIsTopicView('stream_answers'), false);
  });
});

describe('what each view decides', () => {
  it('the stream is shown in every view but answers-only', () => {
    assert.equal(checkIsStreamShown('stream'), true);
    assert.equal(checkIsStreamShown('streamAnswers'), true);
    assert.equal(checkIsStreamShown('answers'), false);
  });

  it('requests are on in every view but the full stream', () => {
    assert.equal(checkAreRequestsEnabled('stream'), false);
    assert.equal(checkAreRequestsEnabled('streamAnswers'), true);
    assert.equal(checkAreRequestsEnabled('answers'), true);
  });
});
