/**
 * @description A Claude account whose sign-in expires, at PROCESS level: the BUILT charness started the way an isolated instance is
 * (`scripts/run-isolated.sh`, `CHAT_MODE=both` with an owner) against the fake Bot API of `telegramE2e/fakeTelegram.ts` — which models
 * private chats: a person who never opened one is refused with Telegram's 403 «bot can't initiate conversation with a user» — and the
 * fake `claude` (`jiraE2e/fakeClaude.ts`), which can end a turn on the CLI's own refusal and whose `auth status` answers as the real CLI
 * does for a login that is gone. The operator keeps the group muted, so General is not where they see this: a private message is. Two
 * sign-out episodes of one account, the first as the operator met it — a refused TURN of a conversation running on it —, the second found
 * by the status check. One flow, in order:
 *
 *   boot with an account `work` signed in → `/limits` lists it as an ordinary row; a topic is bound, its agent started and moved onto `work`
 *   → EPISODE 1: the operator's next message ends the turn on «Failed to authenticate: this login reached its time limit and cannot be
 *     renewed» (a refusal of the login, `signedOut`): the conversation moves to `default` by itself and General gets ONE pinned alert naming
 *     the account with the CLI's words; the operator has NEVER opened a private chat with the bot, so Telegram refuses the private message —
 *     the log says so, nothing lands in any private chat, and the same General alert carries one more line asking the operator to open a
 *     private chat with the bot and press Start (it is the only alert that does)
 *   → THE BUG: `/limits` still lists the account — `work — 🔑 sign-in expired` in the usage block and a `🔑 Claude · work` row that
 *     carries the sign-in callback, never a switch target — while `/accounts` says «not signed in»
 *   → a tap on that `/limits` row signs it in again like the 🔑 of `/accounts`: the link reaches General, the pasted code is taken, the
 *     refusal and the alert's pin go, `/limits` has the account as an ordinary row again; the board message the tap was on is not turned
 *     into the picker
 *   → the operator opens their private chat with the bot; EPISODE 2: the login expires AGAIN (the status check finds none): General's
 *     second alert — without the «open a private chat» line — and now the PRIVATE message: one line naming the account, ONE button with the
 *     sign-in callback, in the operator's private chat, once: more probes add nothing (not in General, not in the private chat)
 *   → a tap on the private message's button starts the sign-in IN the private chat (the link is posted there, the code pasted there is
 *     taken) and leaves the message as it is — its text and its button — instead of turning it into the picker; once the account is back
 *     that message turns into «signed in again» and loses its button
 *
 * What the unit tests cover instead: which accounts the private message is for, once per episode, the ids it keeps, its words and the
 * «open a private chat» line in all 12 locales (`claudeAccountAlert.test.ts`), the board's rows and lines by reason (`limitsBoardPlan.test.ts`,
 * `limitsBoard.test.ts`), the sign-in callback (`claudeAccounts.test.ts`, `claudeProfiles.test.ts`).
 *
 * Nothing leaves the machine: the Bot API is on loopback and the agent is a fake. Everything the test starts is stopped in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram, generalTopicThreadId, type FakeTelegramMessage, type TelegramUser } from './telegramE2e/fakeTelegram';
import { PrivateChatDriver, TopicDriver } from './telegramE2e/topicDriver';
import { fakeClaudeApiErrorOnceFileName, fakeClaudeExpiredLoginMethod, fakeClaudeLoginFileName, fakeClaudeLoginUrl, getLaunchSessionId } from './jiraE2e/fakeClaudeContract';
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
import { getAccountConfigDir, getSessionLaunches, openLimitsBoard, readPersistedState, startCharnessOnInstance, waitForSessionRespawn } from './e2e/fallbackFlowKit';
import { createClaudeProfileLayout } from '../utils/claudeProfiles';
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';

const group = { id: -1001111111111, title: 'ExampleGroup' };
/** The owner: the group's creator, and the one whose private chat the bot serves (`OWNER_USER_ID`). */
const operator: TelegramUser = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser: TelegramUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
/** The account whose sign-in expires. */
const account = 'work';
const pastedCode = 'fake-claude-code-4711';
const signInCallback = `acct_signin_${account}`;
/** The topic whose conversation runs on the account, and its folder (the instance layout makes it). */
const topicThreadId = 121;
const folder = 'signout';
/** What Claude Code says when the login can no longer be renewed: the CLI's own words of a refused turn. */
const refusalText = 'Failed to authenticate: this login reached its time limit and cannot be renewed';
const openPrivateChatLine = 'open a private chat with @fake_charness_bot and press Start.';

