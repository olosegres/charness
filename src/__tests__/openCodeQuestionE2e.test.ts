/**
 * @description A question the OpenCode agent asks stays in the topic however it ends, at PROCESS level: the BUILT charness
 * started the way an isolated instance is (`scripts/run-isolated.sh`) against the fake Bot API
 * (`telegramE2e/fakeTelegram.ts`) and the fake OpenCode server (`openCodeE2e/fakeOpenCodeServer.ts`), which can put a
 * question to the user whenever a flow says (the fake Claude agent cannot ask without a person's message). Three flows:
 *
 *   the idle compaction re-asked a question → the agent asks a NEW question while the re-asked copy waits: the copy is
 *     closed as «not answered» and keeps its text, and its button never answers the new question;
 *   a prompt the server refuses while a question is open → the adapter reports the error: the topic gets the error line,
 *     and the question stays with the «not answered» note, its buttons gone and its pin released;
 *   the question tool's own «🔧 question…» status that waits behind unposted text while the question arrives → it is
 *     never posted: no status line lands under the question.
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
import { startCharnessOnInstance } from './e2e/fallbackFlowKit';
import { enDict } from '../i18n/en';
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';

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
