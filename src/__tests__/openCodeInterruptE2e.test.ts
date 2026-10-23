/**
 * @description `/interrupt` (and its older name `/esc`) on an OpenCode topic, at PROCESS level: the BUILT charness
 * started the way an isolated instance is (`scripts/run-isolated.sh`) against the fake Bot API
 * (`telegramE2e/fakeTelegram.ts`) and the fake OpenCode server (`openCodeE2e/fakeOpenCodeServer.ts`), which ends a
 * running turn the way the real server does when it is told to abort it. One flow, in order:
 *
 *   boot → a topic bound to a folder runs an OpenCode session; a turn is in flight and has streamed some words
 *   → `/interrupt`: the bot aborts that session's generation (it used to answer «Not supported for OpenCode»), the turn
 *     ends, and the topic gets nothing more — no «Aborted» error line, no refusal
 *   → the next message steers the agent: it reaches the SAME session, and the answer lands in a NEW message (the
 *     interrupted turn's words are not overwritten)
 *   → the older `/esc` does the same
 *   → an interrupt before the turn produced anything: the aborted turn's idle is not taken for a session that ran
 *     nothing, so the prompt is not replayed on a recovered session
 *   → a turn blocked on a question: `/interrupt` cancels the question (its buttons are retired, the server's question
 *     is rejected) and aborts the turn — without waiting for Telegram's answer to the buttons' edit.
 *
 * What the unit tests cover instead: the abort request and the wedged-turn watch (`openCodeInterrupt.test.ts`), the
 * menu entries (`modelPickerSurface.test.ts`).
 *
 * Nothing leaves the machine: the Bot API and the OpenCode server are on loopback. Everything the test starts is
 * stopped in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram } from './telegramE2e/fakeTelegram';
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
import { openLimitsBoard, startCharnessOnInstance } from './e2e/fallbackFlowKit';
import { enDict } from '../i18n/en';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';

const interruptTopic = { threadId: 171, folder: 'interrupt-turn' };
const fakeOpenCodeVersion = '1.17.11';
const model = 'example/model-one';
const openCodeModels = [model] as const;
const replyTimeoutMs = 20 * 1000;

/** What the bot logs for an «Aborted» error of the abort it issued itself, and for each idle it handles. */
const abortSwallowedLogLine = '[OpenCode] Swallowed bot-issued abort';
const sessionIdleLogLine = '[OpenCode] Session idle';
const notSupportedLine = 'Not supported for';
const abortedErrorFragment = 'Aborted';

const questionRequestId = 'que_interrupt_1';
const questionHeader = 'Lexer';
const questionText = 'Which lexer should I write?';
const cancelledQuestionLabel = enDict['agent.question_cancelled_msg_label'].replace('{header}', questionHeader);

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let fakeOpenCode: FakeOpenCodeServer;
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

/** The messages the bot SENT to the topic since `fromCall`, the `/limits` boards (the barrier's own replies) left out. */
function listSentLines(fromCall: number): string[] {
  return fakeTelegram.calls.slice(fromCall)
    .filter((call) => call.method === 'sendMessage' && call.payload.message_thread_id === interruptTopic.threadId && !JSON.stringify(call.payload.reply_markup ?? null).includes('lim_'))
    .map((call) => (typeof call.payload.text === 'string' ? call.payload.text : ''));
}

function getTopicSessionId(): string {
  const folderPath = path.join(getLayout().workRoot, interruptTopic.folder);
  const session = [...fakeOpenCode.sessions.values()].find((candidate) => candidate.directory === folderPath);
  assert.ok(session, `a fake OpenCode session for ${folderPath}`);
  return session.id;
}

function listSessionPrompts(sessionId: string): string[] {
  return fakeOpenCode.prompts.filter((prompt) => prompt.sessionId === sessionId).map((prompt) => prompt.text);
}

/** The `STEER-n` label of each operator prompt the session received, in order (a replay would repeat one). */
function listPromptLabels(sessionId: string): string[] {
  return listSessionPrompts(sessionId).flatMap((text) => text.match(/STEER-\d/) ?? []);
}

function countAborts(sessionId: string): number {
  return fakeOpenCode.listRequests('POST', `/session/${sessionId}/abort`).length;
}

function countLogLines(fragment: string): number {
  return getCharness().output.split('\n').filter((line) => line.includes(fragment)).length;
}

/** A slash command the bot owns is never typed into the agent as a prompt. */
function assertCommandNotForwarded(command: string): void {
  assert.ok(!fakeOpenCode.prompts.some((prompt) => prompt.text.includes(command)), `${command} was not forwarded to the agent as a prompt`);
}

