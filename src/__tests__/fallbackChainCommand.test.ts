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
 *   • the auto-switch toggle writes the shared setting; in a topic each setting is ONE full-width button
 *     opening a sub-menu (ON / OFF / As in General + Back) whose choice applies and returns to the screen;
 *   • the SHORT text: the Claude accounts' usage block on top — a heading that says the percentages are USED,
 *     then the `/accounts` renderer's lines (no arrow, Fable only when the account has that window; signed-out
 *     named, never-polled left out) — then what the topic runs on + where its settings come from, then the
 *     list's heading;
 *   • the limit-notice switch button reaches the port with its episode and index and consumes the notice,
 *     a stale tap only answers.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSkipArmedRetryCallbackData } from '../utils/autoContinueOnLimit';
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
let armedFireAt: number | null = null;
const usageRefreshes: Array<{ maxAgeMs?: number }> = [];

function buildProfile(name: string, loggedIn: boolean | undefined = true): ClaudeProfileUsageView {
  return { name, configDir: null, loggedIn, email: `${name}@example.com`, subscriptionType: 'max', usage: undefined, limitedUntil: null };
}

let detection: FallbackDetection = {
  claudeProfiles: [buildProfile('default'), buildProfile('work'), buildProfile('out', false)],
  openCodeModels: ['openai/gpt-5', 'openai/gpt-5-mini', 'google/gemini-2.5-pro'],
  recentOpenCodeModels: ['openai/gpt-5-mini'],
  openCodeLimits: { 'google/gemini-2.5-pro': '2999-01-01T00:00:00.000Z' },
};

const claude = (profile: string, model: string | null = null): FallbackChainEntry => ({ backend: 'claude', profile, model });
const openCode = (providerId: string, modelId: string): FallbackChainEntry => ({ backend: 'opencode', providerId, modelId });

