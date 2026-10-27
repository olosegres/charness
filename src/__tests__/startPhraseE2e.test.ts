/**
 * @description The spoken and typed start phrases (`claude`, `клод`, …) at PROCESS level: the BUILT charness started the way
 * an isolated instance is (`scripts/run-isolated.sh`) against the fake Bot API (`telegramE2e/fakeTelegram.ts`), a fake speech
 * engine for the voice path and the fake agent. «Claude Code» is one choice with several backends, and the bare name `claude`
 * is the adapter name of the DEPRECATED, frozen tmux backend: `/claude` maps it to the topic's own backend first (json-stream
 * by default, or the one `/claude_mode` picked). The phrases used to hand the bare name on, so `claude` typed or said started
 * the tmux backend. One flow, in order:
 *
 *   boot → a topic is bound to a folder
 *   → the typed phrase `claude` starts the default backend: a json-stream process, the topic's agent is json-stream
 *   → the Russian phrase `клод` does the same (after `/quit`)
 *   → a voice note saying «Claude.» does the same, through the engine chain of `stt.json` (the transcript is echoed)
 *   → a topic that picked the per-turn backend: the phrase starts per-turn, not json-stream and not tmux.
 *
 * What the unit tests cover instead: the phrase grammar (`agentTrigger.test.ts`), what a start choice resolves to
 * (`claudeBackendResolve.test.ts`). The tmux backend itself is frozen: no flow starts it here.
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
  getFreePort,
  IsolatedCharness,
  listTmuxSessions,
  removeIsolatedInstanceSync,
  writeFakeClaudeLauncher,
  writeInstanceEnvFile,
  type IsolatedInstanceLayout,
} from './e2e/isolatedCharness';
import { getSessionLaunches, readPersistedState, startCharnessOnInstance } from './e2e/fallbackFlowKit';
import { claudeJsonStreamAdapterName, claudePerTurnAdapterName } from '../adapters/adapterNames';
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const topicThreadId = 231;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const projectFolder = 'phrase-proj';
const threadKeyString = `${group.id}:${topicThreadId}`;
const voiceFileId = 'voice-phrase-1';
const voiceFileBytes = 2048;
const voiceDurationSeconds = 2;
/** What the fake speech engine «recognises»: a start phrase the way an engine writes it, capitalised and with a full stop. */
const spokenPhrase = 'Claude.';

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

/**
 * A start phrase in, an agent out: `trigger` is what makes the bot start it; the topic hears the agent's ready notice, the
 * fake CLI logs exactly one new json-stream process, and the topic's agent is `expectedAgentName`.
 */
async function assertPhraseStartsAgent(trigger: () => Promise<unknown>, expectedAgentName: string): Promise<void> {
  const launchesBefore = getSessionLaunches(getLayout()).length;
  await trigger();
  await getCharness().waitFor('the agent started by the phrase', agentStartTimeoutMs, () => getSessionLaunches(getLayout()).length > launchesBefore);
  assert.equal(getSessionLaunches(getLayout()).length, launchesBefore + 1, 'exactly one process was started');
  await getCharness().waitFor('the topic\'s agent persisted', replyTimeoutMs, () => readTopicAgentName() === expectedAgentName);
}

describe('start phrases end to end: built charness, fake Bot API, fake speech engine', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-phrase-', [projectFolder], getFlowDeadlineMs());
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
      OPENCODE_URL: `http://127.0.0.1:${await getFreePort()}`,
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

  it('the typed phrase `claude` starts the topic\'s backend — json-stream by default — not the deprecated tmux one', async () => {
    await assertPhraseStartsAgent(() => topic.sendAndAwaitReply('claude', 'ready in'), claudeJsonStreamAdapterName);
  });

  it('the Russian phrase `клод` starts it the same way', async () => {
    await topic.sendAndAwaitReply('/quit', 'stopped');
    await assertPhraseStartsAgent(() => topic.sendAndAwaitReply('клод', 'ready in'), claudeJsonStreamAdapterName);
  });

  it('a voice note saying «Claude.» starts it the same way: the transcript is echoed, and the backend is json-stream', async () => {
    await topic.sendAndAwaitReply('/quit', 'stopped');
    await assertPhraseStartsAgent(async () => {
      const voiceMessageId = fakeTelegram.pushOperatorVoice(topicThreadId, voiceFileId, voiceDurationSeconds);
      await topic.waitForMessage('the transcript echo', (message) => message.message_id > voiceMessageId && message.text === `🎤 ${spokenPhrase}`);
      await topic.waitForMessage('the ready notice', (message) => message.message_id > voiceMessageId && message.text.includes('ready in'));
    }, claudeJsonStreamAdapterName);
    assert.equal(speechEngine.requests.length, 1, 'the voice note went through the speech engine');
  });

  it('a topic that picked the per-turn backend: the phrase starts per-turn, as `/claude` would', async () => {
    await topic.sendAndAwaitReply('/quit', 'stopped');
    await topic.sendAndAwaitReply('/claude_mode per-turn', 'applies on next start');
    await getCharness().waitFor('the per-turn pick persisted', replyTimeoutMs, () => readTopicAgentName() === claudePerTurnAdapterName);
    await assertPhraseStartsAgent(() => topic.sendAndAwaitReply('claude', 'ready in'), claudePerTurnAdapterName);
  });
});
