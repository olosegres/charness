/**
 * @description A pending question that the idle compaction re-asks, at PROCESS level: the BUILT charness started the
 * way an isolated instance is (`scripts/run-isolated.sh`) against the fake Bot API of `telegramE2e/fakeTelegram.ts`,
 * with the fake `claude` (`jiraE2e/fakeClaude.ts`, mode `ask`) putting a real `AskUserQuestion` to the topic and the idle
 * window cut to seconds (`AGENT_IDLE_MINUTES`). One flow, in order:
 *
 *   boot → the topic is bound → `/claude` → one answered turn (so the idle fire has something to compress)
 *   → a question is put and left unanswered; the idle fire rejects it, compacts, stops the process and re-asks the
 *     question with `reask_<i>` buttons
 *   → a tap on the SHORT option: the toast is the label whole, the label reaches the resumed agent as a prompt, and
 *     nothing is posted beside the toast
 *   → the same with the LONG option (longer than a toast holds): the toast is its start, the label is posted in full
 *     as ONE message, and the whole label reaches the agent
 *   → a tap the moment the re-asked question appears, which may land while the process is still being stopped: the
 *     label is held and still reaches the agent
 *   → a tap read while the process is live, whose delivery the idle stop overtakes (the fake Bot API holds the
 *     re-asked question's and the toast's responses to put the stop between the two): the stop still under way when the
 *     label is delivered — it is held and reaches the resumed process; the stop already over — the conversation is
 *     woken and gets it. Both used to be lost: written to the process being stopped, or dropped for a gone one
 *
 * Nothing leaves the machine: the Bot API is on loopback and the agent is a fake. Everything the test starts is stopped
 * in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram, type FakeTelegramMessage } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import { fakeAskQuestion, fakeClaudeIgnoreStopSignalsFileName, fakeClaudeLogFileNames, type FakeClaudePrompt } from './jiraE2e/fakeClaudeContract';
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

const group = { id: -1001111111111, title: 'ExampleGroup' };
const topicThreadId = 111;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const projectFolder = 'proj';
const launchLine = 'Launching Telegraf bot (long polling';

/** The idle window of the instance, in minutes (12 s): the fire that compacts and re-asks comes this long after the last activity. */
const idleWindowMinutes = '0.2';
const bootTimeoutMs = 60 * 1000;
const replyTimeoutMs = 20 * 1000;
const agentStartTimeoutMs = 60 * 1000;
/** The re-asked question follows the idle window by a compaction turn and a stop. */
const reaskTimeoutMs = 90 * 1000;

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

/** The user messages the fake agent read that carried `label`, with their whole text. */
function getAgentPrompts(label: string): FakeClaudePrompt[] {
  return readJsonLines<FakeClaudePrompt>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.prompts)).filter((prompt) => prompt.text.includes(label));
}

/**
 * How long the fake Bot API holds its answer to the re-asked question: the idle stop follows that send, so it starts this
 * long after the question is in the topic — after the test's tap has been read.
 */
const reaskedQuestionHoldMs = 3_000;
/** How long the tap's toast is held when the stop is still under way at the delivery: past the stop's start, inside its kill wait (5 s). */
const toastHoldDuringStopMs = 4_500;
/** How long the tap's toast is held when the stop is over at the delivery: past the stop's start and its end. */
const toastHoldAfterStopMs = 7_000;

/** The line the bot logs once the idle fire has stopped the agent's process (the conversation then sleeps). */
const idleStopLine = 'process stopped; the session sleeps';
/** The text the fake agent streams for a prompt naming no label (`Working on <label>.`): a re-asked question's answer is one. */
const unlabelledTurnText = 'Working on unknown.';

function countIdleStops(): number {
  return getCharness().output.split(idleStopLine).length - 1;
}

/**
 * Put the question (`ask` mode) and leave it unanswered until the idle fire rejects it, compacts and re-asks it: resolves
 * the re-asked message, whose buttons are `reask_<i>`, by default once the fire has also stopped the process, so the tap
 * wakes a sleeping conversation. The question is posted just BEFORE the stop: `isIdleStopAwaited: false` resolves at once,
 * for a tap that may land before, inside or after the stop.
 */
