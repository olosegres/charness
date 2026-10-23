/**
 * @description A Claude account billed to a Claude Console organization's API credits, at PROCESS level: the BUILT
 * charness started the way an isolated instance is (`scripts/run-isolated.sh`) against the fake Bot API of
 * `telegramE2e/fakeTelegram.ts` and the fake `claude` (`jiraE2e/fakeClaude.ts`), which logs every launch (argv, the
 * config directory = the account, the NAMES of its environment) and emulates `claude auth login` / `auth status`.
 * The bot's OWN environment carries an `ANTHROPIC_API_KEY`: no session and no sign-in may ever see it. The test plays
 * the operator in one bound topic. One flow, in order:
 *
 *   boot → the instance zone is UTC, the topic is bound and its agent started on the subscription (`default`)
 *   → «➕ Claude API account» asks for a name; the answer creates the account and runs `claude auth login --console`
 *     in ITS directory; the link reaches the topic, the pasted code is deleted, and the bot confirms with the email
 *     and the Console organization; `/accounts` shows the account as `💳 API · pay per use`
 *   → a tap on it moves the topic: the session is re-spawned under the account's directory, the confirmation says
 *     every request is billed
 *   → an account holding a PASTED key (seeded while the bot is down: a key cannot be checked offline) is probed WITH
 *     its `apiKeyHelper` and launched with ONE settings file of its own — the PreCompact hook and the helper — whose
 *     helper really yields the key; the key is in no settings file, no wrapper script and not in `state.json`;
 *     `/status` marks the account `💳 API`
 *   → its credits run out («Credit balance is too low») with switching ON and a subscription in the chain: one
 *     notice says the credits are used up, the topic moves to the subscription at once, the account is marked out of
 *     credits (💸 in `/limits_autoswitch`), and NO wait for a reset is armed
 *   → the operator picks the account again (that ends the mark) and its credits run out with nothing to switch to and
 *     nothing that comes back at a known time: the notice alone — no wait, no hourly retry; `/status` says 💸
 *   → with the subscription limited until a known instant, the credits run out again: the topic waits for THAT reset
 *     and resumes on the subscription (the armed wait names it), never on the exhausted account
 *
 * What the unit tests cover instead: the key paste in the sign-in (`agentLogin.test.ts`), its check and storage
 * (`claudeAccounts.test.ts`, `claudeApiAccount.test.ts`), the trace redaction (`claudeApiAccount.test.ts`).
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
import { fakeClaudeApiErrorOnceFileName, fakeClaudeLoginUrl, getFlagValues, getLaunchSessionId } from './jiraE2e/fakeClaudeContract';
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
  getAccountConfigDir,
  getAllLaunches,
  getSessionLaunches,
  getStatePath,
  readPersistedState,
  restartCharnessWithState,
  startCharnessOnInstance,
  waitForSessionRespawn,
  type PersistedState,
} from './e2e/fallbackFlowKit';
import { claudeCompactHookSettingsFileName } from '../utils/claudeCompactHook';
import { claudeProfileLaunchSettingsFileName, createClaudeProfileLayout, writeClaudeProfileApiKey } from '../utils/claudeProfiles';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const topicThreadId = 121;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const folder = 'api-billed';
/** The account signed in through the (fake) Console login, and the one seeded with a pasted key. */
const consoleAccount = 'console';
const keyAccount = 'credits';
/** A key of the bot's OWN environment: it must reach no session and no sign-in. Never a real key. */
const botEnvApiKey = `sk-ant-api03-${'b'.repeat(40)}`;
/** The key the seeded account holds. Never a real key. */
const pastedApiKey = `sk-ant-api03-${'p'.repeat(40)}`;
const pastedCode = 'fake-console-code-4711';
/** What Claude Code says when a request is refused for a used-up balance. */
const creditBalanceError = 'Credit balance is too low';
/** The topic's key in `state.json`. */
const topicKey = `${group.id}:${topicThreadId}`;

const replyTimeoutMs = 20 * 1000;
const agentStartTimeoutMs = 60 * 1000;

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let general: TopicDriver;
let topic: TopicDriver;
let defaultTmuxSessionsBefore: string[] = [];
/** The topic's conversation — it must follow the topic onto every account. */
let sessionId = '';

function getLayout(): IsolatedInstanceLayout {
  if (!layout) throw new Error('the instance layout is not created yet');
  return layout;
}

