/**
 * @description `getTopicNameOrFolder`: how a topic is named when the bot knows no better — its forum name, else its folder.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { getTopicNameOrFolder } from '../utils/topicLabel';

test('a topic with a name is named by it; one the bot never learned the name of, by its folder', () => {
  assert.equal(getTopicNameOrFolder({ topicName: 'Design', subdir: 'api-proj' }), 'Design');
  assert.equal(getTopicNameOrFolder({ subdir: 'api-proj' }), 'api-proj');
  assert.equal(getTopicNameOrFolder({ topicName: '', subdir: 'api-proj' }), 'api-proj', 'an empty name is no name');
});

test('a topic with no binding is named by nothing: the caller picks its own last resort', () => {
  assert.equal(getTopicNameOrFolder(undefined), null);
  assert.equal(getTopicNameOrFolder(null), null, 'the state store answers `null` for an unbound topic');
});
