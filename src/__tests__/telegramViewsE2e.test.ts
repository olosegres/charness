/**
 * @description The Telegram views end to end, at PROCESS level (request/answer
 * plan S6–S9): the BUILT charness, started the way an isolated instance is
 * started (`scripts/run-isolated.sh` with its own HOME config), serving Telegram
 * only, against a fake Bot API on loopback (`telegramE2e/fakeTelegram.ts`) and
 * a fake `claude` (`jiraE2e/fakeClaude.ts`, via `CLAUDE_BIN`) that answers
 * through the real bot MCP. The test plays the operator in one forum topic.
 * One flow, in order:
 *
 *   isolation checked before the boot: a private tmux server in a private
 *   TMUX_TMPDIR, a temp HOME, DATA_DIR and WORK_ROOT, a PATH with no real agent
 *   → the topic is bound to a folder
 *   → `/verbosity`: the picker shows the detail row and the view row, ✓ on the
 *     defaults; a tap on a view button persists it and re-renders the picker
 *   → `/status` names the view; the typed forms set a view and reject a bad one
 *   → charness restarted: the view survives
 *
 * Nothing leaves the machine: the Bot API and the bot MCP are on loopback, the
 * agent is the fake. Everything the test starts is stopped in `after`.
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FakeTelegram, type FakeTelegramMessage } from './telegramE2e/fakeTelegram';
import {
  builtCliPath,
  createIsolatedInstanceLayout,
  exitOnSignal,
  getFreePort,
  getInstanceEnvNames,
  getProcessEnvNames,
  getTmuxEnv,
  getTmuxSocketDir,
  IsolatedCharness,
  isolatedLaunchEnvNames,
  listTmuxSessions,
  removeIsolatedInstanceSync,
  writeFakeClaudeLauncher,
  writeInstanceEnvFile,
  type IsolatedInstanceLayout,
} from './e2e/isolatedCharness';

/** The repo's placeholder group and a topic in it; the operator is its creator. */
const group = { id: -1001111111111, title: 'ExampleGroup' };
const topicThreadId = 111;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const projectFolder = 'proj';
/** The boot's last line before `bot.launch`, which resolves only when polling stops. */
const launchLine = 'Launching Telegraf bot (long polling';

const bootTimeoutMs = 60 * 1000;
/** A command's reply: a poll round trip and the paced send. */
const replyTimeoutMs = 20 * 1000;
const stopTimeoutMs = 20 * 1000;
const flowMarginMs = 60 * 1000;
const flowTimeoutMs = 2 * bootTimeoutMs + 10 * replyTimeoutMs + 2 * stopTimeoutMs + flowMarginMs;

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let defaultTmuxSessionsBefore: string[] = [];

function getLayout(): IsolatedInstanceLayout {
  if (!layout) throw new Error('the instance layout is not created yet');
  return layout;
}

function getCharness(): IsolatedCharness {
  if (!charness) throw new Error('charness is not started yet');
  return charness;
}

/** The bot's messages in the test topic. */
function listTopicMessages(): FakeTelegramMessage[] {
  return fakeTelegram.listBotMessages(topicThreadId);
}

/** Wait for a bot message in the topic that `check` accepts, newest first; resolves it. */
async function waitForTopicMessage(description: string, check: (message: FakeTelegramMessage) => boolean): Promise<FakeTelegramMessage> {
  let found: FakeTelegramMessage | undefined;
  await getCharness().waitFor(description, replyTimeoutMs, () => {
    found = [...listTopicMessages()].reverse().find(check);
    return found !== undefined;
  });
  if (!found) throw new Error(`no message for ${description}`);
  return found;
}

/** The operator writes in the topic and the bot's next reply containing `expectedText` is awaited. */
async function sendAndAwaitReply(text: string, expectedText: string): Promise<FakeTelegramMessage> {
  const sentAfterId = fakeTelegram.pushOperatorMessage(topicThreadId, text);
  return waitForTopicMessage(`a reply to "${text}" with "${expectedText}"`, (message) => message.message_id > sentAfterId && message.text.includes(expectedText));
}

/** The button labels of a picker message, row by row. */
function getKeyboardLabels(message: FakeTelegramMessage): string[][] {
  return (message.reply_markup?.inline_keyboard ?? []).map((row) => row.map((button) => button.text));
}

