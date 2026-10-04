/**
 * @description The `/reminders` flow (`connectors/telegram/commands/reminders.ts`) wired to ports: a
 * real telegraf instance against the fake Bot API (for the buttons and their answers), the real state
 * store, a recording scheduler engine and recording stand-ins for the topic's send and edit. Pinned:
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
import { Telegraf } from 'telegraf';
import { createReminders, type ReminderWizardSession } from '../connectors/telegram/commands/reminders';
import type { CommandContext, RegisterCommand } from '../connectors/telegram/commands/botCore';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { keyToString, type SessionKey } from '../sessionKey';
import type { SchedulerEngine } from '../scheduler/engine';
import type { ScheduleRecord } from '../scheduler/types';
import { getStateStore, type StateStore } from '../state';
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
import { FakeTelegram } from './telegramE2e/fakeTelegram';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const topicThreadId = 111;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true as const, first_name: 'Fake bot', username: 'fake_charness_bot' };
const key: SessionKey = makeTelegramKey(group.id, topicThreadId);
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

interface Sent {
  messageId: number | null;
  text: string;
  extra: object | undefined;
}

let fakeTelegram: FakeTelegram;
let bot: Telegraf;
let state: StateStore;
let hubHandler: Parameters<RegisterCommand>[1];
let reminders: ReturnType<typeof createReminders>;
const registeredCommandNames: string[] = [];
const registeredActionPatterns: string[] = [];
const wizards = new Map<string, ReminderWizardSession>();
const sentReplies: Sent[] = [];
const sentEdits: Sent[] = [];
const armedJobs: ScheduleRecord[] = [];
const disarmedJobIds: string[] = [];
let callbackSequence = 0;
let nextBotMessageId = 500;

const recordingEngine: SchedulerEngine = {
  armJob: (record) => { armedJobs.push(record); },
  disarmJob: (jobId) => { disarmedJobIds.push(jobId); },
  rearmAll: async () => {},
  whenIdle: async () => {},
  shutdown: () => {},
};

/** The inline keyboard a send or edit carried, as callback data row by row. */
function getKeyboardData(sent: Sent | undefined): string[][] {
  const extra = sent?.extra;
  if (!extra || !('reply_markup' in extra)) return [];
  const markup = extra.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
  return markup.inline_keyboard.map((row) => row.map((button) => button.callback_data));
}

function getLastEdit(): Sent {
  const edit = sentEdits.at(-1);
  assert.ok(edit, 'the flow edited a screen');
  return edit;
}

/** A button tap on the bot's message `messageId`, fed through telegraf's own middleware chain. */
async function tapButton(messageId: number, callbackData: string): Promise<void> {
  callbackSequence += 1;
  const message = fakeTelegram.getMessage(fakeTelegram.pushOperatorMessage(topicThreadId, `screen ${messageId}`));
  assert.ok(message);
  await bot.handleUpdate({
    update_id: callbackSequence,
    callback_query: {
      id: callbackSequence.toString(),
      from: operator,
      message: { ...message, message_id: messageId },
      chat_instance: 'fake-chat-instance',
      data: callbackData,
    },
  });
}

/** Open a fresh wizard on the screen `messageId` and return its id (the `rw_<id>_…` the buttons carry). */
async function openWizard(messageId: number): Promise<string> {
  await tapButton(messageId, 'rmadd');
  const wizardId = /^rw_([a-z0-9]+)_/.exec(getKeyboardData(getLastEdit())[0][0])?.[1];
  assert.ok(wizardId, 'the first wizard step carries the wizard id');
  return wizardId;
}

