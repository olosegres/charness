/**
 * @description «A request waits for its schedule» in a TELEGRAM topic, at PROCESS level: the BUILT charness against the fake Bot
 * API (`telegramE2e/fakeTelegram.ts`), the topic on the «Answers only» view (the one that has requests), with the fake `claude`
 * playing an orchestrator that arms the worker watch the way `charness-orchestration` tells it to — the REAL recipe
 * (`scheduler/workerWatch.ts`) on a REAL worker process (`sleep`) — and answers `progress`. One flow, in order:
 *
 *   boot → a topic bound, a Claude session started, the view set to answers only
 *   → the operator's message opens a request; the agent arms the watch and answers `progress`; the job is stored with that request
 *     (`requestId`)
 *   → the progress follow-up would be due 15 s after the note (this instance's window; production: 15 min) and the engine's sweep
 *     runs every 10 s: both pass, and the agent is NOT prompted — no follow-up, no reminder: it waits for its watch
 *   → the worker exits: the check fails and the agent IS woken by it (the scheduled run, which opens a request of its own); the agent
 *     moves on to the NEXT worker — arms its watch, cancels the old one: the new job is armed under the OPERATOR's request (the one it
 *     works on), not under the request the fire opened, so the operator's request still waits for it: nothing prods it
 *   → the second worker exits: the agent is woken again, cancels the watch and answers
 *
 * Before the rule, the engine reminded such an agent every 15 minutes whatever its watch said. Nothing leaves the machine: the Bot
 * API is on loopback and the agent is a fake. Everything the test starts is stopped in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import {
  fakeClaudeLogFileNames,
  fakeRearmWatchWakeMarker,
  fakeStatusWatchJobName,
  fakeStatusWatchTargetFileName,
  type FakeClaudePrompt,
  type FakeClaudeToolCall,
  type FakeClaudeTurn,
  type FakeStatusWatchTarget,
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
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';
import type { ScheduleRunRecord } from '../scheduler/runLedger';
import type { ScheduleRecord } from '../scheduler/types';
import type { OpenRequestState } from '../requests/types';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const topicThreadId = 152;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const topicFolder = 'wait-flow';
const launchLine = 'Launching Telegraf bot (long polling';
const msPerSecond = 1000;

const bootTimeoutMs = 60 * msPerSecond;
const replyTimeoutMs = 20 * msPerSecond;
const agentTimeoutMs = 60 * msPerSecond;
/** The watch runs every minute (the production minimum is five): a tick is up to a minute and a little away. */
const watchCronIntervalMs = 60 * msPerSecond;
const checkRunTimeoutMs = 2 * watchCronIntervalMs;
/** The follow-up a progress note gets after this long (production: 15 min) and the engine's sweep that would deliver it. */
const progressFollowUpMs = 15 * msPerSecond;
const requestSweepIntervalMs = 10 * msPerSecond;
/** Several follow-up windows and sweeps: a wrongly woken request shows within them. */
const quietObservationMs = 3 * progressFollowUpMs + 2 * requestSweepIntervalMs;

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let topic: TopicDriver;
let defaultTmuxSessionsBefore: string[] = [];
let worker: ChildProcess | null = null;
let nextWorker: ChildProcess | null = null;
let openRequestId = '';
let watchId = '';

function getLayout(): IsolatedInstanceLayout {
  if (!layout) throw new Error('the instance layout is not created yet');
  return layout;
}

function getCharness(): IsolatedCharness {
  if (!charness) throw new Error('charness is not started yet');
  return charness;
}

function removeInstanceSync(): void {
  worker?.kill('SIGKILL');
  nextWorker?.kill('SIGKILL');
  removeIsolatedInstanceSync(layout, charness);
}

function readFakeLog<TRecord>(fileName: string): TRecord[] {
  return readJsonLines<TRecord>(path.join(getLayout().fakeLogDir, fileName));
}

function getToolCalls(tool: string): FakeClaudeToolCall[] {
  return readFakeLog<FakeClaudeToolCall>(fakeClaudeLogFileNames.toolCalls).filter((call) => call.tool === tool);
}

/** Every user message the fake agent has read, in order. */
function getAgentPrompts(): FakeClaudePrompt[] {
  return readFakeLog<FakeClaudePrompt>(fakeClaudeLogFileNames.prompts);
}

function readState(): { schedules?: Record<string, ScheduleRecord>; openRequests?: Record<string, OpenRequestState> } {
  return JSON.parse(fs.readFileSync(path.join(getLayout().dataDir, 'state.json'), 'utf8'));
}

