/**
 * @description A question the agent asks stays in the topic however it ends, at PROCESS level: the BUILT charness started
 * the way an isolated instance is (`scripts/run-isolated.sh`) against the fake Bot API of `telegramE2e/fakeTelegram.ts`,
 * with the fake `claude` (`jiraE2e/fakeClaude.ts`, mode `ask`) putting a real `AskUserQuestion` to the topic. One flow,
 * in order:
 *
 *   boot → the topic is bound → `/claude`
 *   → a tap on an option: the question message is NOT deleted, its text and options stay, the chosen answer stands in
 *     place of the buttons, the pin is gone, and the agent got the answer
 *   → the number of an option typed instead of a tap: the same, with the long label whole
 *   → another message sent instead of an answer: the question stays, a «not answered» note stands in place of the
 *     buttons, the pin is gone, and the message reaches the agent as a prompt
 *   → `/esc`: the same note
 *   → `/quit` (the session is stopped with the question open): the same note
 *   → output landing below the question (a branch of the agent that keeps streaming): the question is posted again at the
 *     bottom and pinned, the first message stays as «asked again below» and is unpinned; an answer to the new one
 *     closes it with the answer
 *   → «create new folder» of `/bind` (it drops a pending question): the same note
 *
 * Nothing leaves the machine: the Bot API is on loopback and the agent is a fake. Everything the test starts is stopped
 * in `after`. The idle compaction's re-ask is in `reaskedQuestionE2e.test.ts`; the OpenCode backend's cancel is in
 * `openCodeInterruptE2e.test.ts`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram, type FakeTelegramMessage } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import {
  fakeAskNoAnswerOutcome,
  fakeAskQuestion,
  fakeAskToolName,
  fakeClaudeLogFileNames,
  fakeClaudeOutputWhileAskedFileName,
  type FakeClaudePrompt,
  type FakeClaudeToolCall,
} from './jiraE2e/fakeClaudeContract';
import { enDict } from '../i18n/en';
import { bindCreateFolderCallback } from '../connectors/telegram/bindPicker';
import {
  builtCliPath,
  createIsolatedInstanceLayout,
  exitOnSignal,
  getFlowDeadlineMs,
  getFreeFixedPort,
  getFreePort,
  IsolatedCharness,
  listTmuxSessions,
  readJsonLines,
  removeIsolatedInstanceSync,
  writeFakeClaudeLauncher,
  writeInstanceEnvFile,
  type IsolatedInstanceLayout,
} from './e2e/isolatedCharness';
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const topicThreadId = 111;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const projectFolder = 'proj';
const launchLine = 'Launching Telegraf bot (long polling';

const bootTimeoutMs = 60 * 1000;
const replyTimeoutMs = 20 * 1000;
const agentStartTimeoutMs = 60 * 1000;
/** A question put again at the bottom follows the output below it by a flush, a debounce and two paced sends. */
const repostTimeoutMs = 45 * 1000;

/** The text the fake streams under a pending question (`fakeClaudeOutputWhileAskedFileName`). */
const outputWhileAskedText = 'A branch of the agent keeps working while the question waits.';

const unansweredNote = enDict['agent.question_unanswered_note'];
const askedAgainNote = enDict['agent.question_asked_again_note'];
const buildAnsweredNote = (answer: string): string => enDict['agent.question_answered_note'].replace('{answer}', answer);

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let topic: TopicDriver;
let repostTopic: TopicDriver;
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

/** The user messages the fake agent read that carried `label`. */
function getAgentPrompts(label: string): FakeClaudePrompt[] {
  return readJsonLines<FakeClaudePrompt>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.prompts)).filter((prompt) => prompt.text.includes(label));
}

/** The answers the fake's `AskUserQuestion` got, in order. */
function getGivenAnswers(): string[] {
  return readJsonLines<FakeClaudeToolCall>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.toolCalls)).filter((call) => call.tool === fakeAskToolName).map((call) => call.outcome);
}

/** Put the question (`ask` mode): resolves its message once it carries the option buttons. */
async function askQuestion(driver: TopicDriver, promptLabel: string): Promise<FakeTelegramMessage> {
  const sentMessageId = fakeTelegram.pushOperatorMessage(topicThreadId, `${promptLabel} [fake:ask] ask me something`);
  return driver.waitForMessage(`the question of ${promptLabel}`, (message) =>
    message.message_id > sentMessageId
    && message.text.includes(fakeAskQuestion.question)
    && driver.getKeyboardData(message).flat().some((data) => data.startsWith('qa_')));
}

