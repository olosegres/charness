/**
 * @description What a topic sees when the OpenCode server goes down, at PROCESS level: the BUILT charness started
 * the way an isolated instance is (`scripts/run-isolated.sh`) against the fake Bot API (`telegramE2e/fakeTelegram.ts`)
 * and the fake OpenCode server (`openCodeE2e/fakeOpenCodeServer.ts`). One flow, in order:
 *
 *   boot → two topics bound, each with an OpenCode session; topic B sends a prompt the "model" never answers, so
 *     its turn is in flight; topic A is idle
 *   → the `opencode` binary disappears and the server stops: the bot finds it down and brings it back. The first
 *     attempt finds no binary and its install fails (the fake `npm` refuses once); a retry installs it into
 *     `~/.npm-global/bin`, spawns `opencode serve` (the fake), and the server is up again
 *   → while the bot retries, topic A sends a message: it is held, not posted to the dead server
 *   → the agreed outcome: topic A sees NOTHING (no error, no "restarting", no "restored"), its held message reaches
 *     the SAME session once the server is back; topic B sees exactly one line — its in-flight reply was lost
 *   → the server goes down again and the binary can NOT be installed (every npm call fails): after the retries each
 *     topic gets exactly one short localized line — never the raw error — and once the install works again, the
 *     next message brings the server back up and reaches the same session.
 *
 * What the unit tests cover instead (`openCodeCrashResume.test.ts`): a session gone on the new server, the forced
 * restart of a credential reload, start/resume through the same retries.
 *
 * Nothing leaves the machine: the Bot API and the OpenCode server are on loopback, `npm` is a fake. Everything the
 * test starts is stopped in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import { FakeOpenCodeServer, writeFakeNpm, writeFakeOpenCodeBinary } from './openCodeE2e/fakeOpenCodeServer';
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
import { defaultLocale, runWithLocale, t } from '../i18n';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';

const idleTopic = { threadId: 131, folder: 'restart-idle' };
const busyTopic = { threadId: 132, folder: 'restart-busy' };
const fakeOpenCodeVersion = '1.17.11';
const defaultOpenCodeModel = 'anthropic/claude-sonnet-4-6';
const openCodeModels = [defaultOpenCodeModel] as const;
const heldPromptLabel = 'RST-A';
const inFlightPromptLabel = 'RST-B';

const replyTimeoutMs = 20 * 1000;
const restartTimeoutMs = 60 * 1000;
/** The retries' 60 s budget, plus the attempts that wait out a spawn and the install calls. */
const allAttemptsFailTimeoutMs = 3 * 60 * 1000;
const afterFailurePromptLabel = 'RST-C';
/** The log line of a failed attempt to bring the server up (`openCodeAdapter.ts`). */
const failedAttemptLogLine = 'Attempt 1 to bring the server up failed';

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let fakeOpenCode: FakeOpenCodeServer;
let openCodePort = 0;
let idleDriver: TopicDriver;
let busyDriver: TopicDriver;
let defaultTmuxSessionsBefore: string[] = [];
let servePidFile = '';
let npmCallLogFile = '';
/** While it exists the fake npm cannot install opencode. */
let npmFailFile = '';

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

/** The pids of the `opencode serve` processes the bot spawned (the fake appends its own). */
function listServePids(): number[] {
  if (!fs.existsSync(servePidFile)) return [];
  return fs.readFileSync(servePidFile, 'utf8').split('\n').filter(Boolean).map((line) => Number.parseInt(line, 10));
}

function countNpmCalls(): number {
  return fs.existsSync(npmCallLogFile) ? fs.readFileSync(npmCallLogFile, 'utf8').split('\n').filter(Boolean).length : 0;
}

/** The fake OpenCode session of a topic's folder. */
function getSessionIdOf(folder: string): string {
  const folderPath = path.join(getLayout().workRoot, folder);
  const session = [...fakeOpenCode.sessions.values()].find((candidate) => candidate.directory === folderPath);
  assert.ok(session, `a fake OpenCode session for ${folderPath}`);
  return session.id;
}

