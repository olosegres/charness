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
 *     the intervals and a topic's `/todo` says the lists are off; «Turn on» brings them back (the reminder is then set
 *     off, so the board steps below see no reminder prompts)
 *   → the project board (topic A's folder a git repository, topic B's a clone of it): B's first prompt carries the
 *     whole board with A's list; A's next prompt only what changed, the one after nothing — and B's change did not wake
 *     A; a fresh session and a compaction in B bring the whole board again; the picker: «Own project» takes B off the
 *     board at once, «Automatic» brings it back; a topic on a folder that is no checkout joins A's project by hand;
 *     General's `/todo` lists the project with its topics
 *   → mid-turn (S4): while B works, A publishes; B gets A's change with its next tool result — the launch settings'
 *     `PostToolUse` hook prints B's inbox, as the real CLI runs it — and B's next prompt does not repeat it; a turn
 *     that ends with no tool call after a change withdraws its inbox, and so does a session stopped mid-turn (`/quit`);
 *     the next prompt carries the change
 *   → a prompt never waits for git: topic D on a new clone whose history walk git holds back (a `git` in the
 *     instance's bin folder) — its prompt reaches the agent at once, with no board, and B's fresh context gets its own
 *     list alone; once git answered, the whole board for both
 *
 * Nothing leaves the machine: the Bot API and the bot MCP are on loopback, the agent is the fake. Everything the test
 * starts is stopped in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FakeTelegram, generalTopicThreadId, type FakeTelegramMessage } from './telegramE2e/fakeTelegram';
import { fakeClaudeBackgroundReleaseFileName, fakeClaudeLogFileNames, fakeClaudeMcpServersFileName, type FakeClaudeHookContext } from './jiraE2e/fakeClaudeContract';
import { legacySchedulerMcpServerName } from '../legacyNames';
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
/** A second checkout (a clone) of topic A's repository, and a folder that is no checkout at all. */
const folderB = 'proj-b';
const folderNotes = 'notes';
const topicBThreadId = 222;
const topicCThreadId = 444;
/** A topic on another clone of A's repository, bound while git is slow to walk its history. */
const folderD = 'proj-d';
const topicDThreadId = 555;
/** While this file (in the test root) exists, the instance's `git` holds every history walk back. */
const gitHoldFileName = 'git-hold';
/** Where the instance's `git` logs each history walk it starts and ends. */
const gitWalkLogFileName = 'git-walks.log';
/** Well inside git's own 30 s bound for the walk: a prompt that waited for it would miss this. */
const promptPastHeldGitMs = 15 * 1000;
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
/** How long into its turn B makes the tool call whose hook delivers A's change (A publishes meanwhile). */
const midTurnToolDelayMs = 8000;
/** A turn long enough to be stopped by `/quit` while it works. */
const stoppedTurnWorkMs = 30 * 1000;
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

/** A topic's stored list record, as a restart reads it. */
function readTopicTodoFileOf(threadId: number): { lastUpdateAt?: number; nag?: { clockStartedAt?: number; workedMs: number; ignoredCount: number }; boardSeen?: object } {
  return JSON.parse(fs.readFileSync(path.join(getLayout().dataDir, 'todos', `${group.id}_${threadId}.json`), 'utf8'));
}

function readTopicTodoFile(): ReturnType<typeof readTopicTodoFileOf> {
  return readTopicTodoFileOf(topicAThreadId);
}

/** The text of the prompt the fake agent read for `label`. */
function getPromptOf(label: string): string {
  const prompt = readPrompts().find((candidate) => new RegExp(`\\b${label}\\b`).test(candidate.text));
  if (!prompt) throw new Error(`no prompt for ${label}`);
  return prompt.text;
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

/** The most `/compact` attempts while the agent still finishes the turn before. */
const compactAttempts = 5;

function countCompactions(): number {
  return readJsonLines(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.compactions)).length;
}

/**
 * `/compact` in a topic until the agent ran the compaction: the bot announces it, then refuses it while the agent is
 * still in its turn ("busy" — a tool call the fake logged does not mean its turn is over). Resolves once a compaction
 * turn ran.
 */
