/**
 * @description A watch's alert from start to finish, at PROCESS level: the BUILT charness started the way an
 * isolated instance is (`scripts/run-isolated.sh`) against the fake Bot API (`telegramE2e/fakeTelegram.ts`), with the
 * fake `claude` playing an orchestrator the way the `charness-manager` skill tells it to. The closest offline stand-in
 * for an agent really arming the two-signal watch (plan V9). One flow, in order:
 *
 *   boot → a topic bound, a Claude session started
 *   → the agent arms a watch with `schedule_create`: the REAL worker-watch recipe (`scheduler/workerWatch.ts`) on a
 *     worker that is gone, cron every minute — WITHOUT a status source, so for the bot it is an ordinary check (the
 *     «worker finished» sentence belongs to a watch with a run directory: `workerStatusE2e.test.ts`)
 *   → the check fails: ONE silent sentence is posted — «🔔 Check … fired — waking the agent.» — with the failure and the
 *     output folded under it in an expandable quotation, never the command and NEVER pinned; the agent is woken with the
 *     watch's prompt
 *   → the agent handles the wake as the skill says — `schedule_list`, `schedule_cancel`; nothing was pinned, so nothing
 *     is unpinned, and the watch is gone from the persisted state.
 *
 * Nothing leaves the machine: the Bot API is on loopback and the agent is a fake. Everything the test starts is
 * stopped in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import { fakeClaudeLogFileNames, fakeGoneWorkerPid, fakeWatchJobName, type FakeClaudeToolCall } from './jiraE2e/fakeClaudeContract';
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
import type { ScheduleRecord } from '../scheduler/types';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const topicThreadId = 151;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const topicFolder = 'watch-flow';
const launchLine = 'Launching Telegraf bot (long polling';
const alertMark = `Check "${fakeWatchJobName}" fired`;

const bootTimeoutMs = 60 * 1000;
const replyTimeoutMs = 20 * 1000;
const agentTimeoutMs = 60 * 1000;
/** A cron of every minute fires at the next minute boundary, then the check runs: up to a minute and a little. */
const checkFireTimeoutMs = 2 * 60 * 1000;
/** The fake's watch cron (`* * * * *`) fires every minute. */
const watchCronIntervalMs = 60 * 1000;

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let topic: TopicDriver;
let defaultTmuxSessionsBefore: string[] = [];
let alertMessageId = 0;

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

function getToolCalls(tool: string): FakeClaudeToolCall[] {
  return readJsonLines<FakeClaudeToolCall>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.toolCalls)).filter((call) => call.tool === tool);
}

function readPersistedSchedules(): ScheduleRecord[] {
  const persisted: { schedules?: Record<string, ScheduleRecord> } = JSON.parse(fs.readFileSync(path.join(getLayout().dataDir, 'state.json'), 'utf8'));
  return Object.values(persisted.schedules ?? {});
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
    fakeTelegram.pushOperatorMessage(topicThreadId, 'W-1 [fake:arm-watch] watch the worker you just launched');
    await getCharness().waitFor('the agent to arm the watch', agentTimeoutMs, () => getToolCalls('schedule_create').length === 1);
    const [created] = getToolCalls('schedule_create');
    assert.doesNotMatch(created.outcome, /^error:/, created.outcome);
    // `state.json` is written a moment after the change (the save is debounced): wait for the record, do not read it at once.
    await getCharness().waitFor('the watch to be persisted', replyTimeoutMs, () => readPersistedSchedules().some((record) => record.name === fakeWatchJobName));
    const [watch] = readPersistedSchedules().filter((record) => record.name === fakeWatchJobName);
    assert.equal(watch.deliveryKind, 'check');
    assert.ok(!('isPinSilent' in watch), 'there is no pin option to persist any more');
    assert.equal(created.outcome, `Scheduled "${fakeWatchJobName}": checks cron * * * * *\nid: ${watch.id}`, 'the topic shows one line and the id, not the recipe');
    assert.doesNotMatch(created.outcome, /kill -0/, 'the command is not part of the confirmation the topic shows');
  });

  it('the check fails: one silent sentence, the reason folded under it, no command, NO pin — and the agent is woken with the watch\'s prompt', async () => {
    await getCharness().waitFor('the check alert', checkFireTimeoutMs, () => topic.listMessages().some((message) => message.text.includes(alertMark)));
    const alert = topic.listMessages().find((message) => message.text.includes(alertMark));
    assert.ok(alert);
    alertMessageId = alert.message_id;
    assert.equal(alert.isSilent, true, 'a check alert is ordinary silent output');
    assert.equal(alert.parseMode, 'HTML', 'the folded part needs Telegram HTML');
    assert.equal(
      alert.text,
      `🔔 Check "${fakeWatchJobName}" fired — waking the agent.\n\n<blockquote expandable>exit 1\n\nworker ${fakeGoneWorkerPid} exited</blockquote>`,
      'the sentence, then the failure and the recipe\'s own output in an expandable quotation',
    );
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
});
