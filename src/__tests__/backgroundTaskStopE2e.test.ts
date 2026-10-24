/**
 * @description The agent's OWN pending work and the automatic stops, at PROCESS level: the BUILT charness started the
 * way an isolated instance is (`scripts/run-isolated.sh`) against the fake Bot API of `telegramE2e/fakeTelegram.ts`,
 * with the fake `claude` (`jiraE2e/fakeClaude.ts`, mode `background-notify`) leaving a background task running after
 * its answer and ending it the way the real CLI 2.1.310 was measured to: the task's end, the empty background list,
 * then the task's own turn, whose first output comes only after the API round-trip (8 s here). The idle window and
 * the pending-work hold are cut to seconds (`AGENT_IDLE_MINUTES`, `AGENT_BACKGROUND_HOLD_MINUTES`). One flow, in order:
 *
 *   boot → the topic is bound → `/claude` → BG-1 answered; its background task runs
 *   → the bot restarts after an upgrade that changed its tools: the adopted process runs a stale tool list, and is
 *     NOT stopped early — the task ends, the task's own turn reaches the topic from the SAME process (the incident: the
 *     stop landed in the gap before that turn's first output and the result was lost) — then the normal idle
 *     lifecycle: the idle compaction first, the stop after it
 *   → BG-2 leaves a task that never reports: the idle fire keeps the process while the hold lasts and looks again,
 *     and once the hold is spent the process is compacted and stopped — a forgotten task does not pin it forever
 *
 * Nothing leaves the machine: the Bot API is on loopback and the agent is a fake. Everything the test starts is stopped
 * in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import {
  fakeClaudeBackgroundReleaseFileName,
  fakeClaudeLogFileNames,
  fakeNotificationTurnLatencyMs,
  getFakeBackgroundTaskFinishedText,
  getLaunchSessionId,
  type FakeClaudeTurn,
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
import { getAgentTurns, getSessionLaunches, restartCharnessWithState, startCharnessOnInstance } from './e2e/fallbackFlowKit';
import { checkIsPidAlive } from '../utils/jsonStreamHost';
import { claudeJsonStreamUsageLogPrefix } from '../adapters/claudeJsonStreamAdapter';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const topicThreadId = 111;
const topicKey = `${group.id}:${topicThreadId}`;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const projectFolder = 'background-work';

/** The idle window, cut to seconds. */
const idleWindowMinutes = '0.2';
const idleWindowMs = 12 * 1000;
/** The pending-work hold, cut to a minute: long enough for the restart and the release, short enough to wait out. */
const backgroundHoldMinutes = '1';
const backgroundHoldMs = 60 * 1000;
const replyTimeoutMs = 20 * 1000;
/** The idle compaction and stop after the task's turn: one idle window plus the compaction turn and the teardown. */
const idleStopTimeoutMs = idleWindowMs + 30 * 1000;
/** The stop after a spent hold: the hold, the idle fires that look again, then the compaction and the teardown. */
const holdStopTimeoutMs = backgroundHoldMs + idleWindowMs + 30 * 1000;

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let topic: TopicDriver;
let defaultTmuxSessionsBefore: string[] = [];
/** The conversation the topic's agent runs. */
let sessionId = '';

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

/** The process the turn labelled `label` ran in (its first turn). */
function getTurnPid(label: string): number {
  const [turn] = getAgentTurns(getLayout(), label);
  if (!turn) throw new Error(`no turn of ${label} recorded`);
  return turn.pid;
}

function listTaskTurns(): Array<FakeClaudeTurn & { origin?: string }> {
  return readJsonLines<FakeClaudeTurn & { origin?: string }>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.turns)).filter((turn) => turn.origin === 'task-notification');
}

function listCompactions(): Array<{ sessionId: string; pid: number }> {
  return readJsonLines<{ sessionId: string; pid: number }>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.compactions));
}

/** Where in the bot's output `text` first appears after `fromIndex`; -1 when it does not. */
function findOutput(text: string, fromIndex: number): number {
  return getCharness().output.indexOf(text, fromIndex);
}

const stopLine = `[compact-on-idle] ${topicKey} process stopped; the session sleeps`;

