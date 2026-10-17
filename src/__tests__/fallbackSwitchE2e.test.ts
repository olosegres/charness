/**
 * @description The notice a usage-limit auto-switch posts, at PROCESS level: the BUILT charness started the way an
 * isolated instance is (`scripts/run-isolated.sh`) against the fake Bot API of `telegramE2e/fakeTelegram.ts`, with
 * the fake `claude` (`jiraE2e/fakeClaude.ts`) refusing a turn for a subscription limit (`usage-limit-once`) and
 * recording how every session is launched (the config directory = the account). The test plays the operator in
 * the General topic and in two bound topics. One flow, in order:
 *
 *   boot → the instance zone is set to UTC, auto switch is turned on in General, two topics are bound (each message
 *     opens a request, as in the operator's own topics)
 *   → a second account («work») and a one-rung chain are seeded while the bot is down (a sign-in cannot be driven
 *     without the real CLI), the bot starts again
 *   → topic A's agent hits its limit: ONE short notice names the account that hit it, the account the topic
 *     continues on, when the limit resets (in the instance zone) and `/accounts` — and no wait notice; the same
 *     conversation continues under the second account and answers
 *   → `/accounts use default` — the command the notice names — moves the topic back: the session is re-spawned
 *     under the first account, same conversation
 *   → the chain's rung pins a model («work» · sonnet): topic B's notice names the model, and the session really
 *     runs on it
 *
 * What the unit tests cover instead: the other backends' wording (OpenCode, no OpenCode server here), a rung
 * whose model the session already runs, an unknown reset, the deferred notice (a tmux Claude without a resumable
 * session) and every locale (`fallbackSwitchNotice.test.ts`).
 *
 * Nothing leaves the machine: the Bot API is on loopback and the agent is a fake. Everything the test starts is
 * stopped in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram, generalTopicThreadId, type FakeTelegramMessage } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import { fakeClaudeLogFileNames, getFlagValues, getLaunchSessionId, type FakeClaudeTurn } from './jiraE2e/fakeClaudeContract';
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
import { createClaudeProfileLayout } from '../utils/claudeProfiles';
import type { ClaudeProfileRecord } from '../state';
import type { FallbackChainEntry } from '../utils/fallbackChain';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const firstTopicThreadId = 111;
const secondTopicThreadId = 112;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const firstFolder = 'switch-first';
const secondFolder = 'switch-second';
const launchLine = 'Launching Telegraf bot (long polling';
/** The account the second one takes over from, and the one the chain names. */
const exhaustedAccount = 'default';
const takeoverAccount = 'work';

const bootTimeoutMs = 60 * 1000;
const replyTimeoutMs = 20 * 1000;
const agentStartTimeoutMs = 60 * 1000;
const takeoverDaysAhead = 2;
/** The hour (UTC) the limit resets at, in the fake's error text. */
const resetHourUtc = 1;

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let general: TopicDriver;
let firstTopic: TopicDriver;
let secondTopic: TopicDriver;
let defaultTmuxSessionsBefore: string[] = [];
/** When the fake says the limit resets (an ISO instant, a few days ahead so the notice carries the date). */
let resetsAtIso = '';
/** The conversation topic A's session ran on the first account — the one that must follow it everywhere. */
let firstSessionId = '';

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

interface PersistedState {
  claudeProfiles?: Record<string, ClaudeProfileRecord>;
  fallbackChain?: FallbackChainEntry[];
  [field: string]: unknown;
}

function getStatePath(): string {
  return path.join(getLayout().dataDir, 'state.json');
}

function readPersistedState(): PersistedState {
  return JSON.parse(fs.readFileSync(getStatePath(), 'utf8'));
}

interface FakeLaunch {
  argv: string[];
  isSessionLaunch: boolean;
  pid: number;
  /** The `CLAUDE_CONFIG_DIR` the process was started with: the second account's directory; `null` for the first. */
  claudeConfigDir: string | null;
}

function getSessionLaunches(): FakeLaunch[] {
  return readJsonLines<FakeLaunch>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.launches)).filter((launch) => launch.isSessionLaunch);
}

function getAgentTurns(label: string): FakeClaudeTurn[] {
  return readJsonLines<FakeClaudeTurn>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.turns)).filter((turn) => turn.issueKey === label);
}

