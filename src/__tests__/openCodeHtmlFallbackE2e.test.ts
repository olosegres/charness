/**
 * @description Telegram REFUSING the markup of an HTML message the bot EDITS, on an OpenCode topic, at PROCESS level: the BUILT
 * charness started the way an isolated instance is (`scripts/run-isolated.sh`) against the fake Bot API
 * (`telegramE2e/fakeTelegram.ts`, whose `failNextCall` answers «can't parse entities») and the fake OpenCode server
 * (`openCodeE2e/fakeOpenCodeServer.ts`). Every text here holds `<&>`, so its HTML (`&lt;&amp;&gt;`) and its source text differ:
 * the retry is right only if it carries the SOURCE text — a retry that resends the HTML without a parse mode shows the
 * entities. One flow, in order:
 *
 *   boot → a topic bound to a folder runs an OpenCode session
 *   → a streamed answer continued in place (the first chunk of the output is EDITED): the edit is refused, the message ends as
 *     the source text, no `parse_mode`
 *   → a tool call's transient status line («🔧 …» → «✅ …», the status frame is EDITED): same
 *   → `/thinking full`: the thinking frame — its first send refused (the CREATE falls back to the source text), then its
 *     edit refused (the EDIT does)
 *   → a delegation (`task` tool): the sub-agent status message — its first send refused (the CREATE falls back), then the
 *     refresh of its timer refused (the EDIT does).
 *
 * The status frame's CREATE with a refusal is `telegramViewsE2e.test.ts` (the Claude backend).
 *
 * Nothing leaves the machine: the Bot API and the OpenCode server are on loopback. Everything the test starts is stopped in
 * `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram, type FakeTelegramCall, type FakeTelegramMessage } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import { FakeOpenCodeServer, writeFakeOpenCodeBinary } from './openCodeE2e/fakeOpenCodeServer';
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
import { startCharnessOnInstance } from './e2e/fallbackFlowKit';
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';

const fallbackTopic = { threadId: 181, folder: 'html-fallback' };
const fakeOpenCodeVersion = '1.17.11';
const model = 'example/model-one';
const openCodeModels = [model] as const;
const replyTimeoutMs = 20 * 1000;
/** The sub-agent status message is refreshed by a 10 s timer (`subagentTickMs` in `bot.ts`): a refresh is waited for this long. */
const subagentRefreshTimeoutMs = 40 * 1000;
/** What Telegram answers for markup it cannot parse. */
const cannotParseDescription = 'Bad Request: can\'t parse entities: Unsupported start tag "x" at byte offset 0';

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let fakeOpenCode: FakeOpenCodeServer;
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

function getTopicSessionId(): string {
  const folderPath = path.join(getLayout().workRoot, fallbackTopic.folder);
  const session = [...fakeOpenCode.sessions.values()].find((candidate) => candidate.directory === folderPath);
  assert.ok(session, `a fake OpenCode session for ${folderPath}`);
  return session.id;
}

/** The operator types `text` and the prompt reaches the fake server. */
async function sendPrompt(text: string): Promise<void> {
  fakeTelegram.pushOperatorMessage(fallbackTopic.threadId, text);
  await getCharness().waitFor(`the prompt «${text}» to reach the server`, replyTimeoutMs, () => fakeOpenCode.prompts.some((prompt) => prompt.text.includes(text)));
}

/** A turn begins: the prompt arrives and the session is busy. Resolves the session id. */
async function beginTurn(promptText: string): Promise<string> {
  await sendPrompt(promptText);
  const sessionId = getTopicSessionId();
  fakeOpenCode.emitSessionBusy(sessionId);
  return sessionId;
}

/** The calls of `method` that touched message `messageId`, in order (an edit carries no thread id). */
function listCallsOnMessage(method: string, messageId: number): FakeTelegramCall[] {
  return fakeTelegram.listCalls(method).filter((call) => call.payload.message_id === messageId);
}

/** Refuse the markup of the next HTML edit of message `messageId`. */
function refuseNextHtmlEditOf(messageId: number): void {
  fakeTelegram.failNextCall('editMessageText', cannotParseDescription, (payload) => payload.parse_mode === 'HTML' && payload.message_id === messageId);
}

/** The text and parse mode of each call, the pair a test compares. */
function describeCalls(calls: FakeTelegramCall[]): Array<[unknown, unknown]> {
  return calls.map((call) => [call.payload.text, call.payload.parse_mode]);
}

