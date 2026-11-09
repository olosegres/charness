/**
 * @description A watch's alert from start to finish, at PROCESS level: the BUILT charness started the way an
 * isolated instance is (`scripts/run-isolated.sh`) against the fake Bot API (`telegramE2e/fakeTelegram.ts`), with the
 * fake `claude` playing an orchestrator the way the `charness-orchestration` skill tells it to. The closest offline stand-in
 * for an agent really arming the three-signal watch (plan V9). One flow, in order:
 *
 *   boot → a topic bound, a Claude session started
 *   → the agent arms a watch with `schedule_create`: the REAL worker-watch recipe (`scheduler/workerWatch.ts`) on a
 *     worker that is gone, cron every minute — WITHOUT a status source, so for the bot it is an ordinary check (the
 *     «worker finished» sentence belongs to a watch with a run directory: `workerStatusE2e.test.ts`)
 *   → the check fails: ONE silent sentence is posted — «🔔 Check … fired — waking the agent.» — with the failure and the
 *     output under it, never the command and NEVER pinned; the agent is woken with the watch's prompt. Telegram is made to
 *     REFUSE the expandable-quotation markup of that one message (the fake answers «can't parse entities»), so the flow proves
 *     the fallback: the same words arrive as plain text, with no tag and no entity shown (the quotation itself, and its
 *     escaping, is proved by `telegramViewsE2e.test.ts`)
 *   → the agent handles the wake as the skill says — `schedule_list`, `schedule_cancel`; nothing was pinned, so nothing
 *     is unpinned, and the watch is gone from the persisted state
 *   → the THIRD signal: the agent arms the same recipe on a LIVE worker that keeps writing (a real process), after it has
 *     `touch`ed the run directory's `watch-armed` marker as the skill says; the check passes; then the marker ages past
 *     2 h 30 min (the test sets its mtime — time passing) and the next run fails with exit 3: the same silent sentence of an
 *     ordinary check, the recipe's own line under it, no command, no pin, the agent woken, the watch cancelled.
 *
 * Nothing leaves the machine: the Bot API is on loopback and the agent is a fake. Everything the test starts is
 * stopped in `after`.
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
  fakeGoneWorkerPid,
  fakeStatusWatchTargetFileName,
  fakeWatchJobName,
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
import type { ScheduleRunRecord } from '../scheduler/runLedger';
import type { ScheduleRecord } from '../scheduler/types';
import { workerWatchArmedFileName } from '../scheduler/workerWatch';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const topicThreadId = 151;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const topicFolder = 'watch-flow';
const launchLine = 'Launching Telegraf bot (long polling';
const alertMark = `Check "${fakeWatchJobName}" fired`;
/** The markup of the folded part: the only thing the fake Bot API is told to refuse. */
const foldedMarkup = '<blockquote expandable>';

const bootTimeoutMs = 60 * 1000;
const replyTimeoutMs = 20 * 1000;
const agentTimeoutMs = 60 * 1000;
/** A cron of every minute fires at the next minute boundary, then the check runs: up to a minute and a little. */
const checkFireTimeoutMs = 2 * 60 * 1000;
/** The fake's watch cron (`* * * * *`) fires every minute. */
const watchCronIntervalMs = 60 * 1000;
const msPerMinute = 60 * 1000;
/** How long ago the marker of the long run is made to be: a literal, well past the recipe's 2 h 30 min, so the test does not move with the window it checks. */
const armedLongAgoMs = 3 * 60 * msPerMinute;
/** A marker the agent touched right before arming is this young when the test looks at it. */
const markerFreshMs = 5 * msPerMinute;

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let topic: TopicDriver;
let defaultTmuxSessionsBefore: string[] = [];
let alertMessageId = 0;
/** The live worker of the third signal's case: a real process, killed when the flow ends. */
let longRunWorker: ChildProcess | null = null;

function getLayout(): IsolatedInstanceLayout {
  if (!layout) throw new Error('the instance layout is not created yet');
  return layout;
}

