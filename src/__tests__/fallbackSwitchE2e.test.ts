/**
 * @description The notice a usage-limit auto-switch posts, at PROCESS level: the BUILT charness started the way an
 * isolated instance is (`scripts/run-isolated.sh`) against the fake Bot API of `telegramE2e/fakeTelegram.ts`, with
 * the fake `claude` (`jiraE2e/fakeClaude.ts`) refusing a turn for a subscription limit (`usage-limit-once`) and
 * recording how every session is launched (the config directory = the account). The test plays the operator in
 * the General topic and in three bound topics. One flow, in order:
 *
 *   boot → the instance zone is set to UTC, auto switch is turned on in General, three topics are bound (each
 *     message opens a request, as in the operator's own topics)
 *   → a second account («work») and a one-rung chain are seeded while the bot is down (a sign-in cannot be driven
 *     without the real CLI), the bot starts again
 *   → topic A's agent hits its limit: ONE short notice names the account that hit it, the account the topic
 *     continues on, when the limit resets (in the instance zone) and `/accounts` — and no wait notice; the same
 *     conversation continues under the second account and answers
 *   → `/accounts use default` — the command the notice names — moves the topic back: the session is re-spawned
 *     under the first account, same conversation
 *   → a second limit with a rung whose model the session already runs: the notice names no model and the move
 *     re-spawns the session once
 *   → the chain's rung pins another model («work» · sonnet): topic B's notice names the model, and the session really
 *     runs on it
 *   → topic C moves to «work», which hits its limit too while «default» is still limited: nothing can take over, a
 *     wait is armed. `/accounts use default` then resumes the interrupted turn: the limit switch, its notice and the
 *     "continue" message
 *
 * What the unit tests cover instead: an unknown reset, the deferred notice (a tmux Claude without a resumable
 * session) and every locale (`fallbackSwitchNotice.test.ts`); the switches to and from OpenCode are the other flow,
 * `fallbackSwitchOpenCodeE2e.test.ts`.
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
import { getFlagValues, getLaunchSessionId } from './jiraE2e/fakeClaudeContract';
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
  getAgentTurns,
  getLaunchOfTurn,
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

const group = { id: -1001111111111, title: 'ExampleGroup' };
const firstTopicThreadId = 111;
const secondTopicThreadId = 112;
const thirdTopicThreadId = 113;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const firstFolder = 'switch-first';
const secondFolder = 'switch-second';
const thirdFolder = 'switch-third';
/** The account the second one takes over from, and the one the chain names. */
const exhaustedAccount = 'default';
const takeoverAccount = 'work';

const replyTimeoutMs = 20 * 1000;
const agentStartTimeoutMs = 60 * 1000;
const takeoverDaysAhead = 2;

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let general: TopicDriver;
let firstTopic: TopicDriver;
let secondTopic: TopicDriver;
let thirdTopic: TopicDriver;
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

/** Start charness on the instance and wait for its first poll to reach the fake Bot API. */
async function startCharness(): Promise<void> {
  charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
}

/** The bot is stopped, its state edited the way a persisted instance would hold it, and started again. */
async function restartWithState(edit: (state: PersistedState) => void): Promise<void> {
  charness = await restartCharnessWithState(getLayout(), fakeTelegram, getCharness(), edit);
}

/** Send a labelled prompt whose first turn the fake agent ends on a usage limit that resets at {@link resetsAtIso}. */
function askAgentToHitTheLimit(threadId: number, label: string): void {
  fakeTelegram.pushOperatorMessage(threadId, `${label} [fake:usage-limit-once] [limit-resets:${resetsAtIso}] please carry on`);
}