/** The launch of the process that ran a turn of `label`, with the turn's index (the fake records launches by pid). */
function getLaunchOfTurn(label: string, turnIndex: number): FakeLaunch {
  const turn = getAgentTurns(label)[turnIndex];
  assert.ok(turn, `turn ${turnIndex + 1} of ${label} recorded`);
  const launch = getSessionLaunches().filter((candidate) => candidate.pid === turn.pid).at(-1);
  assert.ok(launch, `a launch recorded for the process ${turn.pid} that ran ${label}`);
  return launch;
}

function getTakeoverConfigDir(): string {
  return path.join(getLayout().dataDir, 'claude-profiles', takeoverAccount);
}

/** Start charness on the instance and wait for its first poll to reach the fake Bot API. */
async function startCharness(): Promise<void> {
  charness = new IsolatedCharness(getLayout());
  const pollsBefore = fakeTelegram.listCalls('getUpdates').length;
  await charness.start(bootTimeoutMs, (runOutput) => runOutput.includes(launchLine) && fakeTelegram.listCalls('getUpdates').length > pollsBefore);
}

/** The bot is stopped, its state edited the way a persisted instance would hold it, and started again. */
async function restartWithState(edit: (state: PersistedState) => void): Promise<void> {
  await getCharness().stop();
  const persisted = readPersistedState();
  edit(persisted);
  fs.writeFileSync(getStatePath(), JSON.stringify(persisted));
  await startCharness();
}

/** Send a labelled prompt whose first turn the fake agent ends on a usage limit that resets at {@link resetsAtIso}. */
function askAgentToHitTheLimit(threadId: number, label: string): void {
  fakeTelegram.pushOperatorMessage(threadId, `${label} [fake:usage-limit-once] [limit-resets:${resetsAtIso}] please carry on`);
}

/** The bot's «switched» notices in a topic (the only messages that start with the switch mark). */
function listSwitchNotices(driver: TopicDriver): FakeTelegramMessage[] {
  return driver.listMessages().filter((message) => message.text.startsWith('🔁'));
}

