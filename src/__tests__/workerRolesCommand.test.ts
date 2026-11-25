/**
 * `/workers` through the REAL module (`connectors/telegram/commands/workerRoles.ts`) on a real telegraf instance
 * (`commandModuleHarness.ts`), with a real `settings.json` in a temp folder and a canned OpenCode catalog:
 *
 *   • the command, its hidden alias and the one button pattern;
 *   • taps edit the screen in place (a repeated-use screen) and write `settings.json` `workerRoles` — only the changed roles;
 *   • the OpenCode path: providers → a provider's model page (pages, ✓ on the role's model) → a model → its variants; a model pick
 *     keeps the effort only when the model offers it;
 *   • a keyboard that has gone stale: a Claude button still means what it says; an OpenCode one (an index into what another message,
 *     or a bot restart, held) answers «out of date» and changes nothing; an effort button of a role that moved to OpenCode is stale;
 *   • a settings file that cannot be written says so and changes nothing; a refused tap changes nothing.
 *
 * One check, one level: what the built bot shows an operator (the first screen, a Claude pick and what an agent then reads, an
 * OpenCode pick, the warnings, «All to built-in values», `/bot_skills`'s row, a Russian chat) is `workerRolesE2e.test.ts`'s; the
 * screens' words in every locale are `workerRolesScreenPlan.test.ts`'s. This file keeps what a flow cannot reach cheaply.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createWorkerRoles } from '../connectors/telegram/commands/workerRoles';
import { createWorkerRolesSettingsReader, resetInstanceSettingsCache, saveInstanceSettingsChange } from '../instanceSettings';
import { createCommandHarness, type CommandHarness } from './commandModuleHarness';

const screenMessageId = 5150;
const otherMessageId = 5151;

let harness: CommandHarness;
let settingsDir = '';
let settingsPath = '';
let openCodeCatalog: string[] = [];
const variantsByModel: Record<string, string[]> = {
  'openai/gpt-6-astra': ['none', 'low', 'medium', 'high', 'xhigh'],
  'openai/gpt-5.6-sol': ['low', 'high'],
};

function readSettingsFile(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
}

function readEditedScreen(): { messageId: number | null; text: string; labels: string[][]; data: string[][] } {
  const edit = harness.edits.at(-1);
  assert.ok(edit, 'the module edited a message');
  return { messageId: edit.messageId, text: edit.text, labels: harness.getKeyboardLabels(edit), data: harness.getKeyboardData(edit) };
}

const getLastToast = (): string | undefined => harness.fakeTelegram.callbackAnswers.at(-1);

describe('/workers, through the module', () => {
  before(async () => {
    harness = await createCommandHarness();
    settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-roles-'));
    settingsPath = path.join(settingsDir, 'settings.json');
    const readWorkerRoles = createWorkerRolesSettingsReader(() => settingsPath, () => {});
    const workerRoles = createWorkerRoles({
      ...harness.core,
      readWorkerRoles,
      saveWorkerRoles: (setting) => saveInstanceSettingsChange(settingsPath, { workerRoles: setting }),
      getSettingsPath: () => settingsPath,
      listOpenCodeModels: async () => openCodeCatalog,
      getOpenCodeModelVariants: async (model) => variantsByModel[model] ?? [],
      readIsBotSkillsEnabled: () => true,
    });
    workerRoles.registerWorkerRolesCommands();
    workerRoles.registerWorkerRolesCallbacks();
  });

  after(async () => {
    await harness.stop();
    fs.rmSync(settingsDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    harness.replies.length = 0;
    harness.edits.length = 0;
    harness.fakeTelegram.callbackAnswers.length = 0;
    harness.isAuthorised = true;
    harness.isGeneral = false;
    openCodeCatalog = ['openai/gpt-5.6-sol', 'openai/gpt-6-astra', ...Array.from({ length: 11 }, (_, index) => `openai/extra-${index}`), 'anthropic/claude-x'];
    fs.rmSync(settingsPath, { recursive: true, force: true });
    resetInstanceSettingsCache();
  });

  it('registers the command with its hidden alias and ONE button pattern', () => {
    assert.deepEqual(harness.registeredCommandNames, ['workers', 'worker_models']);
    assert.equal(harness.registeredActionPatterns.length, 1);
    assert.match(harness.registeredActionPatterns[0], /^\/\^wkr_/);
  });

  it('a Claude pick and an effort pick edit the role screen in place and write only the changed role; a stale Claude button still means what it says', async () => {
    await harness.tapButton(screenMessageId, 'wkr_m0_sonnet');
    assert.deepEqual(readSettingsFile(), { workerRoles: { builder: { cli: 'claude', model: 'sonnet', effort: 'medium' } } }, 'the model changed, the effort kept');
    assert.equal(readEditedScreen().messageId, screenMessageId);
    assert.deepEqual(readEditedScreen().labels[0], ['Fable', 'Opus', 'Sonnet ✓', 'Haiku']);
    await harness.tapButton(otherMessageId, 'wkr_e0_high');
    assert.deepEqual(readSettingsFile(), { workerRoles: { builder: { cli: 'claude', model: 'sonnet', effort: 'high' } } });
    // Back to Opus · medium: the built-in value again, so the role leaves the file.
    await harness.tapButton(screenMessageId, 'wkr_m0_opus');
    await harness.tapButton(screenMessageId, 'wkr_e0_medium');
    assert.deepEqual(readSettingsFile(), {});
  });

  it('the OpenCode path: providers → the model page (10 a page, ✓ on the role\'s model) → a model → its variants; the effort kept only when offered', async () => {
    await harness.tapButton(screenMessageId, 'wkr_e3_high');
    await harness.tapButton(screenMessageId, 'wkr_oc3');
    assert.deepEqual(readEditedScreen().labels, [['openai'], ['anthropic'], ['← Back']]);
    await harness.tapButton(screenMessageId, 'wkr_p3_0');
    const page = readEditedScreen();
    assert.equal(page.text, '🛠 Reviewer · openai');
    assert.equal(page.labels.length, 12, '10 models, the arrows, Back');
    assert.deepEqual(page.data.at(-1), ['wkr_oc3']);
    await harness.tapButton(screenMessageId, 'wkr_pg3_1');
    assert.equal(readEditedScreen().labels[0][0], 'extra-8', 'the second page');
    await harness.tapButton(screenMessageId, 'wkr_pg3_0');
    await harness.tapButton(screenMessageId, 'wkr_k3_1');
    assert.deepEqual(readSettingsFile(), { workerRoles: { reviewer: { cli: 'opencode', model: 'openai/gpt-6-astra', effort: 'high' } } }, 'high is one of its variants: kept');
    const role = readEditedScreen();
    assert.deepEqual(role.labels.slice(1, 4), [['🔌 OpenCode · gpt-6-astra ✓'], ['none', 'low', 'medium'], ['high ✓', 'xhigh']]);
    await harness.tapButton(screenMessageId, 'wkr_v3_2');
    assert.deepEqual(readSettingsFile(), { workerRoles: { reviewer: { cli: 'opencode', model: 'openai/gpt-6-astra', effort: 'medium' } } });
    // The model page again shows ✓ on the role's model; another model without «medium» drops the variant.
    await harness.tapButton(screenMessageId, 'wkr_oc3');
    await harness.tapButton(screenMessageId, 'wkr_p3_0');
    assert.equal(readEditedScreen().labels[1][0], 'gpt-6-astra ✓');
    await harness.tapButton(screenMessageId, 'wkr_k3_0');
    assert.deepEqual(readSettingsFile(), { workerRoles: { reviewer: { cli: 'opencode', model: 'openai/gpt-5.6-sol' } } }, 'no variant: the model\'s own default');
    assert.match(readEditedScreen().text, /Now: OpenCode · gpt-5\.6-sol · model's default\n/);
  });

  it('an OpenCode button whose list this message does not hold is «out of date» and changes nothing; so is an effort button of a role on OpenCode by now', async () => {
    await harness.tapButton(screenMessageId, 'wkr_oc3');
    const editsBefore = harness.edits.length;
    for (const data of ['wkr_p3_0', 'wkr_k3_0', 'wkr_v3_0', 'wkr_pg3_1']) {
      await harness.tapButton(otherMessageId, data);
      assert.equal(getLastToast(), 'This screen is out of date — open /workers again', data);
    }
    await harness.tapButton(screenMessageId, 'wkr_p2_0');
    assert.equal(getLastToast(), 'This screen is out of date — open /workers again', 'the list belongs to another role');
    await harness.tapButton(screenMessageId, 'wkr_p3_9');
    assert.equal(getLastToast(), 'This screen is out of date — open /workers again', 'an index past the list');
    assert.equal(harness.edits.length, editsBefore);
    assert.equal(fs.existsSync(settingsPath), false, 'nothing written');
    // A role on OpenCode: a Claude effort button from before the move, and a variant of a model it no longer runs, are stale.
    await harness.tapButton(screenMessageId, 'wkr_p3_0');
    await harness.tapButton(screenMessageId, 'wkr_k3_1');
    await harness.tapButton(otherMessageId, 'wkr_e3_low');
    assert.equal(getLastToast(), 'This screen is out of date — open /workers again');
    saveInstanceSettingsChange(settingsPath, { workerRoles: { reviewer: { cli: 'opencode', model: 'openai/gpt-5.6-sol', effort: null } } });
    await harness.tapButton(screenMessageId, 'wkr_v3_0');
    assert.equal(getLastToast(), 'This screen is out of date — open /workers again', 'the variants were gpt-6-astra\'s');
    assert.deepEqual(readSettingsFile(), { workerRoles: { reviewer: { cli: 'opencode', model: 'openai/gpt-5.6-sol' } } });
  });

  it('«Built-in» on a role and «All to built-in values» take the fields out of settings.json, other settings stay', async () => {
    saveInstanceSettingsChange(settingsPath, { autoUpdate: 'off', workerRoles: { builder: { cli: 'claude', model: 'sonnet', effort: 'high' }, planner: { cli: 'claude', model: 'haiku', effort: 'low' } } });
    await harness.tapButton(screenMessageId, 'wkr_x0');
    assert.deepEqual(readSettingsFile(), { autoUpdate: 'off', workerRoles: { planner: { cli: 'claude', model: 'haiku', effort: 'low' } } });
    await harness.tapButton(screenMessageId, 'wkr_all');
    assert.deepEqual(readSettingsFile(), { autoUpdate: 'off' });
    assert.doesNotMatch(JSON.stringify(readEditedScreen().labels), /All to built-in values/);
  });

  it('a settings file that cannot be written: the toast says so, nothing changes and the screen is left as it was', async () => {
    // A directory where the file should be: the atomic rename over it fails.
    fs.mkdirSync(settingsPath);
    await harness.tapButton(screenMessageId, 'wkr_m0_sonnet');
    assert.match(getLastToast() ?? '', /could not be saved/);
    assert.deepEqual(harness.edits, [], 'the screen keeps its buttons: the tap can be repeated');
  });

  it('a refused tap (not an admin) changes nothing', async () => {
    harness.isAuthorised = false;
    await harness.tapButton(screenMessageId, 'wkr_m0_sonnet');
    assert.equal(fs.existsSync(settingsPath), false);
    assert.deepEqual(harness.edits, []);
  });
});
