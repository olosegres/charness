/**
 * @description The `/fallback` picker (`connectors/telegram/commands/fallbackChain.ts`) wired to ports
 * (`commandModuleHarness.ts`: a real telegraf instance against the fake Bot API, the real state store,
 * recording topic sends) and a canned detection. Pinned:
 *
 *   • WIRING — the command and the buttons it registers, in order;
 *   • the empty picker in General (add / propose, the auto-switch toggle), the read-only picker in a topic;
 *   • «propose» drafts the chain from the detection and persists it; the rows show availability;
 *   • reorder / remove through the buttons, and a stale keyboard (old revision) only re-renders;
 *   • the two-step «add»: a Claude account + model, an OpenCode provider + model off the message's snapshot;
 *   • the auto-switch toggle writes the shared setting; the limit-notice switch button reaches the port
 *     with its episode and index and consumes the notice, a stale tap only answers.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFallbackChain } from '../connectors/telegram/commands/fallbackChain';
import type { SessionKey } from '../sessionKey';
import { getFallbackChainRevision, type FallbackChainEntry, type FallbackDetection } from '../utils/fallbackChain';
import type { ClaudeProfileUsageView } from '../utils/claudeUsage';
import { createCommandHarness, type CommandHarness } from './commandModuleHarness';

let harness: CommandHarness;
let isGeneralTopic = true;
let topicPosition: FallbackChainEntry | null = null;
const switchTaps: Array<{ key: SessionKey; episodeId: number; index: number }> = [];
let switchOutcome: string | null = null;

function buildProfile(name: string, loggedIn: boolean | undefined = true): ClaudeProfileUsageView {
  return { name, configDir: null, loggedIn, email: `${name}@example.com`, subscriptionType: 'max', usage: undefined, limitedUntil: null };
}

const detection: FallbackDetection = {
  claudeProfiles: [buildProfile('default'), buildProfile('work'), buildProfile('out', false)],
  openCodeModels: ['openai/gpt-5', 'openai/gpt-5-mini', 'google/gemini-2.5-pro'],
  recentOpenCodeModels: ['openai/gpt-5-mini'],
  openCodeLimits: { 'google/gemini-2.5-pro': '2999-01-01T00:00:00.000Z' },
};

const claude = (profile: string, model: string | null = null): FallbackChainEntry => ({ backend: 'claude', profile, model });
const openCode = (providerId: string, modelId: string): FallbackChainEntry => ({ backend: 'opencode', providerId, modelId });

describe('fallbackChain: /fallback over its ports', () => {
  before(async () => {
    harness = await createCommandHarness();
    const feature = createFallbackChain({
      ...harness.core,
      checkIsGeneral: () => isGeneralTopic,
      getInstanceTimezone: () => 'UTC',
      detectFallbackOptions: async () => detection,
      getTopicPosition: () => topicPosition,
      takeSwitchOffer: async (key, episodeId, index) => {
        switchTaps.push({ key, episodeId, index });
        return switchOutcome;
      },
    });
    feature.registerFallbackChainCommands();
    feature.registerFallbackChainCallbacks();
    await harness.state.setFallbackChain([]);
  });

  after(async () => {
    await harness.state.setFallbackChain([]);
    await harness.stop();
  });

  it('registers /fallback and its buttons', () => {
    assert.deepEqual(harness.registeredCommandNames, ['fallback']);
    assert.deepEqual(harness.registeredActionPatterns, [
      String(/^fbk_up_(\d{1,2})_([0-9a-f]{8})$/),
      String(/^fbk_dn_(\d{1,2})_([0-9a-f]{8})$/),
      String(/^fbk_rm_(\d{1,2})_([0-9a-f]{8})$/),
      'fbk_add',
      String(/^fbk_addc_([a-z0-9][a-z0-9_-]{0,31})$/),
      String(/^fbk_addcm_([a-z0-9][a-z0-9_-]{0,31})_(-|[a-z0-9][a-z0-9._-]{0,31})$/),
      String(/^fbk_addp_(\d{1,2})$/),
      String(/^fbk_addpg_(\d{1,3})$/),
      String(/^fbk_addm_(\d{1,3})$/),
      'fbk_prop',
      'fbk_propok',
      'fbk_clear',
      'fbk_back',
      'fbk_asw_on',
      'fbk_asw_off',
      String(/^fbsw_(\d+)_(\d{1,2})$/),
    ]);
  });

  it('the bare command in General renders the empty picker with add / propose and the auto-switch toggle', async () => {
    await harness.runCommand('fallback');
    const picker = harness.replies.at(-1);
    assert.match(picker?.text ?? '', /It is empty/);
    assert.deepEqual(harness.getKeyboardData(picker), [['fbk_add', 'fbk_prop'], ['fbk_asw_on']]);
  });

  it('«propose» on an empty chain drafts it from the detection: signed-in profiles, then the recent pick, then each provider\'s best', async () => {
    const pickerId = harness.replies.at(-1)!.messageId!;
    await harness.tapButton(pickerId, 'fbk_prop');
    assert.deepEqual(harness.state.getFallbackChain(), [
      claude('default'), claude('work'), openCode('openai', 'gpt-5-mini'), openCode('openai', 'gpt-5'), openCode('google', 'gemini-2.5-pro'),
    ]);
    const rerender = harness.edits.at(-1);
    assert.equal(rerender?.messageId, pickerId);
    assert.match(rerender?.text ?? '', /1\. Claude · default · topic's model\n2\. Claude · work · topic's model\n3\. OpenCode · openai\/gpt-5-mini/);
    assert.match(rerender?.text ?? '', /5\. OpenCode · google\/gemini-2\.5-pro — ⛔ limited until/);
    const revision = getFallbackChainRevision(harness.state.getFallbackChain());
    const rows = harness.getKeyboardData(rerender);
    assert.deepEqual(rows[0], [`fbk_up_0_${revision}`, `fbk_dn_0_${revision}`, `fbk_rm_0_${revision}`]);
    assert.deepEqual(rows.at(-2), ['fbk_add', 'fbk_prop', 'fbk_clear']);
    assert.deepEqual(rows.at(-1), ['fbk_asw_on']);
  });

  it('reorder and remove go through the revision-baked buttons; a stale revision changes nothing and re-renders', async () => {
    const pickerId = harness.replies.at(-1)!.messageId!;
    const revision = getFallbackChainRevision(harness.state.getFallbackChain());
    await harness.tapButton(pickerId, `fbk_dn_0_${revision}`);
    assert.deepEqual(harness.state.getFallbackChain().slice(0, 2), [claude('work'), claude('default')]);
    const editsBefore = harness.edits.length;
    await harness.tapButton(pickerId, `fbk_rm_0_${revision}`); // the old revision: the chain moved on
    assert.equal(harness.state.getFallbackChain().length, 5, 'a stale keyboard removes nothing');
    assert.equal(harness.edits.length, editsBefore + 1, 'but the picker is re-rendered');
    const fresh = getFallbackChainRevision(harness.state.getFallbackChain());
    await harness.tapButton(pickerId, `fbk_rm_4_${fresh}`);
    assert.deepEqual(harness.state.getFallbackChain().at(-1), openCode('openai', 'gpt-5'));
  });

  it('«add» → a Claude account → a model: the entry lands with the model; the topic-model choice stores null', async () => {
    const pickerId = harness.replies.at(-1)!.messageId!;
    await harness.tapButton(pickerId, 'fbk_add');
    const step1 = harness.edits.at(-1);
    assert.match(step1?.text ?? '', /pick the account or provider/);
    assert.deepEqual(harness.getKeyboardData(step1), [
      ['fbk_addc_default'], ['fbk_addc_work'], // `out` is not signed in
      ['fbk_addp_0'], ['fbk_addp_1'],
      ['fbk_back'],
    ]);
    await harness.tapButton(pickerId, 'fbk_addc_work');
    const step2 = harness.edits.at(-1);
    assert.deepEqual(harness.getKeyboardData(step2), [
      ['fbk_addcm_work_-'],
      ['fbk_addcm_work_fable', 'fbk_addcm_work_opus', 'fbk_addcm_work_sonnet', 'fbk_addcm_work_haiku'],
      ['fbk_back'],
    ]);
    await harness.tapButton(pickerId, 'fbk_addcm_work_opus');
    assert.deepEqual(harness.state.getFallbackChain().at(-1), claude('work', 'opus'));
    await harness.tapButton(pickerId, 'fbk_add');
    await harness.tapButton(pickerId, 'fbk_addc_work');
    const lengthBefore = harness.state.getFallbackChain().length;
    await harness.tapButton(pickerId, 'fbk_addcm_work_-');
    assert.equal(harness.state.getFallbackChain().length, lengthBefore, 'already in the chain');
  });

  it('«add» → an OpenCode provider → a model off the message\'s snapshot; a tap without a snapshot only re-renders', async () => {
    const pickerId = harness.replies.at(-1)!.messageId!;
    await harness.tapButton(pickerId, 'fbk_add');
    await harness.tapButton(pickerId, 'fbk_addp_0'); // openai
    const models = harness.edits.at(-1);
    assert.match(models?.text ?? '', /OpenCode · openai — pick the model/);
    assert.deepEqual(harness.getKeyboardData(models), [['fbk_addm_0'], ['fbk_addm_1'], ['fbk_back']]);
    await harness.state.setFallbackChain(harness.state.getFallbackChain().filter((entry) => entry.backend !== 'opencode' || entry.modelId !== 'gpt-5-mini'));
    await harness.tapButton(pickerId, 'fbk_addm_1');
    assert.deepEqual(harness.state.getFallbackChain().at(-1), openCode('openai', 'gpt-5-mini'));
    const lengthBefore = harness.state.getFallbackChain().length;
    await harness.tapButton(pickerId, 'fbk_addm_1'); // the snapshot was consumed by the re-render
    assert.equal(harness.state.getFallbackChain().length, lengthBefore);
  });

  it('«propose» over an existing chain asks first; «clear» empties it; the text verbs mirror the buttons', async () => {
    const pickerId = harness.replies.at(-1)!.messageId!;
    await harness.tapButton(pickerId, 'fbk_prop');
    assert.deepEqual(harness.getKeyboardData(harness.edits.at(-1)), [['fbk_propok'], ['fbk_back']]);
    await harness.tapButton(pickerId, 'fbk_propok');
    assert.equal(harness.state.getFallbackChain().length, 5);
    await harness.tapButton(pickerId, 'fbk_clear');
    assert.deepEqual(harness.state.getFallbackChain(), []);
    await harness.runCommand('fallback', 'propose');
    assert.equal(harness.state.getFallbackChain().length, 5);
    await harness.runCommand('fallback', 'clear');
    assert.deepEqual(harness.state.getFallbackChain(), []);
  });

  it('the auto-switch toggle writes the shared setting (General: the instance default; a topic: its override)', async () => {
    await harness.runCommand('fallback');
    const pickerId = harness.replies.at(-1)!.messageId!;
    await harness.tapButton(pickerId, 'fbk_asw_on');
    assert.equal(harness.state.getClaudeAutoSwitchOnLimitGlobalDefault(), true);
    assert.deepEqual(harness.getKeyboardData(harness.edits.at(-1)).at(-1), ['fbk_asw_off']);
    await harness.runCommand('fallback', 'autoswitch off');
    assert.equal(harness.state.getClaudeAutoSwitchOnLimitGlobalDefault(), false);
    isGeneralTopic = false;
    await harness.runCommand('fallback', 'autoswitch on');
    assert.equal(harness.state.getClaudeAutoSwitchOnLimitOverride(harness.key), true);
    isGeneralTopic = true;
  });

  it('in a regular topic the picker is read-only and names the topic\'s position; edits are refused', async () => {
    await harness.state.setFallbackChain([claude('work', 'opus'), openCode('openai', 'gpt-5')]);
    isGeneralTopic = false;
    topicPosition = claude('work', 'claude-opus-4-1');
    await harness.runCommand('fallback');
    const picker = harness.replies.at(-1);
    assert.match(picker?.text ?? '', /1\. Claude · work · opus ✓/);
    assert.match(picker?.text ?? '', /This topic runs on: Claude · work · claude-opus-4-1/);
    assert.deepEqual(harness.getKeyboardData(picker), [['fbk_asw_off']]);
    const revision = getFallbackChainRevision(harness.state.getFallbackChain());
    await harness.tapButton(picker!.messageId!, `fbk_rm_0_${revision}`);
    assert.equal(harness.state.getFallbackChain().length, 2, 'a topic cannot edit the chain');
    await harness.runCommand('fallback', 'clear');
    assert.equal(harness.state.getFallbackChain().length, 2);
    assert.match(harness.replies.at(-1)?.text ?? '', /edited in the General topic/);
    isGeneralTopic = true;
  });

  it('a «switch to …» tap on a limit notice reaches the port with its episode and index and consumes the notice; a stale tap only answers', async () => {
    const noticeId = (await harness.core.replyToThread(harness.key, 'limit notice'))!;
    switchOutcome = 'switched to work';
    await harness.tapButton(noticeId, 'fbsw_1760000000000_1');
    assert.deepEqual(switchTaps.at(-1), { key: harness.key, episodeId: 1760000000000, index: 1 });
    const consumed = harness.edits.at(-1);
    assert.equal(consumed?.messageId, noticeId);
    assert.equal(consumed?.text, 'switched to work');
    assert.deepEqual(harness.getKeyboardData(consumed), [], 'the keyboard is dropped with the confirmation');

    const editsBefore = harness.edits.length;
    switchOutcome = null;
    await harness.tapButton(noticeId, 'fbsw_1750000000000_0');
    assert.equal(switchTaps.at(-1)?.episodeId, 1750000000000);
    assert.equal(harness.edits.length, editsBefore, 'a stale tap edits nothing');
  });
});
