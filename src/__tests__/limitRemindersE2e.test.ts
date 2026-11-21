/**
 * @description `/limits_reminders` and the `/limits` board's row at PROCESS level: the BUILT charness started the way an isolated instance is
 * (`scripts/run-isolated.sh`) against the fake Bot API of `telegramE2e/fakeTelegram.ts`, with the fake `claude` as the agent. Two topics run
 * on a seeded, signed-in account and both are orchestrating conversations (their note records are seeded while the bot is down), so a note
 * is due at every turn start the setting allows — what the agent's prompt carries is the proof of what the setting says. One flow, in order:
 *
 *   boot → two topics bound, an account seeded, both topics made orchestrating, the usage cache filled by a warm-up turn in each
 *   → General's picker: «every 1 h (default)», one row of buttons, no «As General»; a tap on Off turns the picker into one line with no
 *     buttons and writes `settings.json` — and from then on NEITHER topic's prompt carries a note (Off stops every note; the test timings
 *     shorten the interval, and Off still stays off)
 *   → a topic's picker: «as General (off)» with ✓ on «As General»; a tap on 1 h is the topic's own choice, `state.json` keeps it, and
 *     THAT topic's next prompt carries the reminder while the topic that follows General's Off still gets none
 *   → the `/limits` board: a row under the accounts names the value in force (`🔔 Reminders: off`); a tap opens the picker as a new
 *     message and leaves the board alone; a pick there shows on the board's row at its next opening; General's row opens General's picker
 *   → a topic's own Off beats General's interval — read from the prompts again; «As General» drops the topic's own choice, says what it
 *     follows now, and the next prompt follows General's 4 h
 *   → the same screens in Russian (the chat's language), picker and board row
 *
 * The strings of all twelve languages are `limitRemindersScreenPlan.test.ts`'s; what a flow cannot reach cheaply — the settings file
 * beside other fields, an unwritable file, a refused tap, a stale or hand-made callback — is the module's own, over a harness:
 * `limitRemindersCommand.test.ts`.
 * Nothing leaves the machine: the Bot API is on loopback and the agent is a fake. Everything the test starts is stopped in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram, generalTopicThreadId, type FakeTelegramMessage } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import { fakeClaudeLogFileNames, fakeClaudeUsageWindowsFileName, type FakeClaudePrompt, type FakeClaudeUsageWindows } from './jiraE2e/fakeClaudeContract';
import {
  builtCliPath,
  createIsolatedInstanceLayout,
  exitOnSignal,
  getFlowDeadlineMs,
  getFreeFixedPort,
  getUnservedPort,
  IsolatedCharness,
  listTmuxSessions,
  readJsonLines,
  removeIsolatedInstanceSync,
  writeFakeClaudeLauncher,
  writeInstanceEnvFile,
  type IsolatedInstanceLayout,
} from './e2e/isolatedCharness';
import { openLimitsBoard, readPersistedState, restartCharnessWithState, startCharnessOnInstance } from './e2e/fallbackFlowKit';
import { createClaudeProfileLayout } from '../utils/claudeProfiles';
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const firstThreadId = 111;
const secondThreadId = 112;
const firstTopicKey = `${group.id}:${firstThreadId}`;
const secondTopicKey = `${group.id}:${secondThreadId}`;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const firstFolder = 'reminders-a';
const secondFolder = 'reminders-b';
const accountName = 'work';
const replyTimeoutMs = 30 * 1000;
const agentStartTimeoutMs = 60 * 1000;
/** The interval the flow shortens the setting's own to: a note is never held back by the clock here, only by the setting. */
const shortIntervalMs = 1000;

const reminderRe = /\[Accounts · \d{2}:\d{2}\]/;

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let general: TopicDriver;
let first: TopicDriver;
let second: TopicDriver;
let defaultTmuxSessionsBefore: string[] = [];
let turnCounter = 0;

function getLayout(): IsolatedInstanceLayout {
  if (!layout) throw new Error('the instance layout is not created yet');
  return layout;
}

function getCharness(): IsolatedCharness {
  if (!charness) throw new Error('charness is not started yet');
  return charness;
}

