/**
 * @description Lifecycle safety L1 of the accounts note, at PROCESS level: the BUILT charness started the way an isolated instance is
 * (`scripts/run-isolated.sh`) against the fake Bot API of `telegramE2e/fakeTelegram.ts`, with the fake `claude` as the agent and the idle
 * window cut to seconds (`AGENT_IDLE_MINUTES`). A note is a passenger, never a cause: a conversation that gets accounts notes — one at
 * its turn start, one read inside a running turn, one carried by a send tool's result — must go idle exactly like the same conversation
 * that gets none. Two topics run the SAME turns on the same account; only the first is an orchestrating conversation (its note record
 * is seeded while the bot is down), the second is the control:
 *
 *   boot → two topics are bound, a signed-in account «work» is seeded, the first topic is made an orchestrator
 *   → a warm-up turn in each fills the usage cache (a note needs a fresh figure; the bot's own poller finds no sign-in)
 *   → turn 1: the first topic's prompt carries the reminder, the control's does not
 *   → turn 2 (long, with a late tool call): the reminder comes due while it works — the engine writes the topic's inbox and the
 *     `PostToolUse` hook gives it to the agent with that tool's result; the control's hook gives nothing
 *   → turn 3: the figures changed; the agent sends a message and the TOOL RESULT carries the «changed» summary — the control's does not
 *   → both topics sit idle: each is compacted and stopped at the idle mark, at the same distance from its last turn's end; neither
 *     was found «working» at the mark, neither holds a held mark; no process was woken or started for a note; the topic never shows one
 *   → L5: the reminder comes due while both sessions sleep: nothing is started or posted; the next person's prompt carries it
 *
 * The idle fire is read from the fake Telegram's own store times (`createdAtMs`), never the test's polling. Nothing leaves the machine.
 * The unit-level readers (the engine's poll, the sectioned inbox, the real json-stream adapter's busy / unconsumed-input state) are
 * `limitNotesEngine.test.ts`, `midTurnInbox.test.ts` and `limitNotesMergedInput.test.ts`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram, type FakeTelegramMessage } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import { fakeClaudeLogFileNames, fakeClaudeUsageWindowsFileName, type FakeClaudePrompt, type FakeClaudeUsageWindows } from './jiraE2e/fakeClaudeContract';
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
import { getAllAgentTurns, getSessionLaunches, readPersistedState, restartCharnessWithState, startCharnessOnInstance } from './e2e/fallbackFlowKit';
import { enDict } from '../i18n/en';
import type { LimitNoteRecord } from '../limitNotes/plan';
import { createClaudeProfileLayout } from '../utils/claudeProfiles';
import { checkIsPidAlive } from '../utils/jsonStreamHost';
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const noteThreadId = 111;
const controlThreadId = 112;
const noteTopicKey = `${group.id}:${noteThreadId}`;
const controlTopicKey = `${group.id}:${controlThreadId}`;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const noteFolder = 'notes-on';
const controlFolder = 'notes-off';
const accountName = 'work';

/** The idle window, cut to seconds. */
const idleWindowMinutes = '0.2';
const idleWindowMs = 12 * 1000;
/** The reminder interval the flow runs with: long enough that turn 2 STARTS before the reminder is due, short enough to come due inside it. */
const reminderIntervalMs = 8 * 1000;
/** How often the engine looks at the sessions. */
const enginePollMs = 200;
/** The least time between two notes, cut so turn 3's summary may follow turn 2's reminder at once. */
const summaryFloorMs = 500;
const replyTimeoutMs = 30 * 1000;
const agentStartTimeoutMs = 60 * 1000;
/** Turn 2: busy and silent, then ONE late tool call — the reminder (due 8 s after turn 1's start) is written in between, the hook reads it at the call. */
const longTurnWorkMs = 4 * 1000;
const longTurnToolAfterMs = 4 * 1000;
/** The idle mark, the compaction it makes and the stop, with room for a loaded box. */
const idleStopTimeoutMs = 90 * 1000;
/** How far apart the two topics' idle fires may be measured from their own last answers: a load jitter, never a held or re-armed mark (that is the whole window). */
const idleSkewToleranceMs = 4 * 1000;

