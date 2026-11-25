/**
 * @description The status mark at the END of a topic's name at PROCESS level: the BUILT charness started the way an isolated instance
 * is (`scripts/run-isolated.sh`) against the fake Bot API (`telegramE2e/fakeTelegram.ts`, which now answers `editForumTopic`, echoes the
 * bot's own «renamed» line and refuses any rename that carries an icon), with the fake `claude` (`jiraE2e/fakeClaude.ts`) as the agent.
 * The settle time, the gap between two renames, the sweep and the boot wave are cut to seconds (`CHARNESS_TEST_TIMINGS`). One flow, in
 * order:
 *
 *   boot → a topic «Deploy» is created by the owner, bound, its agent started: the name takes 🟢 once it has held the settle time — the
 *     NAME only (never an icon), the bot's own «renamed» line deleted at once, the stored own name still «Deploy»
 *   → a question: ❓ at once, inside the gap since the last rename; answered: ❓ goes at once; a question set aside keeps the mark and
 *     its late answer takes it off
 *   → a turn that runs on: ⏳ after the settle time, 🟢 when it ends
 *   → the owner renames the topic: around the bot's mark («Deploy v2 🟢») the base is «Deploy v2»; a mark of his own at the end
 *     («Release 🟢») is dropped from the base and told once by the picker; a plain name takes the mark back; a name cut to the limit
 *     saved unchanged keeps the whole stored base
 *   → counts off by default; `/topic_status` switches them on: `📋N` follows the published todo list, and a worker the agent watches
 *     makes the topic work (`⚙️1`) while its own agent rests, until the worker is gone
 *   → the per-turn backend: the process stops after every turn by design and the topic keeps its 🟢 until the next turn (⏳ while it
 *     runs, never 💤); a short reply that wakes it writes nothing (no ⏳ or 🟢 on the way)
 *   → the agent is logged out: ❗️ until it works again; a usage-limit wait with nowhere to switch to: ❗️, leaving it when the wait ends
 *     by itself; a crashed agent: ❗️ until its next turn
 *   → a name Telegram does not keep (the fake drops a trailing mark, as Telegram drops ✅): «not modified» for it is logged once, never believed
 *     and not asked again; a switch the owner touches asks once more, and the mark shows once Telegram keeps it
 *   → the same for an ask Telegram answers OK and keeps altered (the title was not the base): its «renamed» line carries the stored name, which
 *     becomes the belief — also when the line reaches the bot before the answer of its own call does (the fake holds that answer) —,
 *     and the ask is not repeated until the owner touches a switch
 *   → a topic that is unbound while its question waits gets the owner's name back and nothing after it
 *   → a topic whose own name the bot does not know is never renamed: the candidate (the name it was created with, carried by the root
 *     message of the owner's plain messages) is offered by the picker, General lists such topics, one tap names it and the mark appears
 *   → a mark turned off in a topic gives the owner's name back at once; «All off» in General does so for every topic
 *   → no right to manage topics: no rename, one log line, a hint; no right to delete: the renames go on and the lines stay
 *   → a restart renames nothing that is already right, and an owner's rename that waited meanwhile is learned BEFORE the boot's wave
 *     writes (the mark that leaves ❓ at boot is the one write that comes at once: it must carry the owner's NEW name)
 *   → a COLD start (the heartbeat is older than a minute) drops the updates that waited — but first reads the topic renames among them: an
 *     owner's rename made while the bot was down is learned and its mark written over HIS name; a stranger's rename is not taken (and the
 *     name goes back); the owner's plain message that waited is dropped as before
 *   → a restart with NOTHING waiting, while the fake holds the first long poll open as Telegram does: the mark that leaves ❓ is written
 *     seconds after the start, not after the 30 s the wait for a backlog that is not there could cost
 *   → the agent's own context names the owner's name, never one with a mark
 *
 * Nothing leaves the machine: the Bot API is on loopback and the agent is a fake. Everything the test starts is stopped in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram, generalTopicThreadId, type FakeTelegramMessage } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import { spawn, type ChildProcess } from 'child_process';
import {
  fakeAskQuestion,
  fakeClaudeApiErrorOnceFileName,
  fakeClaudeCrashOnPromptFileName,
  fakeClaudeLogFileNames,
  fakeStatusWatchTargetFileName,
  type FakeClaudePrompt,
  type FakeStatusWatchTarget,
} from './jiraE2e/fakeClaudeContract';
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
import { getSessionLaunches, getStatePath, readPersistedState, startCharnessOnInstance } from './e2e/fallbackFlowKit';
import { firstPollHoldMs } from '../connectors/telegram/firstUpdateBatchNote';
import { bindLeaveCurrentCallback } from '../connectors/telegram/bindPicker';
import { enDict } from '../i18n/en';
import { resetBufferMs } from '../apiErrorRetry';
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';
import { getLaunchSessionId } from './jiraE2e/fakeClaudeContract';
import type { BindingData } from '../state';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const projectFolder = 'proj';
const deployBase = 'Deploy';

/** The windows of the topic marks in this flow (production: 20 s, 60 s, 5 min, 5 s). The gap is the longest: it is what the ❓ edges must skip. */
const settleMs = 2500;
const gapMs = 5000;
const sweepMs = 3000;
const bootWaveDelayMs = 1000;
const questionSetAsideWaitMs = 3000;
/** How long a `[work-ms:…]` turn works in silence: longer than the gap and the settle time, so its ⏳ shows while it runs. */
const longTurnMs = gapMs + settleMs + 8000;

/** The watch of a worker runs every minute (the production minimum is five). */
const watchCronIntervalMs = 60 * 1000;
/** A check run: the next tick, plus the time a loaded machine needs to run it. */
const checkRunTimeoutMs = 2 * 60 * 1000;
/** How long the fake needs to see the stopped bot's last long poll close. */
const deadPollSettleMs = 1500;
const secondTopicThreadId = 222;
/** A heartbeat this old makes the next boot a cold start (the boot classifier's threshold is one minute). */
const coldStartDowntimeMs = 5 * 60 * 1000;
/** How long the fake holds a long poll when nothing arrives in the no-backlog restart: as long as Telegram (50 s), far over the first poll's hold. */
const productionLongPollHoldMs = 50 * 1000;
/** How soon after the start a mark leaving ❓ must be written when nothing waited: the first poll's hold and the boot wave, on a loaded box — far below the 30 s cap of the wait for a backlog. */
const noBacklogWriteDeadlineMs = firstPollHoldMs + 12 * 1000;
/** What Telegram drops from the end of a topic name (the old «finished» mark): the fake does the same all through the flow. */
const strippedByTelegramEnding = '✅';
/**
 * How long the fake holds the answer of the rename whose «renamed» line the step reads: the call is handled at once (its line is pushed to the
 * bot), only the answer waits — long enough for the bot to take the line first, far inside the 30 s the bot keeps an ask for its line.
 * Without it the order of the two is a race of two responses; the bot must judge the same in both, and this fixes the harder one.
 */
const lineBeforeAnswerHoldMs = 2500;
const strangerUser = { id: 909090, is_bot: false, first_name: 'Stranger' };
/** A reset this long ahead is the wait of the usage-limit step: longer than the ❗️ takes to show (settle time and gap), short enough for a flow. */
const usageLimitResetAheadMs = gapMs + settleMs + 8000;
const secondTopicCreatedName = 'Research';
const pickerTitle = 'Topic status in the topic list';

const replyTimeoutMs = 20 * 1000;
/**
 * How long an AGENT takes to start or to answer its first prompt after a resume: a process of its own in tmux, which on a box shared with other
 * suites (a load far above its cores starves even the bot's own 5 s status probes) takes far longer than a bot's reply — the bound the other flows
 * give an agent start (`fallbackFlowKit`), not `replyTimeoutMs`.
 */
