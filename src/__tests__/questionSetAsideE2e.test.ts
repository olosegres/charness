/**
 * @description A question the owner does not answer never keeps the agent standing still, at PROCESS level: the BUILT
 * charness started the way an isolated instance is (`scripts/run-isolated.sh`) against the fake Bot API of
 * `telegramE2e/fakeTelegram.ts`, with the fake `claude` (`jiraE2e/fakeClaude.ts`, mode `ask`) putting a real `AskUserQuestion`
 * to the topic, and the question wait cut to seconds (`CHARNESS_TEST_TIMINGS` `questionSetAsideWaitMs`). One flow, in order:
 *
 *   boot → the topic is bound → `/claude`
 *   → a question nobody answers: when the wait ends the agent is told «no answer yet, go on» — the question's tool call is
 *     DENIED with the bot's text, no interrupt follows — and the agent's turn goes on (the proof: it ends with the fake's
 *     fixed text); the question's message stays, with a note under it and the same buttons (now naming the saved record) and
 *     its pin, and the question is saved as a set-aside record instead of a waiting one
 *   → the owner's case: a prompt the bot delivers to the agent while the question waits (a one-shot schedule the agent made
 *     itself) does not cancel the question, and the question is still set aside when its wait ends — the prompt is then read
 *   → one call with two questions, the first answered by a tap: at the end of the wait the agent gets that answer at once,
 *     and the second stays open as the set-aside record
 *   → the bot restarts with the question waiting and comes back when most of its wait is over: it is set aside at the
 *     ORIGINAL moment, not after a new wait; a restart after that keeps the record and the buttons
 *   → a sixth open set-aside question closes the oldest as «not answered» and releases its pin; the others keep theirs, a
 *     question asked meanwhile is pinned beside them
 *
 * Nothing leaves the machine: the Bot API is on loopback and the agent is a fake. Everything the test starts is stopped in
 * `after`. How a late answer reaches the agent, and what ends a set-aside question, come with the answer routes.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram, type FakeTelegramMessage } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import {
  fakeAskQuestion,
  fakeAskSecondQuestion,
  fakeAskSetAsideTurnText,
  fakeClaudeLogFileNames,
  fakeScheduleOnceToken,
  type FakeClaudeControlRequest,
  type FakeClaudeControlResponse,
  type FakeClaudePrompt,
} from './jiraE2e/fakeClaudeContract';
import { enDict } from '../i18n/en';
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
  listTmuxSessions,
  readJsonLines,
  removeIsolatedInstanceSync,
  writeFakeClaudeLauncher,
  writeInstanceEnvFile,
  type IsolatedInstanceLayout,
} from './e2e/isolatedCharness';
import { readPersistedState, restartCharnessWithState, startCharnessOnInstance } from './e2e/fallbackFlowKit';
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';
import type { SetAsideQuestionRecord } from '../types';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const topicThreadId = 111;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const projectFolder = 'proj';

const replyTimeoutMs = 20 * 1000;
/** What a step that waits for the set-aside waits at most: the wait, a send and the agent's turn after it, with room for a loaded box. */
const setAsideTimeoutMs = 45 * 1000;

/** The question wait of the instance, in ms (production: 30 min by default). */
const questionWaitMs = 6000;
/** How late after `askedAt + wait` the agent may be told: the timer, the lifecycle queue and one paced send. */
const setAsideLatenessMs = 3000;

const setAsideNote = enDict['agent.question_set_aside_note'];
const buildAnsweredNote = (answer: string): string => enDict['agent.question_answered_note'].replace('{answer}', answer);
const unansweredNote = enDict['agent.question_unanswered_note'];
const topicKey = keyToString(makeTelegramKey(group.id, topicThreadId));

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let topic: TopicDriver;
let waitingTopic: TopicDriver;
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

function getAgentPrompts(label: string): FakeClaudePrompt[] {
  return readJsonLines<FakeClaudePrompt>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.prompts)).filter((prompt) => prompt.text.includes(label));
}

/** The verdicts the bot wrote on the agent's `can_use_tool` requests that the fake read, in order. */
function getControlResponses(): FakeClaudeControlResponse[] {
  return readJsonLines<FakeClaudeControlResponse>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.controlResponses));
}

function getControlRequests(): FakeClaudeControlRequest[] {
  return readJsonLines<FakeClaudeControlRequest>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.controlRequests));
}

function getSetAsideRecords(): SetAsideQuestionRecord[] {
  return readPersistedState(getLayout()).setAsideQuestions?.[topicKey] ?? [];
}

