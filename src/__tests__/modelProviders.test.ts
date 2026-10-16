/**
 * @description The `/model`, `/effort`, `/connect` and `/disconnect` flows
 * (`connectors/telegram/commands/modelProviders.ts`) wired to ports
 * (`commandModuleHarness.ts`: a real telegraf instance against the fake Bot API, the real state store,
 * recording topic sends). The thread runs the default Claude backend, whose model list needs no process.
 * Pinned:
 *
 *   • WIRING — the commands and the thirteen buttons the module registers, in order;
 *   • the picker and its per-thread state, which the bot also reads (the numbered-pick arming) and clears
 *     (teardown) — owned by the bot and passed in;
 *   • the provider-credential flow's guards: a key that cannot be real is never taken for a secret, and
 *     arming a pending connect cancels the other single-purpose input modes;
 *   • the method picker's OAuth button reaching the sign-in driver port.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createModelProviders, type PendingProviderConnect } from '../connectors/telegram/commands/modelProviders';
import { keyToString, type SessionKey } from '../sessionKey';
import { getInstanceDefaultEffort, setInstanceDefaultEffortReader } from '../effortLevels';
import { createInstanceDefaultEffortReader, resetInstanceSettingsCache } from '../instanceSettings';
import { clearEffortPref } from '../adapters/claudeCliAdapter';
import { ClaudeJsonStreamAdapter } from '../adapters/claudeJsonStreamAdapter';
import { getThreadAdapter } from '../adapters/createAdapter';
import { createStreamSessionFixture } from './claudeJsonStreamSessionFixture';
import { effortSameCallback } from '../utils/effortPickerPlan';
import type { OpenCodeAuthMethod } from '../utils/openCodeAuthLogin';
import {
  modelPickCallbackRe,
  modelPickerBackCallback,
  modelPickerNoopCallback,
  providerHideCallbackRe,
  providerPageCallbackRe,
  providerShowCallbackRe,
} from '../utils/modelPickerPlan';
import { recentModelPickCallbackRe, recentModelsOpenCallback } from '../utils/modelRecentPlan';
import { disconnectProviderCallbackRe } from '../utils/providerDisconnectPlan';
import { createCommandHarness, harnessThreadId, type CommandHarness } from './commandModuleHarness';

const expectedCommandNames = ['connect', 'disconnect', 'model', 'effort'];
const expectedActionPatterns = [
  String(providerPageCallbackRe),
  String(modelPickCallbackRe),
  recentModelsOpenCallback,
  String(recentModelPickCallbackRe),
  String(providerHideCallbackRe),
  String(providerShowCallbackRe),
  modelPickerBackCallback,
  modelPickerNoopCallback,
  String(disconnectProviderCallbackRe),
  '/^model_(.+)$/',
  '/^connm_(\\d+)$/',
  '/^effort_(.+)$/',
  effortSameCallback,
];
const secretMessageId = 77;

interface SignInRequest {
  key: SessionKey;
  providerId: string;
  methodLabel: string;
}

let harness: CommandHarness;
let modelProviders: ReturnType<typeof createModelProviders>;
let keyString: string;
const awaitingModelSelection = new Set<string>();
const awaitingSessionSelection = new Set<string>();
const awaitingFolderName = new Set<string>();
const threadModelLists = new Map<string, string[]>();
const pendingProviderConnects = new Map<string, PendingProviderConnect>();
const connectMethodLists = new Map<string, { providerId: string; methods: OpenCodeAuthMethod[] }>();
const disconnectProviderLists = new Map<string, string[]>();
const signInRequests: SignInRequest[] = [];
/** `settings.json` of the test instance: a throwaway dir, never the operator's config dir. */
let settingsDir = '';
let settingsPath = '';
const settingsLogLines: string[] = [];

/** A hand edit the way an editor saves it: a new file renamed over the old, so the bot's change stamp always moves. */
function writeSettingsByHand(text: string): void {
  const tempPath = `${settingsPath}.by-hand`;
  fs.writeFileSync(tempPath, text);
  fs.renameSync(tempPath, settingsPath);
}

