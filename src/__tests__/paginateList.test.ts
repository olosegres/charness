/**
 * Test case: N/A — Charness has no Jira tracker
 *
 * @description The generic pagination core shared by the `/bind` folder picker
 * and the `/model` model picker. `paginateBindList` is now a thin wrapper over
 * it (its own behaviour stays covered in `validation.test.ts`), so these cases
 * pin the rules that BOTH pickers depend on — notably the clamp, which is what
 * keeps a stale callback from rendering an empty page.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { paginateList } from '../utils/paginateList';

test('paginateList: empty list still yields one page', () => {
  assert.deepEqual(paginateList([], 0, 10), { slice: [], currentPage: 0, totalPages: 1 });
});

test('paginateList: a list that fits is one page', () => {
  const result = paginateList(['a', 'b', 'c'], 0, 10);
  assert.deepEqual(result.slice, ['a', 'b', 'c']);
  assert.equal(result.totalPages, 1);
  assert.equal(result.currentPage, 0);
});

test('paginateList: slices a long list into pages of pageSize', () => {
  // 25 models at the `/model` page size — the last page is the short one.
  const models = Array.from({ length: 25 }, (_, i) => `m${i}`);
  const first = paginateList(models, 0, 10);
  const last = paginateList(models, 2, 10);
  assert.equal(first.totalPages, 3);
  assert.deepEqual(first.slice[0], 'm0');
  assert.equal(first.slice.length, 10);
  assert.deepEqual(last.slice, ['m20', 'm21', 'm22', 'm23', 'm24']);
});

test('paginateList: clamps an out-of-range page to the last one', () => {
  // Stale keyboard after the catalog shrank — must land on a real page, not
  // render an empty body.
  const result = paginateList(['a', 'b', 'c'], 99, 2);
  assert.equal(result.currentPage, 1);
  assert.deepEqual(result.slice, ['c']);
});

test('paginateList: clamps a negative page to 0 and floors a fractional one', () => {
  assert.equal(paginateList(['a', 'b', 'c', 'd'], -5, 2).currentPage, 0);
  assert.equal(paginateList(['a', 'b', 'c', 'd'], 1.9, 2).currentPage, 1);
});

test('paginateList: rejects a non-positive / non-integer pageSize', () => {
  assert.throws(() => paginateList(['a'], 0, 0), /pageSize/);
  assert.throws(() => paginateList(['a'], 0, -1), /pageSize/);
  assert.throws(() => paginateList(['a'], 0, 2.5), /pageSize/);
});

test('paginateList: is generic — it keeps the element type, not just strings', () => {
  const records = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const result = paginateList(records, 1, 2);
  assert.deepEqual(result.slice, [{ id: 3 }]);
});
