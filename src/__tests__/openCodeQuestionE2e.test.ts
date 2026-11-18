/**
 * @description A question the OpenCode agent asks stays in the topic however it ends, at PROCESS level: the BUILT charness
 * started the way an isolated instance is (`scripts/run-isolated.sh`) against the fake Bot API
 * (`telegramE2e/fakeTelegram.ts`) and the fake OpenCode server (`openCodeE2e/fakeOpenCodeServer.ts`), which can put a
 * question to the user whenever a flow says (the fake Claude agent cannot ask without a person's message). Five flows:
 *
 *   the idle compaction re-asked a question → the agent asks a NEW question while the re-asked copy waits: the copy is
 *     closed as «not answered» and keeps its text, and its button never answers the new question;
 *   a prompt the server refuses while a question is open → the adapter reports the error: the topic gets the error line,
 *     and the question stays with the «not answered» note, its buttons gone and its pin released;
 *   the question tool's own «🔧 question…» status that waits behind unposted text while the question arrives → it is
 *     never posted: no status line lands under the question;
 *   a question nobody answers within the question wait (cut to seconds) → the server gets a REPLY whose custom answer is the bot's
 *     «no answer yet, go on» text and never a reject (a reject ends OpenCode's agent loop), the question's message keeps its
 *     buttons and its pin and gains a note, and it is saved as a set-aside record; a later tap on its button sends the late
 *     answer to the server as a prompt and closes the message with the answer;
 *   the server refuses the reply that sets a question aside every time → the bot hands the server's question to itself again, tells the
 *     agent again after each pause, and after the last try says so in the topic AND rewrites the pinned message's own note («the server did
 *     not confirm it — if the agent seems stuck, send it any message», its buttons and pin kept — a statement about the message, never about
 *     the agent now); the owner's message after the notice moves the agent on (the wedge abort) and the note is still true; a later tap on its
 *     button still answers it.
 *
 * What the json-stream flows cover instead: `questionKeptE2e.test.ts` (answer, number, another message, `/esc`, `/quit`,
 * re-post, the re-ask in every phase, a restart).
 *
 * Nothing leaves the machine: the Bot API and the OpenCode server are on loopback. Everything the test starts is stopped
 * in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram, type FakeTelegramMessage } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import { FakeOpenCodeServer, writeFakeOpenCodeBinary } from './openCodeE2e/fakeOpenCodeServer';
import { setAsideRetryLimit } from '../connectors/telegram/commands/questionSetAside';
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
  writeInstanceSettingsFile,
  type IsolatedInstanceLayout,
} from './e2e/isolatedCharness';
import { readPersistedState, startCharnessOnInstance } from './e2e/fallbackFlowKit';
import { enDict } from '../i18n/en';
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';
import { keyToString } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';

const questionTopic = { threadId: 181, folder: 'ask-opencode' };
const fakeOpenCodeVersion = '1.17.11';
const model = 'example/model-one';
const openCodeModels = [model] as const;
const replyTimeoutMs = 20 * 1000;
/** The idle window of the first flow's instance, in minutes (12 s): the fire that compacts and re-asks comes this long after the last activity. */
const idleWindowMinutes = '0.2';
/** The re-asked question follows the idle window by a rejected question, an abort, a compaction and a paced send. */
const reaskTimeoutMs = 90 * 1000;
/** The status a refused prompt is answered with: a client error, which the adapter does not retry. */
const refusedPromptStatus = 400;
const errorLinePrefix = 'Error:';

const firstQuestion = { requestId: 'que_oc_1', header: 'Lexer', question: 'Which lexer should I write?', labels: ['hand-written', 'regex'] } as const;
const secondQuestion = { requestId: 'que_oc_2', header: 'Parser', question: 'Which parser should I write?', labels: ['recursive descent', 'table-driven'] } as const;
type AskedQuestion = typeof firstQuestion | typeof secondQuestion;

const unansweredNote = enDict['agent.question_unanswered_note'];
const askedAgainNote = enDict['agent.question_asked_again_note'];

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let fakeOpenCode: FakeOpenCodeServer;
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

