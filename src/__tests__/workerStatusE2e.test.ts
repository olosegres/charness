/**
 * @description A worker watch's STATUS LINE from start to finish, at PROCESS level: the BUILT charness started the way an
 * isolated instance is (`scripts/run-isolated.sh`) against the fake Bot API (`telegramE2e/fakeTelegram.ts`), with the fake
 * `claude` playing an orchestrator that arms the watch the way the `charness-manager` skill tells it to — the REAL recipe
 * (`scheduler/workerWatch.ts`) with its status arguments — on a REAL worker process (`sleep`) whose event log the test
 * writes by hand. One flow, in order:
 *
 *   boot → a topic bound, a Claude session started
 *   → the agent arms the watch (`arm-status-watch`), then ENDS its turn and is never prompted again until the worker is gone
 *   → line 1: posted by the BOT, silently and not pinned, its «now» the worker's last tool call in Claude `stream-json`
 *   → the worker's log gets a resume's `events-2.jsonl` in OpenCode `--format json`: line 2 carries ITS last tool call, line 1
 *     is deleted (one line at a time), and a check run passed in between WITHOUT a line (the interval holds)
 *   → `/verbosity answers`: the line is deleted and two whole check runs (read from the run ledger) post nothing
 *   → `/verbosity stream`: a line returns
 *   → «Leave current dir» on the `/bind` picker: the line is deleted, the watch is parked (paused for «unbound»), and no check
 *     run and no line follows; the folder bound again: the watch resumes and a line returns at the next due run
 *   → the worker is killed: the line is deleted, the alert is pinned silently, the agent is woken (`cancel-watch`)
 *   → `schedule_cancel`: the alert is unpinned, the watch is gone, and no status line of the whole flow is left in the topic.
 *
 * No agent turn runs for any status line (the fake's prompt log proves it). Nothing leaves the machine: the Bot API is on
 * loopback and the agent is a fake. Everything the test starts is stopped in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram, type FakeTelegramMessage } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import {
  fakeClaudeLogFileNames,
  fakeStatusWatchJobName,
  fakeStatusWatchTargetFileName,
  type FakeClaudePrompt,
  type FakeClaudeToolCall,
  type FakeStatusWatchTarget,
} from './jiraE2e/fakeClaudeContract';
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
import { bindLeaveCurrentCallback } from '../connectors/telegram/bindPicker';
import { enDict } from '../i18n/en';
import { defaultCheckStatusEveryMinutes } from '../scheduler/checkStatus';
import type { ScheduleRunRecord } from '../scheduler/runLedger';
import type { ScheduleRecord } from '../scheduler/types';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const topicThreadId = 151;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const topicFolder = 'status-flow';
const launchLine = 'Launching Telegraf bot (long polling';
const alertMark = `Check "${fakeStatusWatchJobName}" failed`;
/** What the topic shows of the watch's name: the recipe's own leading «watch » is dropped. */
const shownWatchName = fakeStatusWatchJobName.replace(/^watch /, '');
const statusLinePrefix = `⏳ ${shownWatchName} · works `;

const bootTimeoutMs = 60 * 1000;
const replyTimeoutMs = 20 * 1000;
const agentTimeoutMs = 60 * 1000;
/** The watch runs every minute (the production minimum is five): a tick is up to a minute and a little away. */
const watchCronIntervalMs = 60 * 1000;
/** A check run: the next tick, plus the time a loaded machine needs to run it. */
const checkRunTimeoutMs = 2 * 60 * 1000;
/**
 * The gap between two status lines in this flow. With a tick every minute and a slack of a fifth of the interval, a gap of
 * two minutes is a line on every SECOND tick: the tick between two lines runs, passes and posts nothing — what proves the
 * interval, where a minute would make every tick due. A line waits for its second tick, plus the first's wait.
 */
const statusIntervalMs = 2 * 60 * 1000;
const statusLineTimeoutMs = statusIntervalMs + checkRunTimeoutMs;
/** How long the parked watch is watched for a check run: the cron's next tick, whenever it would come, plus a loaded machine's margin. */
const parkedWatchObservationMs = watchCronIntervalMs + 15 * 1000;
/** Check runs that must pass, finished, while the answers-only view is on: more than the one a line due at once could hide in. */
const answersOnlyRunCount = 2;
const workerLogLines = {
  /** A Claude `stream-json` assistant event ending in a tool call. */
  claudeToolCall: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'yarn test', description: 'Run the unit tests' } }] } }),
  /** An OpenCode `--format json` tool event. */
  openCodeToolCall: JSON.stringify({ type: 'tool_use', sessionID: 'ses_1', part: { type: 'tool', tool: 'bash', state: { status: 'completed', title: 'yarn lint', input: { description: 'Lint the sources' } } } }),
};

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let topic: TopicDriver;
let defaultTmuxSessionsBefore: string[] = [];
let worker: ChildProcess | null = null;
let runDir = '';
let alertMessageId = 0;
let watchId = '';
/** Every status line the flow saw in the topic, in order: at the end every one of them must be gone. */
const seenStatusMessageIds: number[] = [];

