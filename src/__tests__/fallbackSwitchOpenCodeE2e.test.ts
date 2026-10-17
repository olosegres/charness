/**
 * @description The usage-limit switch to and from OpenCode at PROCESS level: the BUILT charness
 * started the way an isolated instance is (`scripts/run-isolated.sh`) against the fake Bot API
 * (`telegramE2e/fakeTelegram.ts`), the fake `claude` (`jiraE2e/fakeClaude.ts`) and a fake OpenCode server + CLI
 * (`openCodeE2e/fakeOpenCodeServer.ts`) that serves only what the bot calls and lists anything else as `unhandled`.
 * The bot ADOPTS that server (it is healthy and current) instead of spawning one. Three topics, each a direction:
 *
 *   A  Claude → OpenCode: the Claude agent hits a subscription limit, the chain's rung is an OpenCode model. The
 *      notice names the account that hit it and `OpenCode openai/gpt-5`; the OpenCode session is created in the
 *      topic's folder and its first prompt is the context bridge; the Claude conversation is parked. A plain
 *      `/claude` by hand then resumes the PARKED Claude conversation (same id) under the first account.
 *   B  OpenCode → Claude: the OpenCode session's turn fails with a usage limit, the chain's rung is a Claude account.
 *      The notice names the model that hit it and `Claude «work»`; a new Claude conversation starts under that
 *      account with the bridge; a plain `/opencode` resumes the parked OpenCode session (same id).
 *   C  OpenCode → OpenCode: the model changes within the session; the next prompt — the "continue" message — carries
 *      the rung's model.
 *
 * Nothing leaves the machine: every server is on loopback and every agent is a fake. Everything the test starts is
 * stopped in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram, generalTopicThreadId } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import { getLaunchSessionId } from './jiraE2e/fakeClaudeContract';
import { FakeOpenCodeServer, writeFakeOpenCodeBinary } from './openCodeE2e/fakeOpenCodeServer';
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
import {
  computeResetsAtIso,
  getAccountConfigDir,
  getResetClock,
  getSessionLaunches,
  listSwitchNotices,
  readPersistedState,
  restartCharnessWithState,
  startCharnessOnInstance,
  waitForSessionRespawn,
  type PersistedState,
} from './e2e/fallbackFlowKit';
import { createClaudeProfileLayout } from '../utils/claudeProfiles';
import { claudeJsonStreamAdapterName, openCodeAdapterName } from '../adapters/adapterNames';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';

/** One topic per direction. */
const claudeToOpenCode = { threadId: 111, folder: 'oc-from-claude' };
const openCodeToClaude = { threadId: 112, folder: 'oc-to-claude' };
const openCodeToOpenCode = { threadId: 113, folder: 'oc-to-oc' };

const fakeOpenCodeVersion = '1.17.11';
/** The model OpenCode runs by default, and the ones the chain names. */
const defaultOpenCodeModel = 'anthropic/claude-sonnet-4-6';
const chainOpenCodeModel = 'openai/gpt-5';
const chainOpenCodeModelAlternative = 'google/gemini-2.5-pro';
const openCodeModels = [defaultOpenCodeModel, chainOpenCodeModel, chainOpenCodeModelAlternative] as const;
const exhaustedAccount = 'default';
const takeoverAccount = 'work';

const replyTimeoutMs = 20 * 1000;
const agentStartTimeoutMs = 60 * 1000;
const takeoverDaysAhead = 2;

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let fakeOpenCode: FakeOpenCodeServer;
let general: TopicDriver;
let claudeTopic: TopicDriver;
let toClaudeTopic: TopicDriver;
let openCodeTopic: TopicDriver;
let defaultTmuxSessionsBefore: string[] = [];
let resetsAtIso = '';
let resetClock = '';
/** The conversation topic A's Claude agent ran, which must come back after the OpenCode detour. */
let claudeSessionId = '';
/** The OpenCode session topic B's agent ran before its limit. */
let openCodeSessionOfB = '';

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

async function restartWithState(edit: (state: PersistedState) => void): Promise<void> {
  charness = await restartCharnessWithState(getLayout(), fakeTelegram, getCharness(), edit);
}

function getTopicKey(threadId: number): string {
  return `${group.id}:${threadId}`;
}

/** What `state.json` holds for the topic's agent (its backend and the session ids), once the bot has written it. */
function readAgent(threadId: number): NonNullable<PersistedState['agents']>[string] | undefined {
  return readPersistedState(getLayout()).agents?.[getTopicKey(threadId)];
}

