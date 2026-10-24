/**
 * @description The shared agent todo registry end to end, at PROCESS level: the BUILT charness, started the way an
 * isolated instance is (`scripts/run-isolated.sh` with its own env file), serving Telegram only, against a fake Bot API
 * on loopback (`telegramE2e/fakeTelegram.ts`) and a fake `claude` (`jiraE2e/fakeClaude.ts`) that publishes through the
 * real bot MCP's `todo_update` when its prompt carries todo tokens. The test plays the operator. One flow, in order:
 *
 *   isolation checked → boot → topic A bound to a folder; an unbound topic's `/todo` asks for a bind first
 *   → `/todo` before anything is published shows the empty state
 *   → the agent publishes an in-work item and a queued one: the tool answers with the list; `/todo` shows both
 *   → the agent closes the in-work item: `/todo` lists it under «Done today»
 *   → charness restarted: the list survives (it belongs to the topic, not to the process or the session)
 *   → the staleness reminder (a 4 s interval through the test-timing seam): the agent works longer than the interval
 *     with no prompt reaching it → ONE standalone reminder at the turn end, no request opened for it; with a request
 *     left open the standalone one is held back and the person's next message carries the reminder line instead;
 *     an agent that keeps working on its own (background tasks) is reminded twice, then the bot stays silent; an
 *     update restarts the clock, which waits for the next turn end
 *   → General's `/todo` opens the settings: an interval tap writes `settings.json` and moves the ✓; «Turn off» hides
 *     the intervals and a topic's `/todo` says the lists are off; «Turn on» brings them back
 *
 * Nothing leaves the machine: the Bot API and the bot MCP are on loopback, the agent is the fake. Everything the test
 * starts is stopped in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FakeTelegram, generalTopicThreadId, type FakeTelegramMessage } from './telegramE2e/fakeTelegram';
import { fakeClaudeBackgroundReleaseFileName, fakeClaudeLogFileNames } from './jiraE2e/fakeClaudeContract';
import {
  assertMcpListeningOn,
  builtCliPath,
  createIsolatedInstanceLayout,
  exitOnSignal,
  getFlowDeadlineMs,
  getFreeFixedPort,
  getFreePort,
  getInstanceEnvNames,
  IsolatedCharness,
  isolatedSettingsFileName,
  readJsonLines,
  removeIsolatedInstanceSync,
  writeFakeClaudeLauncher,
  writeInstanceEnvFile,
  type IsolatedInstanceLayout,
} from './e2e/isolatedCharness';
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';

/** The repo's placeholder group and its topics; the operator is the group's creator. */
const group = { id: -1001111111111, title: 'ExampleGroup' };
const topicAThreadId = 111;
const unboundThreadId = 333;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const folderA = 'proj-a';
/** The boot's last line before `bot.launch`, which resolves only when polling stops. */
const launchLine = 'Launching Telegraf bot (long polling';
const bootTimeoutMs = 60 * 1000;
/** A command's reply: a poll round trip and the paced send. */
const replyTimeoutMs = 20 * 1000;
/** A session start, a turn and the agent's tool call through the bot MCP. */
const turnTimeoutMs = 60 * 1000;
/** The staleness reminder's interval and poll for this instance (production: the settings' 1 h, a 10 s poll). */
const reminderIntervalMs = 4000;
const reminderPollMs = 500;
/** A turn that works past the interval. */
const longTurnWorkMs = 5000;
/** What the agent reads in a reminder, either form. */
const reminderMarker = '[Todo] Your published todo list was last updated';

interface FakePrompt {
  issueKey: string;
  requestId: string | null;
  text: string;
}

interface FakeToolCall {
  issueKey: string;
  tool: string;
  args: Record<string, unknown>;
  outcome: string;
}

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let schedulerMcpPort = 0;

function getLayout(): IsolatedInstanceLayout {
  if (!layout) throw new Error('the instance layout is not created yet');
  return layout;
}

function getCharness(): IsolatedCharness {
  if (!charness) throw new Error('charness is not started yet');
  return charness;
}

