/**
 * @description What a topic shows after `/bind` picks a folder, at PROCESS level: the BUILT charness started the way an
 * isolated instance is (`scripts/run-isolated.sh`) against the fake Bot API (`telegramE2e/fakeTelegram.ts`). A bind used to
 * post TWO bound-folder messages back to back — a short «Bound to … Run /claude or /opencode» acknowledgement and then the
 * full welcome (the folder's facts and the start buttons) — and the short one stayed in the topic for good. One flow, in order:
 *
 *   boot → a typed `/bind <folder>` leaves ONE bound-folder message: the full welcome, with its start buttons
 *   → a folder tapped in the `/bind` picker: the same single message
 *   → a folder another topic already uses: its warning (about the shared folder, which the welcome does not say) is
 *     kept, next to the same single welcome
 *   → the picker's «create new folder»: the folder is made on disk and bound, the same single message
 *   → a folder that does not exist: the refusal is shown, no welcome, the topic keeps its binding.
 *
 * What the unit tests cover instead: the picker's layout (`bindKeyboard.test.ts`), the folder-name rules (`folderName.test.ts`).
 *
 * Nothing leaves the machine: the Bot API is on loopback and the agent is a fake. Everything the test starts is stopped
 * in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram, type FakeTelegramMessage } from './telegramE2e/fakeTelegram';
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
import { getSessionLaunches, startCharnessOnInstance } from './e2e/fallbackFlowKit';
import { enDict } from '../i18n/en';
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';

const mainThreadId = 191;
const peerThreadId = 192;
const folders = { first: 'bind-first', second: 'bind-second' } as const;
const madeFolderName = 'bind-made';
const missingFolderName = 'bind-missing';
/** The callback data of `/bind`'s «create new folder» button (the wire id the picker is matched by). */
const bindCreateFolderData = 'bindCreateFolder';
/** The tail of the short acknowledgement the welcome made redundant. */
const shortAckTail = 'Run /claude or /opencode';
/** What the one welcome's keyboard offers: start Claude / OpenCode, resume. */
const startButtonsData = [['agent_claude', 'agent_opencode'], ['open_sessions']];
const replyTimeoutMs = 20 * 1000;

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

/** The callback data of the picker button with this caption (the captions of a picker are unique). */
function getButtonData(driver: TopicDriver, message: FakeTelegramMessage, label: string): string {
  const labels = driver.getKeyboardLabels(message).flat();
  const data = driver.getKeyboardData(message).flat();
  const index = labels.indexOf(label);
  if (index < 0) throw new Error(`no button «${label}» in ${labels.join(' | ')}`);
  return data[index];
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

/**
 * After a bind the topic shows ONE message announcing the folder — the full welcome with the start buttons — and no
 * trace of the short «Run /claude or /opencode» acknowledgement. `afterMessageId` is the operator message that bound it.
 */
async function assertOneBoundMessage(driver: TopicDriver, afterMessageId: number, folder: string): Promise<void> {
  const welcome = await driver.waitForMessage(`the welcome of ${folder}`, (message) => message.message_id > afterMessageId && message.text.includes(enDict['binding.welcome.start_prompt']));
  await openPicker(driver, folder);
  const boundMessages = listBoundMessages(driver, afterMessageId, folder);
  assert.deepEqual(boundMessages.map((message) => message.message_id), [welcome.message_id], `one bound-folder message, the welcome: ${boundMessages.map((message) => JSON.stringify(message.text)).join(' | ')}`);
  assert.deepEqual(driver.getKeyboardData(welcome), startButtonsData, 'the welcome carries the start buttons');
  assert.ok(!driver.listMessages().some((message) => message.message_id > afterMessageId && message.text.includes(shortAckTail)), 'no short acknowledgement lingers in the topic');
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
    await mainTopic.tapAndAwaitAnswer(picker, getButtonData(mainTopic, picker, `📁 ${folders.second}`));
    await assertOneBoundMessage(mainTopic, picker.message_id, folders.second);
  });

  it('a folder another topic already uses: its warning stays, next to the same single welcome', async () => {
    const sentId = fakeTelegram.pushOperatorMessage(peerThreadId, `/bind ${folders.second}`);
    await assertOneBoundMessage(peerTopic, sentId, folders.second);
    const warnings = peerTopic.listMessages().filter((message) => message.message_id > sentId && message.text.includes('already used by threads'));
    assert.equal(warnings.length, 1, 'the shared-folder warning is posted once');
    assert.ok(warnings[0].text.includes(`${group.id}:${mainThreadId}`), 'and names the topic that uses the folder');
  });

  it('«create new folder» makes the folder and binds it with the same single message', async () => {
    const picker = await openPicker(mainTopic, folders.second);
    const toast = await mainTopic.tapAndAwaitAnswer(picker, bindCreateFolderData);
    assert.equal(toast, enDict['bind.create_cb']);
    await mainTopic.waitForMessage('the folder-name prompt', (message) => message.message_id > picker.message_id && message.text === enDict['bind.create_prompt']);
    const sentId = fakeTelegram.pushOperatorMessage(mainThreadId, madeFolderName);
    await assertOneBoundMessage(mainTopic, sentId, madeFolderName);
    assert.ok(fs.statSync(path.join(getLayout().workRoot, madeFolderName)).isDirectory(), 'the folder exists under WORK_ROOT');
  });

  it('a folder that does not exist is refused: no welcome, and the topic keeps its binding', async () => {
    const sentId = fakeTelegram.pushOperatorMessage(mainThreadId, `/bind ${missingFolderName}`);
    const refusal = await mainTopic.waitForMessage('the refusal', (message) => message.message_id > sentId && message.text.includes(`Folder \`${missingFolderName}\` not found`));
    await openPicker(mainTopic, madeFolderName);
    assert.deepEqual(listBoundMessages(mainTopic, sentId, missingFolderName), [], 'nothing announces a binding that was refused');
    assert.ok(!mainTopic.listMessages().some((message) => message.message_id > refusal.message_id && message.text.includes(enDict['binding.welcome.start_prompt'])), 'no welcome after a refusal');
  });
});
