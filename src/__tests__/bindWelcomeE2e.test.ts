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
 *     next to the one welcome
 *   → the /bind picker is spent by a bind: the message is deleted (its «not bound, pick from the list» text is no longer true),
 *     and a second tap landing while the first is still binding gets a short «already bound», no second welcome
 *   → «Leave current dir» removes the picker it was tapped on as well
 *   → the shared-folder row names a topic by the name the bot saw it made with, else by its link; a name only a non-admin
 *     gave is never written onto a binding (the agent's preamble would carry it) — not even when the bot binds the topic by
 *     that name: it stores the folder's own name then
 *   → a tap whose toast comes too late still binds, and leaves the picker neither held nor usable twice
 *   → «create new folder» tapped and then a folder tapped (or «Leave current dir»): the folder-name wait is over, the next plain
 *     message is nobody's folder name; a spent picker refuses «create new folder» and «Leave current dir» as well, and a
 *     double tap on «Leave current dir» unbinds once
 *   → a picker Telegram will not delete loses its buttons instead
 *   → EVERY bind or leave of a topic deletes ALL the /bind pickers the bot still has open there (each plain message in an
 *     unbound topic posts a new one), whichever way it happens — a tap, a typed `/bind <folder>`, the bot's own auto-bind, a
 *     leave — and the «send the folder name» prompt of «create new folder» goes with a bind, but stays while a name is refused
 *   → a topic an admin made with a name no folder has yet remembers it: once the bot has made such a folder, the admin's next
 *     message there binds the topic
 *   → the sweep of the open pickers is ONE bulk delete the welcome and an agent start never wait for, and a picker Telegram will
 *     not delete (the bulk call fails) is tried one by one and loses its buttons
 *   → the shared-folder row names only topics of the SAME chat; topics of other chats are a count, never a name, a link or an id
 *   → a typed folder name followed at once by a tap on the same picker: the name binds, the tap is told the picker was used
 *   → a toast refused as too late is survived on every «picker was already used» answer; a picker the person deleted by hand
 *     is not asked to lose its buttons
 *   → every picker the sweep takes is claimed at once, so a tap on one the sweep could not delete (or strip, past its bound) is
 *     refused; a refused bulk delete costs one keyboard edit per picker, at most a bounded number of them, no delete each
 *   → a tap on a folder with a typed «create new folder» name right behind it: bound to the tapped folder, no folder made
 *   → a rebind or a leave strips the buttons of the topic's previous welcome: its ▶️ Claude / ▶️ OpenCode / 📋 Resume act on the
 *     topic's CURRENT folder, whatever the old welcome says.
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
import { getSessionLaunches, readPersistedState, restartCharnessWithState, startCharnessOnInstance } from './e2e/fallbackFlowKit';
import { bindCreateFolderCallback, bindLeaveCurrentCallback } from '../connectors/telegram/bindPicker';
import { keyboardStripsPerSweepLimit } from '../connectors/telegram/openBindMessages';
import type { BindingData } from '../state';
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
const folders = {
  first: 'bind-first', second: 'bind-second', auto: 'bind-auto', deferred: 'bind-deferred', phrase: 'bind-phrase', phantom: 'bind-phantom', named: 'bind-named', quiet: 'bind-quiet',
  late: 'bind-late', waiting: 'bind-waiting', leaving: 'bind-leaving', undeletable: 'bind-undeletable',
  sweepTyped: 'bind-sweep-typed', sweepTap: 'bind-sweep-tap', sweepLeave: 'bind-sweep-leave', sweepAuto: 'bind-sweep-auto',
  sweepSlow: 'bind-sweep-slow', gone: 'bind-gone',
} as const;
/** A folder no instance folder list has when the topics that wait for it are made: the bot makes it during the flow. */
const laterFolderName = 'bind-later';
/** The folder a typed name makes right before a tap on the picker it was asked on lands. */
const typedBeforeTapFolderName = 'bind-typed-before-tap';
/** The name typed right behind a tap on a folder: it must make no folder. */
const tapThenNameFolderName = 'bind-tap-then-name';
/** Folders the welcome steps bind to by a typed `/bind` (it finds them on disk; they need not be in a picker). */
const welcomeStepFolders = { first: 'bind-welcome-first', second: 'bind-welcome-second', leaving: 'bind-welcome-leaving' } as const;
/**
 * How many `/bind` picker claims the instance keeps (production: 200), fewer than the pickers the sweep step opens: the sweep's
 * claims alone push each other out, so a picker the sweep leaves with its buttons stays refused only if it is held for good.
 */
const bindPickerClaimLimitInFlow = 4;
/** A folder other chats' bindings sit on, made on disk by the step that needs it (a typed `/bind` finds it without the picker). */
const sharedAcrossChatsFolderName = 'bind-shared';
/** The instance also keeps the bindings of other chats: a second group's topic and the operator's private chat. */
const foreignGroupKey = '-1002222222222:5';
const privateChatKey = '424242:0';
const foreignTopicName = 'Secret topic of another group';
const privateTopicName = 'Private chat thread';
/** What the bot logs when a toast reaches Telegram too late and the handler goes on regardless. */
const lateToastLogLine = '[callback] the tap was answered after its query expired';
/** The agent must start long before a response the flow holds back is released: this is how long the flow waits to see it. */
const startWhileSweepHeldTimeoutMs = 20 * 1000;
/** The id the group has in `t.me/c/<id>/…` links: the Bot API id without its `-100`. */
const groupLinkId = '1111111111';
/** Names that match no folder: an admin's topic with one is offered the picker, a non-admin's waits for the admin's bind. */
const adminTopicName = 'Scratch notes';
const strangerTopicName = 'Quiet notes <b>';
/** Spellings of `folders.deferred` the bot's name match accepts (case and separators drift) that a non-admin may give a topic. */
const strangerLooseNames = { first: 'BIND_Deferred', second: 'bind deferred' } as const;
/** Plain messages of the operator — no start phrase, no command — that must be nobody's folder name; one per step, so a failed step leaves nothing for the next. */
const plainNotes = { afterBind: 'noted-after-bind', afterLeave: 'noted-after-leave' } as const;
/** An admin's topic named after `folders.auto` the loose way the bot's name match allows; shown by this name in a shared-folder row. */
const autoTopicName = 'Bind_Auto';
const madeFolderName = 'bind-made';
const missingFolderName = 'bind-missing';
/** The tail of the short acknowledgement and of the greeting the welcome made redundant. */
const shortAckTail = 'Run /claude or /opencode';
const greetingMark = '👋';
/** What the one welcome's keyboard offers: start Claude / OpenCode, resume. */
const startButtonsData = [['agent_claude', 'agent_opencode'], ['open_sessions']];
/** The start of the welcome's shared-folder row, up to where the topics are named. */
const sharedRowStart = enDict['binding.welcome.shared'].split('{threads}')[0];
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

/** How the shared-folder row writes a topic it knows by name. */
function byName(topicName: string): string {
  return `\`${topicName}\``;
}

/** How the shared-folder row writes a topic it knows by nothing but its id: the link that opens the topic. */
function byLink(threadId: number): string {
  return `https://t.me/c/${groupLinkId}/${threadId}`;
}

/** The binding the bot keeps for a topic of the group, read from `state.json`. */
function readBinding(threadId: number): BindingData | undefined {
  return readPersistedState(getLayout()).bindings?.[`${group.id}:${threadId}`];
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
  /** The folder was there before the person asked to create it («create new folder» with an existing folder's name). */
  isExistingFolder?: boolean;
  /** How the row writes each other topic bound to the folder: {@link byName} or {@link byLink}. */
  sharedWith?: string[];
  /** The row's list written out as the welcome shows it — for a list that also counts topics of other chats. */
  sharedWithText?: string;
  /** An agent starts next to the bind, and its own «ready in <folder>» notice names the folder too. */
  isAgentStarting?: boolean;
}

/** Resolves once a pinned message of the topic names `folder`: the status banner every bind pins, which is no announcement of the bind. */
async function waitForStatusBanner(driver: TopicDriver, folder: string): Promise<void> {
  await getCharness().waitFor(`the status banner of ${folder} pinned`, replyTimeoutMs, () => {
    const pinnedIds = new Set(fakeTelegram.listPinnedMessageIds());
    return driver.listMessages().some((message) => pinnedIds.has(message.message_id) && message.text.includes(folder));
  });
}

/**
 * After a bind the topic shows ONE message announcing the folder — the full welcome with the start buttons, carrying the
 * auto-bound, existing-folder and shared-folder rows when they apply — and nothing else that names the folder (the pinned
 * status banner and the picker the check itself asks for aside): no short «Run /claude or /opencode» acknowledgement, no 👋
 * greeting, no separate warning for a shared or an existing folder. `afterMessageId` is the message that led to the bind.
 */
async function assertOneBoundMessage(driver: TopicDriver, afterMessageId: number, folder: string, expected: ExpectedWelcome = {}): Promise<FakeTelegramMessage> {
  const welcome = await driver.waitForMessage(`the welcome of ${folder}`, (message) => message.message_id > afterMessageId && message.text.includes(enDict['binding.welcome.start_prompt']));
  const barrier = await openPicker(driver, folder);
  await waitForStatusBanner(driver, folder);
  const boundMessages = listBoundMessages(driver, afterMessageId, folder);
  assert.deepEqual(boundMessages.map((message) => message.message_id), [welcome.message_id], `one bound-folder message, the welcome: ${boundMessages.map((message) => JSON.stringify(message.text)).join(' | ')}`);
  assert.deepEqual(driver.getKeyboardData(welcome), startButtonsData, 'the welcome carries the start buttons');

  assert.equal(welcome.text.includes(t('binding.welcome.auto_bound')), expected.isAutoBound === true, `the welcome says why the bot bound it only when the bot did: ${JSON.stringify(welcome.text)}`);
  assert.equal(welcome.text.includes(t('binding.welcome.existed')), expected.isExistingFolder === true, `the welcome says the folder was there already only when it was: ${JSON.stringify(welcome.text)}`);
  const sharedWith = expected.sharedWith ?? [];
  if (expected.sharedWithText !== undefined || sharedWith.length > 0) {
    const sharedRow = t('binding.welcome.shared', { threads: expected.sharedWithText ?? sharedWith.join(', ') });
    assert.ok(welcome.text.includes(sharedRow), `the welcome names the topics sharing the folder: ${JSON.stringify(welcome.text)}`);
  } else {
    assert.ok(!welcome.text.includes(sharedRowStart), 'a folder nobody else uses has no shared-folder row');
  }

  const sinceBind = driver.listMessages().filter((message) => message.message_id > afterMessageId);
  assert.ok(!sinceBind.some((message) => message.text.includes(shortAckTail)), 'no short acknowledgement lingers in the topic');
  assert.ok(!sinceBind.some((message) => message.text.includes(greetingMark)), 'no separate greeting in the topic');
  if (!expected.isAgentStarting) {
    const pinnedIds = new Set(fakeTelegram.listPinnedMessageIds());
    const otherMentions = sinceBind.filter((message) => message.message_id !== welcome.message_id && message.message_id !== barrier.message_id && !pinnedIds.has(message.message_id) && message.text.includes(folder));
    assert.deepEqual(otherMentions.map((message) => message.text), [], 'nothing but the welcome (and the status banner) names the folder: no note of its own for a shared or an existing one');
  }
  return welcome;
}

/** The /bind picker is spent by a bind: the message itself is deleted, since its text («not bound — pick from the list») is no longer true. */
async function waitForPickerDeleted(picker: FakeTelegramMessage): Promise<void> {
  await getCharness().waitFor('the picker deleted', replyTimeoutMs, () => fakeTelegram.getMessage(picker.message_id)?.isDeleted === true);
}

/**
 * An admin makes a topic named `name` (offered the picker), and the operator then writes `plainNotes.length` plain messages
 * in it: each is answered with a NEW picker of its own. Resolves the topic and every picker it holds, oldest first.
 */
async function openTopicWithStalePickers(name: string, plainNotes: string[]): Promise<{ threadId: number; topic: TopicDriver; pickers: FakeTelegramMessage[] }> {
  const { threadId, topic, picker } = await openFreshPicker(name);
  const pickers = [picker];
  for (const note of plainNotes) {
    const noteId = fakeTelegram.pushOperatorMessage(threadId, note);
    pickers.push(await topic.waitForMessage(`the picker answering "${note}"`, (message) => message.message_id > noteId && message.text === enDict['thread.no_binding']));
  }
  assert.equal(new Set(pickers.map((message) => message.message_id)).size, plainNotes.length + 1, 'every plain message posted a picker of its own');
  return { threadId, topic, pickers };
}

/** An admin makes a topic named `name`, which matches no folder: it is offered the folder picker. Resolves the topic and its picker. */
async function openFreshPicker(name: string): Promise<{ threadId: number; topic: TopicDriver; picker: FakeTelegramMessage }> {
  const threadId = fakeTelegram.pushTopicCreated(name);
  const topic = new TopicDriver(fakeTelegram, getCharness, threadId, replyTimeoutMs);
  const picker = await topic.waitForMessage('the folder picker', (message) => message.text === enDict['thread.welcome_pick']);
  return { threadId, topic, picker };
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
      ...getTelegramFlowTestTimingsEnv({ bindPickerClaimLimit: bindPickerClaimLimitInFlow }),
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

  it('a folder tapped in the /bind picker leaves the same single message, and the picker is gone', async () => {
    const picker = await openPicker(mainTopic, folders.first);
    assert.ok(mainTopic.getKeyboardData(picker).flat().length > 0, 'the picker has its buttons until a folder is bound through it');
    await mainTopic.tapAndAwaitAnswer(picker, mainTopic.getButtonData(picker, `📁 ${folders.second}`));
    await assertOneBoundMessage(mainTopic, picker.message_id, folders.second);
    await waitForPickerDeleted(picker);
  });

  it('a folder another topic already uses: the same single welcome, with a row naming that topic by its link', async () => {
    const sentId = fakeTelegram.pushOperatorMessage(peerThreadId, `/bind ${folders.second}`);
    await assertOneBoundMessage(peerTopic, sentId, folders.second, { sharedWith: [byLink(mainThreadId)] });
  });

  it('«create new folder» makes the folder and binds it with the same single message; the picker works until then and is deleted after', async () => {
    const picker = await openPicker(mainTopic, folders.second);
    const toast = await mainTopic.tapAndAwaitAnswer(picker, bindCreateFolderCallback);
    assert.equal(toast, enDict['bind.create_cb']);
    const prompt = await mainTopic.waitForMessage('the folder-name prompt', (message) => message.message_id > picker.message_id && message.text === enDict['bind.create_prompt']);
    assert.ok(mainTopic.getKeyboardData(picker).flat().length > 0, 'the picker keeps its buttons while the folder name is awaited');
    // A refused name binds nothing: the question stays, with the picker.
    const refusedId = fakeTelegram.pushOperatorMessage(mainThreadId, '../escape');
    await mainTopic.waitForMessage('the refusal', (message) => message.message_id > refusedId && message.text === enDict['bind.create_separator']);
    assert.notEqual(fakeTelegram.getMessage(prompt.message_id)?.isDeleted, true, 'a refused name keeps the question it answers');
    const sentId = fakeTelegram.pushOperatorMessage(mainThreadId, madeFolderName);
    await assertOneBoundMessage(mainTopic, sentId, madeFolderName);
    assert.ok(fs.statSync(path.join(getLayout().workRoot, madeFolderName)).isDirectory(), 'the folder exists under WORK_ROOT');
    await waitForPickerDeleted(picker);
    await waitForPickerDeleted(prompt);
  });

  it('«create new folder» with the name of a folder that exists binds to it: ONE message, the welcome, which says it was there already', async () => {
    const picker = await openPicker(mainTopic, madeFolderName);
    await mainTopic.tapAndAwaitAnswer(picker, bindCreateFolderCallback);
    const prompt = await mainTopic.waitForMessage('the folder-name prompt', (message) => message.message_id > picker.message_id && message.text === enDict['bind.create_prompt']);
    const sentId = fakeTelegram.pushOperatorMessage(mainThreadId, folders.first);
    await assertOneBoundMessage(mainTopic, sentId, folders.first, { isExistingFolder: true });
    await waitForPickerDeleted(picker);
    await waitForPickerDeleted(prompt);
  });

  it('a tap on a folder that is gone is refused and the picker keeps its buttons: only a bind consumes it', async () => {
    const picker = await openPicker(mainTopic, folders.first);
    fs.rmSync(path.join(getLayout().workRoot, folders.phantom), { recursive: true });
    await mainTopic.tapAndAwaitAnswer(picker, mainTopic.getButtonData(picker, `📁 ${folders.phantom}`));
    await mainTopic.waitForMessage('the refusal', (message) => message.message_id > picker.message_id && message.text === t('bind.not_found', { subdir: folders.phantom, workRoot: getLayout().workRoot }));
    // The barrier first: a keyboard edit queued behind the refusal would otherwise still be on its way when the check looks.
    await openPicker(mainTopic, folders.first);
    assert.ok(mainTopic.getKeyboardData(picker).flat().length > 0, 'a refused pick leaves the picker usable');
    assert.notEqual(fakeTelegram.getMessage(picker.message_id)?.isDeleted, true, 'and in the topic');
  });

  it('a folder that does not exist is refused: no welcome, and the topic keeps its binding', async () => {
    const sentId = fakeTelegram.pushOperatorMessage(mainThreadId, `/bind ${missingFolderName}`);
    const refusal = await mainTopic.waitForMessage('the refusal', (message) => message.message_id > sentId && message.text === t('bind.not_found', { subdir: missingFolderName, workRoot: getLayout().workRoot }));
    await openPicker(mainTopic, folders.first);
    assert.deepEqual(listBoundMessages(mainTopic, sentId, missingFolderName), [], 'nothing announces a binding that was refused');
    assert.ok(!mainTopic.listMessages().some((message) => message.message_id > refusal.message_id && message.text.includes(enDict['binding.welcome.start_prompt'])), 'no welcome after a refusal');
  });

  it('two taps on the same folder of the picker, back to back: bound once, ONE welcome, the second tap is told «This picker was already used.»', async () => {
    const picker = await openPicker(mainTopic, folders.first);
    const folderButton = mainTopic.getButtonData(picker, `📁 ${folders.second}`);
    const answersBefore = fakeTelegram.callbackAnswers.length;
    fakeTelegram.pushCallback(picker.message_id, folderButton);
    fakeTelegram.pushCallback(picker.message_id, folderButton);
    await getCharness().waitFor('both taps answered', replyTimeoutMs, () => fakeTelegram.callbackAnswers.length >= answersBefore + 2);
    assert.deepEqual([...fakeTelegram.callbackAnswers.slice(answersBefore)].sort(), [t('cb.binding_to', { subdir: folders.second }), t('cb.bind_picker_used')].sort(), 'one tap binds, the other is told so');
    // The peer topic is on that folder too (an earlier step), and is known by nothing but its link.
    await assertOneBoundMessage(mainTopic, picker.message_id, folders.second, { sharedWith: [byLink(peerThreadId)] });
    await waitForPickerDeleted(picker);
  });

  it('a topic an admin makes with the name of a folder is bound by the bot: ONE message, the welcome, which says why', async () => {
    const threadId = fakeTelegram.pushTopicCreated(autoTopicName);
    const autoTopic = new TopicDriver(fakeTelegram, getCharness, threadId, replyTimeoutMs);
    await assertOneBoundMessage(autoTopic, threadId, folders.auto, { isAutoBound: true });
    assert.ok(!autoTopic.listMessages().some((message) => message.text === enDict['thread.welcome_pick']), 'no folder picker in a topic that was bound');
  });

  it('a topic a non-admin makes is not bound at once; the admin\'s first message there binds it, with the one welcome — and the binding keeps the FOLDER\'s name, not the member\'s spelling', async () => {
    const { threadId, topic: deferredTopic } = await makeTopicAsStranger(strangerLooseNames.first);
    assert.deepEqual(deferredTopic.listMessages(), [], 'nothing is bound or offered for a non-admin\'s topic');

    const sentId = fakeTelegram.pushOperatorMessage(threadId, 'the first words in the new topic');
    await assertOneBoundMessage(deferredTopic, sentId, folders.deferred, { isAutoBound: true });
    await getCharness().waitFor('the binding persisted', replyTimeoutMs, () => readBinding(threadId) !== undefined);
    assert.equal(readBinding(threadId)?.topicName, folders.deferred, 'what the member typed is not stored; the folder it matched is');
  });

  it('an admin-made topic named after a folder another topic uses: the welcome also names that topic', async () => {
    const threadId = fakeTelegram.pushTopicCreated(folders.auto);
    const sharingTopic = new TopicDriver(fakeTelegram, getCharness, threadId, replyTimeoutMs);
    await assertOneBoundMessage(sharingTopic, threadId, folders.auto, { isAutoBound: true, sharedWith: [byName(autoTopicName)] });
  });

  it('a non-admin-made topic named after a folder another topic uses: the admin\'s first message binds it, the welcome also names that topic', async () => {
    const { threadId, topic: sharingTopic } = await makeTopicAsStranger(strangerLooseNames.second);
    const sentId = fakeTelegram.pushOperatorMessage(threadId, 'the first words in the sharing topic');
    await assertOneBoundMessage(sharingTopic, sentId, folders.deferred, { isAutoBound: true, sharedWith: [byName(folders.deferred)] });
  });

  it('a start phrase as the admin\'s first message in a non-admin-made topic binds it AND starts the agent: one welcome, one session', async () => {
    // The phrase opens the topic's backend, json-stream by default (as `/claude` does), which is a stream-json launch.
    const listAgentStarts = () => getSessionLaunches(getLayout());
    const startsBefore = listAgentStarts().length;
    const { threadId, topic: phraseTopic } = await makeTopicAsStranger(folders.phrase);
    const sentId = fakeTelegram.pushOperatorMessage(threadId, 'claude');
    await assertOneBoundMessage(phraseTopic, sentId, folders.phrase, { isAutoBound: true, isAgentStarting: true });
    await getCharness().waitFor('the agent the phrase asked for to start', agentStartTimeoutMs, () => listAgentStarts().length > startsBefore);
    assert.equal(listAgentStarts().length, startsBefore + 1, 'exactly one session started');
  });

  it('a topic an admin makes with a name that matches no folder is offered the picker; the bind through it keeps the name, and the next topic on that folder names it', async () => {
    const threadId = fakeTelegram.pushTopicCreated(adminTopicName);
    const namedTopic = new TopicDriver(fakeTelegram, getCharness, threadId, replyTimeoutMs);
    const picker = await namedTopic.waitForMessage('the folder picker', (message) => message.text === enDict['thread.welcome_pick']);
    // A plain message first: it matches no folder either, and answering it must not cost the topic the name it was made with.
    const plainId = fakeTelegram.pushOperatorMessage(threadId, 'where am I');
    await namedTopic.waitForMessage('the answer to the plain message', (message) => message.message_id > plainId && message.text === enDict['thread.no_binding']);
    await namedTopic.tapAndAwaitAnswer(picker, namedTopic.getButtonData(picker, `📁 ${folders.named}`));
    await assertOneBoundMessage(namedTopic, picker.message_id, folders.named);
    await getCharness().waitFor('the name kept on the binding', replyTimeoutMs, () => readBinding(threadId)?.topicName === adminTopicName);

    const sentId = fakeTelegram.pushOperatorMessage(peerThreadId, `/bind ${folders.named}`);
    await assertOneBoundMessage(peerTopic, sentId, folders.named, { sharedWith: [byName(adminTopicName)] });
  });

  it('a topic a non-admin made with a name that matches no folder: the admin\'s /bind keeps NO name on it (the agent\'s preamble would carry it), and the next topic on that folder gets its link', async () => {
    const { threadId, topic: quietTopic } = await makeTopicAsStranger(strangerTopicName);
    const sentId = fakeTelegram.pushOperatorMessage(threadId, `/bind ${folders.quiet}`);
    await assertOneBoundMessage(quietTopic, sentId, folders.quiet);
    await getCharness().waitFor('the binding persisted', replyTimeoutMs, () => readBinding(threadId) !== undefined);
    assert.equal(readBinding(threadId)?.topicName, undefined, 'a name only a non-admin gave is not written onto the binding');

    const secondSentId = fakeTelegram.pushOperatorMessage(mainThreadId, `/bind ${folders.quiet}`);
    const welcome = await assertOneBoundMessage(mainTopic, secondSentId, folders.quiet, { sharedWith: [byLink(threadId)] });
    assert.ok(!welcome.text.includes('Quiet notes'), 'nor does the row show it');
  });

  it('«Leave current dir» unbinds the topic and deletes the picker it was tapped on: its «currently bound» text is no longer true', async () => {
    const picker = await openPicker(peerTopic, folders.named);
    await peerTopic.tapAndAwaitAnswer(picker, bindLeaveCurrentCallback);
    await peerTopic.waitForMessage('the unbound notice', (message) => message.message_id > picker.message_id && message.text === enDict['thread.unbound']);
    await waitForPickerDeleted(picker);
    await getCharness().waitFor('the binding gone', replyTimeoutMs, () => readBinding(peerThreadId) === undefined);
  });

  it('a tap whose toast comes too late still binds the topic, once: the claim on the picker is neither lost nor left held for nothing', async () => {
    const { topic: lateTopic, picker } = await openFreshPicker('Late tap');
    const folderButton = lateTopic.getButtonData(picker, `📁 ${folders.late}`);
    fakeTelegram.isCallbackAnswerExpired = true;
    try {
      fakeTelegram.pushCallback(picker.message_id, folderButton);
      await assertOneBoundMessage(lateTopic, picker.message_id, folders.late);
    } finally {
      fakeTelegram.isCallbackAnswerExpired = false;
    }
    await waitForPickerDeleted(picker);
    assert.equal(await lateTopic.tapAndAwaitAnswer(picker, folderButton), t('cb.bind_picker_used'), 'a retap on the spent picker is told so');

    // The «already used» answer itself may come too late as well: that is survived like any other late toast, not left to the error handler.
    const lateLogsBefore = getCharness().output.split(lateToastLogLine).length;
    fakeTelegram.isCallbackAnswerExpired = true;
    try {
      fakeTelegram.pushCallback(picker.message_id, folderButton);
      await getCharness().waitFor('the late «already used» answer survived', replyTimeoutMs, () => getCharness().output.split(lateToastLogLine).length > lateLogsBefore);
    } finally {
      fakeTelegram.isCallbackAnswerExpired = false;
    }
  });

  it('«create new folder» tapped and then a folder tapped: bound, and the next plain message is nobody\'s folder name; the spent picker refuses «create new folder» and «Leave current dir»', async () => {
    const { threadId, topic: waitingTopic, picker } = await openFreshPicker('Waiting for a name');
    await waitingTopic.tapAndAwaitAnswer(picker, bindCreateFolderCallback);
    const prompt = await waitingTopic.waitForMessage('the folder-name prompt', (message) => message.message_id > picker.message_id && message.text === enDict['bind.create_prompt']);
    await waitingTopic.tapAndAwaitAnswer(picker, waitingTopic.getButtonData(picker, `📁 ${folders.waiting}`));
    // No command in between, not even a barrier: a command ends the folder-name wait by itself and would hide the very bug.
    const welcome = await waitingTopic.waitForMessage('the welcome', (message) => message.message_id > picker.message_id && message.text.includes(enDict['binding.welcome.start_prompt']));
    await waitForPickerDeleted(picker);
    await waitForPickerDeleted(prompt);

    const plainId = fakeTelegram.pushOperatorMessage(threadId, plainNotes.afterBind);
    await waitingTopic.waitForMessage('the idle hint for the plain message', (message) => message.message_id > plainId && message.text === t('thread.no_agent_with_binding', { subdir: folders.waiting }));
    assert.ok(!fs.existsSync(path.join(getLayout().workRoot, plainNotes.afterBind)), 'the plain message was not taken for a folder name');
    assert.equal(readBinding(threadId)?.subdir, folders.waiting, 'and the topic keeps its folder');
    assert.deepEqual(listBoundMessages(waitingTopic, picker.message_id, folders.waiting).map((message) => message.message_id), [welcome.message_id], 'one bound-folder message');

    // The picker is spent: neither of its other buttons does anything any more.
    const messagesBefore = waitingTopic.listMessages().length;
    assert.equal(await waitingTopic.tapAndAwaitAnswer(picker, bindCreateFolderCallback), t('cb.bind_picker_used'));
    assert.equal(await waitingTopic.tapAndAwaitAnswer(picker, bindLeaveCurrentCallback), t('cb.bind_picker_used'));
    // The same two refusals, with their toasts too late: survived, not thrown at the error handler.
    const lateLogsBefore = getCharness().output.split(lateToastLogLine).length;
    fakeTelegram.isCallbackAnswerExpired = true;
    try {
      fakeTelegram.pushCallback(picker.message_id, bindCreateFolderCallback);
      fakeTelegram.pushCallback(picker.message_id, bindLeaveCurrentCallback);
      await getCharness().waitFor('both late refusals survived', replyTimeoutMs, () => getCharness().output.split(lateToastLogLine).length >= lateLogsBefore + 2);
    } finally {
      fakeTelegram.isCallbackAnswerExpired = false;
    }
    await openPicker(waitingTopic, folders.waiting);
    assert.equal(readBinding(threadId)?.subdir, folders.waiting, '«Leave current dir» on a spent picker leaves nothing');
    assert.equal(waitingTopic.listMessages().filter((message) => message.text === enDict['bind.create_prompt']).length, 0, 'the first prompt went with the bind, and «create new folder» on the spent picker asked for no second name');
    assert.equal(waitingTopic.listMessages().length, messagesBefore + 1, 'nothing was posted but the barrier\'s own answer');
  });

  it('«create new folder» tapped and then «Leave current dir»: the topic is unbound, and the next plain message is nobody\'s folder name', async () => {
    const { threadId, topic: leavingTopic } = await openFreshPicker('Leaving');
    const sentId = fakeTelegram.pushOperatorMessage(threadId, `/bind ${folders.leaving}`);
    await assertOneBoundMessage(leavingTopic, sentId, folders.leaving);
    const picker = await openPicker(leavingTopic, folders.leaving);
    await leavingTopic.tapAndAwaitAnswer(picker, bindCreateFolderCallback);
    await leavingTopic.waitForMessage('the folder-name prompt', (message) => message.message_id > picker.message_id && message.text === enDict['bind.create_prompt']);
    await leavingTopic.tapAndAwaitAnswer(picker, bindLeaveCurrentCallback);
    await leavingTopic.waitForMessage('the unbound notice', (message) => message.message_id > picker.message_id && message.text === enDict['thread.unbound']);

    const plainId = fakeTelegram.pushOperatorMessage(threadId, plainNotes.afterLeave);
    await leavingTopic.waitForMessage('the picker offered to an unbound topic', (message) => message.message_id > plainId && message.text === enDict['thread.no_binding']);
    assert.ok(!fs.existsSync(path.join(getLayout().workRoot, plainNotes.afterLeave)), 'the plain message was not taken for a folder name');
  });

  it('two taps on «Leave current dir», back to back: unbound once, the second tap is told the picker was used', async () => {
    const { threadId, topic: leavingTopic } = await openFreshPicker('Leaving twice');
    const sentId = fakeTelegram.pushOperatorMessage(threadId, `/bind ${folders.leaving}`);
    await assertOneBoundMessage(leavingTopic, sentId, folders.leaving);
    const picker = await openPicker(leavingTopic, folders.leaving);
    const answersBefore = fakeTelegram.callbackAnswers.length;
    fakeTelegram.pushCallback(picker.message_id, bindLeaveCurrentCallback);
    fakeTelegram.pushCallback(picker.message_id, bindLeaveCurrentCallback);
    await getCharness().waitFor('both taps answered', replyTimeoutMs, () => fakeTelegram.callbackAnswers.length >= answersBefore + 2);
    assert.deepEqual([...fakeTelegram.callbackAnswers.slice(answersBefore)].sort(), ['', t('cb.bind_picker_used')], 'one tap leaves, the other is told so');
    await leavingTopic.waitForMessage('the unbound notice', (message) => message.message_id > picker.message_id && message.text === enDict['thread.unbound']);
    await waitForPickerDeleted(picker);
    await leavingTopic.sendAndAwaitReply('/bind', enDict['bind.current_none']);
    assert.equal(leavingTopic.listMessages().filter((message) => message.message_id > picker.message_id && message.text === enDict['thread.unbound']).length, 1, 'one «Binding cleared.», not two');
  });

  it('a picker Telegram will not delete (too old) loses its buttons instead, so a stale tap cannot rebind the topic', async () => {
    const { topic: undeletableTopic, picker } = await openFreshPicker('Undeletable');
    const folderButton = undeletableTopic.getButtonData(picker, `📁 ${folders.undeletable}`);
    fakeTelegram.isMessageDeletionRefused = true;
    try {
      await undeletableTopic.tapAndAwaitAnswer(picker, folderButton);
      await assertOneBoundMessage(undeletableTopic, picker.message_id, folders.undeletable);
      await getCharness().waitFor('the picker\'s buttons removed', replyTimeoutMs, () => undeletableTopic.getKeyboardData(picker).flat().length === 0);
    } finally {
      fakeTelegram.isMessageDeletionRefused = false;
    }
    assert.notEqual(fakeTelegram.getMessage(picker.message_id)?.isDeleted, true, 'the message itself stayed');
  });

  it('every plain message in an unbound topic posts a picker of its own; a typed /bind <folder> deletes ALL of them', async () => {
    const { threadId, topic: sweptTopic, pickers } = await openTopicWithStalePickers('Sweep typed', ['a first plain note', 'a second plain note']);
    const sentId = fakeTelegram.pushOperatorMessage(threadId, `/bind ${folders.sweepTyped}`);
    await assertOneBoundMessage(sweptTopic, sentId, folders.sweepTyped);
    for (const picker of pickers) await waitForPickerDeleted(picker);
  });

  it('a tap on ONE of several open pickers binds the topic and deletes all of them, so none is left to rebind it', async () => {
    const { topic: sweptTopic, pickers } = await openTopicWithStalePickers('Sweep tap', ['a first plain note', 'a second plain note']);
    const tapped = pickers[1];
    await sweptTopic.tapAndAwaitAnswer(tapped, sweptTopic.getButtonData(tapped, `📁 ${folders.sweepTap}`));
    await assertOneBoundMessage(sweptTopic, tapped.message_id, folders.sweepTap);
    for (const picker of pickers) await waitForPickerDeleted(picker);
  });

  it('«Leave current dir» on one of several open pickers unbinds the topic and deletes all of them', async () => {
    const { threadId, topic: sweptTopic } = await openFreshPicker('Sweep leave');
    const sentId = fakeTelegram.pushOperatorMessage(threadId, `/bind ${folders.sweepLeave}`);
    await assertOneBoundMessage(sweptTopic, sentId, folders.sweepLeave);
    const first = await openPicker(sweptTopic, folders.sweepLeave);
    const second = await openPicker(sweptTopic, folders.sweepLeave);
    await sweptTopic.tapAndAwaitAnswer(second, bindLeaveCurrentCallback);
    await sweptTopic.waitForMessage('the unbound notice', (message) => message.message_id > second.message_id && message.text === enDict['thread.unbound']);
    await waitForPickerDeleted(first);
    await waitForPickerDeleted(second);
  });

  it('the bot\'s own auto-bind (a non-admin\'s topic, bound by the admin\'s first plain message) deletes the picker an earlier /bind left open', async () => {
    const { threadId, topic: autoTopic } = await makeTopicAsStranger('Bind Sweep Auto');
    const picker = await autoTopic.sendAndAwaitReply('/bind', enDict['bind.current_none']);
    const plainId = fakeTelegram.pushOperatorMessage(threadId, 'the first words after /bind');
    await assertOneBoundMessage(autoTopic, plainId, folders.sweepAuto, { isAutoBound: true });
    await waitForPickerDeleted(picker);
  });

  it('a topic an admin made with a name no folder has yet remembers it: once the bot has made that folder, the admin\'s next message there binds the topic', async () => {
    const { threadId, topic: waitingTopic } = await openFreshPicker('Bind Later');
    // The folder appears the way a person makes one: another topic\'s «create new folder».
    const { threadId: makerThreadId, topic: makerTopic, picker } = await openFreshPicker('Folder maker');
    await makerTopic.tapAndAwaitAnswer(picker, bindCreateFolderCallback);
    await makerTopic.waitForMessage('the folder-name prompt', (message) => message.message_id > picker.message_id && message.text === enDict['bind.create_prompt']);
    const makerSentId = fakeTelegram.pushOperatorMessage(makerThreadId, laterFolderName);
    await assertOneBoundMessage(makerTopic, makerSentId, laterFolderName);

    const sentId = fakeTelegram.pushOperatorMessage(threadId, 'is the folder there now?');
    await assertOneBoundMessage(waitingTopic, sentId, laterFolderName, { isAutoBound: true, sharedWith: [byName('Folder maker')] });
  });

  it('an agent start after an auto-bind does not wait for the sweep of the open pickers: they go in ONE bulk call, and the response to it may take as long as it likes', async () => {
    const { threadId, topic: sweptTopic } = await makeTopicAsStranger('Bind Sweep Slow');
    const pickers: FakeTelegramMessage[] = [];
    for (let count = 0; count < 3; count += 1) pickers.push(await sweptTopic.sendAndAwaitReply('/bind', enDict['bind.current_none']));
    assert.equal(new Set(pickers.map((picker) => picker.message_id)).size, 3, 'three pickers are open');

    // Whatever call deletes them, its response is held back until the flow says so: a start that waited for it never begins.
    let releaseDeletes: () => void = () => {};
    const deletesReleased = new Promise<void>((resolve) => { releaseDeletes = resolve; });
    fakeTelegram.holdNextResponse('deleteMessages', deletesReleased);
    fakeTelegram.holdNextResponse('deleteMessage', deletesReleased);
    const bulkCallsBefore = fakeTelegram.listCalls('deleteMessages').length;
    const launchesBefore = getSessionLaunches(getLayout()).length;
    const sentId = fakeTelegram.pushOperatorMessage(threadId, 'claude');
    try {
      await getCharness().waitFor('the agent to start while the sweep\'s response is still held', startWhileSweepHeldTimeoutMs, () => getSessionLaunches(getLayout()).length > launchesBefore);
    } finally {
      releaseDeletes();
    }
    for (const picker of pickers) await waitForPickerDeleted(picker);
    const bulkCalls = fakeTelegram.listCalls('deleteMessages').slice(bulkCallsBefore);
    assert.equal(bulkCalls.length, 1, 'ONE bulk call, not a delete per picker');
    assert.deepEqual(bulkCalls[0].payload.message_ids, pickers.map((picker) => picker.message_id), 'with every open picker in it, oldest first');
    await assertOneBoundMessage(sweptTopic, sentId, folders.sweepSlow, { isAutoBound: true, isAgentStarting: true });
  });

  it('pickers Telegram will not delete (the bulk call is refused) are tried one by one and each loses its buttons: no stale tap can rebind the topic', async () => {
    const { threadId, topic: stuckTopic, pickers } = await openTopicWithStalePickers('Sweep refused', ['a first plain note', 'a second plain note']);
    fakeTelegram.isMessageDeletionRefused = true;
    try {
      const sentId = fakeTelegram.pushOperatorMessage(threadId, `/bind ${folders.gone}`);
      await assertOneBoundMessage(stuckTopic, sentId, folders.gone);
      for (const picker of pickers) await getCharness().waitFor('the picker\'s buttons removed', replyTimeoutMs, () => stuckTopic.getKeyboardData(picker).flat().length === 0);
    } finally {
      fakeTelegram.isMessageDeletionRefused = false;
    }
    for (const picker of pickers) assert.notEqual(fakeTelegram.getMessage(picker.message_id)?.isDeleted, true, 'the messages themselves stayed');
  });

  it('a tap on a picker the person had already deleted by hand binds the topic, and does not try to strip buttons from a message that is gone', async () => {
    const { topic: goneTopic, picker } = await openFreshPicker('Gone picker');
    const folderButton = goneTopic.getButtonData(picker, `📁 ${folders.sweepTap}`);
    const pickerMessage = fakeTelegram.getMessage(picker.message_id);
    assert.ok(pickerMessage, 'the picker is a message of the fake');
    pickerMessage.isDeleted = true; // deleted by hand, with its keyboard still on screen when the tap lands
    const editsOfPicker = () => fakeTelegram.listCalls('editMessageReplyMarkup').filter((call) => call.payload.message_id === picker.message_id);
    const editsBefore = editsOfPicker().length;
    fakeTelegram.pushCallback(picker.message_id, folderButton);
    await goneTopic.waitForMessage('the welcome', (message) => message.message_id > picker.message_id && message.text.includes(enDict['binding.welcome.start_prompt']));
    await goneTopic.sendAndAwaitReply('/bind', enDict['bind.current'].replace('{subdir}', folders.sweepTap));
    assert.equal(editsOfPicker().length, editsBefore, 'no edit of a message that is gone');
    assert.ok(!getCharness().output.includes('[bind] keyboard edit failed'), 'and nothing logged about one');
  });

  it('a typed folder name with a tap on the same picker right behind it: the name binds, the tap is told the picker was used — ONE welcome, no rebind to the tapped folder', async () => {
    const { threadId, topic: raceTopic, picker } = await openFreshPicker('Name then tap');
    await raceTopic.tapAndAwaitAnswer(picker, bindCreateFolderCallback);
    await raceTopic.waitForMessage('the folder-name prompt', (message) => message.message_id > picker.message_id && message.text === enDict['bind.create_prompt']);
    const answersBefore = fakeTelegram.callbackAnswers.length;
    const sentId = fakeTelegram.pushOperatorMessage(threadId, typedBeforeTapFolderName);
    fakeTelegram.pushCallback(picker.message_id, raceTopic.getButtonData(picker, `📁 ${folders.first}`));
    await getCharness().waitFor('the tap answered', replyTimeoutMs, () => fakeTelegram.callbackAnswers.length > answersBefore);
    assert.equal(fakeTelegram.callbackAnswers[answersBefore], t('cb.bind_picker_used'), 'the picker was spent by the typed name');
    await assertOneBoundMessage(raceTopic, sentId, typedBeforeTapFolderName);
    assert.deepEqual(listBoundMessages(raceTopic, sentId, folders.first), [], 'the tap bound nothing');
    assert.equal(readBinding(threadId)?.subdir, typedBeforeTapFolderName, 'the topic stays on the folder the name made');
  });

  it('the shared-folder row names only topics of the SAME chat: those of other chats are a count — never a name, a link or an id', async () => {
    fs.mkdirSync(path.join(getLayout().workRoot, sharedAcrossChatsFolderName));
    // The instance keeps other chats' bindings too (a second group, the operator's private chat); both are on the folder, named.
    const now = new Date().toISOString();
    charness = await restartCharnessWithState(getLayout(), fakeTelegram, getCharness(), (persisted) => {
      persisted.bindings = {
        ...persisted.bindings,
        [foreignGroupKey]: { subdir: sharedAcrossChatsFolderName, createdAt: now, topicName: foreignTopicName },
        [privateChatKey]: { subdir: sharedAcrossChatsFolderName, createdAt: now, topicName: privateTopicName },
      };
    });
    const more = t('binding.welcome.sharedMore', { count: 2 });

    const firstSentId = fakeTelegram.pushOperatorMessage(peerThreadId, `/bind ${sharedAcrossChatsFolderName}`);
    const firstWelcome = await assertOneBoundMessage(peerTopic, firstSentId, sharedAcrossChatsFolderName, { sharedWithText: more });
    // A topic of THIS chat is named (here: by its link, it has no name) next to the count.
    const secondSentId = fakeTelegram.pushOperatorMessage(mainThreadId, `/bind ${sharedAcrossChatsFolderName}`);
    const secondWelcome = await assertOneBoundMessage(mainTopic, secondSentId, sharedAcrossChatsFolderName, { sharedWithText: `${byLink(peerThreadId)}, ${more}` });
    for (const welcome of [firstWelcome, secondWelcome]) {
      for (const secret of [foreignTopicName, privateTopicName, '2222222222', '#5', '424242']) {
        assert.ok(!welcome.text.includes(secret), `nothing of another chat shows in the row: "${secret}" in ${JSON.stringify(welcome.text)}`);
      }
    }
  });

  it('a tap on a folder with a typed «create new folder» name right behind it: the topic is bound to the tapped folder, and the name makes no folder', async () => {
    const { threadId, topic: tapFirstTopic, picker } = await openFreshPicker('Tap then name');
    await tapFirstTopic.tapAndAwaitAnswer(picker, bindCreateFolderCallback);
    await tapFirstTopic.waitForMessage('the folder-name prompt', (message) => message.message_id > picker.message_id && message.text === enDict['bind.create_prompt']);
    fakeTelegram.pushCallback(picker.message_id, tapFirstTopic.getButtonData(picker, `📁 ${folders.auto}`));
    const nameId = fakeTelegram.pushOperatorMessage(threadId, tapThenNameFolderName);
    // The name is answered either way — as an ordinary message of a bound topic, or, were it still taken for a name while the
    // tap holds the picker, with «this picker was already used» — and never by a bind to the name.
    await tapFirstTopic.waitForMessage('the answer to the typed name', (message) => message.message_id > nameId
      && (message.text === t('thread.no_agent_with_binding', { subdir: folders.auto }) || message.text === t('cb.bind_picker_used')));
    assert.ok(!fs.existsSync(path.join(getLayout().workRoot, tapThenNameFolderName)), 'the name made no (empty) folder');
    assert.equal(readBinding(threadId)?.subdir, folders.auto, 'the topic stays on the tapped folder');
    assert.deepEqual(listBoundMessages(tapFirstTopic, picker.message_id, tapThenNameFolderName), [], 'nothing announces a bind to the name');
  });

  it('every picker the sweep takes is claimed at once: when a refused bulk delete leaves some with their buttons (the strip is bounded), a tap on them is refused even past the limit of the claim list — and the fallback costs no delete per picker', async () => {
    const notes = Array.from({ length: keyboardStripsPerSweepLimit + 2 }, (_, index) => `plain note ${index + 1}`);
    const { threadId, topic: manyTopic, pickers } = await openTopicWithStalePickers('Sweep many', notes);
    const pastTheBound = pickers.slice(0, pickers.length - keyboardStripsPerSweepLimit);
    assert.ok(pastTheBound.length >= 2, 'the step has pickers past the strip bound');
    assert.ok(pickers.length > bindPickerClaimLimitInFlow, 'and more pickers than the instance\'s claim list holds');
    const pastTheBoundButtons = pastTheBound.map((picker) => manyTopic.getButtonData(picker, `📁 ${folders.auto}`));
    const singleDeletesBefore = fakeTelegram.listCalls('deleteMessage').length;
    fakeTelegram.isMessageDeletionRefused = true;
    try {
      fs.mkdirSync(path.join(getLayout().workRoot, welcomeStepFolders.first), { recursive: true });
      const sentId = fakeTelegram.pushOperatorMessage(threadId, `/bind ${welcomeStepFolders.first}`);
      await manyTopic.waitForMessage('the welcome', (message) => message.message_id > sentId && message.text.includes(enDict['binding.welcome.start_prompt']));
      const newest = pickers.slice(-keyboardStripsPerSweepLimit);
      for (const picker of newest) await getCharness().waitFor('a picker\'s buttons stripped', replyTimeoutMs, () => manyTopic.getKeyboardData(picker).flat().length === 0);
    } finally {
      fakeTelegram.isMessageDeletionRefused = false;
    }
    assert.equal(fakeTelegram.listCalls('deleteMessage').length, singleDeletesBefore, 'no delete per picker: the fallback strips, it does not delete');
    // …but a tap on one is refused: it was claimed with the rest — and held for good, since the instance's claim list (4 here) is
    // smaller than the sweep, so the newer claims pushed these out of it.
    for (const [index, picker] of pastTheBound.entries()) {
      assert.ok(manyTopic.getKeyboardData(picker).flat().length > 0, 'a picker past the bound keeps its buttons');
      assert.equal(await manyTopic.tapAndAwaitAnswer(picker, pastTheBoundButtons[index]), t('cb.bind_picker_used'));
    }
    assert.equal(readBinding(threadId)?.subdir, welcomeStepFolders.first, 'the stale taps rebound nothing');
  });

  it('a rebind strips the buttons of the topic\'s previous welcome: its ▶️ Claude / ▶️ OpenCode / 📋 Resume would act on the NEW folder', async () => {
    const { threadId, topic: rebindTopic } = await openFreshPicker('Welcome rebind');
    fs.mkdirSync(path.join(getLayout().workRoot, welcomeStepFolders.second), { recursive: true });
    const firstId = fakeTelegram.pushOperatorMessage(threadId, `/bind ${welcomeStepFolders.first}`);
    const firstWelcome = await assertOneBoundMessage(rebindTopic, firstId, welcomeStepFolders.first, { sharedWith: [byName('Sweep many')] });
    assert.deepEqual(rebindTopic.getKeyboardData(firstWelcome), startButtonsData, 'the first welcome has its buttons while it is the current one');

    const secondId = fakeTelegram.pushOperatorMessage(threadId, `/bind ${welcomeStepFolders.second}`);
    const secondWelcome = await assertOneBoundMessage(rebindTopic, secondId, welcomeStepFolders.second);
    await getCharness().waitFor('the old welcome\'s buttons removed', replyTimeoutMs, () => rebindTopic.getKeyboardData(firstWelcome).flat().length === 0);
    assert.deepEqual(rebindTopic.getKeyboardData(secondWelcome), startButtonsData, 'the new welcome keeps its buttons');
    assert.notEqual(fakeTelegram.getMessage(firstWelcome.message_id)?.isDeleted, true, 'the old welcome stays as history: its facts are true of its time');
  });

  it('«Leave current dir» strips the buttons of the topic\'s welcome too: after a leave they have no folder to act on', async () => {
    const { threadId, topic: leaveTopic } = await openFreshPicker('Welcome leave');
    fs.mkdirSync(path.join(getLayout().workRoot, welcomeStepFolders.leaving), { recursive: true });
    const sentId = fakeTelegram.pushOperatorMessage(threadId, `/bind ${welcomeStepFolders.leaving}`);
    const welcome = await assertOneBoundMessage(leaveTopic, sentId, welcomeStepFolders.leaving);
    assert.deepEqual(leaveTopic.getKeyboardData(welcome), startButtonsData);
    const picker = await openPicker(leaveTopic, welcomeStepFolders.leaving);
    await leaveTopic.tapAndAwaitAnswer(picker, bindLeaveCurrentCallback);
    await getCharness().waitFor('the welcome\'s buttons removed', replyTimeoutMs, () => leaveTopic.getKeyboardData(welcome).flat().length === 0);
  });
});
