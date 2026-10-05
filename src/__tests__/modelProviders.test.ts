/**
 * @description The `/model`, `/effort`, `/connect` and `/disconnect` flows
 * (`connectors/telegram/commands/modelProviders.ts`) wired to ports
 * (`commandModuleHarness.ts`: a real telegraf instance against the fake Bot API, the real state store,
 * recording topic sends). The thread runs the default Claude backend, whose model list needs no process.
 * Pinned:
 *
 *   • WIRING — the commands and the ten buttons the module registers, in order;
 *   • the picker and its per-thread state, which the bot also reads (the numbered-pick arming) and clears
 *     (teardown) — owned by the bot and passed in;
 *   • the provider-credential flow's guards: a key that cannot be real is never taken for a secret, and
 *     arming a pending connect cancels the other single-purpose input modes;
 *   • the method picker's OAuth button reaching the sign-in driver port.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createModelProviders, type PendingProviderConnect } from '../connectors/telegram/commands/modelProviders';
import { keyToString, type SessionKey } from '../sessionKey';
import type { OpenCodeAuthMethod } from '../utils/openCodeAuthLogin';
import {
  modelPickCallbackRe,
  modelPickerBackCallback,
  modelPickerNoopCallback,
  providerHideCallbackRe,
  providerPageCallbackRe,
  providerShowCallbackRe,
} from '../utils/modelPickerPlan';
import { disconnectProviderCallbackRe } from '../utils/providerDisconnectPlan';
import { createCommandHarness, harnessThreadId, type CommandHarness } from './commandModuleHarness';

const expectedCommandNames = ['connect', 'disconnect', 'model', 'effort'];
const expectedActionPatterns = [
  String(providerPageCallbackRe),
  String(modelPickCallbackRe),
  String(providerHideCallbackRe),
  String(providerShowCallbackRe),
  modelPickerBackCallback,
  modelPickerNoopCallback,
  String(disconnectProviderCallbackRe),
  '/^model_(.+)$/',
  '/^connm_(\\d+)$/',
  '/^effort_(.+)$/',
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

describe('modelProviders: the model, effort and provider flows over their ports', () => {
  before(async () => {
    harness = await createCommandHarness();
    keyString = keyToString(harness.key);
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
    });
    modelProviders.registerProviderCommands();
    modelProviders.registerModelCommands();
    modelProviders.registerModelCallbacks();
  });

  after(async () => {
    await harness.stop();
  });

  it('registers /connect /disconnect /model /effort and its ten buttons, in the order the bot has always had', () => {
    assert.deepEqual(harness.registeredCommandNames, expectedCommandNames);
    assert.deepEqual(harness.registeredActionPatterns, expectedActionPatterns);
  });

  it('/model lists the backend\'s models and arms the numbered pick on the page it shows', async () => {
    await harness.runCommand('model');
    const picker = harness.replies.at(-1);
    assert.match(picker?.text ?? '', /3 models/);
    assert.match(picker?.text ?? '', /1\. sonnet\n2\. opus\n3\. haiku/);
    assert.deepEqual(harness.getKeyboardData(picker), [['mdl_0_0'], ['mdl_0_1'], ['mdl_0_2']]);
    assert.deepEqual(threadModelLists.get(keyString), ['sonnet', 'opus', 'haiku']);
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

  it('/effort offers the levels; a tap is saved for the next session and answered', async () => {
    await harness.runCommand('effort');
    const picker = harness.replies.at(-1);
    assert.match(picker?.text ?? '', /Current effort/);
    assert.deepEqual(harness.getKeyboardData(picker), [
      ['effort_low', 'effort_medium', 'effort_high'],
      ['effort_xhigh', 'effort_max', 'effort_auto'],
      ['effort_ultracode'],
    ]);
    assert.ok(picker?.messageId);
    const answersBefore = harness.fakeTelegram.callbackAnswers.length;
    await harness.tapButton(picker.messageId, 'effort_high');
    assert.equal(harness.fakeTelegram.callbackAnswers.length, answersBefore + 1);
    assert.match(harness.fakeTelegram.callbackAnswers.at(-1) ?? '', /Level saved/);
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
