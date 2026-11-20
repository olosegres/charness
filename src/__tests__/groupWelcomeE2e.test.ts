/**
 * @description The greeting General gets when the bot is added to the group, at PROCESS level: the BUILT charness started the
 * way an isolated instance is (`scripts/run-isolated.sh`) against the fake Bot API (`telegramE2e/fakeTelegram.ts`), which reports the
 * bot's own membership changes as `my_chat_member` updates. One flow, in order:
 *
 *   boot → two changes that are not «the bot was added» (another user made an admin, the bot itself leaving) post nothing
 *   → the bot made a group admin posts ONE greeting into General, as Markdown, and that greeting is exactly the
 *     `onboarding.welcome` text with the version this very package says in its title (read from `package.json`, never a number
 *     written into the text) and the projects folder in plain words
 *   → the greeting is short and no longer sends the owner to @BotFather (a group admin gets every message)
 *   → `/doctor` agrees with it: a bot that is not an admin, privacy mode on, fails the admin line and the privacy line; the same
 *     bot made an admin still has privacy mode on and gets no privacy line — nothing red is left for a step the greeting dropped.
 *
 * What the unit tests cover instead: the title's wording and the text in every locale (`groupWelcome.test.ts`), the privacy
 * line's rule (`doctorLine.test.ts`).
 *
 * Nothing leaves the machine: the Bot API is on loopback and the agent is a fake. Everything the test starts is stopped
 * in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram, generalTopicThreadId, type FakeTelegramMessage } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
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
import { startCharnessOnInstance } from './e2e/fallbackFlowKit';
import { enDict } from '../i18n/en';
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const otherUser = { id: 535353, is_bot: false, first_name: 'Other' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
/** The one folder under WORK_ROOT (the root must exist for the bot to start). */
const projectFolder = 'alpha';
const replyTimeoutMs = 20 * 1000;
/** The first words of the `/doctor` report (its header, without the Markdown bold). */
const doctorHeader = 'Charness Doctor';
/** The most non-blank lines the greeting may have: it is read on a phone, in a group that is just set up. */
const greetingMaxLines = 8;
/** How many polls to let pass after the greeting before counting what the bot posted: the updates queued before it have been handled. */
const settlePolls = 2;

const packageVersion: string = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8')).version;

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let generalTopic: TopicDriver;
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

/** The bot's greetings in General, oldest first (the startup status the bot also posts there does not open with the wave). */
function listGreetings(): FakeTelegramMessage[] {
  return generalTopic.listMessages().filter((message) => message.text.startsWith('👋'));
}

describe('the greeting when the bot is added to the group', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-greet-', [projectFolder], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    generalTopic = new TopicDriver(fakeTelegram, getCharness, generalTopicThreadId, replyTimeoutMs);
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
      OPENCODE_URL: `http://127.0.0.1:${await getUnservedPort()}`,
      SCHEDULER_MCP_PORT: (await getFreeFixedPort()).toString(),
      ...getTelegramFlowTestTimingsEnv(),
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

  it('boots', async () => {
    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
  });

  it('greets General ONCE, when the bot is made an admin — not for another member, not for the bot leaving', async () => {
    fakeTelegram.pushMyChatMember('member', 'administrator', otherUser);
    fakeTelegram.pushMyChatMember('member', 'left');
    fakeTelegram.pushMyChatMember('left', 'administrator');

    const greeting = await generalTopic.waitForMessage('the greeting in General', (message) => message.text.startsWith('👋'));
    const pollsAtGreeting = fakeTelegram.listCalls('getUpdates').length;
    await getCharness().waitFor('the updates queued before the greeting to be handled', replyTimeoutMs, () => fakeTelegram.listCalls('getUpdates').length >= pollsAtGreeting + settlePolls);
    assert.deepEqual(listGreetings().map((message) => message.message_id), [greeting.message_id], 'one greeting, for the one change that is the bot being added');

    assert.equal(greeting.parseMode, 'Markdown', 'the title is bold and the folder is code');
    assert.equal(greeting.text.split('\n')[0], `👋 *Charness ${packageVersion}*`, 'the title carries the version of the package that runs, not a number written into the text');
    assert.equal(
      greeting.text,
      enDict['onboarding.welcome'].replace('{title}', `Charness ${packageVersion}`).replace('{workRoot}', getLayout().workRoot),
      'the greeting is the onboarding text with the title and the projects folder filled in',
    );
    assert.ok(greeting.text.includes(`Project folders: \`${getLayout().workRoot}\``), 'the projects folder in plain words, not an environment variable');
  });

  it('the greeting is short and sends nobody to @BotFather', async () => {
    const [greeting] = listGreetings();
    assert.ok(greeting, 'the greeting was posted');
    const lines = greeting.text.split('\n').filter((line) => line.trim() !== '');
    assert.ok(lines.length <= greetingMaxLines, `at most ${greetingMaxLines} lines, got ${lines.length}:\n${greeting.text}`);
    for (const stale of ['BotFather', 'setprivacy', 'WORK_ROOT', 'Charness 2.0']) {
      assert.ok(!greeting.text.includes(stale), `the greeting no longer mentions «${stale}»`);
    }
    assert.ok(greeting.text.includes('/doctor'), 'it still points at /doctor for what is missing');
  });

  it('/doctor: a bot that is not an admin fails the admin line and the privacy line', async () => {
    fakeTelegram.isBotPrivacyModeOn = true;
    const report = await generalTopic.sendAndAwaitReply('/doctor', doctorHeader);
    assert.ok(report.text.includes(`❌ ${enDict['doctor.bot_admin']}`), `the admin line fails:\n${report.text}`);
    assert.ok(report.text.includes(`❌ ${enDict['doctor.privacy_off']}`), `the privacy line fails for a bot that is not an admin:\n${report.text}`);
  });

  it('/doctor: the bot made an admin passes with privacy mode still on — no privacy line, nothing red', async () => {
    fakeTelegram.isBotAdmin = true;
    const report = await generalTopic.sendAndAwaitReply('/doctor', doctorHeader);
    assert.ok(report.text.includes(`✅ ${enDict['doctor.bot_admin']}`), `the admin line passes:\n${report.text}`);
    assert.ok(report.text.includes(`✅ ${enDict['doctor.can_manage_topics']}`), `the topics right is granted:\n${report.text}`);
    assert.ok(!report.text.includes(enDict['doctor.privacy_off']), `no privacy line for an admin bot, though privacy mode is on:\n${report.text}`);
    assert.ok(!report.text.includes('❌'), `nothing fails:\n${report.text}`);
  });
});
