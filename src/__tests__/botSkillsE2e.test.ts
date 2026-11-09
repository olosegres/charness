/**
 * @description The «Bot skills» switch (`/bot_skills`) at PROCESS level: the BUILT charness started the way an isolated
 * instance is (`scripts/run-isolated.sh`) against the fake Bot API of `telegramE2e/fakeTelegram.ts`, with the fake `claude`
 * recording how every session is launched (`--plugin-dir`) — and the instructions the bot MCP gives it, read through the
 * launch's own `--mcp-config`. The test plays the operator in General and in two bound topics. One flow, in order:
 *
 *   boot → two topics bound to folders
 *   → ON is the default: a topic's session launches with the bot's skills folder and its MCP instructions carry the hint
 *     to load `charness-orchestration`; General's screen says ON by the built-in default, nothing is written until a tap
 *   → settings.json's `botSkills: "off"` seeds an instance whose General never chose: the next start is without, and
 *     General's screen says OFF «from settings.json»; General's own tap on «On» beats the file from then on and the screen
 *     says «set in General»
 *   → a topic's picker: «Off» becomes the confirmation (keyboard gone), the topic's next start is without while the other
 *     topic, started with the skills, keeps them and is not restarted by the change
 *   → «As in General» hands the topic back to General's value; a General «Off» reaches every topic without a choice of its
 *     own and not the one that chose «On»
 *   → a bot restart adopts a process the switch changed under: its tool list reads as stale, nothing restarts it
 *
 * Nothing leaves the machine: the Bot API is on loopback and the agent is a fake. Everything the test starts is
 * stopped in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram, generalTopicThreadId, type FakeTelegramMessage } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import { fakeClaudeLogFileNames, getFlagValues, type FakeClaudeTurn } from './jiraE2e/fakeClaudeContract';
import {
  builtAgentPluginDir,
  builtCliPath,
  createIsolatedInstanceLayout,
  exitOnSignal,
  getFlowDeadlineMs,
  getFreeFixedPort,
  getFreePort,
  isolatedBaselineSettings,
  IsolatedCharness,
  listTmuxSessions,
  readJsonLines,
  removeIsolatedInstanceSync,
  writeFakeClaudeLauncher,
  writeInstanceEnvFile,
  type IsolatedInstanceLayout,
} from './e2e/isolatedCharness';
import { readBotMcpInstructions } from './e2e/botMcpInstructions';
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const firstThreadId = 111;
const secondThreadId = 112;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const firstFolder = 'first';
const secondFolder = 'second';
const launchLine = 'Launching Telegraf bot (long polling';
/** The hint to load the manager, and the part of the bullet that stays with the skills off. */
const managerSkillHint = '`charness-orchestration`';
const workerWatchRecipe = 'schedule_create to watch EACH worker';
/** What a Claude topic's confirmation says of its running agent. */
const runningAgentNote = 'A running agent keeps its skills until its next start (after an idle stop, in a new session or on a model change).';

const bootTimeoutMs = 60 * 1000;
const replyTimeoutMs = 20 * 1000;
const agentStartTimeoutMs = 60 * 1000;

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let general: TopicDriver;
let first: TopicDriver;
let second: TopicDriver;
let defaultTmuxSessionsBefore: string[] = [];
let promptCounter = 0;

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

interface FakeLaunch {
  argv: string[];
  isSessionLaunch: boolean;
  pid: number;
}

function getSessionLaunches(): FakeLaunch[] {
  return readJsonLines<FakeLaunch>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.launches)).filter((launch) => launch.isSessionLaunch);
}

function getAgentTurns(label: string): FakeClaudeTurn[] {
  return readJsonLines<FakeClaudeTurn>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.turns)).filter((turn) => turn.issueKey === label);
}

/** How a topic's process was launched, and what the bot MCP told it. */
interface SessionReading {
  pid: number;
  argv: string[];
  instructions: string;
}

/**
 * Send a labelled prompt in the topic and read how the process that answered it was launched (the fake records launches
 * by pid, so this is the way to tell WHICH launch belongs to a topic) and the instructions its bot MCP gives.
 */
async function askAgentAndReadSession(threadId: number): Promise<SessionReading> {
  promptCounter += 1;
  const label = `SKL-${promptCounter}`;
  fakeTelegram.pushOperatorMessage(threadId, `${label} [fake:answer] which skills do I have?`);
  await getCharness().waitFor(`the prompt ${label} to reach the agent`, agentStartTimeoutMs, () => getAgentTurns(label).length === 1);
  const [turn] = getAgentTurns(label);
  const launch = getSessionLaunches().filter((candidate) => candidate.pid === turn.pid).at(-1);
  assert.ok(launch, `a launch recorded for the process ${turn.pid} that answered ${label}`);
  return { pid: turn.pid, argv: launch.argv, instructions: await readBotMcpInstructions(launch.argv) };
}

