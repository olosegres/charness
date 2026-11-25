/**
 * @description Messages the operator sent while the agent worked must not keep the topic's process "working" for good, at
 * PROCESS level: the BUILT charness started the way an isolated instance is (`scripts/run-isolated.sh`) against the fake Bot API
 * of `telegramE2e/fakeTelegram.ts`, with the fake `claude` as the agent draining the prompts queued behind a running turn the way
 * the real CLI 2.1.329 was measured to — as ONE turn with ONE echo (`fakeClaudeMergeQueuedPromptsFileName`) — and the idle window
 * cut to seconds (`AGENT_IDLE_MINUTES`). One flow, in order:
 *
 *   boot → the topic is bound and its agent started
 *   → MR-1 starts a slow turn; MR-2 and MR-3 are sent while it works: the agent answers both in ONE turn (the precondition: the
 *     bot wrote three messages and got two echoes)
 *   → the topic sits idle: the idle mark compacts the conversation (the notice reaches the topic) and stops the process — it was
 *     not kept "working" for the one message the bot believed was never taken in (the incident: no compaction, no line, for hours,
 *     until the operator typed `/compact`)
 *   → a bot that was down past the idle window and comes back (its saved last activity hours old) does not compact the idle
 *     process on its overdue boot fire — the prompt cache is cold by then — it only stops it
 *
 * Nothing leaves the machine: the Bot API is on loopback and the agent is a fake. Everything the test starts is stopped in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import { fakeClaudeLogFileNames, fakeClaudeMergeQueuedPromptsFileName, writeFakeContextGrowingEveryTurn, type FakeClaudePrompt } from './jiraE2e/fakeClaudeContract';
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
import { getAgentTurns, getAllAgentTurns, restartCharnessWithState, startCharnessOnInstance } from './e2e/fallbackFlowKit';
import { enDict } from '../i18n/en';
import { claudeJsonStreamUsageLogPrefix } from '../adapters/claudeJsonStreamAdapter';
import { checkIsPidAlive } from '../utils/jsonStreamHost';
import { unconsumedInputGraceMs } from '../utils/jsonStreamPendingWork';
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const topicThreadId = 111;
const topicKey = `${group.id}:${topicThreadId}`;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const projectFolder = 'merged-input';

/**
 * The idle window, cut to seconds. It must stay SHORTER than the grace an unconsumed message holds a turn-less process
 * (`unconsumedInputGraceMs`): with a longer window the grace alone would release a message the matcher failed to recognise,
 * and the flow would pass on a broken matcher (asserted in the idle step).
 */
const idleWindowMinutes = '0.2';
const idleWindowMs = 12 * 1000;
const replyTimeoutMs = 20 * 1000;
/** How long MR-1's turn works: the two messages are written inside it. */
const slowTurnMs = 6 * 1000;
/** The idle mark, the compaction it makes and the stop, with room for a loaded box. */
const idleStopTimeoutMs = 90 * 1000;

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
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

function listPrompts(): FakeClaudePrompt[] {
  return readJsonLines<FakeClaudePrompt>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.prompts));
}

function listCompactions(): Array<{ sessionId: string; pid: number; instruction: string }> {
  return readJsonLines<{ sessionId: string; pid: number; instruction: string }>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.compactions));
}

const stopLine = `[compact-on-idle] ${topicKey} process stopped; the session sleeps`;

/** How many turns ended so far: the bot logs every result's usage. */
function countTurnEnds(): number {
  return getCharness().output.split(`${claudeJsonStreamUsageLogPrefix}${topicKey}:`).length - 1;
}
/** The notice the idle compaction posts into the topic (its first line). */
const idleNoticeStart = enDict['compactOnIdle.notice'].split('\n')[0];

