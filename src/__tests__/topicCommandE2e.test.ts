/**
 * @description `/topic` at PROCESS level: the BUILT charness started the way an isolated instance is
 * (`scripts/run-isolated.sh`) against the fake Bot API (`telegramE2e/fakeTelegram.ts`), which creates forum topics, gives
 * them an id from the one message sequence and — here — also delivers the bot the `forum_topic_created` service message of
 * a topic it created itself (whether Telegram does is not documented), ahead of the creation's own answer. One flow, in order:
 *
 *   boot → a topic bound to a folder
 *   → `/topic`: the name is asked; the name goes in, and the folder question («as here» / «other») follows; «as here»
 *     creates the topic, which is bound to the same folder (name kept on the binding), greeted with the usual welcome — once,
 *     without a warning about the folder's other topic, without the folder picker the service message might bring, without
 *     a `[security]` line about a non-admin's topic — and the
 *     question message becomes the answer with a link to the new topic; no agent starts
 *   → a tap on the answered question's old button makes no second topic
 *   → `/topic <name>` skips the name question; «other folder» opens the same picker `/bind` has, a pick binds the new topic there
 *   → `/topic <name>` in General: the picker at once, no «as here»
 *   → «create new folder»: a refused name keeps the question open, a good one makes the folder on disk and the topic on it
 *   → `/esc` cancels a pending name question (the next message is not taken as the name); so does any other command
 *   → a group without the right to manage topics gets the existing hint, and no topic is made
 *   → the «cancel» button and `/esc` end the wizard at the folder question and in the picker (consuming the message)
 *   → `/bind`'s own «create new folder» (the path `/topic` shares): arming it ends a pending `/topic` question, the folder is made
 *     and bound.
 *
 * What the unit tests cover instead: the pure parts, the picker's paging, the private chat's refusal, the wizard's
 * expiry and the double tap (`topicCommand.test.ts`), the picker's layout (`bindKeyboard.test.ts`).
 *
 * Nothing leaves the machine: the Bot API is on loopback and the agent is a fake. Everything the test starts is stopped
 * in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram, generalTopicThreadId, type FakeTelegramMessage } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import {
  builtCliPath,
  createIsolatedInstanceLayout,
  exitOnSignal,
  getFlowDeadlineMs,
  getFreeFixedPort,
  getFreePort,
  IsolatedCharness,
  listTmuxSessions,
  removeIsolatedInstanceSync,
  writeFakeClaudeLauncher,
  writeInstanceEnvFile,
  type IsolatedInstanceLayout,
} from './e2e/isolatedCharness';
import { getSessionLaunches, readPersistedState, startCharnessOnInstance } from './e2e/fallbackFlowKit';
import { enDict } from '../i18n/en';
import type { BindingData } from '../state';
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';

const group = { id: -1001111111111, title: 'ExampleGroup' };
/** The id the group has in `t.me/c/<id>/…` links: the Bot API id without its `-100`. */
const groupLinkId = '1111111111';
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';

const originThreadId = 181;
const folders = { current: 'alpha', other: 'beta' } as const;
const newFolderName = 'brand-new';
const bindFolderName = 'bind-made';
const raceFolderName = 'race-made';
const plainNoteAfterRace = 'plain-note-after-race';
/** The callback data of `/bind`'s «create new folder» button (the wire id the picker is matched by). */
const bindCreateFolderData = 'bindCreateFolder';
const replyTimeoutMs = 20 * 1000;

const sameFolderLabel = enDict['topic.sameFolderButton'].replace('{subdir}', folders.current);
const otherFolderLabel = enDict['topic.otherFolderButton'];
const createFolderLabel = enDict['bind.create_button'];
const cancelLabel = enDict['topic.cancelButton'];
const escHint = enDict['login.esc_hint'];

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let originTopic: TopicDriver;
let generalTopic: TopicDriver;
let defaultTmuxSessionsBefore: string[] = [];

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

function fillTemplate(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value), template);
}

/** The callback data of the button with this caption (the captions of a picker are unique). */
function getButtonData(driver: TopicDriver, message: FakeTelegramMessage, label: string): string {
  const labels = driver.getKeyboardLabels(message).flat();
  const data = driver.getKeyboardData(message).flat();
  const index = labels.indexOf(label);
  if (index < 0) throw new Error(`no button «${label}» in ${labels.join(' | ')}`);
  return data[index];
}

