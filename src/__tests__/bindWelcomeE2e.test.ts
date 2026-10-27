/**
 * @description What a topic shows after it is bound to a folder, at PROCESS level: the BUILT charness started the way an
 * isolated instance is (`scripts/run-isolated.sh`) against the fake Bot API (`telegramE2e/fakeTelegram.ts`). Whichever way
 * the binding happens, the topic ends up with ONE message announcing it — the full welcome (the folder's facts and the start
 * buttons) — and nothing else: no short «Bound to … Run /claude or /opencode» acknowledgement, no separate 👋 greeting for an
 * auto-bound topic, no separate warning for a shared folder. What those used to say rides in the welcome as one row each.
 * One flow, in order:
 *
 *   boot → a typed `/bind <folder>` leaves ONE bound-folder message: the welcome, with its start buttons
 *   → a folder tapped in the `/bind` picker: the same single message
 *   → a folder another topic already uses: the same single message, with a row naming that topic
 *   → the picker's «create new folder»: the folder is made on disk and bound, the same single message
 *   → a folder that does not exist: the refusal is shown, no welcome, the topic keeps its binding
 *   → a topic an admin makes with the name of a folder: bound by the bot, the welcome says why, in one message
 *   → a topic a non-admin makes with the name of a folder: nothing is bound; the admin's first message there binds it,
 *     again with the one welcome
 *   → the same two ways onto a folder another topic already uses: the welcome also names that topic
 *   → the admin's first message in such a topic is still read as what it is: a start phrase (`claude`) starts the agent,
 *     next to the one welcome.
 *
 * What the unit tests cover instead: the picker's layout (`bindKeyboard.test.ts`), the folder-name rules (`folderName.test.ts`),
 * what a `forum_topic_created` leads to (`forumTopicCreated.test.ts`). `/topic`'s own greeting: `topicCommandE2e.test.ts`.
 *
 * Nothing leaves the machine: the Bot API is on loopback and the agent is a fake. Everything the test starts is stopped
 * in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram, type FakeTelegramMessage, type TelegramUser } from './telegramE2e/fakeTelegram';
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
import { getAllLaunches, getSessionLaunches, startCharnessOnInstance } from './e2e/fallbackFlowKit';
import { bindCreateFolderCallback } from '../connectors/telegram/bindPicker';
import { t } from '../i18n';
import { enDict } from '../i18n/en';
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';

const mainThreadId = 191;
const peerThreadId = 192;
/** A group member who is no admin: the bot does not serve them, so a topic they make is not bound at once. */
const stranger: TelegramUser = { id: 515151, is_bot: false, first_name: 'Stranger' };
const folders = { first: 'bind-first', second: 'bind-second', auto: 'bind-auto', deferred: 'bind-deferred', phrase: 'bind-phrase' } as const;
const madeFolderName = 'bind-made';
const missingFolderName = 'bind-missing';
/** The tail of the short acknowledgement and of the greeting the welcome made redundant. */
const shortAckTail = 'Run /claude or /opencode';
const greetingMark = '👋';
/** What the one welcome's keyboard offers: start Claude / OpenCode, resume. */
const startButtonsData = [['agent_claude', 'agent_opencode'], ['open_sessions']];
/** The start of the welcome's shared-folder row, up to where the topics are named. */
const sharedRowStart = enDict['binding.welcome.shared'].split('{threads}')[0];
/** The flag every FRESH agent start carries, whichever Claude backend runs it (a resume carries `--resume` instead). */
const freshSessionFlag = '--session-id';
/** The log line of the bot setting a non-admin's topic name aside. */
const nameCachedLogLine = '[security] forum_topic_created';
const replyTimeoutMs = 20 * 1000;
/** A session start through the fake agent. */
const agentStartTimeoutMs = 60 * 1000;

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let mainTopic: TopicDriver;
let peerTopic: TopicDriver;
let defaultTmuxSessionsBefore: string[] = [];
/** The topics the auto-bind tests made, which the later ones share a folder with. */
let autoTopicThreadId = 0;
let deferredTopicThreadId = 0;

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

/** The bot's messages in the topic after `afterMessageId` that announce the binding to `folder`, oldest first. */
function listBoundMessages(driver: TopicDriver, afterMessageId: number, folder: string): FakeTelegramMessage[] {
  return driver.listMessages().filter((message) => message.message_id > afterMessageId && message.text.includes(`Bound to \`${folder}\``));
}

/**
 * The operator asks `/bind` with no argument: the picker answers, and it comes after every send the bot queued before it
 * (the one first-come-first-served send gate), so nothing posted for an earlier bind can still be on its way. Resolves the picker.
 */
async function openPicker(driver: TopicDriver, boundFolder: string): Promise<FakeTelegramMessage> {
  return driver.sendAndAwaitReply('/bind', enDict['bind.current'].replace('{subdir}', boundFolder));
}

