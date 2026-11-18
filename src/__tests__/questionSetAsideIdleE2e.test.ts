/**
 * @description The idle mark meets a question nobody answered, at PROCESS level: the BUILT charness started the way an isolated
 * instance is (`scripts/run-isolated.sh`) against the fake Bot API of `telegramE2e/fakeTelegram.ts`, with the fake `claude`
 * (`jiraE2e/fakeClaude.ts`, mode `ask`) putting a real `AskUserQuestion` to the topic. The instance keeps the DEFAULT question wait
 * (30 min) and its idle window is cut to seconds (`AGENT_IDLE_MINUTES`), so the idle mark comes long before the wait ends. One
 * flow, in order:
 *
 *   boot → the topic is bound → `/claude` → one answered turn (so the idle compaction has something to compress)
 *   → a question nobody answers: at the idle mark the agent is told «no answer yet, go on» — the question's tool call is DENIED
 *     with the bot's text, no interrupt, no compaction turn, no stop, no «asked again» message — and the agent's turn goes on (the
 *     proof: it ends with the fake's fixed text); the question stays in the topic with its note, its buttons and its pin, saved as
 *     a set-aside record
 *   → the next idle window, with nothing waiting any more: the conversation is compacted and stopped as any quiet one is, and the
 *     question stays open and pinned through it
 *   → a tap on that question's button wakes the sleeping conversation and the late answer reaches the resumed process
 *
 * The other choice — «Wait for my answer», where the idle fire keeps rejecting, compacting and asking again — is
 * `reaskedQuestionE2e.test.ts` (its instance sets `questionWait` in `settings.json`).
 *
 * Nothing leaves the machine: the Bot API is on loopback and the agent is a fake. Everything the test starts is stopped in `after`.
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
  fakeAskSetAsideTurnText,
  fakeClaudeLogFileNames,
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
import { readPersistedState, startCharnessOnInstance } from './e2e/fallbackFlowKit';
import { assertShownAsSetAside, assertToldToGoOn, firstAskedQuestion } from './e2e/setAsideFlowKit';
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';
import type { SetAsideQuestionRecord } from '../types';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const topicThreadId = 111;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const projectFolder = 'proj';

/** The idle window of the instance, in minutes (12 s): the fire comes this long after the last activity. */
const idleWindowMinutes = '0.2';
const replyTimeoutMs = 20 * 1000;
const agentStartTimeoutMs = 60 * 1000;
/** The idle mark follows the ask by the idle window, a send and the agent's turn after it; the compaction and the stop follow the next window. */
const idleTimeoutMs = 90 * 1000;
/** The default question wait (30 min) is far longer than this: a set-aside that comes inside it is the idle mark's. */
const clearlyBeforeTheWaitMs = 5 * 60 * 1000;
/** The line the bot logs once the idle fire has stopped the agent's process (the conversation then sleeps). */
const idleStopLine = 'process stopped; the session sleeps';
const answeredNote = (answer: string): string => enDict['agent.question_answered_note'].replace('{answer}', answer);
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

/** One record per `/compact` turn the fake agent ran. */
function countCompactions(): number {
  return readJsonLines<{ sessionId: string; pid: number }>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.compactions)).length;
}

function countIdleStops(): number {
  return getCharness().output.split(idleStopLine).length - 1;
}

function getSetAsideRecords(): SetAsideQuestionRecord[] {
  return readPersistedState(getLayout()).setAsideQuestions?.[topicKey] ?? [];
}

/** The `askedAt` the bot saved for the question that waits now. */
function getWaitingQuestionAskedAt(): number {
  const askedAt = readPersistedState(getLayout()).pendingQuestions?.[topicKey]?.askedAt;
  assert.equal(typeof askedAt, 'number', 'the waiting question is saved with the moment it was asked');
  return askedAt as number;
}

/** Put the question (`ask` mode): resolves its message once it carries the option buttons. */
async function askQuestion(promptLabel: string): Promise<FakeTelegramMessage> {
  const sentMessageId = fakeTelegram.pushOperatorMessage(topicThreadId, `${promptLabel} [fake:ask] ask me something`);
  return topic.waitForMessage(`the question of ${promptLabel}`, (message) =>
    message.message_id > sentMessageId
    && message.text.includes(fakeAskQuestion.question)
    && topic.getKeyboardData(message).flat().some((data) => data.startsWith('qa_')));
}

