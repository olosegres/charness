/**
 * @description A topic that only the bot itself wakes is still compacted before each sleep, at PROCESS level: the BUILT charness
 * started the way an isolated instance is (`scripts/run-isolated.sh`) against the fake Bot API of `telegramE2e/fakeTelegram.ts`, with
 * the fake `claude` as the agent and the idle window cut to seconds (`AGENT_IDLE_MINUTES`). The incident (a live orchestrating topic,
 * 31 hours without a compaction): the first idle compaction latches the topic and only a PERSON's message clears the latch, so a topic
 * woken by its own checks and worker watches slept at every later idle mark with «skipped: latched (D2)» and was never compacted again.
 * The owner's rule (2026-11-22): the compaction comes first, then the sleep. One flow, in order:
 *
 *   boot → the topic is bound, its agent started, and one answered turn of a PERSON arms a one-shot scheduler job (the fake agent
 *     creates it on the bot's MCP, as an orchestrating agent arms a check) that fires long after the first sleep
 *   → the topic sits idle: the first idle compaction (its notice, the agent's `/compact`) and then the stop — the name takes 💤
 *   → the scheduler job — not a person — wakes the sleeping conversation: the agent takes one turn, no message of a person came
 *     between, so the latch the first compaction set is still there
 *   → the topic sits idle again: the SECOND idle compaction (a second notice, a second `/compact`) comes BEFORE the second stop and
 *     the second 💤, and the console never says «skipped: latched»
 *
 * Nothing leaves the machine: the Bot API is on loopback and the agent is a fake. Everything the test starts is stopped in `after`.
 * The pure rule (the latch still blocks the compaction of a backend that is not stopped) is covered in `compactOnIdle.test.ts`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import { fakeClaudeLogFileNames, fakeScheduleOnceToken, type FakeClaudePrompt } from './jiraE2e/fakeClaudeContract';
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
import { getAgentTurns, startCharnessOnInstance } from './e2e/fallbackFlowKit';
import { enDict } from '../i18n/en';
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const projectFolder = 'proj';
const topicBaseName = 'Orchestrator';
const sleepingName = `${topicBaseName} 💤`;

/** The idle window of the instance, in minutes (12 s): the fire comes this long after the last activity. */
const idleWindowMinutes = '0.2';
/** The windows of the topic marks in this flow (production: 20 s, 60 s, 5 min, 5 s), cut as `topicStatusIdleE2e` cuts them. */
const settleMs = 800;
const gapMs = 2000;
const sweepMs = 3000;
const bootWaveDelayMs = 1000;
const replyTimeoutMs = 20 * 1000;
/** A name that must wait out the settle time and the gap, with room for a loaded box. */
const renameTimeoutMs = gapMs + settleMs + 15 * 1000;
/** The idle mark, the compaction it makes and the stop, with room for a loaded box. */
const idleStopTimeoutMs = 120 * 1000;
/**
 * When the scheduler job fires, counted from the turn that arms it: well past the first idle mark (12 s), its compaction and its stop,
 * so the job meets a SLEEPING conversation, as a check or a worker watch of a live orchestrating topic does. The flow checks that
 * this held (it fails as «precondition not met» on a box too loaded for it) instead of passing a weaker scenario.
 */
const schedulerJobDelaySeconds = 50;
const schedulerJobLabel = 'SCHED-1';
/** The prompt the scheduler job delivers (the fake's `schedule-once` text) — not the warm-up's own, which only names the label. */
const schedulerJobPrompt = `${schedulerJobLabel} [fake:answer] scheduled`;
/** The job's turn, with room for the wait for the job itself. */
const schedulerWakeTimeoutMs = (schedulerJobDelaySeconds + 60) * 1000;

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let topic: TopicDriver;
let topicThreadId = 0;
let topicKey = '';
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

/** One record per `/compact` turn the fake agent ran. */
function countCompactions(): number {
  return readJsonLines<{ sessionId: string; pid: number }>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.compactions)).length;
}

/** How many times the bot's console said `line`. */
function countConsoleLines(line: string): number {
  return getCharness().output.split(line).length - 1;
}

/** The notice the idle compaction posts into the topic (its first line). */
const idleNoticeStart = enDict['compactOnIdle.notice'].split('\n')[0];

function countIdleNotices(): number {
  return topic.listMessages().filter((message) => message.text.startsWith(idleNoticeStart)).length;
}

/** What the bot says when the idle compaction is held back by the latch: the line this flow must never see. */
function getLatchedSkipLine(): string {
  return `[compact-on-idle] ${topicKey} timer fired but the compaction is skipped: latched (D2)`;
}

const getStopLine = (): string => `[compact-on-idle] ${topicKey} process stopped; the session sleeps`;
const getCompactedLine = (): string => `[ClaudeJson] compacted ${topicKey}`;

/** The topic's idle notices and the renames to 💤, in the order the fake Bot API received them. */
function listNoticeAndSleepCalls(): Array<'notice' | 'sleep'> {
  return fakeTelegram.calls.flatMap((call): Array<'notice' | 'sleep'> => {
    if (call.method === 'sendMessage' && call.payload.message_thread_id === topicThreadId && String(call.payload.text).startsWith(idleNoticeStart)) return ['notice'];
    if (call.method === 'editForumTopic' && call.payload.message_thread_id === topicThreadId && call.payload.name === sleepingName) return ['sleep'];
    return [];
  });
}

