/**
 * @description The boot recovery of a usage-limit episode (`recoverLimitEpisodesFromDisk`), at PROCESS level: the
 * BUILT charness started the way an isolated instance is (`scripts/run-isolated.sh`) against the fake Bot API of
 * `telegramE2e/fakeTelegram.ts` and the fake `claude` (`jiraE2e/fakeClaude.ts`). One flow, in order:
 *
 *   boot → the instance zone is set to UTC, a topic is bound (the default view: a limit wait is a plain notice,
 *     "🚧 Usage limit reached — will auto-resume after reset (~<time>)")
 *   → the topic's agent stops on a session limit whose wording names a CLOCK reset ("resets 10:20am (UTC)")
 *   → the bot is stopped; the wait it armed is gone (as when the wording was not recognised live) and the error is
 *     an hour old, written BEFORE that clock — so the window reset half an hour before the bot comes back. The stdout
 *     log was written to since (as a background sub-agent's frames do), so only the transcript's API-error entry,
 *     with its own timestamp, still says when the error happened
 *   → the bot starts again and recovers the parked episode: the window is over, so it posts NO "usage limit
 *     reached" notice (the reset used to be read against the boot time — tomorrow's 10:20am — and the topic was
 *     told it waits a day for a limit that had already reset); it resumes at once, says so, and the agent takes the
 *     "continue" nudge
 *   → a LIVE limit error is announced whatever its reset says, a reset already past included
 *   → a reset in a NAMED zone (`resets 2:10pm (Europe/Moscow)`, the way Claude Code writes it) is read in that zone:
 *     the notice names it in the instance zone, not the Moscow clock as if it were local.
 *
 * What the unit tests cover instead: the decision table (`limitEpisodeRecovery.test.ts`) and the "window is over"
 * predicate (`apiErrorRetry.test.ts`).
 *
 * Nothing leaves the machine: the Bot API is on loopback and the agent is a fake. Everything the test starts is
 * stopped in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram, generalTopicThreadId } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import {
  builtCliPath,
  createIsolatedInstanceLayout,
  exitOnSignal,
  getFlowDeadlineMs,
  getFreeFixedPort,
  getFreePort,
  IsolatedCharness,
  listTmuxSessions,
  removeIsolatedInstanceSync,
  writeFakeClaudeLauncher,
  writeInstanceEnvFile,
  type IsolatedInstanceLayout,
} from './e2e/isolatedCharness';
import { getAgentTurns, getAllAgentTurns, readPersistedState, restartCharnessWithState, startCharnessOnInstance } from './e2e/fallbackFlowKit';
import { getFakeClaudeTranscriptPath } from './jiraE2e/fakeClaudeContract';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { keyToString } from '../sessionKey';
import { getJsonStreamSessionPaths, resolveJsonStreamSessionDir } from '../utils/jsonStreamHost';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const topicThreadId = 121;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const topicFolder = 'recovery-topic';
const requestLabel = 'REC-1';

const replyTimeoutMs = 20 * 1000;
const agentStartTimeoutMs = 60 * 1000;
const msPerMinute = 60 * 1000;
/** How long before the restart the window reset, and how long before that the error was written. */
const resetAgoMs = 30 * msPerMinute;
const errorAgoMs = 60 * msPerMinute;
const hoursPerHalfDay = 12;
const minutesPadLength = 2;
/** Moscow's offset from UTC (no daylight saving since 2014). */
const moscowOffsetMs = 3 * 60 * 60 * 1000;
/** The bot's limit wait notice ("🚧 Usage limit reached — …") and its resume notice. */
const limitNoticeMark = '🚧';
const resumedNoticeText = 'The limit window has reset';
const recoveryLogLine = 're-arming a limit wait left over from before the restart';

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let general: TopicDriver;
let topic: TopicDriver;
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

/** A UTC clock the way Claude words a session-limit reset: `10:20am (UTC)`. */
function formatUtcResetClock(atMs: number): string {
  const at = new Date(atMs);
  const hour = at.getUTCHours();
  const hour12 = hour % hoursPerHalfDay === 0 ? hoursPerHalfDay : hour % hoursPerHalfDay;
  const minutes = at.getUTCMinutes().toString().padStart(minutesPadLength, '0');
  return `${hour12}:${minutes}${hour < hoursPerHalfDay ? 'am' : 'pm'} (UTC)`;
}

/**
 * Every limit notice the bot SENT to the topic — read off the Bot API calls, not the topic's current messages: a
 * notice the resume removes again a moment later still reached the user as a notification.
 */
/**
 * Move the transcript's API-error entry back to `writtenAt`: the moment the error happened, which the stdout log's
 * mtime no longer tells once later frames were appended.
 */
function backdateTranscriptApiError(transcriptPath: string, writtenAt: Date): void {
  const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').map((line) => {
    if (!line.includes('"isApiErrorMessage":true')) return line;
    return JSON.stringify({ ...JSON.parse(line), timestamp: writtenAt.toISOString() });
  });
  assert.ok(lines.some((line) => line.includes('"isApiErrorMessage":true')), 'the fake recorded the API error in the transcript');
  fs.writeFileSync(transcriptPath, lines.join('\n'));
}

/** The UTC clock the bot names a reset instant with in an instance whose zone is UTC (`HH:MM`, or with the date). */
function formatUtcNoticeClock(atMs: number, nowMs: number): string {
  const at = new Date(atMs).toISOString();
  const isToday = at.slice(0, 10) === new Date(nowMs).toISOString().slice(0, 10);
  return isToday ? at.slice(11, 16) : `${at.slice(0, 10)} ${at.slice(11, 16)}`;
}

