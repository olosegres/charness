/**
 * @description The Telegram views end to end, at PROCESS level (request/answer
 * plan S6–S9): the BUILT charness, started the way an isolated instance is
 * started (`scripts/run-isolated.sh` with its own env file), serving Telegram
 * only, against a fake Bot API on loopback (`telegramE2e/fakeTelegram.ts`) and
 * a fake `claude` (`jiraE2e/fakeClaude.ts`, via `CLAUDE_BIN`) that answers
 * through the real bot MCP. The test plays the operator in one forum topic.
 * One flow, in order:
 *
 *   isolation checked before the boot: a private tmux server in a private
 *   TMUX_TMPDIR, a temp HOME, DATA_DIR and WORK_ROOT, a PATH with no real agent
 *   → the topic is bound to a folder
 *   → `/verbosity`: the picker shows the detail row and the view row, ✓ on the
 *     defaults; a tap on a view button persists it and re-renders the picker
 *   → `/status` names the view; the typed forms set a view and reject a bad one
 *   → charness restarted: the view survives
 *   → the fake agent started; in «Stream + answers» a message opens a request
 *     the agent answers through the bot MCP; in «Answers only» the header says
 *     the plain text and the thinking are not shown; in the full stream no request is opened; a
 *     silent turn is woken; `/schedule` and a scheduled run are requests too
 *   → every answer is pinned with a notification and only the latest stays
 *     pinned, across a restart; a restart that finds the bot MCP port held for a
 *     moment waits it out, so the re-adopted agent still answers; an agent that
 *     never answers gets a pinned alert, released when the next message
 *     supersedes its request
 *   → two messages in a row from the operator merge into ONE open request whose
 *     header names the replaced one and asks for only what it adds; two messages in
 *     a row from two people stay two open requests, each answered on its own
 *   → in «Answers only» a turn posts nothing but its pinned answer — no text, no
 *     status, no thinking, no tool result — while the typing indicator still
 *     runs; back in «Stream + answers» the same turn shows its stream again
 *
 * Nothing leaves the machine: the Bot API and the bot MCP are on loopback, the
 * agent is the fake. Everything the test starts is stopped in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FakeTelegram, type FakeTelegramCall, type FakeTelegramMessage } from './telegramE2e/fakeTelegram';
import { fakeClaudeLogFileNames, type FakeClaudeAnswer, type FakeClaudeTurn } from './jiraE2e/fakeClaudeContract';
import type { ClosedRequestRecord, OpenRequestState } from '../requests/types';
import type { ScheduleRecord } from '../scheduler/types';
import {
  assertMcpListeningOn,
  builtCliPath,
  createIsolatedInstanceLayout,
  exitOnSignal,
  getFreeFixedPort,
  getFreePort,
  getInstanceEnvNames,
  getProcessEnvNames,
  getTmuxEnv,
  getTmuxSocketDir,
  holdPort,
  IsolatedCharness,
  isolatedLaunchEnvNames,
  listTmuxSessions,
  readClosedRequests as readClosedRequestsOf,
  readJsonLines,
  removeIsolatedInstanceSync,
  writeFakeClaudeLauncher,
  writeInstanceEnvFile,
  type IsolatedInstanceLayout,
} from './e2e/isolatedCharness';

/** The repo's placeholder group and a topic in it; the operator is its creator. */
const group = { id: -1001111111111, title: 'ExampleGroup' };
const topicThreadId = 111;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
/** A second group admin: the bot serves them too, and their requests are their own (never merged with the operator's). */
const colleague = { id: 535353, is_bot: false, first_name: 'Colleague' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const projectFolder = 'proj';
/** The boot's last line before `bot.launch`, which resolves only when polling stops. */
const launchLine = 'Launching Telegraf bot (long polling';
const bootTimeoutMs = 60 * 1000;
/** A command's reply: a poll round trip and the paced send. */
const replyTimeoutMs = 20 * 1000;
/** A session start, a turn and the agent's answer through the bot MCP — or a silent turn plus its wake-up. */
const answerTimeoutMs = 60 * 1000;
const stopTimeoutMs = 20 * 1000;
const flowMarginMs = 60 * 1000;
const flowTimeoutMs = 4 * bootTimeoutMs + 16 * replyTimeoutMs + 12 * answerTimeoutMs + 4 * stopTimeoutMs + flowMarginMs;
/** How soon after the restart the seeded scheduled run is due. */
const seededRunDelayMs = 3 * 1000;

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let defaultTmuxSessionsBefore: string[] = [];
/** The bot MCP's port, the same on every start (see {@link assertMcpListeningOn}). */
let schedulerMcpPort = 0;

function getLayout(): IsolatedInstanceLayout {
  if (!layout) throw new Error('the instance layout is not created yet');
  return layout;
}

function getCharness(): IsolatedCharness {
  if (!charness) throw new Error('charness is not started yet');
  return charness;
}

/** The bot's messages in the test topic. */
function listTopicMessages(): FakeTelegramMessage[] {
  return fakeTelegram.listBotMessages(topicThreadId);
}

/** Wait for a bot message in the topic that `check` accepts, newest first; resolves it. */
async function waitForTopicMessage(description: string, check: (message: FakeTelegramMessage) => boolean): Promise<FakeTelegramMessage> {
  let found: FakeTelegramMessage | undefined;
  await getCharness().waitFor(description, replyTimeoutMs, () => {
    found = [...listTopicMessages()].reverse().find(check);
    return found !== undefined;
  });
  if (!found) throw new Error(`no message for ${description}`);
  return found;
}

/** The operator writes in the topic and the bot's next reply containing `expectedText` is awaited. */
async function sendAndAwaitReply(text: string, expectedText: string): Promise<FakeTelegramMessage> {
  const sentAfterId = fakeTelegram.pushOperatorMessage(topicThreadId, text);
  return waitForTopicMessage(`a reply to "${text}" with "${expectedText}"`, (message) => message.message_id > sentAfterId && message.text.includes(expectedText));
}

/** The button labels of a picker message, row by row. */
function getKeyboardLabels(message: FakeTelegramMessage): string[][] {
  return (message.reply_markup?.inline_keyboard ?? []).map((row) => row.map((button) => button.text));
}

function getKeyboardData(message: FakeTelegramMessage): string[][] {
  return (message.reply_markup?.inline_keyboard ?? []).map((row) => row.map((button) => button.callback_data));
}

/** Ready = the boot reached its launch AND this run's polling reached the fake, with the bot MCP on its fixed port. */
async function startCharness(): Promise<void> {
  charness ??= new IsolatedCharness(getLayout());
  const pollsBefore = fakeTelegram.listCalls('getUpdates').length;
  const outputStart = charness.output.length;
  await charness.start(bootTimeoutMs, (runOutput) => runOutput.includes(launchLine) && fakeTelegram.listCalls('getUpdates').length > pollsBefore);
  assertMcpListeningOn(charness.output.slice(outputStart), schedulerMcpPort);
}

/** The `displayPrefs` record of the test topic as persisted — what a restart reads. */
function readPersistedTopicPrefs(): Record<string, string> | undefined {
  const state = JSON.parse(fs.readFileSync(path.join(getLayout().dataDir, 'state.json'), 'utf8')) as { displayPrefs?: Record<string, Record<string, string>> };
  return state.displayPrefs?.[`${group.id}:${topicThreadId}`];
}

function readFakeLog<TRecord>(fileName: string): TRecord[] {
  return readJsonLines<TRecord>(path.join(getLayout().fakeLogDir, fileName));
}

/** The fake agent's turns whose text carried `label` (the `KEY-n` token of the operator's message). */
function getTurns(label: string): FakeClaudeTurn[] {
  return readFakeLog<FakeClaudeTurn>(fakeClaudeLogFileNames.turns).filter((turn) => turn.issueKey === label);
}

function getAnswers(label: string): FakeClaudeAnswer[] {
  return readFakeLog<FakeClaudeAnswer>(fakeClaudeLogFileNames.answers).filter((answer) => answer.issueKey === label);
}

/** Wait for the fake agent's first answer for `label` and resolve it. */
async function waitForFakeAnswer(label: string): Promise<FakeClaudeAnswer> {
  await getCharness().waitFor(`the fake agent's answer for ${label}`, answerTimeoutMs, () => getAnswers(label).length > 0);
  return getAnswers(label)[0];
}

/** The closed-request history the ledger keeps, oldest first. */
function readClosedRequests(): ClosedRequestRecord[] {
  return readClosedRequestsOf(getLayout());
}

function readPersistedState(): { openRequests?: Record<string, OpenRequestState>; schedules?: Record<string, ScheduleRecord> } & Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(getLayout().dataDir, 'state.json'), 'utf8'));
}

