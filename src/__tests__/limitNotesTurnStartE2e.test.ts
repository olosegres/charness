/**
 * @description The turn-start moments of the accounts note, at PROCESS level: the BUILT charness started the way an isolated instance is
 * (`scripts/run-isolated.sh`) against the fake Bot API of `telegramE2e/fakeTelegram.ts`, with the fake `claude` as the agent. One topic
 * on a signed-in account is an orchestrating conversation (its note record is seeded while the bot is down); the setting is the default
 * (1 h) and the figures the fake agent reports never move — what changes between the scenarios is what the note record says, which is
 * how the passing of time reaches the planner (`limitNotes/plan.ts`): the record's «last note» is made 70 or 40 minutes old, so a
 * flow proves the real windows without waiting them out. What the fake agent READ is the proof; the topic's history proves what it
 * never showed. Three scenarios of the plan, in order:
 *
 *   1. a fired check's wake — the agent arms a worker watch, the check fails, the scheduler wakes the agent: the wake prompt carries the
 *      reminder (the interval has never been spent: the agent has never been told), and the topic shows only the usual check line
 *   6. a person's message when the reminder AND the change summary are both due (the last note is 70 min old, its picture is not
 *      today's, the session has been quiet): ONLY the reminder comes
 *   9. a person's message when only the summary is due (the last note is 40 min old: no reminder yet; the picture changed; the session
 *      has been quiet): the prompt carries the «changed» summary and no reminder
 *
 * A fresh figure is a precondition of every note, and the bot's own poller finds no sign-in on a fake account (it marks the cache stale
 * at every boot), so after each restart a WARM-UP turn refills the cache from the agent's frame. Any person's message is a carrier, so
 * the topic's own setting is Off while it runs (seeded with the record): Off means no note at all, the summary included — the flow
 * checks that the seeded record survived the warm-up — and the flow then taps «As General» on the topic's picker, the way a person ends
 * an override. «Quiet» is the one window cut for the flow (`limitNoteQuietMs`, seconds): a wait longer than it can only make the
 * session quieter.
 *
 * The planner's every branch is `limitNotesPlan.test.ts`; the mid-turn and idle behaviour is `limitNotesMidTurnE2e.test.ts`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import { fakeCancelWatchToken, fakeClaudeLogFileNames, fakeWatchJobName } from './jiraE2e/fakeClaudeContract';
import {
  builtCliPath,
  createIsolatedInstanceLayout,
  exitOnSignal,
  getFlowDeadlineMs,
  getFreeFixedPort,
  getUnservedPort,
  IsolatedCharness,
  listTmuxSessions,
  readJsonLines,
  removeIsolatedInstanceSync,
  writeFakeClaudeLauncher,
  writeInstanceEnvFile,
  type IsolatedInstanceLayout,
} from './e2e/isolatedCharness';
import { readPersistedState, restartCharnessWithState, startCharnessOnInstance } from './e2e/fallbackFlowKit';
import { checkIsAccountUsageFresh, getFakePromptText, listFakePrompts, reminderNoteRe, summaryNoteRe, writeFakeUsageWindows } from './e2e/limitNotesFlowKit';
import type { LimitNoteRecord } from '../limitNotes/plan';
import { limitReminderOffMinutes } from '../limitNotes/reminderChoices';
import { createClaudeProfileLayout } from '../utils/claudeProfiles';
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';
import { claudeJsonStreamUsageLogPrefix } from '../adapters/claudeJsonStreamAdapter';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const threadId = 121;
const topicKey = `${group.id}:${threadId}`;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const folder = 'notes-turn-start';
const accountName = 'work';
/** The figure the fake agent reports on every turn; it never moves. */
const reportedWeeklyPercent = 10;
/** A picture no real figure can fingerprint to: a note's «changed» is measured against it. */
const stalePictureFingerprint = 'a-picture-the-agent-saw-long-ago';
const alertMark = `Check "${fakeWatchJobName}" fired`;
const anyNoteRe = /\[Accounts/;

const msPerMinute = 60 * 1000;
/** The reminder interval (1 h, the default) is spent 70 minutes after a note; 40 minutes after one it is not. */
const reminderSpentAgeMs = 70 * msPerMinute;
const reminderNotYetDueAgeMs = 40 * msPerMinute;
/** «Quiet», cut to seconds; the flow waits longer than it. */
const quietWindowMs = 3 * 1000;
const quietMarginMs = 2 * 1000;
/** A watch's cron is every minute (the production minimum is five): the check fires within it, then the wake. */
const watchCronIntervalMs = 60 * 1000;
const checkWakeTimeoutMs = 3 * 60 * 1000;
const replyTimeoutMs = 30 * 1000;
const agentStartTimeoutMs = 60 * 1000;

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let topic: TopicDriver;
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

/** The topic's note record as the bot saved it (`state.json` `limitNotes`). */
function readNoteRecord(): LimitNoteRecord | undefined {
  return readPersistedState(getLayout()).limitNotes?.[topicKey];
}

/** The calls the fake agents made to the bot's tool `tool`. */
function listToolCalls(tool: string): { issueKey: string; tool: string; outcome: string }[] {
  return readJsonLines<{ issueKey: string; tool: string; outcome: string }>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.toolCalls)).filter((call) => call.tool === tool);
}