/** The fake ends the NEXT turn on «Credit balance is too low»; the labelled message starts that turn. */
function runOutOfCredits(label: string): void {
  fs.writeFileSync(path.join(getLayout().fakeStateDir, fakeClaudeApiErrorOnceFileName), creditBalanceError);
  fakeTelegram.pushOperatorMessage(topicThreadId, `${label} please carry on`);
}

/** The bot's «credits used up» notices in the topic. */
function listBalanceNotices(): string[] {
  return topic.listMessages().map((message) => message.text).filter((text) => text.startsWith('💸'));
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

/**
 * Every REGULAR file under `dir`, recursively (the key must be in none of the bot's own files but the account's key
 * file). Links are not followed, and a FIFO (a session's stdin) is never opened — reading one would block.
 */
function listFilesRecursively(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFilesRecursively(entryPath);
    return entry.isFile() ? [entryPath] : [];
  });
}

describe('An account billed to API credits end to end: built charness, fake Bot API, fake claude', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-apibill-', [folder], getFlowDeadlineMs());
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
      ANTHROPIC_API_KEY: botEnvApiKey,
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

  it('boots, sets the instance zone to UTC, binds the topic and starts its agent on the subscription — without the bot\'s own API key', async () => {
    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    await general.sendAndAwaitReply('/timezone UTC', 'Timezone: UTC');
    await topic.sendAndAwaitReply(`/bind ${folder}`, `Bound to \`${folder}\``);
    await topic.sendAndAwaitReply('/claude', 'ready in');
    await getCharness().waitFor('the first session launch', agentStartTimeoutMs, () => getSessionLaunches(getLayout()).length === 1);
    const [launch] = getSessionLaunches(getLayout());
    assert.equal(launch.claudeConfigDir, null, 'the default account');
    assert.ok(!(launch.envNames ?? []).includes('ANTHROPIC_API_KEY'), 'the subscription session never sees an API key');
    assert.deepEqual(getFlagValues(launch.argv, '--settings'), [path.join(getLayout().dataDir, claudeCompactHookSettingsFileName)], 'the shared hook settings');
    sessionId = getLaunchSessionId(launch.argv) ?? '';
    assert.ok(sessionId);
  });

  it('«➕ Claude API account» creates the account and signs it in to the Claude Console in its own directory; the code message is deleted', async () => {
    const screen = await topic.sendAndAwaitReply('/accounts', 'This topic runs on');
    assert.ok(topic.getKeyboardData(screen).some((row) => row.includes('acct_addapi')), 'the screen offers the API account');
    await topic.tapAndAwaitAnswer(screen, 'acct_addapi');
    await topic.waitForMessage('the name question', (message) => message.text.includes('Name for the new API account'));
    await topic.sendAndAwaitReply(consoleAccount, `API account ${consoleAccount} created`);
    const link = await topic.waitForMessage('the Console sign-in link', (message) => message.text.includes(fakeClaudeLoginUrl));
    assert.match(link.text, new RegExp(`Claude Console for API account ${consoleAccount}`));
    assert.match(link.text, /sk-ant-api/, 'the link message offers a pasted key instead');

    const consoleDir = getAccountConfigDir(getLayout(), consoleAccount);
    const login = getAllLaunches(getLayout()).find((launch) => launch.argv.includes('login'));
    assert.deepEqual(login?.argv, ['auth', 'login', '--console'], 'the Console login, never the subscription');
    assert.equal(login?.claudeConfigDir, consoleDir, 'into the account\'s own directory');
    assert.ok(!(login?.envNames ?? []).includes('ANTHROPIC_API_KEY'), 'the sign-in never sees the bot\'s API key');

    const deletesBefore = fakeTelegram.listCalls('deleteMessage').length;
    const codeMessageId = fakeTelegram.pushOperatorMessage(topicThreadId, pastedCode);
    const confirmation = await topic.waitForMessage('the sign-in confirmation', (message) => message.text.includes(`API account ${consoleAccount} signed in`));
    assert.match(confirmation.text, /ops@example\.com — Claude Console organization Example Org/);
    assert.ok(
      fakeTelegram.listCalls('deleteMessage').slice(deletesBefore).some((call) => Number(call.payload.message_id) === codeMessageId),
      'the code message is deleted',
    );
    const record = readPersistedState(getLayout()).claudeProfiles?.[consoleAccount];
    assert.equal(record?.billing, 'api');
    assert.equal(record?.loggedIn, true);

    const after = await topic.sendAndAwaitReply('/accounts', 'This topic runs on');
    assert.match(after.text, new RegExp(`• ${consoleAccount} — ops@example\\.com, 💳 API · pay per use`));
    assert.ok(topic.getKeyboardLabels(after).flat().includes(`${consoleAccount} · ops@example.com 💳`));
  });

  it('a tap on the API account moves the topic onto it, same conversation, and says every request is billed', async () => {
    const screen = await topic.sendAndAwaitReply('/accounts', 'This topic runs on');
    const launchesBefore = getSessionLaunches(getLayout()).length;
    const answer = await topic.tapAndAwaitAnswer(screen, `acct_use_${consoleAccount}`);
    assert.match(answer, new RegExp(`Claude account for this topic: ${consoleAccount}`));
    assert.match(answer, /💳 This account is billed per request/);
    const consoleDir = getAccountConfigDir(getLayout(), consoleAccount);
    await waitForSessionRespawn(getCharness(), getLayout(), 'the session under the API account', consoleDir, sessionId, launchesBefore);
    const launch = getSessionLaunches(getLayout()).at(-1);
    assert.ok(!(launch?.envNames ?? []).includes('ANTHROPIC_API_KEY'), 'its key is the Console login\'s, never the variable');
  });

  it('an account holding a pasted key is probed and launched with ONE settings file of its own whose helper yields the key; the key is in no file of the bot but its own', async () => {
    const keyDir = getAccountConfigDir(getLayout(), keyAccount);
    createClaudeProfileLayout({ dataDir: getLayout().dataDir, name: keyAccount, homeClaudeDir: path.join(getLayout().instanceHome, '.claude') });
    writeClaudeProfileApiKey(keyDir, pastedApiKey);
    await restartWithState((persisted) => {
      persisted.claudeProfiles = { ...persisted.claudeProfiles, [keyAccount]: { createdAt: new Date().toISOString(), loggedIn: true, billing: 'api' } };
    });

    const launchesBefore = getSessionLaunches(getLayout()).length;
    const allLaunchesBefore = getAllLaunches(getLayout()).length;
    await topic.sendAndAwaitReply(`/accounts use ${keyAccount}`, `Claude account for this topic: ${keyAccount}`);
    const probe = getAllLaunches(getLayout()).slice(allLaunchesBefore).find((launch) => launch.argv.includes('status') && launch.claudeConfigDir === keyDir);
    assert.ok(probe, 'the account was probed under its directory');
    assert.equal(probe?.isHelperKeyPlausible, true, 'the probe carries the account\'s apiKeyHelper');

    await waitForSessionRespawn(getCharness(), getLayout(), 'the session under the key account', keyDir, sessionId, launchesBefore);
    const launch = getSessionLaunches(getLayout()).at(-1);
    const settingsPath = path.join(keyDir, claudeProfileLaunchSettingsFileName);
    assert.deepEqual(getFlagValues(launch?.argv ?? [], '--settings'), [settingsPath], 'ONE settings file, the account\'s own');
    assert.equal(launch?.isHelperKeyPlausible, true, 'its helper yields the key');
    assert.ok(!(launch?.envNames ?? []).includes('ANTHROPIC_API_KEY'));
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.ok(settings.hooks?.PreCompact, 'the PreCompact hook rides the same file');

    const filesWithTheKey = listFilesRecursively(getLayout().dataDir).filter((file) => fs.readFileSync(file, 'utf8').includes(pastedApiKey));
    assert.deepEqual(filesWithTheKey, [path.join(keyDir, 'charness-api-key')], 'the key is in its own file only: not in settings, a wrapper script, state.json or a log');
    assert.ok(!fs.readFileSync(getStatePath(getLayout()), 'utf8').includes(botEnvApiKey));

    const status = await topic.sendAndAwaitReply('/status', 'Account:');
    assert.match(status.text, new RegExp(`Account: ${keyAccount} · 💳 API`));
  });

  it('credits used up with switching ON and a subscription in the chain: one notice, the topic moves at once, the account is marked, and no wait is armed', async () => {
    await restartWithState((persisted) => {
      persisted.fallbackChain = [{ backend: 'claude', profile: keyAccount, model: null }, { backend: 'claude', profile: 'default', model: null }];
      persisted.claudeAutoSwitchOnLimitEnabled = true;
    });
    const launchesBefore = getSessionLaunches(getLayout()).length;
    runOutOfCredits('BAL-1');
    await topic.waitForMessage('the credits notice', (message) => message.text.startsWith('💸'));
    assert.match(listBalanceNotices()[0], new RegExp(`^💸 «${keyAccount}»: the API credits are used up \\(«Credit balance is too low»\\)\\. Waiting does not refill them`));
    const switched = await topic.waitForMessage('the switch notice', (message) => message.text.startsWith('🔁'));
    assert.match(switched.text, new RegExp(`«${keyAccount}» .*continues on «default»`));
    await waitForSessionRespawn(getCharness(), getLayout(), 'the conversation to continue on the subscription', null, sessionId, launchesBefore);

    const persisted = readPersistedState(getLayout());
    assert.ok(persisted.claudeProfiles?.[keyAccount]?.creditExhaustedAt, 'the account is marked out of credits');
    assert.equal(persisted.claudeProfiles?.[keyAccount]?.limitedUntil, undefined, 'no reset is invented for a balance');
    assert.equal(persisted.apiRetries?.[topicKey], undefined, 'no wait for a reset');
    assert.ok(!topic.listMessages().some((message) => /Usage limit reached|will auto-resume/.test(message.text)), 'no wait notice');

    const chain = await topic.sendAndAwaitReply('/limits_autoswitch', 'Fallback models, top first');
    assert.ok(topic.getKeyboardLabels(chain).flat().some((label) => label === `1. Claude · ${keyAccount} 💸`), 'the rung says its credits are used up');
  });

  it('picked again (the mark ends) and out of credits with nothing to switch to and nothing that comes back at a known time: the notice alone — no wait, no retry', async () => {
    await restartWithState((persisted) => {
      persisted.fallbackChain = [{ backend: 'claude', profile: keyAccount, model: null }];
    });
    const launchesBefore = getSessionLaunches(getLayout()).length;
    await topic.sendAndAwaitReply(`/accounts use ${keyAccount}`, `Claude account for this topic: ${keyAccount}`);
    await waitForSessionRespawn(getCharness(), getLayout(), 'the session back on the API account', getAccountConfigDir(getLayout(), keyAccount), sessionId, launchesBefore);
    await getCharness().waitFor('the pick to end the mark', replyTimeoutMs, () => readPersistedState(getLayout()).claudeProfiles?.[keyAccount]?.creditExhaustedAt === undefined);

    const noticesBefore = listBalanceNotices().length;
    runOutOfCredits('BAL-2');
    await getCharness().waitFor('the second credits notice', replyTimeoutMs, () => listBalanceNotices().length === noticesBefore + 1);
    assert.match(listBalanceNotices().at(-1) ?? '', /Top up the balance .* then pick the account again: \/limits$/);
    // Settle: an armed wait would be persisted right after the notice.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const persisted = readPersistedState(getLayout());
    assert.equal(persisted.apiRetries?.[topicKey], undefined, 'no wait, no hourly retry');
    assert.ok(persisted.claudeProfiles?.[keyAccount]?.creditExhaustedAt);
    const status = await topic.sendAndAwaitReply('/status', 'Account:');
    assert.match(status.text, new RegExp(`Account: ${keyAccount} · 💳 API · 💸 credits used up`));
  });

  it('with the subscription limited until a known instant, credits used up again: the topic waits for THAT reset and resumes on the subscription', async () => {
    const subscriptionResetMs = Date.now() + 26 * 3_600_000;
    await restartWithState((persisted) => {
      persisted.fallbackChain = [{ backend: 'claude', profile: 'default', model: null }, { backend: 'claude', profile: keyAccount, model: null }];
      persisted.claudeProfiles = { ...persisted.claudeProfiles, default: { createdAt: new Date().toISOString(), limitedUntil: new Date(subscriptionResetMs).toISOString() } };
      delete persisted.claudeProfiles[keyAccount]?.creditExhaustedAt;
    });
    const noticesBefore = listBalanceNotices().length;
    runOutOfCredits('BAL-3');
    await getCharness().waitFor('the third credits notice', replyTimeoutMs, () => listBalanceNotices().length === noticesBefore + 1);
    await getCharness().waitFor('the wait to be armed', replyTimeoutMs, () => readPersistedState(getLayout()).apiRetries?.[topicKey] !== undefined);
    const retry = readPersistedState(getLayout()).apiRetries?.[topicKey] as { kind: string; fireAt: number; resumeOn?: unknown } | undefined;
    assert.equal(retry?.kind, 'usageLimit');
    assert.deepEqual(retry?.resumeOn, { backend: 'claude', profile: 'default', model: null }, 'the wait ends on the subscription');
    assert.ok(Math.abs((retry?.fireAt ?? 0) - (subscriptionResetMs + 60_000)) < 2_000, 'at its reset, not an hour from now');
    assert.match(listBalanceNotices().at(-1) ?? '', /\n\n.*default/, 'the notice says where and when the work resumes');
  });
});
