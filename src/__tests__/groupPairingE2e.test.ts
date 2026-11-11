/**
 * @description WHO may pair the bot with a forum supergroup, at PROCESS level: the BUILT charness, with no `ALLOWED_GROUP_ID`
 * (pairing mode), against the fake Bot API (`telegramE2e/fakeTelegram.ts`) that holds the owner's own group and other groups,
 * each with a creator and admins of its own. Anyone can make a group and add the bot, and is then that group's creator — so
 * administering the group to pair must never be enough. Two instances, one after the other:
 *
 * With an owner (`OWNER_USER_ID`, `CHAT_MODE=both` — the DM-first install that stays unpaired):
 *   → a stranger who created a group of their own writes in it: the bot does not pair it; their `/pair` there is refused
 *     («only the bot's owner») and the bot is still unpaired
 *   → the owner writes in their group: it is paired (the first pairing)
 *   → the stranger's `/pair` is refused again; the bot still serves the owner's group
 *   → the owner's `/pair` in another group of theirs moves the bot there
 *
 * Without an owner (`CHAT_MODE=group`):
 *   → the first admin who writes in a group pairs it (the first pairing, as before)
 *   → a stranger's `/pair` in their own group is refused («only that group's creator»)
 *   → so is the `/pair` of an ADMIN of the served group who is not its creator, in a group they created
 *   → the creator of the served group moves it with `/pair` to another group of theirs.
 *
 * The rule itself, branch by branch, is `threadRouting.test.ts` (getPairingRefusal). Nothing leaves the machine; everything the
 * test starts is stopped in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import { FakeTelegram, type FakeTelegramMessage, type TelegramUser } from './telegramE2e/fakeTelegram';
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
import { readPersistedState, startCharnessOnInstance } from './e2e/fallbackFlowKit';
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';

const botUser: TelegramUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const operator: TelegramUser = { id: 424242, is_bot: false, first_name: 'Operator' };
/** An administrator of the operator's group who is not its creator. */
const helper: TelegramUser = { id: 434343, is_bot: false, first_name: 'Helper' };
const stranger: TelegramUser = { id: 666666, is_bot: false, first_name: 'Stranger' };

const ownGroup = { id: -1001111111111, title: 'ExampleGroup' };
/** A group the operator made too: where the bot is moved. */
const secondOwnGroup = { id: -1001111111112, title: 'ExampleGroup Two', creator: operator };
/** A group a stranger made and added the bot to. */
const strangersGroup = { id: -1002222222221, title: 'Stranger group', creator: stranger };
/** A group the operator's helper made. */
const helpersGroup = { id: -1002222222222, title: 'Helper group', creator: helper };
/** The one project folder of the work root (an instance needs one to start); no topic is bound to it. */
const projectFolder = 'pair-proj';
/** The topic every message of this flow is written in, in each group. */
const threadId = 77;

const replyTimeoutMs = 20 * 1000;
const pairedRe = /Group paired/;
const notOwnerRe = /Only the bot's owner can pair it/;
const notCurrentCreatorRe = /only that group's creator can move it/;

/** One isolated instance of this flow: its layout, its fake Bot API and the running bot. */
interface PairingInstance {
  layout: IsolatedInstanceLayout;
  fakeTelegram: FakeTelegram;
  charness: IsolatedCharness | null;
  defaultTmuxSessionsBefore: string[];
}

async function createPairingInstance(prefix: string, extraEnv: Record<string, string>): Promise<PairingInstance> {
  if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
  const layout = createIsolatedInstanceLayout(prefix, [projectFolder], getFlowDeadlineMs());
  const fakeTelegram = new FakeTelegram({
    botUser,
    operator,
    admins: [helper],
    group: ownGroup,
    otherGroups: [secondOwnGroup, strangersGroup, helpersGroup],
  });
  const apiRoot = await fakeTelegram.start();
  writeInstanceEnvFile(layout, {
    CONNECTORS: 'telegram',
    TELEGRAM_BOT_TOKEN: fakeBotToken,
    TELEGRAM_API_ROOT: apiRoot,
    DATA_DIR: layout.dataDir,
    WORK_ROOT: layout.workRoot,
    TMUX_SOCKET_NAME: layout.tmuxSocketName,
    TMUX_TMPDIR: layout.tmuxTmpDir,
    CLAUDE_BIN: writeFakeClaudeLauncher(layout, null),
    // A free port nothing listens on: the boot's OpenCode pre-start finds no server and no binary, and gives up.
    OPENCODE_URL: `http://127.0.0.1:${await getFreePort()}`,
    SCHEDULER_MCP_PORT: (await getFreeFixedPort()).toString(),
    ...getTelegramFlowTestTimingsEnv(),
    ...extraEnv,
  });
  return { layout, fakeTelegram, charness: null, defaultTmuxSessionsBefore: listTmuxSessions([]) };
}

async function stopPairingInstance(instance: PairingInstance | null): Promise<void> {
  if (!instance) return;
  await instance.charness?.stop();
  removeIsolatedInstanceSync(instance.layout, instance.charness);
  await instance.fakeTelegram.stop();
  assert.deepEqual(listTmuxSessions([]), instance.defaultTmuxSessionsBefore, 'the default tmux server was not touched');
}

function getRunningCharness(instance: PairingInstance): IsolatedCharness {
  if (!instance.charness) throw new Error('charness is not started yet');
  return instance.charness;
}

/** The group the bot has saved as the one it serves, `null` while unpaired. */
function readPairedGroupId(instance: PairingInstance): number | null {
  const pairedGroupId = readPersistedState(instance.layout).pairedGroupId;
  return typeof pairedGroupId === 'number' ? pairedGroupId : null;
}