describe('The idle mark sets a waiting question aside instead of compacting, end to end: built charness, fake Bot API', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-set-aside-idle-', [projectFolder], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    topic = new TopicDriver(fakeTelegram, getCharness, topicThreadId, replyTimeoutMs);
    waitingTopic = new TopicDriver(fakeTelegram, getCharness, topicThreadId, idleTimeoutMs);
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
      AGENT_IDLE_MINUTES: idleWindowMinutes,
      // A free port nothing listens on: the boot's OpenCode pre-start finds no server and no binary, and gives up.
      OPENCODE_URL: `http://127.0.0.1:${await getUnservedPort()}`,
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

  /** The question the first step set aside, for the steps after it. */
  let question: FakeTelegramMessage;
  let record: SetAsideQuestionRecord;

  it('boots Telegram-only against the fake Bot API, binds the topic, starts the fake agent and gives it one answered turn', async () => {
    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    await topic.sendAndAwaitReply(`/bind ${projectFolder}`, `Bound to \`${projectFolder}\``);
    await topic.sendAndAwaitReply('/claude', 'ready in');
    fakeTelegram.pushOperatorMessage(topicThreadId, 'WARM-1 [fake:answer] hello');
    await getCharness().waitFor('the warm-up turn to reach the agent', agentStartTimeoutMs, () => getAgentPrompts('WARM-1').length > 0);
  });

  it('a question still waiting at the idle mark is set aside: the agent is told to go on and does — no interrupt, no compaction, no stop, no «asked again» — and the message keeps its buttons and its pin', async () => {
    const compactionsBefore = countCompactions();
    const stopsBefore = countIdleStops();
    const responsesBefore = getControlResponses().length;
    question = await askQuestion('IDLE-1');
    const askedAt = getWaitingQuestionAskedAt();

    await getCharness().waitFor('the bot to tell the agent its question was set aside', idleTimeoutMs, () => getControlResponses().length > responsesBefore);
    const response = getControlResponses()[responsesBefore];
    assertToldToGoOn(response);
    assert.ok(response.readAt < askedAt + clearlyBeforeTheWaitMs, `it came at the idle mark, long before the 30-minute wait: ${response.readAt - askedAt} ms after the ask`);

    // Load-bearing: the turn WENT ON after the deny — the fake ends it with its fixed text only for a set-aside question.
    await waitingTopic.waitForMessage('the agent\'s turn going on after its question was set aside', (message) => message.message_id > question.message_id && message.text.includes(fakeAskSetAsideTurnText));
    assert.deepEqual(getControlRequests().filter((request) => request.readAt >= askedAt && request.subtype === 'interrupt'), [], 'no interrupt was sent to the agent');
    assert.equal(countCompactions(), compactionsBefore, 'no compaction turn was written to the agent');
    assert.equal(countIdleStops(), stopsBefore, 'the process was not stopped');
    assert.ok(topic.listMessages().every((message) => !topic.getKeyboardData(message).flat().some((data) => data.startsWith('reask_')) && !message.text.includes(enDict['agent.question_asked_again_note'])), 'nothing asks the question again');
    assert.ok(topic.listMessages().every((message) => !message.text.includes(enDict['agent.question_cancelled_for_prompt'])), 'and nothing says it was cancelled');

    await waitingTopic.waitForMessageText('the set-aside note under the question', question, (text) => text.endsWith(`\n\n${enDict['agent.question_set_aside_note']}`));
    await getCharness().waitFor('the question to be saved as a set-aside record', replyTimeoutMs, () => getSetAsideRecords().length === 1);
    const [saved] = getSetAsideRecords();
    record = saved;
    assert.equal(record.messageId, question.message_id);
    assert.equal(record.askedAt, askedAt, 'the record keeps the moment of the ask');
    assert.equal(readPersistedState(getLayout()).pendingQuestions?.[topicKey], undefined, 'the question no longer counts as the one the agent is blocked on');
    assertShownAsSetAside(fakeTelegram, topic, question, record, firstAskedQuestion, 2);
  });

  it('the next idle window, with nothing waiting any more, compacts and stops the conversation as it does a quiet one — and the question stays open and pinned through it', async () => {
    const compactionsBefore = countCompactions();
    const stopsBefore = countIdleStops();
    await getCharness().waitFor('the idle compaction of the conversation', idleTimeoutMs, () => countCompactions() > compactionsBefore);
    await getCharness().waitFor('the idle stop that follows it', agentStartTimeoutMs, () => countIdleStops() > stopsBefore);

    assert.deepEqual(getSetAsideRecords(), [record], 'the record is the one it was');
    assertShownAsSetAside(fakeTelegram, topic, question, record, firstAskedQuestion, 2);
    assert.ok(topic.listMessages().every((message) => !topic.getKeyboardData(message).flat().some((data) => data.startsWith('reask_'))), 'and the stop asked nothing again');
  });

  it('a tap on the question\'s button wakes the sleeping conversation: the late answer reaches the RESUMED process', async () => {
    const askingPid = getAgentPrompts('IDLE-1')[0]?.pid;
    assert.ok(askingPid !== undefined, 'the process that put the question');
    const lateAnswerHeader = '[Late answer to your question asked ';
    const promptsBefore = getAgentPrompts(lateAnswerHeader).length;

    assert.equal(await topic.tapAndAwaitAnswer(question, `qs_${record.id}_0`), fakeAskQuestion.shortOptionLabel);
    await getCharness().waitFor('the late answer to reach the agent', agentStartTimeoutMs, () => getAgentPrompts(lateAnswerHeader).length > promptsBefore);
    const prompt = getAgentPrompts(lateAnswerHeader)[promptsBefore];
    assert.notEqual(prompt.pid, askingPid, 'it was read by a process started AFTER the one that asked');
    assert.ok(prompt.text.includes(`Answer: ${fakeAskQuestion.shortOptionLabel}\n`), prompt.text);
    await topic.waitForMessageText('the answer under the question', question, (text) => text.endsWith(`\n\n${answeredNote(fakeAskQuestion.shortOptionLabel)}`));
    await getCharness().waitFor('the record to be gone', replyTimeoutMs, () => getSetAsideRecords().length === 0);
  });
});
