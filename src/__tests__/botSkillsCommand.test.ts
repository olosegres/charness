/**
 * @description `/bot_skills` (`connectors/telegram/commands/botSkills.ts`) wired to ports (`commandModuleHarness.ts`: a real
 * telegraf instance against the fake Bot API, the real state store, recording topic sends):
 *
 *   • WIRING — the command and its three buttons;
 *   • General — the instance value (settings.json's seed while General never chose), On / Off with the current one marked,
 *     a tap that writes General's value and edits the picker into its confirmation (keyboard gone);
 *   • a topic — On / Off / «As in General (value)» with the topic's own choice marked, the same one-shot taps, «As in
 *     General» dropping the topic's choice, and neither side touching the other;
 *   • the typed forms (`on`, `off`, `general`) and what an unknown word does;
 *   • an OpenCode topic — the screen and the confirmation say the listed skills stay.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBotSkills } from '../connectors/telegram/commands/botSkills';
import { createBotSkillsReader, type BotSkillsSetting } from '../utils/botSkills';
import { createCommandHarness, type CommandHarness } from './commandModuleHarness';

let harness: CommandHarness;
/** `settings.json`'s `botSkills` as the reader sees it, and whether the topic under test runs OpenCode. */
let settingsValue: BotSkillsSetting | null = null;
let isOpenCodeTopic = false;
/** The id of the bot message each test's taps sit on. */
let nextPickerMessageId = 900;

function pushPicker(): number {
  nextPickerMessageId += 1;
  return nextPickerMessageId;
}

/** The last reply the module posted into the topic. */
function lastReply() {
  const reply = harness.replies.at(-1);
  assert.ok(reply, 'the module replied');
  return reply;
}

/** The last edit the module made, and whether it left an inline keyboard on the message. */
function lastEdit() {
  const edit = harness.edits.at(-1);
  assert.ok(edit, 'the module edited a message');
  return { ...edit, hasKeyboard: harness.getKeyboardData(edit).length > 0 };
}