/** The binding the bot keeps for a topic of the group, read from `state.json`. */
function readBinding(threadId: number): BindingData | undefined {
  return readPersistedState(getLayout()).bindings?.[`${group.id}:${threadId}`];
}

/** The topics the bot has created so far, oldest first. */
function listCreatedTopics(): Array<{ threadId: number; name: string }> {
  return [...fakeTelegram.createdTopics];
}

async function waitForTopicCount(count: number): Promise<{ threadId: number; name: string }> {
  await getCharness().waitFor(`${count} topic(s) created`, replyTimeoutMs, () => fakeTelegram.createdTopics.length >= count);
  return fakeTelegram.createdTopics[count - 1];
}

/**
 * Resolves once the bot has polled twice since its `count`-th topic was created: the poll that carried the topic's own
 * `forum_topic_created` (the fake pushes it at the creation) has returned and the bot came back for more, so the service
 * message sits in the new topic's queue. Held on this, the creation's answer reaches the bot only after that, and the topic
 * is not bound yet when its service message is handled — the order a real group showed, where the bot logged its own topic
 * as a non-admin's.
 */
async function waitForOwnTopicEventTaken(count: number): Promise<void> {
  await waitForTopicCount(count);
  const pollsAtCreation = fakeTelegram.listCalls('getUpdates').length;
  await getCharness().waitFor('two polls after the topic was created', replyTimeoutMs, () => fakeTelegram.listCalls('getUpdates').length >= pollsAtCreation + 2);
}

/**
 * The operator types `text` in the origin topic and the bot has handled it AND everything sent before it: a command that
 * answers is its own barrier (`/bind` with no argument always answers).
 */
async function settleOriginTopic(): Promise<void> {
  await originTopic.sendAndAwaitReply('/bind', enDict['bind.current'].replace('{subdir}', folders.current));
}