describe('A topic woken only by the bot is compacted before it sleeps again, end to end: built charness, fake Bot API, fake agent', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-compactsleep-', [projectFolder], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    fakeTelegram.isOwnTopicRenameDelivered = true;
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
      ...getTelegramFlowTestTimingsEnv({
        topicIndicatorSettleMs: settleMs,
        topicIndicatorMinRenameGapMs: gapMs,
        topicIndicatorSweepMs: sweepMs,
        topicIndicatorBootWaveDelayMs: bootWaveDelayMs,
      }),
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

  it('boots, binds the topic, starts its agent; a person\'s turn arms a one-shot scheduler job that fires long after the first sleep', async () => {
    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    topicThreadId = fakeTelegram.pushTopicCreated(topicBaseName);
    topicKey = `${group.id}:${topicThreadId}`;
    topic = new TopicDriver(fakeTelegram, getCharness, topicThreadId, replyTimeoutMs);
    await topic.waitForMessage('the welcome of the new topic', () => true);
    await topic.sendAndAwaitReply(`/bind ${projectFolder}`, `Bound to \`${projectFolder}\``);
    await topic.sendAndAwaitReply('/claude', 'ready in');
    const warmUpMessageId = fakeTelegram.pushOperatorMessage(topicThreadId, `WARM-1 [fake:answer] hello ${fakeScheduleOnceToken(schedulerJobDelaySeconds, schedulerJobLabel)}`);
    await topic.waitForMessage('the warm-up answer', (message) => message.message_id > warmUpMessageId && message.text.includes('WARM-1'));
  });

  it('the first idle mark compacts the conversation — notice, then the agent\'s /compact — and stops the process: the name takes 💤', async () => {
    await getCharness().waitFor('the first idle stop', idleStopTimeoutMs, () => countConsoleLines(getStopLine()) === 1);
    assert.equal(countCompactions(), 1, 'the agent ran one /compact');
    assert.equal(countConsoleLines(getCompactedLine()), 1, 'the bot saw the compaction complete');
    assert.equal(countIdleNotices(), 1, 'the topic got the idle compaction notice');
    assert.deepEqual(listNoticeAndSleepCalls().slice(0, 1), ['notice'], 'the notice reached the topic before anything else of this idle period');
    await getCharness().waitFor(`the topic to be called «${sleepingName}»`, replyTimeoutMs, () => fakeTelegram.getTopicName(topicThreadId) === sleepingName);
    assert.ok(
      !listPrompts().some((prompt) => prompt.text.includes(schedulerJobPrompt)),
      'precondition not met: the scheduler job fired before the first sleep — the box is too loaded for this flow\'s window',
    );
  });

  it('the scheduler job — not a person — wakes the sleeping conversation: one turn is taken, and the latch the first compaction set is still there', async () => {
    // The job's prompt is no request of a person: the fake takes it as a turn of its own (logged under the job's label).
    await getCharness().waitFor('the agent to take the scheduler job\'s turn', schedulerWakeTimeoutMs, () => getAgentTurns(getLayout(), schedulerJobLabel).length === 1);
    assert.equal(listPrompts().filter((prompt) => prompt.text.includes(schedulerJobPrompt)).length, 1, 'the job\'s prompt reached the agent once');
    const persisted: { compactIdleLatchedThreads?: string[] } = JSON.parse(fs.readFileSync(path.join(getLayout().dataDir, 'state.json'), 'utf8'));
    assert.ok(persisted.compactIdleLatchedThreads?.includes(topicKey), 'the topic is still latched: only a person\'s message clears it');
  });

  it('the next idle mark compacts AGAIN before the stop — a second notice and a second /compact come before the second stop and the second 💤', async () => {
    await getCharness().waitFor('the second idle stop', idleStopTimeoutMs, () => countConsoleLines(getStopLine()) === 2);
    assert.equal(countCompactions(), 2, 'the agent ran a second /compact');
    assert.equal(countConsoleLines(getCompactedLine()), 2, 'the bot saw the second compaction complete');
    assert.equal(countIdleNotices(), 2, 'the topic got a second idle compaction notice');
    assert.equal(countConsoleLines(getLatchedSkipLine()), 0, 'the console never says the compaction was skipped as latched');
    // In the console's own order: the second compaction completed, then the second stop (the stop line is logged once the process is gone).
    const output = getCharness().output;
    const secondCompactedAt = output.indexOf(getCompactedLine(), output.indexOf(getCompactedLine()) + 1);
    const secondStopAt = output.indexOf(getStopLine(), output.indexOf(getStopLine()) + 1);
    assert.ok(secondCompactedAt >= 0 && secondCompactedAt < secondStopAt, 'the second compaction completed BEFORE the second stop');
    await getCharness().waitFor('the second 💤', renameTimeoutMs, () => listNoticeAndSleepCalls().filter((call) => call === 'sleep').length >= 2);
    // In the Bot API's order: notice (1), 💤 (1), the job's turn, notice (2), 💤 (2) — the second notice is before the second 💤.
    const calls = listNoticeAndSleepCalls();
    assert.equal(calls.filter((call) => call === 'notice').length, 2);
    const secondNoticeIndex = calls.indexOf('notice', calls.indexOf('notice') + 1);
    const secondSleepIndex = calls.indexOf('sleep', calls.indexOf('sleep') + 1);
    assert.ok(secondNoticeIndex >= 0 && secondSleepIndex >= 0, `a second notice and a second 💤 were sent (order: ${calls.join(', ')})`);
    assert.ok(secondNoticeIndex < secondSleepIndex, `the second notice came before the second 💤 (order: ${calls.join(', ')})`);
  });
});
