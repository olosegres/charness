/**
 * @description The status mark at the END of a topic's name at PROCESS level: the BUILT charness started the way an isolated instance
 * is (`scripts/run-isolated.sh`) against the fake Bot API (`telegramE2e/fakeTelegram.ts`, which now answers `editForumTopic`, echoes the
 * bot's own «renamed» line and refuses any rename that carries an icon), with the fake `claude` (`jiraE2e/fakeClaude.ts`) as the agent.
 * The settle time, the gap between two renames, the sweep and the boot wave are cut to seconds (`CHARNESS_TEST_TIMINGS`). One flow, in
 * order:
 *
 *   boot → a topic «Deploy» is created by the owner, bound, its agent started: the name takes ✅ once it has held the settle time — the
 *     NAME only (never an icon), the bot's own «renamed» line deleted at once, the stored own name still «Deploy»
 *   → a question: ❓ at once, inside the gap since the last rename; answered: ❓ goes at once; a question set aside keeps the mark and
 *     its late answer takes it off
 *   → a turn that runs on: ⏳ after the settle time, ✅ when it ends
 *   → the owner renames the topic: around the bot's mark («Deploy v2 ✅») the base is «Deploy v2»; a mark of his own at the end
 *     («Release ✅») is dropped from the base and told once by the picker; a plain name takes the mark back; a name cut to the limit
 *     saved unchanged keeps the whole stored base
 *   → counts off by default; `/topic_status` switches them on: `📋N` follows the published todo list, and a worker the agent watches
 *     makes the topic work (`⚙️1`) while its own agent rests, until the worker is gone
 *   → the per-turn backend: the process stops after the turn, 💤; a short reply that wakes it writes nothing (no ✅ on the way to ⏳)
 *   → the agent is logged out: ❗️ until it works again
 *   → a topic whose own name the bot does not know is never renamed: the candidate (the name it was created with, carried by the root
 *     message of the owner's plain messages) is offered by the picker, General lists such topics, one tap names it and the mark appears
 *   → a mark turned off in a topic gives the owner's name back at once; «All off» in General does so for every topic
 *   → no right to manage topics: no rename, one log line, a hint; no right to delete: the renames go on and the lines stay
 *   → a restart renames nothing that is already right, and an owner's rename that waited meanwhile is learned before the boot's wave
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
import { readPersistedState, restartCharnessWithState, startCharnessOnInstance } from './e2e/fallbackFlowKit';
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';
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
const secondTopicCreatedName = 'Research';
const pickerTitle = 'Topic status in the topic list';

const replyTimeoutMs = 20 * 1000;
/** A name that must wait out the settle time and the gap, with room for a loaded box. */
const renameTimeoutMs = gapMs + settleMs + 15 * 1000;
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