function getLayout(): IsolatedInstanceLayout {
  if (!layout) throw new Error('the instance layout is not created yet');
  return layout;
}

function getCharness(): IsolatedCharness {
  if (!charness) throw new Error('charness is not started yet');
  return charness;
}

function getWorker(): ChildProcess {
  if (!worker) throw new Error('the worker is not started yet');
  return worker;
}

function getWorkerPid(): number {
  const { pid } = getWorker();
  if (pid === undefined) throw new Error('the worker has no process id');
  return pid;
}

function removeInstanceSync(): void {
  worker?.kill('SIGKILL');
  removeIsolatedInstanceSync(layout, charness);
}

function getToolCalls(tool: string): FakeClaudeToolCall[] {
  return readJsonLines<FakeClaudeToolCall>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.toolCalls)).filter((call) => call.tool === tool);
}

/** How many user messages the fake agent has read: a turn the bot started for a status line would add one. */
function countAgentPrompts(): number {
  return readJsonLines<FakeClaudePrompt>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.prompts)).length;
}

function readPersistedSchedules(): ScheduleRecord[] {
  const persisted: { schedules?: Record<string, ScheduleRecord> } = JSON.parse(fs.readFileSync(path.join(getLayout().dataDir, 'state.json'), 'utf8'));
  return Object.values(persisted.schedules ?? {});
}

/** The status lines in the topic right now (not deleted), oldest first; each one seen is remembered. */
function listVisibleStatusLines(): FakeTelegramMessage[] {
  const lines = topic.listMessages().filter((message) => message.text.startsWith(statusLinePrefix));
  for (const line of lines) if (!seenStatusMessageIds.includes(line.message_id)) seenStatusMessageIds.push(line.message_id);
  return lines;
}

/** Every status line the bot SENT, deleted ones included. */
function countStatusPosts(): number {
  return fakeTelegram.listCalls('sendMessage').filter((call) => String(call.payload.text).startsWith(statusLinePrefix)).length;
}

/** Wait for a status line that no earlier wait saw. */
async function waitForNewStatusLine(description: string): Promise<FakeTelegramMessage> {
  const knownIds = [...seenStatusMessageIds];
  let found: FakeTelegramMessage | undefined;
  await getCharness().waitFor(description, statusLineTimeoutMs, () => {
    found = listVisibleStatusLines().find((line) => !knownIds.includes(line.message_id));
    return found !== undefined;
  });
  if (!found) throw new Error(`no status line for ${description}`);
  return found;
}

/** The elapsed minutes a status line reports. */
function getReportedMinutes(line: FakeTelegramMessage): number {
  const match = /works (\d+) min/.exec(line.text);
  if (!match) throw new Error(`no elapsed time in "${line.text}"`);
  return Number.parseInt(match[1], 10);
}

/**
 * The check runs of the watch that STARTED between two instants, from the run ledger's begin records (a fire writes one before
 * its delivery, so the run that posted a line is already counted when the line is seen; its end record is not).
 */
function countRunsStartedBetween(afterMs: number, beforeMs: number): number {
  return readJsonLines<ScheduleRunRecord>(path.join(getLayout().dataDir, 'scheduler-runs.jsonl'))
    .filter((run) => run.jobId === watchId && run.deliveredAt === undefined && run.firedAt > afterMs && run.firedAt < beforeMs).length;
}

/** The check runs of the watch that have finished, started after `sinceMs`, from the run ledger. */
function countFinishedRunsSince(sinceMs: number): number {
  return readJsonLines<ScheduleRunRecord>(path.join(getLayout().dataDir, 'scheduler-runs.jsonl'))
    .filter((run) => run.jobId === watchId && run.deliveredAt !== undefined && run.firedAt > sinceMs).length;
}

function assertSilentAndUnpinned(line: FakeTelegramMessage): void {
  assert.equal(line.isSilent, true, 'a status line never notifies');
  assert.ok(!fakeTelegram.pinEvents.some((event) => event.messageId === line.message_id), 'a status line is never pinned');
}

