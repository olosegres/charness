/**
 * Test case: N/A — Charness has no Jira tracker
 *
 * @description The pure layer behind the two-level `/model` picker.
 *
 * Two live bugs are pinned here:
 *   1. the 4096-char `/model` message (367 `openrouter` models rendered into
 *      ONE text) — the picker only works if every callback id stays inside
 *      Telegram's 64-BYTE `callback_data` budget, which is why they carry
 *      indexes instead of model names;
 *   2. `/model` on a Claude topic printing an EMPTY list — Claude reports
 *      slash-less aliases (`sonnet`, `opus`, `haiku`) and the old slash-only
 *      grouping dropped every one of them.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  buildModelCatalog,
  buildModelPickCallback,
  buildProviderHideCallback,
  buildProviderPageCallback,
  buildProviderShowCallback,
  checkHasProviderLevel,
  checkIsCallbackDataWithinLimit,
  getModelShortLabel,
  getProviderVisibility,
  groupModelsByProvider,
  modelPickCallbackRe,
  modelPickerBackCallback,
  modelPickerNoopCallback,
  parseModelPickCallback,
  parseProviderHideCallback,
  parseProviderPageCallback,
  parseProviderShowCallback,
  providerHideCallbackRe,
  providerPageCallbackRe,
  providerShowCallbackRe,
  telegramCallbackDataMaxBytes,
} from '../utils/modelPickerPlan';

const claudeAdapterLabel = 'Claude Code';

// ─── grouping ────────────────────────────────────────────────────────────────

test('groupModelsByProvider: splits on the FIRST slash, keeping the full id', () => {
  const grouped = groupModelsByProvider(
    [
      'anthropic/claude-opus-4-8',
      'anthropic/claude-sonnet-4-5',
      'openrouter/anthropic/claude-sonnet-4.5',
    ],
    claudeAdapterLabel,
  );
  assert.deepEqual([...grouped.keys()], ['anthropic', 'openrouter']);
  assert.deepEqual(grouped.get('anthropic'), [
    'anthropic/claude-opus-4-8',
    'anthropic/claude-sonnet-4-5',
  ]);
  // A nested id keeps its whole path — only the FIRST segment is the provider.
  assert.deepEqual(grouped.get('openrouter'), ['openrouter/anthropic/claude-sonnet-4.5']);
});

test('groupModelsByProvider: slash-less ids land under the fallback provider', () => {
  // THE Claude bug: the old slash-only grouping returned an empty map here, so
  // `/model` rendered a header and nothing else.
  const grouped = groupModelsByProvider(['sonnet', 'opus', 'haiku'], claudeAdapterLabel);
  assert.deepEqual([...grouped.keys()], [claudeAdapterLabel]);
  assert.deepEqual(grouped.get(claudeAdapterLabel), ['sonnet', 'opus', 'haiku']);
});

test('groupModelsByProvider: a leading slash is not a provider segment', () => {
  // `indexOf('/') > 0` — a leading slash leaves an EMPTY provider, so the id
  // must fall back rather than create a nameless group.
  const grouped = groupModelsByProvider(['/weird-id'], claudeAdapterLabel);
  assert.deepEqual([...grouped.keys()], [claudeAdapterLabel]);
});

test('groupModelsByProvider: mixed catalog keeps insertion order in both dimensions', () => {
  // Callback ids carry INDEXES into these orders, so a reshuffle would resolve
  // a tap to the wrong model.
  const grouped = groupModelsByProvider(
    ['zeta/one', 'alpha/one', 'zeta/two', 'bare-alias'],
    claudeAdapterLabel,
  );
  assert.deepEqual([...grouped.keys()], ['zeta', 'alpha', claudeAdapterLabel]);
  assert.deepEqual(grouped.get('zeta'), ['zeta/one', 'zeta/two']);
});

test('groupModelsByProvider: an empty catalog yields an empty map', () => {
  assert.equal(groupModelsByProvider([], claudeAdapterLabel).size, 0);
});

test('getModelShortLabel: strips the redundant provider prefix, keeps a bare alias whole', () => {
  assert.equal(getModelShortLabel('anthropic/claude-opus-4-8', 'anthropic'), 'claude-opus-4-8');
  assert.equal(
    getModelShortLabel('openrouter/anthropic/claude-sonnet-4.5', 'openrouter'),
    'anthropic/claude-sonnet-4.5',
  );
  assert.equal(getModelShortLabel('sonnet', claudeAdapterLabel), 'sonnet');
});

// ─── visibility split ────────────────────────────────────────────────────────

test('getProviderVisibility: splits the catalog, keeping catalog order in both lists', () => {
  const { visible, hidden } = getProviderVisibility(
    ['anthropic', 'openrouter', 'openai', 'google'],
    ['openrouter', 'google'],
  );
  assert.deepEqual(visible, ['anthropic', 'openai']);
  assert.deepEqual(hidden, ['openrouter', 'google']);
});

test('getProviderVisibility: nothing hidden → everything visible', () => {
  const { visible, hidden } = getProviderVisibility(['anthropic', 'openai'], []);
  assert.deepEqual(visible, ['anthropic', 'openai']);
  assert.deepEqual(hidden, []);
});

test('getProviderVisibility: a hidden name absent from the catalog is ignored', () => {
  // A leftover from a provider that was disconnected since — it must not
  // render an unhide button that resolves to nothing.
  const { visible, hidden } = getProviderVisibility(['anthropic'], ['retired-provider']);
  assert.deepEqual(visible, ['anthropic']);
  assert.deepEqual(hidden, []);
});

test('getProviderVisibility: every provider hidden → the pick list is empty', () => {
  const { visible, hidden } = getProviderVisibility(['openrouter'], ['openrouter']);
  assert.deepEqual(visible, []);
  assert.deepEqual(hidden, ['openrouter']);
});

// ─── catalog assembly ────────────────────────────────────────────────────────

test('buildModelCatalog: groups, orders and partitions in one pass', () => {
  const catalog = buildModelCatalog(
    ['openrouter/a', 'anthropic/b', 'openrouter/c'],
    claudeAdapterLabel,
    ['openrouter'],
  );
  assert.deepEqual(catalog.providers, ['openrouter', 'anthropic']);
  assert.deepEqual(catalog.visibleProviders, ['anthropic']);
  assert.deepEqual(catalog.hiddenProviders, ['openrouter']);
  assert.deepEqual(catalog.byProvider.get('openrouter'), ['openrouter/a', 'openrouter/c']);
});

test('buildModelCatalog: an empty model list yields an empty catalog', () => {
  const catalog = buildModelCatalog([], claudeAdapterLabel, ['openrouter']);
  assert.deepEqual(catalog.providers, []);
  assert.deepEqual(catalog.visibleProviders, []);
  assert.deepEqual(catalog.hiddenProviders, [], 'a hidden name with no catalog entry is dropped');
});

// ─── level rule ──────────────────────────────────────────────────────────────

test('checkHasProviderLevel: a lone offered provider skips the provider level', () => {
  // The Claude case — one fallback group, nothing hidden.
  assert.equal(checkHasProviderLevel(1, 0), false);
});

test('checkHasProviderLevel: a hidden provider keeps the level (unhide lives there)', () => {
  assert.equal(checkHasProviderLevel(1, 1), true);
  assert.equal(checkHasProviderLevel(0, 2), true);
});

test('checkHasProviderLevel: several offered providers keep the level', () => {
  assert.equal(checkHasProviderLevel(4, 0), true);
});

// ─── callback codec ──────────────────────────────────────────────────────────

test('callback codec: every id round-trips through its parser', () => {
  assert.deepEqual(parseProviderPageCallback(buildProviderPageCallback(3, 7)), {
    providerIndex: 3,
    page: 7,
  });
  assert.deepEqual(parseModelPickCallback(buildModelPickCallback(2, 41)), {
    providerIndex: 2,
    modelIndex: 41,
  });
  assert.equal(parseProviderHideCallback(buildProviderHideCallback(5)), 5);
  assert.equal(parseProviderShowCallback(buildProviderShowCallback(0)), 0);
});

test('callback codec: the four shapes never match each other', () => {
  // `mdl_` is a prefix-neighbour of `mdlp_`/`mdlhide_`/`mdlshow_`, and all of
  // them share the `mdl` root with the static `mdlback`/`mdlnoop` ids — the
  // anchored regexes are what keep a tap from being dispatched to the wrong
  // handler.
  const ids = [
    buildProviderPageCallback(1, 2),
    buildModelPickCallback(1, 2),
    buildProviderHideCallback(1),
    buildProviderShowCallback(1),
    modelPickerBackCallback,
    modelPickerNoopCallback,
  ];
  const matchers = [
    providerPageCallbackRe,
    modelPickCallbackRe,
    providerHideCallbackRe,
    providerShowCallbackRe,
  ];
  for (const id of ids) {
    const matchCount = matchers.filter((re) => re.test(id)).length;
    assert.ok(matchCount <= 1, `"${id}" matched ${matchCount} patterns`);
  }
  // …and the legacy `model_<id>` button (still live for back-compat) shares no
  // prefix with any of them.
  for (const re of matchers) {
    assert.equal(re.test('model_anthropic/claude-opus-4-8'), false);
  }
});

test('callback codec: garbage and near-misses parse to null', () => {
  assert.equal(parseProviderPageCallback('mdlp_1'), null);
  assert.equal(parseProviderPageCallback('mdlp_a_1'), null);
  assert.equal(parseModelPickCallback('mdl_1'), null);
  assert.equal(parseProviderHideCallback('mdlhide_'), null);
  assert.equal(parseProviderShowCallback('mdlshowX'), null);
});

test('callback codec: every id fits Telegram\'s 64-byte callback_data budget', () => {
  // The whole reason the picker is index-based. `openrouter` alone ships 367
  // models across a catalog of ~20 providers, and the raw ids
  // (`openrouter/anthropic/claude-sonnet-4.5`) already exceed the budget —
  // so probe indexes far past any real catalog size.
  const extremeIndex = 999999;
  const ids = [
    buildProviderPageCallback(extremeIndex, extremeIndex),
    buildModelPickCallback(extremeIndex, extremeIndex),
    buildProviderHideCallback(extremeIndex),
    buildProviderShowCallback(extremeIndex),
    modelPickerBackCallback,
    modelPickerNoopCallback,
  ];
  for (const id of ids) {
    assert.ok(
      checkIsCallbackDataWithinLimit(id),
      `"${id}" is ${Buffer.byteLength(id)} bytes, over ${telegramCallbackDataMaxBytes}`,
    );
  }
  // Guard the guard: a raw model id is exactly what does NOT fit.
  assert.equal(
    checkIsCallbackDataWithinLimit(`mdl_${'openrouter/anthropic/claude-sonnet-4.5'.repeat(2)}`),
    false,
  );
});
