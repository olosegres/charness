/**
 * @description The cap on tracker task agents (`/task_agents`) at PROCESS level: the BUILT charness started the way an isolated
 * instance is (`scripts/run-isolated.sh`) against the fake Bot API of `telegramE2e/fakeTelegram.ts`. The test plays the
 * operator in General and in a bound topic. One flow, in order:
 *
 *   boot → a topic bound to a folder
 *   → the bot publishes the command in its menu, and General's /help names it (its underscore escaped, the text is Markdown)
 *   → General's screen: 5 by the built-in default, the picker 5 / 10 / 15 / 20 / 30 / No limit with the 5 marked, nothing
 *     written by looking, no line about running agents (this instance serves no tracker)
 *   → settings.json's `taskAgents.maxConcurrent: 3` seeds an instance whose General never chose: the screen says 3 «from
 *     settings.json», marked on no button (3 is not a picker number)
 *   → a tap on 20: the picker turns into its confirmation (keyboard gone), the value is in state.json, and General's own value
 *     beats the file from then on ( «set in General» )
 *   → a number typed after the command (12) applies at once — on no button, so no ✓ — and so do `off` and `0`; a number over the
 *     bound, a decimal and a word are refused with the range and change nothing
 *   → a topic: the screen reports the value in force and says it is changed in General, with no picker; a number typed there is
 *     refused
 *   → a restart keeps General's value
 *
 * That the cap holds Jira hand-overs back is `jiraTaskAgentSlotsE2e.test.ts`. Nothing leaves the machine: the Bot API is on
 * loopback. Everything the test starts is stopped in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram, generalTopicThreadId } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import {
  builtCliPath,
  createIsolatedInstanceLayout,
  exitOnSignal,
  getFlowDeadlineMs,
  getFreeFixedPort,
  getFreePort,
  isolatedBaselineSettings,
  IsolatedCharness,
  listTmuxSessions,
  removeIsolatedInstanceSync,
  writeFakeClaudeLauncher,
  writeInstanceEnvFile,
  type IsolatedInstanceLayout,
} from './e2e/isolatedCharness';
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';
import { taskAgentsMaxConcurrentUpperBound } from '../trackers/taskAgentLimit';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const topicThreadId = 111;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const projectFolder = 'first';
const launchLine = 'Launching Telegraf bot (long polling';
const screenTitlePrefix = '🧵 Task agents working at once, for the whole bot: ';
const invalidArgumentReply = `⚠️ Send a whole number from 0 to ${taskAgentsMaxConcurrentUpperBound} (0 or off — no limit).`;

const bootTimeoutMs = 60 * 1000;
const replyTimeoutMs = 20 * 1000;

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let general: TopicDriver;
let topic: TopicDriver;
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

/** `settings.json` sits beside the instance's env file. */
function getSettingsFilePath(): string {
  return path.join(path.dirname(getLayout().envFile), 'settings.json');
}

/** A hand edit the way an editor saves it: a new file renamed over the old, so the bot's change stamp moves. */
function writeSettingsFileByHand(settings: object): void {
  const tempPath = `${getSettingsFilePath()}.by-hand`;
  fs.writeFileSync(tempPath, `${JSON.stringify(settings)}\n`);
  fs.renameSync(tempPath, getSettingsFilePath());
}

/** General's value as `state.json` holds it; `undefined` while General never chose. */
function readPersistedLimit(): number | undefined {
  const persisted: { taskAgentsMaxConcurrent?: number } = JSON.parse(fs.readFileSync(path.join(getLayout().dataDir, 'state.json'), 'utf8'));
  return persisted.taskAgentsMaxConcurrent;
}

/** `state.json` is saved a moment after the change: wait for the state the step expects instead of racing the save. */
async function waitForPersistedLimit(expected: number): Promise<void> {
  await getCharness().waitFor(`state.json to hold ${expected}`, replyTimeoutMs, () => readPersistedLimit() === expected);
}

/** The command names in the menu the bot published (`setMyCommands`), across all its calls. */
function listMenuCommandNames(): string[] {
  return fakeTelegram.listCalls('setMyCommands').flatMap((call) => {
    const { commands } = call.payload;
    return Array.isArray(commands) ? commands.flatMap((entry) => (typeof entry?.command === 'string' ? [entry.command] : [])) : [];
  });
}

/** Start charness on the instance and wait for its first poll to reach the fake Bot API. */
async function startCharness(): Promise<void> {
  charness = new IsolatedCharness(getLayout());
  const pollsBefore = fakeTelegram.listCalls('getUpdates').length;
  await charness.start(bootTimeoutMs, (runOutput) => runOutput.includes(launchLine) && fakeTelegram.listCalls('getUpdates').length > pollsBefore);
}