/** `from` writes `text` in the flow's topic of group `groupId`; resolves the bot's first answer there after it that `textRe` matches. */
async function writeAndAwaitAnswer(instance: PairingInstance, groupId: number, from: TelegramUser, text: string, textRe: RegExp): Promise<FakeTelegramMessage> {
  const sentMessageId = instance.fakeTelegram.pushGroupMessage(groupId, threadId, text, from);
  let answer: FakeTelegramMessage | undefined;
  await getRunningCharness(instance).waitFor(`the bot to answer «${text}» from ${from.first_name} with ${textRe}`, replyTimeoutMs, () => {
    answer = instance.fakeTelegram.listBotMessages(threadId, groupId).find((message) => message.message_id > sentMessageId && textRe.test(message.text));
    return answer !== undefined;
  });
  if (!answer) throw new Error(`no answer to «${text}»`);
  return answer;
}

/** Every «Group paired» the bot has posted in group `groupId`. */
function listPairingConfirmations(instance: PairingInstance, groupId: number): FakeTelegramMessage[] {
  return instance.fakeTelegram.listBotMessages(threadId, groupId).filter((message) => pairedRe.test(message.text));
}

let instance: PairingInstance | null = null;

function getInstance(): PairingInstance {
  if (!instance) throw new Error('the instance is not created yet');
  return instance;
}

function removeInstanceSync(): void {
  if (instance) removeIsolatedInstanceSync(instance.layout, instance.charness);
}

before(() => {
  process.on('exit', removeInstanceSync);
  process.once('SIGINT', exitOnSignal);
  process.once('SIGTERM', exitOnSignal);
});

after(() => {
  process.off('exit', removeInstanceSync);
  process.off('SIGINT', exitOnSignal);
  process.off('SIGTERM', exitOnSignal);
});

describe('group pairing with an owner: the owner alone pairs and moves the bot', () => {
  before(async () => {
    instance = await createPairingInstance('charness-pair-owner-', { CHAT_MODE: 'both', OWNER_USER_ID: operator.id.toString() });
  });

  after(async () => {
    await stopPairingInstance(instance);
    instance = null;
  });

  it('a stranger\'s own group is not paired by their message, and their /pair there is refused', async () => {
    getInstance().charness = await startCharnessOnInstance(getInstance().layout, getInstance().fakeTelegram);
    getInstance().fakeTelegram.pushGroupMessage(strangersGroup.id, threadId, 'hello bot', stranger);
    // The refusal comes after the message before it in the same topic: that one was handled too, and paired nothing.
    await writeAndAwaitAnswer(getInstance(), strangersGroup.id, stranger, '/pair', notOwnerRe);
    assert.deepEqual(listPairingConfirmations(getInstance(), strangersGroup.id), []);
    assert.equal(readPairedGroupId(getInstance()), null, 'the bot is still unpaired');
  });

  it('the owner\'s message in their group pairs it', async () => {
    await writeAndAwaitAnswer(getInstance(), ownGroup.id, operator, 'hello from the owner', pairedRe);
    assert.equal(readPairedGroupId(getInstance()), ownGroup.id);
  });

  it('the stranger\'s /pair is refused again: the bot still serves the owner\'s group', async () => {
    await writeAndAwaitAnswer(getInstance(), strangersGroup.id, stranger, '/pair', notOwnerRe);
    assert.equal(readPairedGroupId(getInstance()), ownGroup.id);
  });

  it('so is the /pair of an admin of the owner\'s group who is not the owner, in a group of their own', async () => {
    await writeAndAwaitAnswer(getInstance(), helpersGroup.id, helper, '/pair', notOwnerRe);
    assert.equal(readPairedGroupId(getInstance()), ownGroup.id);
  });

  it('the owner\'s /pair in another group of theirs moves the bot there', async () => {
    await writeAndAwaitAnswer(getInstance(), secondOwnGroup.id, operator, '/pair', pairedRe);
    assert.equal(readPairedGroupId(getInstance()), secondOwnGroup.id);
  });
});

describe('group pairing without an owner: the first group pairs as before, only its creator moves the bot', () => {
  before(async () => {
    instance = await createPairingInstance('charness-pair-creator-', { CHAT_MODE: 'group' });
  });

  after(async () => {
    await stopPairingInstance(instance);
    instance = null;
  });

  it('the first admin who writes in a group pairs it', async () => {
    getInstance().charness = await startCharnessOnInstance(getInstance().layout, getInstance().fakeTelegram);
    await writeAndAwaitAnswer(getInstance(), ownGroup.id, operator, 'hello bot', pairedRe);
    assert.equal(readPairedGroupId(getInstance()), ownGroup.id);
  });

  it('a stranger\'s /pair in their own group is refused', async () => {
    await writeAndAwaitAnswer(getInstance(), strangersGroup.id, stranger, '/pair', notCurrentCreatorRe);
    assert.deepEqual(listPairingConfirmations(getInstance(), strangersGroup.id), []);
    assert.equal(readPairedGroupId(getInstance()), ownGroup.id);
  });

  it('so is the /pair of an admin of the served group who did not create it, in a group they did create', async () => {
    await writeAndAwaitAnswer(getInstance(), helpersGroup.id, helper, '/pair', notCurrentCreatorRe);
    assert.equal(readPairedGroupId(getInstance()), ownGroup.id);
  });

  it('the creator of the served group moves the bot with /pair to another group of theirs', async () => {
    await writeAndAwaitAnswer(getInstance(), secondOwnGroup.id, operator, '/pair', pairedRe);
    assert.equal(readPairedGroupId(getInstance()), secondOwnGroup.id);
  });
});