function assertSkillsOn(reading: SessionReading, description: string): void {
  assert.deepEqual(getFlagValues(reading.argv, '--plugin-dir'), [builtAgentPluginDir], `${description}: the bot's skills folder in ${reading.argv.join(' ')}`);
  assert.ok(reading.instructions.includes(managerSkillHint), `${description}: the hint to load the manager`);
}

function assertSkillsOff(reading: SessionReading, description: string): void {
  assert.deepEqual(getFlagValues(reading.argv, '--plugin-dir'), [], `${description}: no skills folder in ${reading.argv.join(' ')}`);
  assert.ok(!reading.instructions.includes(managerSkillHint), `${description}: no hint to load the manager`);
  assert.ok(reading.instructions.includes(workerWatchRecipe), `${description}: the worker-watch recipe stays`);
}

/** Start charness on the instance and wait for its first poll to reach the fake Bot API. */
async function startCharness(): Promise<void> {
  charness = new IsolatedCharness(getLayout());
  const pollsBefore = fakeTelegram.listCalls('getUpdates').length;
  await charness.start(bootTimeoutMs, (runOutput) => runOutput.includes(launchLine) && fakeTelegram.listCalls('getUpdates').length > pollsBefore);
}

/** A topic's session is stopped (`/quit`) and started again (`/claude`), so the NEXT start reads the switch. */
async function restartSession(driver: TopicDriver): Promise<void> {
  await driver.sendAndAwaitReply('/quit', 'stopped');
  await driver.sendAndAwaitReply('/claude', 'ready in');
}

/** Open `/bot_skills` in the topic and tap `callbackData` on its picker; resolves the picker message after the edit. */
async function pickInTopic(driver: TopicDriver, callbackData: string): Promise<FakeTelegramMessage> {
  const picker = await driver.sendAndAwaitReply('/bot_skills', '🧰 Bot skills');
  await driver.tapAndAwaitAnswer(picker, callbackData);
  await driver.waitForMessageText('the picker turned into its confirmation', picker, (text) => text.startsWith('✅ '));
  return picker;
}

