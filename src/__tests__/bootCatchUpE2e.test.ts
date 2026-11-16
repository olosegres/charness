/**
 * @description The boot never waits for a missed scheduled run, at PROCESS level: the BUILT charness started the way an
 * isolated instance is (`scripts/run-isolated.sh`) against the fake Bot API of `telegramE2e/fakeTelegram.ts`, with the fake
 * `claude` (`jiraE2e/fakeClaude.ts`, mode `ask`) putting a real `AskUserQuestion` to a topic. The incident it pins: after a
 * restart the bot never started polling, so no topic got a message for as long as the catch-ups took — a missed heartbeat and
 * a missed check were both bound to a topic whose agent was mid-turn, waiting for the operator's answer to its pinned question;
 * their delivery waits for that agent, the boot waited for their delivery, and the answer could not arrive before the bot
 * polled. One flow, in order:
 *
 *   boot → two topics bound, a Claude session started in each
 *   → the agent of the first topic asks a question (pinned) and waits for the operator
 *   → the bot stops; while it is down three runs are missed: a heartbeat (a prompt job) and a check that fails (it wakes the
 *     agent) in the waiting topic, a heartbeat in the other topic whose agent is idle — and the bot starts again
 *   → polling starts (the instance's first poll reaches the fake Bot API) although two catch-ups are held by the waiting agent
 *   → the idle topic's catch-up is NOT held by them: announced, its prompt delivered, its run booked — while the question is
 *     still open and nothing of the waiting topic's runs has reached its agent
 *   → the operator can be heard: a command is answered and a typed option number answers the question
 *   → the two held catch-ups then reach the agent, once each, and every missed run is booked once: one begin and one end record
 *     per job in the run ledger, the next run ahead.
 *
 * Nothing leaves the machine: the Bot API is on loopback and the agent is a fake. Everything the test starts is stopped in
 * `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import { fakeAskQuestion, fakeAskToolName, fakeClaudeLogFileNames, type FakeClaudePrompt, type FakeClaudeToolCall } from './jiraE2e/fakeClaudeContract';
import { enDict } from '../i18n/en';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { keyToString } from '../sessionKey';
import { createScheduleRecord } from '../scheduler/store';
import type { ScheduleRunRecord } from '../scheduler/runLedger';
import type { ScheduleRecord, ScheduleSpec } from '../scheduler/types';
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
import { getStatePath, readPersistedState, startCharnessOnInstance, type PersistedState } from './e2e/fallbackFlowKit';
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const waitingTopicThreadId = 311;
const idleTopicThreadId = 312;
const waitingFolder = 'waiting-proj';
const idleFolder = 'idle-proj';
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const launchLine = 'Launching Telegraf bot (long polling';

const bootTimeoutMs = 60 * 1000;
const replyTimeoutMs = 20 * 1000;
/** A held catch-up polls its agent every 5 s (`busyPollIntervalMs`), then the forward and the fake's turn. */
const heldCatchUpTimeoutMs = 60 * 1000;
const agentTimeoutMs = 60 * 1000;
const msPerHour = 60 * 60 * 1000;
/** How long ago the runs were due: past the catch-up tolerance, so each reads as MISSED at the boot. */
const missedForMs = 2 * msPerHour;

/** A daily job: once its catch-up is booked, its next run is hours away, so no on-time run can fire inside the flow. */
const dailySpec: ScheduleSpec = { kind: 'cron', cronExpr: '0 3 * * *' };

const waitingHeartbeatName = 'heartbeat-waiting';
const waitingHeartbeatPrompt = 'HB-WAITING-PROMPT';
const waitingWatchName = 'watch-waiting';
const waitingWatchPrompt = 'WATCH-WAITING-PROMPT';
const idleHeartbeatName = 'heartbeat-idle';
const idleHeartbeatPrompt = 'HB-IDLE-PROMPT';
/** The check of the waiting topic fails, so its first catch-up wakes the agent. */
const failingCheckCommand = 'exit 3';

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let waitingTopic: TopicDriver;
let idleTopic: TopicDriver;
let defaultTmuxSessionsBefore: string[] = [];
let missedJobIds: Record<string, string> = {};
let restartedAtMs = 0;

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

function readLedgerRuns(jobId: string): ScheduleRunRecord[] {
  return readJsonLines<ScheduleRunRecord>(path.join(getLayout().dataDir, 'scheduler-runs.jsonl')).filter((run) => run.jobId === jobId);
}