/** The topic's set-aside records once the SAVED state holds `count` of them: the bot saves its state a moment after it changes. */
async function waitForSetAsideRecords(count: number): Promise<SetAsideQuestionRecord[]> {
  await getCharness().waitFor(`${count} set-aside question${count === 1 ? '' : 's'} to be saved`, replyTimeoutMs, () => getSetAsideRecords().length === count);
  return getSetAsideRecords();
}

/** The `askedAt` the bot saved for the question that waits now. */
function getWaitingQuestionAskedAt(): number {
  const askedAt = readPersistedState(getLayout()).pendingQuestions?.[topicKey]?.askedAt;
  assert.equal(typeof askedAt, 'number', 'the waiting question is saved with the moment it was asked');
  return askedAt as number;
}

/** Put the question (`ask`, or `ask-two`): resolves its message once it carries the option buttons. `extra` is more of the prompt (a token). */
async function askQuestion(promptLabel: string, mode: 'ask' | 'ask-two' = 'ask', extra = ''): Promise<FakeTelegramMessage> {
  const sentMessageId = fakeTelegram.pushOperatorMessage(topicThreadId, `${promptLabel} [fake:${mode}]${extra} ask me something`);
  return topic.waitForMessage(`the question of ${promptLabel}`, (message) =>
    message.message_id > sentMessageId
    && message.text.includes(fakeAskQuestion.question)
    && topic.getKeyboardData(message).flat().some((data) => data.startsWith('qa_')));
}

async function waitForPinned(message: FakeTelegramMessage): Promise<void> {
  await getCharness().waitFor(`message ${message.message_id} to be pinned`, replyTimeoutMs, () => fakeTelegram.listPinnedMessageIds().includes(message.message_id));
}

function readKeptMessageById(messageId: number): FakeTelegramMessage {
  const current = fakeTelegram.getMessage(messageId);
  assert.ok(current && !current.isDeleted, `message ${messageId} is still in the topic`);
  return current;
}

function readKeptMessage(message: FakeTelegramMessage): FakeTelegramMessage {
  return readKeptMessageById(message.message_id);
}

/** The deny the bot wrote after `responsesBefore` verdicts, waited for: what the agent read as its question's result. */
async function waitForSetAsideDeny(description: string, responsesBefore: number): Promise<FakeClaudeControlResponse> {
  await getCharness().waitFor(description, setAsideTimeoutMs, () => getControlResponses().length > responsesBefore);
  return getControlResponses()[responsesBefore];
}

/** What the set-aside text tells the agent, asserted on the message the fake read as its tool result. */
function assertToldToGoOn(response: FakeClaudeControlResponse): void {
  assert.equal(response.behavior, 'deny', 'the question\'s tool call is denied, not answered');
  assert.ok(response.message?.startsWith('[Charness] The user has not answered yet (asked '), `the agent is told nobody answered: ${response.message}`);
  assert.ok(response.message?.includes('This is NOT an answer.'), 'and that this is not an answer');
  assert.ok(response.message?.includes('do not ask it again and do not wait for it'), 'not to ask it again or wait');
  assert.ok(response.message?.includes('Go on with work that does not depend on it'), 'to go on');
  assert.ok(response.message?.includes('[Late answer to your question …]'), 'and how the answer will come');
  assert.notEqual(response.message, 'User declined to answer the question.', 'it is not the abandonment\'s decline');
}

/** The question is on screen as set aside: as asked, the note last, the same options as buttons that name the record, still pinned. */
function assertShownAsSetAside(message: FakeTelegramMessage, record: SetAsideQuestionRecord, question: { header: string; question: string; labels: readonly string[] }, optionCount: number): void {
  const current = readKeptMessage(message);
  for (const part of [question.header, question.question, ...question.labels]) assert.ok(current.text.includes(part), `the question's «${part.slice(0, 40)}…» stays: ${current.text}`);
  assert.ok(current.text.endsWith(`\n\n${setAsideNote}`), `the text ends with the set-aside note: ${current.text.slice(-120)}`);
  assert.notEqual(current.reply_markup, undefined, 'the buttons stay');
  assert.deepEqual(topic.getKeyboardData(current), Array.from({ length: optionCount }, (_, optionIndex) => [`qs_${record.id}_${optionIndex}`]), 'one button per option, naming the record');
  assert.ok(fakeTelegram.listPinnedMessageIds().includes(current.message_id), 'the pin stays');
}