/** Lay out a fresh instance with its fake Bot API and fake OpenCode server; `extraEnv` is what the flow adds to the env file. */
async function setUpInstance(layoutPrefix: string, extraEnv: Record<string, string>): Promise<void> {
  if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
  layout = createIsolatedInstanceLayout(layoutPrefix, [questionTopic.folder], getFlowDeadlineMs());
  defaultTmuxSessionsBefore = listTmuxSessions([]);

  process.on('exit', removeInstanceSync);
  process.once('SIGINT', exitOnSignal);
  process.once('SIGTERM', exitOnSignal);

  fakeTelegram = new FakeTelegram({ botUser, operator, group });
  topic = new TopicDriver(fakeTelegram, getCharness, questionTopic.threadId, replyTimeoutMs);
  waitingTopic = new TopicDriver(fakeTelegram, getCharness, questionTopic.threadId, reaskTimeoutMs);
  const apiRoot = await fakeTelegram.start();
  fakeOpenCode = new FakeOpenCodeServer({ version: fakeOpenCodeVersion, models: openCodeModels, defaultModel: model });
  const openCodeUrl = await fakeOpenCode.start(await getFreePort());
  writeFakeOpenCodeBinary(layout.binDir, { version: fakeOpenCodeVersion, models: openCodeModels });
  writeInstanceEnvFile(layout, {
    TELEGRAM_BOT_TOKEN: fakeBotToken,
    TELEGRAM_API_ROOT: apiRoot,
    ALLOWED_GROUP_ID: group.id.toString(),
    CHAT_MODE: 'group',
    DATA_DIR: layout.dataDir,
    WORK_ROOT: layout.workRoot,
    TMUX_TMPDIR: layout.tmuxTmpDir,
    CLAUDE_BIN: writeFakeClaudeLauncher(layout, null),
    OPENCODE_URL: openCodeUrl,
    SCHEDULER_MCP_PORT: (await getFreeFixedPort()).toString(),
    ...getTelegramFlowTestTimingsEnv(),
    ...extraEnv,
  });
}

async function tearDownInstance(): Promise<void> {
  await charness?.stop();
  removeInstanceSync();
  await fakeTelegram?.stop();
  await fakeOpenCode?.stop();
  process.off('exit', removeInstanceSync);
  process.off('SIGINT', exitOnSignal);
  process.off('SIGTERM', exitOnSignal);
  assert.deepEqual(listTmuxSessions([]), defaultTmuxSessionsBefore, 'the default tmux server was not touched');
  assert.deepEqual(fakeOpenCode.unhandled, [], 'the bot asked the fake OpenCode for nothing it does not model');
}

function getTopicSessionId(): string {
  const folderPath = path.join(getLayout().workRoot, questionTopic.folder);
  const session = [...fakeOpenCode.sessions.values()].find((candidate) => candidate.directory === folderPath);
  assert.ok(session, `a fake OpenCode session for ${folderPath}`);
  return session.id;
}

/** Bind the topic, start the OpenCode session, send a prompt and let the turn run: it has streamed some words. */
async function bootBindAndStartTurn(promptLabel: string): Promise<string> {
  charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
  await topic.sendAndAwaitReply(`/bind ${questionTopic.folder}`, `Bound to \`${questionTopic.folder}\``);
  await topic.sendAndAwaitReply('/opencode', 'ready in');
  fakeTelegram.pushOperatorMessage(questionTopic.threadId, `${promptLabel} write the compiler`);
  await getCharness().waitFor(`the prompt ${promptLabel} to reach the server`, replyTimeoutMs, () => fakeOpenCode.prompts.some((prompt) => prompt.text.includes(promptLabel)));
  const sessionId = getTopicSessionId();
  fakeOpenCode.emitSessionBusy(sessionId);
  fakeOpenCode.emitAssistantText(sessionId, `msg_${promptLabel}`, 'I need a decision.');
  await topic.waitForMessage('the words streamed so far', (message) => message.text.includes('I need a decision.'));
  return sessionId;
}

/** The agent puts `asked` to the user: resolves the message that carries its option buttons. */
async function askQuestion(sessionId: string, asked: AskedQuestion): Promise<FakeTelegramMessage> {
  fakeOpenCode.emitQuestionAsked(sessionId, asked.requestId, [{ question: asked.question, header: asked.header, options: asked.labels.map((label) => ({ label })) }]);
  return topic.waitForMessage(`the question «${asked.question}»`, (message) =>
    message.text.includes(asked.question) && topic.getKeyboardData(message).flat().some((data) => data.startsWith('qa_')));
}

