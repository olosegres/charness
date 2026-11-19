/**
 * @description The caption cut shared by the screens whose buttons name something the owner wrote (`utils/cutButtonLabel.ts`): kept whole
 * when it fits, otherwise cut to the limit with an ellipsis on a grapheme boundary — a family emoji is never split in half.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cutButtonLabel } from '../utils/cutButtonLabel';

test('cutButtonLabel: a caption that fits is kept whole, the limit itself included', () => {
  assert.equal(cutButtonLabel('short', 30), 'short');
  assert.equal(cutButtonLabel('x'.repeat(30), 30), 'x'.repeat(30));
});

test('cutButtonLabel: a long caption is cut to the limit with an ellipsis, on a grapheme boundary', () => {
  const cut = cutButtonLabel('A'.repeat(60), 30);
  assert.equal(cut.length, 30);
  assert.ok(cut.endsWith('…'));
  const family = ['👨', '👩', '👧', '👦'].join('‍');
  const cutFamilies = cutButtonLabel(`${'x'.repeat(28)}${family}${family}${family}`, 30);
  assert.equal(cutFamilies, `${'x'.repeat(28)}${family}…`, 'cut between two families, none split in half');
  assert.equal([...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(cutFamilies)].length, 30);
});