describe('reminders: the /reminders flow over its ports', () => {
  before(async () => {
    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    const apiRoot = await fakeTelegram.start();
    bot = new Telegraf('1000000001:fake-token-for-the-loopback-bot-api', { telegram: { apiRoot } });
    bot.botInfo = { ...botUser, can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false };
    state = await getStateStore();

    const originalAction = bot.action.bind(bot);
    bot.action = (...args: Parameters<Telegraf['action']>) => {
      registeredActionPatterns.push(String(args[0]));
      return originalAction(...args);
    };
    reminders = createReminders({
      bot,
      command: (name, handler) => {
        for (const commandName of [name].flat()) registeredCommandNames.push(commandName);
        hubHandler = handler;
      },
      getState: () => state,
      replyToThread: async (_key, text, extra) => {
        sentReplies.push({ messageId: nextBotMessageId, text, extra });
        return nextBotMessageId++;
      },
      editThreadMessage: async (_key, messageId, text, extra) => {
        sentEdits.push({ messageId, text, extra });
        return true;
      },
      authoriseContext: async () => key,
      reminderWizards: wizards,
      getSchedulerEngine: () => recordingEngine,
    });
    reminders.registerReminderCommands();
    reminders.registerReminderCallbacks();
  });

  after(async () => {
    await fakeTelegram.stop();
  });

  it('registers /reminders and its seven buttons, in the order the bot has always had', () => {
    assert.deepEqual(registeredCommandNames, ['reminders']);
    assert.deepEqual(registeredActionPatterns, expectedActionPatterns);
  });

  it('/reminders opens the hub: an empty list offers Add and Close', async () => {
    await hubHandler({} as CommandContext, key, { name: 'reminders', args: [], argsText: '' });
    const hub = sentReplies.at(-1);
    assert.match(hub?.text ?? '', /No reminders yet/);
    assert.deepEqual(getKeyboardData(hub), [['rmadd'], ['rmclose']]);
  });

  it('the wizard walks its four steps; the typed text creates a bot-local reminder the engine arms', async () => {
    const screen = 501;
    const wizardId = await openWizard(screen);
    assert.equal(wizards.size, 1);
    assert.match(getLastEdit().text, /STEP 1\/4/);

    await tapButton(screen, `rw_${wizardId}_r_0`);
    assert.match(getLastEdit().text, /STEP 2\/4/);
    await tapButton(screen, getKeyboardData(getLastEdit())[0][1]);
    assert.match(getLastEdit().text, /STEP 3\/4/);
    await tapButton(screen, getKeyboardData(getLastEdit())[0][0]);
    assert.match(getLastEdit().text, /STEP 4\/4/);

    assert.equal(reminders.claimReminderTextCapture(key), 'capture', 'the typed text is the reminder text');
    assert.notEqual(reminders.claimReminderTextCapture(key), 'capture', 'the wait is claimed once: a second message is not');
    await reminders.finishReminderWizard(key, reminderText);

    assert.match(getLastEdit().text, /Reminder created/);
    assert.equal(wizards.size, 0, 'the finished wizard is forgotten');
    const [reminder] = state.getThreadSchedules(key);
    assert.equal(reminder.deliveryKind, 'reminder', 'a bot-local reminder, never an agent-prompt job');
    assert.equal(reminder.prompt, reminderText);
    assert.deepEqual(armedJobs.map((job) => job.id), [reminder.id], 'the engine was told to arm it');
  });

  it('the hub counts the reminder; its list row opens a card, whose Delete removes it and disarms the engine', async () => {
    const [reminder] = state.getThreadSchedules(key);
    const screen = 502;
    await tapButton(screen, 'rmlp_0');
    assert.ok(getKeyboardData(getLastEdit()).flat().includes('rmc_0'), 'the list has a row for the reminder');
    await tapButton(screen, 'rmc_0');
    const deleteCallback = getKeyboardData(getLastEdit()).flat().find((data) => data.startsWith('rmdel_'));
    assert.equal(deleteCallback, `rmdel_${reminder.id}`, 'the card carries the reminder\'s own id, never a positional index');

    await tapButton(screen, deleteCallback);
    assert.deepEqual(state.getThreadSchedules(key), []);
    assert.deepEqual(disarmedJobIds, [reminder.id]);
    assert.ok(fakeTelegram.callbackAnswers.includes('🗑 Deleted'));
  });

  it('a stale delete button answers that the reminder is gone', async () => {
    const answersBefore = fakeTelegram.callbackAnswers.length;
    await tapButton(503, 'rmdel_a-reminder-that-never-existed');
    assert.equal(fakeTelegram.callbackAnswers.length, answersBefore + 1);
    assert.equal(disarmedJobIds.length, 1, 'nothing else was disarmed');
  });

  it('an over-long text is refused: the wizard stays on step 4 and the wait is released for the retry', async () => {
    const screen = 504;
    const wizardId = await openWizard(screen);
    await tapButton(screen, `rw_${wizardId}_r_0`);
    await tapButton(screen, getKeyboardData(getLastEdit())[0][1]);
    await tapButton(screen, getKeyboardData(getLastEdit())[0][0]);
    assert.equal(reminders.claimReminderTextCapture(key), 'capture');

    await reminders.finishReminderWizard(key, 'x'.repeat(reminderTextMaxLength + 1));
    assert.match(getLastEdit().text, /STEP 4\/4/);
    assert.equal(wizards.size, 1, 'the wizard is still open');
    assert.deepEqual(state.getThreadSchedules(key), []);
    assert.equal(reminders.claimReminderTextCapture(key), 'capture', 'the retry is captured, not forwarded to the agent');
  });

  it('a cancel retires the open wizard\'s screen and forgets it', async () => {
    assert.equal(wizards.size, 1);
    await reminders.cancelReminderWizard(key);
    assert.match(getLastEdit().text, /Cancelled/);
    assert.equal(wizards.size, 0);
    const editsBefore = sentEdits.length;
    await reminders.cancelReminderWizard(key);
    assert.equal(sentEdits.length, editsBefore, 'with no wizard open a cancel does nothing');
  });

  it('an expired text wait retires the wizard without consuming the message', async () => {
    const wizardId = await openWizard(505);
    await tapButton(505, `rw_${wizardId}_r_0`);
    await tapButton(505, getKeyboardData(getLastEdit())[0][1]);
    await tapButton(505, getKeyboardData(getLastEdit())[0][0]);
    const session = wizards.get(keyToString(key));
    assert.ok(session?.textWait);

    await reminders.expireReminderWizard(key);
    assert.match(getLastEdit().text, /Expired/);
    assert.equal(wizards.size, 0);
  });
});