async function waitForPinned(message: FakeTelegramMessage): Promise<void> {
  await getCharness().waitFor(`message ${message.message_id} to be pinned`, replyTimeoutMs, () => fakeTelegram.listPinnedMessageIds().includes(message.message_id));
}

async function waitForUnpinned(message: FakeTelegramMessage): Promise<void> {
  await getCharness().waitFor(`message ${message.message_id} to be unpinned`, replyTimeoutMs, () => !fakeTelegram.listPinnedMessageIds().includes(message.message_id));
}

/** The question message as the topic holds it NOW: it exists, is not deleted, ends with `note`, and has no buttons. */
function assertKeptWithNote(message: FakeTelegramMessage, note: string, asked: AskedQuestion): void {
  const current = fakeTelegram.getMessage(message.message_id);
  assert.ok(current && !current.isDeleted, `message ${message.message_id} is still in the topic`);
  for (const part of [asked.header, asked.question]) assert.ok(current.text.includes(part), `the question's «${part}» stays: ${current.text}`);
  assert.ok(current.text.endsWith(`\n\n${note}`), `the text ends with the note «${note}»: ${current.text.slice(-80)}`);
  assert.equal(current.reply_markup, undefined, 'the buttons are gone');
}

describe('A question the idle compaction re-asked stays when the OpenCode agent asks a new one, end to end: built charness, fake Bot API, fake OpenCode', () => {
  before(async () => {
    await setUpInstance('charness-ocask-idle-', { AGENT_IDLE_MINUTES: idleWindowMinutes });
    // The idle fire asks the question again only for «Wait for my answer»; any other wait sets it aside (`questionSetAsideIdleE2e.test.ts`).
    writeInstanceSettingsFile(getLayout(), { questionWait: 'untilAnswered' });
  });

  after(tearDownInstance);

  it('a question left open at the idle mark is rejected, the conversation compacted and the question asked again with its own buttons', async () => {
    const sessionId = await bootBindAndStartTurn('IDLE-1');
    const original = await askQuestion(sessionId, firstQuestion);
    await waitForPinned(original);

    const reasked = await waitingTopic.waitForMessage('the re-asked question', (message) =>
      message.message_id > original.message_id && waitingTopic.getKeyboardData(message).flat().some((data) => data.startsWith('reask_')));
    assert.equal(fakeOpenCode.listRequests('POST', `/question/${firstQuestion.requestId}/reject`).length, 1, 'the idle fire rejects the open question on the server');
    assert.equal(fakeOpenCode.listRequests('POST', `/session/${sessionId}/summarize`).length, 1, 'and compacts the conversation');
    await waitingTopic.waitForMessageText('the old question marked as asked again', original, (text) => text.endsWith(`\n\n${askedAgainNote}`));
    assertKeptWithNote(original, askedAgainNote, firstQuestion);
    assert.deepEqual(waitingTopic.getKeyboardData(reasked), [['reask_0'], ['reask_1']], 'one live button per option');
  });

  it('the agent asks a new question while the re-asked copy waits: the copy is closed as «not answered», and its button never answers the new question', async () => {
    const sessionId = getTopicSessionId();
    const reasked = topic.listMessages().find((message) => topic.getKeyboardData(message).flat().some((data) => data.startsWith('reask_')));
    assert.ok(reasked, 'the re-asked copy that waits');
    const promptsBefore = fakeOpenCode.prompts.length;

    const newer = await askQuestion(sessionId, secondQuestion);
    await waitForPinned(newer);

    // The copy keeps what it asked and says it ended without an answer; its buttons are gone, so no tap can reach the new question.
    await topic.waitForMessageText('the re-asked copy closed as not answered', reasked, (text) => text.endsWith(`\n\n${unansweredNote}`));
    assert.equal(fakeTelegram.getMessage(reasked.message_id)?.reply_markup, undefined, 'its buttons are gone');
    assert.equal(await topic.tapAndAwaitAnswer(reasked, 'reask_0'), enDict['cb.no_pending_question'], 'a tap on the old button answers nothing');
    assert.equal(fakeOpenCode.prompts.length, promptsBefore, 'and sends no label to the agent');

    // The new question is as it was asked: still waiting, with its buttons, and the tap on IT answers it.
    assert.deepEqual(topic.getKeyboardData(fakeTelegram.getMessage(newer.message_id) ?? newer), [['qa_0_0'], ['qa_0_1']], 'the new question keeps its buttons');
    const repliesBefore = fakeOpenCode.listRequests('POST', `/question/${secondQuestion.requestId}/reply`).length;
    await topic.tapAndAwaitAnswer(newer, 'qa_0_0');
    await getCharness().waitFor('the answer to reach the server', replyTimeoutMs, () => fakeOpenCode.listRequests('POST', `/question/${secondQuestion.requestId}/reply`).length > repliesBefore);
    await waitForUnpinned(newer);
  });
});