describe('fallbackChain: /limits over its ports', () => {
  before(async () => {
    harness = await createCommandHarness();
    const feature = createFallbackChain({
      ...harness.core,
      checkIsGeneral: () => isGeneralTopic,
      getInstanceTimezone: () => 'UTC',
      refreshClaudeUsage: async (options) => {
        usageRefreshes.push(options);
      },
      detectFallbackOptions: async () => detection,
      getTopicPosition: () => topicPosition,
      applyAutoContinue: async (key, isGeneral, enabled) => {
        if (isGeneral) await harness.state.setAutoContinueOnLimitGlobalDefault(enabled ?? true);
        else await harness.state.setAutoContinueOnLimitOverride(key, enabled);
        return '';
      },
      getArmedLimitRetryFireAt: () => armedFireAt,
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

  it('registers /limits (+ the hidden /fallback alias) and its buttons', () => {
    assert.deepEqual(harness.registeredCommandNames, ['limits', 'fallback']);
    assert.deepEqual(harness.registeredActionPatterns, [
      String(/^fbk_up_(\d{1,2})_([0-9a-f]{8})$/),
      String(/^fbk_dn_(\d{1,2})_([0-9a-f]{8})$/),
      String(/^fbk_tg_(\d{1,2})_([0-9a-f]{8})$/),
      String(/^fbk_rm_(\d{1,2})_([0-9a-f]{8})$/),
      String(/^fbk_op_(\d{1,2})_([0-9a-f]{8})$/),
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
      'fbk_set_asw',
      'fbk_set_wait',
      'fbk_asw_on',
      'fbk_asw_off',
      'fbk_asw_same',
      'fbk_wait_on',
      'fbk_wait_off',
      'fbk_wait_same',
      String(/^fbsw_(\d+)_(\d{1,2})$/),
    ]);
  });

  it('the bare command in General renders the empty screen with add / rebuild and the two instance-default toggles', async () => {
    await harness.runCommand('limits');
    const picker = harness.replies.at(-1);
    assert.equal(
      picker?.text,
      'Usage (% used)\n• out — not signed in\n\nDefaults for all topics.\n\n🪜 No fallback models yet — only signed-in Claude accounts are tried. ➕ Add or 🔄 Fill from connected.',
      'the usage block (its heading, a signed-out account named, a never-polled one left out), the General note, the empty-list note — nothing else',
    );
    assert.doesNotMatch(picker?.text ?? '', /How it works|Auto switch|Wait for/, 'the settings are on the buttons, not repeated in the text');
    assert.deepEqual(usageRefreshes.at(-1), { maxAgeMs: 60_000 }, 'the usage is refreshed on demand (a minute\'s cache) before the screen is built');
    assert.deepEqual(harness.getKeyboardLabels(picker)[0], ['➕ Add', '🔄 Fill from connected']);
    assert.deepEqual(harness.getKeyboardData(picker), [['fbk_add', 'fbk_prop'], ['fbk_asw_on'], ['fbk_wait_off']]);
  });

  it('«propose» on an empty chain drafts it from the detection: signed-in profiles, then the recent pick, then each provider\'s best', async () => {
    const pickerId = harness.replies.at(-1)!.messageId!;
    await harness.tapButton(pickerId, 'fbk_prop');
    assert.deepEqual(harness.state.getFallbackChain(), [
      claude('default'), claude('work'), openCode('openai', 'gpt-5-mini'), openCode('openai', 'gpt-5'), openCode('google', 'gemini-2.5-pro'),
    ]);
    const rerender = harness.edits.at(-1);
    assert.equal(rerender?.messageId, pickerId);
    assert.doesNotMatch(rerender?.text ?? '', /^\d\. /m, 'the list is on the buttons, not in the text');
    assert.match(rerender?.text ?? '', /🪜 Fallback models, top first:$/);
    const revision = getFallbackChainRevision(harness.state.getFallbackChain());
    const rows = harness.getKeyboardData(rerender);
    const labels = harness.getKeyboardLabels(rerender);
    assert.deepEqual(rows.slice(0, 5), [0, 1, 2, 3, 4].map((i) => [`fbk_op_${i}_${revision}`]), 'one full-width button per rung');
    assert.equal(labels[0][0], "1. Claude · default · topic's model");
    assert.equal(labels[2][0], '3. openai / gpt-5-mini');
    assert.match(labels[4][0], /^5\. google \/ gemini-2\.5-pro ⛔ /);
    assert.deepEqual(rows.at(-3), ['fbk_add', 'fbk_prop', 'fbk_clear']);
    assert.deepEqual(rows.slice(-2), [['fbk_asw_on'], ['fbk_wait_off']]);
    for (const row of rows) for (const data of row) assert.ok(Buffer.byteLength(data) <= 64, data);
  });

  it('a rung opens in its own view in the same message; up / down / toggle stay there, remove goes back to the list; a stale revision only re-renders', async () => {
    const pickerId = harness.replies.at(-1)!.messageId!;
    const revision = getFallbackChainRevision(harness.state.getFallbackChain());
    await harness.tapButton(pickerId, `fbk_op_0_${revision}`);
    let detail = harness.edits.at(-1)!;
    assert.equal(detail.messageId, pickerId);
    assert.equal(detail.text, "🪜 1 of 5: Claude · default · topic's model\n✅ Ready.");
    assert.deepEqual(harness.getKeyboardData(detail), [
      [`fbk_dn_0_${revision}`], [`fbk_tg_0_${revision}`, `fbk_rm_0_${revision}`], ['fbk_back'],
    ], 'the first rung has no «up»');
    assert.deepEqual(harness.getKeyboardLabels(detail), [['⬇️ Down'], ["🚫 Don't use", '🗑 Remove'], ['⬅️ Back']]);

    await harness.tapButton(pickerId, `fbk_dn_0_${revision}`);
    assert.deepEqual(harness.state.getFallbackChain().slice(0, 2), [claude('work'), claude('default')]);
    detail = harness.edits.at(-1)!;
    assert.match(detail.text ?? '', /^🪜 2 of 5: Claude · default/, 'the view follows the rung to its new place');
    const fresh = getFallbackChainRevision(harness.state.getFallbackChain());
    assert.deepEqual(harness.getKeyboardData(detail)[0], [`fbk_up_1_${fresh}`, `fbk_dn_1_${fresh}`]);

    const editsBefore = harness.edits.length;
    await harness.tapButton(pickerId, `fbk_rm_0_${revision}`); // the old revision: the chain moved on
    assert.equal(harness.state.getFallbackChain().length, 5, 'a stale keyboard removes nothing');
    assert.equal(harness.edits.length, editsBefore + 1, 'but the picker is re-rendered');
    assert.match(harness.edits.at(-1)?.text ?? '', /🪜 Fallback models, top first:$/, 'as the list');
    await harness.tapButton(pickerId, `fbk_op_0_${revision}`); // a stale open
    assert.match(harness.edits.at(-1)?.text ?? '', /🪜 Fallback models, top first:$/);

    await harness.tapButton(pickerId, `fbk_rm_4_${fresh}`);
    assert.deepEqual(harness.state.getFallbackChain().at(-1), openCode('openai', 'gpt-5'));
    assert.match(harness.edits.at(-1)?.text ?? '', /🪜 Fallback models, top first:$/, 'after a removal: back to the list');
    // The last rung has no «down».
    const last = harness.state.getFallbackChain().length - 1;
    const now = getFallbackChainRevision(harness.state.getFallbackChain());
    await harness.tapButton(pickerId, `fbk_op_${last}_${now}`);
    assert.deepEqual(harness.getKeyboardLabels(harness.edits.at(-1))[0], ['⬆️ Up']);
  });

  it('«add» → a Claude account → a model: the entry lands with the model; the topic-model choice stores null', async () => {
    const pickerId = harness.replies.at(-1)!.messageId!;
    await harness.tapButton(pickerId, 'fbk_add');
    const step1 = harness.edits.at(-1);
    assert.equal(step1?.text, '➕ Pick an account or provider:');
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
    assert.equal(models?.text, '➕ OpenCode · openai — pick a model:');
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

  it('the switch toggle writes the shared setting (General: the instance default; a topic: its override)', async () => {
    await harness.runCommand('limits');
    const pickerId = harness.replies.at(-1)!.messageId!;
    await harness.tapButton(pickerId, 'fbk_asw_on');
    assert.equal(harness.state.getClaudeAutoSwitchOnLimitGlobalDefault(), true);
    assert.deepEqual(harness.getKeyboardData(harness.edits.at(-1)).at(-2), ['fbk_asw_off']);
    await harness.runCommand('fallback', 'autoswitch off'); // the old alias and verb
    assert.equal(harness.state.getClaudeAutoSwitchOnLimitGlobalDefault(), false);
    isGeneralTopic = false;
    await harness.runCommand('limits', 'switch on');
    assert.equal(harness.state.getClaudeAutoSwitchOnLimitOverride(harness.key), true);
    await harness.runCommand('limits', 'switch same');
    assert.equal(harness.state.getClaudeAutoSwitchOnLimitOverride(harness.key), undefined);
    isGeneralTopic = true;
  });

  it('the wait toggle writes the auto-continue setting through its port (General: the default; "same" is refused there)', async () => {
    await harness.runCommand('limits');
    const pickerId = harness.replies.at(-1)!.messageId!;
    await harness.tapButton(pickerId, 'fbk_wait_off');
    assert.equal(harness.state.getAutoContinueOnLimitGlobalDefault(), false);
    assert.deepEqual(harness.getKeyboardData(harness.edits.at(-1)).at(-1), ['fbk_wait_on']);
    await harness.tapButton(pickerId, 'fbk_wait_same'); // meaningless in General: nothing changes
    assert.equal(harness.state.getAutoContinueOnLimitGlobalDefault(), false);
    await harness.runCommand('limits', 'wait same');
    assert.match(harness.replies.at(-1)?.text ?? '', /^Usage: /);
    await harness.runCommand('limits', 'wait on');
    assert.equal(harness.state.getAutoContinueOnLimitGlobalDefault(), true);
  });

  it('in a regular topic the list is editable too and the topic\'s position is named', async () => {
    await harness.state.setFallbackChain([claude('work', 'opus'), openCode('openai', 'gpt-5')]);
    isGeneralTopic = false;
    topicPosition = claude('work', 'claude-opus-4-1');
    await harness.runCommand('fallback');
    const picker = harness.replies.at(-1);
    assert.equal(harness.getKeyboardLabels(picker)[0][0], '1. Claude · work · opus ✓');
    assert.match(picker?.text ?? '', /Runs on: Claude · work · claude-opus-4-1\n🔁 as in General · ⏳ as in General\n\n🪜 Fallback models, top first:$/);
    const revision = getFallbackChainRevision(harness.state.getFallbackChain());
    assert.deepEqual(harness.getKeyboardData(picker), [
      [`fbk_op_0_${revision}`],
      [`fbk_op_1_${revision}`],
      ['fbk_add', 'fbk_prop', 'fbk_clear'],
      ['fbk_set_asw'],
      ['fbk_set_wait'],
    ], 'the same list and actions as in General, then one full-width button per setting (its sub-menu)');
    await harness.tapButton(picker!.messageId!, `fbk_op_1_${revision}`);
    await harness.tapButton(picker!.messageId!, `fbk_tg_1_${revision}`);
    assert.equal(harness.state.getFallbackChain()[1].disabled, true, 'a topic edits the one instance-wide list');
    await harness.tapButton(picker!.messageId!, 'fbk_clear');
    assert.deepEqual(harness.state.getFallbackChain(), [], 'clear works from a topic');
    await harness.runCommand('fallback', 'propose');
    assert.equal(harness.state.getFallbackChain().length > 0, true, 'so does the text verb');
    await harness.state.setFallbackChain([]);
    isGeneralTopic = true;
  });

  it('a topic\'s setting buttons: one SHORT full-width button each with the effective value (its source is one line of text, a phone would cut it on the button); General keeps its single flip button', async () => {
    isGeneralTopic = false;
    await harness.state.setClaudeAutoSwitchOnLimitGlobalDefault(false);
    await harness.state.setAutoContinueOnLimitGlobalDefault(true);
    await harness.state.setClaudeAutoSwitchOnLimitOverride(harness.key, null);
    await harness.state.setAutoContinueOnLimitOverride(harness.key, null);
    await harness.runCommand('limits');
    const screen = harness.replies.at(-1);
    assert.deepEqual(harness.getKeyboardLabels(screen).slice(-2), [
      ['🔁 Auto switch: OFF'],
      ['⏳ Wait for reset: ON'],
    ]);
    for (const [label] of harness.getKeyboardLabels(screen).slice(-2)) assert.ok(label.length <= 30, `${label} fits a phone button`);
    assert.match(screen?.text ?? '', /\n🔁 as in General · ⏳ as in General\n/, 'only the source is in the text: the buttons already say name and value');
    assert.deepEqual(harness.getKeyboardData(screen).slice(-2), [['fbk_set_asw'], ['fbk_set_wait']]);
    await harness.state.setClaudeAutoSwitchOnLimitOverride(harness.key, true);
    await harness.runCommand('limits');
    assert.deepEqual(harness.getKeyboardLabels(harness.replies.at(-1)).at(-2), ['🔁 Auto switch: ON']);
    assert.match(harness.replies.at(-1)?.text ?? '', /\n🔁 set for this topic · ⏳ as in General\n/);
    await harness.state.setClaudeAutoSwitchOnLimitOverride(harness.key, null);
    isGeneralTopic = true;
    await harness.runCommand('limits');
    assert.deepEqual(harness.getKeyboardLabels(harness.replies.at(-1)).slice(-2), [
      ['🔁 Auto switch: OFF'],
      ['⏳ Wait for reset: ON'],
    ], 'General: the same shape');
    assert.deepEqual(harness.getKeyboardData(harness.replies.at(-1)).slice(-2), [['fbk_asw_on'], ['fbk_wait_off']], 'General: a tap flips');
  });

  it('a topic\'s setting sub-menu: opens in the same message with ON / OFF / As in General and Back; a choice applies and returns to the screen', async () => {
    isGeneralTopic = false;
    await harness.state.setClaudeAutoSwitchOnLimitGlobalDefault(false);
    await harness.state.setAutoContinueOnLimitGlobalDefault(true);
    await harness.state.setClaudeAutoSwitchOnLimitOverride(harness.key, null);
    await harness.state.setAutoContinueOnLimitOverride(harness.key, null);
    await harness.runCommand('limits');
    const pickerId = harness.replies.at(-1)!.messageId!;

    await harness.tapButton(pickerId, 'fbk_set_asw');
    const menu = harness.edits.at(-1);
    assert.equal(menu?.messageId, pickerId, 'the sub-menu replaces the screen in the same message');
    assert.equal(menu?.text, '🔁 Auto switch to a fallback model', 'the setting\'s name only: the ✓ below is the value\'s source');
    assert.deepEqual(harness.getKeyboardLabels(menu), [['ON'], ['OFF'], ['As in General (OFF) ✓'], ['⬅️ Back']]);
    assert.deepEqual(harness.getKeyboardData(menu), [['fbk_asw_on'], ['fbk_asw_off'], ['fbk_asw_same'], ['fbk_back']]);
    for (const data of harness.getKeyboardData(menu).flat()) assert.ok(Buffer.byteLength(data) <= 64, `${data} fits callback_data`);
    assert.equal(harness.state.getClaudeAutoSwitchOnLimitOverride(harness.key), undefined, 'opening the menu changes nothing');

    await harness.tapButton(pickerId, 'fbk_asw_on');
    assert.equal(harness.state.getClaudeAutoSwitchOnLimitOverride(harness.key), true);
    assert.equal(harness.state.getClaudeAutoSwitchOnLimitGlobalDefault(), false, 'a topic choice never touches the instance default');
    const backOnScreen = harness.edits.at(-1);
    assert.match(backOnScreen?.text ?? '', /🪜 /, 'the choice returns to the main screen');
    assert.match(backOnScreen?.text ?? '', /\n🔁 set for this topic · ⏳ as in General\n/);
    assert.deepEqual(harness.getKeyboardLabels(backOnScreen).at(-2), ['🔁 Auto switch: ON']);

    await harness.tapButton(pickerId, 'fbk_set_asw');
    assert.deepEqual(harness.getKeyboardLabels(harness.edits.at(-1)), [['ON ✓'], ['OFF'], ['As in General (OFF)'], ['⬅️ Back']], 'the topic\'s own choice is marked');
    await harness.tapButton(pickerId, 'fbk_asw_off');
    assert.equal(harness.state.getClaudeAutoSwitchOnLimitOverride(harness.key), false);
    await harness.tapButton(pickerId, 'fbk_set_asw');
    assert.deepEqual(harness.getKeyboardLabels(harness.edits.at(-1)), [['ON'], ['OFF ✓'], ['As in General (OFF)'], ['⬅️ Back']]);
    await harness.tapButton(pickerId, 'fbk_asw_same');
    assert.equal(harness.state.getClaudeAutoSwitchOnLimitOverride(harness.key), undefined, '«as in General» drops the override');

    await harness.tapButton(pickerId, 'fbk_set_wait');
    assert.equal(harness.edits.at(-1)?.text, '⏳ Wait for the reset and continue');
    assert.deepEqual(harness.getKeyboardLabels(harness.edits.at(-1)), [['ON'], ['OFF'], ['As in General (ON) ✓'], ['⬅️ Back']]);
    assert.deepEqual(harness.getKeyboardData(harness.edits.at(-1)), [['fbk_wait_on'], ['fbk_wait_off'], ['fbk_wait_same'], ['fbk_back']]);
    await harness.tapButton(pickerId, 'fbk_wait_off');
    assert.equal(harness.state.getAutoContinueOnLimitOverride(harness.key), false);
    assert.equal(harness.state.checkIsAutoContinueOnLimitEnabled(harness.key), false);
    assert.deepEqual(harness.getKeyboardLabels(harness.edits.at(-1)).at(-1), ['⏳ Wait for reset: OFF']);
    await harness.tapButton(pickerId, 'fbk_set_wait');
    await harness.tapButton(pickerId, 'fbk_wait_same');
    assert.equal(harness.state.getAutoContinueOnLimitOverride(harness.key), undefined);
    assert.equal(harness.state.checkIsAutoContinueOnLimitEnabled(harness.key), true, 'back to the General value');
    isGeneralTopic = true;
  });

  it('the sub-menu\'s «as in General» names the General value it would give; Back returns to the screen without changing anything', async () => {
    isGeneralTopic = false;
    await harness.state.setClaudeAutoSwitchOnLimitGlobalDefault(true);
    await harness.state.setClaudeAutoSwitchOnLimitOverride(harness.key, false);
    await harness.runCommand('limits');
    const pickerId = harness.replies.at(-1)!.messageId!;
    await harness.tapButton(pickerId, 'fbk_set_asw');
    assert.deepEqual(harness.getKeyboardLabels(harness.edits.at(-1)), [['ON'], ['OFF ✓'], ['As in General (ON)'], ['⬅️ Back']]);
    await harness.tapButton(pickerId, 'fbk_back');
    assert.match(harness.edits.at(-1)?.text ?? '', /🪜 /);
    assert.deepEqual(harness.getKeyboardData(harness.edits.at(-1)).slice(-2), [['fbk_set_asw'], ['fbk_set_wait']]);
    assert.equal(harness.state.getClaudeAutoSwitchOnLimitOverride(harness.key), false, 'Back applies nothing');
    await harness.state.setClaudeAutoSwitchOnLimitOverride(harness.key, null);
    await harness.state.setClaudeAutoSwitchOnLimitGlobalDefault(false);
    isGeneralTopic = true;
  });

  it('a sub-menu tap that reaches General only re-renders the screen (General has no «as in General»)', async () => {
    isGeneralTopic = true;
    await harness.runCommand('limits');
    const pickerId = harness.replies.at(-1)!.messageId!;
    await harness.tapButton(pickerId, 'fbk_set_wait');
    const rerender = harness.edits.at(-1);
    assert.match(rerender?.text ?? '', /^Defaults for all topics\./m);
    assert.deepEqual(harness.getKeyboardData(rerender).slice(-2), [['fbk_asw_on'], ['fbk_wait_off']]);
  });

  it('the usage block: a «% used» heading, then the `/accounts` renderer one row per account — windows with relative resets and no arrow, Fable only when the account has it, the stale mark, the limit mark on the next row; signed-out named, never-polled left out; refreshed on every build', async () => {
    const inHours = (hours: number): string => new Date(Date.now() + hours * 3_600_000 + 30_000).toISOString();
    const polled: ClaudeProfileUsageView = {
      ...buildProfile('personal'),
      usage: {
        fetchedAt: new Date().toISOString(),
        source: 'api',
        buckets: [
          { kind: 'session', percent: 5, resetsAt: inHours(4), scopeModel: null },
          { kind: 'weekly_all', percent: 20, resetsAt: inHours(5 * 24 + 8), scopeModel: null },
          { kind: 'weekly_scoped', percent: 4, resetsAt: inHours(5 * 24 + 8), scopeModel: 'Fable' },
        ],
      },
    };
    const limited: ClaudeProfileUsageView = {
      ...buildProfile('work'),
      usage: { fetchedAt: new Date().toISOString(), source: 'stream', isStale: true, buckets: [{ kind: 'session', percent: 100, resetsAt: inHours(1), scopeModel: null }] },
      limitedUntil: inHours(1),
    };
    const savedDetection = detection;
    detection = { ...savedDetection, claudeProfiles: [polled, limited, buildProfile('fresh'), buildProfile('out', false)] };
    const refreshesBefore = usageRefreshes.length;
    isGeneralTopic = true;
    await harness.runCommand('limits');
    const text = harness.replies.at(-1)?.text ?? '';
    const [usage] = text.split('\n\n');
    const rows = usage.split('\n');
    assert.equal(rows[0], 'Usage (% used)', 'the percentages are said to be USED, once, at the start');
    assert.equal(rows[1], '• personal — ⏱ 5h 5% 🔄 in 4h · week 20% 🔄 in 5d 8h · Fable 4% 🔄 in 5d 8h');
    assert.match(rows[2], /^• work — ⏱ 5h 100% 🔄 in 1h · week — \(stale\)$/, 'no Fable window: nothing about Fable, not even a dash');
    assert.match(rows[3], /^ {4}⛔ at its limit until \d{2}:\d{2}$/, 'the limit mark hangs under its account, as in /accounts');
    assert.equal(rows[4], '• out — not signed in');
    assert.equal(rows.length, 5, 'an account never polled has nothing to show and is left out');
    assert.equal(usageRefreshes.length, refreshesBefore + 1, 'the usage is refreshed when the screen is built');
    const sameLine = '⏱ 5h 5% 🔄 in 4h · week 20% 🔄 in 5d 8h · Fable 4% 🔄 in 5d 8h';
    assert.ok(text.includes(sameLine), 'the same windows line as /accounts prints under a row');
    detection = { ...savedDetection, claudeProfiles: [buildProfile('fresh'), buildProfile('other')] };
    await harness.runCommand('limits');
    assert.doesNotMatch(harness.replies.at(-1)?.text ?? '', /Usage \(% used\)/, 'no account to show → no heading over nothing');
    detection = savedDetection;
  });

  it('the topic screen offers «skip once» only while a limit wait is armed', async () => {
    isGeneralTopic = false;
    armedFireAt = 1_800_000_000_000;
    await harness.runCommand('limits');
    assert.deepEqual(harness.getKeyboardData(harness.replies.at(-1)).at(-1), [buildSkipArmedRetryCallbackData(1_800_000_000_000)]);
    armedFireAt = null;
    await harness.runCommand('limits');
    assert.equal(harness.getKeyboardData(harness.replies.at(-1)).at(-1)?.[0], 'fbk_set_wait', 'without an armed wait the setting button is last');
    isGeneralTopic = true;
  });

  it('the per-rung switch excludes an entry from automatic switching (revision-baked; a stale tap only re-renders); rebuild keeps the exclusion', async () => {
    await harness.state.setFallbackChain([claude('default'), openCode('openai', 'gpt-5')]);
    await harness.runCommand('limits');
    const pickerId = harness.replies.at(-1)!.messageId!;
    const stale = getFallbackChainRevision(harness.state.getFallbackChain());
    await harness.tapButton(pickerId, `fbk_tg_1_${stale}`);
    assert.deepEqual(harness.state.getFallbackChain()[1], { ...openCode('openai', 'gpt-5'), disabled: true });
    assert.match(harness.edits.at(-1)?.text ?? '', /🚫 Left out of automatic switching/);
    const detailRows = harness.getKeyboardData(harness.edits.at(-1));
    assert.equal(detailRows[1][0], `fbk_tg_1_${getFallbackChainRevision(harness.state.getFallbackChain())}`);
    assert.equal(harness.getKeyboardLabels(harness.edits.at(-1))[1][0], '✅ Use', 'the view stays and flips its button');
    await harness.tapButton(pickerId, `fbk_tg_1_${stale}`); // the revision moved on with the exclusion
    assert.deepEqual(harness.state.getFallbackChain()[1], { ...openCode('openai', 'gpt-5'), disabled: true }, 'a stale keyboard changes nothing');
    await harness.tapButton(pickerId, 'fbk_prop');
    await harness.tapButton(pickerId, 'fbk_propok');
    const rebuilt = harness.state.getFallbackChain();
    assert.ok(rebuilt.filter((entry) => entry.backend === 'opencode' && entry.providerId === 'openai').every((entry) => entry.disabled === true), 'openai stays excluded');
    assert.ok(rebuilt.filter((entry) => entry.backend === 'claude').every((entry) => entry.disabled !== true));
    await harness.state.setFallbackChain([]);
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
