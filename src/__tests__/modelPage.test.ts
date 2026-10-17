/**
 * @description The model page shared by `/model`, the «add a fallback model» step and the provider pages of `/limits` and
 * `/accounts` (`connectors/telegram/commands/modelPage.ts`): a screen's own callback data on every button, ✓ and the limit
 * suffix on a caption, the arrows and the page pill only with more than one page, the back row only when the screen has a
 * level above, an out-of-range page clamped to the last one.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildModelPageButtons, modelPageSize, type ModelPageCallbacks } from '../connectors/telegram/commands/modelPage';
import { checkIsCallbackDataWithinLimit } from '../utils/modelPickerPlan';

const callbacks: ModelPageCallbacks = {
  buildPage: (page) => `pg_${page}`,
  buildPick: (modelIndex) => `pick_${modelIndex}`,
  noop: 'noop',
  back: { label: '⬅️ Back', data: 'back' },
};

const buildModels = (count: number): string[] => Array.from({ length: count }, (_, index) => `openrouter/model-${index + 1}`);

function readLabels(rows: ReturnType<typeof buildModelPageButtons>['rows']): string[][] {
  return rows.map((row) => row.map((button) => button.text));
}

function readData(rows: ReturnType<typeof buildModelPageButtons>['rows']): string[][] {
  return rows.map((row) => row.map((button) => (button.hide ? '' : (button as unknown as { callback_data: string }).callback_data)));
}

describe('buildModelPageButtons', () => {
  it('a short list is one page of full-width rows carrying the screen\'s pick data, with the back row last and no arrows', () => {
    const { rows, pageModels, totalPages } = buildModelPageButtons({ provider: 'openrouter', models: buildModels(3), page: 0, current: null, callbacks });
    assert.deepEqual(readLabels(rows), [['model-1'], ['model-2'], ['model-3'], ['⬅️ Back']], 'the provider prefix is stripped from a caption');
    assert.deepEqual(readData(rows), [['pick_0'], ['pick_1'], ['pick_2'], ['back']]);
    assert.deepEqual(pageModels, buildModels(3));
    assert.equal(totalPages, 1);
  });

  it('the ✓ marks the current model and a suffix follows the name, before the ✓', () => {
    const { rows } = buildModelPageButtons({
      provider: 'openrouter',
      models: buildModels(3),
      page: 0,
      current: 'openrouter/model-2',
      callbacks,
      getSuffix: (modelId) => (modelId === 'openrouter/model-2' || modelId === 'openrouter/model-3' ? ' ⛔ 14:00' : ''),
    });
    assert.deepEqual(readLabels(rows).slice(0, 3), [['model-1'], ['model-2 ⛔ 14:00 ✓'], ['model-3 ⛔ 14:00']]);
  });

  it('a long list pages: the pick index is the model\'s place in the WHOLE list, the arrows carry the neighbouring pages and the pill is inert', () => {
    const models = buildModels(modelPageSize * 2 + 3);
    const middle = buildModelPageButtons({ provider: 'openrouter', models, page: 1, current: null, callbacks });
    assert.equal(middle.pageModels.length, modelPageSize);
    assert.deepEqual(readData(middle.rows)[0], [`pick_${modelPageSize}`], 'the first model of page 2 is model number 11 of the list');
    const nav = middle.rows.at(-2)!;
    assert.deepEqual(nav.map((button) => button.text), ['⬅️ Prev', '2/3', 'Next ➡️']);
    assert.deepEqual(readData(middle.rows).at(-2), ['pg_0', 'noop', 'pg_2']);

    const first = buildModelPageButtons({ provider: 'openrouter', models, page: 0, current: null, callbacks });
    assert.deepEqual(readData(first.rows).at(-2), ['noop', 'pg_1'], 'no «previous» on the first page');
    const last = buildModelPageButtons({ provider: 'openrouter', models, page: 2, current: null, callbacks });
    assert.deepEqual(readData(last.rows).at(-2), ['pg_1', 'noop'], 'no «next» on the last page');
    assert.equal(last.pageModels.length, 3);
  });

  it('a stale page past the end lands on the last page', () => {
    const { currentPage, pageModels } = buildModelPageButtons({ provider: 'openrouter', models: buildModels(modelPageSize + 1), page: 99, current: null, callbacks });
    assert.equal(currentPage, 1);
    assert.deepEqual(pageModels, ['openrouter/model-11']);
  });

  it('a screen with no level above passes no back and gets no back row', () => {
    const { rows } = buildModelPageButtons({ provider: 'openrouter', models: buildModels(2), page: 0, current: null, callbacks: { ...callbacks, back: null } });
    assert.deepEqual(readLabels(rows), [['model-1'], ['model-2']]);
  });

  it('a model id that does not start with the provider is shown whole (a Claude alias under the adapter label)', () => {
    const { rows } = buildModelPageButtons({ provider: 'Claude Code', models: ['fable', 'opus'], page: 0, current: 'opus', callbacks });
    assert.deepEqual(readLabels(rows).slice(0, 2), [['fable'], ['opus ✓']]);
  });

  it('every button data the shared builders produce fits Telegram\'s 64 bytes', () => {
    const { rows } = buildModelPageButtons({ provider: 'openrouter', models: buildModels(modelPageSize * 3), page: 1, current: null, callbacks });
    for (const data of readData(rows).flat()) assert.ok(checkIsCallbackDataWithinLimit(data), data);
  });
});