describe('A question stays when the server refuses a prompt while it is open, end to end: built charness, fake Bot API, fake OpenCode', () => {
  before(async () => {
    await setUpInstance('charness-ocask-error-', {});
  });

  after(tearDownInstance);

  it('the adapter reports the refused prompt: the topic gets the error line, and the question stays with the «not answered» note, its buttons gone and its pin released', async () => {
    // The server takes its time over a prompt (the request is held), the agent asks a question meanwhile, and then the
    // server refuses the prompt: the adapter reports the error while the question is open.
    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    await topic.sendAndAwaitReply(`/bind ${questionTopic.folder}`, `Bound to \`${questionTopic.folder}\``);
    await topic.sendAndAwaitReply('/opencode', 'ready in');
    const sessionId = getTopicSessionId();
    let refusePrompt: (status: number | null) => void = () => {};
    const refusal = new Promise<number | null>((resolve) => { refusePrompt = resolve; });
    fakeOpenCode.holdNextRequest('POST', new RegExp(`^/session/${sessionId}/prompt_async$`), refusal);
    try {
      const promptRequestsBefore = fakeOpenCode.listRequests('POST', `/session/${sessionId}/prompt_async`).length;
      fakeTelegram.pushOperatorMessage(questionTopic.threadId, 'REFUSED-1 write the compiler');
      await getCharness().waitFor('the prompt to reach the server, held', replyTimeoutMs, () => fakeOpenCode.listRequests('POST', `/session/${sessionId}/prompt_async`).length > promptRequestsBefore);
      const question = await askQuestion(sessionId, firstQuestion);
      await waitForPinned(question);

      refusePrompt(refusedPromptStatus);
      await topic.waitForMessage('the error line', (message) => message.text.startsWith(errorLinePrefix));
      await topic.waitForMessageText('the note under the question', question, (text) => text.endsWith(`\n\n${unansweredNote}`));
      assertKeptWithNote(question, unansweredNote, firstQuestion);
      await waitForUnpinned(question);
      assert.equal(await topic.tapAndAwaitAnswer(question, 'qa_0_0'), enDict['cb.no_pending_question'], 'the question is closed for good: a stale tap answers nothing');
    } finally {
      refusePrompt(null);
    }
  });
});

