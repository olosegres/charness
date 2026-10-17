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
 *   → `/accounts` in that topic shows one button on top, «↩️ Back to «default» (limit resets …)» (none in General); a
 *     tap moves the topic back — the session is re-spawned under the first account, same conversation — and the
 *     button is gone, from the screen, from a fresh `/accounts` and from `state.json`; an old keyboard's tap is stale
 *   → a second limit brings the button back, it survives a bot restart, and `/accounts use default` — a manual pick —
 *     moves the topic and forgets it
 *   → the chain's rung pins a model («work» · sonnet): topic B's notice names the model, and the session really
 *     runs on it; a `/model` pick by hand forgets the button
 *   → topic C moves to «work», which hits its limit too while «default» is still limited: nothing can take over, a
 *     wait is armed. «↩️ Back» then resumes the interrupted turn exactly as `/accounts use default` does (the limit
 *     switch: its notice, the "continue" message), and since the switch lands on the remembered account the button
 *     is gone — it does not turn into «Back to «work»»
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
  readClosedRequests,
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
  listReturnButtonData,
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
/** The `/accounts` screen of topic A that carries the «back» button the flow taps. */
let backScreen: FakeTelegramMessage;

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

  it('`/accounts` in the moved topic offers ONE button on top that names the account it was moved from and when its limit resets; General has none', async () => {
    const screen = await firstTopic.sendAndAwaitReply('/accounts', 'Claude account for this topic');
    assert.deepEqual(firstTopic.getKeyboardLabels(screen)[0], [`↩️ Back to «${exhaustedAccount}» (limit resets ${getResetClock(resetsAtIso)})`], 'a row of its own, above the accounts');
    assert.equal(listReturnButtonData(firstTopic, screen).length, 1);
    assert.ok(Buffer.byteLength(listReturnButtonData(firstTopic, screen)[0]) <= 64, 'under Telegram\'s callback-data cap');
    backScreen = screen;

    const generalScreen = await general.sendAndAwaitReply('/accounts', 'Claude account');
    assert.deepEqual(listReturnButtonData(general, generalScreen), [], 'In General nothing changes');
  });

  it('a tap on «Back» moves the topic back through the switch path — same conversation — and the button is gone everywhere; an old keyboard\'s tap is stale', async () => {
    const [backData] = listReturnButtonData(firstTopic, backScreen);
    const launchesBefore = getSessionLaunches(getLayout()).length;
    assert.equal(await firstTopic.tapAndAwaitAnswer(backScreen, backData), `↩️ This topic is back on «${exhaustedAccount}».`);

    await waitForSessionRespawn(getCharness(), getLayout(), 'the session to be re-spawned under the first account', null, firstSessionId, launchesBefore);
    await firstTopic.waitForMessageText('the screen re-rendered without the button', backScreen, () => listReturnButtonData(firstTopic, backScreen).length === 0);
    const freshScreen = await firstTopic.sendAndAwaitReply('/accounts', 'Claude account for this topic');
    assert.deepEqual(listReturnButtonData(firstTopic, freshScreen), [], 'a new screen has no button either');
    await getCharness().waitFor('the remembered rung to leave state.json', replyTimeoutMs, () => readPersistedState(getLayout()).fallbackReturns === undefined);
    assert.equal(listSwitchNotices(firstTopic).length, 1, 'going back is not a limit: no limit notice');

    assert.equal(await firstTopic.tapAndAwaitAnswer(backScreen, backData), 'This button is out of date — there is nothing to switch back.', 'the old keyboard moves nothing');
    assert.equal(getSessionLaunches(getLayout()).length, launchesBefore + 1, 'and re-spawns nothing');
  });

  it('a second limit brings the button back, it survives a bot restart, and a pick by hand (`/accounts use default`) moves the topic and forgets it', async () => {
    // The rung now pins `fake`, which the fake agent's reported model (`fake-model`) already contains: the session
    // runs it, so the notice names no model and the move re-spawns the session once, not twice.
    await restartWithState((persisted) => {
      persisted.fallbackChain = [{ backend: 'claude', profile: takeoverAccount, model: 'fake' }];
    });
    const launchesBeforeLimit = getSessionLaunches(getLayout()).length;
    askAgentToHitTheLimit(firstTopicThreadId, 'LIM-3');
    const secondNotice = await firstTopic.waitForMessage('the second switch notice', (message) => message.text.startsWith('🔁') && message.message_id > backScreen.message_id);
    assert.equal(
      secondNotice.text,
      `🔁 Account «${exhaustedAccount}» hit its usage limit — this topic continues on «${takeoverAccount}». The limit resets ${getResetClock(resetsAtIso)}; switch back: /accounts`,
    );
    await getCharness().waitFor('the conversation to continue under the second account', agentStartTimeoutMs, () => getAgentTurns(getLayout(), 'LIM-3').length === 2);
    assert.equal(getLaunchOfTurn(getLayout(), 'LIM-3', 1).claudeConfigDir, getAccountConfigDir(getLayout(), takeoverAccount));
    assert.deepEqual(getFlagValues(getLaunchOfTurn(getLayout(), 'LIM-3', 1).argv, '--model'), [], 'no model is pinned over the one the session runs');
    assert.equal(getSessionLaunches(getLayout()).length, launchesBeforeLimit + 1, 'one new process for the whole switch');

    await restartWithState(() => {});
    const screen = await firstTopic.sendAndAwaitReply('/accounts', 'Claude account for this topic');
    assert.equal(listReturnButtonData(firstTopic, screen).length, 1, 'the remembered rung survived the restart');

    const launchesBefore = getSessionLaunches(getLayout()).length;
    await firstTopic.sendAndAwaitReply(`/accounts use ${exhaustedAccount}`, exhaustedAccount);
    await waitForSessionRespawn(getCharness(), getLayout(), 'the session to be re-spawned under the first account', null, firstSessionId, launchesBefore);
    const afterPick = await firstTopic.sendAndAwaitReply('/accounts', 'Claude account for this topic');
    assert.deepEqual(listReturnButtonData(firstTopic, afterPick), [], 'a manual account switch forgets the rung');
    await getCharness().waitFor('the remembered rung to leave state.json', replyTimeoutMs, () => readPersistedState(getLayout()).fallbackReturns === undefined);
  });

  it('a rung that pins a model: the notice names it and the session really runs on it', async () => {
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

    await getCharness().waitFor('the conversation to continue and answer', agentStartTimeoutMs, () => getAgentTurns(getLayout(), 'LIM-2').length === 2);
    await getCharness().waitFor('the session to run on the pinned model', agentStartTimeoutMs, () => {
      const launch = getLaunchOfTurn(getLayout(), 'LIM-2', 1);
      return getFlagValues(launch.argv, '--model').includes('sonnet');
    });
    assert.equal(getLaunchOfTurn(getLayout(), 'LIM-2', 1).claudeConfigDir, getAccountConfigDir(getLayout(), takeoverAccount));
    assert.equal(listSwitchNotices(secondTopic).length, 1);
  });

  it('a model picked by hand in the moved topic forgets the button', async () => {
    const screen = await secondTopic.sendAndAwaitReply('/accounts', 'Claude account for this topic');
    assert.equal(listReturnButtonData(secondTopic, screen).length, 1, 'the second topic was moved too');
    await secondTopic.sendAndAwaitReply('/model opus', 'opus');
    const afterPick = await secondTopic.sendAndAwaitReply('/accounts', 'Claude account for this topic');
    assert.deepEqual(listReturnButtonData(secondTopic, afterPick), []);
  });

  it('with a limit wait armed, «Back» resumes the interrupted turn exactly like `/accounts use` does — and a switch that lands home forgets the button', async () => {
    // Both accounts will be limited: the chain names them both, and «default» is still marked limited by the earlier flows.
    await restartWithState((persisted) => {
      persisted.fallbackChain = [{ backend: 'claude', profile: takeoverAccount, model: null }, { backend: 'claude', profile: exhaustedAccount, model: null }];
    });
    await thirdTopic.sendAndAwaitReply('/claude', 'ready in');
    askAgentToHitTheLimit(thirdTopicThreadId, 'LIM-4');
    await getCharness().waitFor('topic C to move to the second account and answer', agentStartTimeoutMs, () => listSwitchNotices(thirdTopic).length === 1 && getAgentTurns(getLayout(), 'LIM-4').length === 2);

    askAgentToHitTheLimit(thirdTopicThreadId, 'LIM-5');
    await getCharness().waitFor('the wait to be armed: no account can take over', agentStartTimeoutMs, () => Object.keys(readPersistedState(getLayout()).apiRetries ?? {}).length === 1 && getAgentTurns(getLayout(), 'LIM-5').length === 1);
    assert.equal(listSwitchNotices(thirdTopic).length, 1, 'no switch was possible');

    const screen = await thirdTopic.sendAndAwaitReply('/accounts', 'Claude account for this topic');
    assert.deepEqual(thirdTopic.getKeyboardLabels(screen)[0], [`↩️ Back to «${exhaustedAccount}» (limit resets ${getResetClock(resetsAtIso)})`]);
    const launchesBefore = getSessionLaunches(getLayout()).length;
    await thirdTopic.tapAndAwaitAnswer(screen, listReturnButtonData(thirdTopic, screen)[0]);

    const resumedNotice = await thirdTopic.waitForMessage('the limit switch\'s notice', (message) => message.text.startsWith('🔁') && message.message_id > screen.message_id);
    assert.equal(
      resumedNotice.text,
      `🔁 Account «${takeoverAccount}» hit its usage limit — this topic continues on «${exhaustedAccount}». The limit resets ${getResetClock(resetsAtIso)}; switch back: /accounts`,
      'the same notice a pick during the wait posts: the account the topic left did hit its limit',
    );
    await getCharness().waitFor('the interrupted turn to resume on the first account', agentStartTimeoutMs, () => getAgentTurns(getLayout(), 'LIM-5').length === 2);
    assert.equal(getLaunchOfTurn(getLayout(), 'LIM-5', 1).claudeConfigDir, null, 'the continue message ran under the first account');
    assert.equal(getSessionLaunches(getLayout()).length, launchesBefore + 1);
    await getCharness().waitFor('the wait to be over', replyTimeoutMs, () => readPersistedState(getLayout()).apiRetries === undefined);

    const afterScreen = await thirdTopic.sendAndAwaitReply('/accounts', 'Claude account for this topic');
    assert.deepEqual(listReturnButtonData(thirdTopic, afterScreen), [], 'the topic is home: no «Back to «work»» pointing at the fallback');
    await getCharness().waitFor('the remembered rung to leave state.json', replyTimeoutMs, () => readPersistedState(getLayout()).fallbackReturns === undefined);
  });

  it('«Back» restores the model the topic had, silently: a move that changed it (the rung pinned another) puts it back, and the notice names no model', async () => {
    await restartWithState((persisted) => {
      persisted.fallbackChain = [{ backend: 'claude', profile: takeoverAccount, model: 'sonnet' }];
      // «work» hit its own limit in the flow above; it is available again.
      delete persisted.claudeProfiles?.[takeoverAccount]?.limitedUntil;
    });
    askAgentToHitTheLimit(thirdTopicThreadId, 'LIM-6');
    await getCharness().waitFor('topic C to move to the second account on the pinned model and run the continued turn', agentStartTimeoutMs, () => listSwitchNotices(thirdTopic).length === 3 && getAgentTurns(getLayout(), 'LIM-6').length === 2);
    // The continued turn has ENDED (its request is closed by the final answer): the session is idle, so «Back» moves it at once.
    const continuedRequestId = getAgentTurns(getLayout(), 'LIM-6')[1].requestId;
    await getCharness().waitFor('the continued turn\'s request to close', agentStartTimeoutMs, () => readClosedRequests(getLayout()).some((record) => record.id === continuedRequestId));
    assert.deepEqual(getFlagValues(getLaunchOfTurn(getLayout(), 'LIM-6', 1).argv, '--model'), ['sonnet'], 'precondition: the session runs the rung\'s model');
    const sessionId = getLaunchSessionId(getLaunchOfTurn(getLayout(), 'LIM-6', 1).argv) ?? '';

    const screen = await thirdTopic.sendAndAwaitReply('/accounts', 'Claude account for this topic');
    const launchesBefore = getSessionLaunches(getLayout()).length;
    assert.equal(await thirdTopic.tapAndAwaitAnswer(screen, listReturnButtonData(thirdTopic, screen)[0]), `↩️ This topic is back on «${exhaustedAccount}».`);

    // The re-spawn under the first account keeps `sonnet`; the restore then re-spawns once more on the model it had.
    await getCharness().waitFor('the session to run on the first account and on the model the topic had', agentStartTimeoutMs, () => {
      const latest = getSessionLaunches(getLayout()).at(-1);
      return getSessionLaunches(getLayout()).length === launchesBefore + 2 && latest?.claudeConfigDir === null && getLaunchSessionId(latest.argv) === sessionId
        && getFlagValues(latest.argv, '--model').includes('fake-model');
    });
  });
});