/** The question message as the topic holds it NOW: it must exist and not be deleted. */
function readKeptMessage(message: FakeTelegramMessage): FakeTelegramMessage {
  const current = fakeTelegram.getMessage(message.message_id);
  assert.ok(current && !current.isDeleted, `message ${message.message_id} is still in the topic`);
  return current;
}

/** The question stays as asked: header, question and EVERY option, then `note` — and no buttons. */
function assertQuestionKeptWithNote(message: FakeTelegramMessage, note: string): void {
  const current = readKeptMessage(message);
  for (const part of [fakeAskQuestion.header, fakeAskQuestion.question, fakeAskQuestion.shortOptionLabel, fakeAskQuestion.longOptionLabel]) {
    assert.ok(current.text.includes(part), `the question's «${part.slice(0, 40)}…» stays: ${current.text}`);
  }
  assert.ok(current.text.endsWith(`\n\n${note}`), `the text ends with the note «${note.slice(0, 60)}»: ${current.text.slice(-120)}`);
  assert.equal(current.reply_markup, undefined, 'the buttons are gone');
}

async function waitForUnpinned(message: FakeTelegramMessage): Promise<void> {
  await getCharness().waitFor(`message ${message.message_id} to be unpinned`, replyTimeoutMs, () => !fakeTelegram.listPinnedMessageIds().includes(message.message_id));
}

/** The question is put to the topic pinned (one notification), and only then is it worth walking away from. */
async function waitForPinned(message: FakeTelegramMessage): Promise<void> {
  await getCharness().waitFor(`message ${message.message_id} to be pinned`, replyTimeoutMs, () => fakeTelegram.listPinnedMessageIds().includes(message.message_id));
}

/** A new session after the previous one was stopped: the topic is bound, so `/claude` starts it. */
async function startAgentSession(): Promise<void> {
  await topic.sendAndAwaitReply('/claude', 'ready in');
}