async function waitForMessageText(description: string, text: string): Promise<FakeTelegramMessage> {
  return topic.waitForMessage(description, (message) => message.text === text);
}

describe('Telegram refusing the markup of an EDIT on an OpenCode topic: built charness, fake Bot API, fake OpenCode', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-ochtml-', [fallbackTopic.folder], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    topic = new TopicDriver(fakeTelegram, getCharness, fallbackTopic.threadId, replyTimeoutMs);
    const apiRoot = await fakeTelegram.start();
    fakeOpenCode = new FakeOpenCodeServer({ version: fakeOpenCodeVersion, models: openCodeModels, defaultModel: model });
    const openCodeUrl = await fakeOpenCode.start(await getFreePort());
    writeFakeOpenCodeBinary(layout.binDir, { version: fakeOpenCodeVersion, models: openCodeModels });
    writeInstanceEnvFile(layout, {
      TELEGRAM_BOT_TOKEN: fakeBotToken,
      TELEGRAM_API_ROOT: apiRoot,
      ALLOWED_GROUP_ID: group.id.toString(),
      CHAT_MODE: 'group',
      DATA_DIR: layout.dataDir,
      WORK_ROOT: layout.workRoot,
      TMUX_TMPDIR: layout.tmuxTmpDir,
      CLAUDE_BIN: writeFakeClaudeLauncher(layout, null),
      OPENCODE_URL: openCodeUrl,
      SCHEDULER_MCP_PORT: (await getFreeFixedPort()).toString(),
      ...getTelegramFlowTestTimingsEnv(),
    });
  });

  after(async () => {
    await charness?.stop();
    removeInstanceSync();
    await fakeTelegram?.stop();
    await fakeOpenCode?.stop();
    process.off('exit', removeInstanceSync);
    process.off('SIGINT', exitOnSignal);
    process.off('SIGTERM', exitOnSignal);
    assert.deepEqual(listTmuxSessions([]), defaultTmuxSessionsBefore, 'the default tmux server was not touched');
    assert.deepEqual(fakeOpenCode.unhandled, [], 'the bot asked the fake OpenCode for nothing it does not model');
  });

  it('boots, binds the topic and starts an OpenCode session', async () => {
    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    await topic.sendAndAwaitReply(`/bind ${fallbackTopic.folder}`, `Bound to \`${fallbackTopic.folder}\``);
    await topic.sendAndAwaitReply('/opencode', 'ready in');
  });

  it('the first chunk of a streamed answer, EDITED in place: Telegram refuses the HTML, the message ends as the source text without a parse mode', async () => {
    const sessionId = await beginTurn('HTML-1 read the parser');
    fakeOpenCode.emitAssistantText(sessionId, 'msg_h1', 'Reading <&> in the parser');
    const first = await waitForMessageText('the first words', 'Reading &lt;&amp;&gt; in the parser');
    refuseNextHtmlEditOf(first.message_id);
    fakeOpenCode.emitAssistantText(sessionId, 'msg_h1', ' and then more');

    const plainText = 'Reading <&> in the parser and then more';
    await waitForMessageText('the answer continued in place', plainText);
    assert.deepEqual(
      describeCalls(listCallsOnMessage('editMessageText', first.message_id)),
      [['Reading &lt;&amp;&gt; in the parser and then more', 'HTML'], [plainText, undefined]],
      'the HTML edit was refused once, then the SOURCE text went out without a parse mode — not the entities',
    );
    assert.equal(fakeTelegram.getMessage(first.message_id)?.text, plainText);
    fakeOpenCode.emitSessionIdle(sessionId);
  });

  it('a tool call\'s status line, EDITED in place: Telegram refuses the HTML, the line ends as the source text', async () => {
    const sessionId = await beginTurn('HTML-2 run it');
    fakeOpenCode.emitToolPart(sessionId, 'msg_h2', 'bash', { status: 'running', title: 'Run <&> script' });
    const status = await waitForMessageText('the «🔧» status line', '🔧 Run &lt;&amp;&gt; script...');
    refuseNextHtmlEditOf(status.message_id);
    fakeOpenCode.emitToolPart(sessionId, 'msg_h2', 'bash', { status: 'completed', title: 'Run <&> script' });

    await waitForMessageText('the «✅» status line', '✅ Run <&> script');
    assert.deepEqual(
      describeCalls(listCallsOnMessage('editMessageText', status.message_id)),
      [['✅ Run &lt;&amp;&gt; script', 'HTML'], ['✅ Run <&> script', undefined]],
      'the refused HTML edit, then the source text without a parse mode',
    );
    fakeOpenCode.emitSessionIdle(sessionId);
  });

  it('the thinking frame: its first send refused (the CREATE falls back to the source text), then its edit refused (the EDIT does)', async () => {
    await topic.sendAndAwaitReply('/thinking full', '✅ Thinking mode: full');
    const sessionId = await beginTurn('HTML-3 think');
    fakeTelegram.failNextCall('sendMessage', cannotParseDescription, (payload) => payload.parse_mode === 'HTML' && String(payload.text).includes('Pondering &lt;&amp;&gt; first'));
    fakeOpenCode.emitReasoningText(sessionId, 'msg_h3', 'Pondering <&> first');

    const createdPlain = '•••\n\nPondering <&> first';
    const frame = await waitForMessageText('the thinking frame as plain text', createdPlain);
    const frameSends = fakeTelegram.listCalls('sendMessage').filter((call) => String(call.payload.text).includes('Pondering'));
    assert.deepEqual(
      describeCalls(frameSends),
      [['•••\n\nPondering &lt;&amp;&gt; first', 'HTML'], [createdPlain, undefined]],
      'the refused HTML create, then the source text — the entities are not shown',
    );

    refuseNextHtmlEditOf(frame.message_id);
    fakeOpenCode.emitReasoningText(sessionId, 'msg_h3', ' and second');
    const editedPlain = '•••\n\nPondering <&> first and second';
    await waitForMessageText('the thinking frame edited as plain text', editedPlain);
    assert.deepEqual(
      describeCalls(listCallsOnMessage('editMessageText', frame.message_id)),
      [['•••\n\nPondering &lt;&amp;&gt; first and second', 'HTML'], [editedPlain, undefined]],
      'the refused HTML edit, then the source text without a parse mode',
    );
    fakeOpenCode.emitSessionIdle(sessionId);
  });

  it('the sub-agent status message: its CREATE refused falls back to the source text, and so does the REFRESH of its timer', async () => {
    const sessionId = await beginTurn('HTML-4 delegate it');
    const subagentSourcePattern = /^🤖 sub-agent: Explore <&> code · \d+:\d{2}$/;
    const subagentHtmlPattern = /^🤖 sub-agent: Explore &lt;&amp;&gt; code · \d+:\d{2}$/;
    fakeTelegram.failNextCall('sendMessage', cannotParseDescription, (payload) => payload.parse_mode === 'HTML' && String(payload.text).startsWith('🤖 sub-agent: Explore &lt;'));
    fakeOpenCode.emitToolPart(sessionId, 'msg_h4', 'task', { status: 'running', title: 'Explore <&> code', input: { description: 'Explore <&> code' } });
    const frame = await topic.waitForMessage('the sub-agent status message as plain text', (message) => subagentSourcePattern.test(message.text));
    const createSends = fakeTelegram.listCalls('sendMessage').filter((call) => String(call.payload.text).startsWith('🤖 sub-agent: Explore'));
    assert.equal(createSends.length, 2, 'the HTML create was refused once, then retried');
    assert.equal(createSends[0].payload.parse_mode, 'HTML');
    assert.match(String(createSends[0].payload.text), subagentHtmlPattern, 'the refused create carried the escaped title');
    assert.equal(createSends[1].payload.parse_mode, undefined, 'the retry went out without a parse mode');
    assert.match(String(createSends[1].payload.text), subagentSourcePattern, 'and carried the source title: no entity shown');

    refuseNextHtmlEditOf(frame.message_id);
    await getCharness().waitFor('the timer refresh to be retried as plain text', subagentRefreshTimeoutMs, () => listCallsOnMessage('editMessageText', frame.message_id).length >= 2);
    const [refused, retried] = listCallsOnMessage('editMessageText', frame.message_id);
    assert.equal(refused.payload.parse_mode, 'HTML');
    assert.match(String(refused.payload.text), subagentHtmlPattern, 'the refused refresh carried the escaped title');
    assert.equal(retried.payload.parse_mode, undefined, 'the retry went out without a parse mode');
    assert.match(String(retried.payload.text), subagentSourcePattern, 'and carried the source title: no entity shown');
    fakeOpenCode.emitToolPart(sessionId, 'msg_h4', 'task', { status: 'completed', title: 'Explore <&> code' });
    fakeOpenCode.emitSessionIdle(sessionId);
  });
});
