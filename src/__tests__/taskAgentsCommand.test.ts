/**
 * @description `/task_agents` (`connectors/telegram/commands/taskAgents.ts`) wired to ports (`commandModuleHarness.ts`: a real
 * telegraf instance against the fake Bot API, the real state store, recording topic sends):
 *
 *   • WIRING — the command and its six buttons;
 *   • General — the value in force and where it comes from (the built-in default, settings.json's seed while General never
 *     chose, General's own choice), the numbers 5 / 10 / 15 / 20 / 30 and «No limit» with the one in force marked, a tap that
 *     writes General's value and edits the picker into its confirmation (keyboard gone), the slots in use on a tracker instance;
 *   • the number typed after the command — any whole number in range, `0` / `off` for no limit, what an invalid one does;
 *   • a topic — the value in force, no picker, no way to change it from there.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTaskAgents } from '../connectors/telegram/commands/taskAgents';
import { readTaskAgentLimit, taskAgentsMaxConcurrentUpperBound, type TaskAgentLimitSources } from '../trackers/taskAgentLimit';
import type { TaskAgentSlotStatus } from '../trackers/taskAgentSlots';
import { createCommandHarness, type CommandHarness } from './commandModuleHarness';

let harness: CommandHarness;
/** `settings.json`'s `taskAgents.maxConcurrent` as the reader sees it, and the slots of the instance (`null`: it serves no tracker). */
let settingsValue: number | null = null;
let slotStatus: TaskAgentSlotStatus | null = null;
/** How many times the module told the bot the cap may have changed. */
let limitChangedNotes = 0;
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

const pickerData = [['tka_5', 'tka_10', 'tka_15'], ['tka_20', 'tka_30', 'tka_0']];