describe('botSkills: /bot_skills over its ports', () => {
  before(async () => {
    harness = await createCommandHarness();
    const botSkills = createBotSkills({
      ...harness.core,
      readBotSkills: createBotSkillsReader({
        getGeneralValue: () => harness.state.getBotSkillsGlobalValue(),
        getTopicOverride: (key) => harness.state.getBotSkillsOverride(key),
        getSettingsValue: () => settingsValue,
      }),
      checkIsOpenCodeTopic: () => isOpenCodeTopic,
    });
    botSkills.registerBotSkillsCommands();
    botSkills.registerBotSkillsCallbacks();
  });

  after(async () => {
    await harness.stop();
  });

  it('registers /bot_skills and its three buttons', () => {
    assert.deepEqual(harness.registeredCommandNames, ['bot_skills']);
    assert.deepEqual(harness.registeredActionPatterns, ['bsk_on', 'bsk_off', 'bsk_same']);
  });

  describe('in General', () => {
    before(() => {
      harness.isGeneral = true;
    });

    it('shows the instance value — ON when nothing says otherwise — with On / Off and the ✓ on the one in force', async () => {
      await harness.runCommand('bot_skills');
      const picker = lastReply();
      assert.match(picker.text, /^🧰 Bot skills for ALL topics: ON\n\n/);
      assert.match(picker.text, /A running agent keeps its skills until its next start/);
      assert.match(picker.text, /default of every topic without a choice of its own/);
      assert.deepEqual(harness.getKeyboardData(picker), [['bsk_on', 'bsk_off']]);
      assert.deepEqual(harness.getKeyboardLabels(picker), [['On ✓', 'Off']]);
    });

    it('while General never chose, settings.json\'s seed is the value shown', async () => {
      settingsValue = 'off';
      await harness.runCommand('bot_skills');
      assert.match(lastReply().text, /^🧰 Bot skills for ALL topics: OFF\n/);
      assert.deepEqual(harness.getKeyboardLabels(lastReply()), [['On', 'Off ✓']]);
      assert.equal(harness.state.getBotSkillsGlobalValue(), undefined, 'looking writes nothing');
    });

    it('a tap writes General\'s value, answers the tap and edits the picker into its confirmation — keyboard gone', async () => {
      const picker = pushPicker();
      const answersBefore = harness.fakeTelegram.callbackAnswers.length;
      await harness.tapButton(picker, 'bsk_on');
      assert.equal(harness.state.getBotSkillsGlobalValue(), true, 'General\'s own value now beats the file\'s «off»');
      assert.equal(harness.fakeTelegram.callbackAnswers.length, answersBefore + 1);
      const edit = lastEdit();
      assert.equal(edit.messageId, picker);
      assert.match(edit.text, /^✅ Bot skills: ON for ALL topics \(a topic's own choice still applies\)\. A running agent keeps its skills until its next start; OpenCode's server follows at the bot's next start\.$/);
      assert.equal(edit.hasKeyboard, false, 'a one-shot picker: the menu is gone once a choice is made');
    });

    it('Off is stored as an explicit false, not as «never chose» — the file\'s «on» cannot bring it back', async () => {
      settingsValue = 'on';
      await harness.tapButton(pushPicker(), 'bsk_off');
      assert.equal(harness.state.getBotSkillsGlobalValue(), false);
      assert.match(lastEdit().text, /^✅ Bot skills: OFF for ALL topics/);
      await harness.runCommand('bot_skills');
      assert.match(lastReply().text, /^🧰 Bot skills for ALL topics: OFF\n/);
    });

    it('the typed forms apply at once with the same confirmation; «general» means nothing here and opens the picker', async () => {
      await harness.runCommand('bot_skills', 'on');
      assert.equal(harness.state.getBotSkillsGlobalValue(), true);
      assert.match(lastReply().text, /^✅ Bot skills: ON for ALL topics/);
      assert.equal(harness.getKeyboardData(lastReply()).length, 0, 'a confirmation, not a picker');
      await harness.runCommand('bot_skills', 'off');
      assert.equal(harness.state.getBotSkillsGlobalValue(), false);
      await harness.runCommand('bot_skills', 'general');
      assert.deepEqual(harness.getKeyboardData(lastReply()), [['bsk_on', 'bsk_off']], 'the picker');
      assert.equal(harness.state.getBotSkillsGlobalValue(), false, 'nothing changed');
      await harness.runCommand('bot_skills', 'maybe');
      assert.deepEqual(harness.getKeyboardData(lastReply()), [['bsk_on', 'bsk_off']]);
    });

    it('a stray «as in General» tap in General changes nothing', async () => {
      await harness.tapButton(pushPicker(), 'bsk_same');
      assert.equal(harness.state.getBotSkillsGlobalValue(), false);
      assert.match(lastEdit().text, /^✅ Bot skills: OFF for ALL topics/);
    });
  });

  describe('in a topic', () => {
    before(async () => {
      harness.isGeneral = false;
      await harness.state.setBotSkillsGlobalValue(true);
    });

    it('shows the value in force and where it comes from, with On / Off / «As in General (value)» and the ✓ on «As in General»', async () => {
      await harness.runCommand('bot_skills');
      const picker = lastReply();
      assert.match(picker.text, /^🧰 Bot skills in this topic: ON — as in General\n\n/);
      assert.ok(!picker.text.includes('OpenCode'), 'a Claude topic has no OpenCode note');
      assert.deepEqual(harness.getKeyboardData(picker), [['bsk_on', 'bsk_off'], ['bsk_same']]);
      assert.deepEqual(harness.getKeyboardLabels(picker), [['On', 'Off'], ['As in General (ON) ✓']]);
    });

    it('Off: the topic\'s own choice is stored, the picker becomes the confirmation, General\'s value is untouched', async () => {
      const picker = pushPicker();
      await harness.tapButton(picker, 'bsk_off');
      assert.equal(harness.state.getBotSkillsOverride(harness.key), false);
      assert.equal(harness.state.getBotSkillsGlobalValue(), true, 'General keeps its value');
      const edit = lastEdit();
      assert.equal(edit.messageId, picker);
      assert.equal(edit.text, '✅ Bot skills: OFF for this topic. A running agent keeps its skills until its next start.');
      assert.equal(edit.hasKeyboard, false);

      await harness.runCommand('bot_skills');
      assert.match(lastReply().text, /^🧰 Bot skills in this topic: OFF — set for this topic\n/);
      assert.deepEqual(harness.getKeyboardLabels(lastReply()), [['On', 'Off ✓'], ['As in General (ON)']]);
    });

    it('On beats a General OFF, and General\'s change does not reach a topic with a choice of its own', async () => {
      await harness.state.setBotSkillsGlobalValue(false);
      await harness.tapButton(pushPicker(), 'bsk_on');
      assert.equal(harness.state.getBotSkillsOverride(harness.key), true);
      assert.match(lastEdit().text, /^✅ Bot skills: ON for this topic\./);
      await harness.state.setBotSkillsGlobalValue(true);
      assert.equal(harness.state.getBotSkillsOverride(harness.key), true, 'General\'s change leaves the topic\'s choice alone');
    });

    it('«As in General» drops the topic\'s choice and names what the topic follows now', async () => {
      await harness.state.setBotSkillsGlobalValue(false);
      await harness.tapButton(pushPicker(), 'bsk_same');
      assert.equal(harness.state.getBotSkillsOverride(harness.key), undefined, 'the choice is gone from the state, not only from the screen');
      assert.equal(lastEdit().text, '✅ Bot skills in this topic follow General again: OFF. A running agent keeps its skills until its next start.');
      await harness.runCommand('bot_skills');
      assert.match(lastReply().text, /^🧰 Bot skills in this topic: OFF — as in General\n/);
      assert.deepEqual(harness.getKeyboardLabels(lastReply()), [['On', 'Off'], ['As in General (OFF) ✓']]);
    });

    it('the typed forms apply at once: on, off, and general (drop the choice)', async () => {
      await harness.runCommand('bot_skills', 'on');
      assert.equal(harness.state.getBotSkillsOverride(harness.key), true);
      assert.match(lastReply().text, /^✅ Bot skills: ON for this topic\./);
      await harness.runCommand('bot_skills', 'off');
      assert.equal(harness.state.getBotSkillsOverride(harness.key), false);
      await harness.runCommand('bot_skills', 'general');
      assert.equal(harness.state.getBotSkillsOverride(harness.key), undefined);
      assert.match(lastReply().text, /^✅ Bot skills in this topic follow General again: OFF\./);
    });

    it('an OpenCode topic is told its listed skills stay — on the screen and in every confirmation', async () => {
      isOpenCodeTopic = true;
      const note = 'its one server serves every topic, so its skills stay listed here';
      await harness.runCommand('bot_skills');
      assert.ok(lastReply().text.includes(note), lastReply().text);
      await harness.tapButton(pushPicker(), 'bsk_off');
      assert.ok(lastEdit().text.includes(note), lastEdit().text);
      assert.match(lastEdit().text, /^✅ Bot skills: OFF for this topic\./);
      isOpenCodeTopic = false;
      await harness.runCommand('bot_skills', 'general');
      assert.ok(!lastReply().text.includes(note));
    });
  });
});
