/**
 * @description The `/reminders` flow (`connectors/telegram/commands/reminders.ts`) wired to ports
 * (`commandModuleHarness.ts`: a real telegraf instance against the fake Bot API, the real state store,
 * recording topic sends) and a recording scheduler engine. Pinned:
 *
 *   • WIRING — the command and the seven buttons it registers, in order;
 *   • the whole wizard through its buttons, the typed text creating a bot-LOCAL reminder that the
 *     engine arms, and the card's Delete removing it and disarming the engine;
 *   • the hooks the bot calls from outside the flow — the single-claim of the step-4 text wait, the
 *     cancel and the expiry — and the refusal of an over-long text.
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createReminders, type ReminderWizardSession } from '../connectors/telegram/commands/reminders';
import { keyToString } from '../sessionKey';
import type { SchedulerEngine } from '../scheduler/engine';
import type { ScheduleRecord } from '../scheduler/types';
import {
  reminderAddCallback,
  reminderCardCallbackRe,
  reminderCloseCallback,
  reminderDeleteCallbackRe,
  reminderHubCallback,
  reminderListPageCallbackRe,
  reminderTextMaxLength,
  reminderWizardCallbackRe,
} from '../utils/reminderWizard';
import { createCommandHarness, type CommandHarness, type RecordedSend } from './commandModuleHarness';

const reminderText = 'drink water';
const expectedActionPatterns = [
  reminderAddCallback,
  reminderHubCallback,
  reminderCloseCallback,
  String(reminderListPageCallbackRe),
  String(reminderCardCallbackRe),
  String(reminderDeleteCallbackRe),
  String(reminderWizardCallbackRe),
];

let harness: CommandHarness;
let reminders: ReturnType<typeof createReminders>;
const wizards = new Map<string, ReminderWizardSession>();
const armedJobs: ScheduleRecord[] = [];
const disarmedJobIds: string[] = [];

const recordingEngine: SchedulerEngine = {
  armJob: (record) => { armedJobs.push(record); },
  disarmJob: (jobId) => { disarmedJobIds.push(jobId); },
  rearmAll: async () => {},
  whenIdle: async () => {},
  shutdown: () => {},
};

function getLastEdit(): RecordedSend {
  const edit = harness.edits.at(-1);
  assert.ok(edit, 'the flow edited a screen');
  return edit;
}

/** Open a fresh wizard on the screen `messageId` and return its id (the `rw_<id>_…` the buttons carry). */
async function openWizard(messageId: number): Promise<string> {
  await harness.tapButton(messageId, 'rmadd');
  const wizardId = /^rw_([a-z0-9]+)_/.exec(harness.getKeyboardData(getLastEdit())[0][0])?.[1];
  assert.ok(wizardId, 'the first wizard step carries the wizard id');
  return wizardId;
}

/** Walk a wizard from its first step to step 4 (the text wait): Once → the second day option → the first time. */
async function walkWizardToTextStep(messageId: number): Promise<void> {
  const wizardId = await openWizard(messageId);
  await harness.tapButton(messageId, `rw_${wizardId}_r_0`);
  await harness.tapButton(messageId, harness.getKeyboardData(getLastEdit())[0][1]);
  await harness.tapButton(messageId, harness.getKeyboardData(getLastEdit())[0][0]);
  assert.match(getLastEdit().text, /STEP 4\/4/);
}

