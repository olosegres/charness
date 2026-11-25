/**
 * The screens of `/workers` as pure data (`utils/workerRolesScreenPlan.ts`): the codec of every button, the overview (rows, the
 * «All to built-in values» row, the warnings), a role's screen (Claude models and efforts, the OpenCode row, an OpenCode model's
 * variants, «(built-in)» and «Built-in»), the provider list, the moves a model pick makes — and the same screens in EVERY locale.
 *
 * One check, one level: what the built bot shows an operator (the overview, a Claude pick written to settings.json, the OpenCode
 * path through the providers and the model page, the warnings, «All to built-in values», a Russian chat) is
 * `workerRolesE2e.test.ts`'s. This file keeps the codec's edges, every warning case and the locale sweep.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { localeCodes, runWithLocale, t } from '../i18n';
import { enDict } from '../i18n/en';
import { workerRoleIds, type WorkerRolesSetting } from '../utils/workerRoles';
import {
  buildWorkerRoleProvidersScreen,
  buildWorkerRoleScreen,
  buildWorkerRolesCallbackData,
  buildWorkerRolesOverview,
  formatWorkerRoleValue,
  getValueAfterClaudeModelPick,
  getValueAfterOpenCodeModelPick,
  parseWorkerRolesCallbackData,
  workerRolesCallbackRe,
  type WorkerRolesScreen,
  type WorkerRolesTap,
} from '../utils/workerRolesScreenPlan';

const labelsOf = (screen: WorkerRolesScreen): string[][] => screen.rows.map((row) => row.map((button) => button.label));
const dataOf = (screen: WorkerRolesScreen): string[][] => screen.rows.map((row) => row.map((button) => button.data));

const catalog = ['openai/gpt-5.6-sol', 'openai/gpt-6-astra', 'anthropic/claude-x'];
const openCodeReviewer: WorkerRolesSetting = { reviewer: { cli: 'opencode', model: 'openai/gpt-6-astra', effort: 'medium' } };

describe('the callback codec', () => {
  it('every tap has its own data under 64 bytes and is parsed back to the same tap', () => {
    const taps: WorkerRolesTap[] = [
      { kind: 'overview' },
      { kind: 'allBuiltIn' },
      { kind: 'role', role: 'planner' },
      { kind: 'roleBuiltIn', role: 'builder' },
      { kind: 'claudeModel', role: 'storageBuilder', model: 'sonnet' },
      { kind: 'claudeEffort', role: 'reviewer', effort: 'xhigh' },
      { kind: 'openCodeProviders', role: 'miniReviewer' },
      { kind: 'openCodeProvider', role: 'reviewer', index: 2 },
      { kind: 'openCodeModelPage', role: 'reviewer', page: 11 },
      { kind: 'openCodeModel', role: 'reviewer', index: 117 },
      { kind: 'openCodeVariant', role: 'investigator', index: 0 },
    ];
    assert.deepEqual(taps.map(buildWorkerRolesCallbackData), ['wkr_o', 'wkr_all', 'wkr_r5', 'wkr_x0', 'wkr_m1_sonnet', 'wkr_e3_xhigh', 'wkr_oc4', 'wkr_p3_2', 'wkr_pg3_11', 'wkr_k3_117', 'wkr_v2_0']);
    for (const tap of taps) {
      const data = buildWorkerRolesCallbackData(tap);
      assert.ok(Buffer.byteLength(data) <= 64, data);
      assert.deepEqual(parseWorkerRolesCallbackData(data), tap, data);
    }
  });

  it('a hand-made callback names nothing: an unknown role index, model or effort, a Claude-only level, another screen\'s prefix', () => {
    for (const data of ['wkr_r6', 'wkr_r9', 'wkr_m0_gpt', 'wkr_e0_auto', 'wkr_e0_ultracode', 'wkr_x', 'wkr_p0_', 'wkr_k0_1234', 'wkr_', 'wkr_o ', 'lim_back', 'bsk_wkr']) {
      assert.equal(parseWorkerRolesCallbackData(data), null, data);
    }
    assert.doesNotMatch('bsk_wkr', workerRolesCallbackRe, 'the /bot_skills row is the bot-skills module\'s own button');
  });
});

describe('the overview', () => {
  it('a fresh instance: the six built-in values, the «your own instructions win» paragraph, no «All to built-in values», no warning', () => {
    const screen = buildWorkerRolesOverview({ setting: {}, openCodeModels: null, isBotSkillsEnabled: true });
    assert.equal(screen.text, [enDict['workerRoles.title'], enDict['workerRoles.explanationText'], enDict['workerRoles.runningWorkerNote']].join('\n\n'));
    assert.match(screen.text, /Your own instructions win: a model you name in the conversation, or a delegate skill of the project or your own that names a role's model\./);
    assert.deepEqual(labelsOf(screen), [
      ['Builder: Opus · medium'],
      ['Builder, data storage: Opus · xhigh'],
      ['Investigator: Opus · xhigh'],
      ['Reviewer: Opus · xhigh'],
      ['Mini-review: Opus · high'],
      ['Planner: Opus · xhigh'],
    ]);
    assert.deepEqual(dataOf(screen), workerRoleIds.map((_, index) => [`wkr_r${index}`]));
  });

  it('a changed role shows its value and brings «All to built-in values»; an OpenCode role whose provider is gone carries ⚠️ and its line; the skills off add theirs', () => {
    const setting: WorkerRolesSetting = { builder: { cli: 'claude', model: 'sonnet', effort: 'high' }, ...openCodeReviewer };
    const screen = buildWorkerRolesOverview({ setting, openCodeModels: ['anthropic/claude-x'], isBotSkillsEnabled: false });
    assert.equal(labelsOf(screen)[0][0], 'Builder: Sonnet · high');
    assert.equal(labelsOf(screen)[3][0], '⚠️ Reviewer: OpenCode · gpt-6-astra · medium');
    assert.deepEqual(screen.rows.at(-1), [{ label: '↩ All to built-in values', data: 'wkr_all' }]);
    assert.ok(screen.text.endsWith('\n\n⚠️ Reviewer: OpenCode «openai» is not connected — agents launch it on their own model until it is.\n\n⚠️ The bot\'s skills are off: agents follow their own skills, which may not ask the bot for these values.'), screen.text);
  });

  it('a connected provider whose model is gone says so; a model in the catalog, or a catalog not read, warns about nothing', () => {
    const gone = buildWorkerRolesOverview({ setting: openCodeReviewer, openCodeModels: ['openai/gpt-5.6-sol'], isBotSkillsEnabled: true });
    assert.match(gone.text, /⚠️ Reviewer: the OpenCode model «gpt-6-astra» is gone — agents launch it on their own model until it is back\.$/);
    for (const openCodeModels of [catalog, [], null]) {
      const screen = buildWorkerRolesOverview({ setting: openCodeReviewer, openCodeModels, isBotSkillsEnabled: true });
      assert.doesNotMatch(screen.text, /⚠️/, JSON.stringify(openCodeModels));
      assert.equal(labelsOf(screen)[3][0], 'Reviewer: OpenCode · gpt-6-astra · medium');
    }
  });
});

describe('a role\'s screen', () => {
  it('a built-in Claude role: «(built-in)», the four Claude models, the OpenCode row when a provider is connected, the five efforts, Back only', () => {
    const screen = buildWorkerRoleScreen({ role: 'builder', setting: {}, openCodeModels: catalog, variants: [] });
    assert.equal(screen.text, '🛠 Builder\n\nCode, tests, debugging, e2e and live runs, rework.\n\nNow: Opus · medium (built-in)\nYour own instructions may name another — then they win.');
    assert.deepEqual(labelsOf(screen), [['Fable', 'Opus ✓', 'Sonnet', 'Haiku'], ['🔌 OpenCode model…'], ['low', 'medium ✓', 'high'], ['xhigh', 'max'], ['← Back']]);
    assert.deepEqual(dataOf(screen), [['wkr_m0_fable', 'wkr_m0_opus', 'wkr_m0_sonnet', 'wkr_m0_haiku'], ['wkr_oc0'], ['wkr_e0_low', 'wkr_e0_medium', 'wkr_e0_high'], ['wkr_e0_xhigh', 'wkr_e0_max'], ['wkr_o']]);
  });

  it('no OpenCode provider connected → no OpenCode row; a changed role loses «(built-in)» and gains «Built-in»', () => {
    const screen = buildWorkerRoleScreen({ role: 'builder', setting: { builder: { cli: 'claude', model: 'sonnet', effort: 'high' } }, openCodeModels: [], variants: [] });
    assert.match(screen.text, /\n\nNow: Sonnet · high\n/);
    assert.deepEqual(labelsOf(screen), [['Fable', 'Opus', 'Sonnet ✓', 'Haiku'], ['low', 'medium', 'high ✓'], ['xhigh', 'max'], ['↩ Built-in', '← Back']]);
    assert.deepEqual(screen.rows.at(-1)?.map((button) => button.data), ['wkr_x0', 'wkr_o']);
  });

  it('an OpenCode role: its model on the OpenCode row with ✓, the model\'s variants as the effort rows (indexes), none when it has none', () => {
    const screen = buildWorkerRoleScreen({ role: 'reviewer', setting: openCodeReviewer, openCodeModels: catalog, variants: ['none', 'low', 'medium', 'high', 'xhigh'] });
    assert.match(screen.text, /^🛠 Reviewer\n\nThe independent review of a task or commit\.\n\nNow: OpenCode · gpt-6-astra · medium\n/);
    assert.deepEqual(labelsOf(screen), [['Fable', 'Opus', 'Sonnet', 'Haiku'], ['🔌 OpenCode · gpt-6-astra ✓'], ['none', 'low', 'medium ✓'], ['high', 'xhigh'], ['↩ Built-in', '← Back']]);
    assert.deepEqual(dataOf(screen)[2], ['wkr_v3_0', 'wkr_v3_1', 'wkr_v3_2']);
    const noVariants = buildWorkerRoleScreen({ role: 'reviewer', setting: { reviewer: { cli: 'opencode', model: 'openai/gpt-6-astra', effort: null } }, openCodeModels: [], variants: [] });
    assert.match(noVariants.text, /Now: OpenCode · gpt-6-astra · model's default\n/);
    assert.deepEqual(labelsOf(noVariants), [['Fable', 'Opus', 'Sonnet', 'Haiku'], ['🔌 OpenCode · gpt-6-astra ✓'], ['↩ Built-in', '← Back']], 'the OpenCode row stays even with the catalog unread');
  });

  it('the provider list: one button per provider (an index), then Back to the role', () => {
    const screen = buildWorkerRoleProvidersScreen('reviewer', ['openai', 'anthropic']);
    assert.equal(screen.text, '🛠 Reviewer · OpenCode\n\nChoose the provider:');
    assert.deepEqual(labelsOf(screen), [['openai'], ['anthropic'], ['← Back']]);
    assert.deepEqual(dataOf(screen), [['wkr_p3_0'], ['wkr_p3_1'], ['wkr_r3']]);
  });
});

describe('the moves', () => {
  it('a Claude model keeps a Claude launch effort, else takes the role\'s built-in one', () => {
    assert.deepEqual(getValueAfterClaudeModelPick({ cli: 'claude', model: 'opus', effort: 'max' }, { cli: 'claude', model: 'opus', effort: 'medium' }, 'sonnet'), { cli: 'claude', model: 'sonnet', effort: 'max' });
    assert.deepEqual(getValueAfterClaudeModelPick({ cli: 'opencode', model: 'openai/x', effort: 'high' }, { cli: 'claude', model: 'opus', effort: 'xhigh' }, 'opus'), { cli: 'claude', model: 'opus', effort: 'high' });
    assert.deepEqual(getValueAfterClaudeModelPick({ cli: 'opencode', model: 'openai/x', effort: 'none' }, { cli: 'claude', model: 'opus', effort: 'xhigh' }, 'opus'), { cli: 'claude', model: 'opus', effort: 'xhigh' });
  });

  it('an OpenCode model keeps the effort when it offers it as a variant, else none (the model\'s own default)', () => {
    assert.deepEqual(getValueAfterOpenCodeModelPick({ cli: 'claude', model: 'opus', effort: 'high' }, 'openai/x', ['low', 'high']), { cli: 'opencode', model: 'openai/x', effort: 'high' });
    assert.deepEqual(getValueAfterOpenCodeModelPick({ cli: 'claude', model: 'opus', effort: 'xhigh' }, 'openai/x', ['low', 'high']), { cli: 'opencode', model: 'openai/x', effort: null });
    assert.deepEqual(getValueAfterOpenCodeModelPick({ cli: 'claude', model: 'opus', effort: 'xhigh' }, 'openai/x', []), { cli: 'opencode', model: 'openai/x', effort: null });
  });
});

describe('every locale', () => {
  it('every screen renders with no placeholder left, the same buttons\' data as English and the model ids and effort words untranslated', () => {
    const changed: WorkerRolesSetting = { builder: { cli: 'claude', model: 'sonnet', effort: 'high' }, ...openCodeReviewer };
    const build = (): WorkerRolesScreen[] => [
      buildWorkerRolesOverview({ setting: changed, openCodeModels: ['openai/gpt-5.6-sol'], isBotSkillsEnabled: false }),
      buildWorkerRolesOverview({ setting: openCodeReviewer, openCodeModels: ['anthropic/claude-x'], isBotSkillsEnabled: true }),
      ...workerRoleIds.map((role) => buildWorkerRoleScreen({ role, setting: changed, openCodeModels: catalog, variants: ['low', 'medium'] })),
      buildWorkerRoleProvidersScreen('reviewer', ['openai']),
    ];
    const english = build();
    for (const locale of localeCodes) {
      const screens = runWithLocale(locale, build);
      screens.forEach((screen, index) => {
        assert.doesNotMatch(screen.text, /\{[a-z]+\}|workerRoles\./, `${locale} #${index}: ${screen.text}`);
        for (const label of labelsOf(screen).flat()) assert.doesNotMatch(label, /\{[a-z]+\}|workerRoles\./, `${locale}: ${label}`);
        assert.deepEqual(dataOf(screen), dataOf(english[index]), `${locale} #${index}`);
      });
      if (locale !== 'en') {
        assert.notEqual(screens[0].text, english[0].text, `${locale} translates the overview`);
        assert.ok(screens[0].rows[0][0].label.endsWith('Sonnet · high'), `${locale}: ${screens[0].rows[0][0].label}`);
      }
    }
  });

  it('/help names /workers in General and in a bound topic, and /bot_skills\'s row has its label, in every locale', () => {
    for (const locale of localeCodes) {
      assert.ok(runWithLocale(locale, () => t('help.general')).includes('/workers — '), `${locale}: help.general`);
      assert.ok(runWithLocale(locale, () => t('help.thread_bound', { subdir: 'x' })).includes('/workers — '), `${locale}: help.thread_bound`);
      assert.match(runWithLocale(locale, () => t('botSkills.workerModelsButton')), /^🛠 /, locale);
    }
  });

  it('the Russian screens', () => {
    const overview = runWithLocale('ru', () => buildWorkerRolesOverview({ setting: {}, openCodeModels: null, isBotSkillsEnabled: true }));
    assert.match(overview.text, /^🛠 Модели воркеров — для всего бота\n\n/);
    assert.equal(labelsOf(overview)[0][0], 'Разработчик: Opus · medium');
    const role = runWithLocale('ru', () => buildWorkerRoleScreen({ role: 'builder', setting: {}, openCodeModels: null, variants: [] }));
    assert.match(role.text, /Сейчас: Opus · medium \(встроенное\)\nТвои инструкции могут назвать другую — тогда важнее они\.$/);
    assert.equal(runWithLocale('ru', () => formatWorkerRoleValue({ cli: 'opencode', model: 'openai/x', effort: null })), 'OpenCode · x · по умолчанию модели');
  });
});