/** What a bind's welcome is expected to say besides the folder's facts. */
interface ExpectedWelcome {
  /** The bot bound the topic by itself (its name matches the folder). */
  isAutoBound?: boolean;
  /** The string keys of the other topics bound to the folder. */
  sharedWith?: string[];
}

/**
 * After a bind the topic shows ONE message announcing the folder — the full welcome with the start buttons, carrying the
 * auto-bound and shared-folder rows when they apply — and no trace of the short «Run /claude or /opencode» acknowledgement,
 * the 👋 greeting or a separate shared-folder warning. `afterMessageId` is the message that led to the bind.
 */
async function assertOneBoundMessage(driver: TopicDriver, afterMessageId: number, folder: string, expected: ExpectedWelcome = {}): Promise<FakeTelegramMessage> {
  const welcome = await driver.waitForMessage(`the welcome of ${folder}`, (message) => message.message_id > afterMessageId && message.text.includes(enDict['binding.welcome.start_prompt']));
  await openPicker(driver, folder);
  const boundMessages = listBoundMessages(driver, afterMessageId, folder);
  assert.deepEqual(boundMessages.map((message) => message.message_id), [welcome.message_id], `one bound-folder message, the welcome: ${boundMessages.map((message) => JSON.stringify(message.text)).join(' | ')}`);
  assert.deepEqual(driver.getKeyboardData(welcome), startButtonsData, 'the welcome carries the start buttons');

  assert.equal(welcome.text.includes(t('binding.welcome.auto_bound')), expected.isAutoBound === true, `the welcome says why the bot bound it only when the bot did: ${JSON.stringify(welcome.text)}`);
  const sharedWith = expected.sharedWith ?? [];
  if (sharedWith.length > 0) {
    const sharedRow = t('binding.welcome.shared', { threads: sharedWith.map((sharedKey) => `\`${sharedKey}\``).join(', ') });
    assert.ok(welcome.text.includes(sharedRow), `the welcome names the topics sharing the folder: ${JSON.stringify(welcome.text)}`);
  } else {
    assert.ok(!welcome.text.includes(sharedRowStart), 'a folder nobody else uses has no shared-folder row');
  }

  const sinceBind = driver.listMessages().filter((message) => message.message_id > afterMessageId);
  assert.ok(!sinceBind.some((message) => message.text.includes(shortAckTail)), 'no short acknowledgement lingers in the topic');
  assert.ok(!sinceBind.some((message) => message.text.includes(greetingMark)), 'no separate greeting in the topic');
  assert.deepEqual(sinceBind.filter((message) => message.message_id !== welcome.message_id && message.text.includes(sharedRowStart)), [], 'the shared-folder warning is no message of its own');
  return welcome;
}

/**
 * A non-admin makes a topic named `name`: the bot does not bind it, it sets the name aside for the admin's first message
 * there. Resolves once the bot logged that (counted, because an earlier topic left the same line in the output).
 */
async function makeTopicAsStranger(name: string): Promise<{ threadId: number; topic: TopicDriver }> {
  const occurrencesBefore = getCharness().output.split(nameCachedLogLine).length;
  const threadId = fakeTelegram.pushTopicCreated(name, stranger);
  await getCharness().waitFor(`the name of the non-admin's topic "${name}" set aside`, replyTimeoutMs, () => getCharness().output.split(nameCachedLogLine).length > occurrencesBefore);
  return { threadId, topic: new TopicDriver(fakeTelegram, getCharness, threadId, replyTimeoutMs) };
}