const replyTimeoutMs = 30 * 1000;
/**
 * How long the flow lets the bot go on before it asserts that something did NOT happen (no second message, no private chat): a few of its paced
 * sends (200 ms apart in a flow, `telegramFlowTimings.ts`) with room to spare. Every positive step waits for its own message instead.
 */
const settleMs = 1500;

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let general: TopicDriver;
let topic: TopicDriver;
let privateChat: PrivateChatDriver;
let defaultTmuxSessionsBefore: string[] = [];
/** The topic's conversation: it follows the topic onto every account. */
let sessionId = '';

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

/** The account's login in the fake: signed in as a subscription account, or expired (what `claude auth status` then answers). */
function writeLogin(method: 'claudeai' | typeof fakeClaudeExpiredLoginMethod): void {
  fs.writeFileSync(path.join(getAccountConfigDir(getLayout(), account), fakeClaudeLoginFileName), JSON.stringify({ method }));
}

/** The bot's account alerts in General: the ones that name the account as signed out. */
function listGeneralAlerts(): FakeTelegramMessage[] {
  return general.listMessages().filter((message) => message.text.includes(`Claude account «${account}» is signed out`));
}

/** The sends the bot attempted to the operator's private chat so far (the boot's «ready» status was one: refused as well while no chat is open). */
function countPrivateSendAttempts(): number {
  return fakeTelegram.listCalls('sendMessage').filter((call) => call.payload.chat_id === operator.id).length;
}

/** What the bot told the operator about the account in their PRIVATE chat. */
function listPrivateSignOutMessages(): FakeTelegramMessage[] {
  return privateChat.listMessages().filter((message) => message.text.includes(`«${account}»`));
}

/** The operator's `/accounts` in General: the forced probe of every account runs before the screen is drawn. */
async function probeAccounts(): Promise<FakeTelegramMessage> {
  return general.sendAndAwaitReply('/accounts', 'Claude account for all topics');
}

/** The usage block and the rows of `/limits` in General, for the account. */
async function readLimitsOfAccount(): Promise<{ line: string | undefined; row: { label: string; data: string } | undefined; message: FakeTelegramMessage }> {
  const board = await openLimitsBoard(fakeTelegram, general, generalTopicThreadId);
  const labels = general.getKeyboardLabels(board.message).flat();
  const data = general.getKeyboardData(board.message).flat();
  const index = labels.findIndex((label) => label.includes(` · ${account}`));
  return {
    message: board.message,
    line: board.message.text.split('\n').find((candidate) => candidate.startsWith(`${account} —`)),
    row: index < 0 ? undefined : { label: labels[index], data: data[index] },
  };
}

