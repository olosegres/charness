/**
 * @description A conversation whose transcript the CLI's own cleanup removed, at PROCESS level: the BUILT charness
 * started the way an isolated instance is (`scripts/run-isolated.sh`) against the fake Bot API of
 * `telegramE2e/fakeTelegram.ts`, with the fake `claude` (`jiraE2e/fakeClaude.ts`) behaving as the real CLI 2.1.302 was
 * MEASURED to: a process stopped after a turn writes its metadata entries (`last-prompt`, `cost-state`, …) back into its
 * transcript — into a NEW file when the transcript was removed under it — a moment after the signal, and a transcript
 * with no message is refused by `--resume` («No conversation found») AND by `--session-id` («already in use»). One flow:
 *
 *   boot → a topic is bound, a second account is seeded, the topic's agent answers a first message
 *   → the transcript is removed (the cleanup of old conversations) while the agent runs
 *   → General's `/limits`: a tap on the second account re-spawns the topic under it — with the Bot API refusing the
 *     tap's toast as expired (the re-spawns of every live topic outlast Telegram's wait): the board still moves its ✓,
 *     the confirmation is posted as a message, the conversation starts again under its id; the stub the stopped agent left
 *     is proof the conversation had turns, so the topic is told once that it is gone (no error)
 *   → a tap back on the first account right away (the first process has exited by now, its stub written unless the
 *     re-spawn waited for it): the topic's agent is started again, not refused, and the topic hears no error and no second
 *     notice (the agent just started took no turn: no file, nothing lost); no re-spawn started while the process it
 *     replaced still ran
 *   → the agent is gone before the conversation begun again under its id took a turn: the topic's next message wakes it
 *     silently under the same id and is answered (the watermark of the lost conversation was dropped with it)
 *   → the bot is stopped, the topic's agent is gone and only the stub is left on disk, while the saved state still
 *     names the conversation (the live state of the incident): the topic's next message is told once that the
 *     conversation is gone (the resume is not even tried), starts a new session and is answered, and the message after
 *     it is answered with no further notice
 *   → the topic's agent is gone again and its transcript is removed ENTIRELY while the conversation sleeps (the cleanup
 *     of conversations left alone for a month: no process, so no stub): the bot saw that conversation take turns, so its
 *     next message is told once that it is gone and gets a new session — never a silent start under the old id
 *   → a topic whose agent never took a turn (a session started and left alone) and whose agent is gone: no transcript, so
 *     nothing was lost — its next message wakes it silently under the same id
 *   → an agent that ignores the stop signals is killed after the bounded wait and only then is the replacement launched
 *
 * What the unit tests cover instead: the transcript decision (`claudeTranscriptContent.test.ts`,
 * `claudeSessionLaunch.test.ts`), the board's and the accounts screen's late toast (`limitsBoard.test.ts`,
 * `claudeAccounts.test.ts`, `callbackToast.test.ts`).
 *
 * Nothing leaves the machine: the Bot API is on loopback and the agent is a fake. Everything the test starts is stopped
 * in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram, generalTopicThreadId } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import { fakeClaudeExitFlushDelayFileName, fakeClaudeIgnoreStopSignalsFileName, getFakeClaudeTranscriptPath, getFlagValues, getLaunchSessionId } from './jiraE2e/fakeClaudeContract';
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
  getSessionLaunches,
  openLimitsBoard,
  readPersistedState,
  restartCharnessWithState,
  startCharnessOnInstance,
  waitForSessionRespawn,
  type PersistedState,
} from './e2e/fallbackFlowKit';
import { createClaudeProfileLayout } from '../utils/claudeProfiles';
import { readClaudeTranscriptContent } from '../utils/claudeTranscriptContent';
import { checkIsPidAlive } from '../utils/jsonStreamHost';
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const topicThreadId = 111;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const projectFolder = 'lost-transcript';
const silentFolder = 'never-spoken';
const silentTopicThreadId = 112;
const firstAccount = 'default';
const secondAccount = 'work';

const replyTimeoutMs = 20 * 1000;
/** After a stop signal the fake writes its transcript metadata back this late: after the bot's next launch decision, as a heavy conversation's exit did. */
const exitFlushDelayMs = 1500;
/** A General tap re-spawns the topic's agent: the old process is waited for (its exit flush), the new one starts and answers. */
const respawnTimeoutMs = 60 * 1000;
/** The bot's bounded wait for a stopped process (`pidExitWaitTimeoutMs`): a process that ignores the signals is killed after it. */
const stopWaitMs = 5 * 1000;
/** Lines the bot posts into a topic when its agent fails to come up or the CLI refuses a launch. */
const topicErrorRe = /Claude error|API error|exited unexpectedly|Failed to start/;
/** The one soft line a topic gets when its conversation is gone and a fresh session takes its place. */
const conversationLostNoticeRe = /could not be resumed/;

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let general: TopicDriver;
let topic: TopicDriver;
let silentTopic: TopicDriver;
let defaultTmuxSessionsBefore: string[] = [];
/** The conversation the topic's agent took its first turn on. */
let sessionId = '';
/** The process that ran it: the one the first re-spawn stops, and whose exit writes the stub. */
let firstProcessPid = 0;
/** The process the topic's agent runs in now (the last step that started one keeps it here). */
let topicProcessPid = 0;

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