async function compactWhenIdle(threadId: number): Promise<void> {
  const compactionsBefore = countCompactions();
  for (let attempt = 1; attempt <= compactAttempts; attempt += 1) {
    const sentAfterId = fakeTelegram.pushOperatorMessage(threadId, '/compact');
    let isRefusedAsBusy = false;
    await getCharness().waitFor('the compaction or its refusal', turnTimeoutMs, () => {
      isRefusedAsBusy = fakeTelegram.listBotMessages(threadId).some((message) => message.message_id > sentAfterId && message.text.includes('The agent is busy right now'));
      return isRefusedAsBusy || countCompactions() > compactionsBefore;
    });
    if (!isRefusedAsBusy) return;
  }
  throw new Error(`/compact was refused as busy ${compactAttempts} times`);
}

/**
 * The instance's `git` (its bin folder is first on its PATH): the real one, except that a history walk
 * (`rev-list`) waits while the hold file exists, and is logged — with the folder its `-C` names, wherever the bot puts it among
 * the options (`-c core.fsmonitor=false -C <folder> rev-list …`) — when it starts and ends.
 */
function writeHoldingGit(instance: IsolatedInstanceLayout): void {
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const holdPath = path.join(instance.testRoot, gitHoldFileName);
  const logPath = path.join(instance.testRoot, gitWalkLogFileName);
  fs.writeFileSync(path.join(instance.binDir, 'git'), [
    '#!/bin/sh',
    "folder=''; previous=''",
    'for argument in "$@"; do [ "$previous" = -C ] && folder=$argument; previous=$argument; done',
    'case " $* " in',
    `  *" rev-list "*) echo "start $folder" >> '${logPath}'; while [ -e '${holdPath}' ]; do sleep 0.1; done; '${realGit}' "$@"; status=$?; echo "end $folder" >> '${logPath}'; exit $status;;`,
    'esac',
    `exec '${realGit}' "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
}

/** What waits in the instance's mid-turn inbox dir. */
function listInboxFiles(): string[] {
  const inboxDir = path.join(getLayout().dataDir, 'todos', 'inbox');
  return fs.existsSync(inboxDir) ? fs.readdirSync(inboxDir) : [];
}

function readGitWalkLog(): string {
  const logPath = path.join(getLayout().testRoot, gitWalkLogFileName);
  return fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
}

function removeInstanceSync(): void {
  removeIsolatedInstanceSync(layout, charness);
}

describe('Shared todo registry end to end: built charness, fake Bot API, fake claude', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-todo-', [folderA, folderB, folderNotes], getFlowDeadlineMs());
    // Topic A's folder is a git repository and topic B's a clone of it: one project by root commit (D15).
    const runGit = (cwd: string, ...args: string[]): void => {
      execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-c', 'init.defaultBranch=main', ...args], { cwd, stdio: 'ignore' });
    };
    const repoA = path.join(layout.workRoot, folderA);
    runGit(repoA, 'init', '-q');
    fs.writeFileSync(path.join(repoA, 'README.md'), '# proj\n');
    runGit(repoA, 'add', '.');
    runGit(repoA, 'commit', '-q', '-m', 'first');
    runGit(layout.workRoot, 'clone', '-q', repoA, path.join(layout.workRoot, folderB));
    writeHoldingGit(layout);
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
    assert.equal(view.text, `📋 Todo — ${folderA}\n\nNothing published yet — the agent adds items when it starts work.\n\nProject: ${folderA} · topics: 1 (automatic)`);
    assert.deepEqual(getKeyboardLabels(view), [['Project ▸']]);
  });

  it('the agent publishes an in-work and a queued item: the tool answers with the list and /todo shows both', async () => {
    await sendAndAwaitReply(topicAThreadId, '/claude', 'ready in');
    const call = await publishThroughAgent(topicAThreadId, 'TODO-1', '[todo:inWork:Speed up limits flow tests] [todo:queued:Bump tsx]');
    assert.match(call.outcome, /^Saved\. New items: t1, t2\./);
    assert.match(call.outcome, /▶ in work:\n {2}t1 Speed up limits flow tests — since \d\d:\d\d/);
    const view = await sendAndAwaitReply(topicAThreadId, '/todo', '📋 Todo —');
    assert.match(view.text, /^📋 Todo — proj-a\n\n▶ In work\n {3}Speed up limits flow tests — since \d\d:\d\d\n\n▷ Queue\n {3}1\. Bump tsx\n\nProject: proj-a · topics: 1 \(automatic\)$/);
  });

  it('the agent closes the in-work item: /todo lists it under «Done today»', async () => {
    const call = await publishThroughAgent(topicAThreadId, 'TODO-2', '[todo-id:t1:done]');
    assert.match(call.outcome, /^Saved\./);
    const view = await sendAndAwaitReply(topicAThreadId, '/todo', '📋 Todo —');
    assert.match(view.text, /▷ Queue\n {3}1\. Bump tsx\n\n✓ Done today\n {3}Speed up limits flow tests — \d\d:\d\d\n\nProject: proj-a/);
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

  it('a restart repairs the bot server of an agent started before the rename, under the name that agent still holds', async () => {
    // An agent launched by the bot before the rename holds its bot server as the old name, and the CLI never retries one that failed
    // (the bot was down): its status names the old server `failed`, and nothing is listed under the current name.
    fs.writeFileSync(path.join(getLayout().fakeStateDir, fakeClaudeMcpServersFileName), JSON.stringify([{ name: legacySchedulerMcpServerName, status: 'failed' }]));
    const outputStart = getCharness().output.length;
    await getCharness().stop();
    await startCharness();

    await waitForLogLine('the boot repair of the old-name server', outputStart, new RegExp(
      `\\[scheduler\\] MCP heal: reconnected ${legacySchedulerMcpServerName} in ${group.id}:${topicAThreadId} — the agent started before the rename`,
    ));
    const reconnects = readJsonLines<{ pid: number; serverName: string }>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.mcpReconnects));
    assert.ok(reconnects.length > 0, 'the bot asked an agent to reconnect');
    assert.deepEqual([...new Set(reconnects.map((reconnect) => reconnect.serverName))], [legacySchedulerMcpServerName], 'under the name the agent holds, never the current one');
    assert.doesNotMatch(getCharness().output.slice(outputStart), /MCP heal: reconnected charness /, 'nothing was reported repaired under a name no agent listed');
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
    assert.match(view.text, /\n\nShared todo lists are off: agents are not offered them\. Turn them on in General\.$/);
    await tapAndAwaitRerender(general, 'todo_on', 'Shared todo lists: on', '✅ Saved');
    assert.equal(readSettingsFile().todo?.isEnabled, true);
    await tapAndAwaitRerender(general, 'todo_rem_0', 'stale: off', '✅ Saved');
    assert.deepEqual(readSettingsFile().todo, { reminderMinutes: 0, isEnabled: true });
  });

  // ── S3 — the project board ────────────────────────────────────────────

  it('a topic on another checkout of the same repository is in A\'s project: its first prompt carries the whole board', async () => {
    await sendAndAwaitReply(topicBThreadId, `/bind ${folderB}`, `Bound to \`${folderB}\``);
    await sendAndAwaitReply(topicBThreadId, '/claude', 'ready in');
    const call = await publishThroughAgent(topicBThreadId, 'TODO-21', '[todo:inWork:Fix the footer]');
    const prompt = getPromptOf('TODO-21');
    assert.match(prompt, /\[Project board · proj-a · 1 other topic\]\n#topic 111 \(proj-a\) — (active|working)[^\n]*\n {2}▷ queue: 1\. Bump tsx/);
    assert.match(call.outcome, /\n\nNo changes in the project's other topics since \d\d:\d\d\.$/, 'the tool result says nothing changed since the prompt');
  });

  it('A\'s next prompt carries only what changed — B\'s item —, the one after nothing; B\'s change never woke A', async () => {
    assert.equal(readPrompts().filter((prompt) => !/\bTODO-\d+\b/.test(prompt.text)).length, listStandaloneReminders().length, 'no prompt without a label but the reminders: nothing woke A for the board');
    await publishThroughAgent(topicAThreadId, 'TODO-22', '[todo-touch]');
    assert.match(getPromptOf('TODO-22'), /\[Project board — changes since \d\d:\d\d\]\n#topic 222 \(proj-b\) — [^\n]*\n {2}▶ Fix the footer — since \d\d:\d\d/);
    await publishThroughAgent(topicAThreadId, 'TODO-23', '[todo-touch]');
    assert.doesNotMatch(getPromptOf('TODO-23'), /Project board/);
  });

  it('a fresh session and a completed compaction in B each bring the whole board (and B\'s own list) again', async () => {
    await publishThroughAgent(topicBThreadId, 'TODO-24', '[todo-touch]');
    assert.doesNotMatch(getPromptOf('TODO-24'), /Project board/, 'nothing changed for B');
    await sendAndAwaitReply(topicBThreadId, '/new', 'ready in');
    await publishThroughAgent(topicBThreadId, 'TODO-25', '[todo-touch]');
    assert.match(getPromptOf('TODO-25'), /\[Project board · proj-a · 1 other topic\][\s\S]*\n\nYour published todo list:\n▶ in work:\n {2}t1 Fix the footer/);
    await compactWhenIdle(topicBThreadId);
    await getCharness().waitFor('the board forgotten after the compaction', turnTimeoutMs, () => readTopicTodoFileOf(topicBThreadId).boardSeen === undefined);
    await publishThroughAgent(topicBThreadId, 'TODO-26', '[todo-touch]');
    assert.match(getPromptOf('TODO-26'), /\[Project board · proj-a · 1 other topic\]/);
  });

  it('the picker: «Own project» takes B off the board at once; «Automatic» brings it back', async () => {
    const view = await sendAndAwaitReply(topicBThreadId, '/todo', '📋 Todo —');
    assert.match(view.text, /\n\nProject: proj-a · topics: 2 \(automatic\)$/);
    await tapAndAwaitRerender(view, 'todo_prj', 'Project for proj-b', null);
    const picker = (): FakeTelegramMessage => fakeTelegram.getMessage(view.message_id) ?? view;
    assert.equal(picker().text, 'Project for proj-b\n\nNow: proj-a — automatic · topics: 2');
    assert.deepEqual(getKeyboardLabels(picker()), [['✓ Automatic'], ['Join the project of #topic 111 (proj-a)'], ['Own project'], ['‹ Back']]);
    await tapAndAwaitRerender(view, 'todo_prj_own', 'Now: proj-b — own project · topics: 1', '✅ Project: proj-b');
    await publishThroughAgent(topicAThreadId, 'TODO-27', '[todo:queued:Write the docs]');
    await publishThroughAgent(topicBThreadId, 'TODO-28', '[todo-touch]');
    assert.doesNotMatch(getPromptOf('TODO-28'), /Project board/, 'B is alone in its own project');
    await tapAndAwaitRerender(view, 'todo_prj_auto', 'Now: proj-a — automatic · topics: 2', '✅ Project: proj-a');
    await publishThroughAgent(topicBThreadId, 'TODO-29', '[todo-touch]');
    assert.match(getPromptOf('TODO-29'), /\[Project board — changes since \d\d:\d\d\]\n#topic 111 \(proj-a\)[\s\S]*Write the docs/);
    await tapAndAwaitRerender(view, 'todo_list', 'Project: proj-a · topics: 2 (automatic)', null);
  });

  it('a topic on a folder that is no checkout is a project of its own and joins A\'s by hand', async () => {
    await sendAndAwaitReply(topicCThreadId, `/bind ${folderNotes}`, `Bound to \`${folderNotes}\``);
    const view = await sendAndAwaitReply(topicCThreadId, '/todo', '📋 Todo —');
    assert.match(view.text, /Project: notes · topics: 1 \(automatic\)$/);
    await tapAndAwaitRerender(view, 'todo_prj', 'Project for notes', null);
    const labels = getKeyboardLabels(fakeTelegram.getMessage(view.message_id) ?? view);
    const joinIndex = labels.flat().filter((label) => label.startsWith('Join the project of')).indexOf('Join the project of #topic 111 (proj-a)');
    assert.ok(joinIndex >= 0, JSON.stringify(labels));
    await tapAndAwaitRerender(view, `todo_prj_join_${joinIndex}`, 'Now: proj-a — joined by hand · topics: 3', '✅ Project: proj-a');
    const persisted = JSON.parse(fs.readFileSync(path.join(getLayout().dataDir, 'state.json'), 'utf8')) as { todoProjectOverrides?: Record<string, unknown> };
    assert.deepEqual(persisted.todoProjectOverrides, { [`${group.id}:${topicCThreadId}`]: { kind: 'join', conversationKey: `${group.id}:${topicAThreadId}` } });
  });

  it('General\'s /todo lists the project with its topics', async () => {
    const board = await sendAndAwaitReply(generalTopicThreadId, '/todo', '📋 Todo — all projects');
    assert.match(board.text, /\n\nproj-a · topics: 3\n {3}#topic 111 \(proj-a\) {3}nothing in work · queue 2\n {3}#topic 222 \(proj-b\) {3}▶ Fix the footer\n {3}#topic 444 \(notes\) {3}asleep · nothing in work$/);
  });

  // ── S4 — mid-turn delivery ────────────────────────────────────────────

  it('a working agent gets another topic\'s change with its next tool result (the PostToolUse inbox hook); its next prompt does not repeat it', async () => {
    const readHookContexts = (): FakeClaudeHookContext[] => readJsonLines<FakeClaudeHookContext>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.hooks)).filter((record) => record.issueKey === 'TODO-31');
    fakeTelegram.pushOperatorMessage(topicBThreadId, `TODO-31 [tool-after-ms:${midTurnToolDelayMs}]`);
    await getCharness().waitFor('B working on TODO-31', turnTimeoutMs, () => readPrompts().some((prompt) => /\bTODO-31\b/.test(prompt.text)));
    await publishThroughAgent(topicAThreadId, 'TODO-32', '[todo:queued:Mid-turn item]');
    await getCharness().waitFor('B\'s next tool result carried the change', turnTimeoutMs, () => readHookContexts().length > 0);
    assert.match(readHookContexts()[0].additionalContext, /^\[Project board — changes since \d\d:\d\d\]\n#topic 111 \(proj-a\) — [^\n]*[\s\S]*Mid-turn item/);
    assert.deepEqual(fs.readdirSync(path.join(getLayout().dataDir, 'todos', 'inbox')), [], 'the inbox was taken whole');
    // Seen once taken: the bot's next poll finds the inbox gone; B's next prompt brings nothing more.
    await getCharness().waitFor('the change counted as seen', turnTimeoutMs, () => {
      const seen = (readTopicTodoFileOf(topicBThreadId).boardSeen as { revisions?: Record<string, number> } | undefined)?.revisions ?? {};
      const revisionOfA = (JSON.parse(fs.readFileSync(path.join(getLayout().dataDir, 'todos', `${group.id}_${topicAThreadId}.json`), 'utf8')) as { revision: number }).revision;
      return seen[`${group.id}:${topicAThreadId}`] === revisionOfA;
    });
    await publishThroughAgent(topicBThreadId, 'TODO-33', '[todo-touch]');
    assert.doesNotMatch(getPromptOf('TODO-33'), /Mid-turn item/);
  });

  it('a turn that ends with no tool call after the change withdraws the inbox: empty between turns, the next prompt carries it', async () => {
    fakeTelegram.pushOperatorMessage(topicBThreadId, `TODO-35 [work-ms:${midTurnToolDelayMs}]`);
    await getCharness().waitFor('B working on TODO-35', turnTimeoutMs, () => readPrompts().some((prompt) => /\bTODO-35\b/.test(prompt.text)));
    await publishThroughAgent(topicAThreadId, 'TODO-36', '[todo:queued:Untaken item]');
    await getCharness().waitFor('B\'s inbox written while it works', turnTimeoutMs, () => listInboxFiles().length > 0);
    await getCharness().waitFor('the inbox withdrawn at B\'s turn end', turnTimeoutMs, () => listInboxFiles().length === 0);
    await publishThroughAgent(topicBThreadId, 'TODO-37', '[todo-touch]');
    assert.match(getPromptOf('TODO-37'), /\[Project board — changes since \d\d:\d\d\]\n#topic 111 \(proj-a\)[\s\S]*Untaken item/, 'still unseen: the next prompt carries it');
  });

  it('a session stopped mid-turn while its inbox waits withdraws it; the new session\'s whole board carries the change', async () => {
    fakeTelegram.pushOperatorMessage(topicBThreadId, `TODO-38 [work-ms:${stoppedTurnWorkMs}]`);
    await getCharness().waitFor('B working on TODO-38', turnTimeoutMs, () => readPrompts().some((prompt) => /\bTODO-38\b/.test(prompt.text)));
    await publishThroughAgent(topicAThreadId, 'TODO-39', '[todo:queued:Stopped-turn item]');
    await getCharness().waitFor('B\'s inbox written while it works', turnTimeoutMs, () => listInboxFiles().length > 0);
    await sendAndAwaitReply(topicBThreadId, '/quit', 'stopped');
    await getCharness().waitFor('the inbox withdrawn when B\'s session stopped', replyTimeoutMs, () => listInboxFiles().length === 0);
    await sendAndAwaitReply(topicBThreadId, '/claude', 'ready in');
    await publishThroughAgent(topicBThreadId, 'TODO-40', '[todo-touch]');
    assert.match(getPromptOf('TODO-40'), /\[Project board · proj-a · 1 other topic\][\s\S]*Stopped-turn item/, 'a fresh context carries the whole board, the change made while B worked included');
  });

  // ── no prompt waits for git ───────────────────────────────────────────

  it('a prompt never waits for git: a new clone\'s held history walk lets it through with no board; once git answered, the whole board', async () => {
    const instance = getLayout();
    const folderPathD = path.join(instance.workRoot, folderD);
    execFileSync('git', ['clone', '-q', path.join(instance.workRoot, folderA), folderPathD], { stdio: 'ignore' });
    const holdPath = path.join(instance.testRoot, gitHoldFileName);
    fs.writeFileSync(holdPath, '');
    await sendAndAwaitReply(topicDThreadId, `/bind ${folderD}`, `Bound to \`${folderD}\``);
    await sendAndAwaitReply(topicDThreadId, '/claude', 'ready in');
    fakeTelegram.pushOperatorMessage(topicDThreadId, 'TODO-41');
    await getCharness().waitFor('D\'s prompt while git walks its history', promptPastHeldGitMs, () => readPrompts().some((prompt) => /\bTODO-41\b/.test(prompt.text)));
    assert.ok(readGitWalkLog().includes(`start ${folderPathD}`) && !readGitWalkLog().includes(`end ${folderPathD}`), 'the walk was still held when the prompt went through');
    assert.doesNotMatch(getPromptOf('TODO-41'), /Project board/, 'no board while the grouping is unknown');
    // Every board waits for the grouping; a fresh context still gets its own list.
    await sendAndAwaitReply(topicBThreadId, '/new', 'ready in');
    fakeTelegram.pushOperatorMessage(topicBThreadId, 'TODO-43');
    await getCharness().waitFor('B\'s prompt on a fresh context', promptPastHeldGitMs, () => readPrompts().some((prompt) => /\bTODO-43\b/.test(prompt.text)));
    assert.doesNotMatch(getPromptOf('TODO-43'), /Project board/);
    assert.match(getPromptOf('TODO-43'), /\n\nYour published todo list:\n▶ in work:\n {2}t1 Fix the footer/);
    fs.rmSync(holdPath);
    await getCharness().waitFor('git answered', turnTimeoutMs, () => readGitWalkLog().includes(`end ${folderPathD}`));
    fakeTelegram.pushOperatorMessage(topicDThreadId, 'TODO-42');
    await getCharness().waitFor('D\'s next prompt', turnTimeoutMs, () => readPrompts().some((prompt) => /\bTODO-42\b/.test(prompt.text)));
    assert.match(getPromptOf('TODO-42'), /\[Project board · proj-a · 2 other topics\]/, 'nothing was marked seen: the whole board');
    fakeTelegram.pushOperatorMessage(topicBThreadId, 'TODO-44');
    await getCharness().waitFor('B\'s next prompt', turnTimeoutMs, () => readPrompts().some((prompt) => /\bTODO-44\b/.test(prompt.text)));
    assert.match(getPromptOf('TODO-44'), /\[Project board · proj-a · 1 other topic\]/, 'B\'s fresh context gets the whole board now');
  });
});
