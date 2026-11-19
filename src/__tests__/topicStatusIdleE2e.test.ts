/**
 * @description The idle stop and the status mark of a topic's name at PROCESS level: the BUILT charness started the way an isolated
 * instance is (`scripts/run-isolated.sh`) against the fake Bot API, with the fake `claude` as the agent and the idle window cut to seconds
 * (`AGENT_IDLE_MINUTES`); the settle time and the gap of the marks are cut too (`CHARNESS_TEST_TIMINGS`). One flow, in order:
 *
 *   boot → the owner's topic «Deploy» is bound, its agent started and given one answered turn: the name reads ✅
 *   → the topic sits idle: the conversation is compacted and the bot stops the process at the idle mark (the conversation is kept): the
 *     name takes 💤 — the idle stop is what «asleep» means (the per-turn backend's stop after every turn is not: see `topicStatusE2e`)
 *   → a short reply that wakes it: the process comes back, takes the turn and stays up — the name goes back to ✅ and no ⏳ is ever
 *     written for a turn that ended inside the settle time
 *
 * Nothing leaves the machine: the Bot API is on loopback and the agent is a fake. Everything the test starts is stopped in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import { FakeTelegram } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import {
  builtCliPath,
  createIsolatedInstanceLayout,
  exitOnSignal,
  getFlowDeadlineMs,
  getFreeFixedPort,
  getUnservedPort,
  IsolatedCharness,
  listTmuxSessions,
  removeIsolatedInstanceSync,
  writeFakeClaudeLauncher,
  writeInstanceEnvFile,
  type IsolatedInstanceLayout,
} from './e2e/isolatedCharness';
import { startCharnessOnInstance } from './e2e/fallbackFlowKit';
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const projectFolder = 'proj';
const deployBase = 'Deploy';

/** The idle window of the instance, in minutes (12 s): the fire comes this long after the last activity. */
const idleWindowMinutes = '0.2';
/** The windows of the topic marks in this flow (production: 20 s, 60 s, 5 min, 5 s). */
const settleMs = 800;
const gapMs = 2000;
const sweepMs = 3000;
const bootWaveDelayMs = 1000;

const replyTimeoutMs = 20 * 1000;
/** The idle mark, the compaction it makes and the stop after the next window, with room for a loaded box. */
const idleStopTimeoutMs = 120 * 1000;
/** A name that must wait out the settle time and the gap, with room for a loaded box. */
const renameTimeoutMs = gapMs + settleMs + 15 * 1000;
/** The line the bot logs once the idle fire has stopped the agent's process (the conversation then sleeps). */
const idleStopLine = 'process stopped; the session sleeps';

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let topic: TopicDriver;
let topicThreadId = 0;
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

/** The names the bot gave the topic, in order. */
function listRenamedTo(): string[] {
  return fakeTelegram.listCalls('editForumTopic').filter((call) => call.payload.message_thread_id === topicThreadId).map((call) => String(call.payload.name));
}

async function waitForTopicName(name: string, timeoutMs = renameTimeoutMs): Promise<void> {
  await getCharness().waitFor(`the topic to be called «${name}» (it is «${fakeTelegram.getTopicName(topicThreadId)}»)`, timeoutMs, () => fakeTelegram.getTopicName(topicThreadId) === name);
}

describe('The idle stop shows as 💤 in the topic name, end to end: built charness, fake Bot API, fake agent', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-topicidle-', [projectFolder], getFlowDeadlineMs());
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

  it('boots, binds the owner\'s topic «Deploy», starts its agent and gives it one answered turn: the name reads ✅', async () => {
    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    topicThreadId = fakeTelegram.pushTopicCreated(deployBase);
    topic = new TopicDriver(fakeTelegram, getCharness, topicThreadId, replyTimeoutMs);
    await topic.waitForMessage('the welcome of the new topic', () => true);
    await topic.sendAndAwaitReply(`/bind ${projectFolder}`, `Bound to \`${projectFolder}\``);
    await topic.sendAndAwaitReply('/claude', 'ready in');
    const warmUpMessageId = fakeTelegram.pushOperatorMessage(topicThreadId, 'WARM-1 [fake:answer] hello');
    await topic.waitForMessage('the warm-up answer', (message) => message.message_id > warmUpMessageId);
    await waitForTopicName(`${deployBase} ✅`);
  });

  it('the idle mark compacts the quiet conversation and stops the process, the conversation kept: the name takes 💤', async () => {
    await getCharness().waitFor('the idle stop', idleStopTimeoutMs, () => getCharness().output.includes(idleStopLine));
    await waitForTopicName(`${deployBase} 💤`);
  });

  it('a short reply wakes it: the process comes back and stays up — the name goes back to ✅, and no ⏳ was written for a turn that ended inside the settle time', async () => {
    const renamesBefore = listRenamedTo().length;
    const wakeMessageId = fakeTelegram.pushOperatorMessage(topicThreadId, 'WAKE-1 [fake:answer] are you there?');
    await topic.waitForMessage('the answer of the woken agent', (message) => message.message_id > wakeMessageId && message.text.includes('WAKE-1'));
    await waitForTopicName(`${deployBase} ✅`);
    assert.deepEqual(listRenamedTo().slice(renamesBefore), [`${deployBase} ✅`], 'straight from 💤 to ✅, nothing on the way');
  });
});