async function waitForReaskedQuestion(promptLabel: string, options: { isIdleStopAwaited: boolean } = { isIdleStopAwaited: true }): Promise<FakeTelegramMessage> {
  const idleStopsBefore = countIdleStops();
  const sentMessageId = fakeTelegram.pushOperatorMessage(topicThreadId, `${promptLabel} [fake:ask] ask me something`);
  await topic.waitForMessage(`the question of ${promptLabel}`, (message) => message.message_id > sentMessageId && message.text.includes(fakeAskQuestion.question) && message.reply_markup !== undefined);
  const reasked = await waitingTopic.waitForMessage(`the re-asked question of ${promptLabel}`, (message) =>
    message.message_id > sentMessageId && message.reply_markup !== undefined && waitingTopic.getKeyboardData(message).flat().some((data) => data.startsWith('reask_')),
  );
  assert.match(reasked.text, /You still have a pending question/);
  assert.match(reasked.text, new RegExp(fakeAskQuestion.question.replace('?', '\\?')));
  assert.deepEqual(topic.getKeyboardData(reasked), [['reask_0'], ['reask_1']], 'one button per option');
  if (!options.isIdleStopAwaited) return reasked;
  await getCharness().waitFor(`the idle stop that follows the re-ask of ${promptLabel}`, agentStartTimeoutMs, () => countIdleStops() > idleStopsBefore);
  return reasked;
}