describe('The usage-limit switch notice end to end: built charness, fake Bot API, fake claude', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-fbswitch-', [firstFolder, secondFolder, thirdFolder], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);
    resetsAtIso = computeResetsAtIso(takeoverDaysAhead);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    general = new TopicDriver(fakeTelegram, getCharness, generalTopicThreadId, replyTimeoutMs);
    firstTopic = new TopicDriver(fakeTelegram, getCharness, firstTopicThreadId, replyTimeoutMs);
    secondTopic = new TopicDriver(fakeTelegram, getCharness, secondTopicThreadId, replyTimeoutMs);
    thirdTopic = new TopicDriver(fakeTelegram, getCharness, thirdTopicThreadId, replyTimeoutMs);
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

  it('boots, sets the instance zone to UTC, turns auto switch on in General, binds the three topics and gives them the request view', async () => {
    await startCharness();
    await general.sendAndAwaitReply('/timezone UTC', 'Timezone: UTC');
    await general.sendAndAwaitReply('/limits switch on', 'Auto switch to a fallback model: ON for ALL topics');
    // «Stream + answers»: each message opens a request, whose prompt is what the bot hands the agent again after the switch.
    await firstTopic.sendAndAwaitReply(`/bind ${firstFolder}`, `Bound to \`${firstFolder}\``);
    await firstTopic.sendAndAwaitReply('/verbosity stream_answers', 'This topic shows: Stream + answers');
    await secondTopic.sendAndAwaitReply(`/bind ${secondFolder}`, `Bound to \`${secondFolder}\``);
    await secondTopic.sendAndAwaitReply('/verbosity stream_answers', 'This topic shows: Stream + answers');
    await thirdTopic.sendAndAwaitReply(`/bind ${thirdFolder}`, `Bound to \`${thirdFolder}\``);
    await thirdTopic.sendAndAwaitReply('/verbosity stream_answers', 'This topic shows: Stream + answers');
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
    assert.equal(
      notice.text,
      `🔁 Account «${exhaustedAccount}» hit its usage limit — this topic continues on «${takeoverAccount}». The limit resets ${getResetClock(resetsAtIso)}; switch back: /accounts`,
    );

    await getCharness().waitFor('the conversation to continue under the second account and answer', agentStartTimeoutMs, () => getAgentTurns(getLayout(), 'LIM-1').length === 2);
    const [firstLaunch, secondLaunch] = [getLaunchOfTurn(getLayout(), 'LIM-1', 0), getLaunchOfTurn(getLayout(), 'LIM-1', 1)];
    assert.equal(firstLaunch.claudeConfigDir, null, 'the limit was hit on the first account (no config directory of its own)');
    assert.equal(secondLaunch.claudeConfigDir, getAccountConfigDir(getLayout(), takeoverAccount), 'the conversation continues under the second account');
    firstSessionId = getLaunchSessionId(firstLaunch.argv) ?? '';
    assert.ok(firstSessionId, 'the first launch carries a conversation id');
    assert.equal(getLaunchSessionId(secondLaunch.argv), firstSessionId, 'the SAME conversation continues (resumed)');

    assert.equal(listSwitchNotices(firstTopic).length, 1, 'one notice, not one per step');
    assert.ok(
      !firstTopic.listMessages().some((message) => /Usage limit reached|will auto-resume/.test(message.text)),
      'the wait notice is not posted into a switch',
    );
    assert.equal(
      readPersistedState(getLayout()).claudeProfiles?.[exhaustedAccount]?.limitedUntil,
      resetsAtIso,
      'the exhausted account is marked limited until the reset the error named',
    );
  });

  it('`/accounts use default` — the command the notice names — moves the topic back, same conversation', async () => {
    const launchesBefore = getSessionLaunches(getLayout()).length;
    await firstTopic.sendAndAwaitReply(`/accounts use ${exhaustedAccount}`, exhaustedAccount);
    await waitForSessionRespawn(getCharness(), getLayout(), 'the session to be re-spawned under the first account', null, firstSessionId, launchesBefore);
    assert.equal(listSwitchNotices(firstTopic).length, 1, 'switching back by hand posts no limit notice');
  });

  it('a rung that pins a model the session already runs: the notice names no model and the move re-spawns the session once', async () => {
    // The rung pins `fake`, which the fake agent's reported model (`fake-model`) already contains. The new process
    // reports its model only with its first frame, so reading it AFTER the re-spawn would find nothing running.
    await restartWithState((persisted) => {
      persisted.fallbackChain = [{ backend: 'claude', profile: takeoverAccount, model: 'fake' }];
    });
    const launchesBeforeLimit = getSessionLaunches(getLayout()).length;
    askAgentToHitTheLimit(firstTopicThreadId, 'LIM-3');
    await getCharness().waitFor('the second switch notice', agentStartTimeoutMs, () => listSwitchNotices(firstTopic).length === 2);
    assert.equal(
      listSwitchNotices(firstTopic)[1].text,
      `🔁 Account «${exhaustedAccount}» hit its usage limit — this topic continues on «${takeoverAccount}». The limit resets ${getResetClock(resetsAtIso)}; switch back: /accounts`,
    );
    await getCharness().waitFor('the conversation to continue under the second account', agentStartTimeoutMs, () => getAgentTurns(getLayout(), 'LIM-3').length === 2);
    assert.equal(getLaunchOfTurn(getLayout(), 'LIM-3', 1).claudeConfigDir, getAccountConfigDir(getLayout(), takeoverAccount));
    assert.deepEqual(getFlagValues(getLaunchOfTurn(getLayout(), 'LIM-3', 1).argv, '--model'), [], 'no model is pinned over the one the session runs');
    assert.equal(getSessionLaunches(getLayout()).length, launchesBeforeLimit + 1, 'one new process for the whole switch');
  });

  it('a rung that pins another model: the notice names it and the session really runs on it', async () => {
    await restartWithState((persisted) => {
      persisted.fallbackChain = [{ backend: 'claude', profile: takeoverAccount, model: 'sonnet' }];
    });
    await secondTopic.sendAndAwaitReply('/claude', 'ready in');
    askAgentToHitTheLimit(secondTopicThreadId, 'LIM-2');

    const notice = await secondTopic.waitForMessage('the switch notice', (message) => message.text.startsWith('🔁'));
    assert.equal(
      notice.text,
      `🔁 Account «${exhaustedAccount}» hit its usage limit — this topic continues on «${takeoverAccount}» (sonnet). The limit resets ${getResetClock(resetsAtIso)}; switch back: /accounts`,
    );

    // The wake-up engine may remind the silent turn in the process the account switch started, before the model pin
    // re-spawns it; the continued turn is the one that runs under the pinned model.
    await getCharness().waitFor('a turn of the request to run under the second account on the pinned model', agentStartTimeoutMs, () =>
      getAgentTurns(getLayout(), 'LIM-2').some((turn) => {
        const launch = getSessionLaunches(getLayout()).find((candidate) => candidate.pid === turn.pid);
        return launch !== undefined && launch.claudeConfigDir === getAccountConfigDir(getLayout(), takeoverAccount) && getFlagValues(launch.argv, '--model').includes('sonnet');
      }));
    assert.equal(listSwitchNotices(secondTopic).length, 1);
  });

  it('with a limit wait armed — both accounts limited — `/accounts use default`, the command the notice names, resumes the interrupted turn', async () => {
    // Both accounts will be limited: the chain names them both, and «default» is still marked limited by the earlier flows.
    await restartWithState((persisted) => {
      persisted.fallbackChain = [{ backend: 'claude', profile: takeoverAccount, model: null }, { backend: 'claude', profile: exhaustedAccount, model: null }];
      // «work» is available again for the move below.
      delete persisted.claudeProfiles?.[takeoverAccount]?.limitedUntil;
    });
    await thirdTopic.sendAndAwaitReply('/claude', 'ready in');
    askAgentToHitTheLimit(thirdTopicThreadId, 'LIM-4');
    await getCharness().waitFor('topic C to move to the second account and answer', agentStartTimeoutMs, () => listSwitchNotices(thirdTopic).length === 1 && getAgentTurns(getLayout(), 'LIM-4').length === 2);

    askAgentToHitTheLimit(thirdTopicThreadId, 'LIM-5');
    await getCharness().waitFor('the wait to be armed: no account can take over', agentStartTimeoutMs, () => Object.keys(readPersistedState(getLayout()).apiRetries ?? {}).length === 1 && getAgentTurns(getLayout(), 'LIM-5').length === 1);
    assert.equal(listSwitchNotices(thirdTopic).length, 1, 'no switch was possible');

    const launchesBefore = getSessionLaunches(getLayout()).length;
    await thirdTopic.sendAndAwaitReply(`/accounts use ${exhaustedAccount}`, exhaustedAccount);
    await getCharness().waitFor('the limit switch\'s notice', agentStartTimeoutMs, () => listSwitchNotices(thirdTopic).length === 2);
    assert.equal(
      listSwitchNotices(thirdTopic)[1].text,
      `🔁 Account «${takeoverAccount}» hit its usage limit — this topic continues on «${exhaustedAccount}». The limit resets ${getResetClock(resetsAtIso)}; switch back: /accounts`,
      'a pick during the wait is the limit switch: the account the topic left did hit its limit',
    );
    await getCharness().waitFor('the interrupted turn to resume on the first account', agentStartTimeoutMs, () => getAgentTurns(getLayout(), 'LIM-5').length === 2);
    assert.equal(getLaunchOfTurn(getLayout(), 'LIM-5', 1).claudeConfigDir, null, 'the continue message ran under the first account');
    assert.equal(getSessionLaunches(getLayout()).length, launchesBefore + 1);
    await getCharness().waitFor('the wait to be over', replyTimeoutMs, () => readPersistedState(getLayout()).apiRetries === undefined);
  });
});