/** A missed catch-up's records: its begin record (no `deliveredAt`) and its end record. */
function countCatchUpRecords(jobId: string): { begun: number; ended: number } {
  const catchUps = readLedgerRuns(jobId).filter((run) => run.kind === 'catch-up');
  return { begun: catchUps.filter((run) => run.deliveredAt === undefined).length, ended: catchUps.filter((run) => run.deliveredAt !== undefined).length };
}

function readPersistedJob(jobId: string): ScheduleRecord | undefined {
  const persisted: { schedules?: Record<string, ScheduleRecord> } = JSON.parse(fs.readFileSync(getStatePath(getLayout()), 'utf8'));
  return persisted.schedules?.[jobId];
}

/** What a missed run looks like in `state.json`: built by the store's own factory, then due `missedForMs` ago. */
function buildMissedJob(args: { threadId: number; name: string; prompt: string; checkCommand?: string }): ScheduleRecord {
  const record = createScheduleRecord({
    threadKey: makeTelegramKey(group.id, args.threadId),
    name: args.name,
    spec: dailySpec,
    prompt: args.prompt,
    createdBy: 'agent',
    nowMs: Date.now() - missedForMs,
    ...(args.checkCommand === undefined ? {} : { deliveryKind: 'check' as const, checkCommand: args.checkCommand }),
  });
  return { ...record, nextRunAt: Date.now() - missedForMs };
}

/** The bot is stopped, three runs are missed while it is down, and it starts again: resolves once its polling is up. */
async function restartWithMissedRuns(missedJobs: readonly ScheduleRecord[]): Promise<void> {
  await getCharness().stop();
  const persisted: PersistedState = readPersistedState(getLayout());
  persisted.schedules = Object.fromEntries(missedJobs.map((job) => [job.id, job]));
  fs.writeFileSync(getStatePath(getLayout()), JSON.stringify(persisted));
  // The handle is kept BEFORE the wait: a start that never gets ready must still be stopped by the teardown.
  charness = new IsolatedCharness(getLayout());
  const pollsBefore = fakeTelegram.listCalls('getUpdates').length;
  restartedAtMs = Date.now();
  await charness.start(bootTimeoutMs, (runOutput) => runOutput.includes(launchLine) && fakeTelegram.listCalls('getUpdates').length > pollsBefore);
}

