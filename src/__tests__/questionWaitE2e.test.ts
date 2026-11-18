/**
 * @description `/question_wait` at PROCESS level: the BUILT charness started the way an isolated instance is
 * (`scripts/run-isolated.sh`) against the fake Bot API of `telegramE2e/fakeTelegram.ts`, with the fake `claude`
 * (`jiraE2e/fakeClaude.ts`, mode `ask`) putting a real `AskUserQuestion` to the topic. The instance's finite waits are cut to six seconds
 * (`CHARNESS_TEST_TIMINGS` `questionSetAsideWaitMs`: 30 min by default), which leaves «Don't wait» and «Wait for my answer» as they are,
 * so the choice a flow made is what decides the moment — or never — the agent is told to go on. One flow, in order:
 *
 *   boot → the topic is bound → `/claude`
 *   → `/question_wait` in the topic: the value in force and where it comes from, ✓ on «As in General (30 min)»
 *   → «Don't wait» in the topic: the toast, the picker follows, the choice is saved in `state.json`; a question is set aside AT ONCE
 *     (long before the six-second wait of every other topic)
 *   → «Wait for my answer»: a question is NOT set aside when the wait would have ended; a tap on «As in General» while it waits
 *     times it again, from the moment it was asked, and it is set aside at once (the wait was over)
 *   → a change made while a question waits applies to it: «Don't wait» sets it aside on the tap
 *   → General: its picker, a tap writes `settings.json` beside the other fields, and a topic with no choice of its own follows it —
 *     with General's «Wait for my answer» a question waits; a later «Don't wait» in General sets the waiting question aside at once
 *   → a restart keeps the topic's own choice
 *
 * Nothing leaves the machine: the Bot API is on loopback and the agent is a fake. Everything the test starts is stopped in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram, generalTopicThreadId, type FakeTelegramMessage } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import {
  fakeAskSetAsideTurnText,
  fakeClaudeLogFileNames,
  fakeQuestionVariantToken,
  getFakeAskQuestionText,
  type FakeClaudeControlResponse,
} from './jiraE2e/fakeClaudeContract';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { keyToString } from '../sessionKey';
import {
  builtCliPath,
  createIsolatedInstanceLayout,
  exitOnSignal,
  getFlowDeadlineMs,
  getFreeFixedPort,
  getUnservedPort,
  IsolatedCharness,
  isolatedBaselineSettings,
  isolatedSettingsFileName,
  listTmuxSessions,
  readJsonLines,
  removeIsolatedInstanceSync,
  writeFakeClaudeLauncher,
  writeInstanceEnvFile,
  type IsolatedInstanceLayout,
} from './e2e/isolatedCharness';
import { readPersistedState, restartCharnessWithState, startCharnessOnInstance } from './e2e/fallbackFlowKit';
import { assertToldToGoOn } from './e2e/setAsideFlowKit';
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const topicThreadId = 111;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const projectFolder = 'proj';

const replyTimeoutMs = 20 * 1000;
/** What a step that waits for the set-aside waits at most. */
const setAsideTimeoutMs = 45 * 1000;
/** The finite waits of the instance, in ms (production: 10 min, 30 min, 1 h). */
const questionWaitMs = 6000;
/** How late after the wait the agent may be told: the timer, the lifecycle queue and one paced send. */
const setAsideLatenessMs = 3000;
/** A set-aside «at once» comes well inside the wait every other topic has. */
const atOnceBoundMs = questionWaitMs - 1500;
const topicKey = keyToString(makeTelegramKey(group.id, topicThreadId));

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let topic: TopicDriver;
let waitingTopic: TopicDriver;
let general: TopicDriver;
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

/** The verdicts the bot wrote on the agent's `can_use_tool` requests that the fake read, in order. */
function getControlResponses(): FakeClaudeControlResponse[] {
  return readJsonLines<FakeClaudeControlResponse>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.controlResponses));
}

/** `settings.json` sits beside the instance's env file. */
function readSettingsFile(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(getLayout().testRoot, isolatedSettingsFileName), 'utf8'));
}

