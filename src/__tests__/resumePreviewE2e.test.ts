/**
 * @description The "↩️ Resumed — last N messages" preview of a resumed Claude conversation, at PROCESS level: the BUILT
 * charness started the way an isolated instance is (`scripts/run-isolated.sh`) against the fake Bot API of
 * `telegramE2e/fakeTelegram.ts`, with the fake `claude` (`jiraE2e/fakeClaude.ts`) resuming transcripts the test seeded
 * with the entries the real CLI writes. One flow:
 *
 *   boot → a topic is bound and its agent started
 *   → a conversation whose owner ran `/compact` directly in the CLI (the compaction boundary and summary the CLI writes,
 *     a caveat entry, the command entry with its long argument text, the command's stdout entry): `/sessions` lists it
 *     under its first real prompt, and a tap resumes it — the preview shows the last THREE real messages: the user's, the
 *     agent's and the command as just `/compact`; no tags, no argument text, no summary, no caveat, no stdout, and the
 *     entries it skips do not count toward the three
 *   → a conversation whose last turn loaded a skill (the skill's body, an image note and a message from another session
 *     are `isMeta` entries) and ran a `!` shell command (an input and an output entry): the preview shows the shell
 *     command as `!git status` and none of the skill's text, the image note or the output
 *
 * What the unit tests cover instead: the entry classification (`claudeUserEntry.test.ts`), the turn reader over every
 * shape (`claudeRecentTurns.test.ts`), the silent-reattach recap's body (`claudeReattachRecap.test.ts`), the picker's
 * titles (`claudeSessionTitle.test.ts`, `claudeCliAdapter.sessions.test.ts`).
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
import { FakeTelegram, type FakeTelegramMessage } from './telegramE2e/fakeTelegram';
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

/** The `/compact` conversation's first real prompt: what `/sessions` lists it under. */
const firstPrompt = 'Fix the login bug';
const firstAnswer = 'I fixed the login bug in the auth module.';
const lastPrompt = 'Run the tests';
const lastAnswer = 'All tests pass.';
/** A word of the `/compact` argument text, which the preview must not show. */
const commandArgumentMarker = 'MAXIMALLY COMPLETE';
/** The compaction summary the CLI writes into the transcript as a `user` entry; a long text, which the preview must not show. */
const compactionSummaryStart = 'This session is being continued from a previous conversation that ran out of context.';
const compactionSummaryMarker = 'Primary Request and Intent';

/** The skill conversation: its last real turns, and words of what it loaded and ran, which the preview must not show. */
const skillFirstPrompt = 'Plan the release';
const skillFirstAnswer = 'The plan is ready.';
const skillLastPrompt = 'Commit the work';
const skillLastAnswer = 'Loading the commit skill.';
const skillBodyMarker = 'Step one of the commit skill';
const shellCommand = 'git status';
const shellOutputMarker = 'nothing to commit';

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let topic: TopicDriver;
let defaultTmuxSessionsBefore: string[] = [];
/** The seeded conversations. */
const compactSessionId = randomUUID();
const skillSessionId = randomUUID();

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

/** Entries shaped as the real CLI writes them: a `user` entry with a bare string or a text-block array, an `assistant` entry with text blocks. */
function createEntryFactory(sessionId: string) {
  const base = () => ({ cwd: getWorkDir(), sessionId, timestamp: new Date().toISOString() });
  return {
    user: (content: string | object[], extra: object = {}) => ({ type: 'user', ...base(), message: { role: 'user', content }, ...extra }),
    assistant: (text: string) => ({ type: 'assistant', ...base(), message: { role: 'assistant', content: [{ type: 'text', text }] } }),
  };
}

function writeTranscript(sessionId: string, entries: object[]): void {
  const transcriptPath = getFakeClaudeTranscriptPath({ homeDir: getLayout().instanceHome, workDir: getWorkDir(), sessionId });
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.writeFileSync(transcriptPath, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''));
}

/**
 * The transcript of a conversation whose owner ran `/compact` directly in the CLI, as the real CLI writes it after four
 * real messages: the `compact_boundary` entry, the compaction summary (a `user` entry flagged `isCompactSummary` and
 * `isVisibleInTranscriptOnly`, not `isMeta`), the caveat entry (`isMeta`), the command entry (name, message and the long
 * argument text) and the command's stdout entry.
 */
function writeCompactedTranscript(): void {
  const { user, assistant } = createEntryFactory(compactSessionId);
  writeTranscript(compactSessionId, [
    user(firstPrompt),
    assistant(firstAnswer),
    user(lastPrompt),
    assistant(lastAnswer),
    { type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'manual', preTokens: 123456 }, cwd: getWorkDir(), sessionId: compactSessionId, timestamp: new Date().toISOString() },
    user(
      `${compactionSummaryStart} The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. ${compactionSummaryMarker}: fix the login bug, then run the tests.`,
      { isCompactSummary: true, isVisibleInTranscriptOnly: true },
    ),
    user(
      '<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request, and its output goes straight to the user. It\'s recorded here as context for later messages.</local-command-caveat>',
      { isMeta: true },
    ),
    user(
      `<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args>Make the summary ${commandArgumentMarker}: keep every decision, every open question and every file path, in the order they came up.</command-args>`,
    ),
    user('<local-command-stdout>Compacted PreCompact [grep -qF -e \'summary\' || printf \'%s\' \'hook\'] completed successfully</local-command-stdout>'),
  ]);
}

