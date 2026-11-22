/**
 * @description The idle compaction waits for the context to GROW, and a topic that only the bot itself wakes is compacted before it
 * sleeps once it has, at PROCESS level: the BUILT charness started the way an isolated instance is (`scripts/run-isolated.sh`) against
 * the fake Bot API of `telegramE2e/fakeTelegram.ts`, with the fake `claude` as the agent — it writes the context size the test sets
 * (`fakeClaudeContextTokensFileName`) into each turn's transcript record, as the real CLI leaves it — and the idle window cut to seconds
 * (`AGENT_IDLE_MINUTES`). The owner's rules (2026-11-22): «compaction first, then the topic goes to sleep» — but «if the context did not
 * grow much there is no point in compacting»: the baseline is the context of the FIRST turn after the last compaction (instructions and
 * skills loaded again), and growth of 30 000 tokens over it is what makes a compaction worth it. The incident behind it: a live
 * orchestrating topic, woken only by its own checks and worker watches, slept at every idle mark for 31 hours and was never compacted
 * again. One flow, in order:
 *
 *   boot → the topic is bound, its agent started, and one answered turn of a PERSON (context 40 000) is the baseline; the same turn
 *     arms a one-shot scheduler job (the fake agent creates it on the bot's MCP, as an orchestrating agent arms a check) that fires
 *     long after the first sleep
 *   → the topic sits idle: it has not grown, so the idle mark does NOT compact — one line in the console says why, nothing is posted
 *     to the topic — and it only stops the process: the name takes 💤
 *   → the context grows to 80 000 and the scheduler job — not a person — wakes the sleeping conversation: the agent takes one turn
 *   → the topic sits idle again: it grew by 40 000, so the idle mark compacts it (a notice, the agent's `/compact`) BEFORE the second
 *     stop and the second 💤; the baseline is dropped with the compaction
 *   → a person's turn (context 45 000) starts the baseline over — the first turn after the compaction, not the compaction's own
 *     `post=` figure — and the next idle mark, with no growth since, only stops the process
 *
 * Nothing leaves the machine: the Bot API is on loopback and the agent is a fake. Everything the test starts is stopped in `after`.
 * The decision's branches and the module's reading of the context are `compactOnIdle.test.ts`'s and `compactOnIdleGrowth.test.ts`'s.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import { fakeClaudeContextTokensFileName, fakeClaudeLogFileNames, fakeScheduleOnceToken, type FakeClaudePrompt } from './jiraE2e/fakeClaudeContract';
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
import { defaultCompactGrowthTokens } from '../utils/compactOnIdle';
import type { CompactIdleTrackingEntry } from '../state';
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
/** The context size of the conversation's turns, in tokens: the baseline, what the scheduler job's turn grows it to, and the first turn after the compaction. */
const baselineContextTokens = 40_000;
const grownContextTokens = baselineContextTokens + defaultCompactGrowthTokens + 10_000;
const afterCompactionContextTokens = 45_000;

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

/** What the bot logs when an idle mark finds the context has not grown enough: the compaction is skipped, the stop still follows. */
function getNotGrownSkipLine(): string {
  return `[compact-on-idle] ${topicKey} timer fired but the compaction is skipped: the context grew by`;
}

/** The context size the fake agent writes into the transcript of every turn it ends from now on. */
function setContextTokens(tokens: number): void {
  fs.writeFileSync(path.join(getLayout().fakeStateDir, fakeClaudeContextTokensFileName), tokens.toString());
}