describe('The cap on task agents (/task_agents) end to end: built charness, fake Bot API', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-tka-', [projectFolder], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    general = new TopicDriver(fakeTelegram, getCharness, generalTopicThreadId, replyTimeoutMs);
    topic = new TopicDriver(fakeTelegram, getCharness, topicThreadId, replyTimeoutMs);
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

  it('boots Telegram-only against the fake Bot API and binds a topic to a folder', async () => {
    await startCharness();
    await topic.sendAndAwaitReply(`/bind ${projectFolder}`, `Bound to \`${projectFolder}\``);
  });

  it('the command is in the bot\'s menu, and General\'s /help names it with its underscore escaped', async () => {
    assert.ok(listMenuCommandNames().includes('task_agents'), 'the menu lists /task_agents');
    const helpMessage = await general.sendAndAwaitReply('/help', 'Commands in General');
    assert.ok(helpMessage.text.includes('/task\\_agents — how many tracker task agents may work at once'), helpMessage.text);
    assert.ok(helpMessage.text.includes('/bot\\_skills — '), 'and the line that was already there, escaped the same way');
    const sendCall = fakeTelegram.listCalls('sendMessage').find((call) => typeof call.payload.text === 'string' && call.payload.text.includes('Commands in General'));
    assert.equal(sendCall?.payload.parse_mode, 'Markdown', 'sent as legacy Markdown, where an unescaped underscore would be eaten or fail the whole message');
  });

  it('General\'s screen says 5 by the built-in default and offers the picker with the 5 marked — looking writes nothing, and no agents line (no tracker is served)', async () => {
    const screen = await general.sendAndAwaitReply('/task_agents', `${screenTitlePrefix}5 — the built-in default`);
    assert.deepEqual(general.getKeyboardData(screen), [['tka_5', 'tka_10', 'tka_15'], ['tka_20', 'tka_30', 'tka_0']]);
    assert.deepEqual(general.getKeyboardLabels(screen), [['5 ✓', '10', '15'], ['20', '30', 'No limit']]);
    assert.ok(!screen.text.includes('Now:'), 'an instance without a tracker says nothing of running agents');
    assert.equal(readPersistedLimit(), undefined);
    assert.deepEqual(JSON.parse(fs.readFileSync(getSettingsFilePath(), 'utf8')), isolatedBaselineSettings, 'nor does it touch settings.json');
  });

  it('settings.json seeds an instance whose General never chose — 3 «from settings.json», on no picker button', async () => {
    writeSettingsFileByHand({ ...isolatedBaselineSettings, taskAgents: { maxConcurrent: 3 } });
    const screen = await general.sendAndAwaitReply('/task_agents', `${screenTitlePrefix}3 — from settings.json`);
    assert.deepEqual(general.getKeyboardLabels(screen), [['5', '10', '15'], ['20', '30', 'No limit']]);
  });

  it('a tap turns the picker into its confirmation, stores General\'s value, and General\'s own value beats the file from then on', async () => {
    const picker = await general.sendAndAwaitReply('/task_agents', `${screenTitlePrefix}3 — from settings.json`);
    const answer = await general.tapAndAwaitAnswer(picker, 'tka_20');
    assert.equal(answer, '', 'the tap is answered without a toast');
    await general.waitForMessageText('the picker turned into its confirmation', picker, (text) => text.startsWith('✅ Task agents at once: 20, for the whole bot.'));
    assert.deepEqual(general.getKeyboardData(picker), [], 'a one-shot picker: the menu is gone');
    await waitForPersistedLimit(20);
    assert.equal(JSON.parse(fs.readFileSync(getSettingsFilePath(), 'utf8')).taskAgents.maxConcurrent, 3, 'the file is the operator\'s: the tap does not rewrite it');
    const screen = await general.sendAndAwaitReply('/task_agents', `${screenTitlePrefix}20 — set in General`);
    assert.deepEqual(general.getKeyboardLabels(screen), [['5', '10', '15'], ['20 ✓', '30', 'No limit']]);
  });

  it('a number typed after the command applies at once — any whole number, none of them on a button — and off or 0 mean no limit', async () => {
    await general.sendAndAwaitReply('/task_agents 12', '✅ Task agents at once: 12, for the whole bot.');
    await waitForPersistedLimit(12);
    const screen = await general.sendAndAwaitReply('/task_agents', `${screenTitlePrefix}12 — set in General`);
    assert.deepEqual(general.getKeyboardLabels(screen), [['5', '10', '15'], ['20', '30', 'No limit']], '12 is on no button: no ✓');

    await general.sendAndAwaitReply('/task_agents off', '✅ Task agents at once: no limit, for the whole bot.');
    await waitForPersistedLimit(0);
    const noLimitScreen = await general.sendAndAwaitReply('/task_agents', `${screenTitlePrefix}no limit — set in General`);
    assert.deepEqual(general.getKeyboardLabels(noLimitScreen), [['5', '10', '15'], ['20', '30', 'No limit ✓']]);

    await general.sendAndAwaitReply('/task_agents 7', '✅ Task agents at once: 7, for the whole bot.');
    await general.sendAndAwaitReply('/task_agents 0', '✅ Task agents at once: no limit, for the whole bot.');
    await waitForPersistedLimit(0);
  });

  it('a number over the bound, a decimal and a word are refused with the range and change nothing', async () => {
    await general.sendAndAwaitReply('/task_agents 9', '✅ Task agents at once: 9, for the whole bot.');
    await waitForPersistedLimit(9);
    for (const argument of [`${taskAgentsMaxConcurrentUpperBound + 1}`, '2.5', 'many']) {
      await general.sendAndAwaitReply(`/task_agents ${argument}`, invalidArgumentReply);
    }
    assert.equal(readPersistedLimit(), 9, 'the three refusals changed nothing');
  });

  it('a topic is told the value in force and that it is changed in General — no picker — and a number typed there is refused', async () => {
    const screen = await topic.sendAndAwaitReply('/task_agents', `${screenTitlePrefix}9 — set in General`);
    assert.ok(screen.text.includes('It is one limit for the whole bot — change it in General.'), screen.text);
    assert.deepEqual(topic.getKeyboardData(screen), []);
    await topic.sendAndAwaitReply('/task_agents 3', '⚠️ The limit is one for the whole bot — change it in General.');
    assert.equal(readPersistedLimit(), 9);
  });

  it('a restart keeps General\'s value', async () => {
    await getCharness().stop();
    await startCharness();
    await general.sendAndAwaitReply('/task_agents', `${screenTitlePrefix}9 — set in General`);
  });
});