function readPersistedSchedules(): ScheduleRecord[] {
  return Object.values(readState().schedules ?? {});
}

function countFinishedRunsSince(sinceMs: number): number {
  return readJsonLines<ScheduleRunRecord>(path.join(getLayout().dataDir, 'scheduler-runs.jsonl'))
    .filter((run) => run.jobId === watchId && run.deliveredAt !== undefined && run.firedAt > sinceMs).length;
}

/** A real worker process with its run directory, named as the worker the fake agent's next watch is armed on. */
async function startNamedWorker(runDirName: string): Promise<ChildProcess> {
  const startedWorker = spawn('sleep', ['3600'], { stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => {
    startedWorker.once('spawn', resolve);
    startedWorker.once('error', reject);
  });
  const runDir = path.join(getLayout().testRoot, runDirName);
  fs.mkdirSync(runDir);
  fs.writeFileSync(path.join(runDir, 'events.jsonl'), `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'yarn test' } }] } })}\n`);
  const target: FakeStatusWatchTarget = { pid: startedWorker.pid ?? 0, runDir };
  assert.ok(target.pid > 0, 'the worker has a process id');
  fs.writeFileSync(path.join(getLayout().fakeStateDir, fakeStatusWatchTargetFileName), JSON.stringify(target));
  return startedWorker;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('A request waits for its schedule in a Telegram topic end to end: built charness, fake Bot API, a fake orchestrating agent, a real worker process', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-schedule-wait-', [topicFolder], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

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
      // A free port nothing listens on: the boot's OpenCode pre-start finds no server and no binary, and gives up.
      OPENCODE_URL: `http://127.0.0.1:${await getUnservedPort()}`,
      SCHEDULER_MCP_PORT: (await getFreeFixedPort()).toString(),
      // A watch every minute; the progress follow-up and the engine's sweep in seconds, so a wrongly woken request shows quickly.
      ...getTelegramFlowTestTimingsEnv({ scheduleMinFireIntervalMs: watchCronIntervalMs, progressFollowUpMs, requestSweepIntervalMs }),
    });
  });

  after(async () => {
    worker?.kill('SIGKILL');
    nextWorker?.kill('SIGKILL');
    await charness?.stop();
    removeInstanceSync();
    await fakeTelegram?.stop();
    process.off('exit', removeInstanceSync);
    process.off('SIGINT', exitOnSignal);
    process.off('SIGTERM', exitOnSignal);
    assert.deepEqual(listTmuxSessions([]), defaultTmuxSessionsBefore, 'the default tmux server was not touched');
  });

  it('boots, binds the topic, starts a Claude session and turns the view to answers only (the view that has requests)', async () => {
    charness = new IsolatedCharness(getLayout());
    const pollsBefore = fakeTelegram.listCalls('getUpdates').length;
    await charness.start(bootTimeoutMs, (runOutput) => runOutput.includes(launchLine) && fakeTelegram.listCalls('getUpdates').length > pollsBefore);
    await topic.sendAndAwaitReply(`/bind ${topicFolder}`, `Bound to \`${topicFolder}\``);
    await topic.sendAndAwaitReply('/claude', 'ready in');
    await topic.sendAndAwaitReply('/verbosity answers', 'This topic shows: Answers only');
  });

  it('the agent arms the watch on a running worker and answers `progress`; the job is stored with the request the operator\'s message opened', async () => {
    worker = await startNamedWorker('worker-run');

    fakeTelegram.pushOperatorMessage(topicThreadId, `W-1 [fake:watch-progress] ${fakeRearmWatchWakeMarker} watch the builder you just launched`);
    await getCharness().waitFor('the agent to arm the watch and answer progress', agentTimeoutMs, () =>
      getToolCalls('schedule_create').length === 1 && readFakeLog<{ kind: string }>(fakeClaudeLogFileNames.answers).some((answer) => answer.kind === 'progress'));
    const [created] = getToolCalls('schedule_create');
    assert.doesNotMatch(created.outcome, /^error:/, created.outcome);
    const [turn] = readFakeLog<FakeClaudeTurn>(fakeClaudeLogFileNames.turns);
    openRequestId = turn.requestId ?? '';
    assert.match(openRequestId, /^req_/, 'the operator\'s message opened a request: the view has requests');
    await getCharness().waitFor('the watch to be persisted', replyTimeoutMs, () => readPersistedSchedules().some((record) => record.name === fakeStatusWatchJobName));
    const watch = readPersistedSchedules().find((record) => record.name === fakeStatusWatchJobName);
    assert.ok(watch);
    watchId = watch.id;
    assert.equal(watch.requestId, openRequestId, 'armed under the request that was open');
    assert.ok(readState().openRequests && Object.values(readState().openRequests ?? {}).some((request) => request.id === openRequestId), 'the request is still open after a progress note');
  });

  let promptsAfterArming = 0;

  it('the follow-up window and several sweeps pass while the watch passes: the agent is not prompted — no follow-up, no reminder — and the request is not given up', async () => {
    promptsAfterArming = getAgentPrompts().length;
    const observedFromMs = Date.now();
    await getCharness().waitFor('a run of the watch to finish', checkRunTimeoutMs, () => countFinishedRunsSince(observedFromMs) >= 1);
    await sleep(quietObservationMs);

    assert.equal(getAgentPrompts().length, promptsAfterArming, 'nothing woke the agent: without the rule a follow-up would be due 15 s after the progress note');
    assert.ok(!getAgentPrompts().some((prompt) => prompt.text.includes('[Reminder · request')), 'no reminder of any reason');
    const request = Object.values(readState().openRequests ?? {}).find((open) => open.id === openRequestId);
    assert.ok(request, 'the request is still open');
    assert.equal(request.nextWakeAt, undefined, 'a progress note under a watch schedules no follow-up');
    assert.equal(request.wakeCount, 0);
    assert.equal(request.isWakeStopped, false);
  });

  let promptsAfterWake = 0;
  let nextWatchId = '';

  it('the worker exits: the agent is woken by the failed check and moves on to the next worker — its watch is armed under the OPERATOR\'s request, not under the request the fire opened', async () => {
    nextWorker = await startNamedWorker('worker-next-run');
    worker?.kill('SIGKILL');
    await getCharness().waitFor('the failed check to wake the agent', checkRunTimeoutMs, () => getAgentPrompts().length > promptsAfterArming);
    const wakePrompt = getAgentPrompts()[promptsAfterArming].text;
    assert.ok(wakePrompt.includes(`[Scheduled check "${fakeStatusWatchJobName}" failed]`), wakePrompt);
    assert.ok(wakePrompt.includes('tells the topic when it passes again'), 'a topic keeps its own wording');
    const wakeRequestId = wakePrompt.match(/req_[A-Za-z0-9_-]+/)?.[0] ?? '';
    assert.notEqual(wakeRequestId, openRequestId, 'the fire opened a request of its own, as in any topic with requests');
    await getCharness().waitFor('the agent to arm the next watch and cancel the old one', agentTimeoutMs, () =>
      getToolCalls('schedule_create').length === 2 && getToolCalls('schedule_cancel').length === 1);
    await getCharness().waitFor('the persisted jobs to be the next watch alone', replyTimeoutMs, () => {
      const watches = readPersistedSchedules().filter((record) => record.name === fakeStatusWatchJobName);
      return watches.length === 1 && watches[0].id !== watchId;
    });
    const nextWatch = readPersistedSchedules().find((record) => record.name === fakeStatusWatchJobName);
    assert.ok(nextWatch);
    nextWatchId = nextWatch.id;
    assert.equal(nextWatch.requestId, openRequestId, 'armed under the request the operator\'s message opened — the one the agent works on — not under the scheduler\'s');
    promptsAfterWake = getAgentPrompts().length;
  });

  it('the operator\'s request still waits for the next watch: the follow-up window and several sweeps pass and nothing prods the agent', async () => {
    await sleep(quietObservationMs);
    assert.equal(getAgentPrompts().length, promptsAfterWake, 'no follow-up and no reminder: the request waits for the watch that replaced the first');
    const request = Object.values(readState().openRequests ?? {}).find((open) => open.id === openRequestId);
    assert.ok(request, 'the operator\'s request is still open');
    assert.equal(request.isWakeStopped, false);
    assert.equal(request.wakeCount, 0);
  });

  it('the second worker exits: the agent is woken again, cancels the watch and answers', async () => {
    watchId = nextWatchId;
    nextWorker?.kill('SIGKILL');
    await getCharness().waitFor('the failed check to wake the agent again', checkRunTimeoutMs, () => getAgentPrompts().length > promptsAfterWake);
    await getCharness().waitFor('the agent to cancel the watch', agentTimeoutMs, () => getToolCalls('schedule_cancel').length === 2);
    await getCharness().waitFor('the watch to be gone from the persisted state', replyTimeoutMs, () => readPersistedSchedules().every((record) => record.name !== fakeStatusWatchJobName));
  });
});
