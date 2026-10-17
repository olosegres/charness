/**
 * @description The switches between Claude and OpenCode at PROCESS level: the BUILT charness
 * started the way an isolated instance is (`scripts/run-isolated.sh`) against the fake Bot API
 * (`telegramE2e/fakeTelegram.ts`), the fake `claude` (`jiraE2e/fakeClaude.ts`) and a fake OpenCode server + CLI
 * (`openCodeE2e/fakeOpenCodeServer.ts`) that serves only what the bot calls and lists anything else as `unhandled`.
 * The bot ADOPTS that server (it is healthy and current) instead of spawning one. Four topics:
 *
 *   A  Claude → OpenCode: the Claude agent hits a subscription limit, the chain's rung is an OpenCode model. The
 *      notice names the account that hit it and `OpenCode openai/gpt-5`; the OpenCode session is created in the
 *      topic's folder and its first prompt is the context bridge; the Claude conversation is parked. A `/claude`
 *      by hand then ASKS first (the conversation is handed over in compacted form): ✖️ Cancel changes nothing,
 *      ✅ Continue resumes the PARKED Claude conversation (same id) under the first account, the bridge being its
 *      first prompt.
 *   B  OpenCode → Claude: the OpenCode session's turn fails with a usage limit, the chain's rung is a Claude account.
 *      The notice names the model that hit it and `Claude «work»`; a new Claude conversation starts under that
 *      account with the bridge. `/opencode` by hand asks, ✅ resumes the parked OpenCode session (same id) with the
 *      bridge; a Claude account tapped in `/accounts` on that OpenCode topic asks, ✅ resumes the parked Claude
 *      conversation under that account (the pick is recorded only now).
 *   C  OpenCode → OpenCode: the model changes within the session; the next prompt — the "continue" message — carries
 *      the rung's model. A Claude account tapped in `/accounts` then asks, and ✖️ Cancel leaves the topic on
 *      OpenCode with no pick recorded.
 *   D  A fresh topic (an agent started and not yet spoken to) switches in both directions without asking.
 *
 * Nothing leaves the machine: every server is on loopback and every agent is a fake. Everything the test starts is
 * stopped in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram, generalTopicThreadId, type FakeTelegramMessage } from './telegramE2e/fakeTelegram';
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
  listBridgePrompts,
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
const freshSwitch = { threadId: 114, folder: 'oc-fresh' };

const fakeOpenCodeVersion = '1.17.11';
/** The model OpenCode runs by default, and the ones the chain names. */
const defaultOpenCodeModel = 'anthropic/claude-sonnet-4-6';
const chainOpenCodeModel = 'openai/gpt-5';
const chainOpenCodeModelAlternative = 'google/gemini-2.5-pro';
const openCodeModels = [defaultOpenCodeModel, chainOpenCodeModel, chainOpenCodeModelAlternative] as const;
const exhaustedAccount = 'default';
const takeoverAccount = 'work';
/** The first line of the question before a manual switch, and the line every such confirmation ends with. */
const switchQuestionStart = '🔁 Switch this topic from';
const handoverNote = 'The conversation context will be handed over in compacted form.';
const continueButton = '✅ Continue';
const cancelButton = '✖️ Cancel';
const continueCallback = 'bsw_ok';
const cancelCallback = 'bsw_no';

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
let freshTopic: TopicDriver;
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

/** Whether a bot message is the question before a manual switch between the backends. */
function checkIsSwitchQuestion(message: FakeTelegramMessage): boolean {
  return message.text.startsWith(switchQuestionStart);
}

/** The newest switch question of the topic that is newer than `afterMessageId`. */
async function waitForSwitchQuestion(driver: TopicDriver, afterMessageId: number): Promise<FakeTelegramMessage> {
  return driver.waitForMessage('the question before the switch', (message) => checkIsSwitchQuestion(message) && message.message_id > afterMessageId);
}

/** The newest message id the operator can have sent: questions asked after it are the ones this step provokes. */
function getLatestMessageId(driver: TopicDriver): number {
  return driver.listMessages().at(-1)?.message_id ?? 0;
}

