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
 *     woken and gets it. Both used to be lost: written to the process being stopped, or dropped for a gone one. Each
 *     hold is let go at a state the test observed (the tap read, the stop begun or ended), never after a fixed time
 *   → the same, with the conversation unable to start again: one line says why, no "No agent running" beside it, no
 *     typing loader, the label reaches no agent — and the question's button still delivers it once the agent can start
 *
 * Nothing leaves the machine: the Bot API is on loopback and the agent is a fake. Everything the test starts is stopped
 * in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram, type FakeTelegramCall, type FakeTelegramMessage } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import { fakeAskQuestion, fakeClaudeIgnoreStopSignalsFileName, fakeClaudeLogFileNames, fakeClaudeRefuseLaunchFileName, type FakeClaudePrompt } from './jiraE2e/fakeClaudeContract';
import { enDict } from '../i18n/en';
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

/** The line the bot logs as the idle fire begins to stop the agent's process (its startup window is open from here). */
const idleStopStartLine = 'stopping the idle process';
/** The line the bot logs once the idle fire has stopped the agent's process (the conversation then sleeps). */
const idleStopLine = 'process stopped; the session sleeps';
/** A wake whose resume and the fresh start after it both fail: two launches, each refused at once. */
const failedStartTimeoutMs = agentStartTimeoutMs;
/** A command whose reply is fixed and changes nothing: a barrier — sends are paced first come, first served. */
const barrierCommand = '/timezone Not/AZone';
/** The text the fake agent streams for a prompt naming no label (`Working on <label>.`): a re-asked question's answer is one. */
const unlabelledTurnText = 'Working on unknown.';

function countIdleStops(): number {
  return getCharness().output.split(idleStopLine).length - 1;
}

function countIdleStopStarts(): number {
  return getCharness().output.split(idleStopStartLine).length - 1;
}

