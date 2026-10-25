/**
 * @description A worker watch's alert from start to finish, at PROCESS level: the BUILT charness started the way an
 * isolated instance is (`scripts/run-isolated.sh`) against the fake Bot API (`telegramE2e/fakeTelegram.ts`), with the
 * fake `claude` playing an orchestrator the way the `charness-manager` skill tells it to. The closest offline stand-in
 * for an agent really arming the two-signal watch (plan V9). One flow, in order:
 *
 *   boot → a topic bound, a Claude session started
 *   → the agent arms a watch with `schedule_create`: the REAL worker-watch recipe (`scheduler/workerWatch.ts`) on a
 *     worker that is gone, cron every minute, `isPinSilent: true`
 *   → the check fails (the worker "finished"): the alert is posted and pinned SILENTLY, and the agent is woken with the
 *     watch's prompt
 *   → the agent handles the wake as the skill says — `schedule_list`, `schedule_cancel` — and the cancel unpins exactly
 *     that alert; the watch is gone from the persisted state, so a finished worker leaves nothing pinned.
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
import { fakeClaudeLogFileNames, fakeWatchJobName, type FakeClaudeToolCall } from './jiraE2e/fakeClaudeContract';
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
const alertMark = `Check "${fakeWatchJobName}" failed`;

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

  it('the agent arms the watch with the real recipe and a silent pin', async () => {
    fakeTelegram.pushOperatorMessage(topicThreadId, 'W-1 [fake:arm-watch] watch the worker you just launched');
    await getCharness().waitFor('the agent to arm the watch', agentTimeoutMs, () => getToolCalls('schedule_create').length === 1);
    const [created] = getToolCalls('schedule_create');
    assert.doesNotMatch(created.outcome, /^error:/, created.outcome);
    // `state.json` is written a moment after the change (the save is debounced): wait for the record, do not read it at once.
    await getCharness().waitFor('the watch to be persisted', replyTimeoutMs, () => readPersistedSchedules().some((record) => record.name === fakeWatchJobName));
    const [watch] = readPersistedSchedules().filter((record) => record.name === fakeWatchJobName);
    assert.equal(watch.deliveryKind, 'check');
    assert.equal(watch.isPinSilent, true);
  });

  it('the worker is gone: the alert is pinned silently and the agent is woken with the watch\'s prompt', async () => {
    await getCharness().waitFor('the check alert to be pinned', checkFireTimeoutMs, () => fakeTelegram.pinEvents.some((event) => event.kind === 'pin' && (fakeTelegram.getMessage(event.messageId)?.text ?? '').includes(alertMark)));
    const alertPin = fakeTelegram.pinEvents.find((event) => event.kind === 'pin' && (fakeTelegram.getMessage(event.messageId)?.text ?? '').includes(alertMark));
    assert.ok(alertPin);
    alertMessageId = alertPin.messageId;
    assert.equal(alertPin.isSilent, true, 'a finished worker must not ring the muted operator');
    assert.match(fakeTelegram.getMessage(alertMessageId)?.text ?? '', /worker 4194305 exited/, 'the recipe said why');
    await getCharness().waitFor('the agent woken by the check to list its schedules', agentTimeoutMs, () => getToolCalls('schedule_list').length === 1);
  });

  it('the agent cancels the watch, which unpins exactly that alert, and the watch is gone', async () => {
    await getCharness().waitFor('the agent to cancel the watch', agentTimeoutMs, () => getToolCalls('schedule_cancel').length === 1);
    const [cancelled] = getToolCalls('schedule_cancel');
    assert.match(cancelled.outcome, /1 pinned alert\(s\) unpinned/, cancelled.outcome);
    await getCharness().waitFor('the alert to be unpinned', replyTimeoutMs, () => !fakeTelegram.listPinnedMessageIds().includes(alertMessageId));
    const unpins = fakeTelegram.pinEvents.filter((event) => event.kind === 'unpin');
    assert.deepEqual(unpins.map((event) => event.messageId), [alertMessageId], 'that alert and nothing else');
    await getCharness().waitFor('the watch to be gone from the persisted state', replyTimeoutMs, () => readPersistedSchedules().every((record) => record.name !== fakeWatchJobName));
  });
});
