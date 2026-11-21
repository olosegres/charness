/**
 * @description Starting an agent is the command's job, never a typed or spoken word's: the former start phrases (`claude`,
 * `клод`, `opencode add tests`, a voice note saying «Claude.») start nothing, and `/claude` still opens the topic's own
 * backend, at PROCESS level: the BUILT charness started the way an isolated instance is (`scripts/run-isolated.sh`) against the
 * fake Bot API (`telegramE2e/fakeTelegram.ts`), a fake speech engine for the voice path and the fake agent. «Claude Code» is one
 * choice with several backends, and the bare name `claude` is the adapter name of the DEPRECATED, frozen tmux backend: `/claude`
 * maps it to the topic's own backend first (json-stream by default, or the one `/claude_mode` picked). One flow, in order:
 *
 *   boot → a topic is bound to a folder
 *   → each former phrase typed — `claude`, `клод`, `запусти клода`, `claude fix the bug`, `opencode add tests` — is an ordinary
 *     message: the topic answers with the hint to start an agent, no process starts, the topic has no agent
 *   → a voice note saying «Claude.» likewise: the transcript is echoed (the engine chain of `stt.json` ran), then the same hint
 *   → `/claude` starts the default backend: a json-stream process, the topic's agent is json-stream
 *   → after `/quit` (which releases the conversation) the word `claude` still starts nothing
 *   → a topic that picked the per-turn backend: `/claude` starts per-turn, not json-stream and not tmux.
 *
 * What the unit tests cover instead: what a start choice resolves to (`claudeBackendResolve.test.ts`). The tmux backend itself
 * is frozen: no flow starts it here.
 *
 * Nothing leaves the machine: the Bot API and the speech engine are on loopback and the agent is a fake. Everything the test
 * starts is stopped in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FakeSpeechEngine } from './telegramE2e/fakeSpeechEngine';
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
import { getSessionLaunches, readPersistedState, startCharnessOnInstance } from './e2e/fallbackFlowKit';
import { claudeJsonStreamAdapterName, claudePerTurnAdapterName } from '../adapters/adapterNames';
import { t } from '../i18n';
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const topicThreadId = 231;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const projectFolder = 'start-proj';
const threadKeyString = `${group.id}:${topicThreadId}`;
const voiceFileId = 'voice-phrase-1';
const voiceFileBytes = 2048;
const voiceDurationSeconds = 2;
/** What the fake speech engine «recognises»: a former start phrase the way an engine writes it, capitalised and with a full stop. */
const spokenPhrase = 'Claude.';
/** The words that used to start an agent when typed: bare, with a verb in front, and with a prompt behind. */
const formerStartPhrases = ['claude', 'клод', 'запусти клода', 'claude fix the bug', 'opencode add tests'];

const replyTimeoutMs = 20 * 1000;
const agentStartTimeoutMs = 60 * 1000;

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let speechEngine: FakeSpeechEngine;
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

/** The adapter the bot has persisted for the topic, once it has written `state.json`. */
function readTopicAgentName(): string | undefined {
  return readPersistedState(getLayout()).agents?.[threadKeyString]?.name;
}

/** What a topic with no agent answers a plain message with. */
function getNoAgentHint(): string {
  return t('thread.no_agent_with_binding', { subdir: projectFolder });
}

/**
 * A command in, an agent out: `trigger` is what makes the bot start it; the topic hears the agent's ready notice, the fake CLI
 * logs exactly one new json-stream process, and the topic's agent is `expectedAgentName`.
 */
async function assertStartsAgent(trigger: () => Promise<unknown>, expectedAgentName: string): Promise<void> {
  const launchesBefore = getSessionLaunches(getLayout()).length;
  await trigger();
  await getCharness().waitFor('the agent started by the command', agentStartTimeoutMs, () => getSessionLaunches(getLayout()).length > launchesBefore);
  assert.equal(getSessionLaunches(getLayout()).length, launchesBefore + 1, 'exactly one process was started');
  await getCharness().waitFor('the topic\'s agent persisted', replyTimeoutMs, () => readTopicAgentName() === expectedAgentName);
}

/**
 * Words in, no agent out: `trigger` is what the operator says (the bot's answer to it is the hint, which comes at the end of
 * the message's handling, where an agent start would have come first); no process was launched, the topic's agent is what it
 * was, and no «ready in» notice was posted after the words.
 */
async function assertStartsNoAgent(trigger: () => Promise<unknown>): Promise<void> {
  const launchesBefore = getSessionLaunches(getLayout()).length;
  const agentNameBefore = readTopicAgentName();
  const lastMessageIdBefore = Math.max(0, ...topic.listMessages().map((message) => message.message_id));
  await trigger();
  assert.equal(getSessionLaunches(getLayout()).length, launchesBefore, 'no process was started');
  assert.equal(readTopicAgentName(), agentNameBefore, 'the topic\'s agent did not change');
  assert.ok(!topic.listMessages().some((message) => message.message_id > lastMessageIdBefore && message.text.includes('ready in')), 'no agent announced itself in the topic');
}

