/**
 * @description A prompt forwarded to an ADOPTED session waits for the replay of what the process wrote while the bot was
 * down, at PROCESS level: the BUILT charness started the way an isolated instance is (`scripts/run-isolated.sh`) against the
 * fake Bot API of `telegramE2e/fakeTelegram.ts` and the fake `claude` (`jiraE2e/fakeClaude.ts`). One flow, in order:
 *
 *   boot → a topic is bound and the agent started → it answers a first message
 *   → the bot is stopped; while it is down a turn is written to the agent's stdin and runs to a usage limit (its text
 *     streams, then the limit hits) — the downtime tail the next bot replays
 *   → the bot starts again: the adopt reads the tail from its saved offset, the boot recovery finds the limit error in the
 *     log (its window is over) and resumes the topic at once — a "continue" prompt forwarded within milliseconds of the
 *     adopt, long before the first tail poll (300 ms) has read the tail
 *   → the agent reads the resume prompt only AFTER the bot has taken the replayed turn in (its text is out, its error
 *     handled). Without the wait the prompt reached the agent ~25 ms after the adopt, long before the first poll read the
 *     tail: it reset the answer and error state the replayed frames still use, and it marked "the next output opens a new
 *     message" for the replayed text. The order is compared by timestamps of two processes on one host (the bot's output
 *     trace, the fake agent's prompt log): the prompt came tens of milliseconds after the adopt without the wait, the
 *     replay is read 300 ms after it.
 *
 *   → a limit that ended a turn while the bot was down is handled exactly ONCE: the boot recovery resumes the topic and the
 *     adopt's replay of the same error stays out of it — one resume notice, one "Continue" prompt, and no "usage limit
 *     reached" notice for a window that is over (the replayed error used to be handled again as a live one: the notice for
 *     the finished window, a second resume, a second prompt). Both for a reset named as an instant and for a clock-only
 *     reset (`resets 10:20am (UTC)`), which only the error's own time — not the replay's — reads as already over.
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
import { getAllAgentTurns, getStatePath, readPersistedState, startCharnessOnInstance } from './e2e/fallbackFlowKit';
import { backdateTranscriptApiError, formatUtcResetClock } from './e2e/limitFlowKit';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { keyToString } from '../sessionKey';
import { getJsonStreamSessionPaths, resolveJsonStreamSessionDir } from '../utils/jsonStreamHost';
import { fakeClaudeLogFileNames, getFakeClaudeTranscriptPath, type FakeClaudePrompt } from './jiraE2e/fakeClaudeContract';
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const topicThreadId = 121;
const perTurnThreadId = 122;
const limitsOffThreadId = 123;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const topicFolder = 'replay-topic';
const perTurnFolder = 'replay-per-turn';
const limitsOffFolder = 'replay-limits-off';
const seedLabel = 'SEED-1';
const downtimeLabel = 'DOWN-1';
const perTurnDowntimeLabel = 'PT-2';
const limitsOffSeedLabel = 'OFF-0';
const limitsOffDowntimeLabel = 'OFF-1';

const replyTimeoutMs = 20 * 1000;
const agentStartTimeoutMs = 60 * 1000;
const msPerMinute = 60 * 1000;
/** The limit's reset, already past when the bot comes back: the boot recovery resumes at once. */
const resetAgoMs = 30 * msPerMinute;
/** What the fake agent streams as a turn's text (`Working on <issue>.`). */
const downtimeTurnText = `Working on ${downtimeLabel}.`;
const usageLimitText = "You've hit your session limit";
/** The start of the bot's resume prompt (`apiRetry.continueNudge`). */
const resumePromptStart = 'Continue from where you left off';
const traceFilePrefix = 'output-trace-';
const perTurnAdapterName = 'claude-per-turn';
const limitNoticeMark = '🚧';
const resumedNoticeText = 'The limit window has reset';
/** How long before the bot came back the clock-only reset passed, and how long before that the error was written. */
const errorAgoMs = 60 * msPerMinute;
const msPerHour = 60 * msPerMinute;

/** A topic of the flow: its thread and the folder it is bound to. */
interface TopicSpec {
  threadId: number;
  folder: string;
}
const mainTopicSpec: TopicSpec = { threadId: topicThreadId, folder: topicFolder };
const perTurnTopicSpec: TopicSpec = { threadId: perTurnThreadId, folder: perTurnFolder };
const limitsOffTopicSpec: TopicSpec = { threadId: limitsOffThreadId, folder: limitsOffFolder };

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let topic: TopicDriver;
let perTurnTopic: TopicDriver;
let limitsOffTopic: TopicDriver;
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

