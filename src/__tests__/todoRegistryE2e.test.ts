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
import { FakeTelegram, type FakeTelegramMessage } from './telegramE2e/fakeTelegram';
import { fakeClaudeLogFileNames } from './jiraE2e/fakeClaudeContract';
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
    await getCharness().stop();
    await startCharness();
    const view = await sendAndAwaitReply(topicAThreadId, '/todo', '📋 Todo —');
    assert.match(view.text, /▷ Queue\n {3}1\. Bump tsx\n\n✓ Done today\n {3}Speed up limits flow tests/);
  });
});