describe('Messages sent while the agent works do not keep the topic "working" for good, end to end: built charness, fake Bot API, fake agent', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-mergedin-', [projectFolder], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fs.mkdirSync(layout.fakeStateDir, { recursive: true });
    // The idle compaction compacts again only once the context grew: every turn grows it past the threshold.
    writeFakeContextGrowingEveryTurn(layout.fakeStateDir);
    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    topic = new TopicDriver(fakeTelegram, getCharness, topicThreadId, replyTimeoutMs);
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
      OPENCODE_URL: `http://127.0.0.1:${await getUnservedPort()}`,
      SCHEDULER_MCP_PORT: (await getFreeFixedPort()).toString(),
      ...getTelegramFlowTestTimingsEnv(),
    });
    // The agent drains what is queued behind a running turn the way the real CLI does: as one turn with one echo.
    fs.writeFileSync(path.join(layout.fakeStateDir, fakeClaudeMergeQueuedPromptsFileName), '');
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

  it('boots, binds the topic and starts its agent', async () => {
    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    await topic.sendAndAwaitReply(`/bind ${projectFolder}`, `Bound to \`${projectFolder}\``);
    await topic.sendAndAwaitReply('/verbosity stream_answers', 'This topic shows: Stream + answers');
    await topic.sendAndAwaitReply('/claude', 'ready in');
  });

  it('two messages sent while a turn works are answered by ONE turn: three messages written, two echoes', async () => {
    const turnsBefore = getAllAgentTurns(getLayout()).length;
    fakeTelegram.pushOperatorMessage(topicThreadId, `MR-1 [fake:answer] [work-ms:${slowTurnMs}] a slow turn`);
    await getCharness().waitFor('the agent to read MR-1', replyTimeoutMs, () => listPrompts().some((prompt) => prompt.text.includes('MR-1 ')));
    fakeTelegram.pushOperatorMessage(topicThreadId, 'MR-2 [fake:answer] second message, sent while it works');
    fakeTelegram.pushOperatorMessage(topicThreadId, 'MR-3 [fake:answer] third message, sent while it works');
    await topic.waitForMessage('the answer to MR-3', (message) => message.text.includes('Fake final answer for MR-3'));
    const turns = getAllAgentTurns(getLayout()).slice(turnsBefore);
    assert.equal(turns.length, 2, `MR-1's turn and ONE turn for MR-2 and MR-3 together: ${JSON.stringify(turns)}`);
    assert.equal(listPrompts().filter((prompt) => /MR-[123] /.test(prompt.text)).length, 3, 'the bot wrote all three messages');
  });

  it('the idle mark compacts the conversation and stops the process: nothing is kept "working" for a message the CLI already took in', async () => {
    const pid = getAgentTurns(getLayout(), 'MR-3')[0]?.pid;
    assert.ok(pid !== undefined && checkIsPidAlive(pid), 'the process is up before the idle mark');
    assert.ok(idleWindowMs < unconsumedInputGraceMs, 'the grace alone must not be able to release the message: the flow would not prove the matcher');
    const compactionsBefore = listCompactions().length;
    await getCharness().waitFor('the idle stop', idleStopTimeoutMs, () => getCharness().output.includes(stopLine));
    assert.ok(listCompactions().length > compactionsBefore, 'the conversation was compacted at the idle mark');
    assert.ok(topic.listMessages().some((message) => message.text.startsWith(idleNoticeStart)), 'the topic got the idle compaction notice');
    assert.ok(!getCharness().output.includes(`${topicKey} timer fired but the compaction is skipped: working`), 'the idle fire never took the process for working');
    assert.ok(!checkIsPidAlive(pid), 'the process is gone');
  });

  it('a bot that was down past the idle window does not compact on its way back: its overdue boot fire only stops the idle process (the prompt cache is cold by then)', async () => {
    const turnEndsBefore = countTurnEnds();
    fakeTelegram.pushOperatorMessage(topicThreadId, 'MR-4 [fake:answer] a turn after the idle stop');
    await topic.waitForMessage('the answer to MR-4', (message) => message.text.includes('Fake final answer for MR-4'));
    // The answer shows a moment before its turn ends: a restart before that would adopt a process that looks mid-turn, and the fire would find it busy.
    await getCharness().waitFor('the end of MR-4\'s turn', replyTimeoutMs, () => countTurnEnds() > turnEndsBefore);
    const pid = getAgentTurns(getLayout(), 'MR-4')[0]?.pid;
    assert.ok(pid !== undefined && checkIsPidAlive(pid), 'the woken process is up: a compaction is due, and the process idle');
    const compactionsBefore = listCompactions().length;
    // The bot goes down and comes back long after the idle window: what it saved as the topic's last activity is hours old.
    charness = await restartCharnessWithState(getLayout(), fakeTelegram, getCharness(), (persisted) => {
      const tracking = persisted.compactIdleTracking?.[topicKey];
      assert.ok(tracking, 'the topic has saved compact-on-idle instants');
      tracking.lastActivityAt = Date.now() - 3 * 60 * 60 * 1000;
    });
    await getCharness().waitFor('the idle stop of the overdue fire', idleStopTimeoutMs, () => getCharness().output.includes(stopLine));
    assert.ok(getCharness().output.includes(`${topicKey} timer fired but the compaction is skipped: the idle mark had already passed when the countdown was armed`), `the console says why it did not compact:\n${getCharness().output.split('\n').filter((line) => line.includes('compact-on-idle') || line.includes('reattach')).join('\n')}`);
    assert.equal(listCompactions().length, compactionsBefore, 'not compacted: the idle mark was missed, the cache is cold');
    assert.ok(!checkIsPidAlive(pid), 'the process is gone');
  });
});