/** What the bot SENT to a topic (the Bot API call log), from `afterCallIndex` on. */
function listSentTexts(threadId: number, afterCallIndex: number): string[] {
  return fakeTelegram
    .listCalls('sendMessage')
    .slice(afterCallIndex)
    .filter((call) => call.payload.message_thread_id === threadId)
    .map((call) => (typeof call.payload.text === 'string' ? call.payload.text : ''));
}

describe('An OpenCode server that goes down, end to end: built charness, fake Bot API, fake OpenCode, fake npm', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-ocrestart-', [idleTopic.folder, busyTopic.folder], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    idleDriver = new TopicDriver(fakeTelegram, getCharness, idleTopic.threadId, replyTimeoutMs);
    busyDriver = new TopicDriver(fakeTelegram, getCharness, busyTopic.threadId, replyTimeoutMs);
    const apiRoot = await fakeTelegram.start();

    servePidFile = path.join(layout.fakeLogDir, 'opencode-serve.pids');
    npmCallLogFile = path.join(layout.fakeLogDir, 'npm-calls.log');
    npmFailFile = path.join(layout.fakeStateDir, 'npm-cannot-install');
    fakeOpenCode = new FakeOpenCodeServer({ version: fakeOpenCodeVersion, models: openCodeModels, defaultModel: defaultOpenCodeModel });
    openCodePort = await getFreePort();
    const openCodeUrl = await fakeOpenCode.start(openCodePort);
    const binaryOptions = { version: fakeOpenCodeVersion, models: openCodeModels, servePidFile };
    writeFakeOpenCodeBinary(layout.binDir, binaryOptions);
    // What the fake npm installs: the same fake binary, kept outside the PATH.
    const templateDir = path.join(layout.fakeStateDir, 'opencode-package');
    fs.mkdirSync(templateDir, { recursive: true });
    writeFakeNpm(layout.binDir, { callLogFile: npmCallLogFile, failingCalls: 1, installedBinaryTemplate: writeFakeOpenCodeBinary(templateDir, binaryOptions), failWhileFile: npmFailFile });
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
    });
  });

  after(async () => {
    await charness?.stop();
    for (const pid of listServePids()) {
      try {
        process.kill(pid);
      } catch {
        // already gone
      }
    }
    removeInstanceSync();
    await fakeTelegram?.stop();
    await fakeOpenCode?.stop();
    process.off('exit', removeInstanceSync);
    process.off('SIGINT', exitOnSignal);
    process.off('SIGTERM', exitOnSignal);
    assert.deepEqual(listTmuxSessions([]), defaultTmuxSessionsBefore, 'the default tmux server was not touched');
    assert.deepEqual(fakeOpenCode.unhandled, [], 'the bot asked the fake OpenCode for nothing it does not model');
  });

  it('boots against the fake server, binds two topics with an OpenCode session each; topic B has a turn in flight', async () => {
    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    for (const [driver, topic] of [[idleDriver, idleTopic], [busyDriver, busyTopic]] as const) {
      await driver.sendAndAwaitReply(`/bind ${topic.folder}`, `Bound to \`${topic.folder}\``);
      await driver.sendAndAwaitReply('/opencode', 'ready in');
    }
    fakeTelegram.pushOperatorMessage(busyTopic.threadId, `${inFlightPromptLabel} a long task`);
    await getCharness().waitFor('the in-flight prompt to reach the server', replyTimeoutMs, () => fakeOpenCode.prompts.some((prompt) => prompt.text.includes(inFlightPromptLabel)));
  });

  it('the server goes down with its binary gone: retried until the binary is installed and the server is back; the idle topic sees nothing, the busy one one line, a message typed meanwhile is delivered', async () => {
    const idleSessionId = getSessionIdOf(idleTopic.folder);
    const busySessionId = getSessionIdOf(busyTopic.folder);
    const callsBefore = fakeTelegram.listCalls('sendMessage').length;
    fs.rmSync(path.join(getLayout().binDir, 'opencode'));
    await fakeOpenCode.stop();

    await getCharness().waitFor('the first attempt to fail (no binary, the install refused)', restartTimeoutMs, () => getCharness().output.includes(failedAttemptLogLine));
    fakeTelegram.pushOperatorMessage(idleTopic.threadId, `${heldPromptLabel} typed while the server is down`);
    await getCharness().waitFor('a retry to install the binary and spawn `opencode serve`', restartTimeoutMs, () => listServePids().length > 0);
    await fakeOpenCode.start(openCodePort);

    await getCharness().waitFor('the held message to reach the SAME session', restartTimeoutMs, () => fakeOpenCode.prompts.some((prompt) => prompt.text.includes(heldPromptLabel)));
    const heldPrompt = fakeOpenCode.prompts.find((prompt) => prompt.text.includes(heldPromptLabel));
    assert.equal(heldPrompt?.sessionId, idleSessionId, 'delivered into the restored session, not a new one');
    const restoredNotice = runWithLocale(defaultLocale, () => t('openCodeServer.restartedSessionRestoredNotice'));
    await busyDriver.waitForMessage('the busy topic to hear its reply was lost', (message) => message.text === restoredNotice);

    assert.equal(countNpmCalls(), 2, 'the install was retried once after it failed, then left alone');
    assert.ok(fs.existsSync(path.join(getLayout().instanceHome, '.npm-global', 'bin', 'opencode')), 'installed where installTool installs');
    assert.deepEqual(listSentTexts(idleTopic.threadId, callsBefore), [], 'the idle topic hears nothing: no error, no restart notice');
    assert.deepEqual(listSentTexts(busyTopic.threadId, callsBefore), [restoredNotice], 'the busy topic hears exactly one line');
    assert.ok(fakeOpenCode.listRequests('GET', `/session/${busySessionId}`).length > 0, 'the busy session was restored by its id');
    assert.equal(fakeOpenCode.sessions.size, 2, 'no session was created anew');
  });

  it('the server goes down and the binary cannot be installed: one localized line per topic, no raw error; the next message brings it back', async () => {
    const callsBefore = fakeTelegram.listCalls('sendMessage').length;
    const idleSessionId = getSessionIdOf(idleTopic.folder);
    const unavailableNotice = runWithLocale(defaultLocale, () => t('agent.serverUnavailableNotice', { label: 'OpenCode' }));
    fs.writeFileSync(npmFailFile, '');
    fs.rmSync(path.join(getLayout().instanceHome, '.npm-global', 'bin', 'opencode'), { force: true });
    await fakeOpenCode.stop();

    await getCharness().waitFor('every attempt to have failed', allAttemptsFailTimeoutMs, () => getCharness().output.includes('The server could not be brought up after'));
    await getCharness().waitFor('the notice in both topics', replyTimeoutMs, () => listSentTexts(idleTopic.threadId, callsBefore).length > 0 && listSentTexts(busyTopic.threadId, callsBefore).length > 0);
    assert.deepEqual(listSentTexts(idleTopic.threadId, callsBefore), [unavailableNotice], 'exactly the localized line');
    assert.deepEqual(listSentTexts(busyTopic.threadId, callsBefore), [unavailableNotice], 'exactly the localized line');
    for (const text of [...listSentTexts(idleTopic.threadId, callsBefore), ...listSentTexts(busyTopic.threadId, callsBefore)]) {
      assert.doesNotMatch(text, /ENOENT|spawn|npm ERR|E404/, 'the raw error stays in the log');
    }

    // The install works again: the next message resumes the conversation and brings the server up.
    fs.rmSync(npmFailFile);
    const servesBefore = listServePids().length;
    fakeTelegram.pushOperatorMessage(idleTopic.threadId, `${afterFailurePromptLabel} the server is back?`);
    await getCharness().waitFor('a new `opencode serve`', restartTimeoutMs, () => listServePids().length > servesBefore);
    await fakeOpenCode.start(openCodePort);
    await getCharness().waitFor('the message to reach the SAME session', restartTimeoutMs, () => fakeOpenCode.prompts.some((prompt) => prompt.text.includes(afterFailurePromptLabel)));
    assert.equal(fakeOpenCode.prompts.find((prompt) => prompt.text.includes(afterFailurePromptLabel))?.sessionId, idleSessionId, 'the conversation is intact, not a fresh one');
  });
});
