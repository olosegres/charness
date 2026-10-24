/**
 * @description Mid-turn delivery of the project board to an OpenCode agent (shared todo registry S4, D21, D22), at
 * PROCESS level: the BUILT charness started the way an isolated instance is (`scripts/run-isolated.sh`) against the
 * fake Bot API (`telegramE2e/fakeTelegram.ts`), the fake OpenCode server (`openCodeE2e/fakeOpenCodeServer.ts`) for topic
 * X and the fake `claude` (`jiraE2e/fakeClaude.ts`) for topic Y, whose folders are two checkouts of one git
 * repository. One flow, in order:
 *
 *   boot → X runs an OpenCode session and has had its first prompt (its board is seen); Y runs Claude
 *   → Y publishes while X is idle: nothing is sent to X — a peer's change never starts a turn
 *   → X goes busy: ONE note reaches its running turn with the change — OpenCode reads `prompt_async` between steps —
 *     and the change counts as seen: X's further polls while busy send nothing more; a second change arriving while
 *     X streams its reply is queued without resetting the turn: the reply before and after it stays ONE message
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
import { FakeOpenCodeServer, writeFakeOpenCodeBinary } from './openCodeE2e/fakeOpenCodeServer';
import { fakeClaudeLogFileNames } from './jiraE2e/fakeClaudeContract';
import {
  builtCliPath,
  createIsolatedInstanceLayout,
  exitOnSignal,
  getFlowDeadlineMs,
  getFreeFixedPort,
  getFreePort,
  IsolatedCharness,
  listTmuxSessions,
  readJsonLines,
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
const topicX = { threadId: 181, folder: 'repo-x' };
const topicY = { threadId: 182, folder: 'repo-y' };
const fakeOpenCodeVersion = '1.17.11';
const model = 'example/model-one';
const openCodeModels = [model] as const;
const replyTimeoutMs = 20 * 1000;
const turnTimeoutMs = 60 * 1000;
/** The reminder poll that also hands busy sessions the board's changes (production: 10 s). */
const pollMs = 500;
/** Long enough for several polls: the window in which a wrong send would have happened (an absence is checked). */
const severalPollsMs = 4 * pollMs;
/** What a busy OpenCode agent reads when the board changed (`bot.ts` `todoMidTurnNoticeText`). */
const midTurnNoticeMarker = '[Todo] Other topics of your project changed their lists while you work.';

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let fakeOpenCode: FakeOpenCodeServer;
let driverX: TopicDriver;
let driverY: TopicDriver;
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

function getSessionIdOfX(): string {
  const folderPath = path.join(getLayout().workRoot, topicX.folder);
  const session = [...fakeOpenCode.sessions.values()].find((candidate) => candidate.directory === folderPath);
  assert.ok(session, `a fake OpenCode session for ${folderPath}`);
  return session.id;
}

