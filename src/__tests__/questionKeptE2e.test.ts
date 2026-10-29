/**
 * @description A question the agent asks stays in the topic however it ends, at PROCESS level: the BUILT charness started
 * the way an isolated instance is (`scripts/run-isolated.sh`) against the fake Bot API of `telegramE2e/fakeTelegram.ts`,
 * with the fake `claude` (`jiraE2e/fakeClaude.ts`, mode `ask`) putting a real `AskUserQuestion` to the topic. Two flows.
 *
 * The first, on an instance with the default idle window, in order:
 *
 *   boot → the topic is bound → `/claude`
 *   → a tap on an option: the question message is NOT deleted, its text and options stay, the chosen answer stands in
 *     place of the buttons, the pin is gone, and the agent got the answer
 *   → the number of an option typed instead of a tap: the same, with the long label whole
 *   → another message sent instead of an answer: the question stays, a «not answered» note stands in place of the
 *     buttons, the pin is gone, and the message reaches the agent as a prompt
 *   → `/esc`: the same note
 *   → a close whose edit Telegram refuses to apply to the text (too long): the buttons are taken off all the same
 *   → a close whose Markdown Telegram cannot parse: the question is kept as plain text, without escape marks
 *   → `/quit` (the session is stopped with the question open): the same note
 *   → one call with TWO questions (`ask-two`): each question message keeps its own text and gets its own result — both
 *     answered by a tap; the first answered and the second left alone
 *   → output landing below the question (a branch of the agent that keeps streaming): the question is posted again at the
 *     bottom and pinned, the first message stays as «asked again below» and is unpinned; an answer to the new one
 *     closes it with the answer
 *   → the bot restarts while the question is open and finds the agent's session gone: the question the bot dropped at boot
 *     stays with the same note, its buttons gone and its pin released
 *   → «create new folder» of `/bind` (it drops a pending question): the same note
 *
 * The second, on an instance whose idle window is seconds, so the idle compaction re-asks a question the agent was left
 * waiting on: the re-asked copy has `reask_<i>` buttons, and when the conversation ends without them being used the
 * copy stays with the same note instead of keeping buttons that are dead — whichever way it ends: `/quit`, `/quitall` or
 * `/new` of the sleeping conversation, leaving the folder, a message of the person's instead of a tap (the copy is
 * not left to be tapped later, onto whatever the agent asks next), a stop that comes while the re-asked message is
 * still being sent, or a restart of the bot that finds the conversation released (one that finds it asleep keeps the
 * buttons working).
 *
 * Nothing leaves the machine: the Bot API is on loopback and the agent is a fake. Everything the test starts is stopped
 * in `after`. The idle compaction's re-ask itself is in `reaskedQuestionE2e.test.ts`; the OpenCode backend's cancel is in
 * `openCodeInterruptE2e.test.ts`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram, generalTopicThreadId, type FakeTelegramMessage } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import {
  fakeAskNoAnswerOutcome,
  fakeAskQuestion,
  fakeAskSecondQuestion,
  fakeAskToolName,
  fakeAskTwoOutcomeSeparator,
  fakeClaudeLogFileNames,
  fakeClaudeOutputWhileAskedFileName,
  type FakeClaudePrompt,
  type FakeClaudeToolCall,
} from './jiraE2e/fakeClaudeContract';
import { enDict } from '../i18n/en';
import { bindCreateFolderCallback, bindLeaveCurrentCallback } from '../connectors/telegram/bindPicker';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { keyToString } from '../sessionKey';
import { buildJsonStreamTmuxSessionName } from '../utils/jsonStreamHost';
import {
  builtCliPath,
  createIsolatedInstanceLayout,
  exitOnSignal,
  getFlowDeadlineMs,
  getFreeFixedPort,
  getFreePort,
  getTmuxEnv,
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

const group = { id: -1001111111111, title: 'ExampleGroup' };
const topicThreadId = 111;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const projectFolder = 'proj';

const bootTimeoutMs = 60 * 1000;
const replyTimeoutMs = 20 * 1000;
const agentStartTimeoutMs = 60 * 1000;
/** A question put again at the bottom follows the output below it by a flush, a debounce and two paced sends. */
const repostTimeoutMs = 45 * 1000;
/** The idle window of the second flow's instance, in minutes (12 s): the fire that compacts and re-asks comes this long after the last activity. */
const idleWindowMinutes = '0.2';
/** The re-asked question follows the idle window by a compaction turn and a stop. */
const reaskTimeoutMs = 90 * 1000;
/** The line the bot logs once the idle fire has stopped the agent's process (the conversation then sleeps). */
const idleStopLine = 'process stopped; the session sleeps';
/** The line the bot logs at boot for the persisted questions it brought back and the ones it dropped. */
const droppedQuestionLogLine = '[reattach] pending questions: restored 0, dropped 1';