describe('taskAgents: /task_agents over its ports', () => {
  before(async () => {
    harness = await createCommandHarness();
    const sources: TaskAgentLimitSources = {
      getGeneralValue: () => harness.state.getTaskAgentsMaxConcurrentGlobalValue(),
      getSettingsValue: () => settingsValue,
    };
    const taskAgents = createTaskAgents({
      ...harness.core,
      readTaskAgentLimit: () => readTaskAgentLimit(sources),
      readTaskAgentStatus: () => slotStatus,
      noteTaskAgentLimitChanged: () => {
        limitChangedNotes += 1;
      },
    });
    taskAgents.registerTaskAgentsCommands();
    taskAgents.registerTaskAgentsCallbacks();
  });

  after(async () => {
    await harness.stop();
  });

  it('registers /task_agents and a button for each picker number and for «no limit»', () => {
    assert.deepEqual(harness.registeredCommandNames, ['task_agents']);
    assert.deepEqual(harness.registeredActionPatterns, ['tka_5', 'tka_10', 'tka_15', 'tka_20', 'tka_30', 'tka_0']);
  });

  describe('in General', () => {
    before(() => {
      harness.isGeneral = true;
    });

    it('shows the cap — 5 by the built-in default when nothing says otherwise — what it limits, and how to type another number; the picker marks the one in force', async () => {
      await harness.runCommand('task_agents');
      const screen = lastReply();
      assert.match(screen.text, /^🧵 Task agents working at once, for the whole bot: 5 — the built-in default\n\n/);
      assert.match(screen.text, /waits in one queue and starts by itself when an agent hands its task back/);
      assert.match(screen.text, /Replies to mentions do not count/);
      assert.match(screen.text, /send this command with another number after it \(0 means no limit\)\.$/);
      assert.ok(!screen.text.includes('/task_agents'), 'the text names no slash command: Telegram would auto-link it');
      assert.deepEqual(harness.getKeyboardData(screen), pickerData);
      assert.deepEqual(harness.getKeyboardLabels(screen), [['5 ✓', '10', '15'], ['20', '30', 'No limit']]);
      assert.equal(harness.state.getTaskAgentsMaxConcurrentGlobalValue(), undefined, 'looking writes nothing');
    });

    it('while General never chose, settings.json\'s seed is the value shown and marked', async () => {
      settingsValue = 15;
      await harness.runCommand('task_agents');
      assert.match(lastReply().text, /^🧵 Task agents working at once, for the whole bot: 15 — from settings\.json\n/);
      assert.deepEqual(harness.getKeyboardLabels(lastReply()), [['5', '10', '15 ✓'], ['20', '30', 'No limit']]);
    });

    it('an instance that serves a tracker shows how many agents work and how many wait; one that serves none says nothing of it', async () => {
      slotStatus = { maxConcurrent: 15, runningCount: 3, waitingCount: 2 };
      await harness.runCommand('task_agents');
      assert.match(lastReply().text, /\n\nNow: 3 working, 2 waiting for a free slot\.\n\n/);
      slotStatus = null;
      await harness.runCommand('task_agents');
      assert.ok(!lastReply().text.includes('Now:'));
    });

    it('a tap writes General\'s value, answers the tap and edits the picker into its confirmation — keyboard gone', async () => {
      const picker = pushPicker();
      const answersBefore = harness.fakeTelegram.callbackAnswers.length;
      const notesBefore = limitChangedNotes;
      await harness.tapButton(picker, 'tka_20');
      assert.equal(harness.state.getTaskAgentsMaxConcurrentGlobalValue(), 20, 'General\'s own value now beats the file\'s 15');
      assert.equal(limitChangedNotes, notesBefore + 1, 'the bot is told after the write: a raise starts the waiting issues at once');
      assert.equal(harness.fakeTelegram.callbackAnswers.length, answersBefore + 1);
      const edit = lastEdit();
      assert.equal(edit.messageId, picker);
      assert.equal(edit.text, '✅ Task agents at once: 20, for the whole bot. Agents already working are not stopped; a lower limit holds back the tasks that come next.');
      assert.equal(edit.hasKeyboard, false, 'a one-shot picker: the menu is gone once a choice is made');
      await harness.runCommand('task_agents');
      assert.match(lastReply().text, /^🧵 Task agents working at once, for the whole bot: 20 — set in General\n/, 'General\'s own choice is named as the source, whatever the file says');
      assert.deepEqual(harness.getKeyboardLabels(lastReply()), [['5', '10', '15'], ['20 ✓', '30', 'No limit']]);
    });

    it('«No limit» is stored as 0 — a value, not «never chose» — and the screen says «no limit»', async () => {
      settingsValue = 3;
      await harness.tapButton(pushPicker(), 'tka_0');
      assert.equal(harness.state.getTaskAgentsMaxConcurrentGlobalValue(), 0);
      assert.match(lastEdit().text, /^✅ Task agents at once: no limit, for the whole bot\./);
      await harness.runCommand('task_agents');
      assert.match(lastReply().text, /^🧵 Task agents working at once, for the whole bot: no limit — set in General\n/);
      assert.deepEqual(harness.getKeyboardLabels(lastReply()), [['5', '10', '15'], ['20', '30', 'No limit ✓']]);
    });

    it('the number typed after the command applies at once with the same confirmation — a number no button shows, with no ✓ anywhere', async () => {
      const notesBefore = limitChangedNotes;
      await harness.runCommand('task_agents', '12');
      assert.equal(harness.state.getTaskAgentsMaxConcurrentGlobalValue(), 12);
      assert.equal(limitChangedNotes, notesBefore + 1, 'told after the typed number too');
      assert.match(lastReply().text, /^✅ Task agents at once: 12, for the whole bot\./);
      assert.equal(harness.getKeyboardData(lastReply()).length, 0, 'a confirmation, not a picker');
      await harness.runCommand('task_agents');
      assert.match(lastReply().text, /^🧵 Task agents working at once, for the whole bot: 12 — set in General\n/);
      assert.deepEqual(harness.getKeyboardLabels(lastReply()), [['5', '10', '15'], ['20', '30', 'No limit']], 'no button is marked: 12 is on none');
    });

    it('0 and «off» mean no limit; the bound itself is allowed', async () => {
      await harness.runCommand('task_agents', 'off');
      assert.equal(harness.state.getTaskAgentsMaxConcurrentGlobalValue(), 0);
      await harness.runCommand('task_agents', '7');
      await harness.runCommand('task_agents', '0');
      assert.equal(harness.state.getTaskAgentsMaxConcurrentGlobalValue(), 0);
      await harness.runCommand('task_agents', `${taskAgentsMaxConcurrentUpperBound}`);
      assert.equal(harness.state.getTaskAgentsMaxConcurrentGlobalValue(), taskAgentsMaxConcurrentUpperBound);
    });

    it('anything else is refused with the range, and changes nothing: over the bound, negative, a decimal, a word, two numbers', async () => {
      await harness.runCommand('task_agents', '8');
      const notesBefore = limitChangedNotes;
      for (const text of [`${taskAgentsMaxConcurrentUpperBound + 1}`, '-3', '2.5', 'many', '5 10']) {
        await harness.runCommand('task_agents', text);
        assert.equal(lastReply().text, `⚠️ Send a whole number from 0 to ${taskAgentsMaxConcurrentUpperBound} (0 or off — no limit).`, text);
        assert.equal(harness.state.getTaskAgentsMaxConcurrentGlobalValue(), 8, `${text} changed nothing`);
      }
      assert.equal(limitChangedNotes, notesBefore, 'a refusal tells nobody');
    });
  });

  describe('in a topic', () => {
    before(async () => {
      harness.isGeneral = false;
      await harness.state.setTaskAgentsMaxConcurrentGlobalValue(10);
    });

    it('reports the value in force and says it is changed in General — no picker', async () => {
      await harness.runCommand('task_agents');
      const screen = lastReply();
      assert.match(screen.text, /^🧵 Task agents working at once, for the whole bot: 10 — set in General\n\n/);
      assert.match(screen.text, /It is one limit for the whole bot — change it in General\.$/);
      assert.ok(!screen.text.includes('send this command with another number'), 'no manual-entry hint where it cannot be used');
      assert.deepEqual(harness.getKeyboardData(screen), []);
    });

    it('a number typed there is refused, and changes nothing', async () => {
      const notesBeforeTopic = limitChangedNotes;
      await harness.runCommand('task_agents', '3');
      assert.equal(lastReply().text, '⚠️ The limit is one for the whole bot — change it in General.');
      assert.equal(harness.state.getTaskAgentsMaxConcurrentGlobalValue(), 10);
      assert.equal(limitChangedNotes, notesBeforeTopic, 'nothing was written, nobody is told');
    });

    it('a tap that lands in a topic (an old picker) changes nothing and says where to change it', async () => {
      const picker = pushPicker();
      await harness.tapButton(picker, 'tka_30');
      assert.equal(harness.state.getTaskAgentsMaxConcurrentGlobalValue(), 10);
      assert.equal(lastEdit().text, '⚠️ The limit is one for the whole bot — change it in General.');
    });
  });
});