function listPromptsOfX(): string[] {
  const sessionId = getSessionIdOfX();
  return fakeOpenCode.prompts.filter((prompt) => prompt.sessionId === sessionId).map((prompt) => prompt.text);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('Mid-turn board delivery to an OpenCode agent: built charness, fake Bot API, fake OpenCode, fake claude (S4)', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-todooc-', [topicX.folder, topicY.folder], getFlowDeadlineMs());
    // One repository, two checkouts: X's folder a clone of Y's.
    const runGit = (cwd: string, ...args: string[]): void => {
      execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-c', 'init.defaultBranch=main', ...args], { cwd, stdio: 'ignore' });
    };
    const repoY = path.join(layout.workRoot, topicY.folder);
    runGit(repoY, 'init', '-q');
    fs.writeFileSync(path.join(repoY, 'README.md'), '# repo\n');
    runGit(repoY, 'add', '.');
    runGit(repoY, 'commit', '-q', '-m', 'first');
    runGit(layout.workRoot, 'clone', '-q', repoY, path.join(layout.workRoot, topicX.folder));
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    driverX = new TopicDriver(fakeTelegram, getCharness, topicX.threadId, replyTimeoutMs);
    driverY = new TopicDriver(fakeTelegram, getCharness, topicY.threadId, replyTimeoutMs);
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
      ...getTelegramFlowTestTimingsEnv({ todoReminderPollMs: pollMs }),
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
  });

  it('boots; X runs OpenCode and has had its first prompt; Y runs Claude', async () => {
    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    await driverX.sendAndAwaitReply(`/bind ${topicX.folder}`, `Bound to \`${topicX.folder}\``);
    await driverX.sendAndAwaitReply('/opencode', 'ready in');
    fakeTelegram.pushOperatorMessage(topicX.threadId, 'STEER-1 look at the parser');
    await getCharness().waitFor('X\'s first prompt', replyTimeoutMs, () => fakeOpenCode.prompts.some((prompt) => prompt.text.includes('STEER-1')));
    fakeOpenCode.emitAssistantText(getSessionIdOfX(), 'msg_x_1', 'Looked at it.');
    fakeOpenCode.emitSessionIdle(getSessionIdOfX());
    await driverY.sendAndAwaitReply(`/bind ${topicY.folder}`, `Bound to \`${topicY.folder}\``);
    await driverY.sendAndAwaitReply('/claude', 'ready in');
  });

  it('Y publishes while X is idle: nothing is sent to X', async () => {
    const promptsBefore = listPromptsOfX().length;
    fakeTelegram.pushOperatorMessage(topicY.threadId, 'TODO-41 [todo:inWork:Shared change]');
    await getCharness().waitFor('Y\'s todo_update', turnTimeoutMs, () =>
      readJsonLines<{ tool: string; issueKey: string }>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.toolCalls)).some((call) => call.tool === 'todo_update' && call.issueKey === 'TODO-41'));
    // An absence: several polls pass, in which a send to an idle session would have happened.
    await sleep(severalPollsMs);
    assert.equal(listPromptsOfX().length, promptsBefore, 'a peer\'s change never starts a turn');
  });

  it('X goes busy: ONE note brings it the change into its running turn; text streamed around a second note stays one message', async () => {
    const promptsBefore = listPromptsOfX().length;
    const sessionId = getSessionIdOfX();
    fakeOpenCode.emitSessionBusy(sessionId);
    await getCharness().waitFor('the mid-turn note to X', turnTimeoutMs, () => listPromptsOfX().length > promptsBefore);
    const [note] = listPromptsOfX().slice(promptsBefore);
    assert.ok(note.startsWith(midTurnNoticeMarker), note);
    assert.match(note, /\[Project board — changes since \d\d:\d\d\]\n#topic 182 \(repo-y\) — [^\n]*\n {2}▶ Shared change — since \d\d:\d\d/);
    await sleep(severalPollsMs);
    assert.equal(listPromptsOfX().length, promptsBefore + 1, 'seen once sent: no repeat while X still works');

    // The agent streams its reply; a second change of Y's arrives in the middle of it.
    fakeOpenCode.emitAssistantText(sessionId, 'msg_x_2', 'Alpha part one. ');
    await driverX.waitForMessage('the first part of X\'s reply', (message) => message.text.includes('Alpha part one.'));
    fakeTelegram.pushOperatorMessage(topicY.threadId, 'TODO-42 [todo:queued:Second change]');
    await getCharness().waitFor('the second note to X', turnTimeoutMs, () => listPromptsOfX().some((prompt) => prompt.includes('Second change')));
    fakeOpenCode.emitAssistantText(sessionId, 'msg_x_2', 'Beta part two.');
    fakeOpenCode.emitSessionIdle(sessionId);
    const whole = await driverX.waitForMessage('X\'s reply whole', (message) => message.text.includes('Alpha part one. Beta part two.'));
    assert.ok(whole, 'one message carries the reply before and after the note');
    assert.deepEqual(fakeTelegram.listBotMessages(topicX.threadId).filter((message) => message.text.includes('Beta part two.')).map((message) => message.message_id), [whole.message_id], 'the note split nothing off');
  });
});
