/**
 * Test case: N/A — Charness has no Jira tracker
 *
 * @description The pure layer behind the `/model` picker's "Recently used"
 * shortcut (`utils/modelRecentPlan.ts`): the most-recently-used list (head
 * insert, dedupe, cap), the catalog filter that keeps a stale entry from
 * rendering a button that resolves to nothing, and the stale-tap safety of the
 * flat list's callbacks — the list is reordered by every pick, so a keyboard
 * left in the history must never apply a model other than the one printed on
 * its button.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildModelCatalog, checkIsCallbackDataWithinLimit } from '../utils/modelPickerPlan';
import {
  buildRecentModelPickCallback,
  getRecentModelIdentity,
  getRecentModelPick,
  getRecentModelsInCatalog,
  parseRecentModelPickCallback,
  pushRecentModel,
  recentModelPickCallbackRe,
  recentModelsLimit,
  recentModelsOpenCallback,
} from '../utils/modelRecentPlan';

const openCodeAdapterLabel = 'OpenCode';

// ─── the list ────────────────────────────────────────────────────────────────

test('pushRecentModel: a new pick goes to the head, the input is untouched', () => {
  const before = ['openai/gpt-5', 'anthropic/claude-sonnet-4-5'];
  const after = pushRecentModel(before, 'openrouter/vendor/model');
  assert.deepEqual(after, ['openrouter/vendor/model', 'openai/gpt-5', 'anthropic/claude-sonnet-4-5']);
  assert.deepEqual(before, ['openai/gpt-5', 'anthropic/claude-sonnet-4-5'], 'pure — never mutates');
});

test('pushRecentModel: a repeat pick MOVES its entry to the head instead of duplicating it', () => {
  const after = pushRecentModel(['a/1', 'b/2', 'c/3'], 'c/3');
  assert.deepEqual(after, ['c/3', 'a/1', 'b/2']);
});

test('pushRecentModel: the oldest entry falls off at the cap', () => {
  let list: string[] = [];
  for (let i = 0; i < recentModelsLimit + 3; i++) list = pushRecentModel(list, `p/m-${i}`);
  assert.equal(list.length, recentModelsLimit);
  assert.equal(list[0], `p/m-${recentModelsLimit + 2}`, 'newest first');
  assert.equal(list.at(-1), 'p/m-3', 'm-0, m-1, m-2 were evicted');
});

test('pushRecentModel: whitespace is trimmed and an empty id adds nothing', () => {
  assert.deepEqual(pushRecentModel(['a/1'], '  b/2 '), ['b/2', 'a/1']);
  assert.deepEqual(pushRecentModel(['a/1'], '   '), ['a/1']);
});

// ─── the catalog filter ──────────────────────────────────────────────────────

test('getRecentModelsInCatalog: drops entries the live catalog no longer serves, keeps order', () => {
  const catalog = buildModelCatalog(
    ['anthropic/claude-sonnet-4-5', 'openai/gpt-5', 'openrouter/vendor/model-1'],
    openCodeAdapterLabel,
    [],
  );
  const recent = [
    'openrouter/vendor/model-1',
    'openai/gpt-4', // the server stopped serving this model
    'google/gemini', // the whole provider was disconnected
    'anthropic/claude-sonnet-4-5',
  ];
  assert.deepEqual(getRecentModelsInCatalog(recent, catalog), [
    'openrouter/vendor/model-1',
    'anthropic/claude-sonnet-4-5',
  ]);
});

test('getRecentModelsInCatalog: a HIDDEN provider is unreachable through the shortcut too', () => {
  const catalog = buildModelCatalog(
    ['anthropic/claude-sonnet-4-5', 'openrouter/vendor/model-1'],
    openCodeAdapterLabel,
    ['openrouter'],
  );
  assert.deepEqual(
    getRecentModelsInCatalog(['openrouter/vendor/model-1', 'anthropic/claude-sonnet-4-5'], catalog),
    ['anthropic/claude-sonnet-4-5'],
  );
});

test('getRecentModelsInCatalog: a slash-less entry can never match (no provider to hop between)', () => {
  const catalog = buildModelCatalog(['sonnet', 'opus'], 'Claude Code', []);
  assert.deepEqual(getRecentModelsInCatalog(['sonnet'], catalog), []);
});

test('getRecentModelsInCatalog: a nested id matches on the FIRST segment only', () => {
  const catalog = buildModelCatalog(['openrouter/anthropic/claude-sonnet-4.5'], openCodeAdapterLabel, []);
  assert.deepEqual(
    getRecentModelsInCatalog(['openrouter/anthropic/claude-sonnet-4.5'], catalog),
    ['openrouter/anthropic/claude-sonnet-4.5'],
  );
});

// ─── the callbacks ───────────────────────────────────────────────────────────

test('callback codec: round-trips index + identity and stays inside the 64-byte budget', () => {
  const longId = 'openrouter/some-vendor-name/a-fairly-long-model-identifier-42:free';
  const callback = buildRecentModelPickCallback(9, longId);
  assert.ok(checkIsCallbackDataWithinLimit(callback), callback);
  assert.ok(checkIsCallbackDataWithinLimit(recentModelsOpenCallback));
  assert.match(callback, recentModelPickCallbackRe);
  assert.deepEqual(parseRecentModelPickCallback(callback), {
    index: 9,
    identity: getRecentModelIdentity(longId),
  });
  assert.equal(parseRecentModelPickCallback('mdlr_9'), null);
  assert.equal(parseRecentModelPickCallback('mdl_0_1'), null, 'the model-level codec is a different prefix');
});

test('getRecentModelPick: a fresh keyboard resolves by index', () => {
  const list = ['a/1', 'b/2', 'c/3'];
  const ref = parseRecentModelPickCallback(buildRecentModelPickCallback(1, 'b/2'));
  assert.ok(ref);
  assert.equal(getRecentModelPick(list, ref), 'b/2');
});

test('getRecentModelPick: after a reorder, an old button still applies the model PRINTED on it', () => {
  // The user opened the list, then (from another topic, say) picked c/3, which
  // moved to the head. The old keyboard's index 1 now points at a/1 — tapping
  // "b/2" must still mean b/2.
  const oldList = ['a/1', 'b/2', 'c/3'];
  const ref = parseRecentModelPickCallback(buildRecentModelPickCallback(1, 'b/2'));
  assert.ok(ref);
  const newList = pushRecentModel(oldList, 'c/3');
  assert.equal(newList[1], 'a/1', 'the index now addresses a different entry');
  assert.equal(getRecentModelPick(newList, ref), 'b/2');
});

test('getRecentModelPick: an entry that left the list is REFUSED, never substituted', () => {
  const ref = parseRecentModelPickCallback(buildRecentModelPickCallback(0, 'gone/model'));
  assert.ok(ref);
  assert.equal(getRecentModelPick(['a/1', 'b/2'], ref), null);
  assert.equal(getRecentModelPick([], ref), null);
});

test('getRecentModelIdentity: stable, 8 hex chars, distinct for distinct ids', () => {
  const identity = getRecentModelIdentity('anthropic/claude-sonnet-4-5');
  assert.match(identity, /^[0-9a-f]{8}$/);
  assert.equal(identity, getRecentModelIdentity('anthropic/claude-sonnet-4-5'));
  assert.notEqual(identity, getRecentModelIdentity('anthropic/claude-sonnet-4-6'));
});