describe('/topic end to end: built charness, fake Bot API', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-topic-', Object.values(folders), getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    fakeTelegram.isOwnTopicEventDelivered = true;
    originTopic = new TopicDriver(fakeTelegram, getCharness, originThreadId, replyTimeoutMs);
    generalTopic = new TopicDriver(fakeTelegram, getCharness, generalTopicThreadId, replyTimeoutMs);
    const apiRoot = await fakeTelegram.start();
    writeInstanceEnvFile(layout, {
      CONNECTORS: 'telegram',
      TELEGRAM_BOT_TOKEN: fakeBotToken,
      TELEGRAM_API_ROOT: apiRoot,
      ALLOWED_GROUP_ID: group.id.toString(),
      CHAT_MODE: 'group',
      DATA_DIR: layout.dataDir,
      WORK_ROOT: layout.workRoot,
      TMUX_SOCKET_NAME: layout.tmuxSocketName,
      TMUX_TMPDIR: layout.tmuxTmpDir,
      CLAUDE_BIN: writeFakeClaudeLauncher(layout, null),
      // A free port nothing listens on: the boot's OpenCode pre-start finds no server and no binary, and gives up.
      OPENCODE_URL: `http://127.0.0.1:${await getFreePort()}`,
      SCHEDULER_MCP_PORT: (await getFreeFixedPort()).toString(),
      ...getTelegramFlowTestTimingsEnv(),
    });
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

  it('boots and binds the origin topic to a folder', async () => {
    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    await originTopic.sendAndAwaitReply(`/bind ${folders.current}`, `Bound to \`${folders.current}\``);
  });

  let answeredQuestion: FakeTelegramMessage;
  let answeredQuestionData: string;

  it('/topic asks the name, then the folder; «as here» makes the topic on the same folder, greeted, linked, with no agent', async () => {
    const askName = await originTopic.sendAndAwaitReply('/topic', enDict['topic.askName']);
    assert.ok(askName.text.endsWith(escHint), 'the name question offers /esc');

    fakeTelegram.pushOperatorMessage(originThreadId, '  Release   notes ');
    const question = await originTopic.waitForMessage('the folder question', (message) => message.text === fillTemplate(enDict['topic.askFolder'], { name: 'Release notes' }));
    assert.deepEqual(originTopic.getKeyboardLabels(question), [[sameFolderLabel], [otherFolderLabel], [cancelLabel]]);
    answeredQuestion = question;
    answeredQuestionData = getButtonData(originTopic, question, sameFolderLabel);

    const ownTopicEventTaken = waitForOwnTopicEventTaken(1);
    // A timeout surfaces at the `await` below; the hold itself only waits for it to settle.
    fakeTelegram.holdNextResponse('createForumTopic', ownTopicEventTaken.catch(() => undefined));
    const toast = await originTopic.tapAndAwaitAnswer(question, answeredQuestionData);
    assert.equal(toast, enDict['topic.creatingToast']);
    await ownTopicEventTaken;
    const created = await waitForTopicCount(1);
    assert.equal(created.name, 'Release notes', 'the name arrives trimmed and with its spaces collapsed');

    await originTopic.waitForMessageText('the answer in the question message', question, (text) => text === fillTemplate(enDict['topic.created'], { name: 'Release notes', subdir: folders.current }));
    assert.deepEqual(originTopic.getKeyboardUrls(question), [`https://t.me/c/${groupLinkId}/${created.threadId}`], 'the link opens the new topic');
    assert.deepEqual(originTopic.getKeyboardData(question).flat(), [], 'the choice is consumed');

    // The new topic is bound to the same folder, remembers its name, and is greeted like any bound topic.
    const newTopic = new TopicDriver(fakeTelegram, getCharness, created.threadId, replyTimeoutMs);
    await newTopic.waitForMessage('the welcome', (message) => message.text.includes(enDict['binding.welcome.start_prompt']));
    await newTopic.sendAndAwaitReply('/bind', enDict['bind.current'].replace('{subdir}', folders.current));
    // The bot writes state.json a moment after it bound the topic.
    await getCharness().waitFor('the binding persisted', replyTimeoutMs, () => readBinding(created.threadId) !== undefined);
    assert.equal(readBinding(created.threadId)?.subdir, folders.current);
    assert.equal(readBinding(created.threadId)?.topicName, 'Release notes');
    // The bot also got the service message of its own topic; it must not have been answered with the folder picker or a
    // second greeting. A second round trip is the barrier: every send the service message's handler queued went out first.
    await newTopic.sendAndAwaitReply('/bind', enDict['bind.current'].replace('{subdir}', folders.current));
    assert.equal(newTopic.listMessages().filter((message) => message.text.includes(enDict['binding.welcome.start_prompt'])).length, 1, 'one welcome');
    assert.ok(!newTopic.listMessages().some((message) => message.text.includes('already used by threads')), 'no warning about the folder\'s other topic: the person asked for it');
    assert.ok(!newTopic.listMessages().some((message) => message.text === enDict['thread.welcome_pick']), 'no folder picker in the new topic');
    assert.ok(!getCharness().output.includes('[security] forum_topic_created'), 'the bot\'s own topic is no foreign creation to warn about');
    assert.equal(getSessionLaunches(getLayout()).length, 0, 'no agent was started');
  });

  it('the old button of an answered question makes no second topic', async () => {
    const toast = await originTopic.tapAndAwaitAnswer(answeredQuestion, answeredQuestionData);
    assert.equal(toast, enDict['topic.staleChoice']);
    await settleOriginTopic();
    assert.equal(listCreatedTopics().length, 1);
  });

  it('/topic <name> skips the name question; «other folder» is the /bind picker, and a pick binds the new topic there', async () => {
    const sentId = fakeTelegram.pushOperatorMessage(originThreadId, '/topic Second one');
    const question = await originTopic.waitForMessage('the folder question', (message) => message.message_id > sentId && message.text === fillTemplate(enDict['topic.askFolder'], { name: 'Second one' }));
    assert.ok(!originTopic.listMessages().some((message) => message.message_id > sentId && message.text.startsWith(enDict['topic.askName'])), 'the name was not asked');

    await originTopic.tapAndAwaitAnswer(question, getButtonData(originTopic, question, otherFolderLabel));
    await originTopic.waitForMessageText('the picker', question, (text) => text === fillTemplate(enDict['topic.pickFolder'], { name: 'Second one' }));
    const labels = originTopic.getKeyboardLabels(question).flat();
    assert.deepEqual(labels, [createFolderLabel, `📁 ${folders.current}`, `📁 ${folders.other}`, cancelLabel], '/bind\'s own layout: the create row, then the folders, then the way out');

    await originTopic.tapAndAwaitAnswer(question, getButtonData(originTopic, question, `📁 ${folders.other}`));
    const created = await waitForTopicCount(2);
    await originTopic.waitForMessageText('the answer', question, (text) => text === fillTemplate(enDict['topic.created'], { name: 'Second one', subdir: folders.other }));
    assert.deepEqual(originTopic.getKeyboardUrls(question), [`https://t.me/c/${groupLinkId}/${created.threadId}`]);
    await getCharness().waitFor('the binding of the second topic', replyTimeoutMs, () => readBinding(created.threadId)?.subdir === folders.other);
  });

  it('in General there is no folder to offer as «here»: the picker comes at once', async () => {
    const sentId = fakeTelegram.pushOperatorMessage(generalTopicThreadId, '/topic From General');
    const picker = await generalTopic.waitForMessage('the picker', (message) => message.message_id > sentId && message.text === fillTemplate(enDict['topic.pickFolder'], { name: 'From General' }));
    assert.ok(!generalTopic.getKeyboardLabels(picker).flat().includes(otherFolderLabel), 'no «other folder» step');

    await generalTopic.tapAndAwaitAnswer(picker, getButtonData(generalTopic, picker, `📁 ${folders.current}`));
    const created = await waitForTopicCount(3);
    await generalTopic.waitForMessageText('the answer', picker, (text) => text === fillTemplate(enDict['topic.created'], { name: 'From General', subdir: folders.current }));
    assert.deepEqual(generalTopic.getKeyboardUrls(picker), [`https://t.me/c/${groupLinkId}/${created.threadId}`]);
    await getCharness().waitFor('the binding of the General topic', replyTimeoutMs, () => readBinding(created.threadId)?.subdir === folders.current);
  });

  it('«create new folder» in the picker: a refused name keeps the question open; a good one makes the folder and the topic on it', async () => {
    const sentId = fakeTelegram.pushOperatorMessage(originThreadId, '/topic Fresh start');
    const question = await originTopic.waitForMessage('the folder question', (message) => message.message_id > sentId && message.text === fillTemplate(enDict['topic.askFolder'], { name: 'Fresh start' }));
    await originTopic.tapAndAwaitAnswer(question, getButtonData(originTopic, question, otherFolderLabel));
    await originTopic.waitForMessageText('the picker', question, (text) => text === fillTemplate(enDict['topic.pickFolder'], { name: 'Fresh start' }));
    await originTopic.tapAndAwaitAnswer(question, getButtonData(originTopic, question, createFolderLabel));
    await originTopic.waitForMessageText('the folder-name question', question, (text) => text === `${fillTemplate(enDict['topic.createFolderPrompt'], { name: 'Fresh start' })}\n${escHint}`);
    assert.deepEqual(originTopic.getKeyboardData(question).flat(), [], 'the picker is consumed');

    const refusedId = fakeTelegram.pushOperatorMessage(originThreadId, '../escape');
    await originTopic.waitForMessage('the refusal', (message) => message.message_id > refusedId && message.text === enDict['bind.create_separator']);
    assert.equal(listCreatedTopics().length, 3, 'no topic for a refused name');

    fakeTelegram.pushOperatorMessage(originThreadId, newFolderName);
    const created = await waitForTopicCount(4);
    await originTopic.waitForMessageText('the answer', question, (text) => text === fillTemplate(enDict['topic.created'], { name: 'Fresh start', subdir: newFolderName }));
    assert.ok(fs.statSync(path.join(getLayout().workRoot, newFolderName)).isDirectory(), 'the folder exists under WORK_ROOT');
    await getCharness().waitFor('the binding of the fourth topic', replyTimeoutMs, () => readBinding(created.threadId)?.subdir === newFolderName);
  });

  it('/esc cancels a pending name question: the next message is no name', async () => {
    await originTopic.sendAndAwaitReply('/topic', enDict['topic.askName']);
    await originTopic.sendAndAwaitReply('/esc', enDict['topic.cancelled']);
    const noteId = fakeTelegram.pushOperatorMessage(originThreadId, 'just a note');
    await settleOriginTopic();
    assert.ok(!originTopic.listMessages().some((message) => message.message_id > noteId && message.text === fillTemplate(enDict['topic.askFolder'], { name: 'just a note' })), 'the note was not taken for a name');
    assert.equal(listCreatedTopics().length, 4);
  });

  it('any other command ends a pending name question silently', async () => {
    await originTopic.sendAndAwaitReply('/topic', enDict['topic.askName']);
    await settleOriginTopic();
    const noteId = fakeTelegram.pushOperatorMessage(originThreadId, 'another note');
    await settleOriginTopic();
    assert.ok(!originTopic.listMessages().some((message) => message.message_id > noteId && message.text === fillTemplate(enDict['topic.askFolder'], { name: 'another note' })), 'the note was not taken for a name');
    assert.equal(listCreatedTopics().length, 4);
  });

  it('the «cancel» button ends the wizard at the folder question and in the picker: the message becomes the notice', async () => {
    const sentId = fakeTelegram.pushOperatorMessage(originThreadId, '/topic Cancelled by button');
    const question = await originTopic.waitForMessage('the folder question', (message) => message.message_id > sentId && message.text === fillTemplate(enDict['topic.askFolder'], { name: 'Cancelled by button' }));
    const cancelData = getButtonData(originTopic, question, cancelLabel);
    await originTopic.tapAndAwaitAnswer(question, getButtonData(originTopic, question, otherFolderLabel));
    await originTopic.waitForMessageText('the picker', question, (text) => text === fillTemplate(enDict['topic.pickFolder'], { name: 'Cancelled by button' }));
    await originTopic.tapAndAwaitAnswer(question, cancelData);
    await originTopic.waitForMessageText('the notice', question, (text) => text === enDict['topic.cancelled']);
    assert.deepEqual(originTopic.getKeyboardData(question).flat(), [], 'the keyboard is consumed');
    assert.equal(listCreatedTopics().length, 4);
    // The wizard is gone: a tap on the old button is out of date.
    assert.equal(await originTopic.tapAndAwaitAnswer(question, cancelData), enDict['topic.staleChoice']);
  });

  it('/esc at the folder question ends the wizard instead of interrupting the agent', async () => {
    const sentId = fakeTelegram.pushOperatorMessage(originThreadId, '/topic Cancelled by esc');
    const question = await originTopic.waitForMessage('the folder question', (message) => message.message_id > sentId && message.text === fillTemplate(enDict['topic.askFolder'], { name: 'Cancelled by esc' }));
    const sameFolderData = getButtonData(originTopic, question, sameFolderLabel);
    fakeTelegram.pushOperatorMessage(originThreadId, '/esc');
    await originTopic.waitForMessageText('the notice', question, (text) => text === enDict['topic.cancelled']);
    assert.deepEqual(originTopic.getKeyboardData(question).flat(), [], 'the keyboard is consumed');
    assert.equal(await originTopic.tapAndAwaitAnswer(question, sameFolderData), enDict['topic.staleChoice']);
    assert.equal(listCreatedTopics().length, 4);
  });

  it('a slash command meant for the agent ends a pending name question too', async () => {
    await originTopic.sendAndAwaitReply('/topic', enDict['topic.askName']);
    // Not a bot command, so it goes to the agent (none runs: the topic answers that) — and nothing here is a command that
    // would end the question by itself, as the settling `/bind` of the steps above does.
    const contextId = fakeTelegram.pushOperatorMessage(originThreadId, '/context');
    await originTopic.waitForMessage('the answer to /context', (message) => message.message_id > contextId);
    const noteId = fakeTelegram.pushOperatorMessage(originThreadId, 'a third note');
    await originTopic.waitForMessage('the answer to the note', (message) => message.message_id > noteId);
    assert.ok(!originTopic.listMessages().some((message) => message.message_id > noteId && message.text === fillTemplate(enDict['topic.askFolder'], { name: 'a third note' })), 'the note was not taken for a name');
    assert.equal(listCreatedTopics().length, 4);
  });

  it('a group without the right to manage topics gets the existing hint, and no topic is made', async () => {
    fakeTelegram.canManageTopics = false;
    try {
      const sentId = fakeTelegram.pushOperatorMessage(originThreadId, '/topic Denied');
      const question = await originTopic.waitForMessage('the folder question', (message) => message.message_id > sentId && message.text === fillTemplate(enDict['topic.askFolder'], { name: 'Denied' }));
      await originTopic.tapAndAwaitAnswer(question, getButtonData(originTopic, question, sameFolderLabel));
      await originTopic.waitForMessageText('the hint', question, (text) => text === enDict['error.tg.perm.manage_topics']);
      assert.equal(listCreatedTopics().length, 4);
      assert.deepEqual(originTopic.getKeyboardUrls(question), []);
    } finally {
      fakeTelegram.canManageTopics = true;
    }
  });

  it('«create new folder» of a /topic picker ends /bind\'s own armed folder-name question: the plain message after it is the agent\'s', async () => {
    const sentId = fakeTelegram.pushOperatorMessage(originThreadId, '/topic Races the bind picker');
    const question = await originTopic.waitForMessage('the folder question', (message) => message.message_id > sentId && message.text === fillTemplate(enDict['topic.askFolder'], { name: 'Races the bind picker' }));
    await originTopic.tapAndAwaitAnswer(question, getButtonData(originTopic, question, otherFolderLabel));
    await originTopic.waitForMessageText('the picker', question, (text) => text === fillTemplate(enDict['topic.pickFolder'], { name: 'Races the bind picker' }));

    // /bind's picker, and its «create new folder» tapped: the next plain message would be a folder name for /bind …
    const bindId = fakeTelegram.pushOperatorMessage(originThreadId, '/bind');
    const bindPicker = await originTopic.waitForMessage('the /bind picker', (message) => message.message_id > bindId && originTopic.getKeyboardData(message).flat().includes(bindCreateFolderData));
    await originTopic.tapAndAwaitAnswer(bindPicker, bindCreateFolderData);
    await originTopic.waitForMessage('the /bind folder-name prompt', (message) => message.message_id > bindPicker.message_id && message.text === enDict['bind.create_prompt']);
    // … until the /topic picker's «create new folder» takes the next message for itself.
    await originTopic.tapAndAwaitAnswer(question, getButtonData(originTopic, question, createFolderLabel));
    await originTopic.waitForMessageText('the folder-name question', question, (text) => text === `${fillTemplate(enDict['topic.createFolderPrompt'], { name: 'Races the bind picker' })}\n${escHint}`);

    fakeTelegram.pushOperatorMessage(originThreadId, raceFolderName);
    const created = await waitForTopicCount(5);
    await getCharness().waitFor('the new topic bound to the folder', replyTimeoutMs, () => readBinding(created.threadId)?.subdir === raceFolderName);
    // The message after it is nobody's folder name: it is not made a folder, and the origin topic keeps its binding.
    const noteId = fakeTelegram.pushOperatorMessage(originThreadId, plainNoteAfterRace);
    await originTopic.waitForMessage('the answer to the plain message', (message) => message.message_id > noteId);
    assert.ok(!fs.existsSync(path.join(getLayout().workRoot, plainNoteAfterRace)), 'the plain message was not taken for a folder name');
    assert.equal(readBinding(originThreadId)?.subdir, folders.current, 'the origin topic was not rebound');
  });

  it('/bind\'s own «create new folder» still works, and arming it ends a pending /topic question: the folder\'s name is no topic name', async () => {
    const bindId = fakeTelegram.pushOperatorMessage(originThreadId, '/bind');
    const picker = await originTopic.waitForMessage('the /bind picker', (message) => message.message_id > bindId && originTopic.getKeyboardData(message).flat().includes(bindCreateFolderData));
    await originTopic.sendAndAwaitReply('/topic', enDict['topic.askName']);
    const toast = await originTopic.tapAndAwaitAnswer(picker, bindCreateFolderData);
    assert.equal(toast, enDict['bind.create_cb']);
    await originTopic.waitForMessage('the folder-name prompt', (message) => message.message_id > picker.message_id && message.text === enDict['bind.create_prompt']);

    const refusedId = fakeTelegram.pushOperatorMessage(originThreadId, '../escape');
    await originTopic.waitForMessage('the refusal', (message) => message.message_id > refusedId && message.text === enDict['bind.create_separator']);
    fakeTelegram.pushOperatorMessage(originThreadId, bindFolderName);
    await getCharness().waitFor('the origin topic bound to the new folder', replyTimeoutMs, () => readBinding(originThreadId)?.subdir === bindFolderName);
    assert.ok(fs.statSync(path.join(getLayout().workRoot, bindFolderName)).isDirectory(), 'the folder exists under WORK_ROOT');
    await originTopic.waitForMessage('the welcome of the new binding', (message) => message.text.includes(`Bound to \`${bindFolderName}\``));
    assert.equal(listCreatedTopics().length, 5, 'no topic was made from the folder\'s name');
    assert.ok(!originTopic.listMessages().some((message) => message.text === fillTemplate(enDict['topic.askFolder'], { name: bindFolderName })), 'the folder\'s name was not taken for a topic name');
  });
});
