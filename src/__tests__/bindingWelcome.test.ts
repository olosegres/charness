import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSharedTopicList } from '../connectors/telegram/bindingWelcome';

const releaseNotesLink = 'https://t.me/c/1111111111/191';

test('a topic with a name is that name as inline code, trimmed', () => {
  assert.equal(formatSharedTopicList([{ name: '  Release notes ', link: releaseNotesLink }]), '`Release notes`');
});

test('a topic with no name, or a blank one, is its bare link', () => {
  assert.equal(formatSharedTopicList([{ name: undefined, link: releaseNotesLink }]), releaseNotesLink);
  assert.equal(formatSharedTopicList([{ name: '   ', link: releaseNotesLink }]), releaseNotesLink);
});

test('names and links are comma-separated in the order given', () => {
  assert.equal(
    formatSharedTopicList([{ name: 'Release notes', link: releaseNotesLink }, { name: undefined, link: 'https://t.me/c/1111111111/192' }]),
    '`Release notes`, https://t.me/c/1111111111/192',
  );
});

test('markdown characters of a name are safe inside the code span; a backtick, which cannot be escaped there, becomes an apostrophe', () => {
  assert.equal(formatSharedTopicList([{ name: 'Bind_Auto *x* [y]', link: releaseNotesLink }]), '`Bind_Auto *x* [y]`');
  assert.equal(formatSharedTopicList([{ name: 'the `fix` topic', link: releaseNotesLink }]), "`the 'fix' topic`");
});

test('no other topic gives an empty list', () => {
  assert.equal(formatSharedTopicList([]), '');
});

test('topics that are only counted (other chats, or none to name or link): the label the caller gives is the last item, after the named ones', () => {
  assert.equal(formatSharedTopicList([{ name: 'Release notes', link: releaseNotesLink }], '+2 more'), '`Release notes`, +2 more');
  assert.equal(formatSharedTopicList([{ name: undefined, link: releaseNotesLink }], '+1 more'), `${releaseNotesLink}, +1 more`);
});

test('with no topic of this chat the count stands alone; with none at all there is no list', () => {
  assert.equal(formatSharedTopicList([], '+3 more'), '+3 more');
  assert.equal(formatSharedTopicList([], null), '');
});