/**
 * The transcript of a conversation whose last turn loaded a skill and ran a shell command: the skill's body (a
 * text-block array), an image note and a message from another session — all `isMeta` — then the `!` command's input
 * and its output entry.
 */
function writeSkillLoadedTranscript(): void {
  const { user, assistant } = createEntryFactory(skillSessionId);
  writeTranscript(skillSessionId, [
    user(skillFirstPrompt),
    assistant(skillFirstAnswer),
    user(skillLastPrompt),
    assistant(skillLastAnswer),
    user([{ type: 'text', text: `Base directory for this skill: /example/skills/commit\n\n# Commit\n${skillBodyMarker}: look at the diff.` }], { isMeta: true }),
    user('[Image: original 800x600, displayed at 400x300]', { isMeta: true }),
    user('Another Claude session sent a message: look at the build', { isMeta: true }),
    user(`<bash-input>${shellCommand}</bash-input>`),
    user(`<bash-stdout>On branch main\n${shellOutputMarker}</bash-stdout><bash-stderr></bash-stderr>`),
  ]);
}

/**
 * `/sessions`, a tap on the conversation listed under `title`, and what the bot posts after it: the titles the list
 * showed, the preview of the resumed conversation, and the text of every message posted from the list on.
 */
async function resumeThroughSessionsList(title: string, sessionId: string): Promise<{ listedTitles: string[]; preview: FakeTelegramMessage; postedTexts: string }> {
  const list = await topic.sendAndAwaitReply('/sessions', sessionsListHeader);
  const listedTitles = topic.getKeyboardLabels(list).flat();
  const pickedIndex = listedTitles.findIndex((label) => label.startsWith(title));
  assert.notEqual(pickedIndex, -1, `the conversation is listed under its first real prompt "${title}": ${listedTitles.join(' | ')}`);

  const launchesBefore = getSessionLaunches(getLayout()).length;
  await topic.tapAndAwaitAnswer(list, topic.getKeyboardData(list).flat()[pickedIndex]);
  const preview = await topic.waitForMessage(
    'the preview of the resumed conversation',
    (message) => message.message_id > list.message_id && message.text.includes('Resumed — last'),
  );
  const resumedLaunch = getSessionLaunches(getLayout()).slice(launchesBefore).find((launch) => getFlagValues(launch.argv, '--resume').includes(sessionId));
  assert.ok(resumedLaunch, 'the agent was started again on the seeded conversation');
  const postedTexts = topic.listMessages().filter((message) => message.message_id > list.message_id).map((message) => message.text).join('\n');
  return { listedTitles, preview, postedTexts };
}

function assertNeverPosted(postedTexts: string, leakedFragments: string[]): void {
  for (const leaked of ['<', '&lt;', ...leakedFragments]) {
    assert.ok(!postedTexts.includes(leaked), `the topic never shows "${leaked}": ${postedTexts}`);
  }
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

  it('lists the /compact conversation under its first real prompt and, on a tap, resumes it and previews the last three REAL messages: the command as just `/compact`, no caveat, no stdout, no tags', async () => {
    writeCompactedTranscript();

    const { listedTitles, preview, postedTexts } = await resumeThroughSessionsList(firstPrompt, compactSessionId);

    assert.equal(listedTitles.length, 1, `only the seeded conversation is listed: ${listedTitles.join(' | ')}`);
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
    assertNeverPosted(postedTexts, ['local-command', commandArgumentMarker, 'Compacted PreCompact', 'run directly in Claude Code', compactionSummaryStart, compactionSummaryMarker]);
  });

  it('previews a conversation whose last turn loaded a skill: the shell command as `!git status`, and none of the skill\'s text, the image note, the other session\'s message or the command\'s output', async () => {
    writeSkillLoadedTranscript();

    const { preview, postedTexts } = await resumeThroughSessionsList(skillFirstPrompt, skillSessionId);

    assert.equal(
      preview.text,
      [
        enDict['resume.context_header'].replace('{count}', '3'),
        `${enDict['resume.context_user_label']} ${skillLastPrompt}`,
        `${enDict['resume.context_assistant_label']} ${skillLastAnswer}`,
        `${enDict['resume.context_user_label']} !${shellCommand}`,
      ].join('\n\n'),
      'the preview is the last three real messages: the shell command stands for its entries, the skill loaded takes no slot',
    );
    assertNeverPosted(postedTexts, ['Base directory for this skill', skillBodyMarker, '[Image:', 'Another Claude session', shellOutputMarker, 'bash-']);
  });
});