/** The open requests persisted for the test topic (`openRequests` is keyed by the topic's key plus the requester), oldest first. */
function listPersistedOpenTopicRequests(): OpenRequestState[] {
  return Object.entries(readPersistedState().openRequests ?? {})
    .filter(([groupKey]) => groupKey.startsWith(`${group.id}:${topicThreadId}`))
    .map(([, request]) => request)
    .sort((a, b) => a.createdAt - b.createdAt);
}

function removeInstanceSync(): void {
  removeIsolatedInstanceSync(layout, charness);
}

describe('Telegram views end to end: built charness, fake Bot API, fake claude (S6–S9)', { timeout: flowTimeoutMs }, () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-tg-', [projectFolder]);
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fakeTelegram = new FakeTelegram({ botUser, operator, admins: [colleague], group });
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
    assert.deepEqual(fs.readdirSync(instance.tmuxTmpDir), [], 'no tmux server of the instance is running yet');
    const realHome = fs.realpathSync(os.homedir());
    for (const dir of [instance.instanceHome, instance.dataDir, instance.workRoot, instance.tmuxTmpDir]) {
      assert.ok(!dir.startsWith(`${realHome}${path.sep}`), `${dir} is outside the user's HOME`);
    }
    const envNames = getInstanceEnvNames(instance);
    assert.ok(envNames.includes('TELEGRAM_API_ROOT'), 'the Bot API is the fake');
    for (const name of ['TMUX_SOCKET_NAME', 'TMUX_TMPDIR', 'DATA_DIR', 'WORK_ROOT', 'CLAUDE_BIN']) assert.ok(envNames.includes(name), `${name} is set`);
  });

  it('boots Telegram-only against the fake Bot API, started with nothing but run-isolated.sh\'s variables', async () => {
    await startCharness();
    const pid = getCharness().pid;
    const envNames = pid === undefined ? null : getProcessEnvNames(pid);
    if (envNames !== null) assert.deepEqual([...envNames].sort(), [...isolatedLaunchEnvNames].sort());
    assert.ok(fakeTelegram.listCalls('getMe').length > 0, 'the client reached the fake');
    assert.ok(fakeTelegram.listCalls('setMyCommands').length > 0, 'the commands menu was set on the fake');
  });

  it('the topic is bound to a folder and gets its pinned status banner', async () => {
    await sendAndAwaitReply(`/bind ${projectFolder}`, `Bound to \`${projectFolder}\``);
    await getCharness().waitFor('the status banner pin', replyTimeoutMs, () => fakeTelegram.listPinnedMessageIds().length === 1);
    // The banner's pin is silent — it is bookkeeping, not a notification.
    assert.deepEqual(fakeTelegram.pinEvents.map((event) => event.kind), ['pin']);
    assert.equal(fakeTelegram.pinEvents[0].isSilent, true);
  });

  // ── S6 — the view setting in /verbosity ──────────────────────────────

  it('/verbosity shows the detail row and the view row, ✓ on minimal and on the full stream', async () => {
    const picker = await sendAndAwaitReply('/verbosity', 'view: Stream only');
    assert.match(picker.text, /detail: minimal/);
    assert.deepEqual(getKeyboardLabels(picker), [
      ['minimal ✓', 'short', 'full'],
      ['Stream only ✓', 'Stream + answers', 'Answers only'],
    ]);
    assert.deepEqual(getKeyboardData(picker), [
      ['verb_minimal', 'verb_short', 'verb_full'],
      ['view_stream', 'view_streamAnswers', 'view_answers'],
    ]);
  });

  it('a tap on «Answers only» persists the view, answers the tap and moves the ✓', async () => {
    const picker = listTopicMessages().find((message) => message.text.includes('view: Stream only'));
    assert.ok(picker, 'the picker is in the topic');
    fakeTelegram.pushCallback(picker.message_id, 'view_answers');
    await getCharness().waitFor('the view tap answered', replyTimeoutMs, () => fakeTelegram.callbackAnswers.includes('This topic shows: Answers only'));
    await getCharness().waitFor('the picker re-rendered', replyTimeoutMs, () => getKeyboardLabels(picker)[1]?.[2] === 'Answers only ✓');
    assert.deepEqual(getKeyboardLabels(picker), [
      ['minimal ✓', 'short', 'full'],
      ['Stream only', 'Stream + answers', 'Answers only ✓'],
    ]);
    await getCharness().waitFor('the view persisted', replyTimeoutMs, () => readPersistedTopicPrefs()?.view === 'answers');
  });

  it('a detail tap keeps the view row: the picker re-renders both rows', async () => {
    const picker = listTopicMessages().find((message) => message.text.includes('view: Stream only'));
    assert.ok(picker, 'the picker is in the topic');
    fakeTelegram.pushCallback(picker.message_id, 'verb_full');
    await getCharness().waitFor('the detail tap re-rendered', replyTimeoutMs, () => getKeyboardLabels(picker)[0]?.[2] === 'full ✓');
    assert.deepEqual(getKeyboardLabels(picker), [
      ['minimal', 'short', 'full ✓'],
      ['Stream only', 'Stream + answers', 'Answers only ✓'],
    ]);
  });

  it('/status names the view', async () => {
    const status = await sendAndAwaitReply('/status', 'View: Answers only');
    assert.match(status.text, /Folder: proj/);
  });

  it('the typed form sets a view and rejects an unknown word with both vocabularies', async () => {
    await sendAndAwaitReply('/verbosity stream_answers', '✅ This topic shows: Stream + answers');
    await getCharness().waitFor('the typed view persisted', replyTimeoutMs, () => readPersistedTopicPrefs()?.view === 'streamAnswers');
    const rejected = await sendAndAwaitReply('/verbosity everything', 'is not valid');
    assert.match(rejected.text, /Detail levels: minimal, short, full/);
    assert.match(rejected.text, /Views: stream, stream_answers, answers/);
    // A fresh picker reflects both: the detail set by the earlier tap and the typed view.
    const picker = await sendAndAwaitReply('/verbosity', 'view: Stream + answers');
    assert.deepEqual(getKeyboardLabels(picker)[1], ['Stream only', 'Stream + answers ✓', 'Answers only']);
  });

  it('a restart keeps the view', async () => {
    await getCharness().stop();
    await startCharness();
    await sendAndAwaitReply('/status', 'View: Stream + answers');
  });

  // ── S7 — Telegram request intake ─────────────────────────────────────

  it('/claude starts the fake agent in the topic', async () => {
    await sendAndAwaitReply('/claude', 'ready in');
    assert.ok(listTmuxSessions(['-L', getLayout().tmuxSocketName], getTmuxEnv(getLayout().tmuxTmpDir)).length === 1, 'the agent runs on the private server');
  });

  it('in «Stream + answers» an operator message opens a request; the agent answers it through the bot MCP into the topic', async () => {
    fakeTelegram.pushOperatorMessage(topicThreadId, 'TOPIC-1 [fake:answer]');
    const answer = await waitForFakeAnswer('TOPIC-1');
    const [turn] = getTurns('TOPIC-1');
    assert.match(turn.requestId ?? '', /^req_/, 'the prompt carried a request header');
    assert.equal(turn.isRequestPrompt, true);
    assert.equal(turn.isPlainTextHidden, false, 'the stream is shown in this view, so the header does not claim the plain text and thinking are hidden');
    assert.equal(answer.kind, 'final');
    assert.ok(answer.outcome.startsWith('Delivered'), answer.outcome);
    await waitForTopicMessage('the answer in the topic', (message) => message.text.includes('Fake final answer for TOPIC-1'));
    await getCharness().waitFor('the request closed', replyTimeoutMs, () => readClosedRequests().some((record) => record.id === turn.requestId));
    const closed = readClosedRequests().find((record) => record.id === turn.requestId);
    assert.equal(closed?.closeReason, 'final');
    assert.deepEqual(closed?.origin, { kind: 'message', attributes: { source: 'text', requester: operator.id.toString() } }, 'the origin names the sender: the merge key\'s requester');
  });

  it('in «Answers only» the header tells the agent its plain text and thinking are not shown', async () => {
    await sendAndAwaitReply('/verbosity answers', 'This topic shows: Answers only');
    fakeTelegram.pushOperatorMessage(topicThreadId, 'TOPIC-2 [fake:answer]');
    await waitForFakeAnswer('TOPIC-2');
    assert.equal(getTurns('TOPIC-2')[0].isPlainTextHidden, true, 'the prompt the agent received carries the line that only its answer_request answers reach the user');
  });

  it('in the full stream no request is opened: the agent gets the bare message and its stream shows', async () => {
    await sendAndAwaitReply('/verbosity stream', 'This topic shows: Stream only');
    fakeTelegram.pushOperatorMessage(topicThreadId, 'TOPIC-3 [fake:answer]');
    await getCharness().waitFor('the turn for TOPIC-3', answerTimeoutMs, () => getTurns('TOPIC-3').length > 0);
    assert.equal(getTurns('TOPIC-3')[0].requestId, null, 'no request header');
    await waitForTopicMessage('the agent\'s stream text', (message) => message.text.includes('Working on TOPIC-3'));
    assert.deepEqual(getAnswers('TOPIC-3'), [], 'nothing to answer');
    assert.deepEqual(listPersistedOpenTopicRequests(), [], 'no request is open for the topic');
  });

  it('a turn that ends without an answer is woken, and the answer follows', async () => {
    await sendAndAwaitReply('/verbosity stream_answers', 'This topic shows: Stream + answers');
    fakeTelegram.pushOperatorMessage(topicThreadId, 'TOPIC-4 [fake:silent-once]');
    await waitForFakeAnswer('TOPIC-4');
    assert.deepEqual(getTurns('TOPIC-4').map((turn) => turn.isRequestPrompt), [true, false], 'the request, then a reminder');
    assert.equal(new Set(getTurns('TOPIC-4').map((turn) => turn.requestId)).size, 1, 'one request from start to end');
  });

  it('/schedule hands the agent a request too', async () => {
    fakeTelegram.pushOperatorMessage(topicThreadId, '/schedule TOPIC-5 [fake:answer]');
    await waitForFakeAnswer('TOPIC-5');
    const [turn] = getTurns('TOPIC-5');
    assert.equal(turn.isRequestPrompt, true);
    await getCharness().waitFor('the /schedule request closed', replyTimeoutMs, () => readClosedRequests().some((record) => record.id === turn.requestId));
    assert.deepEqual(readClosedRequests().find((record) => record.id === turn.requestId)?.origin, { kind: 'message', attributes: { source: 'schedule', requester: operator.id.toString() } });
  });

  it('a scheduled run fires as a request: the announcement is pinned and the agent answers it', async () => {
    // Seeded into the store while the bot is down, the way a persisted job re-arms at boot.
    await getCharness().stop();
    const persisted = readPersistedState();
    const dueAt = Date.now() + seededRunDelayMs;
    const seeded: ScheduleRecord = {
      id: 'run-topic-6-seeded',
      threadKey: `${group.id}:${topicThreadId}`,
      name: 'Run TOPIC-6',
      spec: { kind: 'once', onceAtIso: new Date(dueAt).toISOString() },
      prompt: 'TOPIC-6 [fake:answer]',
      createdBy: 'user',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nextRunAt: dueAt,
    };
    persisted.schedules = { ...(persisted.schedules ?? {}), [seeded.id]: seeded };
    fs.writeFileSync(path.join(getLayout().dataDir, 'state.json'), JSON.stringify(persisted));
    await startCharness();

    await waitForTopicMessage('the fire announcement', (message) => message.text.includes('Schedule "Run TOPIC-6"'));
    await waitForFakeAnswer('TOPIC-6');
    const [turn] = getTurns('TOPIC-6');
    assert.equal(turn.isRequestPrompt, true);
    await getCharness().waitFor('the scheduled run\'s request closed', replyTimeoutMs, () => readClosedRequests().some((record) => record.id === turn.requestId));
    assert.deepEqual(
      readClosedRequests().find((record) => record.id === turn.requestId)?.origin,
      { kind: 'scheduledRun', attributes: { source: 'scheduledRun', requester: 'scheduler' } },
      'a scheduled run is the scheduler\'s request, never merged with a person\'s',
    );
  });

  // ── S8 — pinned answer delivery ──────────────────────────────────────

  /** The bot message in the topic whose text contains `text`. */
  function findTopicMessage(text: string): FakeTelegramMessage {
    const message = listTopicMessages().find((candidate) => candidate.text.includes(text));
    assert.ok(message, `a topic message with "${text}"`);
    return message;
  }

  /** The pin events of `messageId`, in order (`pin` / `unpin`). */
  function getPinKinds(messageId: number): string[] {
    return fakeTelegram.pinEvents.filter((event) => event.messageId === messageId).map((event) => event.kind);
  }

  it('every answer so far was pinned with a notification, and only the latest answer is still pinned', async () => {
    const answerTexts = ['TOPIC-1', 'TOPIC-2', 'TOPIC-4', 'TOPIC-5', 'TOPIC-6'].map((label) => `Fake final answer for ${label}`);
    const answerIds = answerTexts.map((text) => findTopicMessage(text).message_id);
    await getCharness().waitFor('the latest answer pinned', replyTimeoutMs, () => fakeTelegram.listPinnedMessageIds().includes(answerIds[answerIds.length - 1]));
    for (const messageId of answerIds) {
      const pin = fakeTelegram.pinEvents.find((event) => event.kind === 'pin' && event.messageId === messageId);
      assert.ok(pin, `answer ${messageId} was pinned`);
      assert.equal(pin.isSilent, false, 'an answer pin notifies the muted topic');
    }
    // The earlier answers were released in order; the last one still holds the pin.
    for (const messageId of answerIds.slice(0, -1)) assert.deepEqual(getPinKinds(messageId), ['pin', 'unpin'], `answer ${messageId}`);
    assert.deepEqual(getPinKinds(answerIds[answerIds.length - 1]), ['pin']);
    const pinnedAnswers = fakeTelegram.listPinnedMessageIds().filter((messageId) => answerIds.includes(messageId));
    assert.deepEqual(pinnedAnswers, [answerIds[answerIds.length - 1]]);
  });

  it('the status banner and the scheduled run\'s announcement keep their own pins', () => {
    const banner = fakeTelegram.pinEvents[0];
    assert.deepEqual(getPinKinds(banner.messageId), ['pin'], 'the banner pin was never touched');
    const announcement = findTopicMessage('Schedule "Run TOPIC-6"');
    assert.deepEqual(getPinKinds(announcement.message_id), ['pin'], 'the scheduled run\'s pin is a separate record');
  });

  it('after a restart the next answer still unpins the one pinned before it', async () => {
    const latestBefore = findTopicMessage('Fake final answer for TOPIC-6').message_id;
    await getCharness().stop();
    await startCharness();
    fakeTelegram.pushOperatorMessage(topicThreadId, 'TOPIC-7 [fake:answer]');
    await waitForFakeAnswer('TOPIC-7');
    const answer = await waitForTopicMessage('the answer after the restart', (message) => message.text.includes('Fake final answer for TOPIC-7'));
    await getCharness().waitFor('the pin moved to the new answer', replyTimeoutMs, () =>
      getPinKinds(answer.message_id).includes('pin') && getPinKinds(latestBefore).includes('unpin'));
    assert.ok(!fakeTelegram.listPinnedMessageIds().includes(latestBefore));
  });

  it('a restart that finds the bot MCP port held for a moment waits it out: the same port is bound and the re-adopted agent still answers', async () => {
    await getCharness().stop();
    const holder = await holdPort(schedulerMcpPort);
    const outputStart = getCharness().output.length;
    const takenLine = `requested port ${schedulerMcpPort} is in use`;
    try {
      // The holder lets go only once the boot has met it: a start that never meets it proves nothing.
      await Promise.all([
        startCharness(),
        getCharness().waitFor('the boot to find the bot MCP port taken', bootTimeoutMs, () => getCharness().output.slice(outputStart).includes(takenLine))
          .then(() => holder.release()),
      ]);
    } finally {
      await holder.release();
    }
    assert.ok(getCharness().output.slice(outputStart).includes(`${takenLine}; retrying`), 'the boot waited for the port instead of falling back');
    // The agent keeps the MCP address of its launch: its answer arrives only if the bot is still on that port.
    fakeTelegram.pushOperatorMessage(topicThreadId, 'TOPIC-12 [fake:answer]');
    await waitForFakeAnswer('TOPIC-12');
    await waitForTopicMessage('the answer after the port wait', (message) => message.text.includes('Fake final answer for TOPIC-12'));
  });

  it('an agent that never answers gets a pinned alert; the next message supersedes the request and releases the alert', async () => {
    fakeTelegram.pushOperatorMessage(topicThreadId, 'TOPIC-8 [fake:silent]');
    // Two silent turns in a row: the request's own, then the reminder's.
    await getCharness().waitFor('two silent turns', answerTimeoutMs, () => getTurns('TOPIC-8').length >= 2);
    const [turn] = getTurns('TOPIC-8');
    const alert = await waitForTopicMessage('the alert', (message) => message.text.includes(`Request ${turn.requestId} got no answer`));
    await getCharness().waitFor('the alert pinned', replyTimeoutMs, () => getPinKinds(alert.message_id).includes('pin'));
    assert.equal(fakeTelegram.pinEvents.find((event) => event.kind === 'pin' && event.messageId === alert.message_id)?.isSilent, false, 'the alert notifies');
    assert.deepEqual(getAnswers('TOPIC-8'), [], 'nothing was answered');

    fakeTelegram.pushOperatorMessage(topicThreadId, 'TOPIC-9 [fake:answer]');
    await waitForFakeAnswer('TOPIC-9');
    await getCharness().waitFor('the alert released', replyTimeoutMs, () => getPinKinds(alert.message_id).includes('unpin'));
    await getCharness().waitFor('the silent request closed as superseded', replyTimeoutMs, () =>
      readClosedRequests().find((record) => record.id === turn.requestId)?.closeReason === 'superseded');
  });

  it('two messages in a row from the operator merge into one open request; its header names the replaced one, answered once', async () => {
    // The first turn stays silent, so its request is still open when the second message lands a moment later.
    fakeTelegram.pushOperatorMessage(topicThreadId, 'TOPIC-20 [fake:silent-once]');
    fakeTelegram.pushOperatorMessage(topicThreadId, 'TOPIC-21 [fake:answer]');
    const answer = await waitForFakeAnswer('TOPIC-21');
    assert.ok(answer.outcome.startsWith('Delivered'), answer.outcome);
    const [firstTurn] = getTurns('TOPIC-20');
    const [secondTurn] = getTurns('TOPIC-21');
    assert.deepEqual(secondTurn.supersededRequestIds, [firstTurn.requestId], 'the second request\'s header names the first as replaced');
    assert.deepEqual(firstTurn.supersededRequestIds, [], 'the first replaced nothing');

    await getCharness().waitFor('the first request closed as superseded', replyTimeoutMs, () =>
      readClosedRequests().some((record) => record.id === firstTurn.requestId));
    const superseded = readClosedRequests().find((record) => record.id === firstTurn.requestId);
    assert.equal(superseded?.closeReason, 'superseded');
    assert.equal(superseded?.supersededBy, secondTurn.requestId, 'the history names the request that replaced it');
    await getCharness().waitFor('the second request closed by its answer', replyTimeoutMs, () =>
      readClosedRequests().find((record) => record.id === secondTurn.requestId)?.closeReason === 'final');
    assert.deepEqual(getAnswers('TOPIC-20'), [], 'the replaced request is never answered on its own — no reminder wakes it');
    assert.equal(listTopicMessages().filter((message) => message.text.includes('Fake final answer for TOPIC-21')).length, 1, 'one answer in the topic');
  });

  it('two messages in a row from two people stay two open requests, each answered on its own', async () => {
    fakeTelegram.pushOperatorMessage(topicThreadId, 'TOPIC-22 [fake:silent-once]');
    fakeTelegram.pushUserMessage(topicThreadId, 'TOPIC-23 [fake:answer]', colleague);
    await waitForFakeAnswer('TOPIC-23');
    const [operatorTurn] = getTurns('TOPIC-22');
    const [colleagueTurn] = getTurns('TOPIC-23');
    assert.deepEqual(colleagueTurn.supersededRequestIds, [], 'the colleague\'s request replaced nothing: the operator\'s is not theirs');

    // The operator's silent turn is woken and answered on its own — it was never superseded.
    const operatorAnswer = await waitForFakeAnswer('TOPIC-22');
    assert.ok(operatorAnswer.outcome.startsWith('Delivered'), operatorAnswer.outcome);
    assert.equal(operatorAnswer.requestId, operatorTurn.requestId);
    await getCharness().waitFor('both requests closed by their own answers', replyTimeoutMs, () =>
      [operatorTurn.requestId, colleagueTurn.requestId].every((id) => readClosedRequests().find((record) => record.id === id)?.closeReason === 'final'));
    assert.deepEqual(getTurns('TOPIC-22').map((turn) => turn.isRequestPrompt), [true, false], 'the operator\'s request, then its reminder');
    await waitForTopicMessage('the operator\'s answer in the topic', (message) => message.text.includes('Fake final answer for TOPIC-22'));
    await waitForTopicMessage('the colleague\'s answer in the topic', (message) => message.text.includes('Fake final answer for TOPIC-23'));
  });

  // ── S9 — answers-only suppression ────────────────────────────────────

  /**
   * The topic a Bot API call addressed: its own `message_thread_id`, or — for an
   * edit, which names only the message — the thread of the message it edits.
   * Filtering edits by `message_thread_id` would count none and prove nothing.
   */
  function getCallThreadId(call: FakeTelegramCall): number | undefined {
    if (call.payload.message_thread_id !== undefined) return Number(call.payload.message_thread_id);
    return fakeTelegram.getMessage(Number(call.payload.message_id))?.message_thread_id;
  }

  /** How many calls of `method` the fake has seen for the test topic. */
  function countTopicCalls(method: string): number {
    return fakeTelegram.listCalls(method).filter((call) => getCallThreadId(call) === topicThreadId).length;
  }

  it('in «Answers only» a turn posts nothing but its pinned answer, while the typing indicator still runs', async () => {
    await sendAndAwaitReply('/verbosity answers', 'This topic shows: Answers only');
    const sendsBefore = countTopicCalls('sendMessage');
    const editsBefore = countTopicCalls('editMessageText');
    const typingBefore = countTopicCalls('sendChatAction');

    fakeTelegram.pushOperatorMessage(topicThreadId, 'TOPIC-10 [fake:answer]');
    await waitForFakeAnswer('TOPIC-10');
    const answer = await waitForTopicMessage('the pinned answer', (message) => message.text.includes('Fake final answer for TOPIC-10'));
    await getCharness().waitFor('the answer pinned', replyTimeoutMs, () => getPinKinds(answer.message_id).includes('pin'));
    // The fake streamed a status frame, a thinking block, a tool call with its result and answer text (`emitTurnActivity`)
    // — none of it was posted or edited into the topic: the only new message is the answer.
    assert.equal(countTopicCalls('sendMessage') - sendsBefore, 1, 'exactly one new message: the answer');
    assert.equal(countTopicCalls('editMessageText') - editsBefore, 0, 'no status or thinking frame was edited');
    assert.ok(listTopicMessages().every((message) => !message.text.includes('Working on TOPIC-10')), 'the agent\'s text stayed out of the topic');
    assert.ok(countTopicCalls('sendChatAction') > typingBefore, 'the typing indicator still ran during the turn');
  });

  it('back in «Stream + answers» the same turn shows its stream again, beside the pinned answer', async () => {
    await sendAndAwaitReply('/verbosity stream_answers', 'This topic shows: Stream + answers');
    fakeTelegram.pushOperatorMessage(topicThreadId, 'TOPIC-11 [fake:answer]');
    await waitForFakeAnswer('TOPIC-11');
    await waitForTopicMessage('the agent\'s stream text', (message) => message.text.includes('Working on TOPIC-11'));
    const answer = await waitForTopicMessage('the pinned answer', (message) => message.text.includes('Fake final answer for TOPIC-11'));
    await getCharness().waitFor('the answer pinned', replyTimeoutMs, () => getPinKinds(answer.message_id).includes('pin'));
  });

  it('every tmux call named the private server; nothing of the instance runs on the default tmux server', () => {
    const instance = getLayout();
    // A call without `-L` would have started (or reached) a `default` server beside the named one.
    assert.deepEqual(fs.readdirSync(getTmuxSocketDir(instance.tmuxTmpDir)), [instance.tmuxSocketName], 'one tmux server, the named one');
    const instanceSessions = new Set(listTmuxSessions(['-L', instance.tmuxSocketName], getTmuxEnv(instance.tmuxTmpDir)));
    assert.ok(instanceSessions.size > 0, 'the agent runs on the private server');
    const defaultSessionsNow = listTmuxSessions([]);
    assert.deepEqual(defaultSessionsNow.filter((name) => instanceSessions.has(name)), []);
    assert.deepEqual(defaultSessionsNow.filter((name) => !defaultTmuxSessionsBefore.includes(name) && name.includes(group.id.toString())), []);
  });
});