describe('The question tool\'s status that the question outran stays out of the topic, end to end: built charness, fake Bot API, fake OpenCode', () => {
  before(async () => {
    await setUpInstance('charness-ocask-status-', {});
  });

  after(tearDownInstance);

  it('a «🔧 question…» status that waited behind unposted text while the question arrived is never posted — no status line lands under the question', async () => {
    const statusFrameText = '🔧 question...';
    const topicKey = `${group.id}:${questionTopic.threadId}`;
    const isPosted = (text: string): boolean => fakeTelegram.listCalls('sendMessage').some((call) => String(call.payload.text).includes(text));
    // The status frame is the whole text `🔧 question...`.
    const isStatusFramePosted = (): boolean => fakeTelegram.listCalls('sendMessage').some((call) => call.payload.text === statusFrameText);
    const botLogIncludes = (text: string): boolean => getCharness().output.includes(text);

    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    await topic.sendAndAwaitReply(`/bind ${questionTopic.folder}`, `Bound to \`${questionTopic.folder}\``);
    await topic.sendAndAwaitReply('/opencode', 'ready in');
    fakeTelegram.pushOperatorMessage(questionTopic.threadId, 'STATUS-1 write the compiler');
    await getCharness().waitFor('the prompt STATUS-1 to reach the server', replyTimeoutMs, () => fakeOpenCode.prompts.some((prompt) => prompt.text.includes('STATUS-1')));
    const sessionId = getTopicSessionId();
    fakeOpenCode.emitSessionBusy(sessionId);

    // The bot posts one message at a time per topic: with the agent's first words held on their Bot API round trip, everything
    // posted after them waits.
    let releaseRoundTrip: () => void = () => {};
    const roundTripReleased = new Promise<void>((resolve) => { releaseRoundTrip = resolve; });
    try {
      fakeTelegram.holdNextResponse('sendMessage', roundTripReleased, (payload) => String(payload.text).includes('I need a decision.'));
      fakeOpenCode.emitAssistantText(sessionId, 'msg_STATUS-1', 'I need a decision.');
      await getCharness().waitFor('the first words on their held round trip', replyTimeoutMs, () => isPosted('I need a decision.'));
      // More words reach the bot and stay in its output buffer behind the flush that is on the round trip.
      fakeOpenCode.emitAssistantText(sessionId, 'msg_STATUS-1', ' Let me ask you.');
      await getCharness().waitFor('the next words to reach the bot', replyTimeoutMs, () => botLogIncludes('Let me ask you.'));
      // The question tool's status is posted below the content, so it first lands that buffer — behind the held round trip.
      fakeOpenCode.emitToolPart(sessionId, 'msg_STATUS-1', 'question', { status: 'running' });
      const statusLogLine = `[Bot] status ${topicKey}: ${statusFrameText}`;
      await getCharness().waitFor('the question tool\'s status to reach the bot', replyTimeoutMs, () => botLogIncludes(statusLogLine));
      // The question itself arrives during that wait: its message replaces any status line.
      fakeOpenCode.emitQuestionAsked(sessionId, firstQuestion.requestId, [{ question: firstQuestion.question, header: firstQuestion.header, options: firstQuestion.labels.map((label) => ({ label })) }]);
      const questionLogLine = `[Bot] question ${topicKey} (${firstQuestion.requestId})`;
      await getCharness().waitFor('the question to reach the bot', replyTimeoutMs, () => botLogIncludes(questionLogLine));
      // The status did reach the bot, and before the question that supersedes it: without this the step would pass with no status at all.
      const botLog = getCharness().output;
      assert.ok(botLog.indexOf(statusLogLine) < botLog.indexOf(questionLogLine), 'the status reached the bot before the question');
      assert.equal(isStatusFramePosted(), false, 'the status frame is still waiting for the buffer to land');
    } finally {
      // A failure above must not leave the topic's send queue wedged behind the held round trip.
      releaseRoundTrip();
    }

    const question = await topic.waitForMessage(`the question «${firstQuestion.question}»`, (message) =>
      message.text.includes(firstQuestion.question) && topic.getKeyboardData(message).flat().some((data) => data.startsWith('qa_')));
    await waitForPinned(question);
    // A command's reply is posted after every send queued before it, a status frame created after the buffer landed included.
    await topic.sendAndAwaitReply('/verbosity stream', 'This topic shows: Stream only');
    assert.equal(isStatusFramePosted(), false, 'the superseded status frame was not created under the question');
  });
});

/** The `answers` matrix of a `POST /question/:id/reply` body: one list of answer texts per question. */
function readReplyAnswers(body: unknown): string[][] {
  if (typeof body !== 'object' || body === null || !('answers' in body) || !Array.isArray(body.answers)) throw new Error(`the reply carries no answers: ${JSON.stringify(body)}`);
  return body.answers.map((answer) => {
    if (!Array.isArray(answer)) throw new Error(`an answer is not a list of texts: ${JSON.stringify(answer)}`);
    return answer.map((text) => text.toString());
  });
}