function getKeyboardData(message: FakeTelegramMessage): string[][] {
  return (message.reply_markup?.inline_keyboard ?? []).map((row) => row.map((button) => button.callback_data));
}

/** Ready = the boot reached its launch AND this run's polling reached the fake. */
async function startCharness(): Promise<void> {
  charness ??= new IsolatedCharness(getLayout());
  const pollsBefore = fakeTelegram.listCalls('getUpdates').length;
  await charness.start(bootTimeoutMs, (runOutput) => runOutput.includes(launchLine) && fakeTelegram.listCalls('getUpdates').length > pollsBefore);
}

/** The `displayPrefs` record of the test topic as persisted — what a restart reads. */
function readPersistedTopicPrefs(): Record<string, string> | undefined {
  const state = JSON.parse(fs.readFileSync(path.join(getLayout().dataDir, 'state.json'), 'utf8')) as { displayPrefs?: Record<string, Record<string, string>> };
  return state.displayPrefs?.[`${group.id}:${topicThreadId}`];
}

function removeInstanceSync(): void {
  removeIsolatedInstanceSync(layout, charness);
}

describe('Telegram views end to end: built charness, fake Bot API, fake claude (S6–S9)', { timeout: flowTimeoutMs }, () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-tg-', [projectFolder]);
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    const apiRoot = await fakeTelegram.start();
    const claudeBin = writeFakeClaudeLauncher(layout);
    writeInstanceEnvFile(layout, {
      TELEGRAM_BOT_TOKEN: fakeBotToken,
      TELEGRAM_API_ROOT: apiRoot,
      ALLOWED_GROUP_ID: group.id.toString(),
      CHAT_MODE: 'group',
      DATA_DIR: layout.dataDir,
      WORK_ROOT: layout.workRoot,
      TMUX_TMPDIR: layout.tmuxTmpDir,
      CLAUDE_BIN: claudeBin,
      // A free port nothing listens on: the boot's OpenCode pre-start finds no server and no binary, and gives up.
      OPENCODE_URL: `http://127.0.0.1:${await getFreePort()}`,
      SCHEDULER_MCP_PORT: (await getFreePort()).toString(),
    });
  });

  after(async () => {
    await charness?.stop();
    removeInstanceSync();
    await fakeTelegram?.stop();
    process.off('exit', removeInstanceSync);
    process.off('SIGINT', exitOnSignal);
    process.off('SIGTERM', exitOnSignal);
  });

  it('isolation holds before the first boot', () => {
    const instance = getLayout();
    assert.deepEqual(fs.readdirSync(instance.tmuxTmpDir), [], 'no tmux server of the instance is running yet');
    const realHome = fs.realpathSync(os.homedir());
    for (const dir of [instance.instanceHome, instance.dataDir, instance.workRoot, instance.tmuxTmpDir]) {
      assert.ok(!dir.startsWith(`${realHome}${path.sep}`), `${dir} is outside the user's HOME`);
    }
    const envNames = getInstanceEnvNames(instance);
    assert.ok(envNames.includes('TELEGRAM_API_ROOT'), 'the Bot API is the fake');
    for (const name of ['TMUX_TMPDIR', 'DATA_DIR', 'WORK_ROOT', 'CLAUDE_BIN']) assert.ok(envNames.includes(name), `${name} is set`);
  });

  it('boots Telegram-only against the fake Bot API, started with nothing but run-isolated.sh\'s variables', async () => {
    await startCharness();
    const pid = getCharness().pid;
    const envNames = pid === undefined ? null : getProcessEnvNames(pid);
    if (envNames !== null) assert.deepEqual([...envNames].sort(), [...isolatedLaunchEnvNames].sort());
    assert.ok(fakeTelegram.listCalls('getMe').length > 0, 'the client reached the fake');
    assert.ok(fakeTelegram.listCalls('setMyCommands').length > 0, 'the commands menu was set on the fake');
  });

  it('the topic is bound to a folder and gets its pinned status banner', async () => {
    await sendAndAwaitReply(`/bind ${projectFolder}`, `Bound to \`${projectFolder}\``);
    await getCharness().waitFor('the status banner pin', replyTimeoutMs, () => fakeTelegram.listPinnedMessageIds().length === 1);
    // The banner's pin is silent — it is bookkeeping, not a notification.
    assert.deepEqual(fakeTelegram.pinEvents.map((event) => event.kind), ['pin']);
    assert.equal(fakeTelegram.pinEvents[0].isSilent, true);
  });

  // ── S6 — the view setting in /verbosity ──────────────────────────────

  it('/verbosity shows the detail row and the view row, ✓ on minimal and on the full stream', async () => {
    const picker = await sendAndAwaitReply('/verbosity', 'view: Full stream');
    assert.match(picker.text, /detail: minimal/);
    assert.deepEqual(getKeyboardLabels(picker), [
      ['minimal ✓', 'short', 'full'],
      ['Full stream ✓', 'Stream + answers', 'Answers only'],
    ]);
    assert.deepEqual(getKeyboardData(picker), [
      ['verb_minimal', 'verb_short', 'verb_full'],
      ['view_stream', 'view_streamAnswers', 'view_answers'],
    ]);
  });

  it('a tap on «Answers only» persists the view, answers the tap and moves the ✓', async () => {
    const picker = listTopicMessages().find((message) => message.text.includes('view: Full stream'));
    assert.ok(picker, 'the picker is in the topic');
    fakeTelegram.pushCallback(picker.message_id, 'view_answers');
    await getCharness().waitFor('the view tap answered', replyTimeoutMs, () => fakeTelegram.callbackAnswers.includes('This topic shows: Answers only'));
    await getCharness().waitFor('the picker re-rendered', replyTimeoutMs, () => getKeyboardLabels(picker)[1]?.[2] === 'Answers only ✓');
    assert.deepEqual(getKeyboardLabels(picker), [
      ['minimal ✓', 'short', 'full'],
      ['Full stream', 'Stream + answers', 'Answers only ✓'],
    ]);
    await getCharness().waitFor('the view persisted', replyTimeoutMs, () => readPersistedTopicPrefs()?.view === 'answers');
  });

  it('a detail tap keeps the view row: the picker re-renders both rows', async () => {
    const picker = listTopicMessages().find((message) => message.text.includes('view: Full stream'));
    assert.ok(picker, 'the picker is in the topic');
    fakeTelegram.pushCallback(picker.message_id, 'verb_full');
    await getCharness().waitFor('the detail tap re-rendered', replyTimeoutMs, () => getKeyboardLabels(picker)[0]?.[2] === 'full ✓');
    assert.deepEqual(getKeyboardLabels(picker), [
      ['minimal', 'short', 'full ✓'],
      ['Full stream', 'Stream + answers', 'Answers only ✓'],
    ]);
  });

  it('/status names the view', async () => {
    const status = await sendAndAwaitReply('/status', 'View: Answers only');
    assert.match(status.text, /Folder: proj/);
  });

  it('the typed form sets a view and rejects an unknown word with both vocabularies', async () => {
    await sendAndAwaitReply('/verbosity stream_answers', '✅ This topic shows: Stream + answers');
    await getCharness().waitFor('the typed view persisted', replyTimeoutMs, () => readPersistedTopicPrefs()?.view === 'streamAnswers');
    const rejected = await sendAndAwaitReply('/verbosity everything', 'is not valid');
    assert.match(rejected.text, /Detail levels: minimal, short, full/);
    assert.match(rejected.text, /Views: stream, stream_answers, answers/);
    // A fresh picker reflects both: the detail set by the earlier tap and the typed view.
    const picker = await sendAndAwaitReply('/verbosity', 'view: Stream + answers');
    assert.deepEqual(getKeyboardLabels(picker)[1], ['Full stream', 'Stream + answers ✓', 'Answers only']);
  });

  it('a restart keeps the view', async () => {
    await getCharness().stop();
    await startCharness();
    await sendAndAwaitReply('/status', 'View: Stream + answers');
  });

  it('the instance runs its tmux server in its private TMUX_TMPDIR; nothing of it runs on the default tmux server', () => {
    const instance = getLayout();
    // No agent was started yet, so the instance's server may not exist.
    const instanceSessions = new Set(listTmuxSessions([], getTmuxEnv(instance.tmuxTmpDir)));
    const defaultSessionsNow = listTmuxSessions([]);
    assert.deepEqual(defaultSessionsNow.filter((name) => instanceSessions.has(name)), []);
    assert.deepEqual(defaultSessionsNow.filter((name) => !defaultTmuxSessionsBefore.includes(name) && name.includes(group.id.toString())), []);
  });
});