function getTopicSessionPaths(spec: TopicSpec = mainTopicSpec): ReturnType<typeof getJsonStreamSessionPaths> {
  return getJsonStreamSessionPaths(resolveJsonStreamSessionDir(getLayout().dataDir, makeTelegramKey(group.id, spec.threadId)));
}

/** Write a user turn to the agent's stdin the way the bot does — while the bot is down, so nobody read its output. */
function writeTurnToAgentStdin(content: string, spec: TopicSpec = mainTopicSpec): void {
  const fifoFd = fs.openSync(getTopicSessionPaths(spec).stdinFifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
  try {
    fs.writeSync(fifoFd, `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`);
  } finally {
    fs.closeSync(fifoFd);
  }
}

/** The bot's output-trace entries (`emit` records of the agent's output), across the hourly buckets. */
function listTracedAgentOutputs(): Array<{ at: number; preview: string }> {
  return fs.readdirSync(getLayout().dataDir)
    .filter((name) => name.startsWith(traceFilePrefix))
    .flatMap((name) => fs.readFileSync(path.join(getLayout().dataDir, name), 'utf8').split('\n').filter(Boolean))
    .map((line) => JSON.parse(line) as { ts: string; kind: string; event?: string; preview?: string })
    .filter((entry) => entry.kind === 'emit' && entry.event === 'output')
    .map((entry) => ({ at: Date.parse(entry.ts), preview: entry.preview ?? '' }));
}

function listResumePrompts(): FakeClaudePrompt[] {
  return fs.readFileSync(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.prompts), 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as FakeClaudePrompt)
    .filter((prompt) => prompt.text.includes(resumePromptStart));
}

/** Count the topic's Bot API sends whose text satisfies `isMatch` — read off the call log, so a message deleted later still counts. */
function countSentToTopic(isMatch: (text: string) => boolean, spec: TopicSpec = mainTopicSpec): number {
  return fakeTelegram.listCalls('sendMessage')
    .filter((call) => call.payload.message_thread_id === spec.threadId)
    .filter((call) => isMatch(typeof call.payload.text === 'string' ? call.payload.text : ''))
    .length;
}

function countUsageLimitResultsInLog(spec: TopicSpec): number {
  return fs.readFileSync(getTopicSessionPaths(spec).stdoutFile, 'utf8').split(usageLimitText).length - 1;
}

/**
 * Stop the bot and, while it is down, run a turn on the agent that ends on a usage limit: the turn is written to the agent's
 * stdin and the call returns once its limit result is in the log. The bot is NOT started again. `resetClause` is what the
 * turn's `[limit-resets:…]` token says; `backdateErrorTo` moves the transcript's API-error entry back (for a clock-only reset
 * that only reads as over against the moment the error happened).
 */
async function runLimitedTurnWhileBotIsDown(label: string, resetClause: string, backdateErrorTo?: Date, spec: TopicSpec = mainTopicSpec): Promise<void> {
  const key = keyToString(makeTelegramKey(group.id, spec.threadId));
  const { stdoutFile } = getTopicSessionPaths(spec);
  // Everything so far is handled and saved: the next bot replays only what is written from here on.
  await getCharness().waitFor('the log saved as handled', replyTimeoutMs, () => (readPersistedState(getLayout()).agents?.[key]?.jsonStreamTail?.offsetBytes ?? 0) >= fs.statSync(stdoutFile).size);
  const sessionId = readPersistedState(getLayout()).agents?.[key]?.claudeSessionId ?? '';
  await getCharness().stop();

  const limitResultsBefore = countUsageLimitResultsInLog(spec);
  writeTurnToAgentStdin(`${label} [fake:usage-limit-once] [limit-resets:${resetClause}] written while the bot is down`, spec);
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + agentStartTimeoutMs;
    const timer = setInterval(() => {
      if (countUsageLimitResultsInLog(spec) > limitResultsBefore) { clearInterval(timer); resolve(); }
      else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('the agent did not run the turn written while the bot was down')); }
    }, 50);
  });
  if (backdateErrorTo) {
    backdateTranscriptApiError(getFakeClaudeTranscriptPath({ homeDir: getLayout().instanceHome, workDir: path.join(getLayout().workRoot, spec.folder), sessionId }), backdateErrorTo);
  }
}

