/**
 * @description Coverage for the one surrogate-safe cut (`utils/surrogateSafeCut.ts`) that the output trace's preview, the Jira
 * comment splitter and a check's status line share: a cut never ends on the first half of an emoji, whatever the limit.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cutTextSurrogateSafe, getSurrogateSafeCutIndex } from '../utils/surrogateSafeCut';

const rocket = '🚀';
/** A high surrogate with no low one after it, or the reverse: what a plain `slice` leaves of a split emoji. */
const loneSurrogatePattern = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

test('a text that fits is not cut', () => {
  assert.equal(getSurrogateSafeCutIndex('abc', 3), 3);
  assert.equal(getSurrogateSafeCutIndex('abc', 10), 3);
  assert.equal(cutTextSurrogateSafe(`ab${rocket}`, 4), `ab${rocket}`);
});

test('plain text is cut exactly at the limit', () => {
  assert.equal(getSurrogateSafeCutIndex('abcdef', 4), 4);
  assert.equal(cutTextSurrogateSafe('abcdef', 4), 'abcd');
});

test('a cut that would end between the halves of an emoji moves back before it', () => {
  const text = `abcd${rocket}tail`;
  // Index 4 is the emoji's first half, 5 its second: a limit of 5 keeps only the first.
  assert.equal(getSurrogateSafeCutIndex(text, 5), 4);
  assert.equal(cutTextSurrogateSafe(text, 5), 'abcd');
  assert.equal(cutTextSurrogateSafe(text, 6), `abcd${rocket}`, 'a limit that holds the whole emoji keeps it');
  for (let limit = 1; limit < text.length; limit += 1) {
    assert.doesNotMatch(cutTextSurrogateSafe(text, limit), loneSurrogatePattern, `limit ${limit}`);
  }
});

test('a limit of one is cut as asked, so a loop over the rest of a text always makes progress', () => {
  assert.equal(getSurrogateSafeCutIndex(`${rocket}x`, 1), 1);
  assert.equal(getSurrogateSafeCutIndex('abc', 0), 0);
});