describe('/bind end to end: built charness, fake Bot API', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-bindwelcome-', Object.values(folders), getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    mainTopic = new TopicDriver(fakeTelegram, getCharness, mainThreadId, replyTimeoutMs);
    peerTopic = new TopicDriver(fakeTelegram, getCharness, peerThreadId, replyTimeoutMs);
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

  it('a typed /bind <folder> leaves one bound-folder message: the full welcome with its start buttons', async () => {
    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    const sentId = fakeTelegram.pushOperatorMessage(mainThreadId, `/bind ${folders.first}`);
    await assertOneBoundMessage(mainTopic, sentId, folders.first);
    assert.equal(getSessionLaunches(getLayout()).length, 0, 'binding starts no agent');
  });

  it('a folder tapped in the /bind picker leaves the same single message', async () => {
    const picker = await openPicker(mainTopic, folders.first);
    await mainTopic.tapAndAwaitAnswer(picker, mainTopic.getButtonData(picker, `📁 ${folders.second}`));
    await assertOneBoundMessage(mainTopic, picker.message_id, folders.second);
  });

  it('a folder another topic already uses: the same single welcome, with a row naming that topic', async () => {
    const sentId = fakeTelegram.pushOperatorMessage(peerThreadId, `/bind ${folders.second}`);
    await assertOneBoundMessage(peerTopic, sentId, folders.second, { sharedWith: [`${group.id}:${mainThreadId}`] });
  });

  it('«create new folder» makes the folder and binds it with the same single message', async () => {
    const picker = await openPicker(mainTopic, folders.second);
    const toast = await mainTopic.tapAndAwaitAnswer(picker, bindCreateFolderCallback);
    assert.equal(toast, enDict['bind.create_cb']);
    await mainTopic.waitForMessage('the folder-name prompt', (message) => message.message_id > picker.message_id && message.text === enDict['bind.create_prompt']);
    const sentId = fakeTelegram.pushOperatorMessage(mainThreadId, madeFolderName);
    await assertOneBoundMessage(mainTopic, sentId, madeFolderName);
    assert.ok(fs.statSync(path.join(getLayout().workRoot, madeFolderName)).isDirectory(), 'the folder exists under WORK_ROOT');
  });

  it('a folder that does not exist is refused: no welcome, and the topic keeps its binding', async () => {
    const sentId = fakeTelegram.pushOperatorMessage(mainThreadId, `/bind ${missingFolderName}`);
    const refusal = await mainTopic.waitForMessage('the refusal', (message) => message.message_id > sentId && message.text === t('bind.not_found', { subdir: missingFolderName, workRoot: getLayout().workRoot }));
    await openPicker(mainTopic, madeFolderName);
    assert.deepEqual(listBoundMessages(mainTopic, sentId, missingFolderName), [], 'nothing announces a binding that was refused');
    assert.ok(!mainTopic.listMessages().some((message) => message.message_id > refusal.message_id && message.text.includes(enDict['binding.welcome.start_prompt'])), 'no welcome after a refusal');
  });

  it('a topic an admin makes with the name of a folder is bound by the bot: ONE message, the welcome, which says why', async () => {
    const threadId = fakeTelegram.pushTopicCreated(folders.auto);
    autoTopicThreadId = threadId;
    const autoTopic = new TopicDriver(fakeTelegram, getCharness, threadId, replyTimeoutMs);
    await assertOneBoundMessage(autoTopic, threadId, folders.auto, { isAutoBound: true });
    assert.ok(!autoTopic.listMessages().some((message) => message.text === enDict['thread.welcome_pick']), 'no folder picker in a topic that was bound');
  });

  it('a topic a non-admin makes is not bound at once; the admin\'s first message there binds it, with the one welcome', async () => {
    const { threadId, topic: deferredTopic } = await makeTopicAsStranger(folders.deferred);
    deferredTopicThreadId = threadId;
    assert.deepEqual(deferredTopic.listMessages(), [], 'nothing is bound or offered for a non-admin\'s topic');

    const sentId = fakeTelegram.pushOperatorMessage(threadId, 'the first words in the new topic');
    await assertOneBoundMessage(deferredTopic, sentId, folders.deferred, { isAutoBound: true });
  });

  it('an admin-made topic named after a folder another topic uses: the welcome also names that topic', async () => {
    const threadId = fakeTelegram.pushTopicCreated(folders.auto);
    const sharingTopic = new TopicDriver(fakeTelegram, getCharness, threadId, replyTimeoutMs);
    await assertOneBoundMessage(sharingTopic, threadId, folders.auto, { isAutoBound: true, sharedWith: [`${group.id}:${autoTopicThreadId}`] });
  });

  it('a non-admin-made topic named after a folder another topic uses: the admin\'s first message binds it, the welcome also names that topic', async () => {
    const { threadId, topic: sharingTopic } = await makeTopicAsStranger(folders.deferred);
    const sentId = fakeTelegram.pushOperatorMessage(threadId, 'the first words in the sharing topic');
    await assertOneBoundMessage(sharingTopic, sentId, folders.deferred, { isAutoBound: true, sharedWith: [`${group.id}:${deferredTopicThreadId}`] });
  });

  it('a start phrase as the admin\'s first message in a non-admin-made topic binds it AND starts the agent: one welcome, one session', async () => {
    // Counted by the flag of a fresh start, not by `getSessionLaunches`: that one knows the stream-json launch only, and the
    // phrase starts whichever backend `ensureAgentSession` is given for the name `claude`.
    const listAgentStarts = () => getAllLaunches(getLayout()).filter((launch) => launch.argv.includes(freshSessionFlag));
    const startsBefore = listAgentStarts().length;
    const { threadId, topic: phraseTopic } = await makeTopicAsStranger(folders.phrase);
    const sentId = fakeTelegram.pushOperatorMessage(threadId, 'claude');
    await assertOneBoundMessage(phraseTopic, sentId, folders.phrase, { isAutoBound: true });
    await getCharness().waitFor('the agent the phrase asked for to start', agentStartTimeoutMs, () => listAgentStarts().length > startsBefore);
    assert.equal(listAgentStarts().length, startsBefore + 1, 'exactly one session started');
  });
});