/** Assert the question's text and its two buttons; the text is the question line, then the shared hand-over line. */
function assertSwitchQuestion(driver: TopicDriver, question: FakeTelegramMessage, questionLine: string): void {
  assert.equal(question.text, `${questionLine}\n${handoverNote}`);
  assert.deepEqual(driver.getKeyboardLabels(question), [[continueButton, cancelButton]]);
  assert.deepEqual(driver.getKeyboardData(question), [[continueCallback, cancelCallback]]);
}

/** Tap a Claude account in the topic's `/accounts` picker (the account is the one the pick names). */
async function tapAccountInPicker(driver: TopicDriver, threadId: number, profile: string): Promise<string> {
  const sentMessageId = fakeTelegram.pushOperatorMessage(threadId, '/accounts');
  const picker = await driver.waitForMessage('the /accounts picker', (message) => message.message_id > sentMessageId && driver.getKeyboardData(message).flat().includes(`acct_use_${profile}`));
  return driver.tapAndAwaitAnswer(picker, `acct_use_${profile}`);
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
    layout = createIsolatedInstanceLayout('charness-fbopencode-', [claudeToOpenCode.folder, openCodeToClaude.folder, openCodeToOpenCode.folder, freshSwitch.folder], getFlowDeadlineMs());
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
    freshTopic = new TopicDriver(fakeTelegram, getCharness, freshSwitch.threadId, replyTimeoutMs);
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

  it('boots against the fake OpenCode server (adopted, not spawned), sets the zone to UTC, turns auto switch on and binds the four topics', async () => {
    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    assert.ok(fakeOpenCode.listRequests('GET', '/global/health').length > 0, 'the bot probed the server');
    assert.ok(!getCharness().output.includes('Starting server on port'), 'a healthy, current server is adopted: no `opencode serve` is spawned');
    await general.sendAndAwaitReply('/timezone UTC', 'Timezone: UTC');
    await general.sendAndAwaitReply('/limits switch on', 'Auto switch to a fallback model: ON for ALL topics');
    for (const [driver, topic] of [[claudeTopic, claudeToOpenCode], [toClaudeTopic, openCodeToClaude], [openCodeTopic, openCodeToOpenCode], [freshTopic, freshSwitch]] as const) {
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

  it('a `/claude` by hand in a topic that runs OpenCode asks first: ✖️ Cancel changes nothing, ✅ Continue resumes the PARKED Claude conversation — the same id — under the first account with the bridge as its first prompt', async () => {
    const launchesBefore = getSessionLaunches(getLayout()).length;
    const openCodePromptsBefore = fakeOpenCode.prompts.length;
    const bridgesBefore = listBridgePrompts(getLayout()).length;

    const askedAfter = getLatestMessageId(claudeTopic);
    fakeTelegram.pushOperatorMessage(claudeToOpenCode.threadId, '/claude');
    const question = await waitForSwitchQuestion(claudeTopic, askedAfter);
    assertSwitchQuestion(claudeTopic, question, '🔁 Switch this topic from OpenCode to Claude «default»?');

    await claudeTopic.tapAndAwaitAnswer(question, cancelCallback);
    await claudeTopic.waitForMessageText('the question to turn into the cancel line', question, (text) => text === '✖️ Cancelled — this topic stays on OpenCode.');
    assert.deepEqual(claudeTopic.getKeyboardData(question), [], 'the keyboard is consumed');
    assert.equal(readAgent(claudeToOpenCode.threadId)?.name, openCodeAdapterName, 'still on OpenCode');
    assert.equal(getSessionLaunches(getLayout()).length, launchesBefore, 'no Claude process was started');

    const askedAgainAfter = getLatestMessageId(claudeTopic);
    fakeTelegram.pushOperatorMessage(claudeToOpenCode.threadId, '/claude');
    const secondQuestion = await waitForSwitchQuestion(claudeTopic, askedAgainAfter);
    await claudeTopic.tapAndAwaitAnswer(secondQuestion, continueCallback);

    await waitForSessionRespawn(getCharness(), getLayout(), 'the parked Claude conversation to resume under the first account', null, claudeSessionId, launchesBefore);
    await getCharness().waitFor('the backend to be Claude again in state.json', replyTimeoutMs, () => readAgent(claudeToOpenCode.threadId)?.name === claudeJsonStreamAdapterName);
    await claudeTopic.waitForMessageText('the question to turn into the outcome line', secondQuestion, (text) => text === '🔁 Switched this topic to Claude «default».');
    assert.deepEqual(claudeTopic.getKeyboardData(secondQuestion), [], 'the keyboard is consumed');
    assert.equal(readAgent(claudeToOpenCode.threadId)?.claudeSessionId, claudeSessionId, 'the SAME conversation');
    assert.equal(readPersistedState(getLayout()).claudeProfileOverrides?.[getTopicKey(claudeToOpenCode.threadId)], undefined, 'a confirmed `/claude` names the account the topic follows but saves no pick of its own: the topic keeps following General');
    assert.equal(readPersistedState(getLayout()).parkedSessions?.[getTopicKey(claudeToOpenCode.threadId)]?.opencodeSessionId, getOpenCodeSessionOf(claudeToOpenCode.folder).id, 'the OpenCode session is parked in its turn');

    await getCharness().waitFor('the bridge to reach the resumed Claude conversation', agentStartTimeoutMs, () => listBridgePrompts(getLayout()).length > bridgesBefore);
    assert.match(listBridgePrompts(getLayout()).at(-1)?.text ?? '', /\[Backend switch\] You \(Claude · default\) are taking this conversation over from OpenCode, because the operator switched this topic's agent\./, 'the first prompt is the context bridge, worded for a manual switch');
    assert.equal(listSwitchNotices(claudeTopic).length, 1, 'going back by hand is not a limit: no limit notice');
    assert.equal(fakeOpenCode.prompts.length, openCodePromptsBefore, 'nothing more reaches OpenCode');

    const staleAnswer = await claudeTopic.tapAndAwaitAnswer(secondQuestion, continueCallback);
    assert.equal(staleAnswer, 'This question is out of date — nothing was switched.', 'a consumed question cannot switch again');
    assert.equal(getSessionLaunches(getLayout()).length, launchesBefore + 1, 'the stale tap started nothing');
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
    const bridgesBefore = listBridgePrompts(getLayout()).length;
    fakeOpenCode.emitUsageLimit(session.id, resetsAtIso);

    const notice = await toClaudeTopic.waitForMessage('the switch notice', (message) => message.text.startsWith('🔁'));
    assert.equal(
      notice.text,
      `🔁 Model ${defaultOpenCodeModel} hit its usage limit — this topic continues on Claude «${takeoverAccount}». The limit resets ${resetClock}; switch back: /accounts`,
    );
    await getCharness().waitFor('a Claude session to start under the second account', agentStartTimeoutMs, () => {
      const latest = getSessionLaunches(getLayout()).at(-1);
      return getSessionLaunches(getLayout()).length > launchesBefore && latest?.claudeConfigDir === getAccountConfigDir(getLayout(), takeoverAccount);
    });
    await getCharness().waitFor('the switch to reach state.json', replyTimeoutMs, () => readAgent(openCodeToClaude.threadId)?.name === claudeJsonStreamAdapterName);
    assert.equal(readPersistedState(getLayout()).parkedSessions?.[getTopicKey(openCodeToClaude.threadId)]?.opencodeSessionId, session.id, 'the OpenCode session is parked for the way back');
    await getCharness().waitFor('the bridge to reach the new Claude conversation', agentStartTimeoutMs, () => listBridgePrompts(getLayout()).length > bridgesBefore);
    assert.match(listBridgePrompts(getLayout()).at(-1)?.text ?? '', /\[Backend switch\] You \(Claude · work · topic's model\) are taking this conversation over from OpenCode · anthropic\/claude-sonnet-4-6, which hit a usage limit/, 'the first prompt is the context bridge');
  });

  it('a `/opencode` by hand in a Claude topic with a conversation asks first, naming the model; ✅ Continue resumes the parked OpenCode session — the same id, no second session — and the bridge is its next prompt', async () => {
    const sessionRequestsBefore = fakeOpenCode.listRequests('GET', `/session/${openCodeSessionOfB}`).length;
    const promptsBefore = fakeOpenCode.prompts.length;

    const askedAfter = getLatestMessageId(toClaudeTopic);
    fakeTelegram.pushOperatorMessage(openCodeToClaude.threadId, '/opencode');
    const question = await waitForSwitchQuestion(toClaudeTopic, askedAfter);
    assertSwitchQuestion(toClaudeTopic, question, `🔁 Switch this topic from Claude to OpenCode ${defaultOpenCodeModel}?`);
    assert.equal(readAgent(openCodeToClaude.threadId)?.name, claudeJsonStreamAdapterName, 'nothing moved before the answer');

    await toClaudeTopic.tapAndAwaitAnswer(question, continueCallback);

    await getCharness().waitFor('the OpenCode session to be resumed', agentStartTimeoutMs, () => fakeOpenCode.listRequests('GET', `/session/${openCodeSessionOfB}`).length > sessionRequestsBefore);
    await getCharness().waitFor('the backend to be OpenCode again in state.json', replyTimeoutMs, () => readAgent(openCodeToClaude.threadId)?.name === openCodeAdapterName);
    await toClaudeTopic.waitForMessageText('the question to turn into the outcome line', question, (text) => text === `🔁 Switched this topic to OpenCode ${defaultOpenCodeModel}.`);
    assert.equal(readAgent(openCodeToClaude.threadId)?.opencodeSessionId, openCodeSessionOfB, 'the SAME OpenCode session');
    assert.equal([...fakeOpenCode.sessions.values()].filter((session) => session.directory === path.join(getLayout().workRoot, openCodeToClaude.folder)).length, 1, 'no second session was created');

    await getCharness().waitFor('the bridge to reach the resumed OpenCode session', agentStartTimeoutMs, () => fakeOpenCode.prompts.length > promptsBefore);
    const bridge = fakeOpenCode.prompts.at(-1);
    assert.equal(bridge?.sessionId, openCodeSessionOfB);
    assert.match(bridge?.text ?? '', /\[Backend switch\] You \(OpenCode · anthropic\/claude-sonnet-4-6\) are taking this conversation over from Claude, because the operator switched this topic's agent\./);
  });

  it('a Claude account tapped in `/accounts` on a topic that runs OpenCode is a switch: it asks naming the account, ✅ Continue records the pick and resumes the PARKED Claude conversation under it with the bridge', async () => {
    const parkedClaudeSessionId = readPersistedState(getLayout()).parkedSessions?.[getTopicKey(openCodeToClaude.threadId)]?.claudeSessionId ?? '';
    assert.ok(parkedClaudeSessionId, 'the Claude conversation the limit left is parked');
    const launchesBefore = getSessionLaunches(getLayout()).length;
    const bridgesBefore = listBridgePrompts(getLayout()).length;

    const askedAfter = getLatestMessageId(toClaudeTopic);
    const tapAnswer = await tapAccountInPicker(toClaudeTopic, openCodeToClaude.threadId, takeoverAccount);
    assert.equal(tapAnswer, '', 'the tap raises no toast: the question is the answer');
    const question = await waitForSwitchQuestion(toClaudeTopic, askedAfter);
    assertSwitchQuestion(toClaudeTopic, question, `🔁 Switch this topic from OpenCode to Claude «${takeoverAccount}»?`);
    assert.equal(readAgent(openCodeToClaude.threadId)?.name, openCodeAdapterName, 'the topic is still on OpenCode');

    await toClaudeTopic.tapAndAwaitAnswer(question, continueCallback);

    await waitForSessionRespawn(getCharness(), getLayout(), 'the parked Claude conversation to resume under the picked account', getAccountConfigDir(getLayout(), takeoverAccount), parkedClaudeSessionId, launchesBefore);
    await getCharness().waitFor('the backend to be Claude in state.json', replyTimeoutMs, () => readAgent(openCodeToClaude.threadId)?.name === claudeJsonStreamAdapterName);
    await toClaudeTopic.waitForMessageText('the question to turn into the outcome line', question, (text) => text === `🔁 Switched this topic to Claude «${takeoverAccount}».`);
    assert.equal(readPersistedState(getLayout()).claudeProfileOverrides?.[getTopicKey(openCodeToClaude.threadId)], takeoverAccount, 'the pick is recorded now');
    assert.equal(readPersistedState(getLayout()).parkedSessions?.[getTopicKey(openCodeToClaude.threadId)]?.opencodeSessionId, openCodeSessionOfB, 'the OpenCode session is parked again');

    await getCharness().waitFor('the bridge to reach the resumed Claude conversation', agentStartTimeoutMs, () => listBridgePrompts(getLayout()).length > bridgesBefore);
    assert.match(listBridgePrompts(getLayout()).at(-1)?.text ?? '', /\[Backend switch\] You \(Claude · work\) are taking this conversation over from OpenCode, because the operator switched this topic's agent\./);
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
      `🔁 Model ${defaultOpenCodeModel} hit its usage limit — this topic continues on OpenCode ${chainOpenCodeModelAlternative}. The limit resets ${resetClock}; switch back: /accounts`,
    );
    await getCharness().waitFor('the "continue" message to reach OpenCode', agentStartTimeoutMs, () => fakeOpenCode.prompts.length > promptsBefore);
    assert.equal(fakeOpenCode.prompts.at(-1)?.model, chainOpenCodeModelAlternative, 'the interrupted turn continues on the rung\'s model');
  });

  it('✖️ Cancel on the account question leaves an OpenCode topic on OpenCode: no pick recorded, no Claude process; the cancelled question cannot be continued', async () => {
    const launchesBefore = getSessionLaunches(getLayout()).length;
    const promptsBefore = fakeOpenCode.prompts.length;

    const askedAfter = getLatestMessageId(openCodeTopic);
    await tapAccountInPicker(openCodeTopic, openCodeToOpenCode.threadId, takeoverAccount);
    const question = await waitForSwitchQuestion(openCodeTopic, askedAfter);
    assertSwitchQuestion(openCodeTopic, question, `🔁 Switch this topic from OpenCode to Claude «${takeoverAccount}»?`);

    await openCodeTopic.tapAndAwaitAnswer(question, cancelCallback);
    await openCodeTopic.waitForMessageText('the question to turn into the cancel line', question, (text) => text === '✖️ Cancelled — this topic stays on OpenCode.');
    assert.deepEqual(openCodeTopic.getKeyboardData(question), [], 'the keyboard is consumed');
    assert.equal(readAgent(openCodeToOpenCode.threadId)?.name, openCodeAdapterName);
    assert.equal(readPersistedState(getLayout()).claudeProfileOverrides?.[getTopicKey(openCodeToOpenCode.threadId)], undefined, 'no pick was recorded');
    assert.equal(getSessionLaunches(getLayout()).length, launchesBefore, 'no Claude process was started');

    const staleAnswer = await openCodeTopic.tapAndAwaitAnswer(question, continueCallback);
    assert.equal(staleAnswer, 'This question is out of date — nothing was switched.');
    assert.equal(readAgent(openCodeToOpenCode.threadId)?.name, openCodeAdapterName);
    assert.equal(getSessionLaunches(getLayout()).length, launchesBefore);
    assert.equal(fakeOpenCode.prompts.length, promptsBefore, 'nothing reached OpenCode');
  });

  it('a fresh topic — an agent started and not yet spoken to — switches between the backends at once, in both directions, without asking', async () => {
    await freshTopic.sendAndAwaitReply('/opencode', 'ready in');
    const freshSession = getOpenCodeSessionOf(freshSwitch.folder);
    const launchesBefore = getSessionLaunches(getLayout()).length;

    await freshTopic.sendAndAwaitReply(`/accounts use ${takeoverAccount}`, `🔁 Switched this topic to Claude «${takeoverAccount}».`);
    await getCharness().waitFor('a Claude session to start under the picked account', agentStartTimeoutMs, () => {
      const launches = getSessionLaunches(getLayout());
      return launches.length > launchesBefore && launches.at(-1)?.claudeConfigDir === getAccountConfigDir(getLayout(), takeoverAccount);
    });
    await getCharness().waitFor('the backend to be Claude in state.json', replyTimeoutMs, () => readAgent(freshSwitch.threadId)?.name === claudeJsonStreamAdapterName);
    assert.equal(readPersistedState(getLayout()).claudeProfileOverrides?.[getTopicKey(freshSwitch.threadId)], takeoverAccount);

    fakeTelegram.pushOperatorMessage(freshSwitch.threadId, '/opencode');
    await getCharness().waitFor('the backend to be OpenCode again in state.json', agentStartTimeoutMs, () => readAgent(freshSwitch.threadId)?.name === openCodeAdapterName);
    assert.equal(readAgent(freshSwitch.threadId)?.opencodeSessionId, freshSession.id, 'the parked OpenCode session is back');

    assert.deepEqual(freshTopic.listMessages().filter(checkIsSwitchQuestion), [], 'no question was asked in either direction');
    assert.equal(fakeOpenCode.prompts.filter((prompt) => prompt.sessionId === freshSession.id).length, 0, 'no bridge: there was nothing to hand over');
  });
});