/** The topic's idle-compaction bookkeeping as the bot saved it. */
function readTracking(): CompactIdleTrackingEntry | undefined {
  const persisted: { compactIdleTracking?: Record<string, CompactIdleTrackingEntry> } = JSON.parse(fs.readFileSync(path.join(getLayout().dataDir, 'state.json'), 'utf8'));
  return persisted.compactIdleTracking?.[topicKey];
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

describe('The idle compaction waits for the context to grow, and a topic woken only by the bot is then compacted before it sleeps, end to end: built charness, fake Bot API, fake agent', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-compactsleep-', [projectFolder], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fs.mkdirSync(layout.fakeStateDir, { recursive: true });
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

  it('boots, binds the topic, starts its agent; a person\'s turn is the baseline (40 000 tokens) and arms a one-shot scheduler job that fires long after the first sleep', async () => {
    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    topicThreadId = fakeTelegram.pushTopicCreated(topicBaseName);
    topicKey = `${group.id}:${topicThreadId}`;
    topic = new TopicDriver(fakeTelegram, getCharness, topicThreadId, replyTimeoutMs);
    await topic.waitForMessage('the welcome of the new topic', () => true);
    await topic.sendAndAwaitReply(`/bind ${projectFolder}`, `Bound to \`${projectFolder}\``);
    await topic.sendAndAwaitReply('/claude', 'ready in');
    setContextTokens(baselineContextTokens);
    const warmUpMessageId = fakeTelegram.pushOperatorMessage(topicThreadId, `WARM-1 [fake:answer] hello ${fakeScheduleOnceToken(schedulerJobDelaySeconds, schedulerJobLabel)}`);
    await topic.waitForMessage('the warm-up answer', (message) => message.message_id > warmUpMessageId && message.text.includes('WARM-1'));
    await getCharness().waitFor('the bot to read the turn\'s context size', replyTimeoutMs, () => readTracking()?.baselineContextTokens === baselineContextTokens);
    assert.equal(readTracking()?.lastContextTokens, baselineContextTokens, 'the first turn of a conversation never compacted is its baseline');
  });

  it('the first idle mark finds no growth: nothing is compacted or posted, one console line says why, and the process is only stopped — the name takes 💤', async () => {
    await getCharness().waitFor('the first idle stop', idleStopTimeoutMs, () => countConsoleLines(getStopLine()) === 1);
    assert.equal(countCompactions(), 0, 'the agent was not asked to /compact');
    assert.equal(countConsoleLines(getCompactedLine()), 0);
    assert.equal(countConsoleLines(getNotGrownSkipLine()), 1, 'the console says the context did not grow');
    assert.equal(countIdleNotices(), 0, 'nothing is posted to the topic');
    await getCharness().waitFor(`the topic to be called «${sleepingName}»`, renameTimeoutMs, () => fakeTelegram.getTopicName(topicThreadId) === sleepingName);
    assert.deepEqual(listNoticeAndSleepCalls(), ['sleep'], 'the first thing of this idle period the topic saw is the sleep');
    assert.ok(
      !listPrompts().some((prompt) => prompt.text.includes(schedulerJobPrompt)),
      'precondition not met: the scheduler job fired before the first sleep — the box is too loaded for this flow\'s window',
    );
  });

  it('the context grows to 80 000 and the scheduler job — not a person — wakes the sleeping conversation: the agent takes one turn, and the bot reads its size', async () => {
    setContextTokens(grownContextTokens);
    // The job's prompt is no request of a person: the fake takes it as a turn of its own (logged under the job's label).
    await getCharness().waitFor('the agent to take the scheduler job\'s turn', schedulerWakeTimeoutMs, () => getAgentTurns(getLayout(), schedulerJobLabel).length === 1);
    assert.equal(listPrompts().filter((prompt) => prompt.text.includes(schedulerJobPrompt)).length, 1, 'the job\'s prompt reached the agent once');
    await getCharness().waitFor('the bot to read the grown context', replyTimeoutMs, () => readTracking()?.lastContextTokens === grownContextTokens);
    assert.equal(readTracking()?.baselineContextTokens, baselineContextTokens, 'growth moves the newest figure only: the baseline stays the first turn\'s');
  });

  it('the next idle mark finds the growth (40 000 of the 30 000 needed) and compacts BEFORE the stop — a notice and a /compact come before the second stop and the second 💤; the baseline is dropped', async () => {
    await getCharness().waitFor('the second idle stop', idleStopTimeoutMs, () => countConsoleLines(getStopLine()) === 2);
    assert.equal(countCompactions(), 1, 'the agent ran a /compact');
    assert.equal(countConsoleLines(getCompactedLine()), 1, 'the bot saw the compaction complete');
    assert.equal(countIdleNotices(), 1, 'the topic got the idle compaction notice');
    assert.equal(countConsoleLines(getNotGrownSkipLine()), 1, 'only the first idle mark was skipped for the context not having grown');
    // In the console's own order: the compaction completed, then the second stop (the stop line is logged once the process is gone).
    const output = getCharness().output;
    const compactedAt = output.indexOf(getCompactedLine());
    const secondStopAt = output.indexOf(getStopLine(), output.indexOf(getStopLine()) + 1);
    assert.ok(compactedAt >= 0 && compactedAt < secondStopAt, 'the compaction completed BEFORE the second stop');
    await getCharness().waitFor('the second 💤', renameTimeoutMs, () => listNoticeAndSleepCalls().filter((call) => call === 'sleep').length >= 2);
    // In the Bot API's order: 💤 (1), the job's turn, the notice, 💤 (2) — the notice is before the second 💤.
    assert.deepEqual(listNoticeAndSleepCalls(), ['sleep', 'notice', 'sleep']);
    const tracking = readTracking();
    assert.equal(tracking?.baselineContextTokens, undefined, 'the compaction dropped the baseline: the next turn that ends starts it over');
    assert.equal(tracking?.lastContextTokens, undefined);
  });

  it('a person\'s turn after the compaction (45 000) is the new baseline — the first turn, not the compaction\'s own figure — and the next idle mark, with no growth, only stops the process', async () => {
    setContextTokens(afterCompactionContextTokens);
    const wakeMessageId = fakeTelegram.pushOperatorMessage(topicThreadId, 'WAKE-1 [fake:answer] are you there?');
    await topic.waitForMessage('the answer of the woken agent', (message) => message.message_id > wakeMessageId && message.text.includes('WAKE-1'));
    await getCharness().waitFor('the bot to read the turn\'s context size', replyTimeoutMs, () => readTracking()?.baselineContextTokens === afterCompactionContextTokens);
    assert.equal(readTracking()?.lastContextTokens, afterCompactionContextTokens);

    await getCharness().waitFor('the third idle stop', idleStopTimeoutMs, () => countConsoleLines(getStopLine()) === 3);
    assert.equal(countCompactions(), 1, 'no second compaction: the context has not grown since the new baseline');
    assert.equal(countIdleNotices(), 1);
    assert.equal(countConsoleLines(getNotGrownSkipLine()), 2, 'the console says so again, once');
  });
});