/** How many turns of the topic's agent have ended: the adapter logs one accounting line at each turn's end (the `result` frame). */
function countEndedTurns(): number {
  return getCharness().output.split('\n').filter((line) => line.startsWith(`${claudeJsonStreamUsageLogPrefix}${topicKey}:`)).length;
}

/** Stop the bot, rewrite the topic's note record and make the topic's own setting Off, start it again: how time passes for a conversation. */
async function restartWithNoteRecordAndNotesOff(record: LimitNoteRecord): Promise<void> {
  charness = await restartCharnessWithState(getLayout(), fakeTelegram, getCharness(), (persisted) => {
    persisted.limitNotes = { [topicKey]: record };
    persisted.limitRemindersOverrides = { ...persisted.limitRemindersOverrides, [topicKey]: limitReminderOffMinutes };
  });
  // The bot's boot poll of the account's usage finds no sign-in on a fake account and marks the cache stale — a moment after boot, and
  // on a loaded box AFTER a frame that came first, which it would then undo. Wait for it: the next poll is ten minutes away.
  await getCharness().waitFor('the boot poll of the usage cache', agentStartTimeoutMs, () => readPersistedState(getLayout()).claudeProfiles?.[accountName]?.usage?.isStale === true);
}

/** The person taps «As General» on the topic's picker: its own choice is dropped, General's default (1 h) applies again. */
async function tapAsGeneralOnTopicPicker(): Promise<void> {
  const picker = await topic.sendAndAwaitReply('/limits_reminders', 'Limit reminders to agents — this topic');
  await topic.tapAndAwaitAnswer(picker, 'lrm_g');
  await topic.waitForMessageText('the picker to turn into its confirmation', picker, (text) => text.startsWith('🔔 Limit reminders:'));
  await getCharness().waitFor('the topic\'s own choice to be dropped', replyTimeoutMs, () => readPersistedState(getLayout()).limitRemindersOverrides?.[topicKey] === undefined);
}

/**
 * Refill the usage cache from an agent frame while the topic's notes are Off, then give the topic back to General and wait for the
 * session to be quiet. Resolves when the flow may send the scenario's message.
 */
