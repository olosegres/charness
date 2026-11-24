/**
 * @description The agent's narration written right before a question reaches the topic, at PROCESS level: the BUILT charness
 * started the way an isolated instance is (`scripts/run-isolated.sh`) against the fake Bot API of `telegramE2e/fakeTelegram.ts`,
 * with the fake `claude` (`jiraE2e/fakeClaude.ts`, mode `ask` with `[fake:narrate]`) streaming its explanation the way Claude
 * Code streams the model's narration under the `updates` thinking display — in a THINKING block — and then putting an
 * `AskUserQuestion` to the topic. In order:
 *
 *   boot → the topic is bound → `/claude`
 *   → a prompt whose turn narrates, then asks: the narration stands in the topic, whole and not deleted, ABOVE the question
 *     (on the topic's default thinking display, which shows thinking only as a placeholder it deletes)
 *   → a tap on an option: the agent got the answer, the narration is still there
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
  fakeAskToolName,
  fakeClaudeLogFileNames,
  fakeNarrateToken,
  fakeNarrationText,
  type FakeClaudeToolCall,
} from './jiraE2e/fakeClaudeContract';
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
import { startCharnessOnInstance } from './e2e/fallbackFlowKit';
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const topicThreadId = 111;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const projectFolder = 'proj';

const replyTimeoutMs = 20 * 1000;
const agentStartTimeoutMs = 60 * 1000;

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

/** The answers the fake's `AskUserQuestion` got, in order. */
function getGivenAnswers(): string[] {
  return readJsonLines<FakeClaudeToolCall>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.toolCalls)).filter((call) => call.tool === fakeAskToolName).map((call) => call.outcome);
}

/** The topic's messages that carry the narration and are still there. */
function listNarrationMessages(): FakeTelegramMessage[] {
  return fakeTelegram.listBotMessages(topicThreadId).filter((message) => message.text.includes(fakeNarrationText));
}

describe('the agent\'s narration before a question reaches the topic (process level)', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-narration-', [projectFolder], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);
    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    topic = new TopicDriver(fakeTelegram, getCharness, topicThreadId, replyTimeoutMs);
    waitingTopic = new TopicDriver(fakeTelegram, getCharness, topicThreadId, agentStartTimeoutMs);
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
      OPENCODE_URL: `http://127.0.0.1:${await getUnservedPort()}`,
      SCHEDULER_MCP_PORT: (await getFreeFixedPort()).toString(),
      ...getTelegramFlowTestTimingsEnv(),
    });
    charness = await startCharnessOnInstance(layout, fakeTelegram);
    await topic.sendAndAwaitReply(`/bind ${projectFolder}`, `Bound to \`${projectFolder}\``);
    await waitingTopic.sendAndAwaitReply('/claude', 'ready in');
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

  it('the narration streamed as thinking stands above the question, and stays after the answer', async () => {
    const sentMessageId = fakeTelegram.pushOperatorMessage(topicThreadId, `narrated [fake:ask] ${fakeNarrateToken} why is it silent?`);
    const question = await waitingTopic.waitForMessage('the question', (message) =>
      message.message_id > sentMessageId
      && message.text.includes(fakeAskQuestion.question)
      && waitingTopic.getKeyboardData(message).flat().some((data) => data.startsWith('qa_')));

    // The narration is landed before the question is posted; on failure the topic's messages show what stood there instead.
    await getCharness().waitFor('the narration to stand in the topic', replyTimeoutMs, () => listNarrationMessages().length > 0).catch((error: unknown) => {
      const shown = fakeTelegram.listAllMessages().map((message) => `${message.message_id}${message.isDeleted ? ' (deleted)' : ''}: ${message.text.slice(0, 120)}`);
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nthe topic's messages:\n${shown.join('\n')}`);
    });
    const [narration] = listNarrationMessages();
    assert.ok(narration, 'the narration is in the topic');
    assert.ok(narration.message_id < question.message_id, `the narration (${narration.message_id}) stands above the question (${question.message_id})`);

    const optionData = waitingTopic.getKeyboardData(question).flat().find((data) => data.startsWith('qa_'));
    assert.ok(optionData, 'the question has an option button');
    const answersBefore = getGivenAnswers().length;
    fakeTelegram.pushCallback(question.message_id, optionData);
    await getCharness().waitFor('the agent to get the answer', agentStartTimeoutMs, () => getGivenAnswers().length > answersBefore);

    const kept = fakeTelegram.getMessage(narration.message_id);
    assert.ok(kept && !kept.isDeleted && kept.text.includes(fakeNarrationText), 'the narration is still in the topic after the answer');
  });
});