/** The operator puts a question (`[fake:ask]`): resolves its message once it carries the option buttons. */
async function askQuestion(label: string): Promise<FakeTelegramMessage> {
  const sentMessageId = fakeTelegram.pushOperatorMessage(topicThreadId, `${label} [fake:ask] ask me something`);
  return topic.waitForMessage(`the question of ${label}`, (candidate) =>
    candidate.message_id > sentMessageId && candidate.text.includes(fakeAskQuestion.question) && topic.getKeyboardData(candidate).flat().some((data) => data.startsWith('qa_')));
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
    general = new TopicDriver(fakeTelegram, getCharness, generalTopicThreadId, replyTimeoutMs);
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
      ...getTelegramFlowTestTimingsEnv({
        topicIndicatorSettleMs: settleMs,
        topicIndicatorMinRenameGapMs: gapMs,
        topicIndicatorSweepMs: sweepMs,
        topicIndicatorBootWaveDelayMs: bootWaveDelayMs,
        questionSetAsideWaitMs,
        scheduleMinFireIntervalMs: watchCronIntervalMs,
      }),
    });
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

  it('boots; the owner\'s topic «Deploy» is bound and gets its agent: the name takes ✅ after the settle time — the name only, the own «renamed» line deleted, the owner\'s name kept', async () => {
    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    topicThreadId = fakeTelegram.pushTopicCreated(deployBase);
    topic = new TopicDriver(fakeTelegram, getCharness, topicThreadId, replyTimeoutMs);
    await topic.waitForMessage('the welcome of the new topic', () => true);
    await topic.sendAndAwaitReply(`/bind ${projectFolder}`, `Bound to \`${projectFolder}\``);
    await getCharness().waitFor('the owner\'s name to be kept with the binding', replyTimeoutMs, () => readBinding(topicThreadId)?.topicName === deployBase);
    assert.deepEqual(listRenamedTo(topicThreadId), [], 'a topic without an agent keeps the owner\'s name: nothing is written');
    await topic.sendAndAwaitReply('/claude', 'ready in');

    await waitForTopicName(topicThreadId, `${deployBase} ✅`);
    assert.deepEqual(listRenamedTo(topicThreadId), [`${deployBase} ✅`], 'one rename: the settle time held back every other name');
    assert.ok(listRenames(topicThreadId).every((rename) => rename.isNameOnly), 'the call carries the name and nothing else — never the icon');
    await waitForOwnRenameLinesDeleted();
    assert.equal(fakeTelegram.ownRenameLineIds.length, 1, 'the bot got its own «renamed» line once, and deleted it');
    assert.ok(!getCharness().output.includes('[security] forum_topic_edited'), 'the bot\'s own rename is no stranger\'s');
    await getCharness().waitFor('the applied name to be persisted', replyTimeoutMs, () => readBinding(topicThreadId)?.indicatorAppliedName === `${deployBase} ✅`);
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
    await topic.tapAndAwaitAnswer(fakeTelegram.getMessage(question.message_id) ?? question, getFirstOptionData(question));
    await getCharness().waitFor('the ❓ to be taken off', replyTimeoutMs, () => fakeTelegram.getTopicName(topicThreadId) !== `${deployBase} ❓`);
    const afterAnswer = listRenames(topicThreadId).at(-1);
    assert.ok(afterAnswer && afterAnswer.atMs - answerTapAtMs < gapMs, 'the answered question\'s mark went at once, not after the gap');
    // The turn ends; whatever the name showed in between, it settles on ✅.
    await waitForTopicName(topicThreadId, `${deployBase} ✅`);
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
    await topic.tapAndAwaitAnswer(current, lateAnswerData);
    await getCharness().waitFor('the ❓ to be taken off by the late answer', renameTimeoutMs, () => fakeTelegram.getTopicName(topicThreadId) !== `${deployBase} ❓`);
    await waitForTopicName(topicThreadId, `${deployBase} ✅`);
  });

  it('a turn that runs on shows ⏳ after the settle time, and ✅ when it ends', async () => {
    const renamesBefore = listRenamedTo(topicThreadId).length;
    fakeTelegram.pushOperatorMessage(topicThreadId, `LONG-1 [work-ms:${longTurnMs}] a long task`);
    await waitForTopicName(topicThreadId, `${deployBase} ⏳`);
    assert.deepEqual(listRenamedTo(topicThreadId).slice(renamesBefore), [`${deployBase} ⏳`], 'straight to ⏳');
    await waitForTopicName(topicThreadId, `${deployBase} ✅`, renameTimeoutMs + longTurnMs);
    assert.ok(getAgentPrompts('LONG-1').length >= 1, 'the agent really took the long task');
  });

  it('the owner renames the topic: around the bot\'s mark the base is the new name, and the mark stays where it is', async () => {
    fakeTelegram.pushTopicRenamed(topicThreadId, `${deployBase} v2 ✅`);
    await getCharness().waitFor('the owner\'s new name', replyTimeoutMs, () => readBinding(topicThreadId)?.topicName === `${deployBase} v2`);
    assert.equal(readBinding(topicThreadId)?.indicatorAppliedName, `${deployBase} v2 ✅`, 'what the topic shows now is remembered as applied');
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
    // The topic shows ✅ in fact: the bot puts its own mark over the owner's after the settle time and the gap.
    await waitForTopicName(topicThreadId, 'Release ✅');
  });

  it('a plain name takes the mark back after the settle time and the gap', async () => {
    fakeTelegram.pushTopicRenamed(topicThreadId, 'New');
    await getCharness().waitFor('the plain name as the base', replyTimeoutMs, () => readBinding(topicThreadId)?.topicName === 'New');
    await waitForTopicName(topicThreadId, 'New ✅');
    // The agent is told the owner's name, not the one with the mark the topic shows now (the preamble rides on this prompt).
    const promptMessageId = fakeTelegram.pushOperatorMessage(topicThreadId, 'NAME-1 what is this topic called?');
    await topic.waitForMessage('the agent\'s answer', (message) => message.message_id > promptMessageId);
    assert.equal(fakeTelegram.getTopicName(topicThreadId), 'New ✅');
  });

  it('a name cut to the limit saved unchanged keeps the whole stored base — the suffix is never cut, the base is', async () => {
    const longBase = `L${'x'.repeat(126)}`;
    fakeTelegram.pushTopicRenamed(topicThreadId, longBase);
    await getCharness().waitFor('the long base', replyTimeoutMs, () => readBinding(topicThreadId)?.topicName === longBase);
    await getCharness().waitFor('the cut name', renameTimeoutMs, () => (fakeTelegram.getTopicName(topicThreadId) ?? '').endsWith('… ✅'));
    const cutName = fakeTelegram.getTopicName(topicThreadId) ?? '';
    assert.equal(cutName.length, 128, 'as long as Telegram allows');
    // The owner saves the name the bot applied, unchanged: the stored base stays whole, never the cut one.
    fakeTelegram.pushTopicRenamed(topicThreadId, cutName);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    assert.equal(readBinding(topicThreadId)?.topicName, longBase);
    // Back to the topic of the rest of the flow.
    fakeTelegram.pushTopicRenamed(topicThreadId, deployBase);
    await getCharness().waitFor('the short base again', replyTimeoutMs, () => readBinding(topicThreadId)?.topicName === deployBase);
    await waitForTopicName(topicThreadId, `${deployBase} ✅`);
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
    assert.equal(fakeTelegram.getTopicName(topicThreadId), `${deployBase} ✅`, 'a count of 0 shows nothing');
  });

  it('📋N follows the published todo list: three queued, one in work, all done', async () => {
    fakeTelegram.pushOperatorMessage(topicThreadId, 'TODO-1 [todo:queued:Alpha] [todo:queued:Beta] [todo:queued:Gamma] plan the work');
    await waitForTopicName(topicThreadId, `${deployBase} ✅ 📋3`);
    fakeTelegram.pushOperatorMessage(topicThreadId, 'TODO-2 [todo-id:t1:inWork] start the first');
    await waitForTopicName(topicThreadId, `${deployBase} ✅ 📋2`);
    fakeTelegram.pushOperatorMessage(topicThreadId, 'TODO-3 [todo-id:t1:done] [todo-id:t2:done] [todo-id:t3:done] all done');
    await waitForTopicName(topicThreadId, `${deployBase} ✅`);
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
    await waitForTopicName(topicThreadId, `${deployBase} ✅`, checkRunTimeoutMs + renameTimeoutMs);
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

  it('the per-turn backend: the process stops after the turn, 💤; a short reply that wakes it writes NOTHING — no ✅ on the way to a ⏳ that never comes', async () => {
    const sentId = fakeTelegram.pushOperatorMessage(topicThreadId, '/claude_mode per-turn');
    await topic.waitForMessage('the backend switch answer', (message) => message.message_id > sentId);
    fakeTelegram.pushOperatorMessage(topicThreadId, 'PT-1 a short reply');
    await waitForTopicName(topicThreadId, `${deployBase} 💤`);

    // The gap since the 💤 is over, so a ✅ wanted for an instant on the way would be written at once if the settle time did not hold it.
    await new Promise((resolve) => setTimeout(resolve, gapMs + 500));
    const wakeMessageId = fakeTelegram.pushOperatorMessage(topicThreadId, 'PT-2 another short reply');
    await topic.waitForMessage('the reply to the waking prompt', (message) => message.message_id > wakeMessageId);
    const renames = await watchForRenames(topicThreadId);
    assert.deepEqual(renames, [], `a turn that wakes the sleeping topic and ends inside the settle time shows nothing, not even a ✅: ${JSON.stringify(renames)}`);
    assert.equal(fakeTelegram.getTopicName(topicThreadId), `${deployBase} 💤`);
  });

  it('a logged-out agent is ❗️ until it works again', async () => {
    fs.writeFileSync(path.join(getLayout().fakeStateDir, fakeClaudeApiErrorOnceFileName), 'Invalid API key · Please run /login');
    fakeTelegram.pushOperatorMessage(topicThreadId, 'AUTH-1 this turn is refused');
    await waitForTopicName(topicThreadId, `${deployBase} ❗️`);
    // It is logged in again: the next turn produces output, the notice is retired, the topic goes back to sleep.
    fakeTelegram.pushOperatorMessage(topicThreadId, 'AUTH-2 hello again');
    await waitForTopicName(topicThreadId, `${deployBase} 💤`);
  });

  it('a topic whose own name the bot does not know is NEVER renamed: its candidate is offered, General lists it, one tap names it — and the mark appears', async () => {
    fakeTelegram.setTopicCreationName(secondTopicThreadId, secondTopicCreatedName);
    secondTopic = new TopicDriver(fakeTelegram, getCharness, secondTopicThreadId, replyTimeoutMs);
    await secondTopic.sendAndAwaitReply(`/bind ${projectFolder}`, `Bound to \`${projectFolder}\``);
    await secondTopic.sendAndAwaitReply('/claude', 'ready in');
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
    await waitForTopicName(secondTopicThreadId, `${secondTopicCreatedName} ✅`);
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
    await waitForTopicName(topicThreadId, `${deployBase} 💤`);
    assert.equal(fakeTelegram.getTopicName(secondTopicThreadId), secondTopicCreatedName, 'the topic with its own set keeps it');
  });

  it('no right to manage topics: no rename, one log line and a hint; the renames go on once the right is back', async () => {
    fakeTelegram.canManageTopics = false;
    const question = await askQuestion('Q-3');
    await getCharness().waitFor('the refusal to be logged', replyTimeoutMs, () => getCharness().output.includes('the bot may not rename topics'));
    const renamesAfterRefusal = listRenamedTo(topicThreadId).length;
    assert.equal(fakeTelegram.getTopicName(topicThreadId), `${deployBase} 💤`, 'the name stays as it was');
    const picker = await openPicker(topic, topicThreadId);
    assert.ok(picker.text.includes('Needs the «Manage topics» admin right.'), picker.text);
    assert.equal(getCharness().output.split('the bot may not rename topics').length - 1, 1, 'one log line');

    fakeTelegram.canManageTopics = true;
    await getCharness().waitFor('the sweep to try again and write the question mark', renameTimeoutMs, () => fakeTelegram.getTopicName(topicThreadId) === `${deployBase} ❓`);
    assert.ok(listRenamedTo(topicThreadId).length > renamesAfterRefusal - 1);
    await topic.tapAndAwaitAnswer(fakeTelegram.getMessage(question.message_id) ?? question, getFirstOptionData(question));
    await waitForTopicName(topicThreadId, `${deployBase} 💤`);
  });

  it('no right to delete messages: the renames go on, the «renamed» lines stay, one log line and a hint', async () => {
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
    await topic.tapAndAwaitAnswer(fakeTelegram.getMessage(question.message_id) ?? question, getFirstOptionData(question));
    await waitForTopicName(topicThreadId, `${deployBase} 💤`);
  });

  it('a restart renames nothing that is already right, and an owner\'s rename that waited meanwhile is learned BEFORE the boot\'s wave', async () => {
    await new Promise((resolve) => setTimeout(resolve, gapMs));
    const deployRenamesBefore = listRenames(topicThreadId).length;
    const secondRenamesBefore = listRenames(secondTopicThreadId).length;
    await getCharness().waitFor('the saved state', replyTimeoutMs, () => readBinding(topicThreadId)?.indicatorAppliedName === `${deployBase} 💤`);
    // The bot is down; the owner renames the topic meanwhile — the update waits for the bot.
    await charness?.stop();
    // The stopped bot's last long poll is closed by the time the fake notices: an update pushed before that is handed to a dead socket and lost.
    await new Promise((resolve) => setTimeout(resolve, deadPollSettleMs));
    fakeTelegram.pushTopicRenamed(topicThreadId, 'Deploy 3 💤');
    charness = await restartCharnessWithState(getLayout(), fakeTelegram, getCharness(), () => {});
    await getCharness().waitFor('the owner\'s rename to be learned', replyTimeoutMs, () => readBinding(topicThreadId)?.topicName === 'Deploy 3');
    const renames = await watchForRenames(topicThreadId, bootWaveDelayMs + quietWatchMs);
    assert.deepEqual(renames, [], 'the wave did not overwrite the rename that waited with the old name');
    assert.equal(listRenames(topicThreadId).length, deployRenamesBefore, 'no rename of the topic since the restart');
    assert.equal(listRenames(secondTopicThreadId).length, secondRenamesBefore, 'the topic that was right is not renamed');
    assert.equal(fakeTelegram.getTopicName(topicThreadId), 'Deploy 3 💤');
  });

  it('the agent\'s own context names the owner\'s name, never one with a mark', () => {
    // The preamble rides on a prompt only when it changed, so it names each name the topic had: the owner's, as he renamed it.
    const names = [...new Set(listPreambleTopicNames())];
    assert.ok(names.length >= 2, `the preamble named the topic before and after a rename: ${JSON.stringify(names)}`);
    assert.ok(names.every((name) => !/\s[❓❗⏳✅💤]/u.test(name)), JSON.stringify(names));
    assert.ok(names.includes(deployBase));
    assert.ok(names.includes('New'), 'the name after the owner\'s rename — the topic showed «New ✅» when the agent was told');
  });

  it('every rename of the whole flow carried the name alone — never an icon — and General was never marked', () => {
    const calls = fakeTelegram.listCalls('editForumTopic');
    assert.ok(calls.length > 20, 'the flow renamed topics a good many times');
    assert.ok(calls.every((call) => Object.keys(call.payload).every((field) => ['chat_id', 'message_thread_id', 'name'].includes(field))), 'no call carried an icon');
    assert.equal(listRenames(generalTopicThreadId).length, 0);
    assert.ok(!getCharness().output.includes('[security] forum_topic_edited'), 'no rename was taken for a stranger\'s');
  });
});