async function warmUpUsageCache(label: string): Promise<void> {
  const recordBefore = readNoteRecord();
  const endedTurnsBefore = countEndedTurns();
  fakeTelegram.pushOperatorMessage(threadId, `${label} [fake:answer] warm up the usage cache`);
  await topic.waitForMessage(`the answer to ${label}`, (message) => message.text.includes(`Fake final answer for ${label}`));
  await getCharness().waitFor(`the end of the warm-up turn ${label}`, agentStartTimeoutMs, () => countEndedTurns() > endedTurnsBefore);
  await getCharness().waitFor('the account\'s figures to reach the bot from the agent\'s frame', agentStartTimeoutMs, () => checkIsAccountUsageFresh(getLayout(), accountName));
  assert.deepEqual(readNoteRecord(), recordBefore, 'Off: the warm-up took no note and consumed no summary — the seeded record is as it was');
  await tapAsGeneralOnTopicPicker();
  await new Promise((resolve) => setTimeout(resolve, quietWindowMs + quietMarginMs));
}

/** The person's message `label`, answered by the fake agent; resolves what the agent read. */
async function runPersonTurn(label: string): Promise<string> {
  const endedTurnsBefore = countEndedTurns();
  fakeTelegram.pushOperatorMessage(threadId, `${label} [fake:answer] a message from the person`);
  await topic.waitForMessage(`the answer to ${label}`, (message) => message.text.includes(`Fake final answer for ${label}`));
  // The topic showing the answer is not the turn's end: a restart now would cut the agent's `answer_request` call off before its result
  // came, the fake agent would wait for that result for good and every later message would queue behind it. The accounting line is the end.
  await getCharness().waitFor(`the end of the turn ${label}`, agentStartTimeoutMs, () => countEndedTurns() > endedTurnsBefore);
  return getFakePromptText(getLayout(), label);
}

function listTopicNoteMessages(): string[] {
  return topic.listMessages().map((message) => message.text).filter((text) => text.includes('[Accounts'));
}