describe('A missed scheduled run never holds up the boot, end to end: built charness, fake Bot API, fake agent', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-bootcu-', [waitingFolder, idleFolder], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    waitingTopic = new TopicDriver(fakeTelegram, getCharness, waitingTopicThreadId, replyTimeoutMs);
    idleTopic = new TopicDriver(fakeTelegram, getCharness, idleTopicThreadId, replyTimeoutMs);
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

  it('boots, binds two topics and starts a fake agent in each', async () => {
    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    await waitingTopic.sendAndAwaitReply(`/bind ${waitingFolder}`, `Bound to \`${waitingFolder}\``);
    await waitingTopic.sendAndAwaitReply('/claude', 'ready in');
    await idleTopic.sendAndAwaitReply(`/bind ${idleFolder}`, `Bound to \`${idleFolder}\``);
    await idleTopic.sendAndAwaitReply('/claude', 'ready in');
  });

  it('the first topic\'s agent asks a question and waits for the operator: it is pinned and saved', async () => {
    const sentMessageId = fakeTelegram.pushOperatorMessage(waitingTopicThreadId, 'BOOTCU-1 [fake:ask] ask me something');
    const question = await waitingTopic.waitForMessage('the question', (message) =>
      message.message_id > sentMessageId
      && message.text.includes(fakeAskQuestion.question)
      && waitingTopic.getKeyboardData(message).flat().some((data) => data.startsWith('qa_')));
    await getCharness().waitFor('the question to be pinned', replyTimeoutMs, () => fakeTelegram.listPinnedMessageIds().includes(question.message_id));
    const key = keyToString(makeTelegramKey(group.id, waitingTopicThreadId));
    await getCharness().waitFor('the question to be saved', replyTimeoutMs, () => readPersistedState(getLayout()).pendingQuestions?.[key]?.messageId === question.message_id);
    assert.deepEqual(getGivenAnswers(), [], 'precondition: the agent has no answer and is waiting for it');
  });

  it('the bot restarts with three runs missed while it was down, two of them held by the waiting agent: its polling starts all the same', async () => {
    const missedJobs = [
      buildMissedJob({ threadId: waitingTopicThreadId, name: waitingHeartbeatName, prompt: waitingHeartbeatPrompt }),
      buildMissedJob({ threadId: waitingTopicThreadId, name: waitingWatchName, prompt: waitingWatchPrompt, checkCommand: failingCheckCommand }),
      buildMissedJob({ threadId: idleTopicThreadId, name: idleHeartbeatName, prompt: idleHeartbeatPrompt }),
    ];
    missedJobIds = Object.fromEntries(missedJobs.map((job) => [job.name, job.id]));
    // Before the fix this start never got ready: the boot waited for the first catch-up's delivery, which waits for the agent.
    await restartWithMissedRuns(missedJobs);
    assert.ok(getCharness().output.includes(launchLine), 'the polling was launched');
  });

  it('the idle topic\'s catch-up is not held by them: announced, delivered and booked while the question is still open', async () => {
    const [missedNotePrefix] = enDict['schedule.missedNote'].split('{time}');
    await idleTopic.waitForMessage('the idle heartbeat\'s catch-up announcement', (message) =>
      message.text.includes(idleHeartbeatName) && message.text.includes(missedNotePrefix));
    await getCharness().waitFor('the idle topic\'s agent to get its prompt', agentTimeoutMs, () => getAgentPrompts(idleHeartbeatPrompt).length === 1);
    await getCharness().waitFor('the idle heartbeat to be booked', replyTimeoutMs, () => {
      const job = readPersistedJob(missedJobIds[idleHeartbeatName]);
      return job?.lastRunStatus === 'delivered' && (job.nextRunAt ?? 0) > Date.now();
    });

    // What waits stays waiting: the agent is busy with its question, so nothing of its topic's runs reached it yet.
    assert.deepEqual(getGivenAnswers(), [], 'the question is still open');
    assert.equal(getAgentPrompts(waitingHeartbeatPrompt).length, 0, 'the waiting topic\'s heartbeat has not reached its agent');
    assert.equal(getAgentPrompts(waitingWatchPrompt).length, 0, 'nor has the wake of its check');
    for (const name of [waitingHeartbeatName, waitingWatchName]) {
      const job = readPersistedJob(missedJobIds[name]);
      assert.ok(job, `${name} is stored`);
      assert.ok((job.nextRunAt ?? Infinity) < restartedAtMs, `${name} is not booked while its delivery waits`);
      assert.deepEqual(countCatchUpRecords(missedJobIds[name]), { begun: 1, ended: 0 }, `${name} is under way: one catch-up begun, none ended`);
    }
  });

  it('the operator is heard while those catch-ups wait: a command is answered, a typed option number answers the question', async () => {
    await waitingTopic.sendAndAwaitReply('/status', 'Folder:');
    const answersBefore = getGivenAnswers().length;
    fakeTelegram.pushOperatorMessage(waitingTopicThreadId, '1');
    await getCharness().waitFor('the agent to get the typed answer', agentTimeoutMs, () => getGivenAnswers().length > answersBefore);
  });

  it('the two held catch-ups then reach the agent once each, and every missed run is booked once, its next run ahead', async () => {
    await getCharness().waitFor('the heartbeat to reach the waiting topic\'s agent', heldCatchUpTimeoutMs, () => getAgentPrompts(waitingHeartbeatPrompt).length === 1);
    await getCharness().waitFor('the check\'s wake to reach the waiting topic\'s agent', heldCatchUpTimeoutMs, () => getAgentPrompts(waitingWatchPrompt).length === 1);
    const alertText = enDict['schedule.checkFired'].replace('{name}', waitingWatchName);
    assert.ok(waitingTopic.listMessages().some((message) => message.text.includes(alertText)), 'the failed check said so in its topic');

    for (const name of [waitingHeartbeatName, waitingWatchName, idleHeartbeatName]) {
      const jobId = missedJobIds[name];
      await getCharness().waitFor(`${name} to be booked`, heldCatchUpTimeoutMs, () => {
        const job = readPersistedJob(jobId);
        return job?.lastRunStatus === 'delivered' && (job.nextRunAt ?? 0) > Date.now();
      });
      assert.deepEqual(countCatchUpRecords(jobId), { begun: 1, ended: 1 }, `${name}: one catch-up for the one missed run`);
      assert.equal(readLedgerRuns(jobId).some((run) => run.kind === 'on-time'), false, `${name}: no other run fired`);
    }
    for (const prompt of [waitingHeartbeatPrompt, waitingWatchPrompt, idleHeartbeatPrompt]) {
      assert.equal(getAgentPrompts(prompt).length, 1, `${prompt} reached its agent exactly once`);
    }
  });
});
