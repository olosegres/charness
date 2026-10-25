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
import { getAllAgentTurns, readPersistedState, startCharnessOnInstance } from './e2e/fallbackFlowKit';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { keyToString } from '../sessionKey';
import { getJsonStreamSessionPaths, resolveJsonStreamSessionDir } from '../utils/jsonStreamHost';
import { fakeClaudeLogFileNames, type FakeClaudePrompt } from './jiraE2e/fakeClaudeContract';
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const topicThreadId = 121;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const topicFolder = 'replay-topic';
const seedLabel = 'SEED-1';
const downtimeLabel = 'DOWN-1';

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

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
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

function getTopicSessionPaths(): ReturnType<typeof getJsonStreamSessionPaths> {
  return getJsonStreamSessionPaths(resolveJsonStreamSessionDir(getLayout().dataDir, makeTelegramKey(group.id, topicThreadId)));
}

/** Write a user turn to the agent's stdin the way the bot does — while the bot is down, so nobody read its output. */
function writeTurnToAgentStdin(content: string): void {
  const fifoFd = fs.openSync(getTopicSessionPaths().stdinFifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
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

describe('A prompt forwarded to an adopted session waits for the replay of its downtime tail: built charness, fake Bot API, fake claude', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-adoptreplay-', [topicFolder], getFlowDeadlineMs());
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
    const key = keyToString(makeTelegramKey(group.id, topicThreadId));
    const { stdoutFile } = getTopicSessionPaths();
    // The first turn is handled and saved: the next bot replays only what is written from here on.
    await getCharness().waitFor('the first turn saved as handled', replyTimeoutMs, () => (readPersistedState(getLayout()).agents?.[key]?.jsonStreamTail?.offsetBytes ?? 0) >= fs.statSync(stdoutFile).size);
    await getCharness().stop();

    const resetAt = new Date(Date.now() - resetAgoMs).toISOString();
    writeTurnToAgentStdin(`${downtimeLabel} [fake:usage-limit-once] [limit-resets:${resetAt}] written while the bot is down`);
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + agentStartTimeoutMs;
      const timer = setInterval(() => {
        if (fs.readFileSync(stdoutFile, 'utf8').includes(usageLimitText)) { clearInterval(timer); resolve(); }
        else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('the agent did not run the turn written while the bot was down')); }
      }, 50);
    });
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
});