describe('modelProviders: the model, effort and provider flows over their ports', () => {
  before(async () => {
    harness = await createCommandHarness();
    keyString = keyToString(harness.key);
    settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'effort-settings-'));
    settingsPath = path.join(settingsDir, 'settings.json');
    // The wiring `bot.ts` does at start-up: the instance default effort is read from `settings.json`.
    setInstanceDefaultEffortReader(createInstanceDefaultEffortReader(() => settingsPath, (line) => settingsLogLines.push(line)));
    modelProviders = createModelProviders({
      ...harness.core,
      awaitingModelSelection,
      awaitingSessionSelection,
      awaitingFolderName,
      threadModelLists,
      pendingProviderConnects,
      connectMethodLists,
      disconnectProviderLists,
      startOpenCodeOAuthLogin: async (key, providerId, methodLabel) => {
        signInRequests.push({ key, providerId, methodLabel });
      },
      getInstanceSettingsPath: () => settingsPath,
    });
    modelProviders.registerProviderCommands();
    modelProviders.registerModelCommands();
    modelProviders.registerModelCallbacks();
  });

  after(async () => {
    setInstanceDefaultEffortReader(() => null);
    resetInstanceSettingsCache();
    fs.rmSync(settingsDir, { recursive: true, force: true });
    await harness.stop();
  });

  it('registers /connect /disconnect /model /effort and its thirteen buttons, in the order the bot has always had', () => {
    assert.deepEqual(harness.registeredCommandNames, expectedCommandNames);
    assert.deepEqual(harness.registeredActionPatterns, expectedActionPatterns);
  });

  it('/model lists the backend\'s models and arms the numbered pick on the page it shows', async () => {
    await harness.runCommand('model');
    const picker = harness.replies.at(-1);
    assert.match(picker?.text ?? '', /4 models/);
    assert.match(picker?.text ?? '', /1\. fable\n2\. opus\n3\. sonnet\n4\. haiku/);
    assert.deepEqual(harness.getKeyboardData(picker), [['mdl_0_0'], ['mdl_0_1'], ['mdl_0_2'], ['mdl_0_3']]);
    assert.deepEqual(threadModelLists.get(keyString), ['fable', 'opus', 'sonnet', 'haiku']);
    assert.equal(awaitingModelSelection.has(keyString), true, 'a bare digit now picks from this page');
  });

  it('a tap on a model is answered, and — with no session — the backend\'s refusal reaches the user', async () => {
    const picker = harness.replies.at(-1)?.messageId;
    assert.ok(picker);
    const answersBefore = harness.fakeTelegram.callbackAnswers.length;
    await harness.tapButton(picker, 'mdl_0_1');
    assert.equal(harness.fakeTelegram.callbackAnswers.length, answersBefore + 1);
    assert.match(harness.fakeTelegram.callbackAnswers.at(-1) ?? '', /No active session/);
  });

  it('a typed number resolves against the page on screen and always consumes the bare-digit affordance', async () => {
    awaitingModelSelection.add(keyString);
    threadModelLists.set(keyString, ['sonnet', 'opus', 'haiku']);
    await harness.runCommand('model', '3');
    assert.equal(awaitingModelSelection.has(keyString), false, 'a typed pick disarms, or the next plain "3" would be swallowed');
    assert.match(harness.replies.at(-1)?.text ?? '', /No active session/);

    await harness.runCommand('model', '99');
    assert.match(harness.replies.at(-1)?.text ?? '', /number|invalid/i, 'an out-of-range number is refused');
  });

  it('/effort in a topic names the level in force and where it comes from; a pick is saved for the next session, answered, and the picker follows', async () => {
    clearEffortPref(harness.key);
    await harness.runCommand('effort');
    const picker = harness.replies.at(-1);
    assert.equal(picker?.text, '⚙️ Effort in this topic: medium — as in General', 'no pick, no settings.json: the code fallback, as in General');
    assert.deepEqual(harness.getKeyboardData(picker), [
      ['effort_low', 'effort_medium', 'effort_high'],
      ['effort_xhigh', 'effort_max', 'effort_auto'],
      ['effort_ultracode'],
      [effortSameCallback],
    ]);
    assert.deepEqual(harness.getKeyboardLabels(picker).flat().filter((label) => label.includes('✓') || label.startsWith('As in')), ['medium ✓', 'As in General (medium)']);
    assert.ok(picker?.messageId);
    const answersBefore = harness.fakeTelegram.callbackAnswers.length;
    await harness.tapButton(picker.messageId, 'effort_high');
    assert.equal(harness.fakeTelegram.callbackAnswers.length, answersBefore + 1);
    assert.match(harness.fakeTelegram.callbackAnswers.at(-1) ?? '', /Level saved/);
    const rerendered = harness.edits.at(-1);
    assert.equal(rerendered?.messageId, picker.messageId, 'the picker the tap came from is edited in place');
    assert.equal(rerendered?.text, '⚙️ Effort in this topic: high — set for this topic');
    assert.ok(harness.getKeyboardLabels(rerendered).flat().includes('high ✓'));
  });

  it('«As in General» drops the topic\'s own pick: the topic follows the instance default again, and the button promises General\'s value', async () => {
    writeSettingsByHand(JSON.stringify({ defaultEffort: 'low' }));
    await harness.runCommand('effort');
    const picker = harness.replies.at(-1);
    assert.equal(picker?.text, '⚙️ Effort in this topic: high — set for this topic', 'the topic\'s own pick wins over the instance default');
    assert.equal(harness.getKeyboardLabels(picker).flat().at(-1), 'As in General (low)');
    assert.ok(picker?.messageId);

    const answersBefore = harness.fakeTelegram.callbackAnswers.length;
    const repliesBefore = harness.replies.length;
    await harness.tapButton(picker.messageId, effortSameCallback);
    assert.equal(harness.fakeTelegram.callbackAnswers.length, answersBefore + 1);
    assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), 'As in General: low');
    assert.equal(harness.replies[repliesBefore]?.text, '✅ Effort in this topic follows General again: low');
    assert.equal(harness.edits.at(-1)?.text, '⚙️ Effort in this topic: low — as in General');
    assert.ok(harness.getKeyboardLabels(harness.edits.at(-1)).flat().includes('low ✓'));
    assert.ok(harness.pinnedStatusUpdateKeys.length > 0, 'the banner is refreshed');

    await harness.runCommand('effort');
    assert.equal(harness.replies.at(-1)?.text, '⚙️ Effort in this topic: low — as in General', 'the pick is gone from disk, not just from the screen');
  });

  it('a RUNNING session keeps the level it started with when General moves on: /effort shows it with the next start\'s level, and «As in General» brings the session to the default', async () => {
    fs.writeFileSync(`${settingsPath}.tmp`, JSON.stringify({ defaultEffort: 'low' }));
    fs.renameSync(`${settingsPath}.tmp`, settingsPath);
    const adapter = getThreadAdapter(harness.key);
    assert.ok(adapter instanceof ClaudeJsonStreamAdapter, 'the harness topic runs the default Claude backend');
    const session = createStreamSessionFixture({ key: harness.key, effort: 'xhigh', model: null });
    adapter['sessions'].set(keyString, session);
    const respawns: Array<string | null> = [];
    const originalRespawn = adapter['respawnWithChange'];
    adapter['respawnWithChange'] = async (target, change) => {
      respawns.push(change.effort);
      target.effort = change.effort; // what the re-spawn leaves behind: the process runs the new level
    };
    try {
      await harness.runCommand('effort');
      const picker = harness.replies.at(-1);
      assert.equal(picker?.text, '⚙️ Effort in this topic: xhigh (low from the next start) — as in General');
      assert.ok(harness.getKeyboardLabels(picker).flat().includes('xhigh ✓'), 'the ✓ is on what the session runs');
      assert.ok(!harness.getKeyboardLabels(picker).flat().includes('low ✓'));
      assert.equal(harness.getKeyboardLabels(picker).flat().at(-1), 'As in General (low)');
      assert.ok(picker?.messageId);

      await harness.tapButton(picker.messageId, effortSameCallback);
      assert.deepEqual(respawns, ['low'], 'the live process is re-spawned at General\'s value');
      assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), 'As in General: low');
      assert.equal(harness.edits.at(-1)?.text, '⚙️ Effort in this topic: low — as in General', 'nothing left to hint at');
    } finally {
      adapter['respawnWithChange'] = originalRespawn;
      adapter['sessions'].delete(keyString);
    }
  });

  it('/effort in General is the instance default: it says so, ✓ marks the current default, and a tap writes settings.json and confirms what that means', async () => {
    fs.rmSync(settingsPath, { force: true });
    harness.isGeneral = true;
    try {
      await harness.runCommand('effort');
      const picker = harness.replies.at(-1);
      assert.equal(
        picker?.text,
        '⚙️ Default effort for all topics: medium\nEvery topic that has no effort of its own runs at this level; topics with their own effort keep it.',
      );
      assert.deepEqual(harness.getKeyboardData(picker), [
        ['effort_low', 'effort_medium', 'effort_high'],
        ['effort_xhigh', 'effort_max', 'effort_auto'],
        ['effort_ultracode'],
      ], 'the Claude levels and no «as in General» button — General has nothing to follow');
      assert.ok(harness.getKeyboardLabels(picker).flat().includes('medium ✓'));
      assert.ok(picker?.messageId);

      const answersBefore = harness.fakeTelegram.callbackAnswers.length;
      const repliesBefore = harness.replies.length;
      const bannerUpdatesBefore = harness.pinnedStatusUpdateKeys.length;
      await harness.tapButton(picker.messageId, 'effort_xhigh');
      assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), 'Effort: xhigh');
      assert.equal(harness.fakeTelegram.callbackAnswers.length, answersBefore + 1);
      assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), { defaultEffort: 'xhigh' });
      assert.equal(getInstanceDefaultEffort(), 'xhigh', 'sessions started from now on read it');
      assert.match(harness.replies[repliesBefore]?.text ?? '', /^✅ Default effort for all topics: xhigh\nTopics with their own effort keep it\. It applies from each topic's next session start or wake-up — running sessions are not restarted\.$/);
      assert.match(harness.edits.at(-1)?.text ?? '', /^⚙️ Default effort for all topics: xhigh\n/);
      assert.ok(harness.getKeyboardLabels(harness.edits.at(-1)).flat().includes('xhigh ✓'));
      assert.equal(harness.pinnedStatusUpdateKeys.length, bannerUpdatesBefore, 'General has no banner to refresh');
    } finally {
      harness.isGeneral = false;
    }
  });

  it('/effort <level> in General sets the default too; an unknown level is refused and nothing is written', async () => {
    harness.isGeneral = true;
    try {
      await harness.runCommand('effort', 'max');
      assert.match(harness.replies.at(-1)?.text ?? '', /^✅ Default effort for all topics: max\n/);
      assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), { defaultEffort: 'max' });

      await harness.runCommand('effort', 'turbo');
      assert.match(harness.replies.at(-1)?.text ?? '', /`turbo` is not valid\. Available: low, medium, high, xhigh, max, auto, ultracode\./);
      assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), { defaultEffort: 'max' });
    } finally {
      harness.isGeneral = false;
    }
  });

  it('a General pick keeps the other settings in the file, and replaces a broken one (the tapped button is the fix) after logging the problem once', async () => {
    resetInstanceSettingsCache();
    writeSettingsByHand('{ "defaultEffort": "mid" }');
    assert.equal(getInstanceDefaultEffort(), 'medium', 'an unknown level falls back to the code default');
    assert.equal(getInstanceDefaultEffort(), 'medium');
    assert.equal(settingsLogLines.filter((line) => line.includes('settings.json defaultEffort')).length, 1, 'one named error, not one per read');

    harness.isGeneral = true;
    try {
      await harness.runCommand('effort', 'high');
    } finally {
      harness.isGeneral = false;
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), { defaultEffort: 'high' });
    assert.equal(getInstanceDefaultEffort(), 'high');
  });

  it('a General pick that cannot be written says so with the path, on the button and in the topic, and changes nothing', async () => {
    const realSettingsPath = settingsPath;
    fs.writeFileSync(path.join(settingsDir, 'plainFile'), '');
    settingsPath = path.join(settingsDir, 'plainFile', 'settings.json'); // a file where the directory should be
    harness.isGeneral = true;
    try {
      await harness.runCommand('effort');
      const picker = harness.replies.at(-1);
      assert.ok(picker?.messageId);
      const repliesBefore = harness.replies.length;
      await harness.tapButton(picker.messageId, 'effort_low');
      // `mkdir -p` over a file is EEXIST on Linux, ENOTDIR elsewhere: the code is the failing call's own.
      const code = /^Error: (ENOTDIR|EEXIST)$/.exec(harness.fakeTelegram.callbackAnswers.at(-1) ?? '')?.[1];
      assert.ok(code, `the button names the errno code: ${harness.fakeTelegram.callbackAnswers.at(-1)}`);
      assert.equal(
        harness.replies[repliesBefore]?.text,
        `⚠️ The default effort could not be saved: ${settingsPath} cannot be written (${code}). Make its directory writable.`,
      );
      assert.equal(harness.replies.length, repliesBefore + 1, 'no confirmation of a change that did not happen');
    } finally {
      harness.isGeneral = false;
      settingsPath = realSettingsPath;
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(realSettingsPath, 'utf8')), { defaultEffort: 'high' });
  });

  it('/connect refuses an invalid provider id and deletes a secret typed beside it', async () => {
    await harness.runCommand('connect', 'bad!id');
    assert.match(harness.replies.at(-1)?.text ?? '', /Invalid provider id `bad!id`/);
    assert.deepEqual(harness.deletedMessageIds, [], 'no key was typed, nothing to delete');

    await harness.runCommand('connect', 'bad!id sk-not-a-real-key', secretMessageId);
    assert.match(harness.replies.at(-1)?.text ?? '', /Invalid provider id/);
    assert.deepEqual(harness.deletedMessageIds, [secretMessageId], 'a key typed with a refused command is still a secret');
  });

  it('an empty or implausible key re-arms the pending connect and stays visible — it is not a secret', async () => {
    awaitingModelSelection.add(keyString);
    awaitingSessionSelection.add(keyString);
    awaitingFolderName.add(keyString);
    const deletedBefore = harness.deletedMessageIds.length;

    await modelProviders.handleProviderConnectKey(harness.key, 'openai', '   ', null);
    assert.deepEqual(pendingProviderConnects.get(keyString), { providerId: 'openai' });
    assert.equal(awaitingModelSelection.has(keyString) || awaitingSessionSelection.has(keyString) || awaitingFolderName.has(keyString), false, 'arming a connect cancels the other single-purpose input modes');

    pendingProviderConnects.delete(keyString);
    await modelProviders.handleProviderConnectKey(harness.key, 'openai', 'this is not a key', 12);
    assert.deepEqual(pendingProviderConnects.get(keyString), { providerId: 'openai' }, 'the connect stays armed for the retry');
    assert.equal(harness.deletedMessageIds.length, deletedBefore, 'an implausible value is kept visible in the topic');
  });

  it('the method picker\'s OAuth button starts the sign-in driver; an expired snapshot says so', async () => {
    const message = harness.fakeTelegram.pushOperatorMessage(harnessThreadId, 'method picker');
    const answersBefore = harness.fakeTelegram.callbackAnswers.length;
    await harness.tapButton(message, 'connm_0');
    assert.equal(harness.fakeTelegram.callbackAnswers.length, answersBefore + 1);
    assert.deepEqual(signInRequests, [], 'no snapshot, no sign-in');

    connectMethodLists.set(keyString, {
      providerId: 'openai',
      methods: [{ type: 'oauth', label: 'ChatGPT Pro/Plus (browser)', hasPrompts: false }],
    });
    await harness.tapButton(message, 'connm_0');
    assert.deepEqual(signInRequests, [{ key: harness.key, providerId: 'openai', methodLabel: 'ChatGPT Pro/Plus (browser)' }]);
  });
});
