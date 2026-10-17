/**
 * @description `/effort` in a topic on OpenCode, where a level is a model VARIANT: General's value is rounded to
 * what the model offers, and the screen names the level the topic will really get — in the text AND on the
 * «As in General (…)» button, whose tap lands on that same level. A model that stops at `high` turns General's
 * `xhigh` into `high`, `ultracode` into its top variant (never its lowest) and leaves `auto` as it is (no variant).
 *
 * The OpenCode server is stubbed at its HTTP boundary (`openCodeServerStub.ts`): the model list and the default
 * model; no session is started, so the screen resolves the PROSPECTIVE model the next session would use.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createModelProviders } from '../connectors/telegram/commands/modelProviders';
import { setThreadAdapter } from '../adapters/createAdapter';
import { openCodeAdapterName } from '../adapters/adapterNames';
import { resetOpenCodeProviderCaches } from '../adapters/openCodeAdapter';
import { setInstanceDefaultEffortReader } from '../effortLevels';
import { createInstanceDefaultEffortReader, resetInstanceSettingsCache } from '../instanceSettings';
import { effortSameCallback } from '../utils/effortPickerPlan';
import { createCommandHarness, type CommandHarness } from './commandModuleHarness';
import { useStubbedOpenCodeServer } from './openCodeServerStub';

const openCodeServer = useStubbedOpenCodeServer();

/** A model that stops at `high` (opus-4-5 style): no `xhigh`, no `max`. */
const modelVariantNames = ['low', 'medium', 'high'];

let harness: CommandHarness;
let settingsDir = '';
let settingsPath = '';

function answerWithModelThatStopsAtHigh(): void {
  resetOpenCodeProviderCaches();
  openCodeServer.answerApiWith(({ method, urlPath }) => {
    if (method === 'GET' && (urlPath === '/config/providers' || urlPath.startsWith('/config/providers?'))) {
      return {
        providers: [{ id: 'anthropic', models: { 'claude-opus-4-5': { variants: Object.fromEntries(modelVariantNames.map((name) => [name, {}])) } } }],
      };
    }
    if (method === 'GET' && (urlPath === '/config' || urlPath.startsWith('/config?'))) {
      return { defaultModel: { providerID: 'anthropic', modelID: 'claude-opus-4-5' } };
    }
    return undefined;
  });
}

/** General's value, written the way an editor saves it (a new file renamed over the old). */
function setGeneralDefault(level: string): void {
  fs.writeFileSync(`${settingsPath}.by-hand`, JSON.stringify({ defaultEffort: level }));
  fs.renameSync(`${settingsPath}.by-hand`, settingsPath);
}

/** The server's default model offers no variants at all (a model the provider lists without any). */
function answerWithModelWithoutVariants(): void {
  resetOpenCodeProviderCaches();
  openCodeServer.answerApiWith(({ method, urlPath }) => {
    if (method === 'GET' && (urlPath === '/config/providers' || urlPath.startsWith('/config/providers?'))) {
      return { providers: [{ id: 'anthropic', models: { 'claude-sonnet-4-6': {} } }] };
    }
    if (method === 'GET' && (urlPath === '/config' || urlPath.startsWith('/config?'))) {
      return { defaultModel: { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' } };
    }
    return undefined;
  });
}

describe('/effort on an OpenCode topic: General\'s value as the model will really take it', () => {
  before(async () => {
    harness = await createCommandHarness();
    settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'effort-opencode-'));
    settingsPath = path.join(settingsDir, 'settings.json');
    setInstanceDefaultEffortReader(createInstanceDefaultEffortReader(() => settingsPath, () => {}));
    setThreadAdapter(harness.key, openCodeAdapterName);
    const modelProviders = createModelProviders({
      ...harness.core,
      awaitingModelSelection: new Set(),
      awaitingSessionSelection: new Set(),
      awaitingFolderName: new Set(),
      threadModelLists: new Map(),
      pendingProviderConnects: new Map(),
      connectMethodLists: new Map(),
      disconnectProviderLists: new Map(),
      startOpenCodeOAuthLogin: async () => {},
      getInstanceSettingsPath: () => settingsPath,
    });
    modelProviders.registerModelCommands();
    modelProviders.registerModelCallbacks();
  });

  after(async () => {
    setInstanceDefaultEffortReader(() => null);
    resetInstanceSettingsCache();
    resetOpenCodeProviderCaches();
    fs.rmSync(settingsDir, { recursive: true, force: true });
    await harness.stop();
  });

  it('General xhigh on a model that stops at high: the text, the ✓ and the button all say high — and the tap lands on it', async () => {
    answerWithModelThatStopsAtHigh();
    setGeneralDefault('xhigh');
    await harness.runCommand('effort');
    const picker = harness.replies.at(-1);
    assert.equal(picker?.text, '⚙️ Effort in this topic: high — as in General');
    assert.deepEqual(harness.getKeyboardLabels(picker).flat(), ['low', 'medium', 'high ✓', 'As in General (high)']);
    assert.ok(picker?.messageId);

    await harness.tapButton(picker.messageId, effortSameCallback);
    assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), 'As in General: high', 'the confirmation names the level the button promised');
  });

  it('General ultracode is the model\'s top variant (high here), not its lowest', async () => {
    answerWithModelThatStopsAtHigh();
    setGeneralDefault('ultracode');
    await harness.runCommand('effort');
    const picker = harness.replies.at(-1);
    assert.equal(picker?.text, '⚙️ Effort in this topic: high — as in General');
    assert.equal(harness.getKeyboardLabels(picker).flat().at(-1), 'As in General (high)');
  });

  it('General auto sends no variant: the screen says auto, and no level carries the ✓', async () => {
    answerWithModelThatStopsAtHigh();
    setGeneralDefault('auto');
    await harness.runCommand('effort');
    const picker = harness.replies.at(-1);
    assert.equal(picker?.text, '⚙️ Effort in this topic: auto — as in General');
    assert.deepEqual(harness.getKeyboardLabels(picker).flat(), ['low', 'medium', 'high', 'As in General (auto)']);
  });

  it('a model with no variants: /effort answers «not available» — the answer the other screens now agree with', async () => {
    answerWithModelWithoutVariants();
    setGeneralDefault('ultracode');
    await harness.runCommand('effort');
    assert.equal(harness.replies.at(-1)?.text, 'ℹ️ No reasoning-effort levels are available for the current model.', 'no picker, no level');
  });
});