const firstQuestion = { header: fakeAskQuestion.header, question: fakeAskQuestion.question, labels: [fakeAskQuestion.shortOptionLabel, fakeAskQuestion.longOptionLabel] } as const;
const secondQuestion = { header: fakeAskSecondQuestion.header, question: fakeAskSecondQuestion.question, labels: [fakeAskSecondQuestion.firstOptionLabel, fakeAskSecondQuestion.secondOptionLabel] } as const;

describe('A question nobody answers is set aside, end to end: built charness, fake Bot API', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-set-aside-', [projectFolder], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    topic = new TopicDriver(fakeTelegram, getCharness, topicThreadId, replyTimeoutMs);
    waitingTopic = new TopicDriver(fakeTelegram, getCharness, topicThreadId, setAsideTimeoutMs);
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

  it('boots Telegram-only against the fake Bot API, binds the topic and starts the fake agent', async () => {
    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    await topic.sendAndAwaitReply(`/bind ${projectFolder}`, `Bound to \`${projectFolder}\``);
    await topic.sendAndAwaitReply('/claude', 'ready in');
  });

  it('a question nobody answers is set aside when the wait ends: the agent is told to go on and does, the message keeps its buttons and its pin', async () => {
    const responsesBefore = getControlResponses().length;
    const question = await askQuestion('SETASIDE-1');
    await waitForPinned(question);
    const askedAt = getWaitingQuestionAskedAt();
    // Before the wait ends nothing is told to the agent and the message is as it was asked.
    assert.ok(Date.now() < askedAt + questionWaitMs - 1000, 'precondition: the wait has not ended yet');
    assert.equal(getControlResponses().length, responsesBefore, 'the agent has heard nothing about its question yet');
    assert.ok(!question.text.includes(setAsideNote), 'the message has no set-aside note yet');
    assert.deepEqual(getSetAsideRecords(), [], 'nothing is set aside yet');

    const response = await waitForSetAsideDeny('the bot to tell the agent its question was set aside', responsesBefore);
    assertToldToGoOn(response);
    assert.ok(response.readAt >= askedAt + questionWaitMs - 50, `not before the wait ended: ${response.readAt - askedAt} ms after the ask`);
    assert.ok(response.readAt <= askedAt + questionWaitMs + setAsideLatenessMs, `and at its end: ${response.readAt - askedAt} ms after the ask`);

    // Load-bearing: the turn WENT ON after the deny — the fake ends it with its fixed text only for a set-aside question.
    await waitingTopic.waitForMessage('the agent\'s turn going on after its question was set aside', (message) => message.message_id > question.message_id && message.text.includes(fakeAskSetAsideTurnText));
    assert.deepEqual(getControlRequests().filter((request) => request.readAt >= askedAt && request.subtype === 'interrupt'), [], 'no interrupt was sent to the agent');
    assert.ok(topic.listMessages().every((message) => !message.text.includes(enDict['agent.question_cancelled_for_prompt'])), 'and no «question cancelled» notice was posted');

    await waitingTopic.waitForMessageText('the set-aside note under the question', question, (text) => text.endsWith(`\n\n${setAsideNote}`));
    const [record, ...others] = await waitForSetAsideRecords(1);
    const state = readPersistedState(getLayout());
    assert.equal(state.pendingQuestions?.[topicKey], undefined, 'the question no longer counts as the one the agent is blocked on');
    assert.deepEqual(others, []);
    assert.equal(record.messageId, question.message_id);
    assert.deepEqual(record.answers, [null]);
    assert.equal(record.askedAt, askedAt, 'the record keeps the moment of the ask');
    assert.ok(record.setAsideAt >= askedAt + questionWaitMs - 50, 'and the moment it was set aside');
    assert.equal(state.setAsideQuestionSequences?.[topicKey], 1, 'the record id comes from a counter');
    assertShownAsSetAside(question, record, firstQuestion, 2);
  });

  it('a prompt the bot delivers while the question waits does not cancel it: it is set aside when its wait ends, and the prompt is read after it', async () => {
    const recordsBefore = getSetAsideRecords().length;
    const responsesBefore = getControlResponses().length;
    const question = await askQuestion('SETASIDE-2', 'ask', ` ${fakeScheduleOnceToken(2, 'SCHED-1')}`);
    await waitForPinned(question);
    const askedAt = getWaitingQuestionAskedAt();

    // The agent's own schedule fires inside the wait: a prompt reaches the agent's session while the question waits for the owner.
    await getCharness().waitFor('the scheduled prompt to fire into the topic', replyTimeoutMs, () => fakeTelegram.listBotMessages(topicThreadId).some((message) => message.message_id > question.message_id && message.text.includes('SCHED-1')));
    assert.notEqual(readKeptMessage(question).reply_markup, undefined, 'the prompt left the question as it was: its buttons');
    assert.ok(readPersistedState(getLayout()).pendingQuestions?.[topicKey], 'the question still waits');

    const response = await waitForSetAsideDeny('the bot to tell the agent its question was set aside', responsesBefore);
    assertToldToGoOn(response);
    assert.ok(response.readAt >= askedAt + questionWaitMs - 50 && response.readAt <= askedAt + questionWaitMs + setAsideLatenessMs, `at the end of the wait, whatever else the agent is sent: ${response.readAt - askedAt} ms after the ask`);

    // The queued prompt is taken in once the turn that waited on the question is over: its answer comes after the turn text.
    const turnEnd = await waitingTopic.waitForMessage('the agent\'s turn going on', (message) => message.message_id > question.message_id && message.text.includes(fakeAskSetAsideTurnText));
    await waitingTopic.waitForMessage('the scheduled prompt answered', (message) => message.message_id > turnEnd.message_id && message.text.includes('Working on SCHED-1'));
    assert.equal(getAgentPrompts('SCHED-1 [fake:answer] scheduled').length, 1, 'the agent read the scheduled prompt once');
    await waitingTopic.waitForMessageText('the set-aside note under the question', question, (text) => text.endsWith(`\n\n${setAsideNote}`));
    await waitForSetAsideRecords(recordsBefore + 1);
  });

  it('two questions in one call, the first answered by a tap: the agent gets that answer when the wait ends, and the second stays open as the set-aside record', async () => {
    const recordsBefore = getSetAsideRecords().length;
    const responsesBefore = getControlResponses().length;
    const first = await askQuestion('SETASIDE-3', 'ask-two');
    const askedAt = getWaitingQuestionAskedAt();
    await topic.tapAndAwaitAnswer(first, 'qa_0_0');
    assert.ok(Date.now() < askedAt + questionWaitMs - 1000, 'precondition: the tap came before the wait ended');
    const second = await topic.waitForMessage('the second question', (message) => message.message_id > first.message_id && message.text.includes(fakeAskSecondQuestion.question) && topic.getKeyboardData(message).flat().some((data) => data.startsWith('qa_1_')));
    await topic.waitForMessageText('the first question\'s answer', first, (text) => text.endsWith(buildAnsweredNote(fakeAskQuestion.shortOptionLabel)));
    await waitForPinned(second);

    const response = await waitForSetAsideDeny('the bot to tell the agent the second question was set aside', responsesBefore);
    assertToldToGoOn(response);
    // The answer already given goes with the text, so the agent does not lose it.
    assert.ok(
      response.message?.endsWith(`(Answers already given in this call: ${JSON.stringify(fakeAskQuestion.question)} = ${JSON.stringify(fakeAskQuestion.shortOptionLabel)}.)`),
      `the given answer is named: ${response.message}`,
    );
    await waitingTopic.waitForMessageText('the set-aside note under the second question', second, (text) => text.endsWith(`\n\n${setAsideNote}`));
    const records = await waitForSetAsideRecords(recordsBefore + 1);
    const record = records[records.length - 1];
    assert.deepEqual(record.answers, [[fakeAskQuestion.shortOptionLabel], null], 'the first answer is kept, the second is open');
    assert.equal(record.messageId, second.message_id, 'the record is the second question\'s message');
    assertShownAsSetAside(second, record, secondQuestion, 2);
    assert.ok(readKeptMessage(first).text.endsWith(buildAnsweredNote(fakeAskQuestion.shortOptionLabel)), 'the answered question keeps its answer');
    await waitingTopic.waitForMessage('the agent going on', (message) => message.message_id > second.message_id && message.text.includes(fakeAskSetAsideTurnText));
  });

  it('a restart while the question waits: it is set aside at the ORIGINAL moment of its wait, not after a new one — and a restart after that keeps the record and the buttons', async () => {
    const recordsBefore = getSetAsideRecords().length;
    const responsesBefore = getControlResponses().length;
    const question = await askQuestion('SETASIDE-4');
    await waitForPinned(question);
    const originalAskedAt = getWaitingQuestionAskedAt();

    // The bot goes down with the question waiting, and the state is edited as if the question had been asked long before the
    // restart: only 500 ms of its wait are left. A bot that started a fresh wait at boot would tell the agent a whole wait later.
    charness = await restartCharnessWithState(getLayout(), fakeTelegram, getCharness(), (persisted) => {
      const pending = persisted.pendingQuestions?.[topicKey];
      assert.ok(pending, 'the waiting question was saved');
      pending.askedAt = Date.now() - (questionWaitMs - 500);
    });
    const restartedAt = Date.now();
    const response = await waitForSetAsideDeny('the bot to tell the agent its question was set aside after the restart', responsesBefore);
    assertToldToGoOn(response);
    assert.ok(response.readAt < restartedAt + 3000, `at the original moment (${response.readAt - restartedAt} ms after the boot), not a whole wait (${questionWaitMs} ms) after it`);
    await waitingTopic.waitForMessage('the agent going on', (message) => message.message_id > question.message_id && message.text.includes(fakeAskSetAsideTurnText));
    await waitingTopic.waitForMessageText('the set-aside note under the question', question, (text) => text.endsWith(`\n\n${setAsideNote}`));
    await waitForSetAsideRecords(recordsBefore + 1);
    assert.ok(originalAskedAt < restartedAt - 1000, 'precondition: the question was asked well before the restart finished');

    // A restart after the wait: the record, the message and its buttons are as they were.
    const recordsAfterSetAside = getSetAsideRecords();
    charness = await restartCharnessWithState(getLayout(), fakeTelegram, getCharness(), () => {});
    assert.deepEqual(getSetAsideRecords(), recordsAfterSetAside, 'the record survives the restart');
    assertShownAsSetAside(question, recordsAfterSetAside[recordsAfterSetAside.length - 1], firstQuestion, 2);
  });

  it('a sixth open set-aside question closes the oldest as «not answered» and releases its pin; the others keep theirs, and a question asked meanwhile is pinned beside them', async () => {
    const oldestRecord = getSetAsideRecords()[0];
    assert.equal(getSetAsideRecords().length, 4, 'precondition: four questions are set aside');
    assert.notEqual(oldestRecord.messageId, null);
    const oldestMessage = readKeptMessageById(oldestRecord.messageId ?? -1);
    assert.ok(fakeTelegram.listPinnedMessageIds().includes(oldestMessage.message_id), 'precondition: the oldest is pinned');

    const fifth = await askQuestion('SETASIDE-5');
    // A new question is pinned beside the set-aside ones: its pin does not retire theirs.
    await waitForPinned(fifth);
    for (const record of getSetAsideRecords()) assert.ok(fakeTelegram.listPinnedMessageIds().includes(record.messageId ?? -1), `the pin of set-aside question ${record.id} stays beside the new question's`);
    await waitingTopic.waitForMessageText('the set-aside note under the fifth question', fifth, (text) => text.endsWith(`\n\n${setAsideNote}`));
    await waitForSetAsideRecords(5);

    const sixth = await askQuestion('SETASIDE-6');
    await waitForPinned(sixth);
    await waitingTopic.waitForMessageText('the set-aside note under the sixth question', sixth, (text) => text.endsWith(`\n\n${setAsideNote}`));
    await waitingTopic.waitForMessageText('the oldest question closed', oldestMessage, (text) => text.endsWith(`\n\n${unansweredNote}`));

    // Six were set aside, five stay open: the saved list is five, with the sixth last.
    await getCharness().waitFor('the saved list to end with the sixth question', replyTimeoutMs, () => getSetAsideRecords().at(-1)?.messageId === sixth.message_id);
    const records = await waitForSetAsideRecords(5);
    assert.ok(!records.some((record) => record.id === oldestRecord.id), 'the oldest is the one that went');
    assert.equal(records[records.length - 1].messageId, sixth.message_id, 'the newest is the sixth');
    assert.equal(new Set(records.map((record) => record.id)).size, 5, 'every record has an id of its own');
    assert.equal(readPersistedState(getLayout()).setAsideQuestionSequences?.[topicKey], 6, 'six questions were ever set aside, and the counter never goes back');
    const closed = readKeptMessage(oldestMessage);
    assert.equal(closed.reply_markup, undefined, 'the closed question has no buttons');
    assert.ok(closed.text.includes(fakeAskQuestion.question), 'it stays readable');
    await getCharness().waitFor('the oldest question\'s pin to be released', replyTimeoutMs, () => !fakeTelegram.listPinnedMessageIds().includes(oldestMessage.message_id));
    for (const record of records) assert.ok(fakeTelegram.listPinnedMessageIds().includes(record.messageId ?? -1), `set-aside question ${record.id} keeps its pin`);
  });
});