const agentStartTimeoutMs = 60 * 1000;
/** A name that must wait out the settle time and the gap, with room for a loaded box. */
const renameTimeoutMs = gapMs + settleMs + 15 * 1000;
/** The wait of the usage-limit step: the reset, the bot's own buffer after it (production's, not timed), the resume and the mark's change after it, on a loaded box. */
const usageLimitTimeoutMs = usageLimitResetAheadMs + resetBufferMs + 2 * renameTimeoutMs;
/** How long a step that proves a rename did NOT happen watches: the gap and the settle time over, then some. */
const quietWatchMs = gapMs + settleMs + 3000;

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let topic: TopicDriver;
let general: TopicDriver;
let topicThreadId = 0;
let secondTopic: TopicDriver;
let defaultTmuxSessionsBefore: string[] = [];
let worker: ChildProcess | null = null;
/** Write the instance's env file with the boot wave's window set: a restart shortens it to make the wave come before the polling does. */
let writeEnvironment: (bootWaveDelay: number) => void = () => { throw new Error('the instance is not set up yet'); };

function getLayout(): IsolatedInstanceLayout {
  if (!layout) throw new Error('the instance layout is not created yet');
  return layout;
}

function getCharness(): IsolatedCharness {
  if (!charness) throw new Error('charness is not started yet');
  return charness;
}

function removeInstanceSync(): void {
  worker?.kill('SIGKILL');
  removeIsolatedInstanceSync(layout, charness);
}

/** The binding the bot keeps for a topic of the group, read from `state.json` (written a moment after the change). */
function readBinding(threadId: number): BindingData | undefined {
  return readPersistedState(getLayout()).bindings?.[`${group.id}:${threadId}`];
}

/** One `editForumTopic` call the bot made, in order. */
interface TopicRename {
  name: string;
  atMs: number;
  /** Whether the call carried anything but the topic and its name — an icon, say. */
  isNameOnly: boolean;
}

function listRenames(threadId: number): TopicRename[] {
  return fakeTelegram.listCalls('editForumTopic')
    .filter((call) => call.payload.message_thread_id === threadId)
    .map((call) => ({
      name: String(call.payload.name),
      atMs: call.receivedAtMs,
      isNameOnly: Object.keys(call.payload).every((field) => ['chat_id', 'message_thread_id', 'name'].includes(field)),
    }));
}

/** The names the topic was given, in order. */
function listRenamedTo(threadId: number): string[] {
  return listRenames(threadId).map((rename) => rename.name);
}

async function waitForTopicName(threadId: number, name: string, timeoutMs = renameTimeoutMs): Promise<void> {
  await getCharness().waitFor(`topic ${threadId} to be called «${name}» (it is «${fakeTelegram.getTopicName(threadId)}»)`, timeoutMs, () => fakeTelegram.getTopicName(threadId) === name);
}

/** Let the topic stay as it is for longer than the settle time and the gap, and say whether the bot renamed it meanwhile. */
async function watchForRenames(threadId: number, watchMs = quietWatchMs): Promise<string[]> {
  const renamesBefore = listRenames(threadId).length;
  await new Promise((resolve) => setTimeout(resolve, watchMs));
  return listRenamedTo(threadId).slice(renamesBefore);
}

/** Every «renamed the topic» line the fake made of the bot's own renames is gone from the topic (deleted by the bot). */
async function waitForOwnRenameLinesDeleted(): Promise<void> {
  await getCharness().waitFor('every own «renamed» line to be deleted', replyTimeoutMs, () => fakeTelegram.ownRenameLineIds.every((messageId) => fakeTelegram.getMessage(messageId)?.isDeleted === true));
}

function getAgentPrompts(label: string): FakeClaudePrompt[] {
  return readJsonLines<FakeClaudePrompt>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.prompts)).filter((prompt) => prompt.text.includes(label));
}

/** The data of the button that answers `question` with its first option, whether it still waits (`qa_…`) or was set aside meanwhile (`qs_…`). */
function getFirstOptionData(question: FakeTelegramMessage): string {
  const current = fakeTelegram.getMessage(question.message_id);
  assert.ok(current && !current.isDeleted, `question ${question.message_id} is still in the topic`);
  const data = topic.getKeyboardData(current).flat().find((candidate) => candidate.startsWith('qa_') || candidate.startsWith('qs_'));
  assert.ok(data, 'the question has its option buttons');
  return data;
}

/** Wait, for as long as an agent start takes, for the bot message in `driver`'s topic that `check` accepts (newest first). */
async function waitForAgentMessage(driver: TopicDriver, description: string, check: (message: FakeTelegramMessage) => boolean): Promise<FakeTelegramMessage> {
  let found: FakeTelegramMessage | undefined;
  await getCharness().waitFor(description, agentStartTimeoutMs, () => {
    found = [...driver.listMessages()].reverse().find(check);
    return found !== undefined;
  });
  if (!found) throw new Error(`no message for ${description}`);
  return found;
}

/** The operator starts the Claude agent (`/claude`) in `driver`'s topic: resolves the bot's «ready in» reply. */
async function startAgent(driver: TopicDriver, threadId: number): Promise<FakeTelegramMessage> {
  const sentMessageId = fakeTelegram.pushOperatorMessage(threadId, '/claude');
  return waitForAgentMessage(driver, 'a reply to "/claude" with "ready in"', (message) => message.message_id > sentMessageId && message.text.includes('ready in'));
}

/** The operator puts a question (`[fake:ask]`) in `driver`'s topic: resolves its message once it carries the option buttons — the agent that asks it may have to be started first. */
async function askQuestion(label: string, driver: TopicDriver = topic, threadId: number = topicThreadId): Promise<FakeTelegramMessage> {
  const sentMessageId = fakeTelegram.pushOperatorMessage(threadId, `${label} [fake:ask] ask me something`);
  return waitForAgentMessage(driver, `the question of ${label}`, (candidate) =>
    candidate.message_id > sentMessageId && candidate.text.includes(fakeAskQuestion.question) && driver.getKeyboardData(candidate).flat().some((data) => data.startsWith('qa_')));
}


/**
 * The operator taps an option of `question` (the first, unless `data` names another button) and the step FAILS AT THE TAP when the bot
 * refuses it with «No pending question» — a refused tap shows only later, as a mark that never leaves, far from its cause. The button is
 * read from the message as it shows NOW: a question the wait has set aside carries the `qs_` buttons by then (or, for a moment, the old
 * ones, which the bot answers the same way).
 */
async function answerQuestion(question: FakeTelegramMessage, data: string = getFirstOptionData(question), driver: TopicDriver = topic): Promise<string> {
  const toast = await driver.tapAndAwaitAnswer(fakeTelegram.getMessage(question.message_id) ?? question, data);
  assert.notEqual(toast, enDict['cb.no_pending_question'], `the tap on ${data} of question ${question.message_id} was refused`);
  return toast;
}

/** The operator sets the question wait of `driver`'s topic from its picker: `qw_untilAnswered` (never set aside), `qw_same` (as in General). */
async function setQuestionWait(driver: TopicDriver, threadId: number, choiceData: string): Promise<void> {
  const sentMessageId = fakeTelegram.pushOperatorMessage(threadId, '/question_wait');
  const picker = await driver.waitForMessage('the question wait picker', (message) => message.message_id > sentMessageId && message.text.includes('How long the agent waits'));
  await driver.tapAndAwaitAnswer(picker, choiceData);
}

/** The operator opens `/topic_status` in `driver`'s topic: the picker's message. */
async function openPicker(driver: TopicDriver, threadId: number): Promise<FakeTelegramMessage> {
  const sentMessageId = fakeTelegram.pushOperatorMessage(threadId, '/topic_status');
  return driver.waitForMessage('the /topic_status picker', (message) => message.message_id > sentMessageId && message.text.startsWith(pickerTitle));
}

/** Tap a switch of the picker and wait until the picker was re-rendered by the tap (its text or keyboard changed). */
async function tapPicker(driver: TopicDriver, picker: FakeTelegramMessage, data: string): Promise<string> {
  const keyboardBefore = JSON.stringify(picker.reply_markup);
  const toast = await driver.tapAndAwaitAnswer(picker, data);
  await getCharness().waitFor(`the picker to be re-rendered after ${data}`, replyTimeoutMs, () => JSON.stringify(picker.reply_markup) !== keyboardBefore || toast !== '✅ Saved');
  return toast;
}