function getTranscriptPath(): string {
  return getFakeClaudeTranscriptPath({ homeDir: getLayout().instanceHome, workDir: path.join(getLayout().workRoot, projectFolder), sessionId });
}

/** The lines of the topic that say its agent failed. */
function listTopicErrors(): string[] {
  return topic.listMessages().map((message) => message.text).filter((text) => topicErrorRe.test(text));
}

function listConversationLostNotices(driver: TopicDriver = topic): string[] {
  return driver.listMessages().map((message) => message.text).filter((text) => conversationLostNoticeRe.test(text));
}

/** The flags the newest session launch carries for the conversation: how the CLI was asked to open it. */
function getNewestLaunchFlags(): { isFresh: boolean; isResume: boolean; configDir: string | null } {
  const launch = getSessionLaunches(getLayout()).at(-1);
  if (!launch) throw new Error('no session launch recorded');
  return {
    isFresh: getFlagValues(launch.argv, '--session-id').includes(sessionId),
    isResume: getFlagValues(launch.argv, '--resume').includes(sessionId),
    configDir: launch.claudeConfigDir,
  };
}

/** Send a labelled prompt the fake agent answers, and wait for its answer in the topic. */
async function askAndAwaitAnswer(label: string): Promise<void> {
  fakeTelegram.pushOperatorMessage(topicThreadId, `${label} [fake:answer] are you there`);
  await topic.waitForMessage(`the agent's answer to ${label}`, (message) => message.text.includes(`Fake final answer for ${label}`));
}