describe('A question nobody answers is set aside on the OpenCode backend too, end to end: built charness, fake Bot API, fake OpenCode', () => {
  /** The question wait of the instance, in ms (production: 30 min by default). */
  const questionWaitMs = 6000;
  const setAsideTimeoutMs = 45 * 1000;
  const setAsideNote = enDict['agent.question_set_aside_note'];

  before(async () => {
    await setUpInstance('charness-ocask-aside-', { ...getTelegramFlowTestTimingsEnv({ questionSetAsideWaitMs: questionWaitMs }) });
  });

  after(tearDownInstance);

  it('the server gets a REPLY with the bot\'s «no answer yet, go on» text as the custom answer and never a reject; the message keeps its buttons and pin and gains a note', async () => {
    const sessionId = await bootBindAndStartTurn('ASIDE-1');
    const topicKey = keyToString(makeTelegramKey(group.id, questionTopic.threadId));
    const question = await askQuestion(sessionId, firstQuestion);
    await waitForPinned(question);
    const askedAt = readPersistedState(getLayout()).pendingQuestions?.[topicKey]?.askedAt;
    assert.equal(typeof askedAt, 'number', 'the waiting question is saved with the moment it was asked');
    assert.ok(Date.now() < (askedAt ?? 0) + questionWaitMs - 1000, 'precondition: the wait has not ended yet');
    assert.deepEqual(fakeOpenCode.listRequests('POST', `/question/${firstQuestion.requestId}/reply`), [], 'precondition: nothing was sent for the question yet');

    const waitingTopicForAside = new TopicDriver(fakeTelegram, getCharness, questionTopic.threadId, setAsideTimeoutMs);
    await getCharness().waitFor('the server to get the reply that sets the question aside', setAsideTimeoutMs, () => fakeOpenCode.listRequests('POST', `/question/${firstQuestion.requestId}/reply`).length > 0);
    const replies = fakeOpenCode.listRequests('POST', `/question/${firstQuestion.requestId}/reply`);
    assert.equal(replies.length, 1, 'one reply');
    const answers = readReplyAnswers(replies[0].body);
    assert.equal(answers.length, 1, 'one answer per question');
    assert.equal(answers[0].length, 1, 'a custom answer: one text');
    assert.ok(answers[0][0].startsWith('[Charness] The user has not answered yet (asked '), `the answer is the bot's text, not an option: ${answers[0][0]}`);
    assert.ok(answers[0][0].includes('This is NOT an answer.') && answers[0][0].includes('Go on with work that does not depend on it'), 'it says so, and to go on');
    // Load-bearing: never a reject — OpenCode ends its agent loop on one.
    assert.deepEqual(fakeOpenCode.listRequests('POST', `/question/${firstQuestion.requestId}/reject`), [], 'the question is never rejected');
    assert.ok(Date.now() >= (askedAt ?? 0) + questionWaitMs - 50, 'not before the wait ended');

    await waitingTopicForAside.waitForMessageText('the set-aside note under the question', question, (text) => text.endsWith(`\n\n${setAsideNote}`));
    // The bot saves its state a moment after it changes: read it once the record is there.
    await getCharness().waitFor('the set-aside question to be saved', replyTimeoutMs, () => (readPersistedState(getLayout()).setAsideQuestions?.[topicKey] ?? []).length === 1);
    const state = readPersistedState(getLayout());
    assert.equal(state.pendingQuestions?.[topicKey], undefined, 'the question no longer counts as the one the agent is blocked on');
    const [record, ...others] = state.setAsideQuestions?.[topicKey] ?? [];
    assert.deepEqual(others, []);
    assert.equal(record.messageId, question.message_id);
    assert.deepEqual(record.answers, [null]);
    const current = fakeTelegram.getMessage(question.message_id);
    assert.ok(current && !current.isDeleted, 'the message stays');
    assert.deepEqual(topic.getKeyboardData(current), [[`qs_${record.id}_0`], [`qs_${record.id}_1`]], 'the buttons stay, naming the record');
    assert.ok(fakeTelegram.listPinnedMessageIds().includes(question.message_id), 'and so does the pin');
  });

  it('a later tap on its button delivers the late answer to the agent as a prompt, closes the message with the answer and releases the pin', async () => {
    const topicKey = keyToString(makeTelegramKey(group.id, questionTopic.threadId));
    const [record] = readPersistedState(getLayout()).setAsideQuestions?.[topicKey] ?? [];
    assert.ok(record && record.messageId !== null, 'precondition: the question is set aside');
    const question = fakeTelegram.getMessage(record.messageId);
    assert.ok(question, 'and its message is there');
    const lateAnswerPrefix = '[Late answer to your question asked ';
    const promptsBefore = fakeOpenCode.prompts.filter((prompt) => prompt.text.includes(lateAnswerPrefix)).length;

    assert.equal(await topic.tapAndAwaitAnswer(question, `qs_${record.id}_0`), firstQuestion.labels[0], 'the toast is the label');

    await getCharness().waitFor('the late answer to reach the server as a prompt', replyTimeoutMs, () => fakeOpenCode.prompts.filter((prompt) => prompt.text.includes(lateAnswerPrefix)).length > promptsBefore);
    const prompt = fakeOpenCode.prompts.filter((candidate) => candidate.text.includes(lateAnswerPrefix))[promptsBefore];
    assert.ok(prompt.text.includes(`Question: ${firstQuestion.question}\nAnswer: ${firstQuestion.labels[0]}\n`), prompt.text);
    assert.ok(prompt.text.includes('You went on without it'), 'worded for a question the agent went on without');
    await topic.waitForMessageText('the answer under the question', question, (text) => text.endsWith(`\n\n${enDict['agent.question_answered_note'].replace('{answer}', firstQuestion.labels[0])}`));
    assert.equal(fakeTelegram.getMessage(question.message_id)?.reply_markup, undefined, 'the buttons are gone');
    await waitForUnpinned(question);
    await getCharness().waitFor('the record to be gone', replyTimeoutMs, () => (readPersistedState(getLayout()).setAsideQuestions?.[topicKey] ?? []).length === 0);
    assert.deepEqual(fakeOpenCode.listRequests('POST', `/question/${firstQuestion.requestId}/reject`), [], 'and the question was never rejected');
  });
});