/** The `askedAt` the bot saved for the question that waits now. */
function getWaitingQuestionAskedAt(): number {
  const askedAt = readPersistedState(getLayout()).pendingQuestions?.[topicKey]?.askedAt;
  assert.equal(typeof askedAt, 'number', 'the waiting question is saved with the moment it was asked');
  return askedAt as number;
}

function checkIsQuestionWaiting(): boolean {
  return readPersistedState(getLayout()).pendingQuestions?.[topicKey] !== undefined;
}

/** The next variant of the question the fake agent asks: every question this flow asks reads differently (an open set-aside copy of one is not asked again). */
let nextQuestionVariant = 1;

/** Put a question (`ask`): resolves its message once it carries the option buttons. */
async function askQuestion(promptLabel: string): Promise<FakeTelegramMessage> {
  const variant = nextQuestionVariant;
  nextQuestionVariant += 1;
  const questionText = getFakeAskQuestionText(variant);
  const sentMessageId = fakeTelegram.pushOperatorMessage(topicThreadId, `${promptLabel} [fake:ask] ${fakeQuestionVariantToken(variant)} ask me something`);
  return topic.waitForMessage(`the question of ${promptLabel}`, (message) =>
    message.message_id > sentMessageId
    && message.text.includes(questionText)
    && topic.getKeyboardData(message).flat().some((data) => data.startsWith('qa_')));
}

/** The deny the bot wrote after `responsesBefore` verdicts, waited for: what the agent read as its question's result. */
async function waitForSetAsideDeny(description: string, responsesBefore: number): Promise<FakeClaudeControlResponse> {
  await getCharness().waitFor(description, setAsideTimeoutMs, () => getControlResponses().length > responsesBefore);
  const response = getControlResponses()[responsesBefore];
  assertToldToGoOn(response);
  return response;
}

/** The turn went on after the deny: the fake ends it with its fixed text only for a set-aside question. */
async function waitForAgentToGoOn(question: FakeTelegramMessage): Promise<void> {
  await waitingTopic.waitForMessage('the agent\'s turn going on after its question was set aside', (message) => message.message_id > question.message_id && message.text.includes(fakeAskSetAsideTurnText));
}

/** The picker `/question_wait` posted in `driver`'s topic. */
async function openPicker(driver: TopicDriver, expectedStart: string): Promise<FakeTelegramMessage> {
  return driver.sendAndAwaitReply('/question_wait', expectedStart);
}