describe('The accounts note at a turn start, end to end: built charness, fake Bot API, fake agent', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-limitnote-start-', [folder], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fs.mkdirSync(layout.fakeStateDir, { recursive: true });
    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    topic = new TopicDriver(fakeTelegram, getCharness, threadId, replyTimeoutMs);
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
      OPENCODE_URL: `http://127.0.0.1:${await getUnservedPort()}`,
      SCHEDULER_MCP_PORT: (await getFreeFixedPort()).toString(),
      ...getTelegramFlowTestTimingsEnv({ limitNoteQuietMs: quietWindowMs, scheduleMinFireIntervalMs: watchCronIntervalMs }),
    });
    writeFakeUsageWindows(getLayout(), accountName, reportedWeeklyPercent);
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

  it('boots, binds the topic, seeds a signed-in account and makes the topic an orchestrating conversation that was never told anything', async () => {
    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    await topic.sendAndAwaitReply(`/bind ${folder}`, `Bound to \`${folder}\``);
    await topic.sendAndAwaitReply('/verbosity stream_answers', 'This topic shows: Stream + answers');
    createClaudeProfileLayout({ dataDir: getLayout().dataDir, name: accountName, homeClaudeDir: path.join(getLayout().instanceHome, '.claude') });
    charness = await restartCharnessWithState(getLayout(), fakeTelegram, getCharness(), (persisted) => {
      persisted.claudeProfiles = {
        ...persisted.claudeProfiles,
        [accountName]: { createdAt: new Date().toISOString(), loggedIn: true, email: 'work@example.com', subscriptionType: 'max' },
      };
      persisted.claudeProfileOverrides = { ...persisted.claudeProfileOverrides, [topicKey]: accountName };
      persisted.limitNotes = { [topicKey]: { lastOrchestratedAt: Date.now() } };
    });
    await topic.sendAndAwaitReply('/claude', 'ready in');
  });

  it('1. a fired check\'s wake carries the reminder; the topic shows only the usual check line', async () => {
    // The arming turn is the conversation's FIRST: nothing is known of the usage yet, so its prompt takes no note, and in the `stream`
    // view (no request) it calls no send tool that could take one. Its frame fills the usage cache, so the wake (a minute or so later)
    // finds a fresh figure and an agent that was never told anything.
    await topic.sendAndAwaitReply('/verbosity stream', 'This topic shows:');
    fakeTelegram.pushOperatorMessage(threadId, 'W-1 [fake:arm-watch] watch the worker you just launched');
    await getCharness().waitFor('the agent to arm the watch', agentStartTimeoutMs, () => listToolCalls('schedule_create').length === 1);
    assert.doesNotMatch(getFakePromptText(getLayout(), 'W-1'), anyNoteRe, 'nothing was known of the usage at the first prompt: no note');
    assert.equal(readNoteRecord()?.lastNoteAt, undefined, 'the agent has still been told nothing');

    await getCharness().waitFor('the check\'s wake to reach the agent', checkWakeTimeoutMs, () => listFakePrompts(getLayout()).some((prompt) => prompt.text.includes(fakeCancelWatchToken)));
    const wake = listFakePrompts(getLayout()).find((prompt) => prompt.text.includes(fakeCancelWatchToken));
    assert.ok(wake);
    assert.match(wake.text, reminderNoteRe, 'the wake prompt carries the reminder');
    assert.doesNotMatch(wake.text, summaryNoteRe, 'the reminder, not the summary');
    assert.ok(wake.text.indexOf(fakeCancelWatchToken) < wake.text.search(reminderNoteRe), 'the note follows the watch\'s own words');

    await getCharness().waitFor('the wake to be handled: the watch cancelled', agentStartTimeoutMs, () => listToolCalls('schedule_cancel').length === 1);
    assert.ok(topic.listMessages().some((message) => message.text.includes(alertMark)), 'the topic shows the usual check line');
    assert.deepEqual(listTopicNoteMessages(), [], 'the topic never shows a note');
    assert.equal(typeof readNoteRecord()?.lastNoteAt, 'number', 'the wake reached the agent: the note is recorded as delivered');
    await topic.sendAndAwaitReply('/verbosity stream_answers', 'This topic shows: Stream + answers');
  });

  it('6. a person\'s message when the reminder and the change summary are both due carries only the reminder', async () => {
    const seeded: LimitNoteRecord = { lastOrchestratedAt: Date.now(), lastNoteAt: Date.now() - reminderSpentAgeMs, fingerprint: stalePictureFingerprint };
    await restartWithNoteRecordAndNotesOff(seeded);
    await warmUpUsageCache('WARM-6');
    const promptText = await runPersonTurn('NOTE-6');
    assert.match(promptText, reminderNoteRe, 'the interval is spent: the reminder is due');
    assert.doesNotMatch(promptText, summaryNoteRe, 'both were due: the reminder comes alone');
    assert.ok(promptText.indexOf('a message from the person') < promptText.search(reminderNoteRe), 'after the person\'s words');
    const record = readNoteRecord();
    assert.notEqual(record?.fingerprint, stalePictureFingerprint, 'the note recorded the picture it showed');
    assert.ok((record?.lastNoteAt ?? 0) > (seeded.lastNoteAt ?? 0) + reminderSpentAgeMs / 2, 'the reminder clock restarted');
    assert.deepEqual(listTopicNoteMessages(), [], 'the topic never shows a note');
  });

  it('9. a person\'s message after quiet, when only the change summary is due, carries the summary and no reminder', async () => {
    const seeded: LimitNoteRecord = { lastOrchestratedAt: Date.now(), lastNoteAt: Date.now() - reminderNotYetDueAgeMs, fingerprint: stalePictureFingerprint };
    await restartWithNoteRecordAndNotesOff(seeded);
    await warmUpUsageCache('WARM-9');
    const promptText = await runPersonTurn('NOTE-9');
    assert.match(promptText, summaryNoteRe, 'the picture changed and the session was quiet: the summary');
    assert.doesNotMatch(promptText, reminderNoteRe, 'the reminder is not due yet (40 min of 60)');
    assert.ok(promptText.indexOf('a message from the person') < promptText.search(summaryNoteRe), 'after the person\'s words');
    assert.notEqual(readNoteRecord()?.fingerprint, stalePictureFingerprint, 'the summary recorded the picture it showed');
    assert.deepEqual(listTopicNoteMessages(), [], 'the topic never shows a note');
  });
});