const reminderRe = /\[Accounts · \d{2}:\d{2}\]/;
const summaryRe = /\[Accounts · \d{2}:\d{2} · changed\]/;

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let noteTopic: TopicDriver;
let controlTopic: TopicDriver;
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

function listPrompts(): FakeClaudePrompt[] {
  return readJsonLines<FakeClaudePrompt>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.prompts));
}

interface HookRecord { issueKey: string; pid: number; sessionId: string; additionalContext: string }

function listHookReads(): HookRecord[] {
  return readJsonLines<HookRecord>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.hooks));
}

interface ToolCallRecord { issueKey: string; tool: string; outcome: string }

function listToolCalls(): ToolCallRecord[] {
  return readJsonLines<ToolCallRecord>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.toolCalls));
}

const hoursAhead = (hours: number): string => new Date(Date.now() + hours * 3_600_000).toISOString();

function writeUsageWindows(weeklyPercent: number): void {
  const windows: FakeClaudeUsageWindows = { [accountName]: { sessionPercent: 30, sessionResetsAt: hoursAhead(3), weeklyPercent, weeklyResetsAt: hoursAhead(72) } };
  fs.writeFileSync(path.join(getLayout().fakeStateDir, fakeClaudeUsageWindowsFileName), JSON.stringify(windows));
}

/** Whether the account's figures reached the bot from an agent's frame and are fresh. */
function checkIsUsageFresh(): boolean {
  const usage = readPersistedState(getLayout()).claudeProfiles?.[accountName]?.usage;
  return usage?.source === 'stream' && usage.isStale !== true;
}

/** The orchestrating topic's note record as the bot saved it (`state.json` `limitNotes`). */
function readNoteRecord(): LimitNoteRecord | undefined {
  return readPersistedState(getLayout()).limitNotes?.[noteTopicKey];
}

/** How many turns the agents ran for `label`. */
function countTurns(label: string): number {
  return getAllAgentTurns(getLayout()).filter((turn) => turn.issueKey === label).length;
}

/** What the fake agent of a topic read as the user message labelled `label`. */
function getPromptText(label: string): string {
  const prompt = listPrompts().find((candidate) => candidate.text.includes(`${label} `));
  assert.ok(prompt, `the agent read ${label}`);
  return prompt.text;
}

async function sendBoth(text: (name: 'NOTE' | 'CTRL') => string): Promise<void> {
  fakeTelegram.pushOperatorMessage(noteThreadId, text('NOTE'));
  fakeTelegram.pushOperatorMessage(controlThreadId, text('CTRL'));
}

async function waitForAnswers(label: number): Promise<{ note: FakeTelegramMessage; control: FakeTelegramMessage }> {
  const note = await noteTopic.waitForMessage(`the answer to NOTE-${label}`, (message) => message.text.includes(`Fake final answer for NOTE-${label}`));
  const control = await controlTopic.waitForMessage(`the answer to CTRL-${label}`, (message) => message.text.includes(`Fake final answer for CTRL-${label}`));
  return { note, control };
}

const idleNoticeStart = enDict['compactOnIdle.notice'].split('\n')[0];
const stopLine = (topicKey: string): string => `[compact-on-idle] ${topicKey} process stopped; the session sleeps`;

function getIdleNotice(topic: TopicDriver): FakeTelegramMessage | undefined {
  return topic.listMessages().find((message) => message.text.startsWith(idleNoticeStart));
}