describe('/question_wait, end to end: built charness, fake Bot API', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-qwait-', [projectFolder], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    topic = new TopicDriver(fakeTelegram, getCharness, topicThreadId, replyTimeoutMs);
    waitingTopic = new TopicDriver(fakeTelegram, getCharness, topicThreadId, setAsideTimeoutMs);
    general = new TopicDriver(fakeTelegram, getCharness, generalTopicThreadId, replyTimeoutMs);
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
      ...getTelegramFlowTestTimingsEnv({ questionSetAsideWaitMs: questionWaitMs }),
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

  let picker: FakeTelegramMessage;

  it('boots Telegram-only against the fake Bot API, binds the topic and starts the fake agent', async () => {
    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    await topic.sendAndAwaitReply(`/bind ${projectFolder}`, `Bound to \`${projectFolder}\``);
    await topic.sendAndAwaitReply('/claude', 'ready in');
  });

  it('/question_wait in a topic names the value in force and where it comes from, offers the waits and «As in General» (with General\'s value), and changes nothing until a tap', async () => {
    picker = await openPicker(topic, '⏳ How long the agent waits for your answer to its question before it goes on without it — this topic: as in General — 30 min');
    assert.deepEqual(topic.getKeyboardData(picker), [['qw_dontWait', 'qw_tenMinutes', 'qw_thirtyMinutes', 'qw_oneHour'], ['qw_untilAnswered'], ['qw_same']]);
    assert.deepEqual(topic.getKeyboardLabels(picker), [["Don't wait", '10 min', '30 min', '1 h'], ['Wait for my answer'], ['As in General (30 min) ✓']]);
    assert.equal(readPersistedState(getLayout()).questionWaitOverrides, undefined, 'nothing is saved until a tap');
  });

  it('«Don\'t wait»: the toast names it, the picker follows, the choice is saved — and a question is set aside AT ONCE, long before the wait every other topic has', async () => {
    assert.equal(await topic.tapAndAwaitAnswer(picker, 'qw_dontWait'), "✅ Don't wait");
    await topic.waitForMessageText('the picker re-rendered', picker, (text) => text.includes('— this topic: Don\'t wait'));
    assert.deepEqual(topic.getKeyboardLabels(fakeTelegram.getMessage(picker.message_id) ?? picker), [["Don't wait ✓", '10 min', '30 min', '1 h'], ['Wait for my answer'], ['As in General (30 min)']]);
    await getCharness().waitFor('the choice to be saved', replyTimeoutMs, () => readPersistedState(getLayout()).questionWaitOverrides?.[topicKey] === 'dontWait');

    const responsesBefore = getControlResponses().length;
    const question = await askQuestion('NOWAIT-1');
    const response = await waitForSetAsideDeny('the bot to tell the agent its question was set aside', responsesBefore);
    // The question was set aside the moment it was asked, so only the record it became still holds the moment.
    await getCharness().waitFor('the question to be saved as a set-aside record', replyTimeoutMs, () => readPersistedState(getLayout()).setAsideQuestions?.[topicKey]?.some((record) => record.messageId === question.message_id) === true);
    const askedAt = readPersistedState(getLayout()).setAsideQuestions?.[topicKey]?.find((record) => record.messageId === question.message_id)?.askedAt ?? 0;
    assert.ok(response.readAt - askedAt < atOnceBoundMs, `at once, not after the wait the other topics have (${questionWaitMs} ms): ${response.readAt - askedAt} ms after the ask`);
    await waitForAgentToGoOn(question);
    assert.equal(checkIsQuestionWaiting(), false, 'nothing waits any more');
  });

  it('«Wait for my answer»: a question is NOT set aside when the wait would have ended; «As in General» then times it again from the moment it was asked, and it is set aside at once', async () => {
    assert.equal(await topic.tapAndAwaitAnswer(picker, 'qw_untilAnswered'), '✅ Wait for my answer');
    await getCharness().waitFor('the choice to be saved', replyTimeoutMs, () => readPersistedState(getLayout()).questionWaitOverrides?.[topicKey] === 'untilAnswered');

    const responsesBefore = getControlResponses().length;
    const question = await askQuestion('UNTIL-1');
    const askedAt = getWaitingQuestionAskedAt();
    await new Promise((resolve) => setTimeout(resolve, questionWaitMs + setAsideLatenessMs));
    assert.equal(getControlResponses().length, responsesBefore, 'the agent has heard nothing, however long it waited');
    assert.equal(checkIsQuestionWaiting(), true, 'and the question still waits');
    assert.ok(Date.now() > askedAt + questionWaitMs + 1000, 'precondition: the wait every other topic has is over');

    // The choice changes while the question waits: the wait it follows now is over already, so the question is set aside on the tap.
    assert.equal(await topic.tapAndAwaitAnswer(picker, 'qw_same'), '✅ as in General — 30 min');
    const response = await waitForSetAsideDeny('the bot to set the waiting question aside after the choice changed', responsesBefore);
    assert.ok(response.readAt >= askedAt + questionWaitMs - 50, 'counted from the moment it was asked, never earlier');
    await waitForAgentToGoOn(question);
    assert.equal(readPersistedState(getLayout()).questionWaitOverrides, undefined, '«as in General» drops the saved choice');
  });

  it('a change made while a question waits applies to it: «Don\'t wait» sets it aside on the tap, not when its wait would have ended', async () => {
    assert.equal(await topic.tapAndAwaitAnswer(picker, 'qw_untilAnswered'), '✅ Wait for my answer');
    const responsesBefore = getControlResponses().length;
    const question = await askQuestion('CHANGE-1');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(getControlResponses().length, responsesBefore, 'precondition: it waits');
    const tappedAt = Date.now();

    assert.equal(await topic.tapAndAwaitAnswer(picker, 'qw_dontWait'), "✅ Don't wait");
    const response = await waitForSetAsideDeny('the bot to set the waiting question aside on the tap', responsesBefore);
    assert.ok(response.readAt - tappedAt < setAsideLatenessMs, `on the tap: ${response.readAt - tappedAt} ms after it`);
    await waitForAgentToGoOn(question);
    assert.equal(await topic.tapAndAwaitAnswer(picker, 'qw_same'), '✅ as in General — 30 min');
  });

  let generalPicker: FakeTelegramMessage;

  it('General: its picker is the instance default — ✓ on the value in force, no «As in General» — and a tap writes settings.json beside the other fields', async () => {
    generalPicker = await openPicker(general, '⏳ How long an agent waits for your answer to its question before it goes on without it — the default of ALL topics: 30 min');
    assert.match(generalPicker.text, /This is the default of every topic that has no choice of its own\.$/);
    assert.deepEqual(general.getKeyboardData(generalPicker), [['qw_dontWait', 'qw_tenMinutes', 'qw_thirtyMinutes', 'qw_oneHour'], ['qw_untilAnswered']]);
    assert.ok(general.getKeyboardLabels(generalPicker).flat().includes('30 min ✓'));
    assert.equal((readSettingsFile() as { questionWait?: string }).questionWait, undefined, 'nothing is written until a tap');

    assert.equal(await general.tapAndAwaitAnswer(generalPicker, 'qw_untilAnswered'), '✅ Wait for my answer');
    assert.deepEqual(readSettingsFile(), { ...isolatedBaselineSettings, questionWait: 'untilAnswered' }, 'the tap keeps the other fields of the file');
    await general.waitForMessageText('the picker re-rendered', generalPicker, (text) => text.includes('the default of ALL topics: Wait for my answer'));
    assert.ok(general.getKeyboardLabels(fakeTelegram.getMessage(generalPicker.message_id) ?? generalPicker).flat().includes('Wait for my answer ✓'));
  });

  it('a topic with no choice of its own follows General: its screen says so, and with General\'s «Wait for my answer» a question waits; a later «Don\'t wait» in General sets the waiting question aside at once', async () => {
    const screen = await openPicker(topic, '⏳ How long the agent waits for your answer to its question before it goes on without it — this topic: as in General — Wait for my answer');
    assert.deepEqual(topic.getKeyboardLabels(screen).at(-1), ['As in General (Wait for my answer) ✓']);

    const responsesBefore = getControlResponses().length;
    const question = await askQuestion('GENERAL-1');
    await new Promise((resolve) => setTimeout(resolve, questionWaitMs + setAsideLatenessMs));
    assert.equal(getControlResponses().length, responsesBefore, 'General\'s choice applies: the question was not set aside');
    assert.equal(checkIsQuestionWaiting(), true);

    const tappedAt = Date.now();
    assert.equal(await general.tapAndAwaitAnswer(generalPicker, 'qw_dontWait'), "✅ Don't wait");
    assert.equal((readSettingsFile() as { questionWait?: string }).questionWait, 'dontWait');
    const response = await waitForSetAsideDeny('the bot to set the waiting question aside after General changed', responsesBefore);
    assert.ok(response.readAt - tappedAt < setAsideLatenessMs, `on the tap: ${response.readAt - tappedAt} ms after it`);
    await waitForAgentToGoOn(question);
  });

  it('a topic\'s own choice wins over General\'s, and a restart keeps it', async () => {
    const screen = await openPicker(topic, 'this topic: as in General — Don\'t wait');
    assert.equal(await topic.tapAndAwaitAnswer(screen, 'qw_oneHour'), '✅ 1 h');
    await getCharness().waitFor('the choice to be saved', replyTimeoutMs, () => readPersistedState(getLayout()).questionWaitOverrides?.[topicKey] === 'oneHour');

    charness = await restartCharnessWithState(getLayout(), fakeTelegram, getCharness(), () => {});
    const afterRestart = await openPicker(topic, '— this topic: 1 h');
    assert.deepEqual(topic.getKeyboardLabels(afterRestart), [["Don't wait", '10 min', '30 min', '1 h ✓'], ['Wait for my answer'], ["As in General (Don't wait)"]]);
    assert.equal((readSettingsFile() as { questionWait?: string }).questionWait, 'dontWait', 'General\'s value is still in the file');
  });
});