/** The text the fake streams under a pending question (`fakeClaudeOutputWhileAskedFileName`). */
const outputWhileAskedText = 'A branch of the agent keeps working while the question waits.';

const unansweredNote = enDict['agent.question_unanswered_note'];
const askedAgainNote = enDict['agent.question_asked_again_note'];
const buildAnsweredNote = (answer: string): string => enDict['agent.question_answered_note'].replace('{answer}', answer);

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

/** Lay out a fresh instance and its fake Bot API; `extraEnv` is what the flow adds to the instance's env file. */
async function setUpInstance(layoutPrefix: string, waitTimeoutMs: number, extraEnv: Record<string, string>): Promise<void> {
  if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
  layout = createIsolatedInstanceLayout(layoutPrefix, [projectFolder], getFlowDeadlineMs());
  defaultTmuxSessionsBefore = listTmuxSessions([]);

  process.on('exit', removeInstanceSync);
  process.once('SIGINT', exitOnSignal);
  process.once('SIGTERM', exitOnSignal);

  fakeTelegram = new FakeTelegram({ botUser, operator, group });
  topic = new TopicDriver(fakeTelegram, getCharness, topicThreadId, replyTimeoutMs);
  waitingTopic = new TopicDriver(fakeTelegram, getCharness, topicThreadId, waitTimeoutMs);
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
    ...extraEnv,
  });
}

async function tearDownInstance(): Promise<void> {
  await charness?.stop();
  removeInstanceSync();
  await fakeTelegram?.stop();
  process.off('exit', removeInstanceSync);
  process.off('SIGINT', exitOnSignal);
  process.off('SIGTERM', exitOnSignal);
  assert.deepEqual(listTmuxSessions([]), defaultTmuxSessionsBefore, 'the default tmux server was not touched');
}

/** Start charness on the instance, bind the topic to the project folder and start the fake agent in it. */
async function bootBindAndStartAgent(): Promise<void> {
  charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
  await topic.sendAndAwaitReply(`/bind ${projectFolder}`, `Bound to \`${projectFolder}\``);
  await startAgentSession();
}

/** The user messages the fake agent read that carried `label`. */
function getAgentPrompts(label: string): FakeClaudePrompt[] {
  return readJsonLines<FakeClaudePrompt>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.prompts)).filter((prompt) => prompt.text.includes(label));
}

/** The answers the fake's `AskUserQuestion` got, in order (the two answers of an `ask-two` call joined). */
function getGivenAnswers(): string[] {
  return readJsonLines<FakeClaudeToolCall>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.toolCalls)).filter((call) => call.tool === fakeAskToolName).map((call) => call.outcome);
}