/** A name with every mark and count the bot may write, for a check that none was written. */
const anyCountPattern = /[⚙📋]/u;

/** The prompts the fake agent read, with the topic name the thread-context preamble of each carries. */
function listPreambleTopicNames(): string[] {
  return readJsonLines<FakeClaudePrompt>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.prompts))
    .flatMap((prompt) => [...prompt.text.matchAll(/topic: "([^"]*)"/g)].map((match) => match[1]));
}

describe('The status mark of topic names end to end: built charness, fake Bot API, fake agent', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-topicmark-', [projectFolder], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    fakeTelegram.isOwnTopicRenameDelivered = true;
    // As the live Telegram does (measured 2026-11-19): a trailing ✅ never shows. No mark of the bot may be one — every step below would see it.
    fakeTelegram.strippedTopicNameEndings = [strippedByTelegramEnding];
    general = new TopicDriver(fakeTelegram, getCharness, generalTopicThreadId, replyTimeoutMs);
    const apiRoot = await fakeTelegram.start();
    const environment = {
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
    };
    writeEnvironment = (bootWaveDelay) => writeInstanceEnvFile(getLayout(), {
      ...environment,
      ...getTelegramFlowTestTimingsEnv({
        topicIndicatorSettleMs: settleMs,
        topicIndicatorMinRenameGapMs: gapMs,
        topicIndicatorSweepMs: sweepMs,
        topicIndicatorBootWaveDelayMs: bootWaveDelay,
        questionSetAsideWaitMs,
        scheduleMinFireIntervalMs: watchCronIntervalMs,
      }),
    });
    writeEnvironment(bootWaveDelayMs);
  });

  after(async () => {
    worker?.kill('SIGKILL');
    await charness?.stop();
    removeInstanceSync();
    await fakeTelegram?.stop();
    process.off('exit', removeInstanceSync);
    process.off('SIGINT', exitOnSignal);
    process.off('SIGTERM', exitOnSignal);
    assert.deepEqual(listTmuxSessions([]), defaultTmuxSessionsBefore, 'the default tmux server was not touched');
  });

  it('boots; the owner\'s topic «Deploy» is bound and gets its agent: the name takes 🟢 after the settle time — the name only, the own «renamed» line deleted, the owner\'s name kept', async () => {
    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    topicThreadId = fakeTelegram.pushTopicCreated(deployBase);
    topic = new TopicDriver(fakeTelegram, getCharness, topicThreadId, replyTimeoutMs);
    await topic.waitForMessage('the welcome of the new topic', () => true);
    await topic.sendAndAwaitReply(`/bind ${projectFolder}`, `Bound to \`${projectFolder}\``);
    await getCharness().waitFor('the owner\'s name to be kept with the binding', replyTimeoutMs, () => readBinding(topicThreadId)?.topicName === deployBase);
    assert.deepEqual(listRenamedTo(topicThreadId), [], 'a topic without an agent keeps the owner\'s name: nothing is written');
    await startAgent(topic, topicThreadId);

    await waitForTopicName(topicThreadId, `${deployBase} 🟢`);
    assert.deepEqual(listRenamedTo(topicThreadId), [`${deployBase} 🟢`], 'one rename: the settle time held back every other name');
    assert.ok(listRenames(topicThreadId).every((rename) => rename.isNameOnly), 'the call carries the name and nothing else — never the icon');
    await waitForOwnRenameLinesDeleted();
    assert.equal(fakeTelegram.ownRenameLineIds.length, 1, 'the bot got its own «renamed» line once, and deleted it');
    assert.ok(!getCharness().output.includes('[security] forum_topic_edited'), 'the bot\'s own rename is no stranger\'s');
    await getCharness().waitFor('the applied name to be persisted', replyTimeoutMs, () => readBinding(topicThreadId)?.indicatorAppliedName === `${deployBase} 🟢`);
    assert.equal(readBinding(topicThreadId)?.topicName, deployBase, 'the stored name is the owner\'s own, never the one with the mark');
  });

  it('a question is marked ❓ AT ONCE — inside the gap since the last rename —, and the mark goes at once when it is answered', async () => {
    const lastRenameAtMs = listRenames(topicThreadId).at(-1)?.atMs ?? 0;
    const question = await askQuestion('Q-1');
    await waitForTopicName(topicThreadId, `${deployBase} ❓`);
    const questionRename = listRenames(topicThreadId).at(-1);
    assert.ok(questionRename);
    assert.ok(questionRename.atMs - lastRenameAtMs < gapMs, `precondition: the gap since the last rename (${questionRename.atMs - lastRenameAtMs} ms) had not ended — the edge skipped it`);

    const answerTapAtMs = Date.now();
    await answerQuestion(question);
    await getCharness().waitFor('the ❓ to be taken off', replyTimeoutMs, () => fakeTelegram.getTopicName(topicThreadId) !== `${deployBase} ❓`);
    const afterAnswer = listRenames(topicThreadId).at(-1);
    assert.ok(afterAnswer && afterAnswer.atMs - answerTapAtMs < gapMs, 'the answered question\'s mark went at once, not after the gap');
    // The turn ends; whatever the name showed in between, it settles on 🟢.
    await waitForTopicName(topicThreadId, `${deployBase} 🟢`);
  });

  it('a question set aside keeps the ❓ — it is still open in the topic —, and its late answer takes the mark off', async () => {
    const question = await askQuestion('Q-2');
    await waitForTopicName(topicThreadId, `${deployBase} ❓`);
    // The wait ends and the agent goes on: the question stays open as a set-aside record (its buttons now name the record).
    await getCharness().waitFor('the question to be set aside', renameTimeoutMs, () => readPersistedState(getLayout()).setAsideQuestions !== undefined && Object.keys(readPersistedState(getLayout()).setAsideQuestions ?? {}).length > 0);
    const keptRenames = await watchForRenames(topicThreadId, questionSetAsideWaitMs + gapMs);
    assert.ok(!keptRenames.some((name) => !name.endsWith('❓')), `the mark stays while the set-aside question is open: ${JSON.stringify(keptRenames)}`);
    assert.equal(fakeTelegram.getTopicName(topicThreadId), `${deployBase} ❓`);

    const current = fakeTelegram.getMessage(question.message_id);
    assert.ok(current);
    const lateAnswerData = topic.getKeyboardData(current).flat().find((data) => data.startsWith('qs_')) ?? '';
    assert.ok(lateAnswerData, 'the set-aside question has its buttons');
    await answerQuestion(current, lateAnswerData);
    await getCharness().waitFor('the ❓ to be taken off by the late answer', renameTimeoutMs, () => fakeTelegram.getTopicName(topicThreadId) !== `${deployBase} ❓`);
    await waitForTopicName(topicThreadId, `${deployBase} 🟢`);
  });

  it('a turn that runs on shows ⏳ after the settle time, and 🟢 when it ends', async () => {
    const renamesBefore = listRenamedTo(topicThreadId).length;
    fakeTelegram.pushOperatorMessage(topicThreadId, `LONG-1 [work-ms:${longTurnMs}] a long task`);
    await waitForTopicName(topicThreadId, `${deployBase} ⏳`);
    assert.deepEqual(listRenamedTo(topicThreadId).slice(renamesBefore), [`${deployBase} ⏳`], 'straight to ⏳');
    await waitForTopicName(topicThreadId, `${deployBase} 🟢`, renameTimeoutMs + longTurnMs);
    assert.ok(getAgentPrompts('LONG-1').length >= 1, 'the agent really took the long task');
  });

  it('the owner renames the topic: around the bot\'s mark the base is the new name, and the mark stays where it is', async () => {
    fakeTelegram.pushTopicRenamed(topicThreadId, `${deployBase} v2 🟢`);
    await getCharness().waitFor('the owner\'s new name', replyTimeoutMs, () => readBinding(topicThreadId)?.topicName === `${deployBase} v2`);
    assert.equal(readBinding(topicThreadId)?.indicatorAppliedName, `${deployBase} v2 🟢`, 'what the topic shows now is remembered as applied');
    const renames = await watchForRenames(topicThreadId);
    assert.deepEqual(renames, [], 'the name already carries the right mark: nothing is written over the owner\'s rename');
    assert.ok(!getCharness().output.includes('[security] forum_topic_edited'), 'the owner\'s rename is no stranger\'s');
  });

  it('a mark of his own at the end of the name — one the bot did not apply — is dropped from the base and told once by the picker', async () => {
    fakeTelegram.pushTopicRenamed(topicThreadId, 'Release 💤');
    await getCharness().waitFor('the base without the ending', replyTimeoutMs, () => readBinding(topicThreadId)?.topicName === 'Release');
    await getCharness().waitFor('the dropped mark to be kept', replyTimeoutMs, () => readBinding(topicThreadId)?.indicatorDroppedMark === '💤');
    const picker = await openPicker(topic, topicThreadId);
    assert.ok(picker.text.includes('«💤» at the end of your name reads as my mark'), picker.text);
    const second = await openPicker(topic, topicThreadId);
    assert.ok(!second.text.includes('at the end of your name reads as my mark'), 'told once');
    // The topic shows 🟢 in fact: the bot puts its own mark over the owner's after the settle time and the gap.
    await waitForTopicName(topicThreadId, 'Release 🟢');
  });

  it('a plain name takes the mark back after the settle time and the gap', async () => {
    fakeTelegram.pushTopicRenamed(topicThreadId, 'New');
    await getCharness().waitFor('the plain name as the base', replyTimeoutMs, () => readBinding(topicThreadId)?.topicName === 'New');
    await waitForTopicName(topicThreadId, 'New 🟢');
    // The agent is told the owner's name, not the one with the mark the topic shows now (the preamble rides on this prompt).
    const promptMessageId = fakeTelegram.pushOperatorMessage(topicThreadId, 'NAME-1 what is this topic called?');
    await topic.waitForMessage('the agent\'s answer', (message) => message.message_id > promptMessageId);
    assert.equal(fakeTelegram.getTopicName(topicThreadId), 'New 🟢');
  });

  it('a name cut to the limit saved unchanged keeps the whole stored base — the suffix is never cut, the base is', async () => {
    const longBase = `L${'x'.repeat(126)}`;
    fakeTelegram.pushTopicRenamed(topicThreadId, longBase);
    await getCharness().waitFor('the long base', replyTimeoutMs, () => readBinding(topicThreadId)?.topicName === longBase);
    await getCharness().waitFor('the cut name', renameTimeoutMs, () => (fakeTelegram.getTopicName(topicThreadId) ?? '').endsWith('… 🟢'));
    const cutName = fakeTelegram.getTopicName(topicThreadId) ?? '';
    assert.equal(cutName.length, 128, 'as long as Telegram allows');
    // The owner saves the name the bot applied, unchanged: the stored base stays whole, never the cut one.
    fakeTelegram.pushTopicRenamed(topicThreadId, cutName);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    assert.equal(readBinding(topicThreadId)?.topicName, longBase);
    // Back to the topic of the rest of the flow.
    fakeTelegram.pushTopicRenamed(topicThreadId, deployBase);
    await getCharness().waitFor('the short base again', replyTimeoutMs, () => readBinding(topicThreadId)?.topicName === deployBase);
    await waitForTopicName(topicThreadId, `${deployBase} 🟢`);
  });

  it('counts are off by default: no number in any name so far, whatever ran — and the picker switches them on', async () => {
    assert.ok(listRenamedTo(topicThreadId).every((name) => !anyCountPattern.test(name)), JSON.stringify(listRenamedTo(topicThreadId)));
    const picker = await openPicker(topic, topicThreadId);
    assert.ok(picker.text.includes('this topic: as in General'));
    assert.deepEqual(topic.getKeyboardLabels(picker).at(-2), ['⚙️ Agents at work', '📋 Tasks queued'], 'both counts off');
    await tapPicker(topic, picker, 'tst_queued_1');
    await tapPicker(topic, picker, 'tst_agents_1');
    assert.ok(picker.text.includes('this topic: its own set'));
    assert.deepEqual(topic.getKeyboardLabels(picker).at(-2), ['✓ ⚙️ Agents at work', '✓ 📋 Tasks queued']);
    assert.equal(fakeTelegram.getTopicName(topicThreadId), `${deployBase} 🟢`, 'a count of 0 shows nothing');
  });

  it('📋N follows the published todo list: three queued, one in work, all done', async () => {
    fakeTelegram.pushOperatorMessage(topicThreadId, 'TODO-1 [todo:queued:Alpha] [todo:queued:Beta] [todo:queued:Gamma] plan the work');
    await waitForTopicName(topicThreadId, `${deployBase} 🟢 📋3`);
    fakeTelegram.pushOperatorMessage(topicThreadId, 'TODO-2 [todo-id:t1:inWork] start the first');
    await waitForTopicName(topicThreadId, `${deployBase} 🟢 📋2`);
    fakeTelegram.pushOperatorMessage(topicThreadId, 'TODO-3 [todo-id:t1:done] [todo-id:t2:done] [todo-id:t3:done] all done');
    await waitForTopicName(topicThreadId, `${deployBase} 🟢`);
  });

  it('a worker the agent watches makes the topic work while the agent itself rests (⏳ ⚙️1), until the worker is gone', async () => {
    const runDir = path.join(getLayout().testRoot, 'worker-run');
    fs.mkdirSync(runDir, { recursive: true });
    const startedWorker = spawn('sleep', ['3600'], { stdio: 'ignore' });
    worker = startedWorker;
    await new Promise<void>((resolve, reject) => {
      startedWorker.once('spawn', resolve);
      startedWorker.once('error', reject);
    });
    fs.writeFileSync(path.join(runDir, 'events.jsonl'), `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'yarn test', description: 'Run the unit tests' } }] } })}\n`);
    const target: FakeStatusWatchTarget = { pid: startedWorker.pid ?? 0, runDir };
    fs.writeFileSync(path.join(getLayout().fakeStateDir, fakeStatusWatchTargetFileName), JSON.stringify(target));

    fakeTelegram.pushOperatorMessage(topicThreadId, 'WATCH-1 [fake:arm-status-watch] watch the builder you just launched');
    await waitForTopicName(topicThreadId, `${deployBase} ⏳ ⚙️1`);

    // The worker ends: the next run of the watch fails, and the topic is no longer working — and has no agent at work.
    startedWorker.kill('SIGKILL');
    await getCharness().waitFor('the worker\'s end to leave the name', checkRunTimeoutMs + renameTimeoutMs, () => {
      const name = fakeTelegram.getTopicName(topicThreadId) ?? '';
      return !name.includes('⚙️') && !name.includes('⏳');
    });
    await waitForTopicName(topicThreadId, `${deployBase} 🟢`, checkRunTimeoutMs + renameTimeoutMs);
    worker = null;
  });

  it('the counts are switched off again from the picker: the defaults are back', async () => {
    const picker = await openPicker(topic, topicThreadId);
    await tapPicker(topic, picker, 'tst_agents_0');
    await tapPicker(topic, picker, 'tst_queued_0');
    const again = await openPicker(topic, topicThreadId);
    assert.deepEqual(topic.getKeyboardLabels(again).at(-2), ['⚙️ Agents at work', '📋 Tasks queued']);
    // The topic follows General again: what General sets from here on reaches it.
    await tapPicker(topic, again, 'tst_same');
    assert.ok(again.text.includes('this topic: as in General'));
  });

  it('the per-turn backend stops its process after every turn by design: the topic shows ⏳ while the turn runs and 🟢 after it — never 💤 — and a short reply that wakes it writes NOTHING', async () => {
    const sentId = fakeTelegram.pushOperatorMessage(topicThreadId, '/claude_mode per-turn');
    // The answer comes once the conversation is resumed on the new backend: a process start, bounded by its handshake's own 15 s.
    await waitForAgentMessage(topic, 'the backend switch answer', (message) => message.message_id > sentId);
    const launchesBeforeLongTurn = getSessionLaunches(getLayout()).length;
    const renamesBefore = listRenamedTo(topicThreadId).length;
    fakeTelegram.pushOperatorMessage(topicThreadId, `PT-1 [work-ms:${longTurnMs}] a long turn`);
    await waitForTopicName(topicThreadId, `${deployBase} ⏳`);
    await waitForTopicName(topicThreadId, `${deployBase} 🟢`, renameTimeoutMs + longTurnMs);
    // The process is gone now (the per-turn stop), and the topic did not go to sleep: 🟢 until the next turn.
    await getCharness().waitFor('the per-turn process to be stopped', replyTimeoutMs, () => getCharness().output.includes('stopped (code='));
    assert.deepEqual(listRenamedTo(topicThreadId).slice(renamesBefore), [`${deployBase} ⏳`, `${deployBase} 🟢`], 'working, then finished — no 💤 in between or after');
    assert.deepEqual(await watchForRenames(topicThreadId), [], 'the stopped topic stays 🟢: nothing is written while it rests');

    // A short reply wakes the stopped process and ends inside the settle time: the topic shows nothing of it.
    const renamesBeforeWake = listRenames(topicThreadId).length;
    const outputBeforeWake = getCharness().output.length;
    const wakeAtMs = Date.now();
    const wakeMessageId = fakeTelegram.pushOperatorMessage(topicThreadId, 'PT-2 another short reply');
    await waitForAgentMessage(topic, 'the reply to the waking prompt (a new process)', (message) => message.message_id > wakeMessageId);
    const replyAfterMs = Date.now() - wakeAtMs;
    assert.ok(getSessionLaunches(getLayout()).length > launchesBeforeLongTurn, 'the reply was taken by a NEW process: the topic really had stopped');
    const renames = await watchForRenames(topicThreadId);
    // A failure says when each name came, against the wake and the turn: a mark shows only for a state held for the settle time.
    const wakeTimeline = [
      ...listRenames(topicThreadId).slice(renamesBeforeWake).map((rename) => `${rename.name} at +${rename.atMs - wakeAtMs} ms`),
      `the agent read the prompt at +${(getAgentPrompts('PT-2')[0]?.readAt ?? Number.NaN) - wakeAtMs} ms`,
      `the reply was seen at +${replyAfterMs} ms`,
      ...getCharness().output.slice(outputBeforeWake).split('\n').filter((line) => line.includes('handshake timed out')),
    ];
    assert.deepEqual(renames, [], `a turn that wakes the stopped topic and ends inside the settle time (${settleMs} ms) shows nothing: ${JSON.stringify(wakeTimeline)}`);
    assert.equal(fakeTelegram.getTopicName(topicThreadId), `${deployBase} 🟢`);
  });

  it('a logged-out agent is ❗️ until it works again', async () => {
    fs.writeFileSync(path.join(getLayout().fakeStateDir, fakeClaudeApiErrorOnceFileName), 'Invalid API key · Please run /login');
    fakeTelegram.pushOperatorMessage(topicThreadId, 'AUTH-1 this turn is refused');
    await waitForTopicName(topicThreadId, `${deployBase} ❗️`);
    // It is logged in again: the next turn produces output, the notice is retired, the topic is finished again.
    fakeTelegram.pushOperatorMessage(topicThreadId, 'AUTH-2 hello again');
    await waitForTopicName(topicThreadId, `${deployBase} 🟢`);
  });

  it('a usage-limit wait with no account to switch to is ❗️, and the mark leaves it when the wait ends by itself and the agent goes on', async () => {
    const resetAt = new Date(Date.now() + usageLimitResetAheadMs).toISOString();
    fakeTelegram.pushOperatorMessage(topicThreadId, `LIMIT-1 [fake:usage-limit-once] [limit-resets:${resetAt}] hit the limit`);
    await waitForTopicName(topicThreadId, `${deployBase} ❗️`, usageLimitTimeoutMs);
    const wasStuckUntilMs = Date.now();
    assert.ok(Object.keys(readPersistedState(getLayout()).apiRetries ?? {}).length === 1, 'a usage-limit wait is armed: nothing to switch to');
    // The window resets, the bot nudges the agent by itself, the agent goes on: no longer stuck, the topic is finished again.
    await getCharness().waitFor('the topic to leave ❗️', usageLimitTimeoutMs, () => fakeTelegram.getTopicName(topicThreadId) !== `${deployBase} ❗️`);
    await waitForTopicName(topicThreadId, `${deployBase} 🟢`, usageLimitTimeoutMs);
    assert.ok(Date.now() - wasStuckUntilMs < usageLimitTimeoutMs, 'the wait ended by itself, nobody wrote to the topic');
    assert.equal(Object.keys(readPersistedState(getLayout()).apiRetries ?? {}).length, 0, 'the wait is over');
  });

  it('a crashed agent is ❗️ until its next turn — not stuck for ever, and not hidden by a 🟢 — and the next turn clears it', async () => {
    const crashSwitch = path.join(getLayout().fakeStateDir, fakeClaudeCrashOnPromptFileName);
    fs.writeFileSync(crashSwitch, '');
    try {
      fakeTelegram.pushOperatorMessage(topicThreadId, 'CRASH-1 this prompt kills the agent');
      await waitForTopicName(topicThreadId, `${deployBase} ❗️`, usageLimitTimeoutMs);
    } finally {
      fs.rmSync(crashSwitch, { force: true });
    }
    // Nothing runs, nothing is asked of the agent: the mark stays while the topic waits for the owner's next message.
    assert.deepEqual(await watchForRenames(topicThreadId), [], 'a crash is stuck until the next turn, however long that takes');
    fakeTelegram.pushOperatorMessage(topicThreadId, 'CRASH-2 are you back?');
    await waitForTopicName(topicThreadId, `${deployBase} 🟢`, usageLimitTimeoutMs);
  });

  it('a topic whose own name the bot does not know is NEVER renamed: its candidate is offered, General lists it, one tap names it — and the mark appears', async () => {
    fakeTelegram.setTopicCreationName(secondTopicThreadId, secondTopicCreatedName);
    secondTopic = new TopicDriver(fakeTelegram, getCharness, secondTopicThreadId, replyTimeoutMs);
    await secondTopic.sendAndAwaitReply(`/bind ${projectFolder}`, `Bound to \`${projectFolder}\``);
    await startAgent(secondTopic, secondTopicThreadId);
    const renamesInWindow = await watchForRenames(secondTopicThreadId);
    assert.deepEqual(renamesInWindow, [], 'an unknown name is never written over');
    assert.equal(readBinding(secondTopicThreadId)?.topicName, undefined);

    const topicPicker = await openPicker(secondTopic, secondTopicThreadId);
    assert.equal(readBinding(secondTopicThreadId)?.topicNameCandidate, secondTopicCreatedName, 'the root message of the owner\'s message carried the creation name');
    assert.ok(topicPicker.text.includes(`I don't know this topic's name. Is it «${secondTopicCreatedName}»?`), topicPicker.text);

    const generalSentId = fakeTelegram.pushOperatorMessage(generalTopicThreadId, '/topic_status');
    const generalPicker = await general.waitForMessage('General\'s picker', (message) => message.message_id > generalSentId && message.text.startsWith(pickerTitle));
    assert.ok(generalPicker.text.includes('Names I don\'t know yet'));
    assert.deepEqual(general.getKeyboardLabels(generalPicker).at(-1), [`✓ «${secondTopicCreatedName}»`]);
    await general.tapAndAwaitAnswer(generalPicker, `tsn_${secondTopicThreadId}`);
    await getCharness().waitFor('the name to be known', replyTimeoutMs, () => readBinding(secondTopicThreadId)?.topicName === secondTopicCreatedName);
    await waitForTopicName(secondTopicThreadId, `${secondTopicCreatedName} 🟢`);
    assert.equal(listRenames(generalTopicThreadId).length, 0, 'General is never marked');
  });

  it('a mark turned off in a topic gives the owner\'s name back AT ONCE; «All off» in General does so for every topic, and the five marks switched on again bring them back', async () => {
    const secondPicker = await openPicker(secondTopic, secondTopicThreadId);
    const lastRenameAtMs = listRenames(secondTopicThreadId).at(-1)?.atMs ?? 0;
    await tapPicker(secondTopic, secondPicker, 'tst_finished_0');
    await waitForTopicName(secondTopicThreadId, secondTopicCreatedName, gapMs);
    const backAtMs = listRenames(secondTopicThreadId).at(-1)?.atMs ?? 0;
    assert.ok(backAtMs - lastRenameAtMs < gapMs + settleMs + 5000, 'the owner\'s own change skipped the wait');

    const generalSentId = fakeTelegram.pushOperatorMessage(generalTopicThreadId, '/topic_status');
    const generalPicker = await general.waitForMessage('General\'s picker', (message) => message.message_id > generalSentId && message.text.startsWith(pickerTitle));
    await tapPicker(general, generalPicker, 'tst_off');
    await waitForTopicName(topicThreadId, deployBase, gapMs);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(path.dirname(getLayout().envFile), 'settings.json'), 'utf8')).topicStatus, { question: false, stuck: false, working: false, finished: false, asleep: false });

    for (const name of ['question', 'stuck', 'working', 'finished', 'asleep']) await tapPicker(general, generalPicker, `tst_${name}_1`);
    await waitForTopicName(topicThreadId, `${deployBase} 🟢`);
    assert.equal(fakeTelegram.getTopicName(secondTopicThreadId), secondTopicCreatedName, 'the topic with its own set keeps it');
  });

  it('no right to manage topics: no rename, one log line and a hint; the renames go on once the right is back', async () => {
    // The question waits for ever: this step is about the right, and a question the wait set aside in the middle of it (the flow's wait is
    // 3 s) would change the buttons under the tap. The next step shares the setting; it hands it back, whatever happens in either.
    await setQuestionWait(topic, topicThreadId, 'qw_untilAnswered');
    try {
      fakeTelegram.canManageTopics = false;
      const question = await askQuestion('Q-3');
      await getCharness().waitFor('the refusal to be logged', replyTimeoutMs, () => getCharness().output.includes('the bot may not rename topics'));
      const renamesAfterRefusal = listRenamedTo(topicThreadId).length;
      assert.equal(fakeTelegram.getTopicName(topicThreadId), `${deployBase} 🟢`, 'the name stays as it was');
      const picker = await openPicker(topic, topicThreadId);
      assert.ok(picker.text.includes('Needs the «Manage topics» admin right.'), picker.text);
      assert.equal(getCharness().output.split('the bot may not rename topics').length - 1, 1, 'one log line');

      fakeTelegram.canManageTopics = true;
      await getCharness().waitFor('the sweep to try again and write the question mark', renameTimeoutMs, () => fakeTelegram.getTopicName(topicThreadId) === `${deployBase} ❓`);
      assert.ok(listRenamedTo(topicThreadId).length > renamesAfterRefusal - 1);
      assert.ok(topic.getKeyboardData(fakeTelegram.getMessage(question.message_id) ?? question).flat().every((data) => data.startsWith('qa_')), 'the question is still the waiting one: the wait is not over');
      await answerQuestion(question);
      await waitForTopicName(topicThreadId, `${deployBase} 🟢`);
    } finally {
      // The right is the bot's to have in the steps after this one, however this one ended.
      fakeTelegram.canManageTopics = true;
    }
  });

  it('no right to delete messages: the renames go on, the «renamed» lines stay, one log line and a hint', async () => {
    try {
      fakeTelegram.isMessageDeletionRefused = true;
      const linesBefore = fakeTelegram.ownRenameLineIds.length;
      const question = await askQuestion('Q-4');
      await waitForTopicName(topicThreadId, `${deployBase} ❓`);
      await getCharness().waitFor('the line to stay and be logged', replyTimeoutMs, () => getCharness().output.includes('a «renamed the topic» line of the bot stayed'));
      const stayedLineId = fakeTelegram.ownRenameLineIds[linesBefore];
      assert.ok(stayedLineId !== undefined && fakeTelegram.getMessage(stayedLineId)?.isDeleted !== true, 'the line is still in the topic');
      const picker = await openPicker(topic, topicThreadId);
      assert.ok(picker.text.includes('Without «Delete messages» each change leaves a «renamed» line in the topic.'), picker.text);

      fakeTelegram.isMessageDeletionRefused = false;
      await answerQuestion(question);
      await waitForTopicName(topicThreadId, `${deployBase} 🟢`);
    } finally {
      // What the two steps changed is handed back whatever happened in them, so one failure does not fail the steps after it for another cause:
      // the right to delete, and the Deploy topic's question wait (set in the step before; the failure of THIS call is told, never hides the step's own).
      fakeTelegram.isMessageDeletionRefused = false;
      await setQuestionWait(topic, topicThreadId, 'qw_same').catch((error) => console.warn(`the Deploy topic's question wait could not be handed back: ${error instanceof Error ? error.message : error}`));
    }
  });

  it('a name Telegram does not keep is never believed: «not modified» for a mark it drops is logged once, stored as nothing and not asked again — and a switch the owner touches asks once more, so the mark shows when Telegram keeps it', async () => {
    // The fake drops 🟢 as well, the way Telegram drops ✅: the topic reads «Deploy» whatever the bot asks.
    fakeTelegram.strippedTopicNameEndings = [strippedByTelegramEnding, '🟢'];
    const unkeptLine = `did not keep «${deployBase} 🟢»`;
    const countUnkeptLines = (): number => getCharness().output.split(unkeptLine).length - 1;
    try {
      // «Finished» off: the owner's name is back, a real change, and the bot believes the base.
      const picker = await openPicker(topic, topicThreadId);
      await tapPicker(topic, picker, 'tst_finished_0');
      await waitForTopicName(topicThreadId, deployBase, gapMs);
      await getCharness().waitFor('the base to be applied', replyTimeoutMs, () => readBinding(topicThreadId)?.indicatorAppliedName === deployBase);

      // «Finished» on: the bot asks for «Deploy 🟢», the title already reads «Deploy» — «not modified», and the bot does not take it for applied.
      const renamesBefore = listRenamedTo(topicThreadId).length;
      await tapPicker(topic, picker, 'tst_finished_1');
      await getCharness().waitFor('the bot to say that Telegram did not keep the name', replyTimeoutMs, () => countUnkeptLines() === 1);
      assert.deepEqual(listRenamedTo(topicThreadId).slice(renamesBefore), [`${deployBase} 🟢`], 'asked once');
      assert.equal(fakeTelegram.getTopicName(topicThreadId), deployBase, 'the topic reads the owner\'s name');
      assert.equal(readBinding(topicThreadId)?.indicatorAppliedName, deployBase, 'the mark is not what the bot believes is shown');
      assert.deepEqual(await watchForRenames(topicThreadId), [], 'no retry loop: the gap, the settle time and a sweep pass and nothing is asked again');
      assert.equal(countUnkeptLines(), 1, 'one line');

      // Telegram keeps the mark from now on (the fake stops dropping it); the owner touches the switch: asked once more, and now it shows.
      fakeTelegram.strippedTopicNameEndings = [strippedByTelegramEnding];
      await tapPicker(topic, picker, 'tst_finished_0');
      await waitForTopicName(topicThreadId, deployBase, gapMs);
      await tapPicker(topic, picker, 'tst_finished_1');
      await waitForTopicName(topicThreadId, `${deployBase} 🟢`, gapMs);
      await getCharness().waitFor('the shown mark to be the applied one', replyTimeoutMs, () => readBinding(topicThreadId)?.indicatorAppliedName === `${deployBase} 🟢`);
      assert.equal(countUnkeptLines(), 1, 'and the line is not repeated');
      await tapPicker(topic, picker, 'tst_same');
    } finally {
      fakeTelegram.strippedTopicNameEndings = [strippedByTelegramEnding];
    }
  });

  it('an ask answered OK that Telegram kept altered is not believed either: the «renamed» line carries the stored name, which becomes the belief — and the same ask is not repeated', async () => {
    // The fake drops 🟢 as Telegram drops ✅. The topic shows ❓ when 🟢 is asked, so the answer is ok (a change) and nothing but the line tells.
    fakeTelegram.strippedTopicNameEndings = [strippedByTelegramEnding, '🟢'];
    await setQuestionWait(topic, topicThreadId, 'qw_untilAnswered');
    try {
      const question = await askQuestion('Q-8');
      await waitForTopicName(topicThreadId, `${deployBase} ❓`);
      // The line of the 🟢 ask reaches the bot BEFORE the answer of that call does: the verdict must wait for the answer's success block.
      fakeTelegram.holdNextResponse('editForumTopic', lineBeforeAnswerHoldMs, (payload) => payload.name === `${deployBase} 🟢`);
      await answerQuestion(question);
      // The turn runs on and ends: «finished» is asked from a title that is not the base — answered ok, stored as «Deploy».
      await getCharness().waitFor('the topic to read the owner\'s name: the 🟢 was dropped', renameTimeoutMs, () => fakeTelegram.getTopicName(topicThreadId) === deployBase && listRenamedTo(topicThreadId).at(-1) === `${deployBase} 🟢`);
      await getCharness().waitFor('the stored name to become the belief', replyTimeoutMs + lineBeforeAnswerHoldMs, () => readBinding(topicThreadId)?.indicatorAppliedName === deployBase);
      assert.deepEqual(await watchForRenames(topicThreadId), [], 'no retry loop: «Deploy 🟢» is not asked again');

      // Telegram keeps the mark from now on; the owner touches the switch (he asked): the mark shows.
      fakeTelegram.strippedTopicNameEndings = [strippedByTelegramEnding];
      const picker = await openPicker(topic, topicThreadId);
      await tapPicker(topic, picker, 'tst_finished_0');
      await waitForTopicName(topicThreadId, deployBase, gapMs);
      await tapPicker(topic, picker, 'tst_finished_1');
      await waitForTopicName(topicThreadId, `${deployBase} 🟢`, gapMs);
      await getCharness().waitFor('the shown mark to be the applied one', replyTimeoutMs, () => readBinding(topicThreadId)?.indicatorAppliedName === `${deployBase} 🟢`);
      await tapPicker(topic, picker, 'tst_same');
    } finally {
      fakeTelegram.strippedTopicNameEndings = [strippedByTelegramEnding];
      await setQuestionWait(topic, topicThreadId, 'qw_same').catch((error) => console.warn(`the Deploy topic's question wait could not be handed back: ${error instanceof Error ? error.message : error}`));
    }
  });

  it('a topic that is unbound while its question waits gets the owner\'s name back — and nothing is written to it after that', async () => {
    const unboundThreadId = fakeTelegram.pushTopicCreated('Billing');
    const unboundTopic = new TopicDriver(fakeTelegram, getCharness, unboundThreadId, replyTimeoutMs);
    await unboundTopic.waitForMessage('the welcome of the new topic', () => true);
    await unboundTopic.sendAndAwaitReply(`/bind ${projectFolder}`, `Bound to \`${projectFolder}\``);
    await startAgent(unboundTopic, unboundThreadId);
    await waitForTopicName(unboundThreadId, 'Billing 🟢');
    await askQuestion('Q-5', unboundTopic, unboundThreadId);
    await waitForTopicName(unboundThreadId, 'Billing ❓');

    // «Leave current dir» while the ❓ shows: the question closes, the name goes back, and nothing is written after it.
    // This step covers the RESTORE and the end state. It does not prove the guard against a late ❓ (`checkIsUnbinding`): the unbind closes
    // the question, so the look it queues wants 🟢 and is written before the restore takes the lock — with or without the guard. The race
    // the guard closes is set up by the unit tests (`topicIndicator.test.ts`, «a topic that is being unbound»).
    const picker = await unboundTopic.sendAndAwaitReply('/bind', enDict['bind.current'].replace('{subdir}', projectFolder));
    await unboundTopic.tapAndAwaitAnswer(picker, bindLeaveCurrentCallback);
    await unboundTopic.waitForMessage('the unbound notice', (message) => message.message_id > picker.message_id && message.text === enDict['thread.unbound']);
    await waitForTopicName(unboundThreadId, 'Billing', replyTimeoutMs);
    await getCharness().waitFor('the binding to be gone from the saved state', replyTimeoutMs, () => readBinding(unboundThreadId) === undefined);
    assert.deepEqual(await watchForRenames(unboundThreadId), [], 'nothing is written to a topic that is no longer bound');
    assert.equal(listRenamedTo(unboundThreadId).at(-1), 'Billing', 'the last name the bot wrote is the owner\'s own');
    assert.equal(fakeTelegram.getTopicName(unboundThreadId), 'Billing');
  });

  it('a restart renames nothing that is already right, and an owner\'s rename that waited meanwhile is learned BEFORE the boot\'s wave writes — also the write that comes at once, a mark leaving ❓', async () => {
    // Topic «Research» has a question that waits for ever (it is never set aside), so its name carries ❓ across the restart.
    await setQuestionWait(secondTopic, secondTopicThreadId, 'qw_untilAnswered');
    await askQuestion('Q-6', secondTopic, secondTopicThreadId);
    await waitForTopicName(secondTopicThreadId, `${secondTopicCreatedName} ❓`);
    await new Promise((resolve) => setTimeout(resolve, gapMs));
    const secondKey = `${group.id}:${secondTopicThreadId}`;
    await getCharness().waitFor('the saved state', replyTimeoutMs, () => readBinding(secondTopicThreadId)?.indicatorAppliedName === `${secondTopicCreatedName} ❓` && readPersistedState(getLayout()).pendingQuestions?.[secondKey] !== undefined);
    const deployRenamesBefore = listRenames(topicThreadId).length;
    const secondRenamesBefore = listRenames(secondTopicThreadId).length;
    const secondSessionId = readPersistedState(getLayout()).agents?.[secondKey]?.claudeSessionId;
    const secondAgent = getSessionLaunches(getLayout()).filter((launch) => getLaunchSessionId(launch.argv) === secondSessionId).at(-1);
    assert.ok(secondAgent, 'the topic\'s agent runs');

    // The bot is down: the agent dies (the question with it), and the owner renames both topics — the updates wait for the bot.
    await charness?.stop();
    // The stopped bot's last long poll is closed by the time the fake notices: an update pushed before that is handed to a dead socket and lost.
    await new Promise((resolve) => setTimeout(resolve, deadPollSettleMs));
    process.kill(secondAgent.pid, 'SIGKILL');
    fakeTelegram.pushTopicRenamed(secondTopicThreadId, `${secondTopicCreatedName} 2 ❓`);
    fakeTelegram.pushTopicRenamed(topicThreadId, 'Deploy 3 🟢');
    // The boot's wave comes at once (1 ms), BEFORE the polling does: only the guard keeps it from writing with the old names.
    writeEnvironment(1);
    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    try {
      await getCharness().waitFor('the owner\'s renames to be learned', replyTimeoutMs, () => readBinding(topicThreadId)?.topicName === 'Deploy 3' && readBinding(secondTopicThreadId)?.topicName === `${secondTopicCreatedName} 2`);
      // The dead agent's question is gone, so the ❓ leaves — the write that comes at once, skipping the settle time and the gap. It carries the NEW name.
      await waitForTopicName(secondTopicThreadId, `${secondTopicCreatedName} 2 💤`);
      assert.deepEqual(listRenamedTo(secondTopicThreadId).slice(secondRenamesBefore), [`${secondTopicCreatedName} 2 💤`], 'the owner\'s rename was never overwritten with the old name');
      assert.deepEqual(await watchForRenames(topicThreadId), [], 'the topic that was right is not renamed');
      assert.equal(listRenames(topicThreadId).length, deployRenamesBefore, 'no rename of it since the restart');
      assert.equal(fakeTelegram.getTopicName(topicThreadId), 'Deploy 3 🟢');
    } finally {
      writeEnvironment(bootWaveDelayMs);
    }
  });

  it('a COLD start reads the topic renames that waited before it drops the updates: the owner\'s rename is learned and marked, a stranger\'s is not, the bot\'s own «renamed» line is deleted and never taken for a name, a plain message that waited is dropped', async () => {
    const renamesBefore = listRenames(topicThreadId).length;
    const pollsBefore = fakeTelegram.listCalls('getUpdates').length;
    await charness?.stop();
    await new Promise((resolve) => setTimeout(resolve, deadPollSettleMs));
    // The heartbeat is a few minutes old: the next boot is a cold start, which drops what waited — as Telegram does, in this fake.
    const persisted = readPersistedState(getLayout());
    persisted.lastHeartbeatAt = Date.now() - coldStartDowntimeMs;
    fs.writeFileSync(getStatePath(getLayout()), JSON.stringify(persisted));
    fakeTelegram.isPendingDroppedByLaunch = true;
    fakeTelegram.pushTopicRenamed(topicThreadId, 'Deploy 4');
    // The bot's own last rename, whose echo had not come back before it stopped: its line must be deleted and its name never taken as the owner's.
    const ownLineId = fakeTelegram.pushTopicRenamed(topicThreadId, 'Deploy ⏳', botUser);
    fakeTelegram.pushTopicRenamed(topicThreadId, 'Hijacked', strangerUser);
    fakeTelegram.pushOperatorMessage(topicThreadId, 'COLD-1 typed while the bot was down');
    try {
      charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
      assert.match(getCharness().output, /Boot mode:\s+COLD START/, 'the boot was a cold start');
      await getCharness().waitFor('the owner\'s rename that waited to be learned', replyTimeoutMs, () => readBinding(topicThreadId)?.topicName === 'Deploy 4');
      // The topic carries HIS name with the mark after it: the stranger's name never became the base, and the bot put the name back over it.
      await getCharness().waitFor('the topic to be called «Deploy 4» plus its mark', renameTimeoutMs, () => /^Deploy 4 [🟢💤]$/u.test(fakeTelegram.getTopicName(topicThreadId) ?? ''));
      assert.equal(readBinding(topicThreadId)?.topicName, 'Deploy 4');
      assert.ok(listRenamedTo(topicThreadId).slice(renamesBefore).every((name) => name.startsWith('Deploy 4 ')), `no rename carried the old or the stranger's name: ${JSON.stringify(listRenamedTo(topicThreadId).slice(renamesBefore))}`);
      assert.match(getCharness().output, /Cold start: 3 topic rename\(s\) waited while the bot was down, 1 applied/);
      assert.match(getCharness().output, /\[security\] forum_topic_edited in chat -1001111111111 by user 909090/);
      assert.ok(!getCharness().output.includes(`by user ${botUser.id}`), 'the bot\'s own line was no stranger\'s rename');
      await getCharness().waitFor('the bot\'s own «renamed» line that waited to be deleted', replyTimeoutMs, () => fakeTelegram.getMessage(ownLineId)?.isDeleted === true);
      // Telegram remembers `allowed_updates`: the read asks with the bot's whole list — the polling's own — never a partial one.
      const pollsSince = fakeTelegram.listCalls('getUpdates').slice(pollsBefore);
      const read = pollsSince.find((call) => call.payload.timeout === 0);
      // The stopped bot's last call (telegraf's ACK of its final batch) carries no subscription and is no poll: the launch's own does.
      const polling = pollsSince.find((call) => call.payload.timeout !== 0 && call.payload.allowed_updates !== undefined);
      assert.ok(read && polling, 'the waiting updates were read once (a short poll), and the launch polled after it');
      assert.deepEqual(read.payload.allowed_updates, polling.payload.allowed_updates, 'the read left the subscription as the launch makes it');
      assert.ok((read.payload.allowed_updates as string[]).includes('callback_query'), 'the buttons are still subscribed to');
      assert.deepEqual(getAgentPrompts('COLD-1'), [], 'the plain message that waited was dropped, as a cold start always did');
    } finally {
      fakeTelegram.isPendingDroppedByLaunch = false;
    }
  });

  it('a restart with NOTHING waiting writes the mark that leaves ❓ seconds after the start: the first long poll Telegram holds open is no backlog', async () => {
    await askQuestion('Q-7', secondTopic, secondTopicThreadId);
    await waitForTopicName(secondTopicThreadId, `${secondTopicCreatedName} 2 ❓`);
    await new Promise((resolve) => setTimeout(resolve, gapMs));
    const secondKey = `${group.id}:${secondTopicThreadId}`;
    await getCharness().waitFor('the saved state', replyTimeoutMs, () => readBinding(secondTopicThreadId)?.indicatorAppliedName === `${secondTopicCreatedName} 2 ❓` && readPersistedState(getLayout()).pendingQuestions?.[secondKey] !== undefined);
    const secondSessionId = readPersistedState(getLayout()).agents?.[secondKey]?.claudeSessionId;
    const secondAgent = getSessionLaunches(getLayout()).filter((launch) => getLaunchSessionId(launch.argv) === secondSessionId).at(-1);
    assert.ok(secondAgent, 'the topic\'s agent runs');
    const renamesBefore = listRenames(secondTopicThreadId).length;

    // The bot is down: the agent dies, the question with it. Nothing is pushed: no update waits for the bot.
    await charness?.stop();
    await new Promise((resolve) => setTimeout(resolve, deadPollSettleMs));
    process.kill(secondAgent.pid, 'SIGKILL');
    const previousHoldMs = fakeTelegram.longPollHoldMs;
    fakeTelegram.longPollHoldMs = productionLongPollHoldMs;
    try {
      charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
      const readyAtMs = Date.now();
      assert.match(getCharness().output, /Boot mode:\s+HOT RELOAD/, 'a restart within a minute is a hot reload: nothing was read before a drop');
      await waitForTopicName(secondTopicThreadId, `${secondTopicCreatedName} 2 💤`);
      const writtenAfterMs = (listRenames(secondTopicThreadId).at(-1)?.atMs ?? Number.POSITIVE_INFINITY) - readyAtMs;
      assert.deepEqual(listRenamedTo(secondTopicThreadId).slice(renamesBefore), [`${secondTopicCreatedName} 2 💤`]);
      assert.ok(writtenAfterMs < noBacklogWriteDeadlineMs, `the mark was written ${writtenAfterMs} ms after the start; the poll that waits for nothing must not hold it back for the cap (30 s)`);
    } finally {
      fakeTelegram.longPollHoldMs = previousHoldMs;
    }
  });

  it('the agent\'s own context names the owner\'s name, never one with a mark', () => {
    // The preamble rides on a prompt only when it changed, so it names each name the topic had: the owner's, as he renamed it.
    const names = [...new Set(listPreambleTopicNames())];
    assert.ok(names.length >= 2, `the preamble named the topic before and after a rename: ${JSON.stringify(names)}`);
    assert.ok(names.every((name) => !/\s[❓❗⏳🟢💤]/u.test(name)), JSON.stringify(names));
    assert.ok(names.includes(deployBase));
    assert.ok(names.includes('New'), 'the name after the owner\'s rename — the topic showed «New 🟢» when the agent was told');
  });

  it('every rename of the whole flow carried the name alone — never an icon — and General was never marked', () => {
    const calls = fakeTelegram.listCalls('editForumTopic');
    assert.ok(calls.length > 20, 'the flow renamed topics a good many times');
    assert.ok(calls.every((call) => Object.keys(call.payload).every((field) => ['chat_id', 'message_thread_id', 'name'].includes(field))), 'no call carried an icon');
    assert.equal(listRenames(generalTopicThreadId).length, 0);
    // `getCharness()` is the instance of the last restart (the no-backlog one): none of its renames was a stranger's.
    assert.ok(!getCharness().output.includes('[security] forum_topic_edited'), 'the last instance took no rename for a stranger\'s');
  });
});