/** The operator's message that opens a request in the topic, labelled so its prompt is found in the agent's log. */
function ask(threadId: number, label: string): void {
  fakeTelegram.pushOperatorMessage(threadId, `${label} please carry on`);
}

/** The OpenCode session the fake created for the topic's folder (the newest one). */
function getOpenCodeSessionOf(folder: string): { id: string } {
  const folderPath = path.join(getLayout().workRoot, folder);
  const session = [...fakeOpenCode.sessions.values()].filter((candidate) => candidate.directory === folderPath).at(-1);
  assert.ok(session, `a fake OpenCode session for ${folderPath}`);
  return session;
}

describe('The usage-limit switch to and from OpenCode end to end: built charness, fake Bot API, fake claude, fake OpenCode', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-fbopencode-', [claudeToOpenCode.folder, openCodeToClaude.folder, openCodeToOpenCode.folder], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);
    resetsAtIso = computeResetsAtIso(takeoverDaysAhead);
    resetClock = getResetClock(resetsAtIso);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    general = new TopicDriver(fakeTelegram, getCharness, generalTopicThreadId, replyTimeoutMs);
    claudeTopic = new TopicDriver(fakeTelegram, getCharness, claudeToOpenCode.threadId, replyTimeoutMs);
    toClaudeTopic = new TopicDriver(fakeTelegram, getCharness, openCodeToClaude.threadId, replyTimeoutMs);
    openCodeTopic = new TopicDriver(fakeTelegram, getCharness, openCodeToOpenCode.threadId, replyTimeoutMs);
    const apiRoot = await fakeTelegram.start();

    // The OpenCode server the bot adopts, and the `opencode` CLI it shells out to, on the instance's private PATH.
    fakeOpenCode = new FakeOpenCodeServer({ version: fakeOpenCodeVersion, models: openCodeModels, defaultModel: defaultOpenCodeModel });
    const openCodeUrl = await fakeOpenCode.start(await getFreePort());
    writeFakeOpenCodeBinary(layout.binDir, { version: fakeOpenCodeVersion, models: openCodeModels });
    writeInstanceEnvFile(layout, {
      TELEGRAM_BOT_TOKEN: fakeBotToken,
      TELEGRAM_API_ROOT: apiRoot,
      ALLOWED_GROUP_ID: group.id.toString(),
      CHAT_MODE: 'group',
      DATA_DIR: layout.dataDir,
      WORK_ROOT: layout.workRoot,
      TMUX_TMPDIR: layout.tmuxTmpDir,
      CLAUDE_BIN: writeFakeClaudeLauncher(layout, null),
      OPENCODE_URL: openCodeUrl,
      SCHEDULER_MCP_PORT: (await getFreeFixedPort()).toString(),
    });
  });

  after(async () => {
    await charness?.stop();
    removeInstanceSync();
    await fakeTelegram?.stop();
    await fakeOpenCode?.stop();
    process.off('exit', removeInstanceSync);
    process.off('SIGINT', exitOnSignal);
    process.off('SIGTERM', exitOnSignal);
    assert.deepEqual(listTmuxSessions([]), defaultTmuxSessionsBefore, 'the default tmux server was not touched');
    assert.deepEqual(fakeOpenCode.unhandled, [], 'the bot asked the fake OpenCode for nothing it does not model');
  });

  it('boots against the fake OpenCode server (adopted, not spawned), sets the zone to UTC, turns auto switch on and binds the three topics', async () => {
    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    assert.ok(fakeOpenCode.listRequests('GET', '/global/health').length > 0, 'the bot probed the server');
    assert.ok(!getCharness().output.includes('Starting server on port'), 'a healthy, current server is adopted: no `opencode serve` is spawned');
    await general.sendAndAwaitReply('/timezone UTC', 'Timezone: UTC');
    await general.sendAndAwaitReply('/limits switch on', 'Auto switch to a fallback model: ON for ALL topics');
    for (const [driver, topic] of [[claudeTopic, claudeToOpenCode], [toClaudeTopic, openCodeToClaude], [openCodeTopic, openCodeToOpenCode]] as const) {
      await driver.sendAndAwaitReply(`/bind ${topic.folder}`, `Bound to \`${topic.folder}\``);
      await driver.sendAndAwaitReply('/verbosity stream_answers', 'This topic shows: Stream + answers');
    }
  });

  it('Claude → OpenCode: one notice, an OpenCode session in the topic\'s folder that starts with the context bridge, the Claude conversation parked', async () => {
    createClaudeProfileLayout({ dataDir: getLayout().dataDir, name: takeoverAccount, homeClaudeDir: path.join(getLayout().instanceHome, '.claude') });
    await restartWithState((persisted) => {
      persisted.claudeProfiles = { ...persisted.claudeProfiles, [takeoverAccount]: { createdAt: new Date().toISOString(), loggedIn: true, email: 'work@example.com', subscriptionType: 'max' } };
      persisted.fallbackChain = [{ backend: 'opencode', providerId: 'openai', modelId: 'gpt-5' }];
    });

    await claudeTopic.sendAndAwaitReply('/claude', 'ready in');
    claudeSessionId = getLaunchSessionId(getSessionLaunches(getLayout()).at(-1)?.argv ?? []) ?? '';
    assert.ok(claudeSessionId, 'the Claude agent runs a conversation');
    fakeTelegram.pushOperatorMessage(claudeToOpenCode.threadId, `LIM-A [fake:usage-limit-once] [limit-resets:${resetsAtIso}] please carry on`);

    const notice = await claudeTopic.waitForMessage('the switch notice', (message) => message.text.startsWith('🔁'));
    assert.equal(
      notice.text,
      `🔁 Account «${exhaustedAccount}» hit its usage limit — this topic continues on OpenCode ${chainOpenCodeModel}. The limit resets ${resetClock}; switch back: /accounts`,
    );
    await getCharness().waitFor('the bridge to reach the OpenCode session', agentStartTimeoutMs, () => fakeOpenCode.prompts.length > 0);

    const session = getOpenCodeSessionOf(claudeToOpenCode.folder);
    const [bridge] = fakeOpenCode.prompts.filter((prompt) => prompt.sessionId === session.id);
    assert.equal(bridge.model, chainOpenCodeModel, 'the prompt runs the rung\'s model');
    assert.match(bridge.text, /\[Backend switch\] You \(OpenCode · openai\/gpt-5\) are taking this conversation over from Claude · default/, 'the first prompt is the context bridge');
    assert.deepEqual(fakeOpenCode.mcpRegistrations.get(path.join(getLayout().workRoot, claudeToOpenCode.folder)), ['telegramBot'], 'the bot registered its MCP server in the folder\'s instance');

    await getCharness().waitFor('the switch to reach state.json', replyTimeoutMs, () => readAgent(claudeToOpenCode.threadId)?.name === openCodeAdapterName);
    assert.equal(readPersistedState(getLayout()).parkedSessions?.[getTopicKey(claudeToOpenCode.threadId)]?.claudeSessionId, claudeSessionId, 'the Claude conversation is parked for the way back');
    assert.equal(listSwitchNotices(claudeTopic).length, 1);
  });

  it('a plain `/claude` resumes the PARKED Claude conversation under the first account — the same id — and nothing more reaches OpenCode', async () => {
    const launchesBefore = getSessionLaunches(getLayout()).length;
    const openCodePromptsBefore = fakeOpenCode.prompts.length;

    fakeTelegram.pushOperatorMessage(claudeToOpenCode.threadId, '/claude');

    await waitForSessionRespawn(getCharness(), getLayout(), 'the parked Claude conversation to resume under the first account', null, claudeSessionId, launchesBefore);
    await getCharness().waitFor('the backend to be Claude again in state.json', replyTimeoutMs, () => readAgent(claudeToOpenCode.threadId)?.name === claudeJsonStreamAdapterName);
    assert.equal(readAgent(claudeToOpenCode.threadId)?.claudeSessionId, claudeSessionId, 'the SAME conversation');
    assert.equal(readPersistedState(getLayout()).parkedSessions?.[getTopicKey(claudeToOpenCode.threadId)]?.opencodeSessionId, getOpenCodeSessionOf(claudeToOpenCode.folder).id, 'the OpenCode session is parked in its turn');
    assert.equal(listSwitchNotices(claudeTopic).length, 1, 'going back by hand is not a limit: no limit notice');
    assert.equal(fakeOpenCode.prompts.length, openCodePromptsBefore, 'nothing more reaches OpenCode');
  });

  it('OpenCode → Claude: the model that hit the limit and the account it moved to are named; a new Claude conversation starts under that account with the bridge', async () => {
    await restartWithState((persisted) => {
      persisted.fallbackChain = [{ backend: 'claude', profile: takeoverAccount, model: null }];
    });
    await toClaudeTopic.sendAndAwaitReply('/opencode', 'ready in');
    const session = getOpenCodeSessionOf(openCodeToClaude.folder);
    openCodeSessionOfB = session.id;
    ask(openCodeToClaude.threadId, 'LIM-B');
    await getCharness().waitFor('the prompt to reach OpenCode', agentStartTimeoutMs, () => fakeOpenCode.prompts.some((prompt) => prompt.sessionId === session.id));
    const launchesBefore = getSessionLaunches(getLayout()).length;
    fakeOpenCode.emitUsageLimit(session.id, resetsAtIso);

    const notice = await toClaudeTopic.waitForMessage('the switch notice', (message) => message.text.startsWith('🔁'));
    assert.equal(
      notice.text,
      `🔁 Model «${defaultOpenCodeModel}» hit its usage limit — this topic continues on Claude «${takeoverAccount}». The limit resets ${resetClock}; switch back: /accounts`,
    );
    await getCharness().waitFor('a Claude session to start under the second account', agentStartTimeoutMs, () => {
      const latest = getSessionLaunches(getLayout()).at(-1);
      return getSessionLaunches(getLayout()).length > launchesBefore && latest?.claudeConfigDir === getAccountConfigDir(getLayout(), takeoverAccount);
    });
    await getCharness().waitFor('the switch to reach state.json', replyTimeoutMs, () => readAgent(openCodeToClaude.threadId)?.name === claudeJsonStreamAdapterName);
    assert.equal(readPersistedState(getLayout()).parkedSessions?.[getTopicKey(openCodeToClaude.threadId)]?.opencodeSessionId, session.id, 'the OpenCode session is parked for the way back');
  });

  it('a plain `/opencode` resumes the parked OpenCode session — the same id, no second session', async () => {
    const sessionRequestsBefore = fakeOpenCode.listRequests('GET', `/session/${openCodeSessionOfB}`).length;

    fakeTelegram.pushOperatorMessage(openCodeToClaude.threadId, '/opencode');

    await getCharness().waitFor('the OpenCode session to be resumed', agentStartTimeoutMs, () => fakeOpenCode.listRequests('GET', `/session/${openCodeSessionOfB}`).length > sessionRequestsBefore);
    await getCharness().waitFor('the backend to be OpenCode again in state.json', replyTimeoutMs, () => readAgent(openCodeToClaude.threadId)?.name === openCodeAdapterName);
    assert.equal(readAgent(openCodeToClaude.threadId)?.opencodeSessionId, openCodeSessionOfB, 'the SAME OpenCode session');
    assert.equal([...fakeOpenCode.sessions.values()].filter((session) => session.directory === path.join(getLayout().workRoot, openCodeToClaude.folder)).length, 1, 'no second session was created');
  });

  it('OpenCode → OpenCode: the model changes within the session and the "continue" message carries the rung\'s model', async () => {
    await restartWithState((persisted) => {
      persisted.fallbackChain = [{ backend: 'opencode', providerId: 'google', modelId: 'gemini-2.5-pro' }];
    });
    await openCodeTopic.sendAndAwaitReply('/opencode', 'ready in');
    const session = getOpenCodeSessionOf(openCodeToOpenCode.folder);
    ask(openCodeToOpenCode.threadId, 'LIM-C');
    await getCharness().waitFor('the prompt to reach OpenCode', agentStartTimeoutMs, () => fakeOpenCode.prompts.some((prompt) => prompt.sessionId === session.id));
    assert.equal(fakeOpenCode.prompts.at(-1)?.model, defaultOpenCodeModel, 'the first prompt runs the default model');
    const promptsBefore = fakeOpenCode.prompts.length;
    fakeOpenCode.emitUsageLimit(session.id, resetsAtIso);

    const notice = await openCodeTopic.waitForMessage('the switch notice', (message) => message.text.startsWith('🔁'));
    assert.equal(
      notice.text,
      `🔁 Model «${defaultOpenCodeModel}» hit its usage limit — this topic continues on OpenCode ${chainOpenCodeModelAlternative}. The limit resets ${resetClock}; switch back: /accounts`,
    );
    await getCharness().waitFor('the "continue" message to reach OpenCode', agentStartTimeoutMs, () => fakeOpenCode.prompts.length > promptsBefore);
    assert.equal(fakeOpenCode.prompts.at(-1)?.model, chainOpenCodeModelAlternative, 'the interrupted turn continues on the rung\'s model');

  });
});