/** Wait for a bot message in the topic that `check` accepts, newest first; resolves it. */
async function waitForTopicMessage(threadId: number, description: string, check: (message: FakeTelegramMessage) => boolean): Promise<FakeTelegramMessage> {
  let found: FakeTelegramMessage | undefined;
  await getCharness().waitFor(description, replyTimeoutMs, () => {
    found = [...fakeTelegram.listBotMessages(threadId)].reverse().find(check);
    return found !== undefined;
  });
  if (!found) throw new Error(`no message for ${description}`);
  return found;
}

/** The operator writes in a topic and the bot's next reply containing `expectedText` is awaited. */
async function sendAndAwaitReply(threadId: number, text: string, expectedText: string): Promise<FakeTelegramMessage> {
  const sentAfterId = fakeTelegram.pushOperatorMessage(threadId, text);
  return waitForTopicMessage(threadId, `a reply to "${text}" with "${expectedText}"`, (message) => message.message_id > sentAfterId && message.text.includes(expectedText));
}

/** Ready = the boot reached its launch AND this run's polling reached the fake, with the bot MCP on its fixed port. */
async function startCharness(): Promise<void> {
  charness ??= new IsolatedCharness(getLayout());
  const pollsBefore = fakeTelegram.listCalls('getUpdates').length;
  const outputStart = charness.output.length;
  await charness.start(bootTimeoutMs, (runOutput) => runOutput.includes(launchLine) && fakeTelegram.listCalls('getUpdates').length > pollsBefore);
  assertMcpListeningOn(charness.output.slice(outputStart), schedulerMcpPort);
}

function readTodoCalls(label: string): FakeToolCall[] {
  return readJsonLines<FakeToolCall>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.toolCalls))
    .filter((call) => call.tool === 'todo_update' && call.issueKey === label);
}

/** The operator writes `label` + todo tokens; resolves the fake agent's `todo_update` call for it. */
async function publishThroughAgent(threadId: number, label: string, tokens: string): Promise<FakeToolCall> {
  fakeTelegram.pushOperatorMessage(threadId, `${label} ${tokens}`);
  await getCharness().waitFor(`the agent's todo_update for ${label}`, turnTimeoutMs, () => readTodoCalls(label).length > 0);
  return readTodoCalls(label)[0];
}

function readPrompts(): FakePrompt[] {
  return readJsonLines<FakePrompt>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.prompts));
}

/** The standalone reminders the agent read: a prompt with the reminder and no operator label. */
function listStandaloneReminders(): FakePrompt[] {
  return readPrompts().filter((prompt) => prompt.text.includes(reminderMarker) && !/\bTODO-\d+\b/.test(prompt.text));
}

/** The topic's stored list record, as a restart reads it. */
function readTopicTodoFile(): { lastUpdateAt?: number; nag?: { clockStartedAt?: number; workedMs: number; ignoredCount: number } } {
  return JSON.parse(fs.readFileSync(path.join(getLayout().dataDir, 'todos', `${group.id}_${topicAThreadId}.json`), 'utf8'));
}

/** Wait for a bot log line (after `outputStart`) that `pattern` matches. */
async function waitForLogLine(description: string, outputStart: number, pattern: RegExp): Promise<void> {
  await getCharness().waitFor(description, turnTimeoutMs, () => pattern.test(getCharness().output.slice(outputStart)));
}

/** The test ends one of the fake agent's background tasks; resolves once the turn it starts has answered. */
async function releaseBackgroundTask(): Promise<void> {
  const taskTurnsBefore = readTaskTurnCount();
  fs.writeFileSync(path.join(getLayout().fakeStateDir, fakeClaudeBackgroundReleaseFileName), '');
  await getCharness().waitFor('the background task\'s turn', turnTimeoutMs, () => readTaskTurnCount() > taskTurnsBefore);
}

function readTaskTurnCount(): number {
  return readJsonLines<{ origin?: string }>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.turns)).filter((turn) => turn.origin === 'task-notification').length;
}

function readSettingsFile(): { todo?: { isEnabled?: boolean; reminderMinutes?: number } } {
  return JSON.parse(fs.readFileSync(path.join(path.dirname(getLayout().envFile), isolatedSettingsFileName), 'utf8'));
}

/** The button labels of a message, row by row. */
function getKeyboardLabels(message: FakeTelegramMessage): string[][] {
  return (message.reply_markup?.inline_keyboard ?? []).map((row) => row.map((button) => button.text));
}