describe('The usage-limit switch notice end to end: built charness, fake Bot API, fake claude', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-fbswitch-', [firstFolder, secondFolder], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);
    const now = new Date();
    resetsAtIso = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + takeoverDaysAhead, resetHourUtc)).toISOString();

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    general = new TopicDriver(fakeTelegram, getCharness, generalTopicThreadId, replyTimeoutMs);
    firstTopic = new TopicDriver(fakeTelegram, getCharness, firstTopicThreadId, replyTimeoutMs);
    secondTopic = new TopicDriver(fakeTelegram, getCharness, secondTopicThreadId, replyTimeoutMs);
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

  it('boots, sets the instance zone to UTC, turns auto switch on in General, binds both topics and gives them the request view', async () => {
    await startCharness();
    await general.sendAndAwaitReply('/timezone UTC', 'Timezone: UTC');
    await general.sendAndAwaitReply('/limits switch on', 'Auto switch to a fallback model: ON for ALL topics');
    // «Stream + answers»: each message opens a request, whose prompt is what the bot hands the agent again after the switch.
    await firstTopic.sendAndAwaitReply(`/bind ${firstFolder}`, `Bound to \`${firstFolder}\``);
    await firstTopic.sendAndAwaitReply('/verbosity stream_answers', 'This topic shows: Stream + answers');
    await secondTopic.sendAndAwaitReply(`/bind ${secondFolder}`, `Bound to \`${secondFolder}\``);
    await secondTopic.sendAndAwaitReply('/verbosity stream_answers', 'This topic shows: Stream + answers');
  });

  it('seeds a second signed-in account and a one-rung chain onto it while the bot is down', async () => {
    createClaudeProfileLayout({ dataDir: getLayout().dataDir, name: takeoverAccount, homeClaudeDir: path.join(getLayout().instanceHome, '.claude') });
    await restartWithState((persisted) => {
      persisted.claudeProfiles = {
        ...persisted.claudeProfiles,
        [takeoverAccount]: { createdAt: new Date().toISOString(), loggedIn: true, email: 'work@example.com', subscriptionType: 'max' },
      };
      persisted.fallbackChain = [{ backend: 'claude', profile: takeoverAccount, model: null }];
    });
    const screen = await general.sendAndAwaitReply('/limits', 'Fallback models, top first');
    assert.deepEqual(general.getKeyboardLabels(screen)[0], [`1. Claude · ${takeoverAccount} · topic's model`], 'the chain names the seeded account, available (no sign-out or missing mark)');
  });

  it('a limit on the topic\'s account posts ONE short notice — who hit it, where the topic continues, the reset, /accounts — and the conversation goes on', async () => {
    await firstTopic.sendAndAwaitReply('/claude', 'ready in');
    askAgentToHitTheLimit(firstTopicThreadId, 'LIM-1');

    const notice = await firstTopic.waitForMessage('the switch notice', (message) => message.text.startsWith('🔁'));
    const resetClock = `${resetsAtIso.slice(0, 10)} ${resetsAtIso.slice(11, 16)}`;
    assert.equal(
      notice.text,
      `🔁 Account «${exhaustedAccount}» hit its usage limit — this topic continues on «${takeoverAccount}». The limit resets ${resetClock}; switch back: /accounts`,
    );

    await getCharness().waitFor('the conversation to continue under the second account and answer', agentStartTimeoutMs, () => getAgentTurns('LIM-1').length === 2);
    const [firstLaunch, secondLaunch] = [getLaunchOfTurn('LIM-1', 0), getLaunchOfTurn('LIM-1', 1)];
    assert.equal(firstLaunch.claudeConfigDir, null, 'the limit was hit on the first account (no config directory of its own)');
    assert.equal(secondLaunch.claudeConfigDir, getTakeoverConfigDir(), 'the conversation continues under the second account');
    firstSessionId = getLaunchSessionId(firstLaunch.argv) ?? '';
    assert.ok(firstSessionId, 'the first launch carries a conversation id');
    assert.equal(getLaunchSessionId(secondLaunch.argv), firstSessionId, 'the SAME conversation continues (resumed)');

    assert.equal(listSwitchNotices(firstTopic).length, 1, 'one notice, not one per step');
    assert.ok(
      !firstTopic.listMessages().some((message) => /Usage limit reached|will auto-resume/.test(message.text)),
      'the wait notice is not posted into a switch',
    );
    assert.equal(
      readPersistedState().claudeProfiles?.[exhaustedAccount]?.limitedUntil,
      resetsAtIso,
      'the exhausted account is marked limited until the reset the error named',
    );
  });

  it('`/accounts use default` — the command the notice names — moves the topic back, same conversation', async () => {
    await firstTopic.sendAndAwaitReply(`/accounts use ${exhaustedAccount}`, exhaustedAccount);
    await getCharness().waitFor('the session to be re-spawned under the first account', agentStartTimeoutMs, () => {
      const [latest] = getSessionLaunches().slice(-1);
      return latest !== undefined && latest.claudeConfigDir === null && latest.pid !== getLaunchOfTurn('LIM-1', 0).pid && getSessionLaunches().length >= 3;
    });
    const latestLaunch = getSessionLaunches().at(-1);
    assert.ok(latestLaunch);
    assert.equal(getLaunchSessionId(latestLaunch.argv), firstSessionId, 'the topic is back on the first account with the SAME conversation');
    assert.equal(listSwitchNotices(firstTopic).length, 1, 'switching back by hand posts no limit notice');
  });

  it('a rung that pins a model: the notice names it and the session really runs on it', async () => {
    await restartWithState((persisted) => {
      persisted.fallbackChain = [{ backend: 'claude', profile: takeoverAccount, model: 'sonnet' }];
    });
    await secondTopic.sendAndAwaitReply('/claude', 'ready in');
    askAgentToHitTheLimit(secondTopicThreadId, 'LIM-2');

    const notice = await secondTopic.waitForMessage('the switch notice', (message) => message.text.startsWith('🔁'));
    const resetClock = `${resetsAtIso.slice(0, 10)} ${resetsAtIso.slice(11, 16)}`;
    assert.equal(
      notice.text,
      `🔁 Account «${exhaustedAccount}» hit its usage limit — this topic continues on «${takeoverAccount}» (sonnet). The limit resets ${resetClock}; switch back: /accounts`,
    );

    await getCharness().waitFor('the conversation to continue and answer', agentStartTimeoutMs, () => getAgentTurns('LIM-2').length === 2);
    await getCharness().waitFor('the session to run on the pinned model', agentStartTimeoutMs, () => {
      const launch = getLaunchOfTurn('LIM-2', 1);
      return getFlagValues(launch.argv, '--model').includes('sonnet');
    });
    assert.equal(getLaunchOfTurn('LIM-2', 1).claudeConfigDir, getTakeoverConfigDir());
    assert.equal(listSwitchNotices(secondTopic).length, 1);
  });
});