describe('A pending question the idle compaction re-asks, end to end: built charness, fake Bot API', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-reask-', [projectFolder], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    topic = new TopicDriver(fakeTelegram, getCharness, topicThreadId, replyTimeoutMs);
    waitingTopic = new TopicDriver(fakeTelegram, getCharness, topicThreadId, reaskTimeoutMs);
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
      OPENCODE_URL: `http://127.0.0.1:${await getFreePort()}`,
      SCHEDULER_MCP_PORT: (await getFreeFixedPort()).toString(),
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

  it('boots Telegram-only against the fake Bot API, binds the topic, starts the fake agent and gives it one answered turn', async () => {
    charness = new IsolatedCharness(getLayout());
    const pollsBefore = fakeTelegram.listCalls('getUpdates').length;
    await charness.start(bootTimeoutMs, (runOutput) => runOutput.includes(launchLine) && fakeTelegram.listCalls('getUpdates').length > pollsBefore);
    await topic.sendAndAwaitReply(`/bind ${projectFolder}`, `Bound to \`${projectFolder}\``);
    await topic.sendAndAwaitReply('/claude', 'ready in');
    fakeTelegram.pushOperatorMessage(topicThreadId, 'WARM-1 [fake:answer] hello');
    await getCharness().waitFor('the warm-up turn to reach the agent', agentStartTimeoutMs, () => getAgentPrompts('WARM-1').length > 0);
  });

  it('a re-asked question\'s SHORT option: the toast is the label whole, nothing is posted beside it, and the label reaches the resumed agent', async () => {
    const reasked = await waitForReaskedQuestion('REASK-1');
    const toast = await topic.tapAndAwaitAnswer(reasked, 'reask_0');
    assert.equal(toast, fakeAskQuestion.shortOptionLabel, 'a label that fits is the toast, whole');
    await getCharness().waitFor('the short label to reach the agent as a prompt', agentStartTimeoutMs, () => getAgentPrompts(fakeAskQuestion.shortOptionLabel).length > 0);
    assert.equal(
      topic.listMessages().filter((message) => message.text === fakeAskQuestion.shortOptionLabel).length,
      0,
      'a toast that fits needs no message',
    );
  });

  it('a re-asked question\'s LONG option: the toast is its start, the label is posted in full as ONE message, and the agent gets the whole label', async () => {
    assert.ok(fakeAskQuestion.longOptionLabel.length > 200, 'precondition: the long label is longer than a toast holds');
    fakeTelegram.pushOperatorMessage(topicThreadId, 'WARM-2 [fake:answer] one more turn to compress');
    await getCharness().waitFor('the second warm-up turn to reach the agent', agentStartTimeoutMs, () => getAgentPrompts('WARM-2').length > 0);

    const reasked = await waitForReaskedQuestion('REASK-2');
    const toast = await topic.tapAndAwaitAnswer(reasked, 'reask_1');
    assert.ok(toast.length <= 200 && toast.endsWith('…'), `the toast fits: ${toast.length} characters`);
    assert.ok(fakeAskQuestion.longOptionLabel.startsWith(toast.slice(0, -1)), 'it is the start of the label');
    const posted = await topic.waitForMessage('the label posted in full', (message) => message.text === fakeAskQuestion.longOptionLabel);
    assert.ok(posted.message_id > reasked.message_id);
    await getCharness().waitFor('the whole long label to reach the agent as a prompt', agentStartTimeoutMs, () => getAgentPrompts(fakeAskQuestion.longOptionLabel).length > 0);
    assert.equal(
      topic.listMessages().filter((message) => message.text === fakeAskQuestion.longOptionLabel).length,
      1,
      'the record of the answer is one message',
    );
  });

  it('a tap the moment the re-asked question appears — before, inside or after the stop that follows it — still reaches the agent', async () => {
    fakeTelegram.pushOperatorMessage(topicThreadId, 'WARM-3 [fake:answer] a third turn to compress');
    await getCharness().waitFor('the third warm-up turn to reach the agent', agentStartTimeoutMs, () => getAgentPrompts('WARM-3').length > 0);
    const promptsBefore = getAgentPrompts(fakeAskQuestion.shortOptionLabel).length;

    const reasked = await waitForReaskedQuestion('REASK-3', { isIdleStopAwaited: false });
    const toast = await topic.tapAndAwaitAnswer(reasked, 'reask_0');
    assert.equal(toast, fakeAskQuestion.shortOptionLabel);
    await getCharness().waitFor('the label to reach the agent as a prompt', agentStartTimeoutMs, () => getAgentPrompts(fakeAskQuestion.shortOptionLabel).length > promptsBefore);
    // A process being stopped may still read the prompt; only a live one ANSWERS it.
    await waitingTopic.waitForMessage('the agent to answer the label', (message) => message.message_id > reasked.message_id && message.text.includes(unlabelledTurnText));
  });

  /**
   * A tap read while the process is live, delivered only after the idle stop began: the re-asked question's send is held
   * (the stop starts {@link reaskedQuestionHoldMs} after the question is in the topic) and so is the tap's toast (the
   * label is delivered `toastHoldMs` after the tap). The label must reach a process started AFTER the one that put the
   * question — the one being stopped may still read it, only the resumed one answers.
   */
  async function tapBeforeTheIdleStopOvertakesIt(warmUpLabel: string, promptLabel: string, toastHoldMs: number): Promise<void> {
    fakeTelegram.pushOperatorMessage(topicThreadId, `${warmUpLabel} [fake:answer] one more turn to compress`);
    await getCharness().waitFor(`the warm-up turn ${warmUpLabel} to reach the agent`, agentStartTimeoutMs, () => getAgentPrompts(warmUpLabel).length > 0);
    const labelPromptsBefore = getAgentPrompts(fakeAskQuestion.shortOptionLabel).length;
    const idleStopsBefore = countIdleStops();
    fakeTelegram.holdNextResponse('sendMessage', reaskedQuestionHoldMs, (payload) => JSON.stringify(payload.reply_markup ?? null).includes('reask_'));
    fakeTelegram.holdNextResponse('answerCallbackQuery', toastHoldMs);

    const reasked = await waitForReaskedQuestion(promptLabel, { isIdleStopAwaited: false });
    const askingPid = getAgentPrompts(promptLabel)[0]?.pid;
    assert.ok(askingPid !== undefined, 'the process that put the question');
    const toast = await topic.tapAndAwaitAnswer(reasked, 'reask_0');
    assert.equal(toast, fakeAskQuestion.shortOptionLabel);
    assert.equal(countIdleStops(), idleStopsBefore, 'precondition: the tap was read before the stop');

    await getCharness().waitFor('the idle stop', agentStartTimeoutMs, () => countIdleStops() > idleStopsBefore);
    await getCharness().waitFor('the label to reach a resumed process', agentStartTimeoutMs, () =>
      getAgentPrompts(fakeAskQuestion.shortOptionLabel).slice(labelPromptsBefore).some((prompt) => prompt.pid !== askingPid));
    await waitingTopic.waitForMessage('the agent to answer the label', (message) => message.message_id > reasked.message_id && message.text.includes(unlabelledTurnText));
  }

  it('a tap read while the process is live, delivered while the idle stop is still under way: held, and the resumed process gets it', async () => {
    // The process ignores the stop signals, so the stop lasts its kill wait: the label is delivered inside the stop window.
    const ignoreStopSignalsPath = path.join(getLayout().fakeStateDir, fakeClaudeIgnoreStopSignalsFileName);
    fs.writeFileSync(ignoreStopSignalsPath, '');
    try {
      await tapBeforeTheIdleStopOvertakesIt('WARM-4', 'REASK-4', toastHoldDuringStopMs);
    } finally {
      fs.rmSync(ignoreStopSignalsPath, { force: true });
    }
    assert.ok(getCharness().output.includes('was still running'), 'the stop really lasted its kill wait');
  });

  it('a tap read while the process is live, delivered after the idle stop is over: the conversation is woken and gets it', async () => {
    await tapBeforeTheIdleStopOvertakesIt('WARM-5', 'REASK-5', toastHoldAfterStopMs);
  });
});
