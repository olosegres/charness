/**
 * @description The todo list's staleness reminder where it must NOT go out on its own (shared todo registry S2, D12)
 * and the per-turn backend (D10), at PROCESS level: the BUILT charness started the way an isolated instance is
 * (`scripts/run-isolated.sh`) against the fake Bot API (`telegramE2e/fakeTelegram.ts`) and the fake `claude`
 * (`jiraE2e/fakeClaude.ts`), a 4 s reminder interval through the test-timing seam. Topics P and M work on two checkouts
 * of one repository; L on a folder of its own. One flow, in order:
 *
 *   boot → P runs the per-turn backend: the process stops after every turn, and the adapter's turn end still starts
 *   the reminder's clock; a turn past the interval is held back — the session sleeps after every turn, it is never
 *   woken for a reminder — and P's next message carries the reminder line instead
 *   → while the bot is down, M is put on an account billed to API credits and L on an account marked limited
 *   → M works past the interval: held back, billed to API credits (never spend money unasked); M's first prompt is a
 *   fresh session and carries the whole board with P's list
 *   → P's next prompt, after its per-turn stop and resume, carries only what changed — a stop is no fresh context, the
 *   one the running bot sees (its `suspended` event) neither
 *   → L works past the interval: held back, its account is limited
 *   → T shows «Answers only»: a final answer ends a turn past the interval — held back while the text after that
 *   answer is followed
 *
 *   → Q asks the operator a question and waits on it past the interval: no reminder while the question is pinned, and
 *   none at the turn end after it is answered — waiting is no work
 *
 * Busy and input not taken in are what a turn end is NOT: a poll never decides at such a moment, so they are
 * unit-tested only (`todoReminder.test.ts`).
 *
 * Nothing leaves the machine. Everything the test starts is stopped in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import { fakeAskQuestion, fakeClaudeLogFileNames, type FakeClaudePrompt } from './jiraE2e/fakeClaudeContract';
import {
  builtCliPath,
  createIsolatedInstanceLayout,
  exitOnSignal,
  getFlowDeadlineMs,
  getFreeFixedPort,
  getFreePort,
  getTmuxEnv,
  IsolatedCharness,
  listTmuxSessions,
  readJsonLines,
  removeIsolatedInstanceSync,
  writeFakeClaudeLauncher,
  writeInstanceEnvFile,
  type IsolatedInstanceLayout,
} from './e2e/isolatedCharness';
import { restartCharnessWithState, startCharnessOnInstance } from './e2e/fallbackFlowKit';
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';
import { createClaudeProfileLayout } from '../utils/claudeProfiles';
import { buildJsonStreamTmuxSessionName } from '../utils/jsonStreamHost';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const topicP = { threadId: 191, folder: 'repo-p' };
const topicM = { threadId: 192, folder: 'repo-m' };
const topicL = { threadId: 193, folder: 'plain-l' };
const topicT = { threadId: 194, folder: 'plain-t' };
const topicQ = { threadId: 195, folder: 'plain-q' };
const meteredAccount = 'metered';
const cappedAccount = 'capped';
const replyTimeoutMs = 20 * 1000;
const turnTimeoutMs = 60 * 1000;
const reminderIntervalMs = 4000;
const reminderPollMs = 500;
/** A turn that works past the interval. */
const longTurnWorkMs = 5000;
const reminderMarker = '[Todo] Your published todo list was last updated';

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
const drivers = new Map<number, TopicDriver>();
let defaultTmuxSessionsBefore: string[] = [];

function getLayout(): IsolatedInstanceLayout {
  if (!layout) throw new Error('the instance layout is not created yet');
  return layout;
}

function getCharness(): IsolatedCharness {
  if (!charness) throw new Error('charness is not started yet');
  return charness;
}

function getDriver(threadId: number): TopicDriver {
  const driver = drivers.get(threadId);
  if (!driver) throw new Error(`no driver for topic ${threadId}`);
  return driver;
}

function removeInstanceSync(): void {
  removeIsolatedInstanceSync(layout, charness);
}

function readPrompts(): FakeClaudePrompt[] {
  return readJsonLines<FakeClaudePrompt>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.prompts));
}