/** Tap `data` on `message` and wait for its toast and for the message to read `expectedText`. */
async function tapAndAwaitRerender(message: FakeTelegramMessage, data: string, expectedText: string, toast: string | null): Promise<void> {
  const answersBefore = fakeTelegram.callbackAnswers.length;
  fakeTelegram.pushCallback(message.message_id, data);
  await getCharness().waitFor(`the tap on ${data} answered`, replyTimeoutMs, () => fakeTelegram.callbackAnswers.length > answersBefore);
  if (toast !== null) assert.equal(fakeTelegram.callbackAnswers.at(-1), toast);
  await getCharness().waitFor(`the message re-rendered after ${data}`, replyTimeoutMs, () => (fakeTelegram.getMessage(message.message_id)?.text ?? '').includes(expectedText));
}

function removeInstanceSync(): void {
  removeIsolatedInstanceSync(layout, charness);
}

describe('Shared todo registry end to end: built charness, fake Bot API, fake claude', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-todo-', [folderA], getFlowDeadlineMs());
    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fakeTelegram = new FakeTelegram({ botUser, operator, admins: [], group });
    const apiRoot = await fakeTelegram.start();
    const claudeBin = writeFakeClaudeLauncher(layout, null);
    schedulerMcpPort = await getFreeFixedPort();
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
      CLAUDE_BIN: claudeBin,
      // A free port nothing listens on: the boot's OpenCode pre-start finds no server and no binary, and gives up.
      OPENCODE_URL: `http://127.0.0.1:${await getFreePort()}`,
      SCHEDULER_MCP_PORT: schedulerMcpPort.toString(),
      ...getTelegramFlowTestTimingsEnv({ todoReminderPollMs: reminderPollMs, todoReminderIntervalMs: reminderIntervalMs }),
    });
  });

  after(async () => {
    await charness?.stop();
    removeInstanceSync();
    await fakeTelegram?.stop();
    process.off('exit', removeInstanceSync);
    process.off('SIGINT', exitOnSignal);
    process.off('SIGTERM', exitOnSignal);
  });

  it('isolation holds before the first boot', () => {
    const instance = getLayout();
    const realHome = fs.realpathSync(os.homedir());
    for (const dir of [instance.instanceHome, instance.dataDir, instance.workRoot, instance.tmuxTmpDir]) {
      assert.ok(!dir.startsWith(`${realHome}${path.sep}`), `${dir} is outside the user's HOME`);
    }
    const envNames = getInstanceEnvNames(instance);
    for (const name of ['TELEGRAM_API_ROOT', 'TMUX_SOCKET_NAME', 'TMUX_TMPDIR', 'DATA_DIR', 'WORK_ROOT', 'CLAUDE_BIN']) assert.ok(envNames.includes(name), `${name} is set`);
  });

  it('boots, topic A is bound; an unbound topic\'s /todo asks for a bind first', async () => {
    await startCharness();
    await sendAndAwaitReply(topicAThreadId, `/bind ${folderA}`, `Bound to \`${folderA}\``);
    await sendAndAwaitReply(unboundThreadId, '/todo', 'Bind a folder first');
  });

  it('/todo before anything is published shows the empty state', async () => {
    const view = await sendAndAwaitReply(topicAThreadId, '/todo', '📋 Todo —');
    assert.equal(view.text, `📋 Todo — ${folderA}\n\nNothing published yet — the agent adds items when it starts work.`);
  });

  it('the agent publishes an in-work and a queued item: the tool answers with the list and /todo shows both', async () => {
    await sendAndAwaitReply(topicAThreadId, '/claude', 'ready in');
    const call = await publishThroughAgent(topicAThreadId, 'TODO-1', '[todo:inWork:Speed up limits flow tests] [todo:queued:Bump tsx]');
    assert.match(call.outcome, /^Saved\. New items: t1, t2\./);
    assert.match(call.outcome, /▶ in work:\n {2}t1 Speed up limits flow tests — since \d\d:\d\d/);
    const view = await sendAndAwaitReply(topicAThreadId, '/todo', '📋 Todo —');
    assert.match(view.text, /^📋 Todo — proj-a\n\n▶ In work\n {3}Speed up limits flow tests — since \d\d:\d\d\n\n▷ Queue\n {3}1\. Bump tsx$/);
  });

  it('the agent closes the in-work item: /todo lists it under «Done today»', async () => {
    const call = await publishThroughAgent(topicAThreadId, 'TODO-2', '[todo-id:t1:done]');
    assert.match(call.outcome, /^Saved\./);
    const view = await sendAndAwaitReply(topicAThreadId, '/todo', '📋 Todo —');
    assert.match(view.text, /▷ Queue\n {3}1\. Bump tsx\n\n✓ Done today\n {3}Speed up limits flow tests — \d\d:\d\d$/);
    assert.doesNotMatch(view.text, /In work/);
  });

  it('a restart keeps the list: it belongs to the topic', async () => {
    // The bot reads the agent's stream on its own pace: a turn that ends just before the stop is never seen ending, and
    // the reminder's clock (S2) would start a turn later. Restart only once the turn of the last update was seen ending.
    await getCharness().waitFor('the turn of the last update seen ending', turnTimeoutMs, () => readTopicTodoFile().nag?.clockStartedAt !== undefined);
    await getCharness().stop();
    await startCharness();
    const view = await sendAndAwaitReply(topicAThreadId, '/todo', '📋 Todo —');
    assert.match(view.text, /▷ Queue\n {3}1\. Bump tsx\n\n✓ Done today\n {3}Speed up limits flow tests/);
  });

  // ── S2 — the staleness reminder ───────────────────────────────────────

  it('an agent that works past the interval with no prompt reaching it gets ONE standalone reminder at the turn end', async () => {
    const remindersBefore = listStandaloneReminders().length;
    const outputStart = getCharness().output.length;
    fakeTelegram.pushOperatorMessage(topicAThreadId, `TODO-3 [work-ms:${longTurnWorkMs}]`);
    await getCharness().waitFor('the standalone reminder', turnTimeoutMs, () => listStandaloneReminders().length > remindersBefore);
    const [reminder] = listStandaloneReminders().slice(remindersBefore);
    assert.equal(reminder.requestId, null, 'the reminder opens no request');
    assert.match(reminder.text, /\[Todo\] Your published todo list was last updated \d+ min ago and you have worked since\. todo_update records in-work \/ queued \/ done; with no items it confirms the list is still accurate\. No text reply is needed\./);
    await waitForLogLine('the bot\'s reminder log line', outputStart, /\[todos\] -1001111111111:111: stale list — reminded the agent/);
    assert.ok(!readPrompts().find((prompt) => prompt.text.includes('TODO-3'))?.text.includes(reminderMarker), 'the prompt that started the work carried none: nothing was due yet');
    await getCharness().waitFor('the reminder counted', turnTimeoutMs, () => readTopicTodoFile().nag?.ignoredCount === 1);
    assert.equal(listStandaloneReminders().length, remindersBefore + 1, 'one reminder');
  });

  it('with a request left open the standalone reminder is held back; the person\'s next message carries the line', async () => {
    await sendAndAwaitReply(topicAThreadId, '/verbosity stream_answers', 'This topic shows: Stream + answers');
    const remindersBefore = listStandaloneReminders().length;
    const outputStart = getCharness().output.length;
    fakeTelegram.pushOperatorMessage(topicAThreadId, `TODO-4 [fake:progress] [work-ms:${longTurnWorkMs}]`);
    await waitForLogLine('the held-back reminder', outputStart, /stale list, no reminder: an open request/);
    assert.equal(listStandaloneReminders().length, remindersBefore, 'no standalone reminder while the request is open');
    fakeTelegram.pushOperatorMessage(topicAThreadId, 'TODO-5 [fake:answer]');
    await getCharness().waitFor('the prompt of TODO-5', turnTimeoutMs, () => readPrompts().some((prompt) => prompt.text.includes('TODO-5')));
    const prompt = readPrompts().find((candidate) => candidate.text.includes('TODO-5'));
    assert.ok(prompt?.text.includes(reminderMarker), 'the person\'s message carries the reminder line');
    assert.ok((prompt?.text.indexOf('TODO-5') ?? -1) < (prompt?.text.indexOf(reminderMarker) ?? -1), 'after the message itself');
  });

  it('an agent that keeps working on its own is reminded twice, then the bot stays silent', async () => {
    await sendAndAwaitReply(topicAThreadId, '/verbosity stream', 'This topic shows: Stream only');
    fakeTelegram.pushOperatorMessage(topicAThreadId, 'TODO-6 [fake:background-notify] [bg-count:3]');
    await getCharness().waitFor('the turn of TODO-6', turnTimeoutMs, () => readPrompts().some((prompt) => prompt.text.includes('TODO-6')));
    const remindersBefore = listStandaloneReminders().length;
    await releaseBackgroundTask();
    await getCharness().waitFor('the first reminder', turnTimeoutMs, () => listStandaloneReminders().length === remindersBefore + 1);
    await releaseBackgroundTask();
    await getCharness().waitFor('the second reminder', turnTimeoutMs, () => listStandaloneReminders().length === remindersBefore + 2);
    const outputStart = getCharness().output.length;
    await releaseBackgroundTask();
    await waitForLogLine('the silence', outputStart, /stale list, no reminder: silent after 2 ignored reminders/);
    assert.equal(listStandaloneReminders().length, remindersBefore + 2, 'no third reminder');
  });

  it('an update restarts the clock: the work of the turn it was made in does not count, the clock starts at its end', async () => {
    const sentAt = Date.now();
    await publishThroughAgent(topicAThreadId, 'TODO-7', `[todo-touch] [work-ms:${longTurnWorkMs}]`);
    assert.ok((readTopicTodoFile().lastUpdateAt ?? 0) >= sentAt);
    await getCharness().waitFor('the clock started at the turn end', turnTimeoutMs, () => (readTopicTodoFile().nag?.clockStartedAt ?? 0) > sentAt);
    assert.deepEqual({ workedMs: readTopicTodoFile().nag?.workedMs, ignoredCount: readTopicTodoFile().nag?.ignoredCount }, { workedMs: 0, ignoredCount: 0 });
  });

  // ── S2 — the settings in General ──────────────────────────────────────

  it('General\'s /todo opens the settings: an interval tap writes settings.json and moves the ✓', async () => {
    const general = await sendAndAwaitReply(generalTopicThreadId, '/todo', '📋 Todo — all projects');
    assert.deepEqual(getKeyboardLabels(general), [['Settings ▸']]);
    await tapAndAwaitRerender(general, 'todo_cfg', 'Todo settings', null);
    const settings = () => fakeTelegram.getMessage(general.message_id) ?? general;
    assert.equal(settings().text, 'Todo settings\n\nShared todo lists: on\nReminder when a list is stale: 1 h');
    assert.deepEqual(getKeyboardLabels(settings()), [['Turn off'], ['off', '30 min', '✓ 1 h', '2 h', '4 h'], ['‹ Back']]);
    await tapAndAwaitRerender(general, 'todo_rem_30', 'stale: 30 min', '✅ Saved');
    assert.deepEqual(getKeyboardLabels(settings())[1], ['off', '✓ 30 min', '1 h', '2 h', '4 h']);
    assert.deepEqual(readSettingsFile().todo, { reminderMinutes: 30 }, 'only the tapped field is written');
  });

  it('«Turn off» hides the intervals and a topic\'s /todo says the lists are off; «Turn on» brings them back', async () => {
    const general = [...fakeTelegram.listBotMessages(generalTopicThreadId)].reverse().find((message) => message.text.startsWith('Todo settings'));
    assert.ok(general, 'the settings screen is in General');
    await tapAndAwaitRerender(general, 'todo_off', 'Shared todo lists: off', '✅ Saved');
    assert.deepEqual(getKeyboardLabels(fakeTelegram.getMessage(general.message_id) ?? general), [['Turn on'], ['‹ Back']]);
    assert.deepEqual(readSettingsFile().todo, { reminderMinutes: 30, isEnabled: false });
    const view = await sendAndAwaitReply(topicAThreadId, '/todo', '📋 Todo —');
    assert.match(view.text, /Shared todo lists are off: agents are not offered them\. Turn them on in General\.$/);
    await tapAndAwaitRerender(general, 'todo_on', 'Shared todo lists: on', '✅ Saved');
    assert.equal(readSettingsFile().todo?.isEnabled, true);
  });
});