/** The operator types `text` and the prompt reaches the fake server (resolves the session's prompt count). */
async function sendPrompt(text: string): Promise<void> {
  fakeTelegram.pushOperatorMessage(interruptTopic.threadId, text);
  await getCharness().waitFor(`the prompt «${text}» to reach the server`, replyTimeoutMs, () => fakeOpenCode.prompts.some((prompt) => prompt.text.includes(text)));
}

/**
 * The operator types `command`; resolves once the fake server was asked to abort the session, and the bot handled the
 * aborted turn's «Aborted» error and idle (the log shows it), so what the topic shows next is the whole outcome.
 */
async function interruptWith(command: string, sessionId: string): Promise<void> {
  const abortsBefore = countAborts(sessionId);
  const abortsHandledBefore = countLogLines(abortSwallowedLogLine);
  const idlesBefore = countLogLines(sessionIdleLogLine);
  fakeTelegram.pushOperatorMessage(interruptTopic.threadId, command);
  await getCharness().waitFor(`${command} to abort the session`, replyTimeoutMs, () => countAborts(sessionId) > abortsBefore);
  await getCharness().waitFor('the bot to handle the aborted turn', replyTimeoutMs, () => countLogLines(abortSwallowedLogLine) > abortsHandledBefore && countLogLines(sessionIdleLogLine) > idlesBefore);
  assert.equal(countAborts(sessionId), abortsBefore + 1, `${command} aborts once`);
}