/** A promise the test settles itself: the moment a held Bot API response is let go. */
function createRelease(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
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
   * A tap read while the process is live, delivered only after the idle stop began. The fake Bot API holds two
   * responses, each let go at a state the test observed: the re-asked question's send (the idle stop follows it) until
   * the tap was read — so the tap sees a live process and no stop under way — and the tap's toast (its label is
   * delivered after it) until the stop has started (`whileTheStopRuns`) or ended (`afterTheStop`). `beforeTheToast` runs
   * just before the toast is let go.
   */
  async function holdATapUntilTheIdleStop(
    warmUpLabel: string,
    promptLabel: string,
    toastRelease: 'whileTheStopRuns' | 'afterTheStop',
    beforeTheToast: () => void = () => {},
  ): Promise<{ reasked: FakeTelegramMessage; askingPid: number; labelPromptsBefore: number; callsAtToast: number }> {
    fakeTelegram.pushOperatorMessage(topicThreadId, `${warmUpLabel} [fake:answer] one more turn to compress`);
    await getCharness().waitFor(`the warm-up turn ${warmUpLabel} to reach the agent`, agentStartTimeoutMs, () => getAgentPrompts(warmUpLabel).length > 0);
    const labelPromptsBefore = getAgentPrompts(fakeAskQuestion.shortOptionLabel).length;
    const stopStartsBefore = countIdleStopStarts();
    const idleStopsBefore = countIdleStops();
    const questionHold = createRelease();
    const toastHold = createRelease();
    fakeTelegram.holdNextResponse('sendMessage', questionHold.promise, (payload) => JSON.stringify(payload.reply_markup ?? null).includes('reask_'));
    fakeTelegram.holdNextResponse('answerCallbackQuery', toastHold.promise);
    try {
      const reasked = await waitForReaskedQuestion(promptLabel, { isIdleStopAwaited: false });
      const askingPid = getAgentPrompts(promptLabel)[0]?.pid;
      assert.ok(askingPid !== undefined, 'the process that put the question');
      // The toast reaches the Bot API once the handler has read the session: the tap was read.
      const toast = await topic.tapAndAwaitAnswer(reasked, 'reask_0');
      assert.equal(toast, fakeAskQuestion.shortOptionLabel);
      assert.equal(countIdleStopStarts(), stopStartsBefore, 'precondition: the tap was read before the stop began');

      questionHold.release();
      if (toastRelease === 'whileTheStopRuns') {
        await getCharness().waitFor('the idle stop to begin', agentStartTimeoutMs, () => countIdleStopStarts() > stopStartsBefore);
      } else {
        await getCharness().waitFor('the idle stop to end', agentStartTimeoutMs, () => countIdleStops() > idleStopsBefore);
      }
      beforeTheToast();
      const callsAtToast = fakeTelegram.calls.length;
      return { reasked, askingPid, labelPromptsBefore, callsAtToast };
    } finally {
      questionHold.release();
      toastHold.release();
    }
  }

  /** The label must reach a process started AFTER the one that put the question: the one being stopped may still read it. */
  async function assertTheLabelReachedAResumedProcess(tap: { reasked: FakeTelegramMessage; askingPid: number; labelPromptsBefore: number }): Promise<void> {
    await getCharness().waitFor('the label to reach a resumed process', agentStartTimeoutMs, () =>
      getAgentPrompts(fakeAskQuestion.shortOptionLabel).slice(tap.labelPromptsBefore).some((prompt) => prompt.pid !== tap.askingPid));
    await waitingTopic.waitForMessage('the agent to answer the label', (message) => message.message_id > tap.reasked.message_id && message.text.includes(unlabelledTurnText));
  }

  it('a tap read while the process is live, delivered while the idle stop is still under way: held, and the resumed process gets it', async () => {
    // The process ignores the stop signals, so the stop lasts its kill wait: the label is delivered inside the stop window.
    const ignoreStopSignalsPath = path.join(getLayout().fakeStateDir, fakeClaudeIgnoreStopSignalsFileName);
    fs.writeFileSync(ignoreStopSignalsPath, '');
    try {
      const tap = await holdATapUntilTheIdleStop('WARM-4', 'REASK-4', 'whileTheStopRuns');
      await assertTheLabelReachedAResumedProcess(tap);
    } finally {
      fs.rmSync(ignoreStopSignalsPath, { force: true });
    }
    assert.ok(getCharness().output.includes('was still running'), 'the stop really lasted its kill wait');
  });

  it('a tap read INSIDE the idle stop, delivered after it is over: the label wakes the conversation instead of waiting in a closed window', async () => {
    // The process ignores the stop signals, so the stop lasts its kill wait: the tap is read while its window is open.
    const ignoreStopSignalsPath = path.join(getLayout().fakeStateDir, fakeClaudeIgnoreStopSignalsFileName);
    fs.writeFileSync(ignoreStopSignalsPath, '');
    const toastHold = createRelease();
    try {
      fakeTelegram.pushOperatorMessage(topicThreadId, 'WARM-7 [fake:answer] one more turn to compress');
      await getCharness().waitFor('the warm-up turn WARM-7 to reach the agent', agentStartTimeoutMs, () => getAgentPrompts('WARM-7').length > 0);
      const labelPromptsBefore = getAgentPrompts(fakeAskQuestion.shortOptionLabel).length;
      const stopStartsBefore = countIdleStopStarts();
      const idleStopsBefore = countIdleStops();
      const reasked = await waitForReaskedQuestion('REASK-7', { isIdleStopAwaited: false });
      const askingPid = getAgentPrompts('REASK-7')[0]?.pid;
      assert.ok(askingPid !== undefined, 'the process that put the question');
      await getCharness().waitFor('the idle stop to begin', agentStartTimeoutMs, () => countIdleStopStarts() > stopStartsBefore);

      // The toast reaches the Bot API once the handler has read the session — inside the stop's window — and is held
      // there until the stop is over: the label is delivered after the window has closed.
      fakeTelegram.holdNextResponse('answerCallbackQuery', toastHold.promise);
      assert.equal(await topic.tapAndAwaitAnswer(reasked, 'reask_0'), fakeAskQuestion.shortOptionLabel);
      assert.equal(countIdleStops(), idleStopsBefore, 'precondition: the tap was read before the stop was over');
      await getCharness().waitFor('the idle stop to end', agentStartTimeoutMs, () => countIdleStops() > idleStopsBefore);
      toastHold.release();

      await assertTheLabelReachedAResumedProcess({ reasked, askingPid, labelPromptsBefore });
    } finally {
      toastHold.release();
      fs.rmSync(ignoreStopSignalsPath, { force: true });
    }
  });

  it('a tap read while the process is live, delivered after the idle stop is over: the conversation is woken and gets it', async () => {
    const tap = await holdATapUntilTheIdleStop('WARM-5', 'REASK-5', 'afterTheStop');
    await assertTheLabelReachedAResumedProcess(tap);
  });

  it('the same, but the conversation cannot be started again: one line says why, nothing pretends to work, the buttons stay', async () => {
    const refuseLaunchPath = path.join(getLayout().fakeStateDir, fakeClaudeRefuseLaunchFileName);
    try {
      const tap = await holdATapUntilTheIdleStop('WARM-6', 'REASK-6', 'afterTheStop', () => fs.writeFileSync(refuseLaunchPath, ''));
      const isNewTopicSend = (call: FakeTelegramCall): boolean => call.method === 'sendMessage' && call.payload.message_thread_id === topicThreadId;
      await getCharness().waitFor('the start failure to be told', failedStartTimeoutMs, () => fakeTelegram.calls.slice(tap.callsAtToast).some(isNewTopicSend));
      // The barrier is read only once the tap's handler is done: the next updates wait for it.
      await new TopicDriver(fakeTelegram, getCharness, topicThreadId, failedStartTimeoutMs).sendAndAwaitReply(barrierCommand, 'Not/AZone');
      const callsAfter = fakeTelegram.calls.slice(tap.callsAtToast);
      const lines = callsAfter.filter(isNewTopicSend).map((call) => String(call.payload.text ?? '')).filter((text) => !text.includes('Not/AZone'));
      assert.equal(lines.length, 1, `one line for the failed start, got: ${JSON.stringify(lines)}`);
      assert.ok(!lines.includes(enDict['agent.no_session']), 'no generic "No agent running" beside the reason');
      assert.ok(!lines[0].includes(enDict['agent.resume_failed_fresh']), `no "a fresh session was started" for a start that failed: ${lines[0]}`);
      assert.match(lines[0], /refused to start/, 'the CLI\'s own words');
      assert.deepEqual(getAgentPrompts(fakeAskQuestion.shortOptionLabel).slice(tap.labelPromptsBefore), [], 'the label reached no agent');
      // The start attempts show their own loader and switch it off when they fail; a forward after the failure would
      // set the topic to "working" (a typing action right after the line) for text the adapter then drops.
      const failureLineIndex = callsAfter.findIndex(isNewTopicSend);
      assert.deepEqual(
        callsAfter.slice(failureLineIndex + 1).filter((call) => call.method === 'sendChatAction' && call.payload.message_thread_id === topicThreadId),
        [],
        'no typing loader after the failure line',
      );
      assert.ok(!getCharness().output.includes('sendInput to inactive session'), 'nothing was forwarded to a session that is not there');

      // The question is still open: once the agent can start, its button delivers the label.
      fs.rmSync(refuseLaunchPath, { force: true });
      const labelPromptsBeforeRetap = getAgentPrompts(fakeAskQuestion.shortOptionLabel).length;
      assert.equal(await topic.tapAndAwaitAnswer(tap.reasked, 'reask_0'), fakeAskQuestion.shortOptionLabel, 'the button still knows its label');
      await getCharness().waitFor('the label to reach the started agent', agentStartTimeoutMs, () => getAgentPrompts(fakeAskQuestion.shortOptionLabel).length > labelPromptsBeforeRetap);
    } finally {
      fs.rmSync(refuseLaunchPath, { force: true });
    }
  });
});