describe('An accounts note is a passenger, never a cause, end to end: built charness, fake Bot API, fake agent', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-limitnote-', [noteFolder, controlFolder], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fs.mkdirSync(layout.fakeStateDir, { recursive: true });
    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    noteTopic = new TopicDriver(fakeTelegram, getCharness, noteThreadId, replyTimeoutMs);
    controlTopic = new TopicDriver(fakeTelegram, getCharness, controlThreadId, replyTimeoutMs);
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
      AGENT_IDLE_MINUTES: idleWindowMinutes,
      // A free port nothing listens on: the boot's OpenCode pre-start finds no server and no binary, and gives up.
      OPENCODE_URL: `http://127.0.0.1:${await getUnservedPort()}`,
      SCHEDULER_MCP_PORT: (await getFreeFixedPort()).toString(),
      ...getTelegramFlowTestTimingsEnv({ limitReminderIntervalMs: reminderIntervalMs, limitNoteEnginePollMs: enginePollMs, limitNoteSummaryFloorMs: summaryFloorMs }),
    });
    writeUsageWindows(10);
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

  it('boots, binds two topics, seeds a signed-in account and makes the first topic an orchestrating conversation', async () => {
    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    for (const [topic, folder] of [[noteTopic, noteFolder], [controlTopic, controlFolder]] as const) {
      await topic.sendAndAwaitReply(`/bind ${folder}`, `Bound to \`${folder}\``);
      await topic.sendAndAwaitReply('/verbosity stream_answers', 'This topic shows: Stream + answers');
    }
    createClaudeProfileLayout({ dataDir: getLayout().dataDir, name: accountName, homeClaudeDir: path.join(getLayout().instanceHome, '.claude') });
    charness = await restartCharnessWithState(getLayout(), fakeTelegram, getCharness(), (persisted) => {
      persisted.claudeProfiles = {
        ...persisted.claudeProfiles,
        [accountName]: { createdAt: new Date().toISOString(), loggedIn: true, email: 'work@example.com', subscriptionType: 'max' },
      };
      // Both topics run on the one account whose figures the fake reports; only the first has ever looked at the limits.
      persisted.claudeProfileOverrides = { ...persisted.claudeProfileOverrides, [noteTopicKey]: accountName, [controlTopicKey]: accountName };
      persisted.limitNotes = { [noteTopicKey]: { lastOrchestratedAt: Date.now() } };
    });
  });

  it('a warm-up turn in each topic fills the usage cache; a conversation with no fresh figure gets no note', async () => {
    await noteTopic.sendAndAwaitReply('/claude', 'ready in');
    await controlTopic.sendAndAwaitReply('/claude', 'ready in');
    fakeTelegram.pushOperatorMessage(noteThreadId, 'NOTE-0 [fake:answer] warm up');
    fakeTelegram.pushOperatorMessage(controlThreadId, 'CTRL-0 [fake:answer] warm up');
    await waitForAnswers(0);
    await getCharness().waitFor('the account\'s figures to reach the bot from the agents\' frames', agentStartTimeoutMs, checkIsUsageFresh);
    assert.doesNotMatch(getPromptText('NOTE-0'), reminderRe, 'nothing fresh was known when the warm-up prompt was written: no note');
  });

  it('turn 1: the orchestrating topic\'s prompt carries the reminder, as its last block; the control\'s prompt carries none', async () => {
    await sendBoth((name) => `${name}-1 [fake:answer] [work-ms:1500] first turn`);
    await waitForAnswers(1);
    const noteText = getPromptText('NOTE-1');
    assert.match(noteText, reminderRe, 'the reminder rides the prompt');
    assert.ok(noteText.indexOf('first turn') < noteText.search(reminderRe), 'after the person\'s words');
    assert.doesNotMatch(getPromptText('CTRL-1'), /\[Accounts/);
    assert.equal(noteTopic.listMessages().some((message) => message.text.includes('[Accounts')), false, 'the topic never shows a note');
    assert.equal(typeof readNoteRecord()?.lastNoteAt, 'number', 'the prompt reached the agent: the note is recorded as delivered');
  });

  it('turn 2: the reminder comes due while the turn works — the engine writes the inbox and the PostToolUse hook gives it to the agent; the control\'s hook gives nothing; no process was started for it', async () => {
    const launchesBefore = getSessionLaunches(getLayout()).length;
    await sendBoth((name) => `${name}-2 [fake:answer] [work-ms:${longTurnWorkMs}] [tool-after-ms:${longTurnToolAfterMs}] second turn, long`);
    await waitForAnswers(2);
    const reads = listHookReads();
    const noteReads = reads.filter((read) => reminderRe.test(read.additionalContext));
    assert.equal(noteReads.length, 1, `exactly one tool call read the reminder: ${JSON.stringify(reads)}`);
    assert.equal(noteReads[0].issueKey, 'NOTE-2');
    assert.equal(reads.some((read) => read.issueKey === 'CTRL-2'), false, 'the control\'s tool call read nothing');
    assert.doesNotMatch(getPromptText('NOTE-2'), /\[Accounts/, 'turn 2 started inside the interval: its prompt carried none — the note came through the hook');
    assert.equal(getSessionLaunches(getLayout()).length, launchesBefore, 'no process was started for a note');
    await getCharness().waitFor('the note recorded as delivered once the hook took it', replyTimeoutMs, () => {
      const lastNoteAt = readNoteRecord()?.lastNoteAt;
      return lastNoteAt !== undefined && Date.now() - lastNoteAt < 60 * 1000;
    });
    assert.deepEqual(fs.readdirSync(path.join(getLayout().dataDir, 'todos', 'inbox')), [], 'the inbox dir is empty again');
  });

  it('turn 3: the figures changed; the send tool\'s result carries the «changed» summary for the orchestrating topic — and nothing for the control', async () => {
    // The summary rides the FIRST send tool's result after the picture changed — `answer_request` is one too. A turn that still owes
    // answers to earlier requests (the topic shows an answer's streamed text before its `answer_request(final)` lands, so on a loaded box
    // turn 3's message can arrive while turn 0–2's requests are open) answers those first, and the summary goes to one of THOSE results
    // (measured: a run in six, `answer_request` «had just been closed» took it). So the precondition is explicit: every earlier request
    // is closed before turn 3 starts, and turn 3's first send tool is the digest.
    const earlierLabels = ['NOTE-0', 'NOTE-1', 'NOTE-2', 'CTRL-0', 'CTRL-1', 'CTRL-2'];
    await getCharness().waitFor('every earlier request to be answered final', replyTimeoutMs, () => {
      const finals = readJsonLines<{ issueKey: string; kind: string }>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.answers)).filter((answer) => answer.kind === 'final');
      return earlierLabels.every((label) => finals.some((answer) => answer.issueKey === label));
    });
    writeUsageWindows(62);
    await sendBoth((name) => `${name}-3 [fake:send-messages] third turn`);
    await waitForAnswers(3);
    assert.doesNotMatch(getPromptText('NOTE-3'), /It replaces the same requester's earlier requests/, 'precondition: turn 3 supersedes no earlier request, so no answer of its own comes before the digest');
    const noteResult = listToolCalls().find((call) => call.issueKey === 'NOTE-3' && call.tool === 'send_messages_to_user');
    const controlResult = listToolCalls().find((call) => call.issueKey === 'CTRL-3' && call.tool === 'send_messages_to_user');
    assert.ok(noteResult && controlResult, `both agents called the send tool: ${JSON.stringify(listToolCalls())}`);
    assert.match(noteResult.outcome, summaryRe);
    assert.doesNotMatch(controlResult.outcome, /\[Accounts/);
    assert.equal(noteTopic.listMessages().some((message) => message.text.includes('[Accounts')), false, 'the topic never shows it');
  });

  it('L1: both topics go idle the same way — compacted and stopped at the idle mark, neither found «working», no held mark, no process woken', async () => {
    const pids = [...new Set(getAllAgentTurns(getLayout()).map((turn) => turn.pid))];
    assert.ok(pids.every((pid) => checkIsPidAlive(pid)), 'both processes are up before the idle mark');
    await getCharness().waitFor('both idle stops', idleStopTimeoutMs, () => getCharness().output.includes(stopLine(noteTopicKey)) && getCharness().output.includes(stopLine(controlTopicKey)));
    const output = getCharness().output;
    for (const topicKey of [noteTopicKey, controlTopicKey]) {
      assert.ok(!output.includes(`${topicKey} timer fired but the compaction is skipped: working`), `the idle fire of ${topicKey} never took the process for working`);
    }
    const tracking = readPersistedState(getLayout()).compactIdleTracking;
    for (const topicKey of [noteTopicKey, controlTopicKey]) {
      assert.equal(tracking?.[topicKey]?.lastHeldMarkAt, undefined, `${topicKey} holds no held mark`);
    }
    const noteNotice = getIdleNotice(noteTopic);
    const controlNotice = getIdleNotice(controlTopic);
    assert.ok(noteNotice && controlNotice, 'both topics got the idle compaction notice');
    const { note: lastNoteAnswer, control: lastControlAnswer } = await waitForAnswers(3);
    const noteIdleMs = noteNotice.createdAtMs - lastNoteAnswer.createdAtMs;
    const controlIdleMs = controlNotice.createdAtMs - lastControlAnswer.createdAtMs;
    assert.ok(noteIdleMs >= idleWindowMs - 2000 && controlIdleMs >= idleWindowMs - 2000, `the mark came after the window, not before: ${noteIdleMs} / ${controlIdleMs} ms`);
    assert.ok(Math.abs(noteIdleMs - controlIdleMs) <= idleSkewToleranceMs, `the idle fire came at the same instant with and without notes: ${noteIdleMs} ms vs ${controlIdleMs} ms after the last answer`);
    assert.ok(noteIdleMs < idleWindowMs + 4 * idleSkewToleranceMs, `the note topic's mark was not pushed back by a re-armed countdown: ${noteIdleMs} ms`);
    assert.ok(pids.every((pid) => !checkIsPidAlive(pid)), 'both processes were stopped');
    assert.equal(getSessionLaunches(getLayout()).length, new Set(getSessionLaunches(getLayout()).map((launch) => launch.pid)).size, 'every launch is a distinct process: none was started again');
    assert.equal(countTurns('NOTE-3'), 1);
  });

  it('L5: a reminder that comes due while the sessions sleep wakes nothing — no process, no topic message — and the next person\'s prompt carries it', async () => {
    const launchesBefore = getSessionLaunches(getLayout()).length;
    const messageIdsBefore = new Set([...noteTopic.listMessages(), ...controlTopic.listMessages()].map((message) => message.message_id));
    // The reminder was due before the idle stop already; the engine polls a sleeping session several times meanwhile.
    await new Promise((resolve) => setTimeout(resolve, reminderIntervalMs + 5 * enginePollMs));
    assert.equal(getSessionLaunches(getLayout()).length, launchesBefore, 'no process was started for a note');
    // A message may be DELETED meanwhile (the stop's status frame): what must not happen is a new one.
    const newMessages = [...noteTopic.listMessages(), ...controlTopic.listMessages()].filter((message) => !messageIdsBefore.has(message.message_id));
    assert.deepEqual(newMessages.map((message) => message.text), [], 'nothing was posted to either topic');
    const inboxDir = path.join(getLayout().dataDir, 'todos', 'inbox');
    assert.deepEqual(fs.existsSync(inboxDir) ? fs.readdirSync(inboxDir) : [], [], 'no inbox file for a session that sleeps');

    await sendBoth((name) => `${name}-4 [fake:answer] back again`);
    await waitForAnswers(4);
    assert.match(getPromptText('NOTE-4'), reminderRe, 'the first prompt after the sleep carries the reminder that was due');
    assert.doesNotMatch(getPromptText('CTRL-4'), /\[Accounts/);
    assert.ok(getSessionLaunches(getLayout()).length > launchesBefore, 'the person\'s message woke the sessions');
  });
});
