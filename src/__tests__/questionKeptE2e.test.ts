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
 *   → a question so long that its answer note does not fit under it: the option descriptions are left out, the answer shows
 *   → the agent's process exits (the CLI dies) with the question open: the same note, the pin gone
 *   → `/quit` (the session is stopped with the question open): the same note
 *   → one call with TWO questions (`ask-two`): each question message keeps its own text and gets its own result — both
 *     answered by a tap; the first answered and the second left alone
 *   → output landing below the question (a branch of the agent that keeps streaming): the question is posted again at the
 *     bottom and pinned, the first message stays as «asked again below» and is unpinned; an answer to the new one
 *     closes it with the answer
 *   → output landing again and again: the first message stays as the record, the newest copy is the live one, and the
 *     copies in between are deleted (two messages at most)
 *   → the question cannot be put again at the bottom (both sends of the new copy are refused): the old copy is NOT marked
 *     «asked again below», keeps its buttons and still answers
 *   → an option number typed while the question's own message is still being sent: the answer shows under it once it lands
 *   → the bot restarts with a saved re-asked copy next to a live question: the stale copy is closed, the question restored
 *   → the bot restarts while the question is open and finds the agent's session gone: the question the bot dropped at boot
 *     stays with the same note, its buttons gone and its pin released
 *   → leaving the folder with the question open (the json-stream stop is reported late): the same note, the pin gone
 *   → «create new folder» of `/bind` (it drops a pending question): the same note
 *
 * The second, on an instance whose idle window is seconds, so the idle compaction re-asks a question the agent was left
 * waiting on: the re-asked copy has `reask_<i>` buttons, and when the conversation ends without them being used the
 * copy stays with the same note instead of keeping buttons that are dead — whichever way it ends: `/quit`, `/quitall` or
 * `/new` of the sleeping conversation, leaving the folder, a message of the person's instead of a tap (the copy is
 * not left to be tapped later, onto whatever the agent asks next — also one typed while the idle stop is under way), a
 * stop that comes while the re-asked message is still being sent, or a restart of the bot that finds the conversation
 * released (one that finds it asleep keeps the buttons working). Also: the old question says «asked again below» only once
 * the re-ask is there (and «not answered» if the re-ask could not be sent) while its buttons are taken off at once; a bot
 * restart during the compaction ends the old question as «not answered»; a message the person writes during the compaction
 * stops the re-ask, and an option NUMBER typed then — or later, to the re-asked copy — answers the question; picking another conversation (`/sessions`) or another backend
 * (`/terminal`) closes the re-asked copy of the one left; a button left on an older re-asked message
 * never answers a newer one (and the message it sits on is closed with its own text and the same note); two quick taps send
 * one answer; a tap on a re-ask still being sent counts; a number typed while the re-ask is being sent shows the answer
 * once the agent got it; a number typed under a copy whose conversation cannot be started shows no answer and leaves the
 * buttons; a long label is shown once, under the question.
 *
 * Nothing leaves the machine: the Bot API is on loopback and the agent is a fake. Everything the test starts is stopped
 * in `after`. The idle compaction's re-ask itself is in `reaskedQuestionE2e.test.ts`; the OpenCode backend's cancel is in
 * `openCodeInterruptE2e.test.ts`; its new question while a re-asked copy waits, and an error with a question open, in
 * `openCodeQuestionE2e.test.ts`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram, generalTopicThreadId, type FakeTelegramMessage } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import {
  fakeAskLongDescription,
  fakeAskNoAnswerOutcome,
  fakeAskQuestion,
  fakeAskSecondQuestion,
  fakeAskToolName,
  fakeAskTwoOutcomeSeparator,
  fakeClaudeIgnoreStopSignalsFileName,
  fakeClaudeLogFileNames,
  fakeClaudeNextOutputWhileAskedFileName,
  fakeClaudeOutputWhileAskedFileName,
  fakeClaudeRefuseLaunchFileName,
  getFakeClaudeTranscriptPath,
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
import { getStatePath, readPersistedState, restartCharnessWithState, startCharnessOnInstance } from './e2e/fallbackFlowKit';
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
/** The line the bot logs as the idle fire begins to stop the agent's process (a message typed from here is buffered). */
const idleStopStartLine = 'stopping the idle process';
/** The line the bot logs at boot for the persisted questions it brought back and the ones it dropped. */
const droppedQuestionLogLine = '[reattach] pending questions: restored 0, dropped 1';

/** The text the fake streams under a pending question (`fakeClaudeOutputWhileAskedFileName`). */
const outputWhileAskedText = 'A branch of the agent keeps working while the question waits.';
/** A number typed under a sleeping conversation that cannot be started: the start fails inside the agent-start window. */
const failedStartTimeoutMs = agentStartTimeoutMs;

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
async function askQuestion(driver: TopicDriver, promptLabel: string, mode: 'ask' | 'ask-two' | 'ask-long' = 'ask'): Promise<FakeTelegramMessage> {
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
  await waitingTopic.sendAndAwaitReply('/claude', 'ready in');
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

  it('the agent\'s process exits while a question is open: the question stays with the «not answered» note, its buttons gone and its pin released', async () => {
    const question = await askQuestion(topic, 'KEPT-DIED');
    await waitForPinned(question);
    const agentPid = getAgentPrompts('KEPT-DIED')[0]?.pid;
    assert.ok(agentPid !== undefined, 'the process that put the question');

    // The CLI dies under the bot (the backend this flow runs: a json-stream process, which the bot reports as a session that
    // ended unexpectedly), not a stop the person asked for. The next step starts from a live session.
    await runStepThenRestore(async () => {
      process.kill(agentPid, 'SIGKILL');
      await topic.waitForMessageText('the note under the question', question, (text) => text.endsWith(`\n\n${unansweredNote}`));
      assertQuestionKeptWithNote(question, unansweredNote);
      await waitForUnpinned(question);
    }, async () => {
      // The conversation ended on its own and `/claude` picks it up silently: a fresh one gives the next step its session.
      await topic.sendAndAwaitReply('/new', 'ready in');
    });
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

  it('output landing again and again under the waiting question: the first message is the record, the live copy is the newest, the copies in between are deleted', async () => {
    fs.writeFileSync(path.join(getLayout().fakeStateDir, fakeClaudeOutputWhileAskedFileName), `${outputWhileAskedText} 1`);
    const nextOutputPath = path.join(getLayout().fakeStateDir, fakeClaudeNextOutputWhileAskedFileName);
    try {
      const repostTopic = new TopicDriver(fakeTelegram, getCharness, topicThreadId, repostTimeoutMs);
      const first = await askQuestion(repostTopic, 'KEPT-BURSTS');
      const isCopyAfter = (afterMessageId: number) => (message: FakeTelegramMessage): boolean =>
        message.message_id > afterMessageId && message.text.includes(fakeAskQuestion.question) && repostTopic.getKeyboardData(message).flat().some((data) => data.startsWith('qa_'));

      // Burst one brings the first copy, and each burst the agent streams after the bot has put the question back brings one more.
      const firstCopy = await repostTopic.waitForMessage('the question posted again after the first burst', isCopyAfter(first.message_id));
      await repostTopic.waitForMessageText('the first message marked as asked again', first, (text) => text.endsWith(`\n\n${askedAgainNote}`));
      fs.writeFileSync(nextOutputPath, `${outputWhileAskedText} 2`);
      const secondCopy = await repostTopic.waitForMessage('the question posted again after the second burst', isCopyAfter(firstCopy.message_id));
      fs.writeFileSync(nextOutputPath, `${outputWhileAskedText} 3`);
      const thirdCopy = await repostTopic.waitForMessage('the question posted again after the third burst', isCopyAfter(secondCopy.message_id));

      // The copies in between only duplicate the record, so they are deleted once the next one is there.
      await getCharness().waitFor('the copies in between to be deleted', repostTimeoutMs, () => [firstCopy, secondCopy].every((copy) => fakeTelegram.getMessage(copy.message_id)?.isDeleted));
      const questionMessages = fakeTelegram.listBotMessages(topicThreadId).filter((message) => message.message_id >= first.message_id && message.text.includes(fakeAskQuestion.question));
      assert.deepEqual(questionMessages.map((message) => message.message_id), [first.message_id, thirdCopy.message_id], 'the topic holds the original and the live copy, nothing else');
      assertQuestionKeptWithNote(first, askedAgainNote);
      assert.deepEqual(topic.getKeyboardData(readKeptMessage(thirdCopy)), [['qa_0_0'], ['qa_0_1']], 'the live copy has the buttons');
      await waitForPinned(thirdCopy);

      await topic.tapAndAwaitAnswer(thirdCopy, 'qa_0_0');
      await topic.waitForMessageText('the answer under the live copy', thirdCopy, (text) => text.endsWith(buildAnsweredNote(fakeAskQuestion.shortOptionLabel)));
      assertQuestionKeptWithNote(first, askedAgainNote);
      await waitForUnpinned(thirdCopy);
    } finally {
      fs.rmSync(path.join(getLayout().fakeStateDir, fakeClaudeOutputWhileAskedFileName), { force: true });
      fs.rmSync(nextOutputPath, { force: true });
    }
  });

  it('a restart between two re-posts: the first message is still the record, the copy from before the restart is deleted, and the topic holds the original and the live copy', async () => {
    fs.writeFileSync(path.join(getLayout().fakeStateDir, fakeClaudeOutputWhileAskedFileName), `${outputWhileAskedText} 1`);
    const nextOutputPath = path.join(getLayout().fakeStateDir, fakeClaudeNextOutputWhileAskedFileName);
    const key = keyToString(makeTelegramKey(group.id, topicThreadId));
    try {
      const repostTopic = new TopicDriver(fakeTelegram, getCharness, topicThreadId, repostTimeoutMs);
      const first = await askQuestion(repostTopic, 'KEPT-RESTART-REPOST');
      const isCopyAfter = (afterMessageId: number) => (message: FakeTelegramMessage): boolean =>
        message.message_id > afterMessageId && message.text.includes(fakeAskQuestion.question) && repostTopic.getKeyboardData(message).flat().some((data) => data.startsWith('qa_'));
      const firstCopy = await repostTopic.waitForMessage('the question posted again after the first burst', isCopyAfter(first.message_id));
      await repostTopic.waitForMessageText('the first message marked as asked again', first, (text) => text.endsWith(`\n\n${askedAgainNote}`));
      await waitForPinned(firstCopy);
      await getCharness().waitFor('the live copy to be saved', replyTimeoutMs, () => readPersistedState(getLayout()).pendingQuestions?.[key]?.messageId === firstCopy.message_id);

      // The bot restarts: the question is restored as the copy that waits. Which message is the original has to survive the restart.
      charness = await restartCharnessWithState(getLayout(), fakeTelegram, getCharness(), () => {});
      assert.notEqual(readKeptMessage(firstCopy).reply_markup, undefined, 'the live copy kept its buttons through the restart');
      fs.writeFileSync(nextOutputPath, `${outputWhileAskedText} 2`);
      const secondCopy = await repostTopic.waitForMessage('the question posted again after the restart', isCopyAfter(firstCopy.message_id));

      // The copy from before the restart only duplicates the record, so it is deleted; the first message stays.
      await getCharness().waitFor('the copy from before the restart to be deleted', repostTimeoutMs, () => fakeTelegram.getMessage(firstCopy.message_id)?.isDeleted === true);
      const questionMessages = fakeTelegram.listBotMessages(topicThreadId).filter((message) => message.message_id >= first.message_id && message.text.includes(fakeAskQuestion.question));
      assert.deepEqual(questionMessages.map((message) => message.message_id), [first.message_id, secondCopy.message_id], 'the topic holds the original and the live copy, nothing else');
      assertQuestionKeptWithNote(first, askedAgainNote);

      await topic.tapAndAwaitAnswer(secondCopy, 'qa_0_0');
      await topic.waitForMessageText('the answer under the live copy', secondCopy, (text) => text.endsWith(buildAnsweredNote(fakeAskQuestion.shortOptionLabel)));
      await waitForUnpinned(secondCopy);
    } finally {
      fs.rmSync(path.join(getLayout().fakeStateDir, fakeClaudeOutputWhileAskedFileName), { force: true });
      fs.rmSync(nextOutputPath, { force: true });
    }
  });

  it('a question so long that its answer note does not fit under it: the option descriptions are left out and the answer still shows', async () => {
    const question = await askQuestion(topic, 'KEPT-LONG', 'ask-long');
    assert.ok(question.text.length > 3500 && question.text.length <= 4096, `precondition: the question fills a message: ${question.text.length} characters`);
    assert.ok(question.text.length + buildAnsweredNote(fakeAskQuestion.longOptionLabel).length > 4096, 'precondition: and has no room for the answer note');
    await waitForPinned(question);

    await topic.tapAndAwaitAnswer(question, 'qa_0_1');
    await topic.waitForMessageText('the answer under the long question', question, (text) => text.endsWith(buildAnsweredNote(fakeAskQuestion.longOptionLabel)));
    const current = readKeptMessage(question);
    assert.ok(current.text.length <= 4096, `the closed text fits a message: ${current.text.length}`);
    assert.ok(!current.text.includes(fakeAskLongDescription), 'the long descriptions are what was left out');
    assertQuestionKeptWithNote(question, buildAnsweredNote(fakeAskQuestion.longOptionLabel));
    await waitForUnpinned(question);
    await getCharness().waitFor('the agent to get the answer', agentStartTimeoutMs, () => getGivenAnswers().includes(fakeAskQuestion.longOptionLabel));
  });

  it('the question cannot be put again at the bottom: the old copy is not marked «asked again below», keeps its buttons and still answers', async () => {
    fs.writeFileSync(path.join(getLayout().fakeStateDir, fakeClaudeOutputWhileAskedFileName), outputWhileAskedText);
    const isQuestionSend = (payload: Record<string, unknown>): boolean => payload.message_thread_id === topicThreadId && JSON.stringify(payload.reply_markup ?? null).includes('qa_');
    const countQuestionSends = (): number => fakeTelegram.listCalls('sendMessage').filter((call) => isQuestionSend(call.payload)).length;
    const sendsBefore = countQuestionSends();
    try {
      const question = await askQuestion(topic, 'KEPT-NOREPOST');
      await waitForPinned(question);
      // The agent's output below the question brings the re-post; both of its attempts (Markdown, then plain) are refused.
      fakeTelegram.failNextCall('sendMessage', 'Bad Request: message is too long', isQuestionSend);
      fakeTelegram.failNextCall('sendMessage', 'Bad Request: message is too long', isQuestionSend);
      await getCharness().waitFor('both attempts at the new copy to be refused', repostTimeoutMs, () => countQuestionSends() - sendsBefore >= 3);

      // Nothing is below: the old copy does not say so, and it is the question that waits.
      const waiting = readKeptMessage(question);
      assert.ok(!waiting.text.endsWith(askedAgainNote), `not «asked again below» with nothing below: ${waiting.text.slice(-60)}`);
      assert.deepEqual(topic.getKeyboardData(waiting), [['qa_0_0'], ['qa_0_1']], 'it keeps its buttons');
      assert.ok(fakeTelegram.listPinnedMessageIds().includes(question.message_id), 'and its pin');

      await topic.tapAndAwaitAnswer(question, 'qa_0_0');
      await topic.waitForMessageText('the answer under the old copy', question, (text) => text.endsWith(buildAnsweredNote(fakeAskQuestion.shortOptionLabel)));
      assertQuestionKeptWithNote(question, buildAnsweredNote(fakeAskQuestion.shortOptionLabel));
      await waitForUnpinned(question);
    } finally {
      fs.rmSync(path.join(getLayout().fakeStateDir, fakeClaudeOutputWhileAskedFileName), { force: true });
    }
  });

  it('an option number typed while the question\'s own message is still being sent: the answer shows under it once it lands', async () => {
    const sendHold = createRelease();
    // The Bot API holds the answer to the question's send: the message exists, the bot does not know its id yet.
    fakeTelegram.holdNextResponse('sendMessage', sendHold.promise, (payload) => payload.message_thread_id === topicThreadId && JSON.stringify(payload.reply_markup ?? null).includes('qa_'));
    await runStepThenRestore(async () => {
      const sentMessageId = fakeTelegram.pushOperatorMessage(topicThreadId, 'KEPT-INFLIGHTANS [fake:ask] ask me something');
      const question = await waitForQuestionAfter(topic, 'the question, its send held', sentMessageId, firstQuestion);
      fakeTelegram.pushOperatorMessage(topicThreadId, '1');
      sendHold.release();

      await topic.waitForMessageText('the answer under the question', question, (text) => text.endsWith(buildAnsweredNote(fakeAskQuestion.shortOptionLabel)));
      assertQuestionKeptWithNote(question, buildAnsweredNote(fakeAskQuestion.shortOptionLabel));
      await waitForUnpinned(question);
      await getCharness().waitFor('the agent to get the answer', agentStartTimeoutMs, () => getGivenAnswers().includes(fakeAskQuestion.shortOptionLabel));
    }, async () => {
      sendHold.release();
    });
  });

  it('a restart with a saved re-asked copy next to a live question: the stale copy is closed, the question is restored and answers', async () => {
    const key = keyToString(makeTelegramKey(group.id, topicThreadId));
    // Any bot message will do as the stale copy's message: the boot only needs an id to close.
    const staleCopy = await topic.sendAndAwaitReply('/timezone Not/AZone', 'Not/AZone');
    const question = await askQuestion(topic, 'KEPT-STALECOPY');
    await waitForPinned(question);
    await getCharness().waitFor('the question to be saved', replyTimeoutMs, () => readPersistedState(getLayout()).pendingQuestions?.[key]?.messageId === question.message_id);

    charness = await restartCharnessWithState(getLayout(), fakeTelegram, getCharness(), (persisted) => {
      persisted.reAskedQuestions = {
        [key]: { messageId: staleCopy.message_id, question: { header: fakeAskQuestion.header, question: fakeAskQuestion.question, options: [{ label: fakeAskQuestion.shortOptionLabel }, { label: fakeAskQuestion.longOptionLabel }] } },
      };
    });
    // The newer question is what waits: the old copy's buttons would deliver into it.
    await topic.waitForMessageText('the stale copy closed', staleCopy, (text) => text.endsWith(`\n\n${unansweredNote}`));
    assertQuestionKeptWithNote(staleCopy, unansweredNote);
    await getCharness().waitFor('the saved copy to be dropped', replyTimeoutMs, () => readPersistedState(getLayout()).reAskedQuestions?.[key] === undefined);
    assert.notEqual(readKeptMessage(question).reply_markup, undefined, 'the live question kept its buttons');
    await topic.tapAndAwaitAnswer(question, 'qa_0_0');
    await topic.waitForMessageText('the answer under the restored question', question, (text) => text.endsWith(buildAnsweredNote(fakeAskQuestion.shortOptionLabel)));
    await getCharness().waitFor('the agent to get the answer', agentStartTimeoutMs, () => getAgentPrompts('KEPT-STALECOPY').length > 0 && getGivenAnswers().includes(fakeAskQuestion.shortOptionLabel));
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

  it('leaving the folder with the question open: it stays with the same note, its buttons gone and its pin released', async () => {
    const question = await askQuestion(topic, 'KEPT-LEAVE');
    await waitForPinned(question);

    // The json-stream process stops in the background after the unbind, so the bot's pending question is gone long before
    // the stop is reported: the note has to come from the unbind itself. The next step starts from a bound topic with a session.
    await runStepThenRestore(async () => {
      const picker = await topic.sendAndAwaitReply('/bind', enDict['bind.current'].replace('{subdir}', projectFolder));
      await topic.tapAndAwaitAnswer(picker, bindLeaveCurrentCallback);
      await topic.waitForMessageText('the note under the question', question, (text) => text.endsWith(`\n\n${unansweredNote}`));
      assertQuestionKeptWithNote(question, unansweredNote);
      await waitForUnpinned(question);
    }, async () => {
      await topic.sendAndAwaitReply(`/bind ${projectFolder}`, `Bound to \`${projectFolder}\``);
      await startAgentSession();
    });
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

  function countIdleStopStarts(): number {
    return getCharness().output.split(idleStopStartLine).length - 1;
  }

  /**
   * One turn first, so the idle fire has something to compress; then the question, left unanswered until the idle fire
   * rejects it, compacts, re-asks it and stops the process. Resolves the re-asked message (buttons `reask_<i>`) once the
   * conversation sleeps — or, with `isStopAwaited: false`, as soon as the stop BEGINS (a message typed from there is
   * buffered).
   */
  async function putReAskedQuestionAndSleep(promptLabel: string, options: { isStopAwaited: boolean } = { isStopAwaited: true }): Promise<FakeTelegramMessage> {
    fakeTelegram.pushOperatorMessage(topicThreadId, `${promptLabel}-WARM [fake:answer] one turn to compress`);
    await getCharness().waitFor(`the warm-up turn of ${promptLabel} to reach the agent`, agentStartTimeoutMs, () => getAgentPrompts(`${promptLabel}-WARM`).length > 0);
    const idleStopsBefore = countIdleStops();
    const idleStopStartsBefore = countIdleStopStarts();
    const sentMessageId = fakeTelegram.pushOperatorMessage(topicThreadId, `${promptLabel} [fake:ask] ask me something`);
    const reasked = await waitingTopic.waitForMessage(`the re-asked question of ${promptLabel}`, (message) =>
      message.message_id > sentMessageId && waitingTopic.getKeyboardData(message).flat().some((data) => data.startsWith('reask_')));
    if (options.isStopAwaited) {
      await getCharness().waitFor(`the idle stop that follows the re-ask of ${promptLabel}`, agentStartTimeoutMs, () => countIdleStops() > idleStopsBefore);
    } else {
      await getCharness().waitFor(`the idle stop that follows the re-ask of ${promptLabel} to begin`, agentStartTimeoutMs, () => countIdleStopStarts() > idleStopStartsBefore);
    }
    assert.deepEqual(waitingTopic.getKeyboardData(reasked), [['reask_0'], ['reask_1']], 'precondition: one live button per option');
    return reasked;
  }

  /** The re-asked question's option label a `reask_<i>` tap delivers, and how often the agent has read it so far. */
  const countLabelPrompts = (label: string): number => getAgentPrompts(label).length;

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

  /**
   * The newest message that holds the question as it was asked (not a re-ask): the copy that waits — the agent's output under
   * a pending question puts the question again at the bottom, which leaves the older copy as a record, so the waiting one is
   * not always the first posted.
   */
  const findNewestQuestionCopy = (): FakeTelegramMessage | undefined =>
    [...topic.listMessages()].reverse().find((message) => message.text.includes(fakeAskQuestion.question) && !topic.getKeyboardData(message).flat().some((data) => data.startsWith('reask_')));

  /** The payload of the send that carries a re-asked question: its buttons are `reask_<i>`. */
  const isReAskSend = (payload: Record<string, unknown>): boolean => JSON.stringify(payload.reply_markup ?? null).includes('reask_');

  it('a button left on an older re-asked message never answers a newer re-asked question', async () => {
    const shortLabel = fakeAskQuestion.shortOptionLabel;
    const older = await putReAskedQuestionAndSleep('REASK-OLDER');
    // Telegram refuses to touch the older message when it is closed (its text and its buttons alike): it keeps live buttons
    // while the person goes on and the agent's next question is re-asked in its turn.
    const isOlder = (payload: Record<string, unknown>): boolean => payload.message_id === older.message_id;
    fakeTelegram.failNextCall('editMessageText', "Bad Request: message can't be edited", isOlder);
    fakeTelegram.failNextCall('editMessageReplyMarkup', "Bad Request: message can't be edited", isOlder);
    const newer = await putReAskedQuestionAndSleep('REASK-NEWER');
    assert.ok(newer.message_id > older.message_id, 'the newer re-ask is a later message');
    assert.notEqual(readKeptMessage(older).reply_markup, undefined, 'precondition: the refused close left the older message its buttons');
    const newerText = readKeptMessage(newer).text;
    const labelPromptsBefore = countLabelPrompts(shortLabel);

    assert.equal(await topic.tapAndAwaitAnswer(older, 'reask_0'), enDict['cb.no_pending_question'], 'the old button answers nothing');
    // The tapped message is an orphan nothing in the bot knows: it ends where it stands, its own text kept and «not answered»
    // in place of the buttons, so it is not left with no result at all.
    await waitingTopic.waitForMessageText('the older message closed with its own text', older, (text) => text.endsWith(`\n\n${unansweredNote}`));
    // A re-asked message names its options only on the buttons, so what stays is its header and question.
    assertQuestionKeptWithNote(older, unansweredNote, { header: fakeAskQuestion.header, question: fakeAskQuestion.question, labels: [] });
    assert.equal(countLabelPrompts(shortLabel), labelPromptsBefore, 'and sends nothing to the agent');
    assert.equal(readKeptMessage(newer).text, newerText, 'the newer message is as it was');
    assert.deepEqual(waitingTopic.getKeyboardData(readKeptMessage(newer)), [['reask_0'], ['reask_1']], 'with its buttons');

    // The newer one still works, and the answer lands on IT.
    assert.equal(await topic.tapAndAwaitAnswer(newer, 'reask_0'), shortLabel);
    await getCharness().waitFor('the label to reach the agent', agentStartTimeoutMs, () => countLabelPrompts(shortLabel) > labelPromptsBefore);
    await waitingTopic.waitForMessageText('the answer under the newer question', newer, (text) => text.endsWith(buildAnsweredNote(shortLabel)));
    assert.ok(!readKeptMessage(older).text.includes(buildAnsweredNote(shortLabel)), 'the older message shows no answer');
  });

  it('a message typed while the idle stop is under way closes the re-asked question too', async () => {
    // The process ignores the stop signals, so the stop lasts its kill wait: the message is typed inside that window, where
    // it is buffered for the session to come.
    const ignoreStopSignalsPath = path.join(getLayout().fakeStateDir, fakeClaudeIgnoreStopSignalsFileName);
    fs.writeFileSync(ignoreStopSignalsPath, '');
    await runStepThenRestore(async () => {
      const idleStopsBefore = countIdleStops();
      const reasked = await putReAskedQuestionAndSleep('REASK-STOPPING', { isStopAwaited: false });
      assert.equal(countIdleStops(), idleStopsBefore, 'precondition: the stop is under way, not over');

      fakeTelegram.pushOperatorMessage(topicThreadId, 'STOPPING-1 [fake:answer] typed while the process is being stopped');
      await assertReAskedQuestionClosed(reasked);
      await getCharness().waitFor('the buffered message to reach the agent', agentStartTimeoutMs, () => getAgentPrompts('STOPPING-1').length > 0);
    }, async () => {
      fs.rmSync(ignoreStopSignalsPath, { force: true });
    });
  });

  it('a long label tapped on a re-asked question is posted whole only when the close could not show it', async () => {
    const longLabel = fakeAskQuestion.longOptionLabel;
    const reasked = await putReAskedQuestionAndSleep('REASK-LONGLABEL');
    fakeTelegram.failNextCall('editMessageText', "Bad Request: message can't be edited", (payload) =>
      payload.message_id === reasked.message_id && String(payload.text).endsWith(buildAnsweredNote(longLabel)));
    const labelPromptsBefore = countLabelPrompts(longLabel);

    const toast = await topic.tapAndAwaitAnswer(reasked, 'reask_1');
    assert.ok(toast.length <= 200 && toast.endsWith('…'), `the toast is the start of the label: ${toast.length} characters`);
    const posted = await waitingTopic.waitForMessage('the label posted in full', (message) => message.text === longLabel);
    assert.ok(posted.message_id > reasked.message_id);
    await getCharness().waitFor('the whole label to reach the agent', agentStartTimeoutMs, () => countLabelPrompts(longLabel) > labelPromptsBefore);
    await getCharness().waitFor('the buttons to be taken off the message whose close was refused', replyTimeoutMs, () => readKeptMessage(reasked).reply_markup === undefined);
    assert.equal(topic.listMessages().filter((message) => message.text === longLabel).length, 1, 'the record of the answer is one message');
  });

  it('two quick taps on a re-asked question send ONE answer', async () => {
    const shortLabel = fakeAskQuestion.shortOptionLabel;
    const reasked = await putReAskedQuestionAndSleep('REASK-TWICE');
    const labelPromptsBefore = countLabelPrompts(shortLabel);
    const answersBefore = fakeTelegram.callbackAnswers.length;

    // Both arrive in one batch; waking the sleeping conversation takes the first a while, and the second finds it taken.
    fakeTelegram.pushCallback(reasked.message_id, 'reask_0');
    fakeTelegram.pushCallback(reasked.message_id, 'reask_0');
    await getCharness().waitFor('both taps to be answered', agentStartTimeoutMs, () => fakeTelegram.callbackAnswers.length >= answersBefore + 2);
    assert.deepEqual([...fakeTelegram.callbackAnswers.slice(answersBefore, answersBefore + 2)].sort(), [enDict['cb.no_pending_question'], shortLabel].sort(), 'one tap is answered with the label, the other says it is spent');
    await waitingTopic.waitForMessageText('the answer under the re-asked question', reasked, (text) => text.endsWith(buildAnsweredNote(shortLabel)));
    await getCharness().waitFor('the agent to read the label', agentStartTimeoutMs, () => countLabelPrompts(shortLabel) > labelPromptsBefore);
    assert.equal(countLabelPrompts(shortLabel), labelPromptsBefore + 1, 'the agent read the label once');

    // The second tap runs only after the first has written the answer, and whatever it edits waits its turn in the send pacer,
    // behind the answer and ahead of anything the bot sends after it: a reply to a command typed now is sent after that edit, so
    // when it is there nothing is queued any more. The answer must still be the last word on the message.
    await waitingTopic.sendAndAwaitReply('/timezone Not/AZone', 'Not/AZone');
    assertQuestionKeptWithNote(reasked, buildAnsweredNote(shortLabel), { ...firstQuestion, labels: [] });
    assert.ok(!readKeptMessage(reasked).text.includes(unansweredNote), 'and the second tap did not write «not answered» over it');
  });

  it('a tap on the re-asked question while its message is still being sent counts, and the answer lands on that message', async () => {
    const shortLabel = fakeAskQuestion.shortOptionLabel;
    const key = keyToString(makeTelegramKey(group.id, topicThreadId));
    const sendHold = createRelease();
    // The Bot API holds the answer to the re-asked question's send: the message exists, the bot does not know its id yet.
    fakeTelegram.holdNextResponse('sendMessage', sendHold.promise, isReAskSend);
    await runStepThenRestore(async () => {
      fakeTelegram.pushOperatorMessage(topicThreadId, 'REASK-FLIGHT-WARM [fake:answer] one turn to compress');
      await getCharness().waitFor('the warm-up turn to reach the agent', agentStartTimeoutMs, () => getAgentPrompts('REASK-FLIGHT-WARM').length > 0);
      const sentMessageId = fakeTelegram.pushOperatorMessage(topicThreadId, 'REASK-FLIGHT [fake:ask] ask me something');
      const reasked = await waitingTopic.waitForMessage('the re-asked question, its send held', (message) =>
        message.message_id > sentMessageId && waitingTopic.getKeyboardData(message).flat().some((data) => data.startsWith('reask_')));
      const labelPromptsBefore = countLabelPrompts(shortLabel);

      assert.equal(await topic.tapAndAwaitAnswer(reasked, 'reask_0'), shortLabel, 'a tap on a message the bot has no id for yet counts');
      await getCharness().waitFor('the label to reach the agent', agentStartTimeoutMs, () => countLabelPrompts(shortLabel) > labelPromptsBefore);
      sendHold.release();
      await waitingTopic.waitForMessageText('the answer under the re-asked question', reasked, (text) => text.endsWith(buildAnsweredNote(shortLabel)));
      await getCharness().waitFor('the saved state to hold no re-asked question', replyTimeoutMs, () => readPersistedState(getLayout()).reAskedQuestions?.[key] === undefined);
    }, async () => {
      sendHold.release();
    });
  });

  it('the old question loses its buttons at once but says «asked again below» only once the re-ask is there', async () => {
    const sendHold = createRelease();
    fakeTelegram.holdNextResponse('sendMessage', sendHold.promise, isReAskSend);
    const callsBeforeStep = fakeTelegram.calls.length;
    await runStepThenRestore(async () => {
      fakeTelegram.pushOperatorMessage(topicThreadId, 'REASK-ORDER-WARM [fake:answer] one turn to compress');
      await getCharness().waitFor('the warm-up turn to reach the agent', agentStartTimeoutMs, () => getAgentPrompts('REASK-ORDER-WARM').length > 0);
      const idleStopsBefore = countIdleStops();
      const sentMessageId = fakeTelegram.pushOperatorMessage(topicThreadId, 'REASK-ORDER [fake:ask] ask me something');
      await waitForQuestionAfter(topic, 'the question', sentMessageId, firstQuestion);
      const reasked = await waitingTopic.waitForMessage('the re-asked question, its send held', (message) =>
        message.message_id > sentMessageId && waitingTopic.getKeyboardData(message).flat().some((data) => data.startsWith('reask_')));

      // The re-ask is on its way and not there yet (the bot has no answer to its send): the question that waited does not claim it is.
      const original = findNewestQuestionCopy();
      assert.ok(original && original.message_id < reasked.message_id, 'the question that waited is still in the topic');
      assert.ok(!original.text.endsWith(askedAgainNote), `not yet «asked again below»: ${original.text.slice(-60)}`);
      // Its buttons are no longer good, though: the pending question is gone, and the compaction can take minutes (a restart in
      // between would leave them dead for good). They came off at the start, BEFORE the compaction was announced.
      assert.equal(original.reply_markup, undefined, 'the buttons are off while the re-ask is on its way');
      const stepCalls = fakeTelegram.calls.slice(callsBeforeStep);
      const keyboardOffIndex = stepCalls.findIndex((call) => call.method === 'editMessageReplyMarkup' && call.payload.message_id === original.message_id);
      const noticeIndex = stepCalls.findIndex((call) => call.method === 'sendMessage' && String(call.payload.text).includes(enDict['compactOnIdle.notice']));
      assert.ok(keyboardOffIndex >= 0 && noticeIndex > keyboardOffIndex, `the buttons came off (call ${keyboardOffIndex}) before the compaction was announced (call ${noticeIndex})`);
      sendHold.release();
      await waitingTopic.waitForMessageText('the old question marked as asked again', original, (text) => text.endsWith(`\n\n${askedAgainNote}`));
      assertQuestionKeptWithNote(original, askedAgainNote);
      assert.ok(reasked.message_id > original.message_id);
      await getCharness().waitFor('the idle stop that follows', agentStartTimeoutMs, () => countIdleStops() > idleStopsBefore);
    }, async () => {
      sendHold.release();
    });
  });

  it('the re-ask could not be sent: the old question is closed as «not answered», not as «asked again below»', async () => {
    fakeTelegram.failNextCall('sendMessage', 'Bad Request: message is too long', isReAskSend);
    fakeTelegram.pushOperatorMessage(topicThreadId, 'REASK-NOSEND-WARM [fake:answer] one turn to compress');
    await getCharness().waitFor('the warm-up turn to reach the agent', agentStartTimeoutMs, () => getAgentPrompts('REASK-NOSEND-WARM').length > 0);
    const sentMessageId = fakeTelegram.pushOperatorMessage(topicThreadId, 'REASK-NOSEND [fake:ask] ask me something');
    await waitForQuestionAfter(topic, 'the question', sentMessageId, firstQuestion);

    // The copy that waited when the idle fire came is the newest one; it ends as «not answered», no re-ask having been sent.
    const original = await waitingTopic.waitForMessage('the newest copy of the question closed as unanswered', (message) =>
      message.message_id > sentMessageId && message === findNewestQuestionCopy() && message.text.endsWith(`\n\n${unansweredNote}`));
    assertQuestionKeptWithNote(original, unansweredNote);
    assert.deepEqual(
      topic.listMessages().filter((message) => message.message_id > original.message_id && waitingTopic.getKeyboardData(message).flat().some((data) => data.startsWith('reask_'))),
      [],
      'no re-asked question reached the topic',
    );
  });

  it('a message of the person\'s during the idle compaction: no re-ask is posted after it, and the old question is closed as «not answered»', async () => {
    const noticeHold = createRelease();
    // The compaction is done and its notice is the next thing to go out; the Bot API holds the answer to that send, and the re-ask
    // is the one after it.
    fakeTelegram.holdNextResponse('sendMessage', noticeHold.promise, (payload) => String(payload.text).includes(enDict['compactOnIdle.notice']));
    await runStepThenRestore(async () => {
      fakeTelegram.pushOperatorMessage(topicThreadId, 'REASK-DURING-WARM [fake:answer] one turn to compress');
      await getCharness().waitFor('the warm-up turn to reach the agent', agentStartTimeoutMs, () => getAgentPrompts('REASK-DURING-WARM').length > 0);
      const sentMessageId = fakeTelegram.pushOperatorMessage(topicThreadId, 'REASK-DURING [fake:ask] ask me something');
      await waitForQuestionAfter(topic, 'the question', sentMessageId, firstQuestion);
      await waitingTopic.waitForMessage('the compaction notice, its send held', (message) => message.message_id > sentMessageId && message.text.includes(enDict['compactOnIdle.notice']));

      fakeTelegram.pushOperatorMessage(topicThreadId, 'DURING-1 [fake:answer] written while the compaction was being announced');
      await getCharness().waitFor('the message to reach the agent', agentStartTimeoutMs, () => getAgentPrompts('DURING-1').length > 0);
      noticeHold.release();

      // The person wrote instead of answering: the question that waited ends as «not answered», and nothing asks it again.
      const original = await waitingTopic.waitForMessage('the newest copy of the question closed as unanswered', (message) =>
        message.message_id > sentMessageId && message === findNewestQuestionCopy() && message.text.endsWith(`\n\n${unansweredNote}`));
      assertQuestionKeptWithNote(original, unansweredNote);
      assert.deepEqual(
        topic.listMessages().filter((message) => message.message_id > original.message_id && waitingTopic.getKeyboardData(message).flat().some((data) => data.startsWith('reask_'))),
        [],
        'no re-asked question follows a message the person wrote instead',
      );
    }, async () => {
      noticeHold.release();
    });
  });

  it('picking another conversation from /sessions closes the re-asked question of the one that sleeps', async () => {
    // Another conversation of this folder, as the CLI left it: the fake's own transcripts are not listed as resumable.
    const otherSessionId = randomUUID();
    const otherFirstPrompt = 'An older conversation about the lexer';
    const workDir = path.join(getLayout().workRoot, projectFolder);
    const transcriptPath = getFakeClaudeTranscriptPath({ homeDir: getLayout().instanceHome, workDir, sessionId: otherSessionId });
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    const entry = (type: 'user' | 'assistant', content: string | object[]): object => ({ type, cwd: workDir, sessionId: otherSessionId, timestamp: new Date().toISOString(), message: { role: type, content } });
    fs.writeFileSync(transcriptPath, [entry('user', otherFirstPrompt), entry('assistant', [{ type: 'text', text: 'Noted.' }])].map((line) => `${JSON.stringify(line)}\n`).join(''));

    const reasked = await putReAskedQuestionAndSleep('REASK-PICK');
    const list = await topic.sendAndAwaitReply('/sessions', 'Sessions to resume');
    const pickedIndex = topic.getKeyboardLabels(list).flat().findIndex((label) => label.startsWith(otherFirstPrompt));
    assert.notEqual(pickedIndex, -1, `precondition: the other conversation is listed: ${topic.getKeyboardLabels(list).flat().join(' | ')}`);
    await topic.tapAndAwaitAnswer(list, topic.getKeyboardData(list).flat()[pickedIndex]);
    await assertReAskedQuestionClosed(reasked);
  });

  it('switching the topic to another backend closes the re-asked question of the conversation left behind', async () => {
    const reasked = await putReAskedQuestionAndSleep('REASK-SWITCH');
    await runStepThenRestore(async () => {
      await topic.sendAndAwaitReply('/terminal', 'Terminal ready');
      await assertReAskedQuestionClosed(reasked);
    }, async () => {
      // Back to the agent the next steps use: in a terminal every message is shell input, so the shell is closed first.
      await topic.sendAndAwaitReply('/quit', 'stopped');
      await startAgentSession();
    });
  });

  /**
   * The bot stops in the middle of an idle compaction: the compaction is done and its notice is the next thing to go out, the
   * Bot API holds the answer to that send, so the bot is still "in" the compaction — the question cleared, its buttons off,
   * the re-ask not yet posted — when it stops. `prepareBootState` runs while the bot is down; the bot is started again after it.
   * Resolves the message the question waited in.
   */
  async function stopBotDuringIdleCompaction(promptLabel: string, noticeHold: { release: () => void; promise: Promise<void> }, prepareBootState: () => void): Promise<FakeTelegramMessage> {
    fakeTelegram.holdNextResponse('sendMessage', noticeHold.promise, (payload) => String(payload.text).includes(enDict['compactOnIdle.notice']));
    fakeTelegram.pushOperatorMessage(topicThreadId, `${promptLabel}-WARM [fake:answer] one turn to compress`);
    await getCharness().waitFor('the warm-up turn to reach the agent', agentStartTimeoutMs, () => getAgentPrompts(`${promptLabel}-WARM`).length > 0);
    const sentMessageId = fakeTelegram.pushOperatorMessage(topicThreadId, `${promptLabel} [fake:ask] ask me something`);
    await waitForQuestionAfter(topic, 'the question', sentMessageId, firstQuestion);
    await waitingTopic.waitForMessage('the compaction notice, its send held', (message) => message.message_id > sentMessageId && message.text.includes(enDict['compactOnIdle.notice']));
    const original = findNewestQuestionCopy();
    assert.ok(original, 'the question that waited');
    assert.equal(original.reply_markup, undefined, 'precondition: its buttons are already off');
    assert.ok(!original.text.endsWith(`\n\n${unansweredNote}`) && !original.text.endsWith(askedAgainNote), 'precondition: and it has no result yet');

    await getCharness().stop();
    prepareBootState();
    noticeHold.release();
    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    return original;
  }

  it('a restart of the bot during the idle compaction, the conversation still resumable: the question is asked again at boot and the old message says so', async () => {
    const shortLabel = fakeAskQuestion.shortOptionLabel;
    const key = keyToString(makeTelegramKey(group.id, topicThreadId));
    const noticeHold = createRelease();
    await runStepThenRestore(async () => {
      const original = await stopBotDuringIdleCompaction('REASK-RESTART', noticeHold, () => {});

      // Nobody had the chance to answer: the question is put again, with buttons, and the old message points at it.
      const reasked = await waitingTopic.waitForMessage('the question asked again at boot', (message) =>
        message.message_id > original.message_id && waitingTopic.getKeyboardData(message).flat().some((data) => data.startsWith('reask_')));
      await waitingTopic.waitForMessageText('the old question marked as asked again', original, (text) => text.endsWith(`\n\n${askedAgainNote}`));
      assertQuestionKeptWithNote(original, askedAgainNote);
      await getCharness().waitFor('the saved record to name the new copy', replyTimeoutMs, () => readPersistedState(getLayout()).reAskedQuestions?.[key]?.messageId === reasked.message_id);
      assert.equal(readPersistedState(getLayout()).reAskedQuestions?.[key]?.isPosted, undefined, 'and to be a posted one');

      // The copy works like any re-asked question: a tap delivers the label and writes the answer under it.
      const labelPromptsBefore = countLabelPrompts(shortLabel);
      assert.equal(await topic.tapAndAwaitAnswer(reasked, 'reask_0'), shortLabel);
      await getCharness().waitFor('the label to reach the agent', agentStartTimeoutMs, () => countLabelPrompts(shortLabel) > labelPromptsBefore);
      await waitingTopic.waitForMessageText('the answer under the question asked again', reasked, (text) => text.endsWith(buildAnsweredNote(shortLabel)));
      assertQuestionKeptWithNote(original, askedAgainNote);
    }, async () => {
      noticeHold.release();
    });
  });

  it('a restart of the bot during the idle compaction, the conversation gone while the bot was down: the old question ends as «not answered» and nothing is asked again', async () => {
    const key = keyToString(makeTelegramKey(group.id, topicThreadId));
    const noticeHold = createRelease();
    await runStepThenRestore(async () => {
      const original = await stopBotDuringIdleCompaction('REASK-RESTART-GONE', noticeHold, () => {
        // What `/quit` does while the bot is down: the agent's process is gone and its conversation is released.
        spawnSync('tmux', ['kill-session', '-t', `=${buildJsonStreamTmuxSessionName(makeTelegramKey(group.id, topicThreadId))}`], { env: getTmuxEnv(getLayout().tmuxTmpDir) });
        const persisted = readPersistedState(getLayout());
        const agent = persisted.agents?.[key];
        if (agent) delete agent.claudeSessionId;
        fs.writeFileSync(getStatePath(getLayout()), JSON.stringify(persisted));
      });

      await waitingTopic.waitForMessageText('the note under the old question', original, (text) => text.endsWith(`\n\n${unansweredNote}`));
      assertQuestionKeptWithNote(original, unansweredNote);
      await getCharness().waitFor('nothing to be left in the saved state', replyTimeoutMs, () => readPersistedState(getLayout()).reAskedQuestions?.[key] === undefined);
      assert.deepEqual(
        topic.listMessages().filter((message) => message.message_id > original.message_id && waitingTopic.getKeyboardData(message).flat().some((data) => data.startsWith('reask_'))),
        [],
        'and nothing was asked again',
      );
    }, async () => {
      noticeHold.release();
      await startAgentSession();
    });
  });

  it('a button of an older re-asked copy is not taken for the question whose re-ask is still being sent', async () => {
    const shortLabel = fakeAskQuestion.shortOptionLabel;
    const older = await putReAskedQuestionAndSleep('REASK-BOUND-OLD');
    // Telegram refuses to touch the older message when it is closed (its text and its buttons alike): it keeps live buttons.
    const isOlder = (payload: Record<string, unknown>): boolean => payload.message_id === older.message_id;
    fakeTelegram.failNextCall('editMessageText', "Bad Request: message can't be edited", isOlder);
    fakeTelegram.failNextCall('editMessageReplyMarkup', "Bad Request: message can't be edited", isOlder);
    const sendHold = createRelease();
    fakeTelegram.holdNextResponse('sendMessage', sendHold.promise, isReAskSend);
    await runStepThenRestore(async () => {
      fakeTelegram.pushOperatorMessage(topicThreadId, 'REASK-BOUND-NEW-WARM [fake:answer] one turn to compress');
      await getCharness().waitFor('the warm-up turn to reach the agent', agentStartTimeoutMs, () => getAgentPrompts('REASK-BOUND-NEW-WARM').length > 0);
      const sentMessageId = fakeTelegram.pushOperatorMessage(topicThreadId, 'REASK-BOUND-NEW [fake:ask] ask me something');
      const newer = await waitingTopic.waitForMessage('the newer re-asked question, its send held', (message) =>
        message.message_id > sentMessageId && waitingTopic.getKeyboardData(message).flat().some((data) => data.startsWith('reask_')));
      assert.notEqual(readKeptMessage(older).reply_markup, undefined, 'precondition: the older message still has live buttons');
      const labelPromptsBefore = countLabelPrompts(shortLabel);

      // The bot has no id for the newer message yet: a tap on the OLDER message must not be taken for it.
      assert.equal(await topic.tapAndAwaitAnswer(older, 'reask_0'), enDict['cb.no_pending_question'], 'the old button answers nothing');
      assert.equal(countLabelPrompts(shortLabel), labelPromptsBefore, 'and sends nothing to the agent');

      // The newer one is untouched, and a tap on IT still counts.
      assert.equal(await topic.tapAndAwaitAnswer(newer, 'reask_0'), shortLabel);
      await getCharness().waitFor('the label to reach the agent', agentStartTimeoutMs, () => countLabelPrompts(shortLabel) > labelPromptsBefore);
      // The old buttons come off by a send of their own, which waits behind the held one: let that go.
      sendHold.release();
      await getCharness().waitFor('the old buttons to be taken off', replyTimeoutMs, () => readKeptMessage(older).reply_markup === undefined);
      await waitingTopic.waitForMessageText('the answer under the newer question', newer, (text) => text.endsWith(buildAnsweredNote(shortLabel)));
    }, async () => {
      sendHold.release();
    });
  });

  it('an option number typed during the idle compaction answers the question: the label goes to the agent, the old message shows the answer, nothing is asked again', async () => {
    const longLabel = fakeAskQuestion.longOptionLabel;
    const noticeHold = createRelease();
    fakeTelegram.holdNextResponse('sendMessage', noticeHold.promise, (payload) => String(payload.text).includes(enDict['compactOnIdle.notice']));
    await runStepThenRestore(async () => {
      fakeTelegram.pushOperatorMessage(topicThreadId, 'REASK-NUMBER-WARM [fake:answer] one turn to compress');
      await getCharness().waitFor('the warm-up turn to reach the agent', agentStartTimeoutMs, () => getAgentPrompts('REASK-NUMBER-WARM').length > 0);
      const sentMessageId = fakeTelegram.pushOperatorMessage(topicThreadId, 'REASK-NUMBER [fake:ask] ask me something');
      await waitForQuestionAfter(topic, 'the question', sentMessageId, firstQuestion);
      await waitingTopic.waitForMessage('the compaction notice, its send held', (message) => message.message_id > sentMessageId && message.text.includes(enDict['compactOnIdle.notice']));
      const original = findNewestQuestionCopy();
      assert.ok(original, 'the question that waited');
      const labelPromptsBefore = countLabelPrompts(longLabel);

      // The buttons are off but the numbered options are still on screen: «2» is the long one.
      fakeTelegram.pushOperatorMessage(topicThreadId, '2');
      await getCharness().waitFor('the label to reach the agent', agentStartTimeoutMs, () => countLabelPrompts(longLabel) > labelPromptsBefore);
      noticeHold.release();

      await waitingTopic.waitForMessageText('the answer under the question', original, (text) => text.endsWith(buildAnsweredNote(longLabel)));
      assertQuestionKeptWithNote(original, buildAnsweredNote(longLabel));
      assert.deepEqual(
        topic.listMessages().filter((message) => message.message_id > original.message_id && waitingTopic.getKeyboardData(message).flat().some((data) => data.startsWith('reask_'))),
        [],
        'the question is answered, so it is not asked again',
      );
    }, async () => {
      noticeHold.release();
    });
  });

  it('an option number typed under the re-asked copy answers it, like a tap', async () => {
    const shortLabel = fakeAskQuestion.shortOptionLabel;
    const reasked = await putReAskedQuestionAndSleep('REASK-DIGIT');
    const labelPromptsBefore = countLabelPrompts(shortLabel);

    fakeTelegram.pushOperatorMessage(topicThreadId, '1');
    await getCharness().waitFor('the label to reach the resumed agent', agentStartTimeoutMs, () => countLabelPrompts(shortLabel) > labelPromptsBefore);
    await waitingTopic.waitForMessageText('the answer under the re-asked question', reasked, (text) => text.endsWith(buildAnsweredNote(shortLabel)));
    assertQuestionKeptWithNote(reasked, buildAnsweredNote(shortLabel));
  });

  it('an option number typed while the re-ask is being sent: the label reaches the agent, then the old message and the copy that lands both show the answer', async () => {
    const shortLabel = fakeAskQuestion.shortOptionLabel;
    const sendHold = createRelease();
    // The Bot API holds the answer to the re-asked question's send: the message exists, the bot does not know its id yet.
    fakeTelegram.holdNextResponse('sendMessage', sendHold.promise, isReAskSend);
    await runStepThenRestore(async () => {
      fakeTelegram.pushOperatorMessage(topicThreadId, 'REASK-NUMBER-FLIGHT-WARM [fake:answer] one turn to compress');
      await getCharness().waitFor('the warm-up turn to reach the agent', agentStartTimeoutMs, () => getAgentPrompts('REASK-NUMBER-FLIGHT-WARM').length > 0);
      const sentMessageId = fakeTelegram.pushOperatorMessage(topicThreadId, 'REASK-NUMBER-FLIGHT [fake:ask] ask me something');
      const reasked = await waitingTopic.waitForMessage('the re-asked question, its send held', (message) =>
        message.message_id > sentMessageId && waitingTopic.getKeyboardData(message).flat().some((data) => data.startsWith('reask_')));
      const original = findNewestQuestionCopy();
      assert.ok(original, 'the question that waited');
      const labelPromptsBefore = countLabelPrompts(shortLabel);

      fakeTelegram.pushOperatorMessage(topicThreadId, '1');
      await getCharness().waitFor('the label to reach the agent', agentStartTimeoutMs, () => countLabelPrompts(shortLabel) > labelPromptsBefore);
      sendHold.release();

      // Once the label is delivered, the copy that lands ends the same way as the message the question waited in.
      await waitingTopic.waitForMessageText('the answer under the re-asked question', reasked, (text) => text.endsWith(buildAnsweredNote(shortLabel)));
      await waitingTopic.waitForMessageText('the answer under the old message', original, (text) => text.endsWith(buildAnsweredNote(shortLabel)));
      assertQuestionKeptWithNote(original, buildAnsweredNote(shortLabel));
    }, async () => {
      sendHold.release();
    });
  });

  it('an option number typed under the re-asked copy when the conversation cannot be started: no answer is shown, the buttons stay and answer once the agent can start', async () => {
    const shortLabel = fakeAskQuestion.shortOptionLabel;
    const refuseLaunchPath = path.join(getLayout().fakeStateDir, fakeClaudeRefuseLaunchFileName);
    const reasked = await putReAskedQuestionAndSleep('REASK-DIGIT-REFUSED');
    const labelPromptsBefore = countLabelPrompts(shortLabel);
    await runStepThenRestore(async () => {
      fs.writeFileSync(refuseLaunchPath, '');
      fakeTelegram.pushOperatorMessage(topicThreadId, '1');
      await new TopicDriver(fakeTelegram, getCharness, topicThreadId, failedStartTimeoutMs).waitForMessage('the line that says why the start failed', (message) => message.message_id > reasked.message_id && /refused to start/.test(message.text));

      // The label reached no agent, so nothing says it was answered: the copy is as it was, buttons and all.
      assert.equal(countLabelPrompts(shortLabel), labelPromptsBefore, 'the label reached no agent');
      const waiting = readKeptMessage(reasked);
      assert.ok(!waiting.text.includes(buildAnsweredNote(shortLabel)), `no answer shown for a label nobody got: ${waiting.text.slice(-80)}`);
      assert.deepEqual(waitingTopic.getKeyboardData(waiting), [['reask_0'], ['reask_1']], 'the buttons stay');

      fs.rmSync(refuseLaunchPath, { force: true });
      assert.equal(await topic.tapAndAwaitAnswer(reasked, 'reask_0'), shortLabel, 'the button still knows its label');
      await getCharness().waitFor('the label to reach the started agent', agentStartTimeoutMs, () => countLabelPrompts(shortLabel) > labelPromptsBefore);
      await waitingTopic.waitForMessageText('the answer under the question once the label was delivered', reasked, (text) => text.endsWith(buildAnsweredNote(shortLabel)));
    }, async () => {
      fs.rmSync(refuseLaunchPath, { force: true });
    });
  });
});