describe('/interrupt on an OpenCode topic end to end: built charness, fake Bot API, fake OpenCode', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-ocinterrupt-', [interruptTopic.folder], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    topic = new TopicDriver(fakeTelegram, getCharness, interruptTopic.threadId, replyTimeoutMs);
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
    });
  });

  after(async () => {
    await charness?.stop();
    removeInstanceSync();
    await fakeTelegram?.stop();
    await fakeOpenCode?.stop();
    process.off('exit', removeInstanceSync);
    process.off('SIGINT', exitOnSignal);
    process.off('SIGTERM', exitOnSignal);
    assert.deepEqual(listTmuxSessions([]), defaultTmuxSessionsBefore, 'the default tmux server was not touched');
    assert.deepEqual(fakeOpenCode.unhandled, [], 'the bot asked the fake OpenCode for nothing it does not model');
  });

  it('boots, binds the topic and starts an OpenCode session; a turn is in flight and has streamed some words', async () => {
    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    await topic.sendAndAwaitReply(`/bind ${interruptTopic.folder}`, `Bound to \`${interruptTopic.folder}\``);
    await topic.sendAndAwaitReply('/opencode', 'ready in');
    await sendPrompt('STEER-1 write the parser');
    const sessionId = getTopicSessionId();
    fakeOpenCode.emitSessionBusy(sessionId);
    fakeOpenCode.emitAssistantText(sessionId, 'msg_a1', 'Reading the parser sources…');
    await topic.waitForMessage('the words streamed so far', (message) => message.text.includes('Reading the parser sources'));
  });

  it('/interrupt aborts the generation: the turn ends and the topic is told nothing more — no «Aborted» error, no refusal', async () => {
    const sessionId = getTopicSessionId();
    const callsBefore = fakeTelegram.calls.length;
    await interruptWith('/interrupt', sessionId);
    await openLimitsBoard(fakeTelegram, topic, interruptTopic.threadId);
    assert.deepEqual(listSentLines(callsBefore), [], 'the interrupt posts no line of its own: the turn simply stops');
    assertCommandNotForwarded('/interrupt');
    const everyBotText = topic.listMessages().map((message) => message.text).join('\n');
    assert.ok(!everyBotText.includes(notSupportedLine), 'the command is supported on OpenCode');
    assert.ok(!everyBotText.includes(abortedErrorFragment), 'the abort is not reported as an error');
  });

  it('the next message steers the agent: it reaches the same session, and the answer is a new message beside the interrupted one', async () => {
    const sessionId = getTopicSessionId();
    const sessionsBefore = fakeOpenCode.sessions.size;
    await sendPrompt('STEER-2 do the lexer instead');
    assert.equal(fakeOpenCode.sessions.size, sessionsBefore, 'no new session: the conversation stays');
    assert.deepEqual(listPromptLabels(sessionId), ['STEER-1', 'STEER-2']);

    fakeOpenCode.emitSessionBusy(sessionId);
    fakeOpenCode.emitAssistantText(sessionId, 'msg_a2', 'Switching to the lexer.');
    const answer = await topic.waitForMessage('the answer to the new message', (message) => message.text.includes('Switching to the lexer.'));
    fakeOpenCode.emitSessionIdle(sessionId);
    const interrupted = topic.listMessages().find((message) => message.text.includes('Reading the parser sources'));
    assert.ok(interrupted, 'the interrupted turn\'s words are still on screen');
    assert.notEqual(answer.message_id, interrupted.message_id, 'the answer is a new message');
    assert.ok(!interrupted.text.includes('Switching to the lexer.'), 'the interrupted turn\'s message was not overwritten');
  });

  it('the older /esc interrupts the same way', async () => {
    const sessionId = getTopicSessionId();
    await sendPrompt('STEER-3 compile it');
    fakeOpenCode.emitSessionBusy(sessionId);
    fakeOpenCode.emitAssistantText(sessionId, 'msg_a3', 'Compiling the module…');
    await topic.waitForMessage('the words streamed so far', (message) => message.text.includes('Compiling the module'));
    const callsBefore = fakeTelegram.calls.length;
    await interruptWith('/esc', sessionId);
    await openLimitsBoard(fakeTelegram, topic, interruptTopic.threadId);
    assert.deepEqual(listSentLines(callsBefore), []);
    assertCommandNotForwarded('/esc');
  });

  it('an interrupt before the turn produced anything is not taken for a session that ran nothing: the prompt is not replayed', async () => {
    const sessionId = getTopicSessionId();
    await sendPrompt('STEER-4 start over');
    fakeOpenCode.emitSessionBusy(sessionId);
    const promptLabelsBefore = listPromptLabels(sessionId);
    const sessionsBefore = fakeOpenCode.sessions.size;
    const callsBefore = fakeTelegram.calls.length;
    await interruptWith('/interrupt', sessionId);
    await openLimitsBoard(fakeTelegram, topic, interruptTopic.threadId);
    assert.deepEqual(listSentLines(callsBefore), [], 'no «recovering» notice');
    assert.ok(!topic.listMessages().some((message) => message.text === enDict['agent.session_recovering']), 'the wedge recovery did not run');
    assert.deepEqual(listPromptLabels(sessionId), promptLabelsBefore, 'the interrupted prompt was not sent again');
    assert.equal(fakeOpenCode.sessions.size, sessionsBefore, 'no fresh session');
  });

  it('a turn blocked on a question: /interrupt cancels the question and aborts the turn', async () => {
    const sessionId = getTopicSessionId();
    await sendPrompt('STEER-5 pick a lexer');
    fakeOpenCode.emitSessionBusy(sessionId);
    fakeOpenCode.emitAssistantText(sessionId, 'msg_a5', 'I need a decision.');
    fakeOpenCode.emitQuestionAsked(sessionId, questionRequestId, [{ question: questionText, header: questionHeader, options: [{ label: 'hand-written' }, { label: 'regex' }] }]);
    const bubble = await topic.waitForMessage('the question with its buttons', (message) => message.text.includes(questionText));
    assert.ok(topic.getKeyboardData(bubble).flat().some((data) => data.startsWith('qa_')), 'the options are buttons');

    const rejectsBefore = fakeOpenCode.listRequests('POST', `/question/${questionRequestId}/reject`).length;
    // The Telegram answer to the question buttons' edit is held: the abort must not wait for it (that edit goes through the
    // send pacer, seconds late on a busy instance, while the agent keeps working).
    let releaseEdit = (): void => {};
    fakeTelegram.holdNextResponse('editMessageText', new Promise<void>((resolve) => { releaseEdit = resolve; }), (payload) => payload.text === cancelledQuestionLabel);
    try {
      await interruptWith('/interrupt', sessionId);
      await getCharness().waitFor('the question rejected on the server while the buttons\' edit is still held', replyTimeoutMs, () => fakeOpenCode.listRequests('POST', `/question/${questionRequestId}/reject`).length > rejectsBefore);
    } finally {
      releaseEdit();
    }
    await topic.waitForMessageText('the question retired', bubble, (text) => text === cancelledQuestionLabel);
    assert.equal(fakeOpenCode.listRequests('POST', `/question/${questionRequestId}/reject`).length, rejectsBefore + 1, 'the question is rejected on the server');
    assert.deepEqual(topic.getKeyboardData(bubble).flat(), [], 'the stale buttons are gone');
  });
});