function getCharness(): IsolatedCharness {
  if (!charness) throw new Error('charness is not started yet');
  return charness;
}

function removeInstanceSync(): void {
  longRunWorker?.kill('SIGKILL');
  removeIsolatedInstanceSync(layout, charness);
}

function getToolCalls(tool: string): FakeClaudeToolCall[] {
  return readJsonLines<FakeClaudeToolCall>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.toolCalls)).filter((call) => call.tool === tool);
}

function readPersistedSchedules(): ScheduleRecord[] {
  const persisted: { schedules?: Record<string, ScheduleRecord> } = JSON.parse(fs.readFileSync(path.join(getLayout().dataDir, 'state.json'), 'utf8'));
  return Object.values(persisted.schedules ?? {});
}

/** The runs of one watch that have finished, from the run ledger (a fire writes its record first, `deliveredAt` once its delivery resolved). */
function countFinishedRuns(jobId: string): number {
  return readJsonLines<ScheduleRunRecord>(path.join(getLayout().dataDir, 'scheduler-runs.jsonl'))
    .filter((run) => run.jobId === jobId && run.deliveredAt !== undefined).length;
}

describe('A worker watch end to end: built charness, fake Bot API, a fake orchestrating agent', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-watch-', [topicFolder], getFlowDeadlineMs());
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
      OPENCODE_URL: `http://127.0.0.1:${await getFreePort()}`,
      SCHEDULER_MCP_PORT: (await getFreeFixedPort()).toString(),
      // A watch every minute (the production minimum is five), so the check fires within the flow's wait.
      ...getTelegramFlowTestTimingsEnv({ scheduleMinFireIntervalMs: watchCronIntervalMs }),
    });
  });

  after(async () => {
    longRunWorker?.kill('SIGKILL');
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

  it('the agent arms the watch with the real recipe', async () => {
    fakeTelegram.failNextCall(
      'sendMessage',
      'Bad Request: can\'t parse entities: Unsupported start tag "x" at byte offset 0',
      (payload) => payload.parse_mode === 'HTML' && String(payload.text).includes(foldedMarkup),
    );
    fakeTelegram.pushOperatorMessage(topicThreadId, 'W-1 [fake:arm-watch] watch the worker you just launched');
    await getCharness().waitFor('the agent to arm the watch', agentTimeoutMs, () => getToolCalls('schedule_create').length === 1);
    const [created] = getToolCalls('schedule_create');
    assert.doesNotMatch(created.outcome, /^error:/, created.outcome);
    // `state.json` is written a moment after the change (the save is debounced): wait for the record, do not read it at once.
    await getCharness().waitFor('the watch to be persisted', replyTimeoutMs, () => readPersistedSchedules().some((record) => record.name === fakeWatchJobName));
    const [watch] = readPersistedSchedules().filter((record) => record.name === fakeWatchJobName);
    assert.equal(watch.deliveryKind, 'check');
    assert.ok(!('isPinSilent' in watch), 'there is no pin option to persist any more');
    assert.match(
      created.outcome,
      new RegExp(`^Scheduled "${fakeWatchJobName}": checks; next: \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}\\nid: ${watch.id}$`),
      'one line — what and when, not the raw cron and not the recipe — and the id',
    );
    assert.doesNotMatch(created.outcome, /\* \* \*/, 'no cron expression in what the topic shows');
    assert.doesNotMatch(created.outcome, /kill -0/, 'the command is not part of the confirmation the topic shows');
  });

  it('the check fails and Telegram refuses the markup: the same words arrive as plain text — one silent sentence, the reason under it, no command, no tag, NO pin — and the agent is woken', async () => {
    await getCharness().waitFor('the check alert', checkFireTimeoutMs, () => topic.listMessages().some((message) => message.text.includes(alertMark)));
    const alert = topic.listMessages().find((message) => message.text.includes(alertMark));
    assert.ok(alert);
    alertMessageId = alert.message_id;
    assert.equal(alert.isSilent, true, 'the retry is as silent as the refused send');
    assert.equal(alert.parseMode, undefined, 'the retry went out without a parse mode');
    assert.equal(
      alert.text,
      `🔔 Check "${fakeWatchJobName}" fired — waking the agent.\n\nexit 1\n\nworker ${fakeGoneWorkerPid} exited`,
      'the sentence, then the failure and the recipe\'s own output — the same words the quotation would have held',
    );
    assert.doesNotMatch(alert.text, /<|>|&(lt|gt|amp);/, 'no tag and no entity shown literally');
    const alertSends = fakeTelegram.listCalls('sendMessage').filter((call) => String(call.payload.text).includes(alertMark));
    assert.deepEqual(
      alertSends.map((call) => call.payload.parse_mode),
      ['HTML', undefined],
      'the HTML send was refused once, then the plain one went through',
    );
    assert.ok(String(alertSends[0].payload.text).includes(foldedMarkup), 'the refused send carried the quotation');
    assert.doesNotMatch(alert.text, /kill -0|\$ |find /, 'the command stays out of the topic');
    await getCharness().waitFor('the agent woken by the check to list its schedules', agentTimeoutMs, () => getToolCalls('schedule_list').length === 1);
    assert.ok(
      !fakeTelegram.pinEvents.some((event) => event.messageId === alertMessageId || (fakeTelegram.getMessage(event.messageId)?.text ?? '').includes(alertMark)),
      'the alert has no pin event of any kind',
    );
  });

  it('the agent cancels the watch: there is nothing pinned to unpin, and the watch is gone', async () => {
    await getCharness().waitFor('the agent to cancel the watch', agentTimeoutMs, () => getToolCalls('schedule_cancel').length === 1);
    const [cancelled] = getToolCalls('schedule_cancel');
    assert.doesNotMatch(cancelled.outcome, /pinned/, cancelled.outcome);
    assert.deepEqual(fakeTelegram.pinEvents.filter((event) => event.kind === 'unpin'), [], 'no unpin: nothing was pinned');
    await getCharness().waitFor('the watch to be gone from the persisted state', replyTimeoutMs, () => readPersistedSchedules().every((record) => record.name !== fakeWatchJobName));
  });

  let longRunRunDir = '';
  let longRunMarkerPath = '';

  it('the third signal: the agent touches the marker and arms the same recipe on a LIVE worker that keeps writing — the check passes (a run of it finished and raised nothing)', async () => {
    const startedWorker = spawn('sleep', ['3600'], { stdio: 'ignore' });
    longRunWorker = startedWorker;
    await new Promise<void>((resolve, reject) => {
      startedWorker.once('spawn', resolve);
      startedWorker.once('error', reject);
    });
    longRunRunDir = path.join(getLayout().testRoot, 'long-run');
    longRunMarkerPath = path.join(longRunRunDir, workerWatchArmedFileName);
    fs.mkdirSync(longRunRunDir);
    fs.writeFileSync(path.join(longRunRunDir, 'events.jsonl'), '{}\n');
    const target: FakeStatusWatchTarget = { pid: startedWorker.pid ?? 0, runDir: longRunRunDir };
    assert.ok(target.pid > 0, 'the worker has a process id');
    fs.writeFileSync(path.join(getLayout().fakeStateDir, fakeStatusWatchTargetFileName), JSON.stringify(target));
    // The alert of this watch is refused its markup too, so the whole text is one plain string the assertions can compare.
    fakeTelegram.failNextCall(
      'sendMessage',
      'Bad Request: can\'t parse entities: Unsupported start tag "x" at byte offset 0',
      (payload) => payload.parse_mode === 'HTML' && String(payload.text).includes(foldedMarkup),
    );
    const createsBefore = getToolCalls('schedule_create').length;
    fakeTelegram.pushOperatorMessage(topicThreadId, 'W-2 [fake:arm-watch] watch the long run you just launched');
    await getCharness().waitFor('the agent to arm the second watch', agentTimeoutMs, () => getToolCalls('schedule_create').length === createsBefore + 1);
    const created = getToolCalls('schedule_create')[createsBefore];
    assert.doesNotMatch(created.outcome, /^error:/, created.outcome);
    await getCharness().waitFor('the second watch to be persisted', replyTimeoutMs, () => readPersistedSchedules().some((record) => record.name === fakeWatchJobName));
    const [watch] = readPersistedSchedules().filter((record) => record.name === fakeWatchJobName);
    assert.match(watch.checkCommand ?? '', new RegExp(`kill -0 ${target.pid}\\b`), 'the recipe is armed on the live worker');
    assert.ok(fs.existsSync(longRunMarkerPath), 'the agent touched the marker before arming, as the skill says');
    assert.ok(Date.now() - fs.statSync(longRunMarkerPath).mtimeMs < markerFreshMs, 'and it is fresh');

    // The pass is PROVEN, not assumed: a run of this watch finished with the fresh marker and raised nothing. Without it the next
    // case would also be satisfied by a recipe that fails at once (the marker in the wrong folder, a quoting slip in `find`).
    await getCharness().waitFor('a run of the second watch to finish', checkFireTimeoutMs, () => countFinishedRuns(watch.id) >= 1);
    assert.ok(!topic.listMessages().some((message) => message.message_id > alertMessageId && message.text.includes(alertMark)), 'no alert of the second watch while its marker is fresh');
    assert.notEqual(readPersistedSchedules().find((record) => record.id === watch.id)?.isCheckFailing, true, 'the finished run passed');
  });

  it('the watch was armed over 2 h 30 min ago and the worker is alive and writing: the run fails with the recipe\'s third exit code — one silent sentence, the recipe\'s own line under it, no command, NO pin — and the agent is woken', async () => {
    const firstAlertId = alertMessageId;
    const listsBefore = getToolCalls('schedule_list').length;
    // Time passing, as the test can make it: the marker is older than the window; the worker's log is fresh (the silence signal stays quiet).
    const armedLongAgo = new Date(Date.now() - armedLongAgoMs);
    fs.utimesSync(longRunMarkerPath, armedLongAgo, armedLongAgo);
    const eventsNow = new Date();
    fs.utimesSync(path.join(longRunRunDir, 'events.jsonl'), eventsNow, eventsNow);

    await getCharness().waitFor('the second check alert', checkFireTimeoutMs, () => topic.listMessages().some((message) => message.message_id > firstAlertId && message.text.includes(alertMark)));
    const alert = topic.listMessages().find((message) => message.message_id > firstAlertId && message.text.includes(alertMark));
    assert.ok(alert);
    assert.equal(alert.isSilent, true);
    assert.equal(
      alert.text,
      `🔔 Check "${fakeWatchJobName}" fired — waking the agent.\n\nexit 3\n\n${longRunMarkerPath}: older than 2 h 30 min`,
      'the sentence, then exit 3 and the recipe\'s own line: the third signal, not the first (the process lives) and not the second (the log is fresh)',
    );
    assert.doesNotMatch(alert.text, /kill -0|\$ |find /, 'the command stays out of the topic');
    assert.ok(longRunWorker && longRunWorker.exitCode === null && longRunWorker.signalCode === null, 'the worker is still alive: only the clock fired');
    await getCharness().waitFor('the agent woken by the check to list its schedules', agentTimeoutMs, () => getToolCalls('schedule_list').length === listsBefore + 1);
    assert.ok(!fakeTelegram.pinEvents.some((event) => event.messageId === alert.message_id), 'the alert has no pin event');
    await getCharness().waitFor('the agent to cancel the second watch', agentTimeoutMs, () => getToolCalls('schedule_cancel').length === 2);
    await getCharness().waitFor('the second watch to be gone from the persisted state', replyTimeoutMs, () => readPersistedSchedules().every((record) => record.name !== fakeWatchJobName));
    assert.deepEqual(fakeTelegram.pinEvents.filter((event) => event.kind === 'unpin'), [], 'no unpin: nothing was pinned');
  });
});