describe('The bot-skills switch end to end: built charness, fake Bot API', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-skills-', [firstFolder, secondFolder], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

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

  it('boots Telegram-only against the fake Bot API and binds both topics to a folder', async () => {
    await startCharness();
    await first.sendAndAwaitReply(`/bind ${firstFolder}`, `Bound to \`${firstFolder}\``);
    await second.sendAndAwaitReply(`/bind ${secondFolder}`, `Bound to \`${secondFolder}\``);
  });

  it('ON is the default: General\'s screen says ON, and a topic\'s session launches with the skills and the hint in its instructions', async () => {
    const screen = await general.sendAndAwaitReply('/bot_skills', '🧰 Bot skills for ALL topics: ON — the built-in default');
    assert.deepEqual(general.getKeyboardData(screen), [['bsk_on', 'bsk_off']]);
    assert.deepEqual(general.getKeyboardLabels(screen), [['On ✓', 'Off']]);
    assert.deepEqual(JSON.parse(fs.readFileSync(getSettingsFilePath(), 'utf8')), isolatedBaselineSettings, 'looking changes nothing');

    await first.sendAndAwaitReply('/claude', 'ready in');
    assertSkillsOn(await askAgentAndReadSession(firstThreadId), 'the default');
  });

  it('settings.json seeds an instance whose General never chose: the next start is without, and General\'s screen says OFF', async () => {
    writeSettingsFileByHand({ ...isolatedBaselineSettings, botSkills: 'off' });
    await restartSession(first);
    assertSkillsOff(await askAgentAndReadSession(firstThreadId), 'the seed');
    const screen = await general.sendAndAwaitReply('/bot_skills', '🧰 Bot skills for ALL topics: OFF — from settings.json');
    assert.deepEqual(general.getKeyboardLabels(screen), [['On', 'Off ✓']]);
  });

  it('General\'s own tap beats the file from then on, answers, and turns the picker into its confirmation', async () => {
    const picker = await general.sendAndAwaitReply('/bot_skills', '🧰 Bot skills for ALL topics: OFF — from settings.json');
    const answer = await general.tapAndAwaitAnswer(picker, 'bsk_on');
    assert.equal(answer, '', 'the tap is answered without a toast');
    await general.waitForMessageText('the picker turned into its confirmation', picker, (text) => text.startsWith('✅ Bot skills: ON for ALL topics'));
    assert.match(picker.text, /A running agent keeps its skills until its next start; OpenCode's server follows at the bot's next start\.$/);
    assert.deepEqual(general.getKeyboardData(picker), [], 'a one-shot picker: the menu is gone');
    assert.equal(JSON.parse(fs.readFileSync(getSettingsFilePath(), 'utf8')).botSkills, 'off', 'the file is the operator\'s: the tap does not rewrite it');
    await general.sendAndAwaitReply('/bot_skills', '🧰 Bot skills for ALL topics: ON — set in General');

    await restartSession(first);
    assertSkillsOn(await askAgentAndReadSession(firstThreadId), 'General\'s ON over the file\'s off');
  });

  it('a topic\'s «Off» is its own: the confirmation replaces the picker, the topic starts without, the other topic keeps its skills and is not restarted', async () => {
    const firstPidBeforeSecondChoice = (await askAgentAndReadSession(firstThreadId)).pid;
    const launchesBefore = getSessionLaunches().length;
    const screen = await second.sendAndAwaitReply('/bot_skills', '🧰 Bot skills in this topic: ON — as in General');
    assert.deepEqual(second.getKeyboardData(screen), [['bsk_on', 'bsk_off'], ['bsk_same']]);
    assert.deepEqual(second.getKeyboardLabels(screen), [['On', 'Off'], ['As in General (ON) ✓']]);
    await second.tapAndAwaitAnswer(screen, 'bsk_off');
    await second.waitForMessageText('the picker turned into its confirmation', screen, (text) => text === `✅ Bot skills: OFF for this topic. ${runningAgentNote}`);
    assert.deepEqual(second.getKeyboardData(screen), []);
    assert.equal(getSessionLaunches().length, launchesBefore, 'the change launches nothing');

    await second.sendAndAwaitReply('/claude', 'ready in');
    assertSkillsOff(await askAgentAndReadSession(secondThreadId), 'the topic\'s own Off');
    const firstAgain = await askAgentAndReadSession(firstThreadId);
    assert.equal(firstAgain.pid, firstPidBeforeSecondChoice, 'the other topic\'s process is the one it had');
    assertSkillsOn(firstAgain, 'the other topic');
    assert.equal(getSessionLaunches().length, launchesBefore + 1, 'one new launch: the second topic\'s');
  });

  it('the topic\'s screen now says the choice is its own', async () => {
    const screen = await second.sendAndAwaitReply('/bot_skills', '🧰 Bot skills in this topic: OFF — set for this topic');
    assert.deepEqual(second.getKeyboardLabels(screen), [['On', 'Off ✓'], ['As in General (ON)']]);
  });

  it('«As in General» hands the topic back to General\'s value — its next start has the skills again', async () => {
    const picker = await pickInTopic(second, 'bsk_same');
    assert.equal(picker.text, `✅ Bot skills in this topic follow General again: ON. ${runningAgentNote}`);
    await restartSession(second);
    assertSkillsOn(await askAgentAndReadSession(secondThreadId), 'following General');
  });

  it('a General «Off» reaches the topic without a choice of its own, and not the one that chose «On»', async () => {
    await pickInTopic(first, 'bsk_on');
    const generalPicker = await general.sendAndAwaitReply('/bot_skills', '🧰 Bot skills for ALL topics: ON');
    await general.tapAndAwaitAnswer(generalPicker, 'bsk_off');
    await general.waitForMessageText('the picker turned into its confirmation', generalPicker, (text) => text.startsWith('✅ Bot skills: OFF for ALL topics'));

    await restartSession(second);
    assertSkillsOff(await askAgentAndReadSession(secondThreadId), 'following General\'s Off');
    await restartSession(first);
    assertSkillsOn(await askAgentAndReadSession(firstThreadId), 'its own On over General\'s Off');
  });

  it('a bot restart adopts a process the switch changed under: its tool list reads as stale, and nothing restarts it', async () => {
    // The first topic runs with the skills (its own On); turning it Off changes what the bot would give it at its next start.
    const running = await askAgentAndReadSession(firstThreadId);
    await pickInTopic(first, 'bsk_off');
    const launchesBefore = getSessionLaunches().length;

    await getCharness().stop();
    await startCharness();
    await getCharness().waitFor('the surviving sessions to be re-adopted', replyTimeoutMs, () => /\[reattach\] claude-json-stream: adopted [1-9]/.test(getCharness().output));
    await getCharness().waitFor('the stale tool list to be noted', replyTimeoutMs, () => getCharness().output.includes(`[reattach] ${group.id}:${firstThreadId}: adopted with a stale tool list`));
    assert.ok(!getCharness().output.includes(`[reattach] ${group.id}:${secondThreadId}: adopted with a stale tool list`), 'the topic whose switch did not change is not stale');
    assert.equal(getSessionLaunches().length, launchesBefore, 'adopting launches nothing');
    const answering = await askAgentAndReadSession(firstThreadId);
    assert.equal(answering.pid, running.pid, 'the adopted process still answers');
    assert.deepEqual(getFlagValues(answering.argv, '--plugin-dir'), [builtAgentPluginDir], 'and still has what it was started with');
    assert.ok(!answering.instructions.includes(managerSkillHint), 'while a fresh connect is already told the topic is off');
  });
});
