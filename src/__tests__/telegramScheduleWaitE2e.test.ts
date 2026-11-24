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
 *   → the worker exits: the check fails and the agent IS woken by it — the scheduled run RIDES the operator's request its watch was
 *     armed under (the header names it; no request of its own is opened, `src/requests/README.md` § Scheduled runs); the agent moves on
 *     to the NEXT worker — arms its watch, cancels the old one, answers `progress`: the new job is armed under the operator's request,
 *     which still waits for it: nothing prods it
 *   → the second worker exits: the agent is woken again behind the same request, cancels the watch and answers it `final`
 *   → a one-shot armed under an operator's request that is finished when it fires: with nothing to ride the fire opens the scheduler's
 *     request, the agent has NOTHING to report and says nothing — the request closes silently: no reminder, no «got no answer» alert
 *   → another such one-shot whose fire finds the deploy broken: it opens the scheduler's request, launches the fix, arms its watch —
 *     armed under the scheduler's request, whose fire started the turn — and answers it `progress` (the operator is told «working on it»)
 *   → that worker exits: the watch's fire RIDES the scheduler's request instead of replacing it; the agent restarts the worker and says
 *     nothing — the turn is quiet, as on a Jira hand-over: no reminder, no alert, and the request the operator was told about stays open
 *   → the topic runs per-turn and a message arrives while the process stops after a turn: it is buffered and replayed after the resume.
 *     Nothing decides its turn before the agent took it in — no reminder while the agent works on it — and its one silent turn,
 *     decided at the turn's own end although the stop follows it at once, gets ONE reminder, then the answer: no give-up
 *   → still per-turn: a one-shot fires while the agent works on the operator's message, and its post waits for that turn, which ends
 *     silent. The fire is written first and starts the next turn; the operator's reminder follows it. So the watch the agent arms in
 *     that turn is the fire's request's, not the reminded one's
 *   → «wait for reset» off: a request's reminder turn ends on a usage limit. The bot answers the request and stops waking it before
 *     that turn is decided: it is no second silent turn — no reminder into the limit, no «got no answer»
 *   → still per turn: a turn ends in an error the bot does not classify while the operator's next message waits behind it. The CLI runs
 *     that message as its next turn (measured on 2.1.330), so the process is not stopped and nothing decides its turn before it ran:
 *     it is answered in the same process, with no reminder and no give-up
 *   → still per turn: a file the operator sends while the process stops after a turn, whose download lasts past the stop's end. The
 *     window it arrived in is closed by the time its prompt is written: the prompt is routed then, so it wakes the sleeping session and
 *     gets its own turn — no reminder (in the answers view) — and in the stream view, which opens no request, it reaches the agent too
 *   → a second Claude account, the idle lifecycle: the operator moves the topic to it while the agent works, and that turn ends silent.
 *     The switch re-spawns the process onto the new account right after the turn, and the turn's reminder waits for that re-spawn:
 *     one launch, nothing started beside it, the reminder in the new process
 *   → per turn, right after it (so no per-turn step's leftovers share its windows): a first message that waits behind the stop, whose
 *     «queued» notice the Bot API holds until the next stop: it is watched before its replay, not after the notice — its silent turn
 *     is counted while the notice is still held and reminded at once (the late watch was made in the next stop's window, named no
 *     process and waited for good); the step ends once the conversation sleeps again
 *   → per turn: an account picked while a turn works is applied by the per-turn stop at that turn's end, never by a re-spawn beside
 *     it: a message the stop holds reaches the next process, on the new account — once, its request answered, no re-spawn
 *   → per turn, a message the stop holds and then `/quit`: the stop starts nothing for it — no process is launched, the agent never gets
 *     it, its request is closed and the operator is told to send it again
 *   → per turn again: a one-shot fire resumes the sleeping conversation, and the CLI refuses the resume slowly; a message the operator
 *     sends meanwhile waits in the resume's window. The bot starts a fresh session instead, and the message reaches it in a turn of its
 *     own — no reminder of a request whose words the agent never got
 *   → the same, and the fresh start fails too: the message reaches no agent, its request closes, and the operator is told to send it
 *     again
 *
 * Before the rule, the engine reminded such an agent every 15 minutes whatever its watch said; before the scheduled-run model, every
 * fire opened a request that replaced the previous fire's, and an answered one's «working on it» was lost or chased. Nothing leaves the
 * machine: the Bot API is on loopback and the agent is a fake. Everything the test starts is stopped in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram, generalTopicThreadId } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import {
  fakeClaudeLogFileNames,
  fakeClaudeApiErrorDelayFileName,
  fakeClaudeApiErrorOnceFileName,
  fakeClaudeExitFlushDelayFileName,
  fakeClaudeLaunchDelayFileName,
  fakeClaudeHoldReleaseFileName,
  fakeClaudeLaunchRefusalDelayFileName,
  fakeClaudeRefuseLaunchFileName,
  fakeOneShotDelaySeconds,
  fakeScheduleOnceToken,
  getFakeClaudeUnrestorableConversationFileName,
  getLaunchSessionId,
  fakeOneShotNextWatchIssueKey,
  fakeOneShotNextWatchMarker,
  fakeOneShotSilentMarker,
  fakeOneShotWatchIssueKey,
  fakeOneShotWatchMarker,
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
import { bindLeaveCurrentCallback } from '../connectors/telegram/bindPicker';
import { checkIsProcessAlive } from './recordedProcess';
import { getAccountConfigDir, getSessionLaunches, restartCharnessWithState } from './e2e/fallbackFlowKit';
import { createClaudeProfileLayout } from '../utils/claudeProfiles';
import type { ScheduleRunRecord } from '../scheduler/runLedger';
import type { ScheduleRecord } from '../scheduler/types';
import type { ClosedRequestRecord, OpenRequestState } from '../requests/types';

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
/** How long the fake process takes to exit when the per-turn stop asks it to: the stop's window stays open that long. */
const perTurnStopHoldMs = 8 * msPerSecond;
/** How long the fake takes to start a session in the step that lands /quitall inside a wake: well past /quitall's own handling. */
const slowLaunchMs = 8 * msPerSecond;
/** One send pacer interval and a margin: a line already on its way is in the topic after it. */
const pacerSettleMs = 5 * msPerSecond;
/** How long after its arming the run of the leave step comes due: after the tap, while the leave is held. */
const runInLeaveDelaySeconds = 15;
/** How long past the run's due time the leave's toast is held: the run fires, and its post waits, inside the leave. */
const leaveHoldPastFireMs = 4 * msPerSecond;
/** What a person is told when a command that ends or replaces the conversation dropped their message (not «while it was starting»). */
const endingCommandDropLine = 'this conversation was ended or switched before the agent read it';
/** A buffered message's way to its answer: the stop, the resume, the held turn, the stop again, the reminder's resume and turn. */
const bufferedFlowTimeoutMs = 3 * 60 * msPerSecond;
/** Past a job's own instant its fire's post has started (the engine's timer delivers at once): a post behind a running turn waits. */
const firePostStartMarginMs = 5 * msPerSecond;
/** A usage limit the fake ends a turn on: the CLI's own wording, read as a confirmed limit (no probe retry is armed for it). */
const usageLimitErrorText = "You've hit your session limit · resets 11:00pm";
/** An error result the bot classifies as no API error (`classifyAgentApiError` → null): nothing holds the turn end. */
const unclassifiedErrorText = 'The agent runner stopped unexpectedly';
/** How long the turn that ends in that error runs first: the operator's next message is written into it meanwhile. */
const failingTurnRunMs = 6 * msPerSecond;
/** The `slow-once` turn of the message queued behind it works this long in silence (the fake's default) before it answers. */
const slowTurnTimeoutMs = 2 * 60 * msPerSecond;
/**
 * How long the fake takes to refuse a resume or a start in the failed-resume steps: a message lands inside that window. Under the
 * adapter's 15 s initialize handshake, after which a start that has not answered is taken as up.
 */
const launchRefusalDelayMs = 10 * msPerSecond;
/** The size of the file whose download the per-turn file steps hold. */
const heldFileBytes = 64;
/** A one-shot armed `fakeOneShotDelaySeconds` ahead fires within this (the engine's timer, the post and the turn). */
const oneShotFireTimeoutMs = (fakeOneShotDelaySeconds + 60) * msPerSecond;
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
let thirdWorker: ChildProcess | null = null;
let fourthWorker: ChildProcess | null = null;
const schedulerRequester = 'scheduler';
/** The second Claude account the last step moves the topic to. */
const secondAccount = 'second';
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
  thirdWorker?.kill('SIGKILL');
  fourthWorker?.kill('SIGKILL');
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

/** The request history (`DATA_DIR/requests.jsonl`): every request that closed, and why. */
function readClosedRequests(): ClosedRequestRecord[] {
  return readJsonLines<ClosedRequestRecord>(path.join(getLayout().dataDir, 'requests.jsonl'));
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

/** How many times the bot's output has `line` so far. */
function countOutputLines(line: string): number {
  return getCharness().output.split(line).length - 1;
}

/** How many of the topic's messages so far carry `text`. */
function countTopicMessages(text: string): number {
  return topic.listMessages().filter((message) => message.text.includes(text)).length;
}

/**
 * A per-turn topic: a warm-up turn ends and its stop is held open (the fake waits `perTurnStopHoldMs` before it exits); the operator
 * sends a file inside that window, and its download is held until the stop has ended. So the window the file ARRIVED in is closed
 * by the time its prompt is written, and the conversation sleeps. Resolves once the download was released.
 */
async function sendFileAcrossThePerTurnStop(warmUpIssueKey: string, fileIssueKey: string): Promise<void> {
  const topicKeyString = `${group.id}:${topicThreadId}`;
  const stopLine = `[compact-on-idle] ${topicKeyString} stopping the idle process`;
  const stoppedLine = `[compact-on-idle] ${topicKeyString} process stopped`;
  const exitFlushDelayPath = path.join(getLayout().fakeStateDir, fakeClaudeExitFlushDelayFileName);
  fs.writeFileSync(exitFlushDelayPath, perTurnStopHoldMs.toString());
  const releaseDownloads = fakeTelegram.holdFileDownloads();
  try {
    const stopsBefore = countOutputLines(stopLine);
    const stoppedBefore = countOutputLines(stoppedLine);
    fakeTelegram.pushOperatorMessage(topicThreadId, `${warmUpIssueKey} [fake:answer] warm up the per-turn session`);
    await getCharness().waitFor('the per-turn stop after the warm-up turn', bufferedFlowTimeoutMs, () => countOutputLines(stopLine) > stopsBefore);
    const fileId = `file-${fileIssueKey.toLowerCase()}`;
    fakeTelegram.registerFile(fileId, Buffer.alloc(heldFileBytes, 5));
    fakeTelegram.pushOperatorFile(topicThreadId, 'document', fileId, { fileName: 'notes.txt', caption: `${fileIssueKey} [fake:answer] a file sent while the process stops` });
    await getCharness().waitFor('the file\'s download to begin', replyTimeoutMs, () => fakeTelegram.getHeldFileDownloadCount() > 0);
    assert.equal(countOutputLines(stoppedLine), stoppedBefore, 'the stop is still under way: the file arrived inside its window');
    await getCharness().waitFor('the stop to end while the download is held', bufferedFlowTimeoutMs, () => countOutputLines(stoppedLine) > stoppedBefore);
  } finally {
    releaseDownloads();
    fs.rmSync(exitFlushDelayPath, { force: true });
  }
}

/** Every user message the fake agent read that carries `text`. */
function getAgentPromptsWith(text: string): FakeClaudePrompt[] {
  return getAgentPrompts().filter((prompt) => prompt.text.includes(text));
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
    thirdWorker?.kill('SIGKILL');
    fourthWorker?.kill('SIGKILL');
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

    fakeTelegram.pushOperatorMessage(topicThreadId, `WA-1 [fake:watch-progress] ${fakeRearmWatchWakeMarker} watch the builder you just launched`);
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

  it('the worker exits: the agent is woken by the failed check RIDING the operator\'s request — no request of its own — and moves on to the next worker, armed under that request', async () => {
    nextWorker = await startNamedWorker('worker-next-run');
    worker?.kill('SIGKILL');
    await getCharness().waitFor('the failed check to wake the agent', checkRunTimeoutMs, () => getAgentPrompts().length > promptsAfterArming);
    const wakePrompt = getAgentPrompts()[promptsAfterArming].text;
    assert.ok(wakePrompt.includes(`[Scheduled check "${fakeStatusWatchJobName}" failed]`), wakePrompt);
    assert.ok(wakePrompt.includes('tells the topic when it passes again'), 'a topic keeps its own wording');
    assert.ok(wakePrompt.includes(`[Scheduled run "${fakeStatusWatchJobName}" · request ${openRequestId} is open]`), 'the fire rides the request its watch was armed under');
    assert.ok(!wakePrompt.includes('[Request req_'), 'no request of its own was opened');
    await getCharness().waitFor('the agent to arm the next watch and cancel the old one', agentTimeoutMs, () =>
      getToolCalls('schedule_create').length === 2 && getToolCalls('schedule_cancel').length === 1);
    await getCharness().waitFor('the persisted jobs to be the next watch alone', replyTimeoutMs, () => {
      const watches = readPersistedSchedules().filter((record) => record.name === fakeStatusWatchJobName);
      return watches.length === 1 && watches[0].id !== watchId;
    });
    const nextWatch = readPersistedSchedules().find((record) => record.name === fakeStatusWatchJobName);
    assert.ok(nextWatch);
    nextWatchId = nextWatch.id;
    assert.equal(nextWatch.requestId, openRequestId, 'armed under the request the operator\'s message opened — the one the fire rode');
    await getCharness().waitFor('the progress note to the operator\'s request', agentTimeoutMs, () =>
      Object.values(readState().openRequests ?? {}).find((open) => open.id === openRequestId)?.progressAnswerCount === 2);
    assert.ok(!Object.values(readState().openRequests ?? {}).some((open) => open.origin.attributes.requester === schedulerRequester), 'no scheduler\'s request is open');
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

  it('the second worker exits: the agent is woken again behind the same request, cancels the watch and answers it `final`', async () => {
    watchId = nextWatchId;
    nextWorker?.kill('SIGKILL');
    await getCharness().waitFor('the failed check to wake the agent again', checkRunTimeoutMs, () => getAgentPrompts().length > promptsAfterWake);
    assert.ok(getAgentPrompts()[promptsAfterWake].text.includes(`request ${openRequestId} is open]`), 'it rides the operator\'s request again');
    await getCharness().waitFor('the agent to cancel the watch', agentTimeoutMs, () => getToolCalls('schedule_cancel').length === 2);
    await getCharness().waitFor('the watch to be gone from the persisted state', replyTimeoutMs, () => readPersistedSchedules().every((record) => record.name !== fakeStatusWatchJobName));
    await getCharness().waitFor('the operator\'s request to close with the result', agentTimeoutMs, () =>
      readClosedRequests().some((closed) => closed.id === openRequestId));
    assert.equal(readClosedRequests().find((closed) => closed.id === openRequestId)?.closeReason, 'final', 'the result is the answer to the operator\'s own request');
  });

  /** Arm a one-shot under an operator's request the agent then answers `final`: the request is finished when the job fires. */
  async function armOneShotUnderFinishedRequest(issueKey: string, marker: string): Promise<number> {
    const createsBefore = getToolCalls('schedule_create').length;
    fakeTelegram.pushOperatorMessage(topicThreadId, `${issueKey} [fake:one-shot-then-final] ${marker} check the deploy in a moment`);
    await getCharness().waitFor('the agent to arm the one-shot', agentTimeoutMs, () => getToolCalls('schedule_create').length === createsBefore + 1);
    await getCharness().waitFor('the operator\'s request to be answered `final`', agentTimeoutMs, () =>
      readFakeLog<{ issueKey: string; kind: string }>(fakeClaudeLogFileNames.answers).some((answer) => answer.issueKey === issueKey && answer.kind === 'final'));
    return getAgentPrompts().length;
  }

  it('a one-shot whose request is finished when it fires, with nothing to report: the fire opens the scheduler\'s request and the agent says nothing — closed silently, no reminder, no alert', async () => {
    const promptsBeforeFire = await armOneShotUnderFinishedRequest('WB-2', fakeOneShotSilentMarker);
    await getCharness().waitFor('the one-shot to wake the agent', oneShotFireTimeoutMs, () => getAgentPrompts().length > promptsBeforeFire);
    const firePrompt = getAgentPrompts()[promptsBeforeFire].text;
    const fireRequestId = /\[Request (req_[A-Za-z0-9_-]+) · from: a scheduled run in this topic\]/.exec(firePrompt)?.[1] ?? '';
    assert.match(fireRequestId, /^req_/, `nothing to ride: the fire opened the scheduler's request\n${firePrompt}`);
    assert.ok(firePrompt.includes(`Answer it through answer_request (requestId "${fireRequestId}") only when you have a result the requester needs.`), 'the scheduler\'s request asks for an answer only with a result');
    assert.ok(!firePrompt.includes('kind "final" with the full result at the end of your turn'), 'not the «final at the end of every turn» of a person\'s request: every answer here is pinned, which notifies');

    await sleep(quietObservationMs);
    assert.equal(getAgentPrompts().length, promptsBeforeFire + 1, 'no reminder: the fire was the only prompt');
    assert.ok(!topic.listMessages().some((message) => message.text.includes('got no answer')), 'no «got no answer» alert in the topic');
    assert.deepEqual(Object.values(readState().openRequests ?? {}).map((open) => open.id), [], 'the scheduler\'s request nobody was told about closed silently');
    assert.equal(readClosedRequests().find((closed) => closed.id === fireRequestId)?.closeReason, 'cancelled', 'closed without an answer, nothing posted');
  });

  let schedulerRequestId = '';

  it('a one-shot whose fire finds the deploy broken: the scheduler\'s request it opens gets the fix\'s watch (its fire started the turn) and a `progress` note', async () => {
    thirdWorker = await startNamedWorker('worker-third-run');
    const promptsBeforeFire = await armOneShotUnderFinishedRequest('WC-3', fakeOneShotWatchMarker);
    await getCharness().waitFor('the one-shot to wake the agent', oneShotFireTimeoutMs, () => getAgentPrompts().length > promptsBeforeFire);
    schedulerRequestId = /\[Request (req_[A-Za-z0-9_-]+) · from: a scheduled run in this topic\]/.exec(getAgentPrompts()[promptsBeforeFire].text)?.[1] ?? '';
    assert.match(schedulerRequestId, /^req_/);
    await getCharness().waitFor('the fix\'s watch to be persisted', replyTimeoutMs, () => readPersistedSchedules().some((record) => record.name === fakeStatusWatchJobName));
    const watch = readPersistedSchedules().find((record) => record.name === fakeStatusWatchJobName);
    assert.equal(watch?.requestId, schedulerRequestId, 'armed under the request the alarm that started the turn rides');
    await getCharness().waitFor('the `progress` note to the scheduler\'s request', agentTimeoutMs, () =>
      readFakeLog<{ requestId: string; kind: string }>(fakeClaudeLogFileNames.answers).some((answer) => answer.requestId === schedulerRequestId && answer.kind === 'progress'));
    assert.ok(Object.values(readState().openRequests ?? {}).some((open) => open.id === schedulerRequestId), 'answered `progress`: it stays open');
    assert.ok(readFakeLog<FakeClaudeTurn>(fakeClaudeLogFileNames.turns).some((turn) => turn.issueKey === fakeOneShotWatchIssueKey));
  });

  it('that worker exits: the watch\'s fire RIDES the scheduler\'s request it was armed under; the agent says nothing — quiet: no reminder, no alert, and the request the operator was told about stays open', async () => {
    const promptsBeforeWake = getAgentPrompts().length;
    thirdWorker?.kill('SIGKILL');
    await getCharness().waitFor('the failed check to wake the agent', checkRunTimeoutMs, () => getAgentPrompts().length > promptsBeforeWake);
    const wakePrompt = getAgentPrompts()[promptsBeforeWake].text;
    assert.ok(wakePrompt.includes(`[Scheduled run "${fakeStatusWatchJobName}" · request ${schedulerRequestId} is open]`), wakePrompt);
    assert.ok(!wakePrompt.includes('[Request req_'), 'no new request replaces the one the operator was told about');

    await sleep(quietObservationMs);
    assert.equal(getAgentPrompts().length, promptsBeforeWake + 1, 'no reminder: the agent that handled the alarm is not silent');
    assert.ok(!topic.listMessages().some((message) => message.text.includes('got no answer')), 'no «got no answer» alert in the topic');
    const request = Object.values(readState().openRequests ?? {}).find((open) => open.id === schedulerRequestId);
    assert.ok(request, 'still open: «working on it» is not closed silently');
    assert.equal(request.wakeCount, 0);
    assert.equal(request.isWakeStopped, false);
  });

  it('per-turn: a message that arrives while the process stops after a turn is buffered and replayed — no reminder before the agent took it in; its one silent turn gets ONE reminder, not the give-up (review 15 #1 and P1)', async () => {
    const topicKeyString = `${group.id}:${topicThreadId}`;
    await topic.sendAndAwaitReply('/claude_mode per-turn', 'Switched to 🔁 Per-turn');
    // The fake waits this long before it exits at the stop: the stop's startup window stays open, so a message lands in it.
    fs.writeFileSync(path.join(getLayout().fakeStateDir, fakeClaudeExitFlushDelayFileName), perTurnStopHoldMs.toString());
    try {
      const stopLine = `[compact-on-idle] ${topicKeyString} stopping the idle process`;
      const stopsBefore = getCharness().output.split(stopLine).length - 1;
      fakeTelegram.pushOperatorMessage(topicThreadId, 'WE-5 [fake:answer] warm up the per-turn session');
      await getCharness().waitFor('the per-turn stop after the warm-up turn', bufferedFlowTimeoutMs, () => getCharness().output.split(stopLine).length - 1 > stopsBefore);

      fakeTelegram.pushOperatorMessage(topicThreadId, 'WF-6 [fake:hold-silent-once] a question while it stops');
      await getCharness().waitFor('the message to be queued behind the stop', replyTimeoutMs, () => topic.listMessages().some((message) => message.text.includes('your message is queued')));
      await getCharness().waitFor('the agent to take the replayed message in', bufferedFlowTimeoutMs, () => readFakeLog<FakeClaudeTurn>(fakeClaudeLogFileNames.turns).some((turn) => turn.issueKey === 'WF-6'));
      const bufferedRequestId = readFakeLog<FakeClaudeTurn>(fakeClaudeLogFileNames.turns).find((turn) => turn.issueKey === 'WF-6')?.requestId ?? '';
      assert.match(bufferedRequestId, /^req_/);
      // The agent works on it (its turn is held): nothing may have decided that turn yet.
      await sleep(2 * requestSweepIntervalMs);
      const whileWorking = Object.values(readState().openRequests ?? {}).find((open) => open.id === bufferedRequestId);
      assert.ok(whileWorking, 'still open while the agent works on it');
      assert.equal(whileWorking.silentTurnCount, 0, 'no silent turn decided before the agent took the message in');
      assert.equal(whileWorking.wakeCount, 0, 'no reminder written before its turn');

      const remindersOf = (): number => getAgentPrompts().filter((prompt) => prompt.text.includes(`[Reminder · request ${bufferedRequestId} is still open]`)).length;
      assert.equal(remindersOf(), 0);
      // The turn ends with no answer; the per-turn stop follows at once.
      fs.writeFileSync(path.join(getLayout().fakeStateDir, fakeClaudeHoldReleaseFileName), '');
      await getCharness().waitFor('the request to be answered after its reminder', bufferedFlowTimeoutMs, () => readClosedRequests().some((closed) => closed.id === bufferedRequestId));
      assert.equal(readClosedRequests().find((closed) => closed.id === bufferedRequestId)?.closeReason, 'final');
      assert.equal(remindersOf(), 1, 'ONE reminder for the one silent turn — decided at the turn\'s end, not lost to the stop');
      assert.ok(!topic.listMessages().some((message) => message.text.includes('got no answer')), 'no give-up');
    } finally {
      fs.rmSync(path.join(getLayout().fakeStateDir, fakeClaudeExitFlushDelayFileName), { force: true });
    }
  });

  it('per-turn: a fire whose post waited behind the operator\'s silent turn starts the next turn and the operator\'s reminder follows it — the watch the agent arms in that turn is the fire\'s request\'s (review 16 #2)', async () => {
    // A clean slate: the scheduler's request of the earlier steps closes, so this fire opens a request of its own.
    fakeTelegram.pushOperatorMessage(topicThreadId, '/esc');
    await getCharness().waitFor('every open request to close', replyTimeoutMs, () => Object.keys(readState().openRequests ?? {}).length === 0);
    fourthWorker = await startNamedWorker('worker-fourth-run');
    const watchIdsBefore = new Set(readPersistedSchedules().map((record) => record.id));
    await armOneShotUnderFinishedRequest('WG-7', fakeOneShotNextWatchMarker);
    const fireAt = getToolCalls('schedule_create').filter((call) => call.issueKey === 'WG-7').at(-1)?.args.onceAt;
    assert.equal(typeof fireAt, 'string', 'the one-shot names its instant');

    fakeTelegram.pushOperatorMessage(topicThreadId, 'WH-8 [fake:hold-silent-then-progress] a question that keeps the agent busy');
    await getCharness().waitFor('the agent to work on the operator\'s message', agentTimeoutMs, () => readFakeLog<FakeClaudeTurn>(fakeClaudeLogFileNames.turns).some((turn) => turn.issueKey === 'WH-8'));
    const operatorRequestId = readFakeLog<FakeClaudeTurn>(fakeClaudeLogFileNames.turns).find((turn) => turn.issueKey === 'WH-8')?.requestId ?? '';
    assert.match(operatorRequestId, /^req_/);
    // The one-shot fires while that turn runs: its post waits for the turn.
    await sleep(Math.max(Date.parse(fireAt?.toString() ?? '') + firePostStartMarginMs - Date.now(), 0));
    const isFirePrompt = (prompt: FakeClaudePrompt): boolean => prompt.text.includes(fakeOneShotNextWatchIssueKey);
    assert.ok(!getAgentPrompts().some(isFirePrompt), 'the fire waits behind the running turn');

    // The operator's turn ends with no answer; the per-turn stop follows at once and is held open for a while, so the waiting post
    // sees the session idle and goes on while the stop runs: the fire and the operator's reminder both queue behind the stop.
    const exitFlushDelayPath = path.join(getLayout().fakeStateDir, fakeClaudeExitFlushDelayFileName);
    fs.writeFileSync(exitFlushDelayPath, perTurnStopHoldMs.toString());
    try {
      fs.writeFileSync(path.join(getLayout().fakeStateDir, fakeClaudeHoldReleaseFileName), '');
      await getCharness().waitFor('the watch the fire\'s turn arms', bufferedFlowTimeoutMs, () =>
        readPersistedSchedules().some((record) => record.name === fakeStatusWatchJobName && !watchIdsBefore.has(record.id)));
    } finally {
      fs.rmSync(exitFlushDelayPath, { force: true });
    }
    const prompts = getAgentPrompts();
    const firePromptIndex = prompts.findIndex(isFirePrompt);
    const fireRequestId = /\[Request (req_[A-Za-z0-9_-]+) · from: a scheduled run in this topic\]/.exec(prompts[firePromptIndex]?.text ?? '')?.[1] ?? '';
    assert.match(fireRequestId, /^req_/, 'with nothing to ride, the fire opened the scheduler\'s request');
    const watch = readPersistedSchedules().find((record) => record.name === fakeStatusWatchJobName && !watchIdsBefore.has(record.id));
    assert.equal(watch?.requestId, fireRequestId, 'armed under the request whose fire started the turn — not the reminded operator\'s request');

    await getCharness().waitFor('the operator\'s request to be answered after its reminder and follow-up', bufferedFlowTimeoutMs, () => readClosedRequests().some((closed) => closed.id === operatorRequestId));
    const reminderIndex = getAgentPrompts().findIndex((prompt) => prompt.text.includes(`[Reminder · request ${operatorRequestId} is still open]`));
    assert.ok(reminderIndex > firePromptIndex, `the waited fire was written first and the reminder followed it (fire ${firePromptIndex}, reminder ${reminderIndex})`);
    assert.ok(!topic.listMessages().some((message) => message.text.includes('got no answer')), 'no give-up');
  });

  it('«wait for reset» off: a reminder\'s turn that ends on a usage limit is no second silent turn — the bot answers the request and stops waking it first: no reminder into the limit, no «got no answer» (review 16 #1)', async () => {
    await topic.sendAndAwaitReply('/auto_continue_limits off', 'Auto-resume after a usage limit: OFF for this topic');
    const apiErrorOncePath = path.join(getLayout().fakeStateDir, fakeClaudeApiErrorOnceFileName);
    try {
      fakeTelegram.pushOperatorMessage(topicThreadId, 'WJ-10 [fake:hold-silent-once] a request whose agent goes quiet once');
      await getCharness().waitFor('the agent to work on the request', agentTimeoutMs, () => readFakeLog<FakeClaudeTurn>(fakeClaudeLogFileNames.turns).some((turn) => turn.issueKey === 'WJ-10'));
      const requestId = readFakeLog<FakeClaudeTurn>(fakeClaudeLogFileNames.turns).find((turn) => turn.issueKey === 'WJ-10')?.requestId ?? '';
      assert.match(requestId, /^req_/);
      // Its first turn ends silent and is reminded; the reminder's turn ends on the usage limit.
      fs.writeFileSync(apiErrorOncePath, usageLimitErrorText);
      fs.writeFileSync(path.join(getLayout().fakeStateDir, fakeClaudeHoldReleaseFileName), '');
      const readRequest = (): OpenRequestState | undefined => Object.values(readState().openRequests ?? {}).find((open) => open.id === requestId);
      await getCharness().waitFor('the bot to stop waking the limited request', bufferedFlowTimeoutMs, () => readRequest()?.isLimitStopped === true);
      assert.ok(!fs.existsSync(apiErrorOncePath), 'the reminder\'s turn is the one that met the limit');
      await sleep(2 * requestSweepIntervalMs);

      const request = readRequest();
      assert.ok(request, 'still open: its answer comes after the operator writes');
      assert.equal(request.silentTurnCount, 1, 'only the first turn was silent: the one that ended on the limit is not');
      assert.equal(request.isWakeStopped, false, 'not given up');
      assert.equal(getAgentPrompts().filter((prompt) => prompt.text.includes(`[Reminder · request ${requestId} is still open]`)).length, 1, 'no reminder written into the limited session');
      assert.ok(!topic.listMessages().some((message) => message.text.includes('got no answer')), 'no «got no answer»');
    } finally {
      fs.rmSync(apiErrorOncePath, { force: true });
    }
  });

  it('per-turn: a message written while a turn runs that then ends in an error the bot does not classify is answered in its own turn — the process waits for it, nothing decides it ahead of that turn: no reminder, no give-up (review 17 #1)', async () => {
    // Still per turn (since the buffered-message step): the conversation sleeps between turns.
    const apiErrorOncePath = path.join(getLayout().fakeStateDir, fakeClaudeApiErrorOnceFileName);
    const apiErrorDelayPath = path.join(getLayout().fakeStateDir, fakeClaudeApiErrorDelayFileName);
    fs.writeFileSync(apiErrorDelayPath, failingTurnRunMs.toString());
    fs.writeFileSync(apiErrorOncePath, unclassifiedErrorText);
    try {
      fakeTelegram.pushOperatorMessage(topicThreadId, 'WL-12 [fake:answer] a turn that will fail');
      await getCharness().waitFor('the failing turn to start', agentTimeoutMs, () => readFakeLog<FakeClaudeTurn>(fakeClaudeLogFileNames.turns).some((turn) => turn.issueKey === 'WL-12' && turn.requestId === null));
      const launchesWhileItRuns = getSessionLaunches(getLayout()).length;
      // Open requests are kept per requester: the operator's new message replaces the entry of the request it supersedes.
      const listOpenRequestIds = (): string[] => Object.values(readState().openRequests ?? {}).map((open) => open.id);
      const openBefore = new Set(listOpenRequestIds());
      fakeTelegram.pushOperatorMessage(topicThreadId, 'WM-13 [fake:slow-once] a message written while the turn runs');
      await getCharness().waitFor('the message to open its request', replyTimeoutMs, () => listOpenRequestIds().some((id) => !openBefore.has(id)));
      const requestId = listOpenRequestIds().find((id) => !openBefore.has(id)) ?? '';
      assert.match(requestId, /^req_/);

      await getCharness().waitFor('the queued message to be answered in its own turn', slowTurnTimeoutMs, () => readClosedRequests().some((closed) => closed.id === requestId));
      assert.equal(readClosedRequests().find((closed) => closed.id === requestId)?.closeReason, 'final');
      assert.equal(getSessionLaunches(getLayout()).length, launchesWhileItRuns, 'answered in the process the error left: the per-turn stop waited for its turn');
      assert.deepEqual(getAgentPrompts().filter((prompt) => prompt.text.includes(`[Reminder · request ${requestId} is still open]`)), [], 'no reminder decided ahead of its turn');
      assert.ok(!topic.listMessages().some((message) => message.text.includes('got no answer')), 'no give-up');
    } finally {
      fs.rmSync(apiErrorOncePath, { force: true });
      fs.rmSync(apiErrorDelayPath, { force: true });
    }
  });

  it('per-turn: a file sent while the process stops after a turn, whose download outlasts the stop, gets its own turn — the stop\'s window that closed meanwhile does not keep it: the session wakes for it, no reminder (review 18 #1)', async () => {
    await sendFileAcrossThePerTurnStop('WN-14', 'WO-15');
    await getCharness().waitFor('the file to reach the agent in a turn of its own', bufferedFlowTimeoutMs, () => readFakeLog<FakeClaudeTurn>(fakeClaudeLogFileNames.turns).some((turn) => turn.issueKey === 'WO-15'));
    const requestId = readFakeLog<FakeClaudeTurn>(fakeClaudeLogFileNames.turns).find((turn) => turn.issueKey === 'WO-15')?.requestId ?? '';
    assert.match(requestId, /^req_/, 'the file opened its request');
    await getCharness().waitFor('the file\'s request to be answered', agentTimeoutMs, () => readClosedRequests().some((closed) => closed.id === requestId));
    assert.equal(readClosedRequests().find((closed) => closed.id === requestId)?.closeReason, 'final');
    assert.equal(getAgentPromptsWith('WO-15').length, 1, 'the agent read the file once: its own turn, not a re-post of an unread prompt');
    assert.deepEqual(getAgentPromptsWith(`[Reminder · request ${requestId} is still open]`), [], 'no reminder');
    assert.ok(!topic.listMessages().some((message) => message.text.includes('got no answer')), 'no give-up');
  });

  it('per-turn, the stream view: the same file reaches the agent — no request brings it back, so nothing but its own write can (review 18 #1)', async () => {
    await topic.sendAndAwaitReply('/verbosity stream', 'This topic shows: Stream only');
    await sendFileAcrossThePerTurnStop('WP-16', 'WQ-17');
    await getCharness().waitFor('the file to reach the agent', bufferedFlowTimeoutMs, () => readFakeLog<FakeClaudeTurn>(fakeClaudeLogFileNames.turns).some((turn) => turn.issueKey === 'WQ-17'));
    assert.equal(readFakeLog<FakeClaudeTurn>(fakeClaudeLogFileNames.turns).find((turn) => turn.issueKey === 'WQ-17')?.requestId, null, 'the stream view opens no request');
    assert.equal(getAgentPromptsWith('WQ-17').length, 1);
    await topic.sendAndAwaitReply('/verbosity answers', 'This topic shows: Answers only');
  });

  it('a deferred account switch: the turn the operator moved to another account ends silent and its process is re-spawned onto it right after — the reminder waits for the re-spawn: one launch, nothing beside it, the reminder in the new process (report 6, not fixed 2)', async () => {
    // A clean slate, a second signed-in account, and the idle lifecycle: per turn, the stop would end the process the switch re-spawns.
    fakeTelegram.pushOperatorMessage(topicThreadId, '/esc');
    await getCharness().waitFor('every open request to close', replyTimeoutMs, () => Object.keys(readState().openRequests ?? {}).length === 0);
    createClaudeProfileLayout({ dataDir: getLayout().dataDir, name: secondAccount, homeClaudeDir: path.join(getLayout().instanceHome, '.claude') });
    charness = await restartCharnessWithState(getLayout(), fakeTelegram, getCharness(), (persisted) => {
      persisted.claudeProfiles = { ...persisted.claudeProfiles, [secondAccount]: { createdAt: new Date().toISOString(), loggedIn: true, email: 'second@example.com', subscriptionType: 'max' } };
    });
    // A sleeping per-turn session switches at its next start, a live one at once: both replies name the backend.
    await topic.sendAndAwaitReply('/claude_mode json', '⚡ JSON-stream');

    fakeTelegram.pushOperatorMessage(topicThreadId, 'WK-11 [fake:hold-silent-once] a question while the account changes');
    await getCharness().waitFor('the agent to work on the request', agentTimeoutMs, () => readFakeLog<FakeClaudeTurn>(fakeClaudeLogFileNames.turns).some((turn) => turn.issueKey === 'WK-11'));
    const requestId = readFakeLog<FakeClaudeTurn>(fakeClaudeLogFileNames.turns).find((turn) => turn.issueKey === 'WK-11')?.requestId ?? '';
    assert.match(requestId, /^req_/);
    // The process works: the switch waits for the turn's end.
    await topic.sendAndAwaitReply(`/accounts use ${secondAccount}`, `Claude account for this topic: ${secondAccount}`);
    const launchesBefore = getSessionLaunches(getLayout()).length;

    // The turn ends with no answer; the switch re-spawns the process at once, and the turn's reminder follows the re-spawn.
    fs.writeFileSync(path.join(getLayout().fakeStateDir, fakeClaudeHoldReleaseFileName), '');
    await getCharness().waitFor('the request to be answered after its reminder', bufferedFlowTimeoutMs, () => readClosedRequests().some((closed) => closed.id === requestId));
    assert.equal(readClosedRequests().find((closed) => closed.id === requestId)?.closeReason, 'final');
    const launches = getSessionLaunches(getLayout()).slice(launchesBefore);
    assert.equal(launches.length, 1, `one launch: the re-spawn onto the new account\n${JSON.stringify(launches)}`);
    assert.equal(launches[0].claudeConfigDir, getAccountConfigDir(getLayout(), secondAccount));
    assert.deepEqual(launches.map((launch) => launch.overlapsPid ?? null), [null], 'nothing of the conversation still ran when it started');
    const reminders = getAgentPrompts().filter((prompt) => prompt.text.includes(`[Reminder · request ${requestId} is still open]`));
    assert.equal(reminders.length, 1, 'one reminder for the one silent turn');
    assert.equal(reminders[0].pid, launches[0].pid, 'the reminder went into the re-spawned process');
    assert.ok(!topic.listMessages().some((message) => message.text.includes('got no answer')), 'no give-up');
  });

  it('per-turn: a first message queued behind the stop is watched before its replay, not once its paced «queued» notice is out — its silent turn is reminded at once (review 20 #2)', async () => {
    const topicKeyString = `${group.id}:${topicThreadId}`;
    const stopLine = `[compact-on-idle] ${topicKeyString} stopping the idle process`;
    const stoppedLine = `[compact-on-idle] ${topicKeyString} process stopped`;
    const exitFlushDelayPath = path.join(getLayout().fakeStateDir, fakeClaudeExitFlushDelayFileName);
    let releaseNotice: () => void = () => {};
    let isNoticeHeld = false;
    // Right after the idle-lifecycle step, so no per-turn step's leftovers (a trailing stop, a fire posted again) share its windows.
    await topic.sendAndAwaitReply('/claude_mode per-turn', '🔁 Per-turn');
    try {
      fs.writeFileSync(exitFlushDelayPath, perTurnStopHoldMs.toString());
      const stopsBefore = countOutputLines(stopLine);
      const unfinishedStopsBefore = stopsBefore - countOutputLines(stoppedLine);
      fakeTelegram.pushOperatorMessage(topicThreadId, 'WY-25 [fake:answer] warm up the per-turn session');
      await getCharness().waitFor('the per-turn stop after the warm-up turn', bufferedFlowTimeoutMs, () => countOutputLines(stopLine) > stopsBefore);
      // The «queued» notice is held, as a busy process-wide pacer would hold it, until the message's own turn has ended and the next
      // stop's window is open.
      fakeTelegram.holdNextResponse('sendMessage', new Promise<void>((resolve) => { releaseNotice = resolve; }), (payload) => {
        const isNotice = typeof payload.text === 'string' && payload.text.includes('your message is queued');
        if (isNotice) isNoticeHeld = true;
        return isNotice;
      });
      const openBefore = new Set(Object.values(readState().openRequests ?? {}).map((open) => open.id));
      fakeTelegram.pushOperatorMessage(topicThreadId, 'WZ-26 [fake:silent-once] a message whose notice is slow');
      await getCharness().waitFor('the agent to take the replayed message in', bufferedFlowTimeoutMs, () =>
        readFakeLog<FakeClaudeTurn>(fakeClaudeLogFileNames.turns).some((turn) => turn.issueKey === 'WZ-26'));
      assert.ok(isNoticeHeld, 'the message was the first of the stop\'s window: its «queued» notice is the one held');
      const requestId = Object.values(readState().openRequests ?? {}).map((open) => open.id).find((id) => !openBefore.has(id)) ?? '';
      assert.match(requestId, /^req_/);
      await getCharness().waitFor('the stop after its silent turn', bufferedFlowTimeoutMs, () => countOutputLines(stopLine) > stopsBefore + 1);
      // Decided at its own end, while the notice is still held: the watch was there before the replay wrote the message.
      await getCharness().waitFor('its silent turn to be counted while the notice is held', replyTimeoutMs, () =>
        Object.values(readState().openRequests ?? {}).find((open) => open.id === requestId)?.silentTurnCount === 1);
      releaseNotice();
      // Its silent turn was decided at its end: the reminder brings the answer.
      await getCharness().waitFor('the request to be answered after its reminder', bufferedFlowTimeoutMs, () => readClosedRequests().some((closed) => closed.id === requestId));
      assert.equal(readClosedRequests().find((closed) => closed.id === requestId)?.closeReason, 'final');
      assert.equal(getAgentPromptsWith(`[Reminder · request ${requestId} is still open]`).length, 1, 'one reminder for the one silent turn');
      assert.ok(!topic.listMessages().some((message) => message.text.includes('got no answer')), 'no give-up');
      // The next step starts from a conversation that sleeps: the stop after the answer's turn has ended.
      await getCharness().waitFor('the conversation to sleep after the answer', bufferedFlowTimeoutMs, () => {
        const lastLaunch = getSessionLaunches(getLayout()).at(-1);
        return countOutputLines(stopLine) - countOutputLines(stoppedLine) === unfinishedStopsBefore && (lastLaunch === undefined || !checkIsProcessAlive(lastLaunch.pid));
      });
    } finally {
      releaseNotice();
      fs.rmSync(exitFlushDelayPath, { force: true });
    }
  });

  it('per-turn: an account picked while the turn works is applied by the stop at the turn\'s end, never by a re-spawn beside it — a message that stop holds reaches the next process, on the new account (review 22 #1)', async () => {
    const topicKeyString = `${group.id}:${topicThreadId}`;
    const stopLine = `[compact-on-idle] ${topicKeyString} stopping the idle process`;
    const stoppedLine = `[compact-on-idle] ${topicKeyString} process stopped`;
    const respawnLine = `[ClaudeJson] ${topicKeyString}: re-spawning under configDir=`;
    const exitFlushDelayPath = path.join(getLayout().fakeStateDir, fakeClaudeExitFlushDelayFileName);
    // Already per turn after the step before (which leaves the conversation asleep), still on the second account.
    await topic.sendAndAwaitReply('/claude_mode per-turn', '🔁 Per-turn');
    try {
      fs.writeFileSync(exitFlushDelayPath, perTurnStopHoldMs.toString());
      const stopsBefore = countOutputLines(stopLine);
      const droppedBefore = countTopicMessages('did not reach it');
      const unfinishedStopsBefore = stopsBefore - countOutputLines(stoppedLine);
      fakeTelegram.pushOperatorMessage(topicThreadId, 'XA-31 [fake:hold-silent-once] a turn the account changes under');
      await getCharness().waitFor('the agent to work on it', agentTimeoutMs, () => readFakeLog<FakeClaudeTurn>(fakeClaudeLogFileNames.turns).some((turn) => turn.issueKey === 'XA-31'));
      const silentRequestId = readFakeLog<FakeClaudeTurn>(fakeClaudeLogFileNames.turns).find((turn) => turn.issueKey === 'XA-31')?.requestId ?? '';
      assert.match(silentRequestId, /^req_/);
      // The process works: the pick waits for the turn's end.
      await topic.sendAndAwaitReply('/accounts use default', 'Claude account for this topic: default');
      const launchesBefore = getSessionLaunches(getLayout()).length;
      const respawnsBefore = countOutputLines(respawnLine);
      // The turn ends with no answer; the per-turn stop follows at once and holds its window open while the process exits.
      fs.writeFileSync(path.join(getLayout().fakeStateDir, fakeClaudeHoldReleaseFileName), '');
      await getCharness().waitFor('the per-turn stop after the turn', bufferedFlowTimeoutMs, () => countOutputLines(stopLine) > stopsBefore);
      const queuedBefore = countTopicMessages('your message is queued');
      fakeTelegram.pushOperatorMessage(topicThreadId, 'XB-32 [fake:answer] a message the stop holds');
      // Load-bearing: the message waited in the stop's window — one that came after the exit would wake the conversation by itself
      // and pass every assertion below (review 23 nit 5).
      await getCharness().waitFor('the message to be queued behind the stop', replyTimeoutMs, () => countTopicMessages('your message is queued') > queuedBefore);
      await getCharness().waitFor('the held message to reach the agent', bufferedFlowTimeoutMs, () =>
        readFakeLog<FakeClaudeTurn>(fakeClaudeLogFileNames.turns).some((turn) => turn.issueKey === 'XB-32'));
      const heldRequestId = readFakeLog<FakeClaudeTurn>(fakeClaudeLogFileNames.turns).find((turn) => turn.issueKey === 'XB-32')?.requestId ?? '';
      assert.match(heldRequestId, /^req_/);
      await getCharness().waitFor('the held message\'s request to be answered', bufferedFlowTimeoutMs, () => readClosedRequests().some((closed) => closed.id === heldRequestId));
      assert.equal(readClosedRequests().find((closed) => closed.id === heldRequestId)?.closeReason, 'final');
      // One open request per requester: the operator's newer message replaced their silent one.
      assert.equal(readClosedRequests().find((closed) => closed.id === silentRequestId)?.closeReason, 'superseded');
      assert.equal(getAgentPromptsWith('XB-32').length, 1, 'the held message is written once');
      assert.ok(getAgentPromptsWith(`[Reminder · request ${silentRequestId} is still open]`).length <= 1, 'at most one reminder for the silent turn');
      assert.equal(countOutputLines(respawnLine), respawnsBefore, 'no re-spawn: the stop ended the process, the resume took the new account');
      const launches = getSessionLaunches(getLayout()).slice(launchesBefore);
      assert.ok(launches.length >= 1, 'the next turn runs in a new process');
      assert.deepEqual(launches.map((launch) => launch.claudeConfigDir), launches.map(() => null), 'every process since the pick runs on the account picked (the first one: no directory of its own)');
      assert.deepEqual(launches.map((launch) => launch.overlapsPid ?? null), launches.map(() => null), 'none started while another process of the conversation still ran');
      assert.equal(countTopicMessages('did not reach it'), droppedBefore, 'nothing was dropped');
      // The next step starts from a conversation that sleeps.
      await getCharness().waitFor('the conversation to sleep after the answers', bufferedFlowTimeoutMs, () => {
        const lastLaunch = getSessionLaunches(getLayout()).at(-1);
        return countOutputLines(stopLine) - countOutputLines(stoppedLine) === unfinishedStopsBefore && (lastLaunch === undefined || !checkIsProcessAlive(lastLaunch.pid));
      });
    } finally {
      fs.rmSync(exitFlushDelayPath, { force: true });
      fs.rmSync(path.join(getLayout().fakeStateDir, fakeClaudeHoldReleaseFileName), { force: true });
    }
  });

  it('per-turn: a message the stop holds, then /quit — the stop starts nothing for it: no process is launched, the agent never gets it, its request is closed and the operator is told to send it again (review 23 #1)', async () => {
    const topicKeyString = `${group.id}:${topicThreadId}`;
    const stopLine = `[compact-on-idle] ${topicKeyString} stopping the idle process`;
    const stoppedLine = `[compact-on-idle] ${topicKeyString} process stopped`;
    const exitFlushDelayPath = path.join(getLayout().fakeStateDir, fakeClaudeExitFlushDelayFileName);
    await topic.sendAndAwaitReply('/claude_mode per-turn', '🔁 Per-turn');
    try {
      fs.writeFileSync(exitFlushDelayPath, perTurnStopHoldMs.toString());
      const stopsBefore = countOutputLines(stopLine);
      fakeTelegram.pushOperatorMessage(topicThreadId, 'XE-35 [fake:answer] warm up the per-turn session');
      await getCharness().waitFor('the per-turn stop after the warm-up turn', bufferedFlowTimeoutMs, () => countOutputLines(stopLine) > stopsBefore);
      const stoppedBefore = countOutputLines(stoppedLine);
      const queuedBefore = countTopicMessages('your message is queued');
      const droppedBefore = countTopicMessages(endingCommandDropLine);
      const openBefore = new Set(Object.values(readState().openRequests ?? {}).map((open) => open.id));
      fakeTelegram.pushOperatorMessage(topicThreadId, 'XF-36 [fake:answer] a message the stop holds');
      await getCharness().waitFor('the message to be queued behind the stop', replyTimeoutMs, () => countTopicMessages('your message is queued') > queuedBefore);
      assert.equal(countOutputLines(stoppedLine), stoppedBefore, 'the stop is still under way: the message waits in its window');
      const requestId = Object.values(readState().openRequests ?? {}).map((open) => open.id).find((id) => !openBefore.has(id)) ?? '';
      assert.match(requestId, /^req_/, 'the message opened its request');
      const launchesBefore = getSessionLaunches(getLayout()).length;
      // /quit queues behind the stop, marked as ending the conversation.
      fakeTelegram.pushOperatorMessage(topicThreadId, '/quit');
      await getCharness().waitFor('the operator to be told the message did not reach the agent', bufferedFlowTimeoutMs, () => countTopicMessages(endingCommandDropLine) > droppedBefore);
      await getCharness().waitFor('/quit to release the conversation', replyTimeoutMs, () => countTopicMessages('The sleeping session was released') > 0);
      assert.deepEqual(getSessionLaunches(getLayout()).slice(launchesBefore), [], 'nothing was resumed or started for it');
      assert.deepEqual(getAgentPromptsWith('XF-36'), [], 'the agent never got it');
      assert.equal(readClosedRequests().find((closed) => closed.id === requestId)?.closeReason, 'cancelled');
      assert.deepEqual(Object.keys(readState().openRequests ?? {}).filter((stateKey) => stateKey.startsWith(topicKeyString)), [], 'no request is left open for a backstop to post later');
      // The steps after this one work with an agent: the operator starts one again, as after any `/quit`.
      await topic.sendAndAwaitReply('/claude', 'ready in');
    } finally {
      fs.rmSync(exitFlushDelayPath, { force: true });
    }
  });

  it('/quitall from General while the topic\'s process stops: a message sent to the topic in those seconds is not delivered — never written into the exiting process, no fresh agent started for it after the quit; its request is closed and the operator told (review 24 nit 3, review 25 #2)', async () => {
    const topicKeyString = `${group.id}:${topicThreadId}`;
    const exitFlushDelayPath = path.join(getLayout().fakeStateDir, fakeClaudeExitFlushDelayFileName);
    // An idle session keeps its process between turns: the one /quitall stops.
    await topic.sendAndAwaitReply('/claude_mode json', '⚡ JSON-stream');
    fakeTelegram.pushOperatorMessage(topicThreadId, 'XI-39 [fake:answer] warm up the idle session before /quitall');
    await getCharness().waitFor('the warm-up turn', agentTimeoutMs, () => readFakeLog<FakeClaudeTurn>(fakeClaudeLogFileNames.turns).some((turn) => turn.issueKey === 'XI-39'));
    const warmUpPid = getAgentPromptsWith('XI-39').at(-1)?.pid ?? 0;
    assert.ok(checkIsProcessAlive(warmUpPid), 'the idle process is up');
    try {
      fs.writeFileSync(exitFlushDelayPath, perTurnStopHoldMs.toString());
      const launchesBefore = getSessionLaunches(getLayout()).length;
      const droppedBefore = countTopicMessages(endingCommandDropLine);
      const closedBefore = new Set(readClosedRequests().map((closed) => closed.id));
      const countQuitSummaries = (): number => fakeTelegram.listBotMessages(generalTopicThreadId).filter((message) => message.text.includes('🚪 Quit')).length;
      const quitSummariesBefore = countQuitSummaries();
      fakeTelegram.pushOperatorMessage(generalTopicThreadId, '/quitall');
      await getCharness().waitFor('/quitall to stop the topic\'s process', replyTimeoutMs, () =>
        readFakeLog<{ pid: number }>(fakeClaudeLogFileNames.stopSignals).some((record) => record.pid === warmUpPid));
      fakeTelegram.pushOperatorMessage(topicThreadId, 'XJ-40 [fake:answer] a message sent while /quitall stops the process');
      assert.ok(checkIsProcessAlive(warmUpPid), 'the process is still exiting when the message comes');
      await getCharness().waitFor('the operator to be told the message did not reach the agent', replyTimeoutMs, () => countTopicMessages(endingCommandDropLine) > droppedBefore);
      await getCharness().waitFor('/quitall to finish', bufferedFlowTimeoutMs, () => !checkIsProcessAlive(warmUpPid) && countQuitSummaries() > quitSummariesBefore);
      // Load-bearing: before, the message woke the conversation, and the wake's ensure — queued behind the release — found no id and
      // started a fresh agent with it right after the quit. Its request is closed only once the bot decided it goes nowhere.
      await getCharness().waitFor('the message\'s request to be closed', replyTimeoutMs, () =>
        readClosedRequests().some((closed) => !closedBefore.has(closed.id) && closed.closeReason === 'cancelled' && closed.conversationKey === topicKeyString));
      assert.deepEqual(getAgentPromptsWith('XJ-40'), [], 'never written into the process being stopped, nor into any other');
      assert.deepEqual(getSessionLaunches(getLayout()).slice(launchesBefore), [], 'no fresh agent was started after the quit');
      assert.deepEqual(Object.keys(readState().openRequests ?? {}).filter((stateKey) => stateKey.startsWith(topicKeyString)), [], 'no request is left open for a backstop to post later');
    } finally {
      fs.rmSync(exitFlushDelayPath, { force: true });
    }
    // The steps after this one work with a per-turn agent: the operator starts one again, as after any quit.
    await topic.sendAndAwaitReply('/claude_mode per-turn', '🔁 Per-turn');
    await topic.sendAndAwaitReply('/claude', 'ready in');
  });

  it('per-turn: a file whose prompt wakes the sleeping conversation, then /quitall from General while that wake is under way — its person is told ONCE that it did not reach the agent, not by /quitall and again by its own refused write (review 27 #1)', async () => {
    const launchDelayPath = path.join(getLayout().fakeStateDir, fakeClaudeLaunchDelayFileName);
    const countQuitSummaries = (): number => fakeTelegram.listBotMessages(generalTopicThreadId).filter((message) => message.text.includes('🚪 Quit')).length;
    // The resume the file's prompt makes is held: a CLI slow to start, so /quitall lands while the prompt is on its way to its write.
    fs.writeFileSync(launchDelayPath, slowLaunchMs.toString());
    try {
      const droppedBefore = countTopicMessages(endingCommandDropLine);
      const quitSummariesBefore = countQuitSummaries();
      const launchesBefore = getSessionLaunches(getLayout()).length;
      const openBefore = new Set(Object.values(readState().openRequests ?? {}).map((open) => open.id));
      // The per-turn agent from the step before takes a warm-up turn; the file arrives in its stop's window and is written after the stop:
      // its request opens, and its write wakes the conversation.
      await sendFileAcrossThePerTurnStop('XO-45', 'XP-46');
      await getCharness().waitFor('the wake to begin resuming the conversation', replyTimeoutMs, () => getSessionLaunches(getLayout()).length > launchesBefore);
      await getCharness().waitFor('the file\'s request to be open', replyTimeoutMs, () => Object.values(readState().openRequests ?? {}).some((open) => !openBefore.has(open.id)));
      fakeTelegram.pushOperatorMessage(generalTopicThreadId, '/quitall');
      await getCharness().waitFor('/quitall to finish', bufferedFlowTimeoutMs, () => countQuitSummaries() > quitSummariesBefore);
      await getCharness().waitFor('the operator to be told the file did not reach the agent', replyTimeoutMs, () => countTopicMessages(endingCommandDropLine) > droppedBefore);
      // Load-bearing: before, /quitall told it from its handler and the refused write told it again once the wake was over. Both lines would
      // be out by now; one more pacer interval to be sure.
      await sleep(pacerSettleMs);
      assert.equal(countTopicMessages(endingCommandDropLine) - droppedBefore, 1, 'told once');
      assert.deepEqual(getAgentPromptsWith('XP-46'), [], 'it never reached the agent');
    } finally {
      fs.rmSync(launchDelayPath, { force: true });
    }
    // The steps after this one work with a per-turn agent: the operator starts one again, as after any quit.
    await topic.sendAndAwaitReply('/claude', 'ready in');
  });

  it('per-turn: a message the stop holds, then «Leave current dir» whose toast comes back only once the stop is over — the tap marks the conversation ahead of its toast, so the stop starts nothing for it: no process is launched, its request is closed and the operator is told (review 24 #1)', async () => {
    const topicKeyString = `${group.id}:${topicThreadId}`;
    const stopLine = `[compact-on-idle] ${topicKeyString} stopping the idle process`;
    const stoppedLine = `[compact-on-idle] ${topicKeyString} process stopped`;
    const exitFlushDelayPath = path.join(getLayout().fakeStateDir, fakeClaudeExitFlushDelayFileName);
    // The picker is posted before the turn: its post is paced, and the tap must land while the stop still runs.
    const picker = await topic.sendAndAwaitReply('/bind', `Currently bound: \`${topicFolder}\``);
    try {
      fs.writeFileSync(exitFlushDelayPath, perTurnStopHoldMs.toString());
      const stopsBefore = countOutputLines(stopLine);
      fakeTelegram.pushOperatorMessage(topicThreadId, 'XG-37 [fake:answer] warm up the per-turn session before leaving the folder');
      await getCharness().waitFor('the per-turn stop after the warm-up turn', bufferedFlowTimeoutMs, () => countOutputLines(stopLine) > stopsBefore);
      const stoppedBefore = countOutputLines(stoppedLine);
      const queuedBefore = countTopicMessages('your message is queued');
      const droppedBefore = countTopicMessages(endingCommandDropLine);
      const unboundBefore = countTopicMessages('Binding cleared');
      const openBefore = new Set(Object.values(readState().openRequests ?? {}).map((open) => open.id));
      fakeTelegram.pushOperatorMessage(topicThreadId, 'XH-38 [fake:answer] a message the stop holds before the folder is left');
      await getCharness().waitFor('the message to be queued behind the stop', replyTimeoutMs, () => countTopicMessages('your message is queued') > queuedBefore);
      assert.equal(countOutputLines(stoppedLine), stoppedBefore, 'the stop is still under way: the message waits in its window');
      const requestId = Object.values(readState().openRequests ?? {}).map((open) => open.id).find((id) => !openBefore.has(id)) ?? '';
      assert.match(requestId, /^req_/, 'the message opened its request');
      const launchesBefore = getSessionLaunches(getLayout()).length;
      // The tap's toast is a Bot API round trip, and the leave's unpin and delete after it are paced sends: the toast is held here until
      // the stop is over, as those seconds would in production, so a mark taken only after them comes too late for the stop.
      const stopEnded = getCharness().waitFor('the stop to end', bufferedFlowTimeoutMs, () => countOutputLines(stoppedLine) > stoppedBefore);
      fakeTelegram.holdNextResponse('answerCallbackQuery', stopEnded.catch(() => undefined));
      fakeTelegram.pushCallback(picker.message_id, bindLeaveCurrentCallback);
      await getCharness().waitFor('the operator to be told the message did not reach the agent', bufferedFlowTimeoutMs, () => countTopicMessages(endingCommandDropLine) > droppedBefore);
      await getCharness().waitFor('the topic to be unbound', replyTimeoutMs, () => countTopicMessages('Binding cleared') > unboundBefore);
      assert.deepEqual(getSessionLaunches(getLayout()).slice(launchesBefore), [], 'nothing was resumed or started for it in the folder being left');
      assert.deepEqual(getAgentPromptsWith('XH-38'), [], 'the agent never got it');
      assert.equal(readClosedRequests().find((closed) => closed.id === requestId)?.closeReason, 'cancelled');
      assert.deepEqual(Object.keys(readState().openRequests ?? {}).filter((stateKey) => stateKey.startsWith(topicKeyString)), [], 'no request is left open for a backstop to post later');
    } finally {
      fs.rmSync(exitFlushDelayPath, { force: true });
    }
    // The steps after this one work in the folder with a per-turn agent and the answers view: the operator sets them up again.
    await topic.sendAndAwaitReply(`/bind ${topicFolder}`, `Bound to \`${topicFolder}\``);
    await topic.sendAndAwaitReply('/claude', 'ready in');
    await topic.sendAndAwaitReply('/claude_mode per-turn', '🔁 Per-turn');
    await topic.sendAndAwaitReply('/verbosity answers', 'This topic shows: Answers only');
  });

  /**
   * Per turn: a one-shot armed by `armingIssueKey`'s turn fires after the conversation went to sleep, and its post resumes it. The CLI
   * refuses that resume after {@link launchRefusalDelayMs} (the conversation cannot be restored), and — with `isFreshStartRefused` — the
   * fresh start that follows as well. Meanwhile the operator's `messageIssueKey` message arrives and waits in the resume's window.
   * Resolves the message's request id once the bot has said it is queued; the fake's refusal files are removed by the caller.
   */
  async function sendMessageIntoFailingResume(armingIssueKey: string, messageIssueKey: string, isFreshStartRefused: boolean): Promise<string> {
    const stoppedLine = `[compact-on-idle] ${group.id}:${topicThreadId} process stopped`;
    const stoppedBefore = countOutputLines(stoppedLine);
    await armOneShotUnderFinishedRequest(armingIssueKey, '');
    await getCharness().waitFor('the conversation to sleep after the arming turn', bufferedFlowTimeoutMs, () => countOutputLines(stoppedLine) > stoppedBefore);
    const armingTurn = readFakeLog<FakeClaudeTurn>(fakeClaudeLogFileNames.turns).filter((turn) => turn.issueKey === armingIssueKey).at(-1);
    const sessionId = getLaunchSessionId(getSessionLaunches(getLayout()).find((launch) => launch.pid === armingTurn?.pid)?.argv ?? []) ?? '';
    assert.ok(sessionId, 'the sleeping conversation\'s id');
    fs.writeFileSync(path.join(getLayout().fakeStateDir, fakeClaudeLaunchRefusalDelayFileName), launchRefusalDelayMs.toString());
    fs.writeFileSync(path.join(getLayout().fakeStateDir, getFakeClaudeUnrestorableConversationFileName(sessionId)), '');
    if (isFreshStartRefused) fs.writeFileSync(path.join(getLayout().fakeStateDir, fakeClaudeRefuseLaunchFileName), '');
    const launchesBefore = getSessionLaunches(getLayout()).length;
    await getCharness().waitFor('the fire to resume the sleeping conversation', oneShotFireTimeoutMs, () =>
      getSessionLaunches(getLayout()).slice(launchesBefore).some((launch) => getLaunchSessionId(launch.argv) === sessionId));
    const queuedBefore = topic.listMessages().filter((message) => message.text.includes('your message is queued')).length;
    const openBefore = new Set(Object.values(readState().openRequests ?? {}).map((open) => open.id));
    fakeTelegram.pushOperatorMessage(topicThreadId, `${messageIssueKey} [fake:answer] a message written while the conversation resumes`);
    await getCharness().waitFor('the message to wait in the resume\'s window', replyTimeoutMs, () =>
      topic.listMessages().filter((message) => message.text.includes('your message is queued')).length > queuedBefore);
    const requestId = Object.values(readState().openRequests ?? {}).map((open) => open.id).find((id) => !openBefore.has(id)) ?? '';
    assert.match(requestId, /^req_/, 'the message opened its request');
    assert.equal(getSessionLaunches(getLayout()).length, launchesBefore + 1, 'still inside the resume: no fresh start yet');
    return requestId;
  }

  function removeRefusalFiles(): void {
    for (const fileName of fs.readdirSync(getLayout().fakeStateDir)) {
      if (fileName === fakeClaudeLaunchRefusalDelayFileName || fileName === fakeClaudeRefuseLaunchFileName || fileName.startsWith(getFakeClaudeUnrestorableConversationFileName(''))) {
        fs.rmSync(path.join(getLayout().fakeStateDir, fileName), { force: true });
      }
    }
  }

  it('per-turn: a message that waits while a sleeping conversation is resumed reaches the fresh session that replaces a failed resume — never dropped, no reminder of words the agent never got (review 19 #1)', async () => {
    await topic.sendAndAwaitReply('/claude_mode per-turn', '🔁 Per-turn');
    // Counted from here: an earlier step's dropped message said so in the same topic.
    const droppedBefore = countTopicMessages('did not reach it');
    try {
      const requestId = await sendMessageIntoFailingResume('WU-21', 'WV-22', false);
      await getCharness().waitFor('the message to reach the fresh session in a turn of its own', bufferedFlowTimeoutMs, () =>
        readFakeLog<FakeClaudeTurn>(fakeClaudeLogFileNames.turns).some((turn) => turn.issueKey === 'WV-22' && turn.requestId === requestId));
      await getCharness().waitFor('its request to be answered', agentTimeoutMs, () => readClosedRequests().some((closed) => closed.id === requestId));
      assert.equal(readClosedRequests().find((closed) => closed.id === requestId)?.closeReason, 'final');
      assert.equal(getAgentPromptsWith('WV-22').length, 1, 'the agent read the message once');
      assert.deepEqual(getAgentPromptsWith(`[Reminder · request ${requestId} is still open]`), [], 'no reminder');
      assert.equal(countTopicMessages('did not reach it'), droppedBefore, 'nothing was dropped');
    } finally {
      removeRefusalFiles();
    }
  });

  it('per-turn: when the fresh start after a failed resume fails too, a message that waited there is dropped — its request closes and the operator is told to send it again (review 19 #1)', async () => {
    // Counted from here: an earlier step's dropped message said so in the same topic.
    const droppedBefore = countTopicMessages('did not reach it. Send it again.');
    try {
      const requestId = await sendMessageIntoFailingResume('WW-23', 'WX-24', true);
      await getCharness().waitFor('the operator to be told the message did not reach the agent', bufferedFlowTimeoutMs, () =>
        countTopicMessages('did not reach it. Send it again.') > droppedBefore);
      await getCharness().waitFor('its request to close', replyTimeoutMs, () => readClosedRequests().some((closed) => closed.id === requestId));
      assert.equal(readClosedRequests().find((closed) => closed.id === requestId)?.closeReason, 'cancelled');
      assert.deepEqual(getAgentPromptsWith('WX-24'), [], 'no agent got it');
      await sleep(2 * requestSweepIntervalMs);
      assert.deepEqual(getAgentPromptsWith(`[Reminder · request ${requestId} is still open]`), [], 'no reminder of a request nobody got');
    } finally {
      removeRefusalFiles();
    }
  });

  it('a scheduled run that comes due while «Leave current dir» runs waits for the leave: no agent starts in the folder being left, and the job pauses until the next bind (review 27 nit 4, review 28 #1)', async () => {
    const runPromptText = 'XR-48 [fake:answer] scheduled';
    // The ledger appends a run twice: at the fire, and with `deliveredAt` (and a failure's `error`) once its delivery is over.
    const readJobRun = (jobId: string): ScheduleRunRecord | undefined =>
      readJsonLines<ScheduleRunRecord>(path.join(getLayout().dataDir, 'scheduler-runs.jsonl')).filter((run) => run.jobId === jobId).at(-1);
    // An idle agent whose process stays between turns: the one the leave stops. The switch runs as the conversation's transition, so its
    // reply comes after a start still under way: the step before may end while a retry of its failed post starts on the CLI it made
    // refuse, and a message sent into that start would be dropped with it. The arming message then wakes the sleeping conversation.
    await topic.sendAndAwaitReply('/claude_mode json', '⚡ JSON-stream');
    const createsBefore = getToolCalls('schedule_create').length;
    fakeTelegram.pushOperatorMessage(topicThreadId, `XQ-47 [fake:answer] ${fakeScheduleOnceToken(runInLeaveDelaySeconds, 'XR-48')} arm a run`);
    await getCharness().waitFor('the agent to arm the one-shot', agentTimeoutMs, () => getToolCalls('schedule_create').length === createsBefore + 1);
    const fireAtMs = Date.parse(String(getToolCalls('schedule_create').at(-1)?.args.onceAt));
    await getCharness().waitFor('the arming turn\'s answer', agentTimeoutMs, () =>
      readFakeLog<{ issueKey: string; kind: string }>(fakeClaudeLogFileNames.answers).some((answer) => answer.issueKey === 'XQ-47' && answer.kind === 'final'));
    const jobId = readPersistedSchedules().find((job) => job.name === 'queued XR-48')?.id ?? '';
    assert.ok(jobId, 'the one-shot is stored');
    const picker = await topic.sendAndAwaitReply('/bind', `Currently bound: \`${topicFolder}\``);
    const launchesBefore = getSessionLaunches(getLayout()).length;
    const unboundBefore = countTopicMessages('Binding cleared');
    // The tap marks the conversation; its toast is a Bot API round trip, held here past the run's due time, as a slow network would: the
    // run fires while the leave runs.
    let toastReleasedAtMs = 0;
    const toastReleased = sleep(fireAtMs + leaveHoldPastFireMs - Date.now()).then(() => { toastReleasedAtMs = Date.now(); });
    fakeTelegram.holdNextResponse('answerCallbackQuery', toastReleased);
    fakeTelegram.pushCallback(picker.message_id, bindLeaveCurrentCallback);
    assert.ok(Date.now() < fireAtMs, 'precondition: the run comes due after the tap');
    await getCharness().waitFor('the topic to be unbound', bufferedFlowTimeoutMs, () => countTopicMessages('Binding cleared') > unboundBefore);
    await getCharness().waitFor('the run to be over, or an agent to start for it', oneShotFireTimeoutMs, () => {
      const run = readJobRun(jobId);
      return getSessionLaunches(getLayout()).length > launchesBefore || run?.deliveredAt !== undefined;
    });
    // Load-bearing: before, the run's post went on once the leave's stop was over, found the binding still there while the leave paused
    // the topic's jobs, and started a fresh agent in the folder being left.
    assert.deepEqual(getSessionLaunches(getLayout()).slice(launchesBefore), [], 'no agent started in the folder being left');
    const run = readJobRun(jobId);
    assert.ok(toastReleasedAtMs > 0 && (run?.firedAt ?? Infinity) < toastReleasedAtMs, 'precondition: the run fired inside the leave');
    assert.deepEqual(getAgentPromptsWith(runPromptText), [], 'no agent read the run');
    // It met the topic the leave unbound: it starts nothing there and fails — a start refused for no folder, since the ensure's plan reads
    // every topic as bound (`getBinding` gives `null`, compared with `undefined`; reported, not changed here). The leave paused the job
    // already, and the engine keeps a job paused during its delivery paused.
    assert.ok(run?.error !== undefined && run.deliveredAt !== undefined, 'the run is over and reached no agent');
    const job = readState().schedules?.[jobId];
    assert.equal(job?.isPaused, true, 'the job waits for the next bind');
    assert.equal(job?.pauseReason, 'unbound');
  });
});