/** Put the question (`ask` mode, or `mode`): resolves its message once it carries the option buttons. */
async function askQuestion(driver: TopicDriver, promptLabel: string, mode: 'ask' | 'ask-two' = 'ask'): Promise<FakeTelegramMessage> {
  const sentMessageId = fakeTelegram.pushOperatorMessage(topicThreadId, `${promptLabel} [fake:${mode}] ask me something`);
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

/** The question stays as asked: header, question and EVERY option of `question`, then `note` — and no buttons. */
function assertQuestionKeptWithNote(message: FakeTelegramMessage, note: string, question: { header: string; question: string; labels: readonly string[] } = firstQuestion): void {
  const current = readKeptMessage(message);
  for (const part of [question.header, question.question, ...question.labels]) {
    assert.ok(current.text.includes(part), `the question's «${part.slice(0, 40)}…» stays: ${current.text}`);
  }
  assert.ok(current.text.endsWith(`\n\n${note}`), `the text ends with the note «${note.slice(0, 60)}»: ${current.text.slice(-120)}`);
  assert.equal(current.reply_markup, undefined, 'the buttons are gone');
}

/** What `ask` mode puts to the topic, as `assertQuestionKeptWithNote` reads it. */
const firstQuestion = {
  header: fakeAskQuestion.header,
  question: fakeAskQuestion.question,
  labels: [fakeAskQuestion.shortOptionLabel, fakeAskQuestion.longOptionLabel],
} as const;
/** The second question of `ask-two` mode. */
const secondQuestion = {
  header: fakeAskSecondQuestion.header,
  question: fakeAskSecondQuestion.question,
  labels: [fakeAskSecondQuestion.firstOptionLabel, fakeAskSecondQuestion.secondOptionLabel],
} as const;

async function waitForUnpinned(message: FakeTelegramMessage): Promise<void> {
  await getCharness().waitFor(`message ${message.message_id} to be unpinned`, replyTimeoutMs, () => !fakeTelegram.listPinnedMessageIds().includes(message.message_id));
}

/** The question is put to the topic pinned (one notification), and only then is it worth walking away from. */
async function waitForPinned(message: FakeTelegramMessage): Promise<void> {
  await getCharness().waitFor(`message ${message.message_id} to be pinned`, replyTimeoutMs, () => fakeTelegram.listPinnedMessageIds().includes(message.message_id));
}

/**
 * Run a step, then `restore` the state the next step starts from — also when the step failed, and then the step's own error
 * is the one reported (a failure of the restore after it is only logged, or it would hide what the step found).
 */
async function runStepThenRestore(step: () => Promise<void>, restore: () => Promise<void>): Promise<void> {
  let stepError: unknown;
  let hasStepFailed = false;
  try {
    await step();
  } catch (error) {
    hasStepFailed = true;
    stepError = error;
  }
  try {
    await restore();
  } catch (restoreError) {
    if (!hasStepFailed) throw restoreError;
    console.error('the restore after a failed step failed too:', restoreError);
  }
  if (hasStepFailed) throw stepError;
}

/** A new session after the previous one was stopped: the topic is bound, so `/claude` starts it. */
async function startAgentSession(): Promise<void> {
  await topic.sendAndAwaitReply('/claude', 'ready in');
}

/** A promise the test settles itself: the moment a held Bot API response is let go. */
function createRelease(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

/** The topic message that carries the option buttons of the question that follows `afterMessageId`, waited for. */
async function waitForQuestionAfter(driver: TopicDriver, description: string, afterMessageId: number, question: { question: string }): Promise<FakeTelegramMessage> {
  return driver.waitForMessage(description, (message) =>
    message.message_id > afterMessageId
    && message.text.includes(question.question)
    && driver.getKeyboardData(message).flat().some((data) => data.startsWith('qa_')));
}

describe('A question the agent asks stays in the topic however it ends, end to end: built charness, fake Bot API', () => {
  before(async () => {
    await setUpInstance('charness-qkept-', replyTimeoutMs, {});
  });

  after(tearDownInstance);

  it('boots Telegram-only against the fake Bot API, binds the topic and starts the fake agent', async () => {
    await bootBindAndStartAgent();
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

  it('a close whose edit Telegram refuses to apply to the text: the buttons are taken off all the same', async () => {
    const question = await askQuestion(topic, 'KEPT-REFUSED');
    await waitForPinned(question);
    // «message is too long» is what an over-long question plus its note gets: not a parse error, so the text is not tried again.
    fakeTelegram.failNextCall('editMessageText', 'Bad Request: message is too long', (payload) => String(payload.text).endsWith(unansweredNote));

    fakeTelegram.pushOperatorMessage(topicThreadId, 'REFUSED-1 [fake:answer] never mind the question');
    await getCharness().waitFor('the buttons to be taken off', replyTimeoutMs, () => readKeptMessage(question).reply_markup === undefined);
    const current = readKeptMessage(question);
    assert.ok(current.text.includes(fakeAskQuestion.question) && !current.text.endsWith(unansweredNote), `the text is as it was: ${current.text.slice(-80)}`);
    await waitForUnpinned(question);
  });

  it('a close whose Markdown Telegram cannot parse: the question is kept as plain text, without escape marks', async () => {
    const question = await askQuestion(topic, 'KEPT-PLAIN');
    await waitForPinned(question);
    fakeTelegram.failNextCall('editMessageText', "Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 12", (payload) => payload.parse_mode === 'Markdown' && String(payload.text).endsWith(unansweredNote));

    fakeTelegram.pushOperatorMessage(topicThreadId, 'PLAIN-1 [fake:answer] never mind the question');
    await topic.waitForMessageText('the note under the question', question, (text) => text.endsWith(`\n\n${unansweredNote}`));
    assertQuestionKeptWithNote(question, unansweredNote);
    assert.ok(!readKeptMessage(question).text.includes('*'), `plain text: no bold mark is left: ${readKeptMessage(question).text}`);
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

  it('one call with two questions, both answered: each question message keeps its own text and gets its own result', async () => {
    const answersBefore = getGivenAnswers().length;
    const first = await askQuestion(topic, 'KEPT-TWO-A', 'ask-two');
    assert.ok(!first.text.includes(secondQuestion.question), 'only the first question is on screen at first');
    await topic.tapAndAwaitAnswer(first, 'qa_0_0');
    await topic.waitForMessageText('the first answer under the first question', first, (text) => text.endsWith(buildAnsweredNote(fakeAskQuestion.shortOptionLabel)));

    // The second is a NEW message, shown once the first is answered; the first stays as it was.
    const second = await waitForQuestionAfter(topic, 'the second question', first.message_id, secondQuestion);
    assert.ok(!second.text.includes(fakeAskQuestion.question), 'the second message holds the second question alone');
    assert.deepEqual(topic.getKeyboardData(second), [['qa_1_0'], ['qa_1_1']], 'one button per option of the second question');
    assertQuestionKeptWithNote(first, buildAnsweredNote(fakeAskQuestion.shortOptionLabel));
    await topic.tapAndAwaitAnswer(second, 'qa_1_1');
    await topic.waitForMessageText('the second answer under the second question', second, (text) => text.endsWith(buildAnsweredNote(fakeAskSecondQuestion.secondOptionLabel)));

    assertQuestionKeptWithNote(first, buildAnsweredNote(fakeAskQuestion.shortOptionLabel), firstQuestion);
    assertQuestionKeptWithNote(second, buildAnsweredNote(fakeAskSecondQuestion.secondOptionLabel), secondQuestion);
    await waitForUnpinned(first);
    await waitForUnpinned(second);
    await getCharness().waitFor('the agent to get both answers', agentStartTimeoutMs, () => getGivenAnswers().length > answersBefore);
    assert.equal(getGivenAnswers().at(-1), [fakeAskQuestion.shortOptionLabel, fakeAskSecondQuestion.secondOptionLabel].join(fakeAskTwoOutcomeSeparator));
  });

  it('one call with two questions, the second left alone: the first keeps its answer, the second gets the «not answered» note', async () => {
    const first = await askQuestion(topic, 'KEPT-TWO-B', 'ask-two');
    await topic.tapAndAwaitAnswer(first, 'qa_0_1');
    await topic.waitForMessageText('the long answer under the first question', first, (text) => text.endsWith(buildAnsweredNote(fakeAskQuestion.longOptionLabel)));
    const second = await waitForQuestionAfter(topic, 'the second question', first.message_id, secondQuestion);
    await waitForPinned(second);

    fakeTelegram.pushOperatorMessage(topicThreadId, 'WALK-2 [fake:answer] leave the second question');
    await topic.waitForMessageText('the note under the second question', second, (text) => text.endsWith(`\n\n${unansweredNote}`));
    assertQuestionKeptWithNote(second, unansweredNote, secondQuestion);
    assertQuestionKeptWithNote(first, buildAnsweredNote(fakeAskQuestion.longOptionLabel), firstQuestion);
    await waitForUnpinned(second);
    await getCharness().waitFor('the new message to reach the agent as a prompt', agentStartTimeoutMs, () => getAgentPrompts('WALK-2').length > 0);
  });

  it('output landing below the question: it is posted again at the bottom and pinned, the first message stays as «asked again below», an answer closes the new one', async () => {
    fs.writeFileSync(path.join(getLayout().fakeStateDir, fakeClaudeOutputWhileAskedFileName), outputWhileAskedText);
    try {
      const repostTopic = new TopicDriver(fakeTelegram, getCharness, topicThreadId, repostTimeoutMs);
      const first = await askQuestion(repostTopic, 'KEPT-REPOST');
      // The agent's output lands below the question, which brings it back to the bottom: a newer message with the buttons.
      const reposted = await repostTopic.waitForMessage('the question posted again at the bottom', (message) =>
        message.message_id > first.message_id
        && message.text.includes(fakeAskQuestion.question)
        && repostTopic.getKeyboardData(message).flat().some((data) => data.startsWith('qa_')));
      // The text streamed while the question waits is what moved it; it may be a message of its own or carried by the one the
      // turn's earlier text is in (a continuation is appended by an edit), so only its being in the topic is asserted.
      await repostTopic.waitForMessage('the output the agent streamed while the question waited', (message) => message.text.includes(outputWhileAskedText));

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

  it('a restart that finds the agent\'s session gone: the question the bot drops at boot stays with the «not answered» note, its buttons gone and its pin released', async () => {
    const key = keyToString(makeTelegramKey(group.id, topicThreadId));
    const question = await askQuestion(topic, 'KEPT-BOOT');
    await waitForPinned(question);
    await getCharness().waitFor('the question to be saved', replyTimeoutMs, () => readPersistedState(getLayout()).pendingQuestions?.[key]?.messageId === question.message_id);

    await getCharness().stop();
    // Precondition: the bot being down closes nothing — the question is open on screen, with its buttons and its pin.
    assert.notEqual(readKeptMessage(question).reply_markup, undefined, 'precondition: the buttons are there while the bot is down');
    assert.ok(fakeTelegram.listPinnedMessageIds().includes(question.message_id), 'precondition: the question is pinned while the bot is down');
    // The agent's session is gone while the bot is down: nothing is left to answer the question.
    const killed = spawnSync('tmux', ['kill-session', '-t', `=${buildJsonStreamTmuxSessionName(makeTelegramKey(group.id, topicThreadId))}`], { env: getTmuxEnv(getLayout().tmuxTmpDir) });
    assert.equal(killed.status, 0, `the agent's tmux session was killed: ${killed.stderr.toString()}`);

    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    await getCharness().waitFor('the boot to drop the question', bootTimeoutMs, () => getCharness().output.includes(droppedQuestionLogLine));
    await topic.waitForMessageText('the note under the dropped question', question, (text) => text.endsWith(`\n\n${unansweredNote}`));
    assertQuestionKeptWithNote(question, unansweredNote);
    await waitForUnpinned(question);
    assert.equal(readPersistedState(getLayout()).pendingQuestions?.[key], undefined, 'the dropped question is gone from the saved state');
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

describe('A question the idle compaction re-asked stays too, when the conversation ends before it is used, end to end: built charness, fake Bot API', () => {
  before(async () => {
    await setUpInstance('charness-qkept-idle-', reaskTimeoutMs, { AGENT_IDLE_MINUTES: idleWindowMinutes });
  });

  after(tearDownInstance);

  function countIdleStops(): number {
    return getCharness().output.split(idleStopLine).length - 1;
  }

  /**
   * One turn first, so the idle fire has something to compress; then the question, left unanswered until the idle fire
   * rejects it, compacts, re-asks it and stops the process. Resolves the re-asked message (buttons `reask_<i>`) once the
   * conversation sleeps.
   */
  async function putReAskedQuestionAndSleep(promptLabel: string): Promise<FakeTelegramMessage> {
    fakeTelegram.pushOperatorMessage(topicThreadId, `${promptLabel}-WARM [fake:answer] one turn to compress`);
    await getCharness().waitFor(`the warm-up turn of ${promptLabel} to reach the agent`, agentStartTimeoutMs, () => getAgentPrompts(`${promptLabel}-WARM`).length > 0);
    const idleStopsBefore = countIdleStops();
    const sentMessageId = fakeTelegram.pushOperatorMessage(topicThreadId, `${promptLabel} [fake:ask] ask me something`);
    const reasked = await waitingTopic.waitForMessage(`the re-asked question of ${promptLabel}`, (message) =>
      message.message_id > sentMessageId && waitingTopic.getKeyboardData(message).flat().some((data) => data.startsWith('reask_')));
    await getCharness().waitFor(`the idle stop that follows the re-ask of ${promptLabel}`, agentStartTimeoutMs, () => countIdleStops() > idleStopsBefore);
    assert.deepEqual(waitingTopic.getKeyboardData(reasked), [['reask_0'], ['reask_1']], 'precondition: one live button per option');
    return reasked;
  }

  async function assertReAskedQuestionClosed(reasked: FakeTelegramMessage): Promise<void> {
    await waitingTopic.waitForMessageText('the note under the re-asked question', reasked, (text) => text.endsWith(`\n\n${unansweredNote}`));
    assertQuestionKeptWithNote(reasked, unansweredNote);
    // The buttons are dead for good reason now: a tap says so, instead of looking alive.
    assert.equal(await topic.tapAndAwaitAnswer(reasked, 'reask_0'), enDict['cb.no_pending_question']);
  }

  it('boots with a short idle window, binds the topic and starts the fake agent', async () => {
    await bootBindAndStartAgent();
  });

  it('/quit of the sleeping conversation: the re-asked question stays with the «not answered» note instead of dead buttons', async () => {
    const reasked = await putReAskedQuestionAndSleep('REASK-QUIT');
    // The next step starts from a live session, whatever this one found.
    await runStepThenRestore(async () => {
      await topic.sendAndAwaitReply('/quit', enDict['agent.sleeping_released']);
      await assertReAskedQuestionClosed(reasked);
    }, startAgentSession);
  });

  it('/new of the sleeping conversation: the same', async () => {
    const reasked = await putReAskedQuestionAndSleep('REASK-NEW');
    const newCommandId = fakeTelegram.pushOperatorMessage(topicThreadId, '/new');
    await assertReAskedQuestionClosed(reasked);
    await waitingTopic.waitForMessage('the fresh session', (message) => message.message_id > newCommandId && message.text.includes('ready in'));
  });

  it('leaving the folder with the conversation asleep: the same', async () => {
    const reasked = await putReAskedQuestionAndSleep('REASK-LEAVE');
    // The next step starts from a bound topic with a live session, whatever this one found.
    await runStepThenRestore(async () => {
      const picker = await topic.sendAndAwaitReply('/bind', enDict['bind.current'].replace('{subdir}', projectFolder));
      await topic.tapAndAwaitAnswer(picker, bindLeaveCurrentCallback);
      await assertReAskedQuestionClosed(reasked);
    }, async () => {
      await topic.sendAndAwaitReply(`/bind ${projectFolder}`, `Bound to \`${projectFolder}\``);
      await startAgentSession();
    });
  });

  it('/quit while the re-asked question is still being sent: the message that lands is closed the same', async () => {
    const sendHold = createRelease();
    // The Bot API holds the answer to the re-asked question's send: the message exists, the bot does not know its id yet.
    fakeTelegram.holdNextResponse('sendMessage', sendHold.promise, (payload) => JSON.stringify(payload.reply_markup ?? null).includes('reask_'));
    await runStepThenRestore(async () => {
      fakeTelegram.pushOperatorMessage(topicThreadId, 'REASK-INFLIGHT-WARM [fake:answer] one turn to compress');
      await getCharness().waitFor('the warm-up turn to reach the agent', agentStartTimeoutMs, () => getAgentPrompts('REASK-INFLIGHT-WARM').length > 0);
      const sentMessageId = fakeTelegram.pushOperatorMessage(topicThreadId, 'REASK-INFLIGHT [fake:ask] ask me something');
      const reasked = await waitingTopic.waitForMessage('the re-asked question, its send held', (message) =>
        message.message_id > sentMessageId && waitingTopic.getKeyboardData(message).flat().some((data) => data.startsWith('reask_')));

      // The send being held, nothing else can be sent either (sends are paced in order): the stop is read off the saved state
      // instead — it clears the conversation's compaction marks, which the idle fire left behind, the way any stop does.
      const key = keyToString(makeTelegramKey(group.id, topicThreadId));
      assert.ok(readPersistedState(getLayout()).compactIdleTracking?.[key], 'precondition: the idle fire left its marks on the saved state');
      fakeTelegram.pushOperatorMessage(topicThreadId, '/quit');
      await getCharness().waitFor('the stop to clear the conversation\'s compaction marks', replyTimeoutMs, () => readPersistedState(getLayout()).compactIdleTracking?.[key] === undefined);
      assert.notEqual(readKeptMessage(reasked).reply_markup, undefined, 'precondition: the stop alone leaves the held message as it is');
      sendHold.release();
      await assertReAskedQuestionClosed(reasked);
    }, async () => {
      // The next step starts from a live session, whatever this one found.
      sendHold.release();
      await startAgentSession();
    });
  });

  it('/quitall with the conversation asleep: the same', async () => {
    const reasked = await putReAskedQuestionAndSleep('REASK-ALL');
    // The next step starts from a live session, whatever this one found.
    await runStepThenRestore(async () => {
      // The menu's spelling: a hyphen ends a command in Telegram, so `/quit-all` reaches the bot as `/quit`.
      fakeTelegram.pushOperatorMessage(generalTopicThreadId, '/quitall');
      await assertReAskedQuestionClosed(reasked);
    }, startAgentSession);
  });

  it('a restart of the bot while the re-asked question waits and the conversation sleeps: its buttons still work', async () => {
    const reasked = await putReAskedQuestionAndSleep('REASK-BOOT');
    const labelPromptsBefore = getAgentPrompts(fakeAskQuestion.shortOptionLabel).length;

    charness = await restartCharnessWithState(getLayout(), fakeTelegram, getCharness(), () => {});
    assert.notEqual(readKeptMessage(reasked).reply_markup, undefined, 'the restart leaves the question open');
    assert.equal(await topic.tapAndAwaitAnswer(reasked, 'reask_0'), fakeAskQuestion.shortOptionLabel, 'the button still knows its question');
    await getCharness().waitFor('the label to reach the resumed agent', agentStartTimeoutMs, () => getAgentPrompts(fakeAskQuestion.shortOptionLabel).length > labelPromptsBefore);
    await waitingTopic.waitForMessageText('the answer under the re-asked question', reasked, (text) => text.endsWith(buildAnsweredNote(fakeAskQuestion.shortOptionLabel)));
    assertQuestionKeptWithNote(reasked, buildAnsweredNote(fakeAskQuestion.shortOptionLabel));
  });

  it('a restart of the bot after the conversation was released while it was down: the re-asked question is closed at boot', async () => {
    const reasked = await putReAskedQuestionAndSleep('REASK-GONE');
    const key = keyToString(makeTelegramKey(group.id, topicThreadId));

    await runStepThenRestore(async () => {
      charness = await restartCharnessWithState(getLayout(), fakeTelegram, getCharness(), (persisted) => {
        // What `/quit` does to a sleeping conversation, done while the bot is down: nothing is left to resume.
        const agent = persisted.agents?.[key];
        if (agent) delete agent.claudeSessionId;
      });
      await assertReAskedQuestionClosed(reasked);
      assert.equal(readPersistedState(getLayout()).reAskedQuestions?.[key], undefined, 'the saved question is gone with it');
    }, startAgentSession);
  });

  it('a message of the person\'s instead of a tap: the re-asked question stays with the same note, and the agent gets the message', async () => {
    const reasked = await putReAskedQuestionAndSleep('REASK-INSTEAD');
    fakeTelegram.pushOperatorMessage(topicThreadId, 'INSTEAD-1 [fake:answer] a message instead of a tap');
    await assertReAskedQuestionClosed(reasked);
    await waitingTopic.waitForMessage('the woken agent to answer', (message) => message.message_id > reasked.message_id && message.text.includes('Working on INSTEAD-1.'));
  });

  it('a button of a re-asked question that was left behind never lands on the question the agent asks next', async () => {
    const reasked = await putReAskedQuestionAndSleep('REASK-STALE');
    // The person writes again and the agent they woke asks a NEW question: the one that waits now is that one.
    const newer = await askQuestion(waitingTopic, 'STALE-1');
    assert.ok(newer.message_id > reasked.message_id, 'the newer question is a later message');
    await waitForPinned(newer);
    const answersBefore = getGivenAnswers().length;

    await assertReAskedQuestionClosed(reasked);
    // The old buttons did nothing: the newer question is as it was, still waiting, with its buttons and its pin.
    assert.deepEqual(topic.getKeyboardData(readKeptMessage(newer)), [['qa_0_0'], ['qa_0_1']], 'the newer question keeps its buttons');
    assert.ok(fakeTelegram.listPinnedMessageIds().includes(newer.message_id), 'and its pin');
    assert.equal(getGivenAnswers().length, answersBefore, 'and the agent was told nothing about it');
    await topic.tapAndAwaitAnswer(newer, 'qa_0_0');
    await topic.waitForMessageText('the answer under the newer question', newer, (text) => text.endsWith(buildAnsweredNote(fakeAskQuestion.shortOptionLabel)));
  });
});