describe('A conversation whose transcript was removed, end to end: built charness, fake Bot API, fake claude', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-losttr-', [projectFolder, silentFolder], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fs.mkdirSync(layout.fakeStateDir, { recursive: true });
    fs.writeFileSync(path.join(layout.fakeStateDir, fakeClaudeExitFlushDelayFileName), exitFlushDelayMs.toString());
    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    general = new TopicDriver(fakeTelegram, getCharness, generalTopicThreadId, replyTimeoutMs);
    topic = new TopicDriver(fakeTelegram, getCharness, topicThreadId, replyTimeoutMs);
    silentTopic = new TopicDriver(fakeTelegram, getCharness, silentTopicThreadId, replyTimeoutMs);
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
      ...getTelegramFlowTestTimingsEnv(),
    });
  });

  after(async () => {
    fakeTelegram.isCallbackAnswerExpired = false;
    // No more late flushes of the agents the teardown stops: they would write into the directories it is removing.
    fs.rmSync(path.join(getLayout().fakeStateDir, fakeClaudeExitFlushDelayFileName), { force: true });
    await charness?.stop();
    removeInstanceSync();
    await fakeTelegram?.stop();
    process.off('exit', removeInstanceSync);
    process.off('SIGINT', exitOnSignal);
    process.off('SIGTERM', exitOnSignal);
    assert.deepEqual(listTmuxSessions([]), defaultTmuxSessionsBefore, 'the default tmux server was not touched');
  });

  /** The bot is stopped, `beforeStart` runs on the instance while it is down, and the bot starts again. */
  async function restartWith(beforeStart: (state: PersistedState) => void): Promise<void> {
    charness = await restartCharnessWithState(getLayout(), fakeTelegram, getCharness(), beforeStart);
  }

  it('boots, binds the topic with the request view, seeds a second signed-in account and lets the topic\'s agent answer a first message', async () => {
    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    await topic.sendAndAwaitReply(`/bind ${projectFolder}`, `Bound to \`${projectFolder}\``);
    await topic.sendAndAwaitReply('/verbosity stream_answers', 'This topic shows: Stream + answers');
    createClaudeProfileLayout({ dataDir: getLayout().dataDir, name: secondAccount, homeClaudeDir: path.join(getLayout().instanceHome, '.claude') });
    await restartWith((persisted) => {
      persisted.claudeProfiles = {
        ...persisted.claudeProfiles,
        [secondAccount]: { createdAt: new Date().toISOString(), loggedIn: true, email: 'work@example.com', subscriptionType: 'max' },
      };
    });
    await topic.sendAndAwaitReply('/claude', 'ready in');
    await askAndAwaitAnswer('LOST-1');
    const launch = getSessionLaunches(getLayout()).at(-1);
    sessionId = (launch && getLaunchSessionId(launch.argv)) ?? '';
    firstProcessPid = launch?.pid ?? 0;
    assert.ok(sessionId, 'the launch carries a conversation id');
    assert.equal(await readClaudeTranscriptContent(getTranscriptPath()), 'conversation', 'the first turn left a transcript');
  });

  it('with the transcript removed under the live agent, a General tap on the second account whose toast comes too late still moves the board\'s ✓, says the confirmation as a message, and starts the conversation again under its id', async () => {
    fs.rmSync(getTranscriptPath());
    const board = await openLimitsBoard(fakeTelegram, general, generalTopicThreadId);
    assert.match(board.rowLabel(`Claude · ${firstAccount}`), /^✓ Claude · default/, 'precondition: the default account is the first');
    const launchesBefore = getSessionLaunches(getLayout()).length;
    fakeTelegram.isCallbackAnswerExpired = true;
    try {
      fakeTelegram.pushCallback(board.message.message_id, board.rowData(`Claude · ${secondAccount}`));
      await getCharness().waitFor('the board to move its ✓ to the second account', respawnTimeoutMs, () => general.getKeyboardLabels(board.message).flat().some((label) => label.startsWith(`✓ Claude · ${secondAccount}`)));
    } finally {
      fakeTelegram.isCallbackAnswerExpired = false;
    }
    assert.ok(
      general.listMessages().some((message) => message.text.includes(`Default Claude account for ALL topics: ${secondAccount}`)),
      'the toast was refused: the confirmation is a message',
    );
    await waitForSessionRespawn(getCharness(), getLayout(), 'the topic\'s agent to be re-spawned under the second account', getAccountConfigDir(getLayout(), secondAccount), sessionId, launchesBefore);
    assert.deepEqual(getNewestLaunchFlags(), { isFresh: true, isResume: false, configDir: getAccountConfigDir(getLayout(), secondAccount) }, 'nothing to resume: the conversation starts again under its id');
    assert.deepEqual(listTopicErrors(), [], 'the topic hears no error');
    // The stopped agent left only a stub: proof the conversation HAD turns, and our re-spawn is what discarded it.
    await topic.waitForMessage('the one-line notice that the conversation is gone', (message) => conversationLostNoticeRe.test(message.text));
    assert.equal(listConversationLostNotices().length, 1, 'told once');
  });

  it('a tap back on the first account right away — the first process has exited by now — starts the topic\'s agent again instead of being refused; the topic hears no error', async () => {
    // The process the first re-spawn stopped writes its metadata entries back as it exits, a moment after the signal: with
    // nothing waiting for it, its stub is on disk by now.
    await getCharness().waitFor('the first process to be gone', exitFlushDelayMs * 4, () => !checkIsPidAlive(firstProcessPid));
    const board = await openLimitsBoard(fakeTelegram, general, generalTopicThreadId);
    const launchesBefore = getSessionLaunches(getLayout()).length;
    await general.tapAndAwaitAnswer(board.message, board.rowData(`Claude · ${firstAccount}`));
    await waitForSessionRespawn(getCharness(), getLayout(), 'the topic\'s agent to be re-spawned under the first account', null, sessionId, launchesBefore);
    assert.deepEqual(listTopicErrors(), [], 'the topic hears no error');
    assert.ok(!getCharness().output.includes('exited unexpectedly'), 'the agent did not die at its start');
    assert.equal(listConversationLostNotices().length, 1, 'no second notice: the agent just re-spawned took no turn, so no file was left and nothing was lost');
    assert.deepEqual(
      getSessionLaunches(getLayout()).filter((launch) => launch.overlapsPid != null).map((launch) => launch.pid),
      [],
      'every re-spawn waited for the process it replaced: never two agents on one conversation',
    );
  });

  it('the conversation begun again under its id sleeps before its first turn: its next message wakes it silently under the same id — the topic was already told once', async () => {
    const launch = getSessionLaunches(getLayout()).at(-1);
    assert.ok(launch, 'the topic\'s agent runs');
    await restartWith((persisted) => {
      process.kill(launch.pid, 'SIGKILL'); // the agent is gone while the bot is down; the saved state still names its conversation
      const agent = persisted.agents?.[`${group.id}:${topicThreadId}`];
      assert.equal(agent?.claudeSessionId, sessionId, 'the saved state names the conversation');
      assert.equal(agent?.seenWatermark, undefined, 'the watermark of the lost conversation is not taken for a turn of the new one');
    });
    assert.equal(await readClaudeTranscriptContent(getTranscriptPath()), 'absent', 'precondition: the new conversation took no turn, so there is no file');
    const launchesBefore = getSessionLaunches(getLayout()).length;
    await askAndAwaitAnswer('LOST-2');
    const launches = getSessionLaunches(getLayout()).slice(launchesBefore);
    assert.equal(launches.length, 1, 'one new process for the message');
    assert.deepEqual([getFlagValues(launches[0].argv, '--resume'), getFlagValues(launches[0].argv, '--session-id')], [[], [sessionId]], 'started under the same id, nothing to resume');
    assert.equal(listConversationLostNotices().length, 1, 'no second notice for the one loss');
    assert.deepEqual(listTopicErrors(), []);
  });

  it('a topic left with a gone agent and only the stub on disk while the saved state still names the conversation: its next message is told once that the conversation is gone, starts a new session, and the message after it is answered with no further notice', async () => {
    const launch = getSessionLaunches(getLayout()).at(-1);
    assert.ok(launch, 'the topic\'s agent runs');
    await restartWith((persisted) => {
      // The agent dies with the bot down; its transcript is gone and only the metadata stub of a lost conversation is left.
      process.kill(launch.pid, 'SIGKILL');
      fs.rmSync(getTranscriptPath(), { force: true });
      fs.mkdirSync(path.dirname(getTranscriptPath()), { recursive: true });
      fs.writeFileSync(getTranscriptPath(), `${JSON.stringify({ type: 'last-prompt', lastPrompt: 'an old prompt', sessionId })}\n${JSON.stringify({ type: 'cost-state', sessionId })}\n`);
      const agent = persisted.agents?.[`${group.id}:${topicThreadId}`];
      assert.equal(agent?.claudeSessionId, sessionId, 'the saved state names the conversation');
    });
    assert.equal(await readClaudeTranscriptContent(getTranscriptPath()), 'metadataOnly', 'precondition: the stub is all that is on disk');
    const launchesBefore = getSessionLaunches(getLayout()).length;
    await askAndAwaitAnswer('LOST-3');
    const launches = getSessionLaunches(getLayout()).slice(launchesBefore);
    const noticesBefore = 1; // the one the live re-spawn posted
    assert.equal(launches.length, 1, 'one new process for the message: the resume was not even tried');
    assert.equal(getFlagValues(launches[0].argv, '--resume').length, 0, 'nothing was resumed');
    topicProcessPid = launches[0].pid;
    const freshSessionId = getLaunchSessionId(launches[0].argv);
    assert.ok(freshSessionId && freshSessionId !== sessionId, 'the conversation is a new one, under a new id');
    assert.equal(listConversationLostNotices().length, noticesBefore + 1, 'the topic is told once more that the previous conversation is gone');
    assert.deepEqual(listTopicErrors(), [], 'the topic hears no error');
    await getCharness().waitFor('the new conversation to be the saved one', replyTimeoutMs, () => readPersistedState(getLayout()).agents?.[`${group.id}:${topicThreadId}`]?.claudeSessionId === freshSessionId);
    await askAndAwaitAnswer('LOST-4');
    assert.equal(listConversationLostNotices().length, noticesBefore + 1, 'no further notice: the saved state no longer names the dead conversation');
    assert.deepEqual(listTopicErrors(), []);
  });

  it('a sleeping conversation whose transcript was removed ENTIRELY (no stub: no process was there to write one) is told once that it is gone and gets a new session — the bot saw it take turns', async () => {
    const launch = getSessionLaunches(getLayout()).at(-1);
    assert.ok(launch, 'the topic\'s agent runs');
    const lostSessionId = getLaunchSessionId(launch.argv) ?? '';
    const lostTranscriptPath = getFakeClaudeTranscriptPath({ homeDir: getLayout().instanceHome, workDir: path.join(getLayout().workRoot, projectFolder), sessionId: lostSessionId });
    assert.equal(await readClaudeTranscriptContent(lostTranscriptPath), 'conversation', 'precondition: the session took turns');
    await restartWith((persisted) => {
      process.kill(launch.pid, 'SIGKILL');
      fs.rmSync(lostTranscriptPath, { force: true });
      const agent = persisted.agents?.[`${group.id}:${topicThreadId}`];
      assert.equal(agent?.claudeSessionId, lostSessionId, 'the saved state names the conversation');
      assert.equal(agent?.seenWatermark?.sessionId, lostSessionId, 'the bot recorded that it took a turn');
    });
    const noticesBefore = listConversationLostNotices().length;
    const launchesBefore = getSessionLaunches(getLayout()).length;
    await askAndAwaitAnswer('LOST-5');
    const launches = getSessionLaunches(getLayout()).slice(launchesBefore);
    assert.equal(launches.length, 1, 'one new process for the message: the resume was refused before any launch');
    topicProcessPid = launches[0].pid;
    const freshSessionId = getLaunchSessionId(launches[0].argv);
    assert.ok(freshSessionId && freshSessionId !== lostSessionId, 'a new conversation under a new id, not a silent start under the lost one');
    assert.equal(listConversationLostNotices().length, noticesBefore + 1, 'the topic is told once that the conversation is gone');
    assert.deepEqual(listTopicErrors(), [], 'the topic hears no error');
  });

  it('a session started and left alone has no transcript: when its agent is gone, the next message wakes it silently under the SAME id — nothing was lost, so no notice', async () => {
    await silentTopic.sendAndAwaitReply(`/bind ${silentFolder}`, `Bound to \`${silentFolder}\``);
    await silentTopic.sendAndAwaitReply('/verbosity stream_answers', 'This topic shows: Stream + answers');
    await silentTopic.sendAndAwaitReply('/claude', 'ready in');
    const launch = getSessionLaunches(getLayout()).at(-1);
    const silentSessionId = (launch && getLaunchSessionId(launch.argv)) ?? '';
    assert.ok(launch && silentSessionId, 'the topic\'s agent runs on a conversation id');
    const silentTranscriptPath = getFakeClaudeTranscriptPath({ homeDir: getLayout().instanceHome, workDir: path.join(getLayout().workRoot, silentFolder), sessionId: silentSessionId });
    await restartWith((persisted) => {
      process.kill(launch.pid, 'SIGKILL'); // the agent is gone while the bot is down; the saved state still names its conversation
      assert.equal(persisted.agents?.[`${group.id}:${silentTopicThreadId}`]?.claudeSessionId, silentSessionId, 'the saved state names the conversation');
    });
    assert.equal(await readClaudeTranscriptContent(silentTranscriptPath), 'absent', 'precondition: it never took a turn, so there is no file');
    const launchesBefore = getSessionLaunches(getLayout()).length;
    fakeTelegram.pushOperatorMessage(silentTopicThreadId, 'NEVER-1 [fake:answer] anyone there?');
    await silentTopic.waitForMessage('the agent\'s answer', (message) => message.text.includes('Fake final answer for NEVER-1'));
    const launches = getSessionLaunches(getLayout()).slice(launchesBefore);
    assert.equal(launches.length, 1, 'one new process for the message');
    assert.deepEqual([getFlagValues(launches[0].argv, '--resume'), getFlagValues(launches[0].argv, '--session-id')], [[], [silentSessionId]], 'started under the same id, nothing to resume');
    assert.deepEqual(listConversationLostNotices(silentTopic), [], 'no notice: there never was a conversation');
  });

  it('an agent that ignores the stop signals is killed after the bounded wait, and only then is the replacement launched: never two agents on one conversation', async () => {
    assert.ok(topicProcessPid !== 0 && checkIsPidAlive(topicProcessPid), 'the topic\'s agent runs');
    const ignoreFile = path.join(getLayout().fakeStateDir, fakeClaudeIgnoreStopSignalsFileName);
    const board = await openLimitsBoard(fakeTelegram, topic, topicThreadId);
    const launchesBefore = getSessionLaunches(getLayout()).length;
    const outputBefore = getCharness().output.length;
    fs.writeFileSync(ignoreFile, '');
    try {
      const startedAt = Date.now();
      await topic.tapAndAwaitAnswer(board.message, board.rowData(`Claude · ${secondAccount}`));
      assert.ok(Date.now() - startedAt >= stopWaitMs - 500, 'the bot waited out its bounded wait before it gave up on the stop signals');
      await getCharness().waitFor('the replacement to be launched under the second account', respawnTimeoutMs, () => getSessionLaunches(getLayout()).length > launchesBefore);
      assert.equal(checkIsPidAlive(topicProcessPid), false, 'the process that ignored the signals was killed');
      assert.ok(getCharness().output.slice(outputBefore).includes(`process ${topicProcessPid} was still running`), 'the bot said it had to kill it');
      assert.deepEqual(
        getSessionLaunches(getLayout()).filter((launch) => launch.overlapsPid != null).map((launch) => launch.pid),
        [],
        'the replacement started with the old process gone',
      );
    } finally {
      fs.rmSync(ignoreFile, { force: true });
      if (checkIsPidAlive(topicProcessPid)) process.kill(topicProcessPid, 'SIGKILL');
    }
  });
});