function removeInstanceSync(): void {
  removeIsolatedInstanceSync(layout, charness);
}

/** `settings.json` sits beside the instance's env file. */
function readSettingsFile(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(path.dirname(getLayout().envFile), 'settings.json'), 'utf8'));
}

const hoursAhead = (hours: number): string => new Date(Date.now() + hours * 3_600_000).toISOString();

function writeUsageWindows(): void {
  const windows: FakeClaudeUsageWindows = { [accountName]: { sessionPercent: 30, sessionResetsAt: hoursAhead(3), weeklyPercent: 40, weeklyResetsAt: hoursAhead(72) } };
  fs.writeFileSync(path.join(getLayout().fakeStateDir, fakeClaudeUsageWindowsFileName), JSON.stringify(windows));
}

/** Whether the account's figures reached the bot from an agent's frame and are fresh. */
function checkIsUsageFresh(): boolean {
  const usage = readPersistedState(getLayout()).claudeProfiles?.[accountName]?.usage;
  return usage?.source === 'stream' && usage.isStale !== true;
}

function listPrompts(): FakeClaudePrompt[] {
  return readJsonLines<FakeClaudePrompt>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.prompts));
}

/** What the fake agent read as the user message labelled `label`. */
function getPromptText(label: string): string {
  const prompt = listPrompts().find((candidate) => candidate.text.includes(`${label} `));
  assert.ok(prompt, `the agent read ${label}`);
  return prompt.text;
}

/** A turn in the topic: a labelled message the agent answers; resolves the label once the agent read it and answered. */
async function runTurn(driver: TopicDriver, threadId: number, tag: 'AA' | 'BB'): Promise<string> {
  turnCounter += 1;
  const label = `${tag}-${turnCounter}`;
  fakeTelegram.pushOperatorMessage(threadId, `${label} [fake:answer] a turn`);
  await driver.waitForMessage(`the answer to ${label}`, (message) => message.text.includes(`Fake final answer for ${label}`));
  return label;
}

/** The newest message of the topic that is NOT the picker's first screen: the current text of the picker message `picker`. */
function getCurrentMessage(driver: TopicDriver, picker: FakeTelegramMessage): FakeTelegramMessage {
  const current = driver.listMessages().find((message) => message.message_id === picker.message_id);
  assert.ok(current, 'the picker message is still in the topic');
  return current;
}

/** Tap `data` on the picker and wait until it has become its one-line confirmation (a text that starts with the bell and has no buttons). */
async function tapPicker(driver: TopicDriver, picker: FakeTelegramMessage, data: string): Promise<FakeTelegramMessage> {
  await driver.tapAndAwaitAnswer(picker, data);
  await driver.waitForMessageText('the picker to turn into its confirmation', picker, (text) => text.startsWith('🔔 Limit reminders:') || text.startsWith('🔔 Напоминания о лимитах:'));
  return getCurrentMessage(driver, picker);
}