function listSentLimitNotices(): string[] {
  return fakeTelegram
    .listCalls('sendMessage')
    .filter((call) => call.payload.message_thread_id === topicThreadId)
    .map((call) => (typeof call.payload.text === 'string' ? call.payload.text : ''))
    .filter((text) => text.startsWith(limitNoticeMark));
}

describe('The boot recovery of a parked usage limit end to end: built charness, fake Bot API, fake claude', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-limitrec-', [topicFolder], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    general = new TopicDriver(fakeTelegram, getCharness, generalTopicThreadId, replyTimeoutMs);
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

  it('boots, sets the instance zone to UTC and binds the topic', async () => {
    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    await general.sendAndAwaitReply('/timezone UTC', 'Timezone: UTC');
    await topic.sendAndAwaitReply(`/bind ${topicFolder}`, `Bound to \`${topicFolder}\``);
  });

  it('a session limit with a clock reset stops the agent and the live bot announces the wait', async () => {
    await topic.sendAndAwaitReply('/claude', 'ready in');
    const resetClock = formatUtcResetClock(Date.now() - resetAgoMs);
    fakeTelegram.pushOperatorMessage(topicThreadId, `${requestLabel} [fake:usage-limit-once] [limit-resets:${resetClock}] please carry on`);
    const liveNotice = await topic.waitForMessage('the live wait notice', (message) => message.text.startsWith(limitNoticeMark));
    assert.match(liveNotice.text, /will auto-resume after reset/, 'the plain wait notice (no request answers it)');
    assert.equal(listSentLimitNotices().length, 1, 'the call log sees the notice the topic shows');
    assert.equal(getAgentTurns(getLayout(), requestLabel).length, 1, 'the agent stopped on its first turn');
  });

  it('after a restart with the window already reset, the parked topic resumes at once — no "usage limit reached" for a limit that is over', async () => {
    const limitNoticesBefore = listSentLimitNotices().length;
    const key = makeTelegramKey(group.id, topicThreadId);
    const { stdoutFile } = getJsonStreamSessionPaths(resolveJsonStreamSessionDir(getLayout().dataDir, key));
    const sessionId = readPersistedState(getLayout()).agents?.[keyToString(key)]?.claudeSessionId ?? '';
    assert.ok(sessionId, 'the topic ran a Claude conversation');
    const transcriptPath = getFakeClaudeTranscriptPath({ homeDir: getLayout().instanceHome, workDir: path.join(getLayout().workRoot, topicFolder), sessionId });
    charness = await restartCharnessWithState(getLayout(), fakeTelegram, getCharness(), (persisted) => {
      // The wait the live bot armed is gone — the case the recovery exists for — and the error is an hour old, while
      // the stdout log was written to just now (after the reset): its mtime would read the reset as tomorrow's.
      delete persisted.apiRetries?.[keyToString(key)];
      backdateTranscriptApiError(transcriptPath, new Date(Date.now() - errorAgoMs));
      const laterFrameAt = new Date();
      fs.utimesSync(stdoutFile, laterFrameAt, laterFrameAt);
    });

    await getCharness().waitFor('the parked episode to be recovered', agentStartTimeoutMs, () => getCharness().output.includes(recoveryLogLine));
    await topic.waitForMessage('the resume notice', (message) => message.text.includes(resumedNoticeText));
    await getCharness().waitFor('the agent to take the "continue" nudge', agentStartTimeoutMs, () => getAllAgentTurns(getLayout()).length === 2);
    assert.deepEqual(listSentLimitNotices().slice(limitNoticesBefore), [], 'a window that is over is not announced as a usage limit');
  });

  it('a LIVE limit error is announced even when the reset it names is already past (only a recovered episode resumes silently)', async () => {
    const limitNoticesBefore = listSentLimitNotices().length;
    const pastResetIso = new Date(Date.now() - resetAgoMs).toISOString();
    fakeTelegram.pushOperatorMessage(topicThreadId, `${requestLabel}-live [fake:usage-limit-once] [limit-resets:${pastResetIso}] again`);
    await getCharness().waitFor('the live limit notice', agentStartTimeoutMs, () => listSentLimitNotices().length > limitNoticesBefore);
  });

  it('a reset in a named zone is read in that zone: the notice names the instant in the instance zone', async () => {
    const limitNoticesBefore = listSentLimitNotices().length;
    // Two hours from now in Moscow (+03:00, no DST), on the whole minute, as Claude Code writes it.
    const resetAtMs = Math.floor((Date.now() + 2 * 60 * 60 * 1000) / msPerMinute) * msPerMinute;
    const moscow = new Date(resetAtMs + moscowOffsetMs);
    const moscowHour = moscow.getUTCHours();
    const moscowClock = `${moscowHour % hoursPerHalfDay === 0 ? hoursPerHalfDay : moscowHour % hoursPerHalfDay}:${moscow.getUTCMinutes().toString().padStart(minutesPadLength, '0')}${moscowHour < hoursPerHalfDay ? 'am' : 'pm'} (Europe/Moscow)`;
    fakeTelegram.pushOperatorMessage(topicThreadId, `${requestLabel}-zone [fake:usage-limit-once] [limit-resets:${moscowClock}] once more`);
    await getCharness().waitFor('the limit notice', agentStartTimeoutMs, () => listSentLimitNotices().length > limitNoticesBefore);
    const notice = listSentLimitNotices()[limitNoticesBefore];
    assert.ok(notice.includes(`(~${formatUtcNoticeClock(resetAtMs, Date.now())})`), `the reset in UTC, got: ${notice}`);
  });
});