describe('A worker watch status line end to end: built charness, fake Bot API, a fake orchestrating agent, a real worker process', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-status-', [topicFolder], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    runDir = path.join(layout.testRoot, 'worker-run');
    fs.mkdirSync(runDir);
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
      OPENCODE_URL: `http://127.0.0.1:${await getFreePort()}`,
      SCHEDULER_MCP_PORT: (await getFreeFixedPort()).toString(),
      // A watch every minute and a status line every other one (the production minimum and default are 5 and 15 minutes).
      ...getTelegramFlowTestTimingsEnv({ scheduleMinFireIntervalMs: watchCronIntervalMs, checkStatusIntervalMs: statusIntervalMs }),
    });
  });

  after(async () => {
    worker?.kill('SIGKILL');
    await charness?.stop();
    removeInstanceSync();
    await fakeTelegram?.stop();
    process.off('exit', removeInstanceSync);
    process.off('SIGINT', exitOnSignal);
    process.off('SIGTERM', exitOnSignal);
    assert.deepEqual(listTmuxSessions([]), defaultTmuxSessionsBefore, 'the default tmux server was not touched');
  });

  it('boots, binds the topic and starts a Claude session', async () => {
    charness = new IsolatedCharness(getLayout());
    const pollsBefore = fakeTelegram.listCalls('getUpdates').length;
    await charness.start(bootTimeoutMs, (runOutput) => runOutput.includes(launchLine) && fakeTelegram.listCalls('getUpdates').length > pollsBefore);
    await topic.sendAndAwaitReply(`/bind ${topicFolder}`, `Bound to \`${topicFolder}\``);
    await topic.sendAndAwaitReply('/claude', 'ready in');
  });

  it('the agent arms the watch with the real recipe and its status arguments, on a worker that is running', async () => {
    const startedWorker = spawn('sleep', ['3600'], { stdio: 'ignore' });
    worker = startedWorker;
    await new Promise<void>((resolve, reject) => {
      startedWorker.once('spawn', resolve);
      startedWorker.once('error', reject);
    });
    fs.writeFileSync(path.join(runDir, 'events.jsonl'), `${workerLogLines.claudeToolCall}\n`);
    const target: FakeStatusWatchTarget = { pid: getWorkerPid(), runDir };
    fs.writeFileSync(path.join(getLayout().fakeStateDir, fakeStatusWatchTargetFileName), JSON.stringify(target));

    fakeTelegram.pushOperatorMessage(topicThreadId, 'S-1 [fake:arm-status-watch] watch the builder you just launched');
    await getCharness().waitFor('the agent to arm the watch', agentTimeoutMs, () => getToolCalls('schedule_create').length === 1);
    const [created] = getToolCalls('schedule_create');
    assert.doesNotMatch(created.outcome, /^error:/, created.outcome);
    assert.match(created.outcome, new RegExp(`status every ${defaultCheckStatusEveryMinutes} min`), 'the list line says the status rhythm the recipe asked for');
    // `state.json` is written a moment after the change (the save is debounced): wait for the record, do not read it at once.
    await getCharness().waitFor('the watch to be persisted', replyTimeoutMs, () => readPersistedSchedules().some((record) => record.name === fakeStatusWatchJobName));
    const [watch] = readPersistedSchedules().filter((record) => record.name === fakeStatusWatchJobName);
    watchId = watch.id;
    assert.equal(watch.deliveryKind, 'check');
    assert.equal(watch.isPinSilent, true);
    assert.equal(watch.statusWorkerRunDir, runDir);
    assert.equal(watch.statusEveryMinutes, defaultCheckStatusEveryMinutes, 'the recipe\'s own rhythm is persisted; the test seam shortens it at run time');
    assert.match(watch.checkCommand ?? '', new RegExp(`kill -0 ${getWorkerPid()}\\b`));
  });

  let promptsAfterArming = 0;
  let firstLine: FakeTelegramMessage;
  let firstLineSeenAtMs = 0;

  it('line 1: the BOT posts it — silent, not pinned — with the worker\'s last tool call from its Claude log, and no agent turn runs', async () => {
    promptsAfterArming = countAgentPrompts();
    firstLine = await waitForNewStatusLine('the first status line');
    firstLineSeenAtMs = Date.now();
    assert.match(firstLine.text, new RegExp(`^${statusLinePrefix}\\d+ min · now: Bash: Run the unit tests$`), firstLine.text);
    assertSilentAndUnpinned(firstLine);
    assert.equal(countAgentPrompts(), promptsAfterArming, 'the agent was not prompted: a status line costs no turn');
    assert.equal(getToolCalls('schedule_list').length, 0, 'the agent did not wake to look at the watch');
  });

  let secondLine: FakeTelegramMessage;

  it('line 2: the log of a resumed worker (OpenCode format, events-2.jsonl) is read, the previous line is deleted, and a run in between posts nothing', async () => {
    const resumedLogPath = path.join(runDir, 'events-2.jsonl');
    fs.writeFileSync(resumedLogPath, `${workerLogLines.openCodeToolCall}\n`);
    // Newer than events.jsonl whatever the disk clock's granularity: the newest log is the live one.
    const newerAt = new Date(Date.now() + 1000);
    fs.utimesSync(resumedLogPath, newerAt, newerAt);

    secondLine = await waitForNewStatusLine('the second status line');
    const secondLineSeenAtMs = Date.now();
    assert.match(secondLine.text, new RegExp(`^${statusLinePrefix}\\d+ min · now: bash: Lint the sources$`), secondLine.text);
    assert.ok(getReportedMinutes(secondLine) > getReportedMinutes(firstLine), 'the elapsed time counts from the watch\'s creation and grows');
    assertSilentAndUnpinned(secondLine);

    await getCharness().waitFor('the first line to be deleted', replyTimeoutMs, () => fakeTelegram.getMessage(firstLine.message_id)?.isDeleted === true);
    assert.deepEqual(listVisibleStatusLines().map((line) => line.message_id), [secondLine.message_id], 'one line at a time, at the bottom');
    // Between the sightings: the run that posted line 2 and, when the interval holds, the tick before it that passed and posted
    // nothing. With every run posting (no interval) line 2 would come from the very next tick and this would count ONE.
    assert.ok(
      countRunsStartedBetween(firstLineSeenAtMs, secondLineSeenAtMs) >= 2,
      'a check run passed between the two lines without posting one: the interval holds',
    );
    assert.equal(countStatusPosts(), 2, 'two lines were posted in all');
    assert.equal(countAgentPrompts(), promptsAfterArming, 'still no agent turn');
  });

  it('the answers-only view shows no status line: the line is deleted and two whole check runs post nothing', async () => {
    await topic.sendAndAwaitReply('/verbosity answers', 'This topic shows: Answers only');
    await getCharness().waitFor('the status line to be deleted', checkRunTimeoutMs, () => listVisibleStatusLines().length === 0);
    const postsAtDeletion = countStatusPosts();
    const deletedAtMs = Date.now();
    // The interval alone would have a line due again by the second run: only the view can keep it away.
    await getCharness().waitFor('two check runs to finish', answersOnlyRunCount * checkRunTimeoutMs, () => countFinishedRunsSince(deletedAtMs) >= answersOnlyRunCount);
    assert.equal(listVisibleStatusLines().length, 0);
    assert.equal(countStatusPosts(), postsAtDeletion, 'no line was posted while the topic shows answers only');
    assert.equal(countAgentPrompts(), promptsAfterArming, 'still no agent turn');
  });

  let thirdLine: FakeTelegramMessage;

  it('back on the stream view the lines resume', async () => {
    await topic.sendAndAwaitReply('/verbosity stream', 'This topic shows: Stream only');
    thirdLine = await waitForNewStatusLine('a status line after the view is back on the stream');
    assert.match(thirdLine.text, new RegExp(`^${statusLinePrefix}\\d+ min · now: bash: Lint the sources$`), thirdLine.text);
    assertSilentAndUnpinned(thirdLine);
  });

  it('leaving the folder («Leave current dir» on the /bind picker): the status line is deleted, the watch is parked, and no run and no line follows', async () => {
    const [lineBeforeLeaving] = listVisibleStatusLines();
    assert.equal(listVisibleStatusLines().length, 1, 'one line is in the topic when the operator leaves');
    const postsBeforeLeaving = countStatusPosts();

    const picker = await topic.sendAndAwaitReply('/bind', enDict['bind.current'].replace('{subdir}', topicFolder));
    await topic.tapAndAwaitAnswer(picker, bindLeaveCurrentCallback);
    await topic.waitForMessage('the unbound notice', (message) => message.message_id > picker.message_id && message.text === enDict['thread.unbound']);
    const leftAtMs = Date.now();

    // The line goes with the pause, before the binding: a parked watch never runs again to take it away.
    assert.ok(
      fakeTelegram.listCalls('deleteMessage').some((call) => Number(call.payload.message_id) === lineBeforeLeaving.message_id),
      'the bot asked the Bot API to delete the line',
    );
    assert.equal(fakeTelegram.getMessage(lineBeforeLeaving.message_id)?.isDeleted, true);
    assert.deepEqual(listVisibleStatusLines(), [], 'no status line is left under a watch that no longer watches');
    await getCharness().waitFor('the watch to be persisted as parked', replyTimeoutMs, () => {
      const watch = readPersistedSchedules().find((record) => record.id === watchId);
      return watch?.isPaused === true && watch.pauseReason === 'unbound' && watch.statusMessageId === undefined;
    });

    // A parked watch has no timer: the cron's next tick passes without a run and without a line.
    await getCharness().waitFor('the next check tick to have passed', parkedWatchObservationMs + replyTimeoutMs, () => Date.now() > leftAtMs + parkedWatchObservationMs);
    assert.equal(countRunsStartedBetween(leftAtMs, Date.now()), 0, 'the parked watch did not run');
    assert.equal(countStatusPosts(), postsBeforeLeaving, 'and no line was posted');
    assert.deepEqual(listVisibleStatusLines(), []);
    assert.equal(countAgentPrompts(), promptsAfterArming, 'still no agent turn');
  });

  let resumedLine: FakeTelegramMessage;

  it('the folder bound again: the watch resumes and a line returns at the next due run', async () => {
    await topic.sendAndAwaitReply(`/bind ${topicFolder}`, `Bound to \`${topicFolder}\``);
    resumedLine = await waitForNewStatusLine('a status line after the topic is bound again');
    assert.match(resumedLine.text, new RegExp(`^${statusLinePrefix}\\d+ min · now: bash: Lint the sources$`), resumedLine.text);
    assert.ok(getReportedMinutes(resumedLine) > getReportedMinutes(thirdLine), 'the elapsed time still counts from the watch\'s creation');
    assertSilentAndUnpinned(resumedLine);
    const watch = readPersistedSchedules().find((record) => record.id === watchId);
    assert.equal(watch?.isPaused, undefined, 'the watch is running again');
  });

  it('the worker finishes: the status line is deleted, the alert is pinned silently, the agent is woken', async () => {
    getWorker().kill('SIGKILL');
    await getCharness().waitFor('the check alert to be pinned', checkRunTimeoutMs, () => fakeTelegram.pinEvents.some((event) => event.kind === 'pin' && (fakeTelegram.getMessage(event.messageId)?.text ?? '').includes(alertMark)));
    const alertPin = fakeTelegram.pinEvents.find((event) => event.kind === 'pin' && (fakeTelegram.getMessage(event.messageId)?.text ?? '').includes(alertMark));
    assert.ok(alertPin);
    alertMessageId = alertPin.messageId;
    assert.equal(alertPin.isSilent, true, 'a finished worker must not ring the muted operator');
    assert.match(fakeTelegram.getMessage(alertMessageId)?.text ?? '', new RegExp(`worker ${getWorkerPid()} exited`), 'the recipe said why');
    assert.equal(fakeTelegram.getMessage(resumedLine.message_id)?.isDeleted, true, 'a «works …» line under a finished worker would be wrong');
    assert.deepEqual(listVisibleStatusLines(), [], 'no status line under the alert');
    await getCharness().waitFor('the agent woken by the check to list its schedules', agentTimeoutMs, () => getToolCalls('schedule_list').length === 1);
    assert.equal(countAgentPrompts(), promptsAfterArming + 1, 'the failure woke the agent once — the only prompt since it armed the watch');
  });

  it('the agent cancels the watch: the alert is unpinned, the watch is gone, and no status line of the flow is left', async () => {
    await getCharness().waitFor('the agent to cancel the watch', agentTimeoutMs, () => getToolCalls('schedule_cancel').length === 1);
    const [cancelled] = getToolCalls('schedule_cancel');
    assert.match(cancelled.outcome, /1 pinned alert\(s\) unpinned/, cancelled.outcome);
    assert.doesNotMatch(cancelled.outcome, /status line/, 'the failure had already taken the line away');
    await getCharness().waitFor('the alert to be unpinned', replyTimeoutMs, () => !fakeTelegram.listPinnedMessageIds().includes(alertMessageId));
    await getCharness().waitFor('the watch to be gone from the persisted state', replyTimeoutMs, () => readPersistedSchedules().every((record) => record.name !== fakeStatusWatchJobName));

    assert.deepEqual(listVisibleStatusLines(), []);
    assert.ok(seenStatusMessageIds.length >= 4, 'the four lines the steps waited for were posted');
    for (const messageId of seenStatusMessageIds) assert.equal(fakeTelegram.getMessage(messageId)?.isDeleted, true, `status line ${messageId} was deleted`);
    assert.ok(
      fakeTelegram.listCalls('editMessageText').every((call) => !String(call.payload.text).startsWith(statusLinePrefix)),
      'a line is replaced by a new message, never edited in place (an edit would not bump the topic)',
    );
  });
});