describe('A question the agent asks stays in the topic however it ends, end to end: built charness, fake Bot API', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-qkept-', [projectFolder], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    topic = new TopicDriver(fakeTelegram, getCharness, topicThreadId, replyTimeoutMs);
    repostTopic = new TopicDriver(fakeTelegram, getCharness, topicThreadId, repostTimeoutMs);
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

  it('boots Telegram-only against the fake Bot API, binds the topic and starts the fake agent', async () => {
    charness = new IsolatedCharness(getLayout());
    const pollsBefore = fakeTelegram.listCalls('getUpdates').length;
    await charness.start(bootTimeoutMs, (runOutput) => runOutput.includes(launchLine) && fakeTelegram.listCalls('getUpdates').length > pollsBefore);
    await topic.sendAndAwaitReply(`/bind ${projectFolder}`, `Bound to \`${projectFolder}\``);
    await startAgentSession();
  });

  it('a tap on an option: the question message stays with its options, the chosen answer stands in place of the buttons, the pin is gone, the agent gets the answer', async () => {
    const question = await askQuestion(topic, 'KEPT-TAP');
    await waitForPinned(question);
    assert.deepEqual(topic.getKeyboardData(question), [['qa_0_0'], ['qa_0_1']], 'one button per option');

    await topic.tapAndAwaitAnswer(question, 'qa_0_0');
    await topic.waitForMessageText('the answer under the question', question, (text) => text.endsWith(buildAnsweredNote(fakeAskQuestion.shortOptionLabel)));
    assertQuestionKeptWithNote(question, buildAnsweredNote(fakeAskQuestion.shortOptionLabel));
    await waitForUnpinned(question);
    await getCharness().waitFor('the agent to get the answer', agentStartTimeoutMs, () => getGivenAnswers().includes(fakeAskQuestion.shortOptionLabel));
  });

  it('the number of an option typed instead of a tap: the same, with the long label whole', async () => {
    const question = await askQuestion(topic, 'KEPT-DIGIT');
    await waitForPinned(question);

    fakeTelegram.pushOperatorMessage(topicThreadId, '2');
    await topic.waitForMessageText('the long answer under the question', question, (text) => text.endsWith(buildAnsweredNote(fakeAskQuestion.longOptionLabel)));
    assertQuestionKeptWithNote(question, buildAnsweredNote(fakeAskQuestion.longOptionLabel));
    await waitForUnpinned(question);
    await getCharness().waitFor('the agent to get the long answer', agentStartTimeoutMs, () => getGivenAnswers().includes(fakeAskQuestion.longOptionLabel));
  });

  it('another message sent instead of an answer: the question stays, a «not answered» note replaces the buttons, the pin is gone, the message reaches the agent', async () => {
    const question = await askQuestion(topic, 'KEPT-WALK');
    await waitForPinned(question);
    const answersBefore = getGivenAnswers().length;

    fakeTelegram.pushOperatorMessage(topicThreadId, 'WALK-1 [fake:answer] never mind the question, do this instead');
    await topic.waitForMessageText('the note under the question', question, (text) => text.endsWith(`\n\n${unansweredNote}`));
    assertQuestionKeptWithNote(question, unansweredNote);
    await waitForUnpinned(question);
    await getCharness().waitFor('the new message to reach the agent as a prompt', agentStartTimeoutMs, () => getAgentPrompts('WALK-1').length > 0);
    await getCharness().waitFor('the agent to see the question declined', agentStartTimeoutMs, () => getGivenAnswers().length > answersBefore);
    assert.deepEqual(getGivenAnswers().slice(answersBefore), [fakeAskNoAnswerOutcome], 'the question was declined, not answered');
    // The note under the question IS the cancellation notice: no second line about it.
    assert.ok(!topic.listMessages().some((message) => message.text === enDict['agent.question_cancelled_for_prompt']), 'no standalone «previous question cancelled» line');
  });

  it('/esc: the same note under the question that stays', async () => {
    const question = await askQuestion(topic, 'KEPT-ESC');
    await waitForPinned(question);

    fakeTelegram.pushOperatorMessage(topicThreadId, '/esc');
    await topic.waitForMessageText('the note under the question', question, (text) => text.endsWith(`\n\n${unansweredNote}`));
    assertQuestionKeptWithNote(question, unansweredNote);
    await waitForUnpinned(question);
  });

  it('/quit with the question open: the session is stopped, the question stays with the same note', async () => {
    const question = await askQuestion(topic, 'KEPT-QUIT');
    await waitForPinned(question);

    fakeTelegram.pushOperatorMessage(topicThreadId, '/quit');
    await topic.waitForMessageText('the note under the question', question, (text) => text.endsWith(`\n\n${unansweredNote}`));
    assertQuestionKeptWithNote(question, unansweredNote);
    await waitForUnpinned(question);
    await startAgentSession();
  });

  it('output landing below the question: it is posted again at the bottom and pinned, the first message stays as «asked again below», an answer closes the new one', async () => {
    fs.writeFileSync(path.join(getLayout().fakeStateDir, fakeClaudeOutputWhileAskedFileName), outputWhileAskedText);
    try {
      const first = await askQuestion(repostTopic, 'KEPT-REPOST');
      // The agent's output lands below the question, which brings it back to the bottom: a newer message with the buttons.
      const reposted = await repostTopic.waitForMessage('the question posted again at the bottom', (message) =>
        message.message_id > first.message_id
        && message.text.includes(fakeAskQuestion.question)
        && repostTopic.getKeyboardData(message).flat().some((data) => data.startsWith('qa_')));
      const output = await repostTopic.waitForMessage('the output under the first question', (message) => message.text.includes(outputWhileAskedText));
      assert.ok(first.message_id < output.message_id && output.message_id < reposted.message_id, 'the order: question, output, the question again');

      // The first message is not deleted: the question as asked, «asked again below» in place of the buttons, no pin.
      await repostTopic.waitForMessageText('the first question marked as asked again', first, (text) => text.endsWith(`\n\n${askedAgainNote}`));
      assertQuestionKeptWithNote(first, askedAgainNote);
      await waitForUnpinned(first);
      await waitForPinned(reposted);

      await topic.tapAndAwaitAnswer(reposted, 'qa_0_0');
      await topic.waitForMessageText('the answer under the question posted again', reposted, (text) => text.endsWith(buildAnsweredNote(fakeAskQuestion.shortOptionLabel)));
      assertQuestionKeptWithNote(reposted, buildAnsweredNote(fakeAskQuestion.shortOptionLabel));
      assertQuestionKeptWithNote(first, askedAgainNote);
      await waitForUnpinned(reposted);
    } finally {
      fs.rmSync(path.join(getLayout().fakeStateDir, fakeClaudeOutputWhileAskedFileName), { force: true });
    }
  });

  it('«create new folder» of /bind drops a pending question: it stays with the same note', async () => {
    const question = await askQuestion(topic, 'KEPT-BIND');
    await waitForPinned(question);

    const picker = await topic.sendAndAwaitReply('/bind', enDict['bind.current'].replace('{subdir}', projectFolder));
    await topic.tapAndAwaitAnswer(picker, bindCreateFolderCallback);
    await topic.waitForMessageText('the note under the question', question, (text) => text.endsWith(`\n\n${unansweredNote}`));
    assertQuestionKeptWithNote(question, unansweredNote);
    await waitForUnpinned(question);
  });
});
