/**
 * @description The notice a usage-limit auto-switch posts, at PROCESS level: the BUILT charness started the way an
 * isolated instance is (`scripts/run-isolated.sh`) against the fake Bot API of `telegramE2e/fakeTelegram.ts`, with
 * the fake `claude` (`jiraE2e/fakeClaude.ts`) refusing a turn for a subscription limit (`usage-limit-once`) and
 * recording how every session is launched (the config directory = the account). The test plays the operator in
 * the General topic and in four bound topics. One flow, in order:
 *
 *   boot → the instance zone is set to UTC, auto switch is turned on in General by the button of `/limits_autoswitch`,
 *     four topics are bound (each message opens a request, as in the operator's own topics)
 *   → a second account («work») and a one-rung chain are seeded while the bot is down (a sign-in cannot be driven
 *     without the real CLI), the bot starts again
 *   → topic A's agent hits its limit: ONE short notice names the account that hit it, the account the topic
 *     continues on, when the limit resets (in the instance zone) and `/limits` — and no wait notice; the same
 *     conversation continues under the second account and answers
 *   → `/limits` — the command the notice names — lists both accounts (the one the topic runs on carries the ✓, the
 *     exhausted one its ⛔ reset in the message's usage block, never on its button); a tap on the first account moves the topic back: the session is re-spawned under
 *     it, same conversation
 *   → a second limit with a rung whose model the session already runs: the notice names no model and the move
 *     re-spawns the session once
 *   → the chain's rung pins another model («work» · sonnet): topic B's notice names the model, and the session really
 *     runs on it
 *   → with an EMPTY fallback list topic D's notice still names `/limits`, and the board lists both accounts
 *   → the ✓ row of that board opens the model page of the account the topic runs on; a pick restarts the session on
 *     that model and leaves the topic following General's account
 *   → with a wait armed by a Fable-only limit (the usage snapshot says so) a pick of a model the limit does not cover (opus)
 *     continues the work at once, while a pick still inside the limit (fable) only changes the model and keeps the wait
 *   → with a wait armed by an exhausted SHARED weekly window Fable is stopped too (it drains that window as well): a Fable pick
 *     only changes the model and the wait stays
 *   → topic C moves to «work», which hits its limit too while «default» is still limited: nothing can take over, a
 *     wait is armed. A tap on the first account on the `/limits` board then resumes the interrupted turn: the limit switch, its notice and the
 *     "continue" message
 *
 * What the unit tests cover instead: the board's rows, its model pages and its General face (`limitsBoard.test.ts`), an unknown reset, the deferred notice (a tmux Claude without a resumable
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
  removeIsolatedInstanceSync,
  writeFakeClaudeLauncher,
  writeInstanceEnvFile,
  type IsolatedInstanceLayout,
} from './e2e/isolatedCharness';
import {
  computeResetsAtIso,
  getAccountConfigDir,
  checkHasTurnOnLaunch,
  getAgentTurns,
  getLaunchOfTurn,
  getResetClock,
  getSessionLaunches,
  listSwitchNotices,
  openLimitsBoard,
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
const fourthTopicThreadId = 114;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const firstFolder = 'switch-first';
const secondFolder = 'switch-second';
const thirdFolder = 'switch-third';
const fourthFolder = 'switch-fourth';
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
let fourthTopic: TopicDriver;
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

/** The `/limits` board of a topic, with the callback data and labels of its rows by account. */
async function openBoard(driver: TopicDriver, threadId: number): Promise<{ message: FakeTelegramMessage; rowData: (account: string) => string; rowLabel: (account: string) => string }> {
  const board = await openLimitsBoard(fakeTelegram, driver, threadId);
  return { message: board.message, rowData: (account) => board.rowData(`Claude · ${account}`), rowLabel: (account) => board.rowLabel(`Claude · ${account}`) };
}