describe('the start command end to end, and the former start phrases: built charness, fake Bot API, fake speech engine', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-start-', [projectFolder], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    topic = new TopicDriver(fakeTelegram, getCharness, topicThreadId, replyTimeoutMs);
    speechEngine = new FakeSpeechEngine(() => ({ status: 200, text: spokenPhrase }));
    const speechUrl = await speechEngine.start();
    // The voice settings the way an operator keeps them, beside the instance's env file: one engine, a loopback server.
    fs.writeFileSync(path.join(path.dirname(layout.envFile), 'stt.json'), `${JSON.stringify({ engines: [{ id: 'u1', kind: 'url', url: speechUrl }] }, null, 2)}\n`);
    fakeTelegram.registerFile(voiceFileId, Buffer.alloc(voiceFileBytes, 7));
    const apiRoot = await fakeTelegram.start();
    writeInstanceEnvFile(layout, {
      CONNECTORS: 'telegram',
      TELEGRAM_BOT_TOKEN: fakeBotToken,
      TELEGRAM_API_ROOT: apiRoot,
      ALLOWED_GROUP_ID: group.id.toString(),
      CHAT_MODE: 'group',
      DATA_DIR: layout.dataDir,
      WORK_ROOT: layout.workRoot,
      TMUX_SOCKET_NAME: layout.tmuxSocketName,
      TMUX_TMPDIR: layout.tmuxTmpDir,
      CLAUDE_BIN: writeFakeClaudeLauncher(layout, null),
      // A free port nothing listens on: the boot's OpenCode pre-start finds no server and no binary, and gives up.
      OPENCODE_URL: `http://127.0.0.1:${await getUnservedPort()}`,
      SCHEDULER_MCP_PORT: (await getFreeFixedPort()).toString(),
      ...getTelegramFlowTestTimingsEnv(),
    });
  });

  after(async () => {
    await charness?.stop();
    removeInstanceSync();
    await fakeTelegram?.stop();
    await speechEngine?.stop();
    process.off('exit', removeInstanceSync);
    process.off('SIGINT', exitOnSignal);
    process.off('SIGTERM', exitOnSignal);
    assert.deepEqual(listTmuxSessions([]), defaultTmuxSessionsBefore, 'the default tmux server was not touched');
  });

  it('boots and binds the topic to a folder', async () => {
    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    await topic.sendAndAwaitReply(`/bind ${projectFolder}`, `Bound to \`${projectFolder}\``);
  });

  it('a former start phrase typed — bare, with a verb, with a prompt, in either language — starts no agent: the topic answers with the hint', async () => {
    for (const phrase of formerStartPhrases) {
      await assertStartsNoAgent(() => topic.sendAndAwaitReply(phrase, getNoAgentHint()));
    }
  });

  it('a voice note saying «Claude.» starts no agent either: the transcript is echoed, then the hint', async () => {
    await assertStartsNoAgent(async () => {
      const voiceMessageId = fakeTelegram.pushOperatorVoice(topicThreadId, voiceFileId, voiceDurationSeconds);
      await topic.waitForMessage('the transcript echo', (message) => message.message_id > voiceMessageId && message.text === `🎤 ${spokenPhrase}`);
      await topic.waitForMessage('the hint', (message) => message.message_id > voiceMessageId && message.text === getNoAgentHint());
    });
    assert.equal(speechEngine.requests.length, 1, 'the voice note went through the speech engine');
  });

  it('`/claude` starts the topic\'s backend — json-stream by default — not the deprecated tmux one', async () => {
    await assertStartsAgent(() => topic.sendAndAwaitReply('/claude', 'ready in'), claudeJsonStreamAdapterName);
  });

  it('after `/quit` the word `claude` still starts nothing, and `/claude` starts the agent again', async () => {
    await topic.sendAndAwaitReply('/quit', 'stopped');
    await assertStartsNoAgent(() => topic.sendAndAwaitReply('claude', getNoAgentHint()));
    await assertStartsAgent(() => topic.sendAndAwaitReply('/claude', 'ready in'), claudeJsonStreamAdapterName);
  });

  it('a topic that picked the per-turn backend: `/claude` starts per-turn, as it always did', async () => {
    await topic.sendAndAwaitReply('/quit', 'stopped');
    await topic.sendAndAwaitReply('/claude_mode per-turn', 'applies on next start');
    await getCharness().waitFor('the per-turn pick persisted', replyTimeoutMs, () => readTopicAgentName() === claudePerTurnAdapterName);
    await assertStartsAgent(() => topic.sendAndAwaitReply('/claude', 'ready in'), claudePerTurnAdapterName);
  });
});