describe('The agent\'s own background work is never cut off by an automatic stop: built charness, fake Bot API, fake claude', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-bgtask-', [projectFolder], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fs.mkdirSync(layout.fakeStateDir, { recursive: true });
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
      AGENT_IDLE_MINUTES: idleWindowMinutes,
      AGENT_BACKGROUND_HOLD_MINUTES: backgroundHoldMinutes,
      // A free port nothing listens on: the boot's OpenCode pre-start finds no server and no binary, and gives up.
      OPENCODE_URL: `http://127.0.0.1:${await getFreePort()}`,
      SCHEDULER_MCP_PORT: (await getFreeFixedPort()).toString(),
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

  it('boots, binds the topic, and the agent answers BG-1 and leaves a background task running', async () => {
    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    await topic.sendAndAwaitReply(`/bind ${projectFolder}`, `Bound to \`${projectFolder}\``);
    await topic.sendAndAwaitReply('/verbosity stream_answers', 'This topic shows: Stream + answers');
    await topic.sendAndAwaitReply('/claude', 'ready in');
    fakeTelegram.pushOperatorMessage(topicThreadId, 'BG-1 [fake:background-notify] watch the run');
    await topic.waitForMessage('the answer to BG-1', (message) => message.text.includes('Fake final answer for BG-1'));
    // The turn ends a moment after its answer shows (the answer tool's round-trip): a restart before that cuts the turn.
    await getCharness().waitFor('the end of BG-1\'s turn', replyTimeoutMs, () => findOutput(`${claudeJsonStreamUsageLogPrefix}${topicKey}:`, 0) >= 0);
    const launch = getSessionLaunches(getLayout()).at(-1);
    sessionId = (launch && getLaunchSessionId(launch.argv)) ?? '';
    assert.ok(sessionId, 'the launch carries a conversation id');
    assert.ok(checkIsPidAlive(getTurnPid('BG-1')), 'the process holding the task is alive');
  });

  it('adopted with a stale tool list, the process is not stopped early: the task\'s own turn reaches the topic, then the idle compaction, then the stop', async () => {
    const pid = getTurnPid('BG-1');
    const outputBeforeRestart = getCharness().output.length;
    // An upgrade that changed the bot's tools: the digest the live process was started with no longer matches.
    charness = await restartCharnessWithState(getLayout(), fakeTelegram, getCharness(), (persisted) => {
      const agent = persisted.agents?.[topicKey];
      assert.ok(agent?.mcpToolDigest, 'the topic has a persisted tool digest to make stale');
      agent.mcpToolDigest = 'a-digest-of-an-earlier-build';
    });
    await getCharness().waitFor('the adopt of the stale process', replyTimeoutMs, () => findOutput(`[reattach] ${topicKey}: adopted with a stale tool list`, 0) >= 0);
    assert.ok(checkIsPidAlive(pid), 'the adopted process is alive');

    // The task ends: the background list empties, and the task's turn shows its first output only after the round-trip.
    const outputBeforeRelease = getCharness().output.length;
    fs.writeFileSync(path.join(getLayout().fakeStateDir, fakeClaudeBackgroundReleaseFileName), '');
    const finishedText = getFakeBackgroundTaskFinishedText('BG-1');
    await topic.waitForMessage('the task\'s own turn in the topic', (message) => message.text.includes(finishedText));
    assert.deepEqual(listTaskTurns().map((turn) => turn.pid), [pid], 'the task\'s turn ran in the adopted process, to its end');
    assert.ok(getCharness().output.slice(outputBeforeRelease).indexOf(stopLine) < 0, `no stop in the ${fakeNotificationTurnLatencyMs} ms before the task's turn showed`);
    assert.ok(!getCharness().output.slice(outputBeforeRestart).includes('stopping the adopted process'), 'no early stop of the adopted process');

    // The normal idle lifecycle: compacted in the same process first, stopped after.
    await getCharness().waitFor('the idle compaction of the adopted process', idleStopTimeoutMs, () => listCompactions().some((compaction) => compaction.sessionId === sessionId && compaction.pid === pid));
    await getCharness().waitFor('the idle stop after the compaction', idleStopTimeoutMs, () => findOutput(stopLine, outputBeforeRelease) >= 0);
    assert.ok(!checkIsPidAlive(pid), 'the process is gone');
  });

  it('a task that never reports holds the process only for the hold: the idle fire keeps it and looks again, then the process is compacted and stopped', async () => {
    const outputBefore = getCharness().output.length;
    const compactionsBefore = listCompactions().length;
    fakeTelegram.pushOperatorMessage(topicThreadId, 'BG-2 [fake:background-notify] start a watcher and forget it');
    await topic.waitForMessage('the answer to BG-2', (message) => message.text.includes('Fake final answer for BG-2'));
    const answeredAt = Date.now();
    const pid = getTurnPid('BG-2');

    await getCharness().waitFor('the idle fire to keep the process for its task', idleStopTimeoutMs, () => findOutput(`[compact-on-idle] ${topicKey} process kept: working`, outputBefore) >= 0);
    await getCharness().waitFor('the idle fire to look again', replyTimeoutMs, () => findOutput(`[compact-on-idle] ${topicKey} looks again in`, outputBefore) >= 0);
    assert.ok(checkIsPidAlive(pid), 'kept while the hold lasts');

    await getCharness().waitFor('the stop once the hold is spent', holdStopTimeoutMs, () => findOutput(stopLine, outputBefore) >= 0);
    assert.ok(Date.now() - answeredAt >= backgroundHoldMs, 'not stopped before the hold was spent');
    assert.ok(listCompactions().length > compactionsBefore, 'compacted before the stop');
    assert.ok(!checkIsPidAlive(pid), 'the process is gone');
  });
});
