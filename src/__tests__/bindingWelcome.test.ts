import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSharedTopicList, getSharedTopicLabel } from '../connectors/telegram/bindingWelcome';

test('a topic is called by its stored name, trimmed', () => {
  assert.equal(getSharedTopicLabel('  Release notes ', '-1001111111111:191'), 'Release notes');
});

test('a topic with no stored name, or a blank one, is called by its key', () => {
  assert.equal(getSharedTopicLabel(undefined, '-1001111111111:191'), '-1001111111111:191');
  assert.equal(getSharedTopicLabel('   ', '-1001111111111:191'), '-1001111111111:191');
});

test('the labels are inline code, comma-separated', () => {
  assert.equal(formatSharedTopicList(['Release notes', '-1001111111111:191']), '`Release notes`, `-1001111111111:191`');
});

test('markdown characters of a name are safe inside the code span; a backtick, which cannot be escaped there, becomes an apostrophe', () => {
  assert.equal(formatSharedTopicList(['Bind_Auto *x* [y]']), '`Bind_Auto *x* [y]`');
  assert.equal(formatSharedTopicList(['the `fix` topic']), "`the 'fix' topic`");
});

test('no other topic gives an empty list', () => {
  assert.equal(formatSharedTopicList([]), '');
});