describe('The usage-limit switch notice end to end: built charness, fake Bot API, fake claude', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-fbswitch-', [firstFolder, secondFolder, thirdFolder, fourthFolder], getFlowDeadlineMs());
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
    fourthTopic = new TopicDriver(fakeTelegram, getCharness, fourthTopicThreadId, replyTimeoutMs);
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

  it('boots, sets the instance zone to UTC, turns auto switch on in General with the button of /limits_autoswitch, binds the four topics and gives them the request view', async () => {
    await startCharness();
    await general.sendAndAwaitReply('/timezone UTC', 'Timezone: UTC');
    const setup = await general.sendAndAwaitReply('/limits_autoswitch', 'Defaults for all topics.');
    assert.deepEqual(general.getKeyboardLabels(setup).slice(-2), [['🔁 Auto switch: OFF'], ['⏳ Wait for reset: ON']]);
    const answer = await general.tapAndAwaitAnswer(setup, 'fbk_asw_on');
    assert.match(answer, /Auto switch to a fallback model: ON for ALL topics/);
    await getCharness().waitFor('the button to show the new value', replyTimeoutMs, () => general.getKeyboardLabels(setup).at(-2)?.[0] === '🔁 Auto switch: ON');
    // «Stream + answers»: each message opens a request, whose prompt is what the bot hands the agent again after the switch.
    await firstTopic.sendAndAwaitReply(`/bind ${firstFolder}`, `Bound to \`${firstFolder}\``);
    await firstTopic.sendAndAwaitReply('/verbosity stream_answers', 'This topic shows: Stream + answers');
    await secondTopic.sendAndAwaitReply(`/bind ${secondFolder}`, `Bound to \`${secondFolder}\``);
    await secondTopic.sendAndAwaitReply('/verbosity stream_answers', 'This topic shows: Stream + answers');
    await thirdTopic.sendAndAwaitReply(`/bind ${thirdFolder}`, `Bound to \`${thirdFolder}\``);
    await thirdTopic.sendAndAwaitReply('/verbosity stream_answers', 'This topic shows: Stream + answers');
    await fourthTopic.sendAndAwaitReply(`/bind ${fourthFolder}`, `Bound to \`${fourthFolder}\``);
    await fourthTopic.sendAndAwaitReply('/verbosity stream_answers', 'This topic shows: Stream + answers');
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
    const screen = await general.sendAndAwaitReply('/limits_autoswitch', 'Fallback models, top first');
    assert.deepEqual(general.getKeyboardLabels(screen)[0], [`1. Claude · ${takeoverAccount}`], 'the chain names the seeded account, available (no sign-out or missing mark)');
  });

  it('a limit on the topic\'s account posts ONE short notice — who hit it, where the topic continues, the reset, /accounts — and the conversation goes on', async () => {
    await firstTopic.sendAndAwaitReply('/claude', 'ready in');
    askAgentToHitTheLimit(firstTopicThreadId, 'LIM-1');

    const notice = await firstTopic.waitForMessage('the switch notice', (message) => message.text.startsWith('🔁'));
    assert.equal(
      notice.text,
      `🔁 Account «${exhaustedAccount}» hit its usage limit — this topic continues on «${takeoverAccount}». The limit resets ${getResetClock(resetsAtIso)}. Switch: /limits`,
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

  it('`/limits` — the command the notice names — lists both accounts and a tap on the first one moves the topic back, same conversation', async () => {
    const board = await openBoard(firstTopic, firstTopicThreadId);
    // The model after the account is the one the live process reports on its init frame, which may or may not have been read yet.
    assert.equal(board.rowLabel(takeoverAccount), `✓ Claude · ${takeoverAccount}`, 'the topic runs on the account it continued on; the button is the name only, no model');
    assert.equal(board.rowLabel(exhaustedAccount), 'Claude · default', 'no reset on the exhausted account\'s button');
    assert.match(
      board.message.text,
      /^Usage \(% used\)\ndefault — ⛔ at its limit until [A-Z][a-z]{2} 01:00\n\n🔁 Auto switch: ON \(as in General\) · ⏳ Wait for reset: ON \(as in General\) — \/limits_autoswitch\n\nChoose the active model:$/,
      'the exhausted account\'s reset is in the message\'s usage block',
    );
    const launchesBefore = getSessionLaunches(getLayout()).length;
    const toast = await firstTopic.tapAndAwaitAnswer(board.message, board.rowData(exhaustedAccount));
    assert.match(toast, new RegExp(`Claude account for this topic: ${exhaustedAccount}`));
    await waitForSessionRespawn(getCharness(), getLayout(), 'the session to be re-spawned under the first account', null, firstSessionId, launchesBefore);
    assert.equal(listSwitchNotices(firstTopic).length, 1, 'switching back by hand posts no limit notice');
    // The agent was still answering when the pick came in: the switch applies when its turn ends, and the board
    // shows where the topic REALLY runs — so the ✓ is checked on a board opened after the session restarted.
    const after = await openBoard(firstTopic, firstTopicThreadId);
    assert.match(after.rowLabel(exhaustedAccount), /^✓ Claude · default/, 'the topic runs on the first account again');
    assert.equal(after.rowLabel(takeoverAccount), `Claude · ${takeoverAccount}`);
    assert.equal(readPersistedState(getLayout()).claudeProfileOverrides?.[`${group.id}:${firstTopicThreadId}`], exhaustedAccount, 'the pick is the topic\'s own');
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
      `🔁 Account «${exhaustedAccount}» hit its usage limit — this topic continues on «${takeoverAccount}». The limit resets ${getResetClock(resetsAtIso)}. Switch: /limits`,
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
      `🔁 Account «${exhaustedAccount}» hit its usage limit — this topic continues on «${takeoverAccount}» (sonnet). The limit resets ${getResetClock(resetsAtIso)}. Switch: /limits`,
    );

    // The wake-up engine may remind the silent turn in the process the account switch started, before the model pin
    // re-spawns it; the process the pin starts then gets the «continue» nudge, which carries no request and so no label.
    // Either way the conversation's next turn runs under the second account on the pinned model.
    const sessionId = getLaunchSessionId(getLaunchOfTurn(getLayout(), 'LIM-2', 0).argv) ?? '';
    assert.ok(sessionId, 'the first launch carries a conversation id');
    await getCharness().waitFor('a turn of the conversation to run under the second account on the pinned model', agentStartTimeoutMs, () =>
      checkHasTurnOnLaunch(getLayout(), { sessionId, configDir: getAccountConfigDir(getLayout(), takeoverAccount), model: 'sonnet' }));
    assert.equal(listSwitchNotices(secondTopic).length, 1);
  });

  it('with an EMPTY fallback list nothing is known to take over: the wait notice names /limits and /limits_autoswitch, the board lists both accounts, and its «skip once» ends the wait', async () => {
    await restartWithState((persisted) => {
      persisted.fallbackChain = [];
      delete persisted.claudeProfiles?.[takeoverAccount]?.limitedUntil;
    });
    await fourthTopic.sendAndAwaitReply('/claude', 'ready in');
    askAgentToHitTheLimit(fourthTopicThreadId, 'LIM-6');
    const notice = await fourthTopic.waitForMessage('the wait notice', (message) => message.text.includes('Skip this resume'));
    assert.match(notice.text, /Skip this resume: \/limits · turn waiting off: \/limits_autoswitch$/);
    assert.deepEqual(readPersistedState(getLayout()).fallbackChain ?? [], [], 'the list stayed empty');
    assert.equal(listSwitchNotices(fourthTopic).length, 0, 'no account with known room: no switch');

    const board = await openBoard(fourthTopic, fourthTopicThreadId);
    const rows = fourthTopic.getKeyboardLabels(board.message).flat();
    assert.equal(rows.length, 3, 'both signed-in accounts, then «skip once» (a limit wait is armed)');
    assert.equal(board.rowLabel(exhaustedAccount), '✓ Claude · default');
    assert.match(board.message.text, /^Usage \(% used\)\ndefault — ⛔ at its limit until [A-Z][a-z]{2} 01:00\n\n/, 'the limit is in the message, not on the button');
    assert.equal(board.rowLabel(takeoverAccount), `Claude · ${takeoverAccount}`);
    assert.equal(rows.at(-1), '⏭ Skip once');
    const skipData = fourthTopic.getKeyboardData(board.message).flat().at(-1) ?? '';
    await fourthTopic.tapAndAwaitAnswer(board.message, skipData);
    await getCharness().waitFor('the wait to be skipped', replyTimeoutMs, () => readPersistedState(getLayout()).apiRetries === undefined);
  });

  it('the ✓ row opens the model page of the account the topic runs on: a pick restarts the session on that model and does not turn "follows General" into an account pick of its own', async () => {
    const launchesBefore = getSessionLaunches(getLayout()).length;
    const board = await openBoard(fourthTopic, fourthTopicThreadId);
    await fourthTopic.tapAndAwaitAnswer(board.message, board.rowData(exhaustedAccount));
    await fourthTopic.waitForMessageText('the model page', board.message, (text) => text === `Claude · ${exhaustedAccount} — pick the model for this topic:`);
    const labels = fourthTopic.getKeyboardLabels(board.message).flat();
    assert.deepEqual(labels.map((label) => label.replace(' ✓', '')), ['fable', 'opus', 'sonnet', 'haiku', '⬅️ Back']);
    const sonnetData = fourthTopic.getKeyboardData(board.message).flat()[labels.findIndex((label) => label.startsWith('sonnet'))];
    await fourthTopic.tapAndAwaitAnswer(board.message, sonnetData);
    await getCharness().waitFor('the session to restart on sonnet', agentStartTimeoutMs, () => {
      const latest = getSessionLaunches(getLayout()).at(-1);
      return getSessionLaunches(getLayout()).length > launchesBefore && latest !== undefined && getFlagValues(latest.argv, '--model').includes('sonnet');
    });
    assert.equal(readPersistedState(getLayout()).claudeProfileOverrides?.[`${group.id}:${fourthTopicThreadId}`], undefined, 'the topic still follows General\'s account');
    await getCharness().waitFor('the board to come back', replyTimeoutMs, () => board.message.text.endsWith('Choose the active model:') && fourthTopic.getKeyboardLabels(board.message).flat().includes(`✓ Claude · ${exhaustedAccount}`));
    // The model is no longer on the button: the page the ✓ row opens marks the one the session runs.
    await fourthTopic.tapAndAwaitAnswer(board.message, board.rowData(exhaustedAccount));
    await fourthTopic.waitForMessageText('the model page again', board.message, (text) => text === `Claude · ${exhaustedAccount} — pick the model for this topic:`);
    await getCharness().waitFor('sonnet to carry the ✓ on the page', replyTimeoutMs, () => fourthTopic.getKeyboardLabels(board.message).flat().includes('sonnet ✓'));
    await fourthTopic.tapAndAwaitAnswer(board.message, fourthTopic.getKeyboardData(board.message).flat().at(-1) ?? '');
  });

  it('with a wait armed by a Fable-only limit: a model the limit does not cover (opus) continues the work, a pick still inside the limit (fable) only changes the model and keeps the wait', async () => {
    // The usage snapshot of «default» says ONLY Fable's weekly window is exhausted; the topic hit the limit on it.
    await restartWithState((persisted) => {
      persisted.fallbackChain = [];
      const existing = persisted.claudeProfiles?.[exhaustedAccount];
      persisted.claudeProfiles = {
        ...persisted.claudeProfiles,
        [exhaustedAccount]: {
          createdAt: existing?.createdAt ?? new Date().toISOString(),
          ...existing,
          usage: {
            fetchedAt: new Date().toISOString(),
            source: 'api',
            buckets: [
              { kind: 'session', percent: 10, resetsAt: resetsAtIso, scopeModel: null },
              { kind: 'weekly_all', percent: 20, resetsAt: resetsAtIso, scopeModel: null },
              { kind: 'weekly_scoped', percent: 100, resetsAt: resetsAtIso, scopeModel: 'Fable' },
            ],
          },
        },
      };
    });
    const noticesBefore = listSwitchNotices(fourthTopic).length;
    askAgentToHitTheLimit(fourthTopicThreadId, 'LIM-7');
    await getCharness().waitFor('the wait to be armed: no other account can take over', agentStartTimeoutMs, () => Object.keys(readPersistedState(getLayout()).apiRetries ?? {}).length === 1 && getAgentTurns(getLayout(), 'LIM-7').length === 1);

    // Inside the limit: Fable. The model changes, the wait stays, nothing is resumed.
    let board = await openBoard(fourthTopic, fourthTopicThreadId);
    await fourthTopic.tapAndAwaitAnswer(board.message, board.rowData(exhaustedAccount));
    await fourthTopic.waitForMessageText('the model page', board.message, (text) => text === `Claude · ${exhaustedAccount} — pick the model for this topic:`);
    const launchesBeforeFable = getSessionLaunches(getLayout()).length;
    const fableToast = await fourthTopic.tapAndAwaitAnswer(board.message, fourthTopic.getKeyboardData(board.message).flat()[0]);
    assert.equal(fableToast, `✅ This topic runs on Claude «${exhaustedAccount}» (fable).`);
    await getCharness().waitFor('the session to restart on fable', agentStartTimeoutMs, () => {
      const latest = getSessionLaunches(getLayout()).at(-1);
      return getSessionLaunches(getLayout()).length > launchesBeforeFable && latest !== undefined && getFlagValues(latest.argv, '--model').includes('fable');
    });
    assert.equal(Object.keys(readPersistedState(getLayout()).apiRetries ?? {}).length, 1, 'the wait stays armed');
    assert.equal(getAgentTurns(getLayout(), 'LIM-7').length, 1, 'the interrupted turn was not resumed');
    assert.equal(listSwitchNotices(fourthTopic).length, noticesBefore, 'no limit notice');

    // Beyond the limit: opus. The work continues on it at once.
    board = await openBoard(fourthTopic, fourthTopicThreadId);
    await fourthTopic.tapAndAwaitAnswer(board.message, board.rowData(exhaustedAccount));
    await fourthTopic.waitForMessageText('the model page', board.message, (text) => text === `Claude · ${exhaustedAccount} — pick the model for this topic:`);
    const labels = fourthTopic.getKeyboardLabels(board.message).flat();
    const opusToast = await fourthTopic.tapAndAwaitAnswer(board.message, fourthTopic.getKeyboardData(board.message).flat()[labels.findIndex((label) => label.startsWith('opus'))]);
    assert.equal(opusToast, `✅ This topic runs on Claude «${exhaustedAccount}» (opus).`);
    await getCharness().waitFor('the limit move\'s notice', agentStartTimeoutMs, () => listSwitchNotices(fourthTopic).length === noticesBefore + 1);
    assert.match(
      listSwitchNotices(fourthTopic).at(-1)?.text ?? '',
      new RegExp(`^🔁 Model \\S+ hit its usage limit — this topic continues on «${exhaustedAccount}» \\(opus\\)\\. The limit resets ${getResetClock(resetsAtIso)}\\. Switch: /limits$`),
      'the model hit the limit, the account did not change',
    );
    await getCharness().waitFor('the interrupted turn to resume on opus', agentStartTimeoutMs, () => getAgentTurns(getLayout(), 'LIM-7').length === 2);
    const resumed = getLaunchOfTurn(getLayout(), 'LIM-7', 1);
    assert.equal(resumed.claudeConfigDir, null, 'still the first account');
    assert.ok(getFlagValues(resumed.argv, '--model').includes('opus'), 'on the model that was picked');
    await getCharness().waitFor('the wait to be over', replyTimeoutMs, () => readPersistedState(getLayout()).apiRetries === undefined);
    assert.equal(readPersistedState(getLayout()).claudeProfileOverrides?.[`${group.id}:${fourthTopicThreadId}`], undefined, 'the topic still follows General\'s account');
    // The resumed turn must have ANSWERED before the next step restarts the bot: a restart in the middle of a turn is another scenario.
    await getCharness().waitFor('the resumed turn to answer', agentStartTimeoutMs, () => fourthTopic.listMessages().filter((message) => message.text.includes('Working on LIM-7')).length >= 2);
  });

  it('with a wait armed by an exhausted SHARED weekly window, Fable is stopped too (it drains that window as well): the pick only changes the model and the wait stays', async () => {
    await restartWithState((persisted) => {
      const existing = persisted.claudeProfiles?.[exhaustedAccount];
      persisted.claudeProfiles = {
        ...persisted.claudeProfiles,
        [exhaustedAccount]: {
          createdAt: existing?.createdAt ?? new Date().toISOString(),
          ...existing,
          usage: {
            fetchedAt: new Date().toISOString(),
            source: 'api',
            buckets: [
              { kind: 'session', percent: 10, resetsAt: resetsAtIso, scopeModel: null },
              { kind: 'weekly_all', percent: 100, resetsAt: resetsAtIso, scopeModel: null },
              { kind: 'weekly_scoped', percent: 5, resetsAt: resetsAtIso, scopeModel: 'Fable' },
            ],
          },
        },
      };
    });
    askAgentToHitTheLimit(fourthTopicThreadId, 'LIM-8');
    await getCharness().waitFor('the wait to be armed', agentStartTimeoutMs, () => Object.keys(readPersistedState(getLayout()).apiRetries ?? {}).length === 1 && getAgentTurns(getLayout(), 'LIM-8').length === 1);
    const noticesBefore = listSwitchNotices(fourthTopic).length;

    const board = await openBoard(fourthTopic, fourthTopicThreadId);
    await fourthTopic.tapAndAwaitAnswer(board.message, board.rowData(exhaustedAccount));
    await fourthTopic.waitForMessageText('the model page', board.message, (text) => text === `Claude · ${exhaustedAccount} — pick the model for this topic:`);
    const labels = fourthTopic.getKeyboardLabels(board.message).flat();
    const launchesBefore = getSessionLaunches(getLayout()).length;
    const toast = await fourthTopic.tapAndAwaitAnswer(board.message, fourthTopic.getKeyboardData(board.message).flat()[labels.findIndex((label) => label.startsWith('fable'))]);
    assert.equal(toast, `✅ This topic runs on Claude «${exhaustedAccount}» (fable).`);
    await getCharness().waitFor('the session to restart on fable', agentStartTimeoutMs, () => {
      const latest = getSessionLaunches(getLayout()).at(-1);
      return getSessionLaunches(getLayout()).length > launchesBefore && latest !== undefined && getFlagValues(latest.argv, '--model').includes('fable');
    });
    assert.equal(Object.keys(readPersistedState(getLayout()).apiRetries ?? {}).length, 1, 'the wait stays armed: Fable would only run into the same window');
    assert.equal(getAgentTurns(getLayout(), 'LIM-8').length, 1, 'the interrupted turn was not resumed');
    assert.equal(listSwitchNotices(fourthTopic).length, noticesBefore, 'no limit notice');

    // End the wait the way the operator does («skip once» on the board), so the next step starts clean.
    const again = await openBoard(fourthTopic, fourthTopicThreadId);
    assert.equal(fourthTopic.getKeyboardLabels(again.message).flat().at(-1), '⏭ Skip once', 'the armed wait offers «skip once»');
    const skipData = fourthTopic.getKeyboardData(again.message).flat().at(-1) ?? '';
    await fourthTopic.tapAndAwaitAnswer(again.message, skipData);
    await getCharness().waitFor('the wait to be skipped', replyTimeoutMs, () => readPersistedState(getLayout()).apiRetries === undefined);
  });

  it('with a limit wait armed — both accounts limited — a tap on the first account on the /limits board resumes the interrupted turn', async () => {
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

    const board = await openBoard(thirdTopic, thirdTopicThreadId);
    assert.match(board.rowLabel(takeoverAccount), /^✓ Claude · work/, 'the topic runs on the second account');
    assert.equal(thirdTopic.getKeyboardLabels(board.message).flat().at(-1), '⏭ Skip once', 'the armed wait offers «skip once»');
    const launchesBefore = getSessionLaunches(getLayout()).length;
    await thirdTopic.tapAndAwaitAnswer(board.message, board.rowData(exhaustedAccount));
    await getCharness().waitFor('the limit switch\'s notice', agentStartTimeoutMs, () => listSwitchNotices(thirdTopic).length === 2);
    assert.equal(
      listSwitchNotices(thirdTopic)[1].text,
      `🔁 Account «${takeoverAccount}» hit its usage limit — this topic continues on «${exhaustedAccount}». The limit resets ${getResetClock(resetsAtIso)}. Switch: /limits`,
      'a pick during the wait is the limit switch: the account the topic left did hit its limit',
    );
    await getCharness().waitFor('the interrupted turn to resume on the first account', agentStartTimeoutMs, () => getAgentTurns(getLayout(), 'LIM-5').length === 2);
    assert.equal(getLaunchOfTurn(getLayout(), 'LIM-5', 1).claudeConfigDir, null, 'the continue message ran under the first account');
    assert.equal(getSessionLaunches(getLayout()).length, launchesBefore + 1);
    await getCharness().waitFor('the wait to be over', replyTimeoutMs, () => readPersistedState(getLayout()).apiRetries === undefined);
  });
});