function getPromptOf(label: string): string {
  const prompt = readPrompts().find((candidate) => new RegExp(`\\b${label}\\b`).test(candidate.text));
  if (!prompt) throw new Error(`no prompt for ${label}`);
  return prompt.text;
}

function readTopicTodoFile(threadId: number): { nag?: { clockStartedAt?: number; workedMs?: number }; lastTurnEndAt?: number } {
  const filePath = path.join(getLayout().dataDir, 'todos', `${group.id}_${threadId}.json`);
  return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : {};
}

/** The operator writes `label` + `tokens`; resolves once the agent read the prompt. */
async function sendToAgent(threadId: number, label: string, tokens = ''): Promise<void> {
  fakeTelegram.pushOperatorMessage(threadId, `${label} ${tokens}`.trim());
  await getCharness().waitFor(`the prompt of ${label}`, turnTimeoutMs, () => readPrompts().some((prompt) => new RegExp(`\\b${label}\\b`).test(prompt.text)));
}

/** The agent publishes (`[todo:inWork:…]`) and the bot sees that turn end: the reminder's clock starts. */
async function publishAndAwaitClock(threadId: number, label: string, title: string): Promise<void> {
  await sendToAgent(threadId, label, `[todo:inWork:${title}]`);
  await getCharness().waitFor(`${label}: the clock started at the turn end`, turnTimeoutMs, () => readTopicTodoFile(threadId).nag?.clockStartedAt !== undefined);
}

/**
 * The per-turn process that read the topic's last prompt stopped after its turn: its tmux session on the instance's
 * private server is gone (one name serves every process of the topic, and the next starts only after the stop).
 */
async function awaitPerTurnStop(threadId: number): Promise<void> {
  const sessionName = buildJsonStreamTmuxSessionName(makeTelegramKey(group.id, threadId));
  await getCharness().waitFor(`topic ${threadId} stopped after its turn`, turnTimeoutMs, () => (
    !listTmuxSessions(['-L', getLayout().tmuxSocketName], getTmuxEnv(getLayout().tmuxTmpDir)).includes(sessionName)
  ));
}

/** The agent works past the interval; resolves on the bot's line that a due reminder was held back for `reason`. */
async function workAndAwaitHeldBack(threadId: number, label: string, reason: RegExp): Promise<string> {
  const outputStart = getCharness().output.length;
  await sendToAgent(threadId, label, `[work-ms:${longTurnWorkMs}]`);
  const linePattern = new RegExp(`\\[todos\\] ${group.id}:${threadId}: stale list, no reminder: [^\\n]*`);
  let line = '';
  await getCharness().waitFor(`${label}: the held-back reminder`, turnTimeoutMs, () => {
    line = linePattern.exec(getCharness().output.slice(outputStart))?.[0] ?? '';
    return line !== '';
  });
  assert.match(line, reason);
  assert.ok(!getCharness().output.slice(outputStart).includes(`[todos] ${group.id}:${threadId}: stale list — reminded the agent`), 'no standalone reminder');
  return line;
}