describe('/limits_reminders and the /limits row end to end: built charness, fake Bot API, fake agent', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-limitrem-', [firstFolder, secondFolder], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fs.mkdirSync(layout.fakeStateDir, { recursive: true });
    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    general = new TopicDriver(fakeTelegram, getCharness, generalTopicThreadId, replyTimeoutMs);
    first = new TopicDriver(fakeTelegram, getCharness, firstThreadId, replyTimeoutMs);
    second = new TopicDriver(fakeTelegram, getCharness, secondThreadId, replyTimeoutMs);
    const apiRoot = await fakeTelegram.start();
    writeInstanceEnvFile(layout, {
      TELEGRAM_BOT_TOKEN: fakeBotToken,
      TELEGRAM_API_ROOT: apiRoot,
      ALLOWED_GROUP_ID: group.id.toString(),
      CHAT_MODE: 'group',
      DATA_DIR: layout.dataDir,
      WORK_ROOT: layout.workRoot,
      TMUX_TMPDIR: layout.tmuxTmpDir,
      CLAUDE_BIN: writeFakeClaudeLauncher(layout, null),
      // A free port nothing listens on: the boot's OpenCode pre-start finds no server and no binary, and gives up.
      OPENCODE_URL: `http://127.0.0.1:${await getUnservedPort()}`,
      SCHEDULER_MCP_PORT: (await getFreeFixedPort()).toString(),
      ...getTelegramFlowTestTimingsEnv({ limitReminderIntervalMs: shortIntervalMs }),
    });
    writeUsageWindows();
  });

  after(async () => {
    await charness?.stop();
    removeInstanceSync();
    await fakeTelegram?.stop();
    process.off('exit', removeInstanceSync);
    process.off('SIGINT', exitOnSignal);
    process.off('SIGTERM', exitOnSignal);
    assert.deepEqual(listTmuxSessions([]), defaultTmuxSessionsBefore, 'the default tmux server was not touched');
  });

  it('boots, binds two topics, seeds a signed-in account, makes both topics orchestrating conversations, and a warm-up turn in each fills the usage cache', async () => {
    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    for (const [topic, folder] of [[first, firstFolder], [second, secondFolder]] as const) {
      await topic.sendAndAwaitReply(`/bind ${folder}`, `Bound to \`${folder}\``);
      await topic.sendAndAwaitReply('/verbosity stream_answers', 'This topic shows: Stream + answers');
    }
    createClaudeProfileLayout({ dataDir: getLayout().dataDir, name: accountName, homeClaudeDir: path.join(getLayout().instanceHome, '.claude') });
    charness = await restartCharnessWithState(getLayout(), fakeTelegram, getCharness(), (persisted) => {
      persisted.claudeProfiles = { ...persisted.claudeProfiles, [accountName]: { createdAt: new Date().toISOString(), loggedIn: true, email: 'work@example.com', subscriptionType: 'max' } };
      persisted.claudeProfileOverrides = { ...persisted.claudeProfileOverrides, [firstTopicKey]: accountName, [secondTopicKey]: accountName };
      persisted.limitNotes = { [firstTopicKey]: { lastOrchestratedAt: Date.now() }, [secondTopicKey]: { lastOrchestratedAt: Date.now() } };
    });
    await first.sendAndAwaitReply('/claude', 'ready in');
    await second.sendAndAwaitReply('/claude', 'ready in');
    await runTurn(first, firstThreadId, 'AA');
    await runTurn(second, secondThreadId, 'BB');
    await getCharness().waitFor('the account\'s figures to reach the bot from the agents\' frames', agentStartTimeoutMs, checkIsUsageFresh);
  });

  it('General\'s picker: «every 1 h (default)», one row of intervals and Off, no «As General»; Off turns it into one line with no buttons and writes settings.json', async () => {
    const picker = await general.sendAndAwaitReply('/limits_reminders', 'Limit reminders to agents');
    assert.ok(picker.text.startsWith('🔔 Limit reminders to agents\n\n'), picker.text);
    assert.ok(picker.text.endsWith('Now: every 1 h (default)'), picker.text);
    assert.deepEqual(general.getKeyboardLabels(picker), [['1 h ✓', '2 h', '4 h', 'Off']]);
    assert.deepEqual(general.getKeyboardData(picker), [['lrm_60', 'lrm_120', 'lrm_240', 'lrm_0']]);
    assert.equal('limitReminders' in readSettingsFile(), false, 'a look writes nothing: the file (the instance\'s baseline) has no limitReminders');

    const confirmation = await tapPicker(general, picker, 'lrm_0');
    assert.equal(confirmation.text, '🔔 Limit reminders: off (all topics without their own choice).');
    assert.deepEqual(general.getKeyboardLabels(confirmation), [], 'the picker is consumed: no buttons left');
    assert.deepEqual((readSettingsFile().limitReminders as { everyMinutes?: number }).everyMinutes, 0, 'Off is stored as 0');
  });

  it('Off in General stops every note: neither orchestrating topic\'s next prompt carries one, the shortened interval notwithstanding', async () => {
    const firstLabel = await runTurn(first, firstThreadId, 'AA');
    const secondLabel = await runTurn(second, secondThreadId, 'BB');
    assert.doesNotMatch(getPromptText(firstLabel), /\[Accounts/);
    assert.doesNotMatch(getPromptText(secondLabel), /\[Accounts/);
  });

  it('a topic\'s picker: «as General (off)», ✓ on «As General»; a tap on 1 h is its OWN choice, stored — and only that topic\'s next prompt carries the reminder', async () => {
    const picker = await first.sendAndAwaitReply('/limits_reminders', 'Limit reminders to agents — this topic');
    assert.ok(picker.text.endsWith('Now: as General (off)'), picker.text);
    assert.deepEqual(first.getKeyboardLabels(picker), [['As General ✓'], ['1 h', '2 h', '4 h', 'Off']]);

    const confirmation = await tapPicker(first, picker, 'lrm_60');
    assert.equal(confirmation.text, '🔔 Limit reminders: every 1 h (this topic).');
    assert.deepEqual(first.getKeyboardLabels(confirmation), []);
    assert.equal(readPersistedState(getLayout()).limitRemindersOverrides?.[firstTopicKey], 60);
    assert.equal(readPersistedState(getLayout()).limitRemindersOverrides?.[secondTopicKey], undefined, 'the other topic still follows General');

    const firstLabel = await runTurn(first, firstThreadId, 'AA');
    const secondLabel = await runTurn(second, secondThreadId, 'BB');
    assert.match(getPromptText(firstLabel), reminderRe, 'the topic\'s own interval beats General\'s Off');
    assert.doesNotMatch(getPromptText(secondLabel), /\[Accounts/, 'the topic that follows General\'s Off gets none');
  });

  it('the /limits board: a row under the accounts names the value in force; a tap opens the picker as a NEW message and leaves the board alone; a pick shows on the row at the next opening', async () => {
    const board = await openLimitsBoard(fakeTelegram, second, secondThreadId);
    const labels = second.getKeyboardLabels(board.message).flat();
    assert.equal(labels.at(-1), '🔔 Reminders: off', 'topic B follows General\'s Off');
    assert.ok(labels.some((label) => label.includes('Claude · ')), 'the account rows are above it');
    const rowData = board.rowData('🔔 Reminders');
    assert.equal(rowData, 'lim_rem');

    const messagesBefore = second.listMessages().length;
    const boardTextBefore = board.message.text;
    fakeTelegram.pushCallback(board.message.message_id, rowData);
    const picker = await second.waitForMessage('the picker opened from the board', (message) => message.message_id > board.message.message_id && message.text.startsWith('🔔 Limit reminders to agents — this topic'));
    assert.ok(picker.text.endsWith('Now: as General (off)'), picker.text);
    assert.equal(second.listMessages().length, messagesBefore + 1, 'one new message: the picker');
    assert.equal(getCurrentMessage(second, board.message).text, boardTextBefore, 'the board message is untouched');

    const confirmation = await tapPicker(second, picker, 'lrm_120');
    assert.equal(confirmation.text, '🔔 Limit reminders: every 2 h (this topic).');
    const reopened = await openLimitsBoard(fakeTelegram, second, secondThreadId);
    assert.equal(second.getKeyboardLabels(reopened.message).flat().at(-1), '🔔 Reminders: every 2 h');
    const firstBoard = await openLimitsBoard(fakeTelegram, first, firstThreadId);
    assert.equal(first.getKeyboardLabels(firstBoard.message).flat().at(-1), '🔔 Reminders: every 1 h', 'topic A\'s own value');
  });

  it('General\'s board row opens General\'s picker (no «As General»); its tap sets the instance value for every topic without a choice of its own', async () => {
    const board = await openLimitsBoard(fakeTelegram, general, generalTopicThreadId);
    assert.equal(general.getKeyboardLabels(board.message).flat().at(-1), '🔔 Reminders: off');
    fakeTelegram.pushCallback(board.message.message_id, board.rowData('🔔 Reminders'));
    const picker = await general.waitForMessage('General\'s picker opened from the board', (message) => message.message_id > board.message.message_id && message.text.startsWith('🔔 Limit reminders to agents\n\n'));
    assert.deepEqual(general.getKeyboardLabels(picker), [['1 h', '2 h', '4 h', 'Off ✓']]);
    const confirmation = await tapPicker(general, picker, 'lrm_240');
    assert.equal(confirmation.text, '🔔 Limit reminders: every 4 h (all topics without their own choice).');
    assert.equal((readSettingsFile().limitReminders as { everyMinutes?: number }).everyMinutes, 240);
    const reopened = await openLimitsBoard(fakeTelegram, general, generalTopicThreadId);
    assert.equal(general.getKeyboardLabels(reopened.message).flat().at(-1), '🔔 Reminders: every 4 h');
  });

  it('a topic\'s own Off beats General\'s interval, a topic\'s own interval beats it the other way — read from the prompts', async () => {
    const picker = await first.sendAndAwaitReply('/limits_reminders', 'Limit reminders to agents — this topic');
    assert.deepEqual(first.getKeyboardLabels(picker), [['As General'], ['1 h ✓', '2 h', '4 h', 'Off']]);
    await tapPicker(first, picker, 'lrm_0');
    assert.equal(readPersistedState(getLayout()).limitRemindersOverrides?.[firstTopicKey], 0, 'a topic\'s Off is stored as 0');

    const firstLabel = await runTurn(first, firstThreadId, 'AA');
    const secondLabel = await runTurn(second, secondThreadId, 'BB');
    assert.doesNotMatch(getPromptText(firstLabel), /\[Accounts/, 'General says 4 h, the topic says Off: Off');
    assert.match(getPromptText(secondLabel), reminderRe, 'topic B\'s own 2 h: its reminder is due');
  });

  it('«As General» drops the topic\'s own choice, names what it follows now, and the next prompt follows General\'s 4 h', async () => {
    const picker = await first.sendAndAwaitReply('/limits_reminders', 'Limit reminders to agents — this topic');
    assert.deepEqual(first.getKeyboardLabels(picker), [['As General'], ['1 h', '2 h', '4 h', 'Off ✓']], 'the topic\'s own Off is the one marked');
    const confirmation = await tapPicker(first, picker, 'lrm_g');
    assert.equal(confirmation.text, '🔔 Limit reminders: as General — every 4 h (this topic).');
    assert.deepEqual(first.getKeyboardLabels(confirmation), []);
    assert.equal(readPersistedState(getLayout()).limitRemindersOverrides?.[firstTopicKey], undefined, 'the topic\'s own choice is gone from state.json');

    const firstLabel = await runTurn(first, firstThreadId, 'AA');
    assert.match(getPromptText(firstLabel), reminderRe, 'General\'s 4 h applies again: the reminder is due');
  });

  it('in Russian — the chat\'s language — the picker, its confirmation and the board\'s row are worded in it', async () => {
    charness = await restartCharnessWithState(getLayout(), fakeTelegram, getCharness(), (persisted) => {
      persisted.chatLocaleOverrides = { [group.id.toString()]: 'ru' };
    });
    const picker = await first.sendAndAwaitReply('/limits_reminders', 'Напоминания агентам о лимитах — этот топик');
    assert.ok(picker.text.endsWith('Сейчас: как в General (каждые 4 ч)'), picker.text);
    assert.deepEqual(first.getKeyboardLabels(picker), [['Как в General ✓'], ['1 ч', '2 ч', '4 ч', 'Выкл']]);
    assert.deepEqual(first.getKeyboardData(picker), [['lrm_g'], ['lrm_60', 'lrm_120', 'lrm_240', 'lrm_0']], 'the data does not depend on the language');
    const confirmation = await tapPicker(first, picker, 'lrm_120');
    assert.equal(confirmation.text, '🔔 Напоминания о лимитах: каждые 2 ч (этот топик).');
    const board = await openLimitsBoard(fakeTelegram, first, firstThreadId);
    assert.equal(first.getKeyboardLabels(board.message).flat().at(-1), '🔔 Напоминания: каждые 2 ч');
  });
});