describe('A Claude account whose sign-in expires, end to end: built charness, fake Bot API with private chats, fake claude', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-signout-', [folder], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    // A person who never opened a private chat with the bot cannot be written to: Telegram answers 403.
    fakeTelegram.isPrivateChatStartRequired = true;
    general = new TopicDriver(fakeTelegram, getCharness, generalTopicThreadId, replyTimeoutMs);
    topic = new TopicDriver(fakeTelegram, getCharness, topicThreadId, replyTimeoutMs);
    privateChat = new PrivateChatDriver(fakeTelegram, getCharness, operator, replyTimeoutMs);
    const apiRoot = await fakeTelegram.start();
    writeInstanceEnvFile(layout, {
      TELEGRAM_BOT_TOKEN: fakeBotToken,
      TELEGRAM_API_ROOT: apiRoot,
      ALLOWED_GROUP_ID: group.id.toString(),
      CHAT_MODE: 'both',
      OWNER_USER_ID: operator.id.toString(),
      DATA_DIR: layout.dataDir,
      WORK_ROOT: layout.workRoot,
      TMUX_TMPDIR: layout.tmuxTmpDir,
      CLAUDE_BIN: writeFakeClaudeLauncher(layout, null),
      // A free port nothing listens on: the boot's OpenCode pre-start finds no server and no binary, and gives up.
      OPENCODE_URL: `http://127.0.0.1:${await getUnservedPort()}`,
      SCHEDULER_MCP_PORT: (await getFreeFixedPort()).toString(),
      ...getTelegramFlowTestTimingsEnv(),
    });
    // The account an operator signed in by hand before the boot: the first usage poll adopts and probes it.
    createClaudeProfileLayout({ dataDir: layout.dataDir, name: account, homeClaudeDir: path.join(layout.instanceHome, '.claude') });
    writeLogin('claudeai');
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

  it('boots with the account signed in: `/limits` lists it as an ordinary row, no alert anywhere; a topic is bound, its agent started and moved onto the account', async () => {
    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    await getCharness().waitFor(`${account} adopted and signed in`, replyTimeoutMs, () => readPersistedState(getLayout()).claudeProfiles?.[account]?.loggedIn === true);
    const limits = await readLimitsOfAccount();
    assert.equal(limits.row?.label, `Claude · ${account}`);
    assert.match(limits.row?.data ?? '', /^lim_c_\d+$/, 'a switch row');
    assert.equal(listGeneralAlerts().length, 0);
    assert.equal(fakeTelegram.listPrivateBotMessages(operator.id).length, 0);

    await topic.sendAndAwaitReply(`/bind ${folder}`, `Bound to \`${folder}\``);
    await topic.sendAndAwaitReply('/claude', 'ready in');
    await getCharness().waitFor('the first session launch', replyTimeoutMs, () => getSessionLaunches(getLayout()).length === 1);
    sessionId = getLaunchSessionId(getSessionLaunches(getLayout())[0].argv) ?? '';
    assert.ok(sessionId);
    const screen = await topic.sendAndAwaitReply('/accounts', 'This topic runs on');
    const launchesBefore = getSessionLaunches(getLayout()).length;
    await topic.tapAndAwaitAnswer(screen, `acct_use_${account}`);
    await waitForSessionRespawn(getCharness(), getLayout(), `the conversation under ${account}`, getAccountConfigDir(getLayout(), account), sessionId, launchesBefore);
  });

  it('EPISODE 1, a refused turn: the conversation moves to `default`; General gets ONE pinned alert with the CLI\'s words; the operator never opened a private chat, so the private message is refused, nothing lands in any private chat and the alert asks them to open one', async () => {
    const privateAttemptsBefore = countPrivateSendAttempts();
    const launchesBefore = getSessionLaunches(getLayout()).length;
    fs.writeFileSync(path.join(getLayout().fakeStateDir, fakeClaudeApiErrorOnceFileName), refusalText);
    fakeTelegram.pushOperatorMessage(topicThreadId, 'please carry on');

    const alert = await general.waitForMessage('the alert in General', (message) => message.text.includes(`Claude account «${account}» is signed out`));
    assert.match(alert.text, new RegExp(`/accounts login ${account}`), 'General keeps its text as before: the command to run');
    assert.ok(alert.text.includes(`The CLI said: ${refusalText}`), `the CLI's own words: ${alert.text}`);
    assert.ok(alert.text.includes('Its conversations continue on «default»'), alert.text);
    assert.ok(alert.text.endsWith(openPrivateChatLine), `the line that asks the operator to open a private chat closes the alert: ${alert.text}`);
    assert.ok(alert.text.includes('To be told about this in a private message next time, open a private chat with @fake_charness_bot'), alert.text);
    await getCharness().waitFor('the alert pinned in General', replyTimeoutMs, () => fakeTelegram.listPinnedMessageIds().includes(alert.message_id));
    await waitForSessionRespawn(getCharness(), getLayout(), 'the conversation moved to default', null, sessionId, launchesBefore);

    const screen = await probeAccounts();
    assert.match(screen.text, new RegExp(`• ${account} — not signed in`), '/accounts says «not signed in»');
    await getCharness().waitFor('the private message tried and refused', replyTimeoutMs, () => getCharness().output.includes("[accounts] the operator's private chat is closed to the bot"));
    await new Promise((resolve) => setTimeout(resolve, settleMs));
    assert.equal(fakeTelegram.listPrivateBotMessages(operator.id).length, 0, 'nothing in the operator\'s private chat: it does not exist for the bot');
    assert.equal(listGeneralAlerts().length, 1, 'General\'s alert once');
    assert.equal(countPrivateSendAttempts(), privateAttemptsBefore + 1, 'the bot tried the operator\'s private chat once — the refusal is a log line, not a retry loop');
    const record = readPersistedState(getLayout()).claudeAccountAlerts;
    assert.equal(record?.alerted?.includes(account), true, 'told, so the next round says nothing');
    assert.equal(record?.signOutMessageIds, undefined, 'no private message, so no id');
    assert.equal(readPersistedState(getLayout()).claudeProfiles?.[account]?.authRefusal?.reason, 'signedOut', 'the refusal of the login is on the account');
  });

  it('THE BUG: `/limits` does not drop the signed-out account — its usage line says `🔑 sign-in expired` and its row is the sign-in button, no switch target', async () => {
    const limits = await readLimitsOfAccount();
    assert.equal(limits.line, `${account} — 🔑 sign-in expired`);
    assert.equal(limits.row?.label, `🔑 Claude · ${account}`);
    assert.equal(limits.row?.data, signInCallback);
    assert.ok(Buffer.byteLength(limits.row?.data ?? '') <= 64);
  });

  it('a tap on the `/limits` row signs the account in again: the link in General, the pasted code taken, the pin gone, the row an ordinary one; the board message is not turned into the picker', async () => {
    const [pinnedAlert] = listGeneralAlerts();
    assert.ok(fakeTelegram.listPinnedMessageIds().includes(pinnedAlert.message_id), 'the alert is pinned until the sign-in');
    const board = await readLimitsOfAccount();
    const boardTextBefore = board.message.text;
    assert.equal(board.row?.data, signInCallback, 'the row to tap is on the board');
    await general.tapAndAwaitAnswer(board.message, board.row?.data ?? '');
    const link = await general.waitForMessage('the sign-in link', (message) => message.text.includes(fakeClaudeLoginUrl));
    assert.match(link.text, new RegExp(`profile ${account}`));
    assert.equal(board.message.text, boardTextBefore, 'the board message stays the board — it is not edited into /accounts');

    // The login the fake records is the account's new one: the status probe will say signed in.
    fakeTelegram.pushOperatorMessage(generalTopicThreadId, pastedCode);
    await general.waitForMessage('the sign-in confirmation', (message) => message.text.includes(`Profile ${account} signed in`));
    const back = await general.waitForMessage('the «signed in again» line', (message) => message.text.includes(`Claude account «${account}» is signed in again`));
    assert.ok(back.message_id > 0);
    await getCharness().waitFor('the alert unpinned', replyTimeoutMs, () => !fakeTelegram.listPinnedMessageIds().includes(pinnedAlert.message_id));
    assert.equal(readPersistedState(getLayout()).claudeProfiles?.[account]?.loggedIn, true);

    const limits = await readLimitsOfAccount();
    assert.equal(limits.row?.label, `Claude · ${account}`, 'an ordinary row again');
    assert.match(limits.row?.data ?? '', /^lim_c_\d+$/);
    assert.equal(limits.line, undefined, 'no figure was polled for it, and no «sign-in expired» line');
  });

  it('EPISODE 2, the status check finds the login gone, the operator\'s private chat is open: General alerts again, and the PRIVATE message follows — one line, one sign-in button, once', async () => {
    fakeTelegram.pushPrivateMessage(operator, '/status'); // writing to the bot opens the chat, as pressing Start does
    await privateChat.waitForMessage('the status reply in the private chat', () => true);
    const privateBefore = fakeTelegram.listPrivateBotMessages(operator.id).length;
    const alertsBefore = listGeneralAlerts().length;

    writeLogin(fakeClaudeExpiredLoginMethod);
    await probeAccounts();
    const dm = await privateChat.waitForMessage('the private sign-out message', (message) => message.text.includes(`«${account}»`) && message.text.includes('signed out'));
    assert.equal(dm.text, `🔑 Claude account «${account}» is signed out — its sign-in expired. Tap the button to sign it in again.`);
    assert.deepEqual(privateChat.getKeyboardLabels(dm), [['🔑 Sign in again']]);
    assert.deepEqual(privateChat.getKeyboardData(dm), [[signInCallback]]);
    assert.ok(!dm.isSilent, 'a notification: the private chat is what reaches an operator who keeps the group muted');
    await general.waitForMessage('General\'s second alert', () => listGeneralAlerts().length === alertsBefore + 1);
    assert.equal(listGeneralAlerts().length, alertsBefore + 1, 'General\'s notice is unchanged: still posted, once');
    assert.ok(!listGeneralAlerts().at(-1)?.text.includes('private chat'), 'the private message went out, so the alert does not ask for a private chat');

    // Once per sign-out: more probes of the same sign-out add nothing, in General or in the private chat.
    await probeAccounts();
    await probeAccounts();
    await new Promise((resolve) => setTimeout(resolve, settleMs));
    assert.equal(listPrivateSignOutMessages().length, 1, 'one private message for the episode');
    assert.equal(fakeTelegram.listPrivateBotMessages(operator.id).length, privateBefore + 1, 'and nothing else in the private chat');
    assert.equal(listGeneralAlerts().length, alertsBefore + 1, 'no third alert');
  });

  it('a tap on the private message\'s button starts the sign-in IN the private chat and leaves the message as it is; the code pasted there signs the account in', async () => {
    const [dm] = listPrivateSignOutMessages();
    const textBefore = dm.text;
    await privateChat.tapAndAwaitAnswer(dm, signInCallback);
    const link = await privateChat.waitForMessage('the sign-in link in the private chat', (message) => message.text.includes(fakeClaudeLoginUrl));
    assert.match(link.text, new RegExp(`profile ${account}`));
    assert.equal(dm.text, textBefore, 'the private message keeps its text — it is not edited into /accounts');
    assert.deepEqual(privateChat.getKeyboardData(dm), [[signInCallback]], 'and its button');

    fakeTelegram.pushPrivateMessage(operator, pastedCode);
    await privateChat.waitForMessage('the sign-in confirmation in the private chat', (message) => message.text.includes(`Profile ${account} signed in`));
    await getCharness().waitFor(`${account} signed in again`, replyTimeoutMs, () => readPersistedState(getLayout()).claudeProfiles?.[account]?.loggedIn === true);

    // The earlier private message is now untrue: it says the account is signed in again and its button is gone.
    await privateChat.waitForMessageText('the private message turned into «signed in again»', dm, (text) => text === `✅ Claude account «${account}» is signed in again and takes conversations.`);
    assert.deepEqual(privateChat.getKeyboardData(dm), [], 'no button on a message that is no longer true');
    assert.equal(readPersistedState(getLayout()).claudeAccountAlerts?.signOutMessageIds, undefined, 'its id is no longer kept');
    assert.equal(listPrivateSignOutMessages().length, 1, 'turned, not repeated: still the one message');
    const limits = await readLimitsOfAccount();
    assert.equal(limits.row?.label, `Claude · ${account}`);
  });
});
