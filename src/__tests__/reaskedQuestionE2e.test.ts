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
import { fakeAskQuestion, fakeClaudeLogFileNames, type FakeClaudePrompt } from './jiraE2e/fakeClaudeContract';
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

/** The line the bot logs once the idle fire has stopped the agent's process (the conversation then sleeps). */
const idleStopLine = 'process stopped; the session sleeps';

function countIdleStops(): number {
  return getCharness().output.split(idleStopLine).length - 1;
}

/**
 * Put the question (`ask` mode) and leave it unanswered until the idle fire rejects it, compacts and re-asks it: resolves
 * the re-asked message, whose buttons are `reask_<i>`, once the fire has also stopped the process — the question is posted
 * just BEFORE the stop, and a tap inside that window reaches a dying process instead of waking a sleeping conversation.
 */
async function waitForReaskedQuestion(promptLabel: string): Promise<FakeTelegramMessage> {
  const idleStopsBefore = countIdleStops();
  const sentMessageId = fakeTelegram.pushOperatorMessage(topicThreadId, `${promptLabel} [fake:ask] ask me something`);
  await topic.waitForMessage(`the question of ${promptLabel}`, (message) => message.message_id > sentMessageId && message.text.includes(fakeAskQuestion.question) && message.reply_markup !== undefined);
  const reasked = await waitingTopic.waitForMessage(`the re-asked question of ${promptLabel}`, (message) =>
    message.message_id > sentMessageId && message.reply_markup !== undefined && waitingTopic.getKeyboardData(message).flat().some((data) => data.startsWith('reask_')),
  );
  assert.match(reasked.text, /You still have a pending question/);
  assert.match(reasked.text, new RegExp(fakeAskQuestion.question.replace('?', '\\?')));
  assert.deepEqual(topic.getKeyboardData(reasked), [['reask_0'], ['reask_1']], 'one button per option');
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
});