describe('reminders: the /reminders flow over its ports', () => {
  before(async () => {
    harness = await createCommandHarness();
    reminders = createReminders({ ...harness.core, reminderWizards: wizards, getSchedulerEngine: () => recordingEngine });
    reminders.registerReminderCommands();
    reminders.registerReminderCallbacks();
  });

  after(async () => {
    await harness.stop();
  });

  it('registers /reminders and its seven buttons, in the order the bot has always had', () => {
    assert.deepEqual(harness.registeredCommandNames, ['reminders']);
    assert.deepEqual(harness.registeredActionPatterns, expectedActionPatterns);
  });

  it('/reminders opens the hub: an empty list offers Add and Close', async () => {
    await harness.runCommand('reminders');
    const hub = harness.replies.at(-1);
    assert.match(hub?.text ?? '', /No reminders yet/);
    assert.deepEqual(harness.getKeyboardData(hub), [['rmadd'], ['rmclose']]);
  });

  it('the wizard walks its four steps; the typed text creates a bot-local reminder the engine arms', async () => {
    const screen = 501;
    const wizardId = await openWizard(screen);
    assert.equal(wizards.size, 1);
    assert.match(getLastEdit().text, /STEP 1\/4/);

    await harness.tapButton(screen, `rw_${wizardId}_r_0`);
    assert.match(getLastEdit().text, /STEP 2\/4/);
    await harness.tapButton(screen, harness.getKeyboardData(getLastEdit())[0][1]);
    assert.match(getLastEdit().text, /STEP 3\/4/);
    await harness.tapButton(screen, harness.getKeyboardData(getLastEdit())[0][0]);
    assert.match(getLastEdit().text, /STEP 4\/4/);

    assert.equal(reminders.claimReminderTextCapture(harness.key), 'capture', 'the typed text is the reminder text');
    assert.notEqual(reminders.claimReminderTextCapture(harness.key), 'capture', 'the wait is claimed once: a second message is not');
    await reminders.finishReminderWizard(harness.key, reminderText);

    assert.match(getLastEdit().text, /Reminder created/);
    assert.equal(wizards.size, 0, 'the finished wizard is forgotten');
    const [reminder] = harness.state.getThreadSchedules(harness.key);
    assert.equal(reminder.deliveryKind, 'reminder', 'a bot-local reminder, never an agent-prompt job');
    assert.equal(reminder.prompt, reminderText);
    assert.deepEqual(armedJobs.map((job) => job.id), [reminder.id], 'the engine was told to arm it');
  });

  it('the hub counts the reminder; its list row opens a card, whose Delete removes it and disarms the engine', async () => {
    const [reminder] = harness.state.getThreadSchedules(harness.key);
    const screen = 502;
    await harness.tapButton(screen, 'rmlp_0');
    assert.ok(harness.getKeyboardData(getLastEdit()).flat().includes('rmc_0'), 'the list has a row for the reminder');
    await harness.tapButton(screen, 'rmc_0');
    const deleteCallback = harness.getKeyboardData(getLastEdit()).flat().find((data) => data.startsWith('rmdel_'));
    assert.equal(deleteCallback, `rmdel_${reminder.id}`, 'the card carries the reminder\'s own id, never a positional index');

    await harness.tapButton(screen, deleteCallback);
    assert.deepEqual(harness.state.getThreadSchedules(harness.key), []);
    assert.deepEqual(disarmedJobIds, [reminder.id]);
    assert.ok(harness.fakeTelegram.callbackAnswers.includes('🗑 Deleted'));
  });

  it('a stale delete button answers that the reminder is gone', async () => {
    const answersBefore = harness.fakeTelegram.callbackAnswers.length;
    await harness.tapButton(503, 'rmdel_a-reminder-that-never-existed');
    assert.equal(harness.fakeTelegram.callbackAnswers.length, answersBefore + 1);
    assert.equal(disarmedJobIds.length, 1, 'nothing else was disarmed');
  });

  it('an over-long text is refused: the wizard stays on step 4 and the wait is released for the retry', async () => {
    await walkWizardToTextStep(504);
    assert.equal(reminders.claimReminderTextCapture(harness.key), 'capture');

    await reminders.finishReminderWizard(harness.key, 'x'.repeat(reminderTextMaxLength + 1));
    assert.match(getLastEdit().text, /STEP 4\/4/);
    assert.equal(wizards.size, 1, 'the wizard is still open');
    assert.deepEqual(harness.state.getThreadSchedules(harness.key), []);
    assert.equal(reminders.claimReminderTextCapture(harness.key), 'capture', 'the retry is captured, not forwarded to the agent');
  });

  it('a cancel retires the open wizard\'s screen and forgets it', async () => {
    assert.equal(wizards.size, 1);
    await reminders.cancelReminderWizard(harness.key);
    assert.match(getLastEdit().text, /Cancelled/);
    assert.equal(wizards.size, 0);
    const editsBefore = harness.edits.length;
    await reminders.cancelReminderWizard(harness.key);
    assert.equal(harness.edits.length, editsBefore, 'with no wizard open a cancel does nothing');
  });

  it('an expired text wait retires the wizard without consuming the message', async () => {
    await walkWizardToTextStep(505);
    assert.ok(wizards.get(keyToString(harness.key))?.textWait);

    await reminders.expireReminderWizard(harness.key);
    assert.match(getLastEdit().text, /Expired/);
    assert.equal(wizards.size, 0);
  });
});