describe('A reply that sets a question aside is refused by the OpenCode server, end to end: built charness, fake Bot API, fake OpenCode', () => {
  /** The question wait of the instance, in ms, and the pause before the bot tries again (production: 30 min and 30 s). */
  const questionWaitMs = 4000;
  const retryPauseMs = 300;
  const refusalTimeoutMs = 60 * 1000;
  /** A client error: the adapter does not retry it on its own, so each refusal is exactly one failed set-aside. */
  const refusedReplyStatus = 400;
  const notTakenNote = enDict['agent.question_set_aside_not_taken_note'];

  before(async () => {
    await setUpInstance('charness-ocask-refused-', { ...getTelegramFlowTestTimingsEnv({ questionSetAsideWaitMs: questionWaitMs, questionSetAsideRetryMs: retryPauseMs }) });
  });

  after(tearDownInstance);

  it('every try is refused: the server is asked for its question again after each pause, the topic is told once after the last, and the pinned message\'s note says the agent may still wait', async () => {
    const sessionId = await bootBindAndStartTurn('REFUSED-1');
    const topicKey = keyToString(makeTelegramKey(group.id, questionTopic.threadId));
    const replyPath = `/question/${firstQuestion.requestId}/reply`;
    // The question stays open on the server although its reply is refused: it is what the server's registry lists.
    fakeOpenCode.setServedQuestions([{ id: firstQuestion.requestId, sessionID: sessionId, questions: [{ question: firstQuestion.question, header: firstQuestion.header, options: firstQuestion.labels.map((label) => ({ label })) }] }]);
    const attempts = setAsideRetryLimit + 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) fakeOpenCode.holdNextRequest('POST', new RegExp(`^${replyPath}$`), Promise.resolve(refusedReplyStatus));
    const question = await askQuestion(sessionId, firstQuestion);
    await waitForPinned(question);

    const refusedTopic = new TopicDriver(fakeTelegram, getCharness, questionTopic.threadId, refusalTimeoutMs);
    await refusedTopic.waitForMessage('the notice that the agent may still wait', (message) => message.text === enDict['agent.set_aside_reply_failed_notice']);
    assert.equal(fakeOpenCode.listRequests('POST', replyPath).length, attempts, 'the first try and one more after each pause — the chain did not stop early and did not go on');
    assert.deepEqual(fakeOpenCode.listRequests('POST', `/question/${firstQuestion.requestId}/reject`), [], 'the question is never rejected');
    assert.ok(fakeOpenCode.listRequests('GET', '/question').length >= setAsideRetryLimit, 'the server was asked for its open question again after each refusal');
    assert.equal(topic.listMessages().filter((message) => message.text === enDict['agent.set_aside_reply_failed_notice']).length, 1, 'the notice is posted once');

    // Load-bearing: the pinned message no longer says «the agent went on» — it says the agent may still be waiting — and stays answerable.
    await refusedTopic.waitForMessageText('the «may still wait» note under the question', question, (text) => text.endsWith(`\n\n${notTakenNote}`));
    await getCharness().waitFor('the set-aside question to be saved', replyTimeoutMs, () => (readPersistedState(getLayout()).setAsideQuestions?.[topicKey] ?? []).length === 1);
    const [record] = readPersistedState(getLayout()).setAsideQuestions?.[topicKey] ?? [];
    const current = fakeTelegram.getMessage(question.message_id);
    assert.ok(current && !current.isDeleted, 'the message stays');
    assert.ok(!current.text.includes(enDict['agent.question_set_aside_note']), 'and it no longer says the agent went on');
    assert.deepEqual(topic.getKeyboardData(current), [[`qs_${record.id}_0`], [`qs_${record.id}_1`]], 'the buttons stay, naming the record');
    assert.ok(fakeTelegram.listPinnedMessageIds().includes(question.message_id), 'and so does the pin');
  });

  it('the owner does what the notice says — any message: the wedge backstop aborts the stuck turn, the message reaches the agent, and the pinned note is still true (it never claimed the agent waits)', async () => {
    const sessionId = getTopicSessionId();
    const topicKey = keyToString(makeTelegramKey(group.id, questionTopic.threadId));
    const [record] = readPersistedState(getLayout()).setAsideQuestions?.[topicKey] ?? [];
    assert.ok(record && record.messageId !== null, 'precondition: the question is still set aside');
    const question = fakeTelegram.getMessage(record.messageId);
    assert.ok(question, 'and its message is there');
    const abortsBefore = fakeOpenCode.listRequests('POST', `/session/${sessionId}/abort`).length;

    fakeTelegram.pushOperatorMessage(questionTopic.threadId, 'MOVE-ON please carry on without it');
    await getCharness().waitFor('the owner\'s message to reach the server', replyTimeoutMs, () => fakeOpenCode.prompts.some((prompt) => prompt.text.includes('MOVE-ON')));
    assert.equal(fakeOpenCode.listRequests('POST', `/session/${sessionId}/abort`).length, abortsBefore + 1, 'the turn stuck on the question was aborted before the message went in');
    // The agent moves on: the server's registry no longer holds the question, and the agent works.
    fakeOpenCode.setServedQuestions([]);
    fakeOpenCode.emitAssistantText(sessionId, 'msg_MOVED_ON', 'Carrying on without the answer.');
    await topic.waitForMessage('the agent\'s words after it moved on', (message) => message.text.includes('Carrying on without the answer.'));

    // The note says what happened to the «go on» message — still the case, and not a claim about the agent: it was never rewritten to say the
    // agent waits, so nothing has to take it back when the agent moves on by itself, by this message, or by a new question.
    const current = fakeTelegram.getMessage(question.message_id);
    assert.ok(current && current.text.endsWith(`\n\n${notTakenNote}`), `the note is the one about the unconfirmed message: ${current?.text.slice(-120)}`);
    assert.ok(!current.text.includes(enDict['agent.question_set_aside_note']), 'and never the false reassurance that the agent went on');
    assert.deepEqual(topic.getKeyboardData(current), [[`qs_${record.id}_0`], [`qs_${record.id}_1`]], 'the question can still be answered');
    assert.ok(fakeTelegram.listPinnedMessageIds().includes(question.message_id), 'and stays pinned');
    assert.equal((readPersistedState(getLayout()).setAsideQuestions?.[topicKey] ?? []).length, 1, 'a message that is not an answer closes nothing');
  });

  it('a tap on its button still answers it: the late answer reaches the server as a prompt, the message closes with the answer and the pin is released', async () => {
    const topicKey = keyToString(makeTelegramKey(group.id, questionTopic.threadId));
    const [record] = readPersistedState(getLayout()).setAsideQuestions?.[topicKey] ?? [];
    assert.ok(record && record.messageId !== null, 'precondition: the question is still set aside');
    const question = fakeTelegram.getMessage(record.messageId);
    assert.ok(question, 'and its message is there');
    const lateAnswerPrefix = '[Late answer to your question asked ';
    const promptsBefore = fakeOpenCode.prompts.filter((prompt) => prompt.text.includes(lateAnswerPrefix)).length;

    assert.equal(await topic.tapAndAwaitAnswer(question, `qs_${record.id}_0`), firstQuestion.labels[0], 'the toast is the label');

    await getCharness().waitFor('the late answer to reach the server as a prompt', replyTimeoutMs, () => fakeOpenCode.prompts.filter((prompt) => prompt.text.includes(lateAnswerPrefix)).length > promptsBefore);
    await topic.waitForMessageText('the answer under the question', question, (text) => text.endsWith(`\n\n${enDict['agent.question_answered_note'].replace('{answer}', firstQuestion.labels[0])}`));
    await waitForUnpinned(question);
    await getCharness().waitFor('the record to be gone', replyTimeoutMs, () => (readPersistedState(getLayout()).setAsideQuestions?.[topicKey] ?? []).length === 0);
  });
});
