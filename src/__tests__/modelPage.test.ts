/**
 * @description The model page shared by `/model`, the «add a fallback model» step and the provider pages of `/limits` and
 * `/accounts` (`connectors/telegram/commands/modelPage.ts`): a screen's own callback data on every button, ✓ and the limit
 * suffix on a caption, the arrows and the page pill only with more than one page, the back row only when the screen has a
 * level above, an out-of-range page clamped to the last one.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildModelPageButtons,
  buildOpenCodeProviderPage,
  decideProviderTap,
  handleModelPick,
  handleProviderTap,
  modelPageSize,
  type ModelPageCallbacks,
  type ProviderPickDeps,
} from '../connectors/telegram/commands/modelPage';
import type { SessionKey } from '../sessionKey';
import type { FallbackChainEntry } from '../utils/fallbackChain';
import type { OperatorSwitchOutcome } from '../utils/operatorSwitchPlan';
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

// ── the provider pick the `/limits` board and `/accounts` share ──

const topicKey: SessionKey = { platform: 'telegram', space: '-1001111111111', thread: '111' };

describe('decideProviderTap', () => {
  it('a provider with no model is out of date; ONE model not yet in use is switched at once; the topic\'s own provider, or several models, open the page', () => {
    assert.equal(decideProviderTap({ models: [], isHere: false }), 'stale');
    assert.equal(decideProviderTap({ models: [], isHere: true }), 'stale');
    assert.equal(decideProviderTap({ models: ['only'], isHere: false }), 'switchNow');
    assert.equal(decideProviderTap({ models: ['only'], isHere: true }), 'page');
    assert.equal(decideProviderTap({ models: ['a', 'b'], isHere: false }), 'page');
    assert.equal(decideProviderTap({ models: ['a', 'b'], isHere: true }), 'page');
  });
});

describe('buildOpenCodeProviderPage', () => {
  const rung: FallbackChainEntry = { backend: 'opencode', providerId: 'openai', modelId: 'gpt-5' };
  const nowMs = Date.parse('2026-10-17T10:00:00Z');

  it('titles the page «OpenCode · provider», marks the model the topic runs ✓ and a limited model with its reset', () => {
    const page = buildOpenCodeProviderPage({
      providerId: 'openai',
      models: ['gpt-5', 'gpt-5-mini'],
      page: 0,
      rung,
      limits: { 'openai/gpt-5-mini': '2026-10-17T14:00:00.000Z', 'openai/other': '2026-10-17T15:00:00.000Z' },
      timezone: 'UTC',
      nowMs,
      callbacks,
    });
    assert.equal(page.text, 'OpenCode · openai — pick the model for this topic:');
    assert.deepEqual(readLabels(page.keyboard.reply_markup.inline_keyboard as never), [['gpt-5 ✓'], ['gpt-5-mini ⛔ 14:00'], ['⬅️ Back']]);
  });

  it('no ✓ when the topic runs on another provider or on Claude, and a mark in the past is not shown', () => {
    for (const elsewhere of [null, { backend: 'claude', profile: 'perf', model: 'opus' } as const, { backend: 'opencode', providerId: 'google', modelId: 'gemini' } as const]) {
      const page = buildOpenCodeProviderPage({ providerId: 'openai', models: ['gpt-5'], page: 0, rung: elsewhere, limits: { 'openai/gpt-5': '2026-10-17T09:00:00.000Z' }, timezone: 'UTC', nowMs, callbacks });
      assert.deepEqual(readLabels(page.keyboard.reply_markup.inline_keyboard as never)[0], ['gpt-5']);
    }
  });
});

describe('handleModelPick / handleProviderTap', () => {
  function createDeps(outcome: OperatorSwitchOutcome) {
    const log: string[] = [];
    const picked: FallbackChainEntry[] = [];
    const deps: ProviderPickDeps = {
      ctx: { answerCbQuery: async (text?: string) => { log.push(`toast:${text ?? ''}`); return true; } },
      key: topicKey,
      switchTopicByOperator: async (_key, to) => { picked.push(to); return outcome; },
      answerWholeText: async (_ctx, _key, text) => { log.push(`whole:${text}`); },
      rerender: async () => { log.push('rerender'); },
    };
    return { deps, log, picked };
  }
  const to: FallbackChainEntry = { backend: 'opencode', providerId: 'openai', modelId: 'gpt-5' };

  it('a switch is answered with the SHORT toast naming where the topic runs — never the route\'s own long line — and returns to the screen', async () => {
    const { deps, log } = createDeps({ kind: 'switched', text: 'a very long /model reply '.repeat(20), label: 'OpenCode openai/gpt-5' });
    await handleModelPick(deps, to);
    assert.deepEqual(log, ['whole:✅ This topic runs on OpenCode openai/gpt-5.', 'rerender']);
  });

  it('an asked hand-over question has no toast (the question is the answer) and returns to the screen; a refusal shows its reason and STAYS on the page', async () => {
    const asked = createDeps({ kind: 'asked' });
    await handleModelPick(asked.deps, to);
    assert.deepEqual(asked.log, ['toast:', 'rerender']);
    const refused = createDeps({ kind: 'refused', text: '⚠️ no luck' });
    await handleModelPick(refused.deps, to);
    assert.deepEqual(refused.log, ['whole:⚠️ no luck']);
  });

  it('a provider tap: stale answers only «out of date»; one new model is switched at once; otherwise the page opens', async () => {
    const run = async (models: string[], rung: FallbackChainEntry | null) => {
      const { deps, log, picked } = createDeps({ kind: 'switched', text: 'x', label: 'L' });
      await handleProviderTap({ ...deps, providerId: 'openai', models, rung, showPage: async () => { log.push('page'); }, answerStale: async () => { log.push('stale'); } });
      return { log, picked };
    };
    assert.deepEqual((await run([], null)).log, ['stale']);
    const single = await run(['only'], null);
    assert.deepEqual(single.log, ['whole:✅ This topic runs on L.', 'rerender']);
    assert.deepEqual(single.picked, [{ backend: 'opencode', providerId: 'openai', modelId: 'only' }]);
    const here = await run(['only'], { backend: 'opencode', providerId: 'openai', modelId: 'only' });
    assert.deepEqual(here.log, ['toast:', 'page'], 'the topic runs on the provider: its page, not a switch');
    assert.deepEqual(here.picked, []);
    assert.deepEqual((await run(['a', 'b'], null)).log, ['toast:', 'page']);
  });
});