describe('The todo reminder\'s held-back cases and the per-turn backend: built charness, fake Bot API, fake claude (S2)', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-todoskip-', [topicP.folder, topicM.folder, topicL.folder, topicT.folder, topicQ.folder], getFlowDeadlineMs());
    const runGit = (cwd: string, ...args: string[]): void => {
      execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-c', 'init.defaultBranch=main', ...args], { cwd, stdio: 'ignore' });
    };
    const repoP = path.join(layout.workRoot, topicP.folder);
    runGit(repoP, 'init', '-q');
    fs.writeFileSync(path.join(repoP, 'README.md'), '# repo\n');
    runGit(repoP, 'add', '.');
    runGit(repoP, 'commit', '-q', '-m', 'first');
    runGit(layout.workRoot, 'clone', '-q', repoP, path.join(layout.workRoot, topicM.folder));
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    for (const topic of [topicP, topicM, topicL, topicT, topicQ]) drivers.set(topic.threadId, new TopicDriver(fakeTelegram, getCharness, topic.threadId, replyTimeoutMs));
    const apiRoot = await fakeTelegram.start();
    writeInstanceEnvFile(layout, {
      TELEGRAM_BOT_TOKEN: fakeBotToken,
      TELEGRAM_API_ROOT: apiRoot,
      ALLOWED_GROUP_ID: group.id.toString(),
      CHAT_MODE: 'group',
      DATA_DIR: layout.dataDir,
      WORK_ROOT: layout.workRoot,
      TMUX_SOCKET_NAME: layout.tmuxSocketName,
      TMUX_TMPDIR: layout.tmuxTmpDir,
      CLAUDE_BIN: writeFakeClaudeLauncher(layout, null),
      // A free port nothing listens on: the boot's OpenCode pre-start finds no server and no binary, and gives up.
      OPENCODE_URL: `http://127.0.0.1:${await getFreePort()}`,
      SCHEDULER_MCP_PORT: (await getFreeFixedPort()).toString(),
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
    assert.deepEqual(listTmuxSessions([]), defaultTmuxSessionsBefore, 'the default tmux server was not touched');
  });

  it('boots and binds the five topics', async () => {
    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    for (const topic of [topicP, topicM, topicL, topicT, topicQ]) await getDriver(topic.threadId).sendAndAwaitReply(`/bind ${topic.folder}`, `Bound to \`${topic.folder}\``);
  });

  it('per-turn P: the adapter\'s turn end starts the clock though the process is stopped right after it', async () => {
    await getDriver(topicP.threadId).sendAndAwaitReply('/claude_mode perturn', 'applies on next start');
    await getDriver(topicP.threadId).sendAndAwaitReply('/claude', 'ready in');
    await publishAndAwaitClock(topicP.threadId, 'TODO-51', 'Per-turn task');
    assert.ok(readTopicTodoFile(topicP.threadId).lastTurnEndAt !== undefined, 'the turn end is recorded for the board');
  });

  it('per-turn P: a due reminder is held back — the session sleeps after every turn —, and P\'s next message carries the line', async () => {
    await workAndAwaitHeldBack(topicP.threadId, 'TODO-52', /the session sleeps after every turn \(never woken for it\)/);
    await sendToAgent(topicP.threadId, 'TODO-53');
    assert.ok(getPromptOf('TODO-53').includes(reminderMarker), 'form a: the reminder rides the next prompt');
    // Stopped before the restart below, so P sleeps through it and its next prompt starts a process of its own.
    await awaitPerTurnStop(topicP.threadId);
  });

  it('while the bot is down, M is put on an account billed to API credits and L on an account marked limited', async () => {
    const homeClaudeDir = path.join(getLayout().instanceHome, '.claude');
    for (const account of [meteredAccount, cappedAccount]) createClaudeProfileLayout({ dataDir: getLayout().dataDir, name: account, homeClaudeDir });
    const limitedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    charness = await restartCharnessWithState(getLayout(), fakeTelegram, getCharness(), (persisted) => {
      persisted.claudeProfiles = {
        ...persisted.claudeProfiles,
        [meteredAccount]: { createdAt: new Date().toISOString(), loggedIn: true, billing: 'api', email: 'ops@example.com' },
        [cappedAccount]: { createdAt: new Date().toISOString(), loggedIn: true, subscriptionType: 'max', email: 'capped@example.com', limitedUntil },
      };
      persisted.claudeProfileOverrides = {
        ...persisted.claudeProfileOverrides,
        [`${group.id}:${topicM.threadId}`]: meteredAccount,
        [`${group.id}:${topicL.threadId}`]: cappedAccount,
      };
    });
  });

  it('M on the API-billed account: its fresh session gets the whole board, and a due reminder is held back — never spend money unasked', async () => {
    await getDriver(topicM.threadId).sendAndAwaitReply('/claude', 'ready in');
    await publishAndAwaitClock(topicM.threadId, 'TODO-61', 'Metered task');
    assert.match(getPromptOf('TODO-61'), /\[Project board · repo-p · 1 other topic\]\n#topic 191 \(repo-p\) — [^\n]*\n {2}▶ Per-turn task/);
    await workAndAwaitHeldBack(topicM.threadId, 'TODO-62', /billed to API credits/);
  });

  it('P resumed after its per-turn stop gets only what changed: a stop is no fresh context', async () => {
    await sendToAgent(topicP.threadId, 'TODO-54');
    const prompt = getPromptOf('TODO-54');
    assert.match(prompt, /\[Project board — changes since \d\d:\d\d\]\n#topic 192 \(repo-m\) — [^\n]*\n {2}▶ Metered task/);
    assert.doesNotMatch(prompt, /\[Project board · /, 'not the whole board');
    // The stop after TODO-53 came before the restart; this one the running bot makes and sees (its `suspended` event).
    await awaitPerTurnStop(topicP.threadId);
    await sendToAgent(topicM.threadId, 'TODO-63', '[todo:queued:Metered follow-up]');
    await getCharness().waitFor('M published the follow-up', turnTimeoutMs, () => JSON.stringify(readTopicTodoFile(topicM.threadId)).includes('Metered follow-up'));
    await sendToAgent(topicP.threadId, 'TODO-55');
    assert.match(getPromptOf('TODO-55'), /\[Project board — changes since \d\d:\d\d\]\n#topic 192 \(repo-m\) — [\s\S]*Metered follow-up/);
    assert.doesNotMatch(getPromptOf('TODO-55'), /\[Project board · /, 'a stop the running bot saw is no fresh context either');
  });

  it('L on the limited account: a due reminder is held back', async () => {
    await getDriver(topicL.threadId).sendAndAwaitReply('/claude', 'ready in');
    await publishAndAwaitClock(topicL.threadId, 'TODO-71', 'Capped task');
    await workAndAwaitHeldBack(topicL.threadId, 'TODO-72', /the account or model is limited/);
  });

  it('T in «Answers only»: a turn past the interval that ends on a final answer is held back while its tail is followed', async () => {
    await getDriver(topicT.threadId).sendAndAwaitReply('/verbosity answers', 'This topic shows: Answers only');
    await getDriver(topicT.threadId).sendAndAwaitReply('/claude', 'ready in');
    await publishAndAwaitClock(topicT.threadId, 'TODO-81', 'Answered task');
    const outputStart = getCharness().output.length;
    await sendToAgent(topicT.threadId, 'TODO-82', `[fake:answer] [work-ms:${longTurnWorkMs}]`);
    const linePattern = new RegExp(`\\[todos\\] ${group.id}:${topicT.threadId}: stale list, no reminder: [^\\n]*`);
    await getCharness().waitFor('TODO-82: the held-back reminder', turnTimeoutMs, () => linePattern.test(getCharness().output.slice(outputStart)));
    assert.match(linePattern.exec(getCharness().output.slice(outputStart))?.[0] ?? '', /the text after a final answer is followed/);
  });

  it('Q waits on its question past the interval: no reminder while it is pinned, none after it is answered — waiting is no work', async () => {
    const driver = getDriver(topicQ.threadId);
    await driver.sendAndAwaitReply('/claude', 'ready in');
    await publishAndAwaitClock(topicQ.threadId, 'TODO-91', 'Asked task');
    const outputStart = getCharness().output.length;
    const sentMessageId = fakeTelegram.pushOperatorMessage(topicQ.threadId, 'TODO-92 [fake:ask]');
    const question = await driver.waitForMessage('Q\'s question', (message) => message.message_id > sentMessageId && message.text.includes(fakeAskQuestion.question) && message.reply_markup !== undefined);
    // The scenario itself: the question waits for the operator longer than the reminder's interval.
    await new Promise((resolve) => setTimeout(resolve, reminderIntervalMs + longTurnWorkMs));
    const answeredAt = Date.now();
    const [[firstOption]] = driver.getKeyboardData(question);
    await driver.tapAndAwaitAnswer(question, firstOption);
    await getCharness().waitFor('the turn end after the answer', turnTimeoutMs, () => (readTopicTodoFile(topicQ.threadId).lastTurnEndAt ?? 0) > answeredAt);
    const workedMs = readTopicTodoFile(topicQ.threadId).nag?.workedMs ?? 0;
    assert.ok(workedMs < reminderIntervalMs, `the wait counted as work: ${workedMs} ms`);
    const output = getCharness().output.slice(outputStart);
    assert.ok(!output.includes(`[todos] ${group.id}:${topicQ.threadId}: stale list`), 'no reminder, none held back: the list is not stale');
  });
});