describe('A prompt forwarded to an adopted session waits for the replay of its downtime tail: built charness, fake Bot API, fake claude', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-adoptreplay-', [topicFolder, perTurnFolder, limitsOffFolder], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    topic = new TopicDriver(fakeTelegram, getCharness, topicThreadId, replyTimeoutMs);
    // A resume through the stop window starts a new process: allow a start's time.
    perTurnTopic = new TopicDriver(fakeTelegram, getCharness, perTurnThreadId, agentStartTimeoutMs);
    limitsOffTopic = new TopicDriver(fakeTelegram, getCharness, limitsOffThreadId, replyTimeoutMs);
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
      ...getTelegramFlowTestTimingsEnv({}),
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

  it('boots, binds the topic, starts the agent and lets it answer a first message', async () => {
    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    await topic.sendAndAwaitReply(`/bind ${topicFolder}`, `Bound to \`${topicFolder}\``);
    await topic.sendAndAwaitReply('/claude', 'ready in');
    fakeTelegram.pushOperatorMessage(topicThreadId, `${seedLabel} hello`);
    await topic.waitForMessage('the first answer', (message) => message.text.includes(`Working on ${seedLabel}.`));
  });

  it('a turn that ran to a usage limit while the bot was down is replayed once, and the resume prompt waits for it: two turns, two messages', async () => {
    await runLimitedTurnWhileBotIsDown(downtimeLabel, new Date(Date.now() - resetAgoMs).toISOString());
    const turnsBeforeBoot = getAllAgentTurns(getLayout()).length;

    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);

    await getCharness().waitFor('the agent to take the resume prompt', agentStartTimeoutMs, () => getAllAgentTurns(getLayout()).length > turnsBeforeBoot);
    await topic.waitForMessage('the replayed turn\'s text', (message) => message.text === downtimeTurnText);
    // The trace is written in 500 ms batches: wait for the replayed text's record.
    await getCharness().waitFor('the replayed text in the output trace', replyTimeoutMs, () => listTracedAgentOutputs().some((entry) => entry.preview.includes(downtimeTurnText)));
    const replayedTextAt = listTracedAgentOutputs().find((entry) => entry.preview.includes(downtimeTurnText))?.at ?? Number.POSITIVE_INFINITY;
    const resumePrompt = listResumePrompts().at(0);
    assert.ok(resumePrompt, 'the boot recovery resumed the topic');
    assert.ok(resumePrompt.readAt >= replayedTextAt, `the agent read the resume prompt (${resumePrompt.readAt}) only after the bot took the replayed turn in (${replayedTextAt})`);
  });

  /**
   * Restart the bot over a limited turn that ended while it was down and count what the topic and the agent got. The count is
   * taken after a sentinel prompt has been answered: everything the replay of the limit error sets in motion (a notice, a
   * retry, a second "Continue") is only a few async hops, a sentinel is a whole Telegram → bot → agent → bot → Telegram round
   * trip, so nothing from the replay can still be on its way once the sentinel is answered.
   */
  async function restartAndCountWhatTheLimitedTurnCaused(sentinelLabel: string): Promise<{ limitNotices: number; resumeNotices: number; continuePrompts: number }> {
    const before = { limitNotices: countSentToTopic((text) => text.startsWith(limitNoticeMark)), resumeNotices: countSentToTopic((text) => text.includes(resumedNoticeText)), continuePrompts: listResumePrompts().length };
    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    await getCharness().waitFor('the agent to take the resume prompt', agentStartTimeoutMs, () => listResumePrompts().length > before.continuePrompts);
    fakeTelegram.pushOperatorMessage(topicThreadId, `${sentinelLabel} did anything else happen?`);
    await topic.waitForMessage('the sentinel\'s answer', (message) => message.text.includes(`Working on ${sentinelLabel}.`));
    return {
      limitNotices: countSentToTopic((text) => text.startsWith(limitNoticeMark)) - before.limitNotices,
      resumeNotices: countSentToTopic((text) => text.includes(resumedNoticeText)) - before.resumeNotices,
      continuePrompts: listResumePrompts().length - before.continuePrompts,
    };
  }

  it('on the per-turn backend the resume prompt that reaches the adopted session at the boot is not lost to the stop the replayed turn end starts', async () => {
    // A per-turn topic whose process is alive when the bot goes down (started, no turn yet — the per-turn stop comes at a turn's
    // end). The turn written while the bot is down ends the way the stop gate allows, so the replay of its end finds the stop
    // permitted and queues it — at the very moment the boot recovery's resume prompt, waiting for that replay, is let through.
    const key = keyToString(makeTelegramKey(group.id, perTurnThreadId));
    await perTurnTopic.sendAndAwaitReply(`/bind ${perTurnFolder}`, `Bound to \`${perTurnFolder}\``);
    await perTurnTopic.sendAndAwaitReply('/claude', 'ready in');
    const picker = await perTurnTopic.sendAndAwaitReply('/claude_mode', 'Claude Code backend — current:');
    await perTurnTopic.tapAndAwaitAnswer(picker, `ccmode_${perTurnAdapterName}`);
    await perTurnTopic.waitForMessage('the switch to the per-turn backend', (message) => message.text.includes('Switched to'));
    await getCharness().waitFor('the per-turn backend persisted', replyTimeoutMs, () => readPersistedState(getLayout()).agents?.[key]?.name === perTurnAdapterName);

    await runLimitedTurnWhileBotIsDown(perTurnDowntimeLabel, new Date(Date.now() - resetAgoMs).toISOString(), undefined, perTurnTopicSpec);
    const resumeMessagesBefore = countSentToTopic((text) => text.includes(resumedNoticeText), perTurnTopicSpec);
    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);

    // The resume prompt has no issue label: the fake answers it "Working on unknown.", which only the resumed turn produces here.
    await perTurnTopic.waitForMessage('the resumed turn\'s answer', (message) => message.text === 'Working on unknown.');
    assert.equal(countSentToTopic((text) => text.includes(resumedNoticeText), perTurnTopicSpec) - resumeMessagesBefore, 1, 'the topic was told once that the work resumed');
  });

  it('a limit that ended a turn while the bot was down (a reset named as an instant) is handled once: no notice for a window that is over, one resume, one "Continue"', async () => {
    await runLimitedTurnWhileBotIsDown('DOWN-2', new Date(Date.now() - resetAgoMs).toISOString());
    assert.deepEqual(await restartAndCountWhatTheLimitedTurnCaused('SENT-2'), { limitNotices: 0, resumeNotices: 1, continuePrompts: 1 });
  });

  it('the same for a clock-only reset (`resets 10:20am (UTC)`): read against the moment the error was written it is over; read against the replay it would be tomorrow', async () => {
    await runLimitedTurnWhileBotIsDown('DOWN-3', formatUtcResetClock(Date.now() - resetAgoMs), new Date(Date.now() - errorAgoMs));
    assert.deepEqual(await restartAndCountWhatTheLimitedTurnCaused('SENT-3'), { limitNotices: 0, resumeNotices: 1, continuePrompts: 1 });
  });

  it('a replayed limit error on a topic the recovery does not own (waiting for the reset is off) is read against the moment it was written, not the replay\'s clock', async () => {
    // The recovery leaves a topic with the wait off alone, so the error reaches the bot only through the replay — handled as a
    // live one, which marks the topic's account limited until the error's reset. A clock-only reset ("resets 10:20am") is the
    // NEXT occurrence of that clock: after the moment the error was written it is half an hour ago (the window is over), after
    // the replay's clock it is tomorrow — and the account stayed limited for a day.
    const key = keyToString(makeTelegramKey(group.id, limitsOffThreadId));
    await limitsOffTopic.sendAndAwaitReply(`/bind ${limitsOffFolder}`, `Bound to \`${limitsOffFolder}\``);
    await limitsOffTopic.sendAndAwaitReply('/claude', 'ready in');
    fakeTelegram.pushOperatorMessage(limitsOffThreadId, `${limitsOffSeedLabel} hello`);
    await limitsOffTopic.waitForMessage('the first answer', (message) => message.text.includes(`Working on ${limitsOffSeedLabel}.`));
    await runLimitedTurnWhileBotIsDown(limitsOffDowntimeLabel, formatUtcResetClock(Date.now() - resetAgoMs), new Date(Date.now() - errorAgoMs), limitsOffTopicSpec);
    const persisted = readPersistedState(getLayout());
    // The account carries no limit mark of an earlier step: the wait below then proves THIS restart set it (the state file is saved a
    // moment after a change, and an old mark would satisfy the wait at once).
    const { limitedUntil: _earlierMark, ...defaultProfile } = persisted.claudeProfiles?.default ?? { createdAt: new Date().toISOString() };
    fs.writeFileSync(getStatePath(getLayout()), JSON.stringify({
      ...persisted,
      claudeProfiles: { ...persisted.claudeProfiles, default: defaultProfile },
      autoContinueOnLimitOverrides: { ...(persisted.autoContinueOnLimitOverrides as Record<string, boolean> | undefined), [key]: false },
    }));
    const noticesBefore = countSentToTopic((text) => text.startsWith(limitNoticeMark), limitsOffTopicSpec);

    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);

    await getCharness().waitFor('the replayed limit error handled (the wait-is-off notice)', agentStartTimeoutMs, () => countSentToTopic((text) => text.startsWith(limitNoticeMark), limitsOffTopicSpec) > noticesBefore);
    await getCharness().waitFor('the account marked limited', replyTimeoutMs, () => readPersistedState(getLayout()).claudeProfiles?.default?.limitedUntil !== undefined);
    const limitedUntilMs = Date.parse(readPersistedState(getLayout()).claudeProfiles?.default?.limitedUntil ?? '');
    assert.ok(limitedUntilMs - Date.now() < 2 * msPerHour, `the account is limited for a short while at most (the window was over), not until tomorrow: ${new Date(limitedUntilMs).toISOString()}`);
  });
});
