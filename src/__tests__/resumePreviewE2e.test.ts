/**
 * @description The "↩️ Resumed — last N messages" preview of a resumed Claude conversation, at PROCESS level: the BUILT
 * charness started the way an isolated instance is (`scripts/run-isolated.sh`) against the fake Bot API of
 * `telegramE2e/fakeTelegram.ts`, with the fake `claude` (`jiraE2e/fakeClaude.ts`) resuming a transcript the test seeded
 * with the entries the real CLI writes when the owner runs `/compact` directly in it (a caveat entry, the command entry
 * with its long argument text, the command's stdout entry). One flow:
 *
 *   boot → a topic is bound and its agent started
 *   → `/sessions` lists the seeded conversation under its first real prompt (not under any of the CLI's own entries)
 *   → a tap on it resumes the conversation, and the preview shows the last THREE real messages: the user's, the agent's
 *     and the command as just `/compact` — no tags, no argument text, no caveat, no stdout; the entries it skips do not
 *     count toward the three
 *
 * What the unit tests cover instead: the entry classification (`claudeUserEntry.test.ts`), the turn reader over every
 * shape (`claudeRecentTurns.test.ts`), the silent-reattach recap's body (`reattachRecap.test.ts`), the picker's titles
 * (`claudeSessionTitle.test.ts`).
 *
 * Nothing leaves the machine: the Bot API is on loopback and the agent is a fake. Everything the test starts is stopped
 * in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import { getFakeClaudeTranscriptPath, getFlagValues } from './jiraE2e/fakeClaudeContract';
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
import { getSessionLaunches, startCharnessOnInstance } from './e2e/fallbackFlowKit';
import { enDict } from '../i18n/en';
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const topicThreadId = 111;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const projectFolder = 'resume-preview';

const replyTimeoutMs = 20 * 1000;
/** The start of the `/sessions` list's header (`session.list_header` up to the backend's label). */
const sessionsListHeader = 'Sessions to resume';

/** The conversation's first real prompt: what `/sessions` lists it under. */
const firstPrompt = 'Fix the login bug';
const firstAnswer = 'I fixed the login bug in the auth module.';
const lastPrompt = 'Run the tests';
const lastAnswer = 'All tests pass.';
/** A word of the `/compact` argument text, which the preview must not show. */
const commandArgumentMarker = 'MAXIMALLY COMPLETE';

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let topic: TopicDriver;
let defaultTmuxSessionsBefore: string[] = [];
/** The seeded conversation. */
const sessionId = randomUUID();

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

function getWorkDir(): string {
  return path.join(getLayout().workRoot, projectFolder);
}

/**
 * The transcript of a conversation whose owner ran `/compact` directly in the CLI, shaped as the real CLI writes it:
 * a caveat entry, the command entry (name, message and the long argument text) and the command's stdout entry, each a
 * `user` entry with a bare string.
 */
function writeCompactedTranscript(): void {
  const userEntry = (content: string, extra: object = {}) => ({ type: 'user', cwd: getWorkDir(), sessionId, timestamp: new Date().toISOString(), message: { role: 'user', content }, ...extra });
  const assistantEntry = (text: string) => ({ type: 'assistant', cwd: getWorkDir(), sessionId, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text }] } });
  const entries = [
    userEntry(firstPrompt),
    assistantEntry(firstAnswer),
    userEntry(lastPrompt),
    assistantEntry(lastAnswer),
    userEntry(
      '<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request, and its output goes straight to the user. It\'s recorded here as context for later messages.</local-command-caveat>',
      { isMeta: true },
    ),
    userEntry(
      `<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args>Make the summary ${commandArgumentMarker}: keep every decision, every open question and every file path, in the order they came up.</command-args>`,
    ),
    userEntry('<local-command-stdout>Compacted PreCompact [grep -qF -e \'summary\' || printf \'%s\' \'hook\'] completed successfully</local-command-stdout>'),
  ];
  const transcriptPath = getFakeClaudeTranscriptPath({ homeDir: getLayout().instanceHome, workDir: getWorkDir(), sessionId });
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.writeFileSync(transcriptPath, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''));
}

describe('The resumed-conversation preview, end to end: built charness, fake Bot API, fake claude', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-resprev-', [projectFolder], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    topic = new TopicDriver(fakeTelegram, getCharness, topicThreadId, replyTimeoutMs);
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
      OPENCODE_URL: `http://127.0.0.1:${await getFreePort()}`,
      SCHEDULER_MCP_PORT: (await getFreeFixedPort()).toString(),
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
    assert.deepEqual(listTmuxSessions([]), defaultTmuxSessionsBefore, 'the default tmux server was not touched');
  });

  it('boots, binds the topic and starts its agent', async () => {
    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    await topic.sendAndAwaitReply(`/bind ${projectFolder}`, `Bound to \`${projectFolder}\``);
    await topic.sendAndAwaitReply('/claude', 'ready in');
  });

  it('lists the conversation under its first real prompt and, on a tap, resumes it and previews the last three REAL messages: the command as just `/compact`, no caveat, no stdout, no tags', async () => {
    writeCompactedTranscript();

    const list = await topic.sendAndAwaitReply('/sessions', sessionsListHeader);
    const pickLabels = topic.getKeyboardLabels(list).flat();
    assert.equal(pickLabels.length, 1, `only the seeded conversation is listed: ${pickLabels.join(' | ')}`);
    assert.ok(pickLabels[0].startsWith(firstPrompt), `the conversation is listed under its first real prompt: ${pickLabels[0]}`);

    const launchesBefore = getSessionLaunches(getLayout()).length;
    const messagesBefore = topic.listMessages().length;
    await topic.tapAndAwaitAnswer(list, topic.getKeyboardData(list)[0][0]);
    const preview = await topic.waitForMessage('the preview of the resumed conversation', (message) => message.text.includes('Resumed — last'));

    assert.equal(
      preview.text,
      [
        enDict['resume.context_header'].replace('{count}', '3'),
        `${enDict['resume.context_user_label']} ${lastPrompt}`,
        `${enDict['resume.context_assistant_label']} ${lastAnswer}`,
        `${enDict['resume.context_user_label']} /compact`,
      ].join('\n\n'),
      'the preview is the last three real messages, the command as just its name',
    );

    const resumedLaunch = getSessionLaunches(getLayout()).slice(launchesBefore).find((launch) => getFlagValues(launch.argv, '--resume').includes(sessionId));
    assert.ok(resumedLaunch, 'the agent was started again on the seeded conversation');
    const newTexts = topic.listMessages().slice(messagesBefore).map((message) => message.text).join('\n');
    for (const leaked of ['<', '&lt;', 'local-command', commandArgumentMarker, 'Compacted PreCompact', 'run directly in Claude Code']) {
      assert.ok(!newTexts.includes(leaked), `the topic never shows "${leaked}": ${newTexts}`);
    }
  });
});
