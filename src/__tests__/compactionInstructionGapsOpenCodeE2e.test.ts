/**
 * @description The agent-mistakes section of a compaction summary on OpenCode, at PROCESS level: the BUILT charness started
 * the way an isolated instance is (`scripts/run-isolated.sh`) against the fake Bot API (`telegramE2e/fakeTelegram.ts`) and the
 * fake OpenCode server (`openCodeE2e/fakeOpenCodeServer.ts`), which plays a compaction out the way the real server does: the
 * summary message announced, its text streamed in pieces that cut lines and even markers, the message finished, the session
 * idle, the stored message served by `GET /session/:id/message`. OpenCode STREAMS its summary to the bot, which drops it with
 * `/compact_summary` off and shows it with the setting on. One flow, in order:
 *
 *   boot → a topic bound to a folder runs an OpenCode session
 *   → summary HIDDEN, `/compact`: the topic gets the start notice, the completion line and THEN the section alone under its
 *     own header — read by the bot after the compaction, so it lands in order — and nothing else of the summary
 *   → summary HIDDEN, the server compacts by itself mid-turn, twice (after the agent already streamed text): the section of
 *     each summary is posted, once
 *   → summary HIDDEN, the server's compaction starts inside the debounce of the agent's own words (they leave as two tails,
 *     the words are not taken for the summary), and the agent goes on after the compaction with the summary's `finish` lost
 *     (its answer is not taken for the summary either): the words and the answer reach the topic, the section is posted once
 *   → summary SHOWN, `/compact`: the stream goes to the topic whole — no marker line, no «none» line, the section under its
 *     header — and the section is in exactly one message
 *   → summary SHOWN, the server compacts by itself and the agent goes on: the answer is a message of its own, not glued on the summary
 *   → summary SHOWN, a section that says there were no mistakes: no header and no scaffolding either
 *   → `/compact_mistakes off`: the flag the OpenCode plugin reads is kept for the session, so the plugin — which the fake server
 *     runs before every compaction, as the real one does, from the file in the instance's own plugin folder — asks for no
 *     section in the `/compact` and the server's own compaction; and the section is posted for neither, although the fake's
 *     summary holds one (the bot's own gate); back `on`: the flag is gone, the plugin asks again and both post the section again.
 *
 * What the unit tests cover instead: the pure filter and tracker (`streamedCompactionSummary.test.ts`, `compactOnIdle.test.ts`),
 * the module over a stub adapter incl. the idle compaction's order (`compactionInstructionGaps.test.ts`), the adapter's hints
 * (`openCodeOutputDedup.test.ts`, `openCodeCompactContext.test.ts`).
 *
 * Nothing leaves the machine: the Bot API and the OpenCode server are on loopback. Everything the test starts is stopped in
 * `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram } from './telegramE2e/fakeTelegram';
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
import { enDict } from '../i18n/en';
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';
import {
  compactionChecklistGuidance,
  compactionClosingEndMarker,
  compactionClosingStartMarker,
  compactionGapsEndMarker,
  compactionGapsGuidance,
  compactionGapsStartMarker,
  compactionNoGapsLine,
  compactionSkillsGuidance,
} from '../utils/compactOnIdle';
import { getOpenCodeCompactMistakesOffDir } from '../utils/compactMistakesFlags';
import { getOpenCodeCompactPluginContext, installOpenCodeCompactPlugin } from '../utils/openCodeCompactPlugin';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';

const openCodeTopic = { threadId: 171, folder: 'compaction-gaps-opencode' };
const fakeOpenCodeVersion = '1.17.11';
const openCodeModel = 'anthropic/claude-sonnet-4-5';
const replyTimeoutMs = 20 * 1000;

const summaryBody = 'FAKE-SUMMARY-BODY: the refactor is half done.';
const closingText = 'FAKE-CLOSING: next, run the suite.';
const instructionGapsText = '1. Mistake (repeated): pushed without asking. Change: add a never-push-without-permission rule to CLAUDE.md.\n2. Mistake: skipped the lint step. Change: a lint line in the commit skill.';
const agentWorkText = 'AGENT-WORK: still reading the parser.';
const agentMixedText = 'AGENT-MIXED: the parser is half read. ';
const agentAfterText = 'AGENT-AFTER: back to the parser.';

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
  const folderPath = path.join(getLayout().workRoot, openCodeTopic.folder);
  const session = [...fakeOpenCode.sessions.values()].find((candidate) => candidate.directory === folderPath);
  assert.ok(session, `a fake OpenCode session for ${folderPath}`);
  return session.id;
}

/** A summary as the model writes it with the instruction followed: a body, the section in its markers, the checklist, the closing section. */
function buildSummary(sectionBody: string): string {
  return [
    '## Goals',
    summaryBody,
    compactionGapsStartMarker,
    sectionBody,
    compactionGapsEndMarker,
    '1. load these skills: commit',
    '2. run the suite',
    compactionClosingStartMarker,
    closingText,
    compactionClosingEndMarker,
  ].join('\n');
}

/**
 * The summary cut into the pieces the server streams: in the middle of both section markers and of a prose line, and at the
 * END of a line right before a marker (the next piece opens with that line's newline and the marker line, which show nothing
 * of their own — a newline thrown away there glues the section's header onto the line before it).
 */
function cutSummary(summary: string): string[] {
  const cuts = [
    summary.indexOf(summaryBody) + summaryBody.length,
    summary.indexOf(compactionGapsStartMarker) + 7,
    summary.indexOf(instructionGapsText.slice(0, 30)) + 12,
    summary.indexOf(compactionGapsEndMarker) + 10,
    summary.indexOf(closingText) + 8,
  ].sort((a, b) => a - b);
  const pieces: string[] = [];
  let from = 0;
  for (const cut of [...cuts, summary.length]) {
    pieces.push(summary.slice(from, cut));
    from = cut;
  }
  return pieces;
}

/**
 * Whether a text carries a section marker. The summary the server streams goes through the bot's output formatting, which
 * HTML-escapes `<<<`: a topic text is checked for both forms, or a marker that reached the topic would pass as clean.
 */
function hasMarker(text: string): boolean {
  return text.includes('<<<') || text.includes('&lt;&lt;&lt;');
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Longer than the adapter's output debounce (500 ms): what the agent streams before it is a tail of its own by now. */
const pastDebounceMs = 650;

function getNewestMessageId(): number {
  return topic.listMessages().at(-1)?.message_id ?? 0;
}

function listTextsAfter(messageId: number): string[] {
  return topic.listMessages().filter((message) => message.message_id > messageId).map((message) => message.text);
}

/** The bot's confirmation of `/compact_summary on|off` in a topic. */
function getSummarySwitchConfirmation(isVisible: boolean): string {
  return enDict['compactSummary.setThisTopic'].replace('{state}', isVisible ? enDict['compactSummary.on'] : enDict['compactSummary.off']);
}

/** The bot's confirmation of `/compact_mistakes on|off` in a topic. */
function getMistakesSwitchConfirmation(isEnabled: boolean): string {
  return enDict['compactMistakes.setThisTopic'].replace('{state}', isEnabled ? enDict['compactMistakes.on'] : enDict['compactMistakes.off']);
}

/**
 * OpenCode's global plugin folder of the INSTANCE: the bot resolves it from its own HOME (`os.homedir()`), the instance's temp
 * home. Spelled out from the layout on purpose — `resolveOpenCodeGlobalPluginDir` reads the HOME of THIS process, which is
 * the real one, and an install there would replace the plugin of the live bot.
 */
function getInstancePluginDir(): string {
  const pluginDir = path.join(getLayout().instanceHome, '.config', 'opencode', 'plugins');
  assert.ok(pluginDir.startsWith(getLayout().testRoot + path.sep), `the plugin folder is inside the instance's own root: ${pluginDir}`);
  return pluginDir;
}

/** The flag the bot keeps for the session while its topic has the section OFF — where the OpenCode plugin looks (`utils/compactMistakesFlags.ts`). */
function getOffFlagPath(sessionId: string): string {
  return path.join(getOpenCodeCompactMistakesOffDir(getInstancePluginDir()), sessionId);
}

/** What the plugin pushed into the prompt of the session's latest compaction. */
function getLatestPluginContext(): string[] {
  return fakeOpenCode.pluginContexts.filter((entry) => entry.sessionId === getTopicSessionId()).at(-1)?.context ?? [];
}

/** The instruction the `index`-th `/compact` of the session reached the server with. */
function getSummarizeInstruction(index: number): string {
  const body = fakeOpenCode.listRequests('POST', `/session/${getTopicSessionId()}/summarize`)[index]?.body as { instruction?: string } | null;
  return body?.instruction ?? '';
}

async function setSummaryVisible(isVisible: boolean): Promise<void> {
  await topic.sendAndAwaitReply(`/compact_summary ${isVisible ? 'on' : 'off'}`, getSummarySwitchConfirmation(isVisible));
}

/** The picker of `/compact_summary` changes nothing and, answered after, shows every send the compaction queued before it went out (sends are first come, first served). */
async function waitForSendQueueToDrain(): Promise<void> {
  await topic.sendAndAwaitReply('/compact_summary', enDict['compactSummary.title'].split('{state}')[0]);
}

/** `/compact` with the next summarize playing `summary` out; resolves once the server has the request and has run the plugin for it. */
async function runCompact(summary: string, messageId: string): Promise<void> {
  const summarizesBefore = fakeOpenCode.listRequests('POST', `/session/${getTopicSessionId()}/summarize`).length;
  const pluginRunsBefore = fakeOpenCode.pluginContexts.length;
  fakeOpenCode.setNextSummarize({ messageId, chunks: cutSummary(summary) });
  fakeTelegram.pushOperatorMessage(openCodeTopic.threadId, '/compact');
  await getCharness().waitFor('the compaction to reach the server', replyTimeoutMs, () => fakeOpenCode.listRequests('POST', `/session/${getTopicSessionId()}/summarize`).length > summarizesBefore && fakeOpenCode.pluginContexts.length > pluginRunsBefore);
}

describe('The agent-mistakes section on OpenCode: built charness, fake Bot API, fake OpenCode', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-ocgaps-', [openCodeTopic.folder], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    topic = new TopicDriver(fakeTelegram, getCharness, openCodeTopic.threadId, replyTimeoutMs);
    const apiRoot = await fakeTelegram.start();
    // The plugin the bot installs for the server (`GET /config` of the fake reports it loaded): the fake runs its hook before every compaction.
    const pluginDir = getInstancePluginDir();
    assert.equal(installOpenCodeCompactPlugin(pluginDir), 'written');
    fakeOpenCode = new FakeOpenCodeServer({ version: fakeOpenCodeVersion, models: [openCodeModel], defaultModel: openCodeModel, pluginDir });
    const openCodeUrl = await fakeOpenCode.start(await getFreePort());
    writeFakeOpenCodeBinary(layout.binDir, { version: fakeOpenCodeVersion, models: [openCodeModel] });
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
    await topic.sendAndAwaitReply(`/bind ${openCodeTopic.folder}`, `Bound to \`${openCodeTopic.folder}\``);
    await topic.sendAndAwaitReply('/opencode', 'ready in');
    getTopicSessionId();
  });

  it('summary HIDDEN, /compact: the notices, then the section ALONE under its header — in that order, and nothing else of the summary', async () => {
    const messageBefore = getNewestMessageId();
    await runCompact(buildSummary(instructionGapsText), 'msg_summary_1');
    assert.deepEqual(getLatestPluginContext(), [getOpenCodeCompactPluginContext(true)], 'the plugin asks for the section (`/compact_mistakes` is on by default)');
    await topic.waitForMessage('the section', (message) => message.message_id > messageBefore && message.text.includes(enDict['compact.instructionGapsHeader']));
    await waitForSendQueueToDrain();

    const texts = listTextsAfter(messageBefore);
    const startedAt = texts.findIndex((text) => text === enDict['compact.started']);
    const doneAt = texts.findIndex((text) => text.startsWith('✅'));
    const sectionAt = texts.findIndex((text) => text.includes(instructionGapsText));
    assert.ok(startedAt >= 0 && doneAt > startedAt, `the start notice, then the completion line: ${JSON.stringify(texts)}`);
    assert.ok(sectionAt > doneAt, `the section comes after the completion line, not while the summary streams: ${JSON.stringify(texts)}`);
    assert.equal(texts[sectionAt], `${enDict['compact.instructionGapsHeader']}\n\n${instructionGapsText}`, 'alone under its header');
    assert.equal(texts.filter((text) => text.includes(instructionGapsText)).length, 1, 'once');
    assert.ok(!texts.some((text) => text.includes(summaryBody) || text.includes(closingText) || text.includes(enDict['compact.summaryHeader'])), 'the full summary stays hidden');
    assert.ok(!texts.some(hasMarker), 'no marker reaches the topic');
  });

  it('summary HIDDEN, the server compacts by itself mid-turn, twice: the section of each of those summaries is posted, once', async () => {
    const sessionId = getTopicSessionId();
    const messageBefore = getNewestMessageId();
    for (const [index, summaryMessageId] of ['msg_summary_2', 'msg_summary_2b'].entries()) {
      // The agent has streamed text in this turn and the summary follows: it is told from the summary before it by its
      // message id, and a section posted for the one before must not close this one.
      fakeOpenCode.emitAssistantText(sessionId, `msg_work_${index}`, `${agentWorkText} (${index})`);
      await topic.waitForMessage('the agent\'s text', (message) => message.message_id > messageBefore && message.text.includes(`${agentWorkText} (${index})`));
      const sectionsBefore = listTextsAfter(messageBefore).filter((text) => text.includes(instructionGapsText)).length;
      await fakeOpenCode.emitCompactionSummary(sessionId, { messageId: summaryMessageId, chunks: cutSummary(buildSummary(instructionGapsText)) });
      await getCharness().waitFor(`the section of the server's own compaction ${index + 1}`, replyTimeoutMs, () => listTextsAfter(messageBefore).filter((text) => text.includes(instructionGapsText)).length > sectionsBefore);
    }
    await waitForSendQueueToDrain();

    const texts = listTextsAfter(messageBefore);
    assert.equal(texts.filter((text) => text.includes(instructionGapsText)).length, 2, `one section per summary: ${JSON.stringify(texts)}`);
    assert.ok(texts.filter((text) => text.includes(instructionGapsText)).every((text) => text === `${enDict['compact.instructionGapsHeader']}\n\n${instructionGapsText}`), 'each alone under its header');
    assert.ok(!texts.some((text) => text.includes(summaryBody) || text.includes(closingText)), 'the full summary stays hidden');
    assert.ok(!texts.some(hasMarker), 'no marker reaches the topic');
  });

  it('summary HIDDEN, the server compacts inside the debounce of the agent\'s own words: they are not taken for the summary — they reach the topic, and the section is posted once', async () => {
    const sessionId = getTopicSessionId();
    const messageBefore = getNewestMessageId();
    // No wait between the words and the summary's first piece: the bot's buffer holds both when its debounce fires.
    fakeOpenCode.emitAssistantText(sessionId, 'msg_work_mixed', agentMixedText);
    await fakeOpenCode.emitCompactionSummary(sessionId, { messageId: 'msg_summary_3', chunks: cutSummary(buildSummary(instructionGapsText)) });
    await topic.waitForMessage('the agent\'s words', (message) => message.message_id > messageBefore && message.text.includes(agentMixedText));
    await getCharness().waitFor('the section of the server\'s own compaction', replyTimeoutMs, () => listTextsAfter(messageBefore).some((text) => text.includes(instructionGapsText)));
    await waitForSendQueueToDrain();

    const texts = listTextsAfter(messageBefore);
    assert.equal(texts.filter((text) => text.includes(instructionGapsText)).length, 1, `the section once: ${JSON.stringify(texts)}`);
    assert.ok(texts.some((text) => text.includes(agentMixedText)), 'the agent\'s words are shown');
    assert.ok(!texts.some((text) => text.includes(summaryBody) || text.includes(closingText)), 'the full summary stays hidden');
    assert.ok(!texts.some(hasMarker), 'no marker reaches the topic');
  });

  it('summary HIDDEN, the agent goes on in the same turn after the compaction (the summary\'s finish is lost): its answer is not taken for the summary — it reaches the topic', async () => {
    const sessionId = getTopicSessionId();
    const messageBefore = getNewestMessageId();
    await fakeOpenCode.emitCompactionSummary(sessionId, { messageId: 'msg_summary_4', chunks: cutSummary(buildSummary(instructionGapsText)) }, {
      isFinishDropped: true,
      beforeIdle: async () => {
        fakeOpenCode.emitAssistantText(sessionId, 'msg_work_after', agentAfterText);
        await sleep(pastDebounceMs);
      },
    });
    await topic.waitForMessage('the agent\'s answer after the compaction', (message) => message.message_id > messageBefore && message.text.includes(agentAfterText));
    await waitForSendQueueToDrain();

    const texts = listTextsAfter(messageBefore);
    assert.equal(texts.filter((text) => text.includes(instructionGapsText)).length, 1, `the section once: ${JSON.stringify(texts)}`);
    assert.ok(!texts.some((text) => text.includes(summaryBody) || text.includes(closingText)), 'the full summary stays hidden');
    assert.ok(!texts.some(hasMarker), 'no marker reaches the topic');
  });

  it('summary SHOWN, /compact: the stream reaches the topic with no marker line and no none line, the section under its header, in exactly one message', async () => {
    await setSummaryVisible(true);
    const messageBefore = getNewestMessageId();
    await runCompact(buildSummary(instructionGapsText), 'msg_summary_3');
    await topic.waitForMessage('the end of the streamed summary', (message) => message.message_id > messageBefore && message.text.includes(closingText));
    await waitForSendQueueToDrain();

    const texts = listTextsAfter(messageBefore);
    const shown = texts.join('\n');
    assert.ok(shown.includes(summaryBody), 'the summary is shown');
    assert.ok(!hasMarker(shown), `no marker line reaches the topic: ${shown}`);
    assert.ok(shown.includes(`${summaryBody}\n${enDict['compact.instructionGapsHeader']}\n${instructionGapsText}\n`), `the section sits under its header, on lines of their own, ahead of the checklist: ${shown}`);
    assert.equal(texts.filter((text) => text.includes(instructionGapsText)).length, 1, 'the section is in exactly one message');
    assert.ok(!texts.some((text) => text.startsWith(enDict['compact.instructionGapsHeader'])), 'and that message is the summary, not a message of its own');
    assert.ok(shown.indexOf('1. load these skills: commit') > shown.indexOf(instructionGapsText), 'the checklist follows the section');
  });

  it('summary SHOWN, the server compacts by itself and the agent goes on in the same turn (the summary\'s finish is lost): the summary is shown once and clean, and the answer follows it on a line of its own', async () => {
    const sessionId = getTopicSessionId();
    const messageBefore = getNewestMessageId();
    await fakeOpenCode.emitCompactionSummary(sessionId, { messageId: 'msg_summary_5', chunks: cutSummary(buildSummary(instructionGapsText)) }, {
      isFinishDropped: true,
      beforeIdle: async () => {
        fakeOpenCode.emitAssistantText(sessionId, 'msg_work_after_shown', agentAfterText);
        await sleep(pastDebounceMs);
      },
    });
    await topic.waitForMessage('the agent\'s answer after the compaction', (message) => message.message_id > messageBefore && message.text.includes(agentAfterText));
    await waitForSendQueueToDrain();

    const texts = listTextsAfter(messageBefore);
    assert.equal(texts.filter((text) => text.includes(summaryBody)).length, 1, `the summary is shown once: ${JSON.stringify(texts)}`);
    assert.equal(texts.filter((text) => text.includes(instructionGapsText)).length, 1, 'with its section, once');
    assert.ok(!texts.some(hasMarker), 'no marker reaches the topic');
    // The bot joins standalone outputs queued inside one debounce into one message, a line apart; what must never happen is
    // the answer raw-appended to the line before it, as the tail of the summary it is no part of.
    const answerText = texts.find((text) => text.includes(agentAfterText)) ?? '';
    const answerAt = answerText.indexOf(agentAfterText);
    assert.ok(answerAt === 0 || answerText[answerAt - 1] === '\n', `the answer starts a line: ${JSON.stringify(answerText)}`);
  });

  it('summary SHOWN, a section that says there were no mistakes: no header, no none line, no marker', async () => {
    const messageBefore = getNewestMessageId();
    await runCompact(buildSummary(compactionNoGapsLine), 'msg_summary_4');
    await topic.waitForMessage('the end of the streamed summary', (message) => message.message_id > messageBefore && message.text.includes(closingText));
    await waitForSendQueueToDrain();

    const shown = listTextsAfter(messageBefore).join('\n');
    assert.ok(shown.includes(summaryBody), 'the summary is shown');
    assert.ok(!hasMarker(shown) && !shown.includes(compactionNoGapsLine) && !shown.includes(enDict['compact.instructionGapsHeader']), `nothing of the empty section reaches the topic: ${shown}`);
    assert.ok(shown.includes('1. load these skills: commit'), 'the rest of the summary is intact');
  });

  // The fake's summaries keep their section through the steps below, whatever they are asked: a real model that is not
  // asked writes none, so what keeps the topic clean here is the bot's own gate — the part a real agent never exercises.
  it('`/compact_mistakes off`: /compact asks for no section — the skills and the checklist stay — the plugin\'s flag is kept, and nothing of the section is posted', async () => {
    await setSummaryVisible(false);
    await topic.sendAndAwaitReply('/compact_mistakes off', getMistakesSwitchConfirmation(false));
    assert.ok(fs.existsSync(getOffFlagPath(getTopicSessionId())), 'the bot keeps the flag the OpenCode plugin reads for this session');
    const compactionsBefore = fakeOpenCode.listRequests('POST', `/session/${getTopicSessionId()}/summarize`).length;
    const messageBefore = getNewestMessageId();
    await runCompact(buildSummary(instructionGapsText), 'msg_summary_5');
    // The server runs the plugin that is loaded (the bot then adds no resume guidance of its own): the plugin is what asks.
    assert.deepEqual(getLatestPluginContext(), [getOpenCodeCompactPluginContext(false)], 'the plugin asks for no section — the skills and the checklist stay');
    assert.ok(!getLatestPluginContext()[0].includes(compactionGapsGuidance) && !getLatestPluginContext()[0].includes(compactionGapsStartMarker));
    assert.ok(getLatestPluginContext()[0].includes(compactionSkillsGuidance) && getLatestPluginContext()[0].includes(compactionChecklistGuidance));
    assert.ok(!getSummarizeInstruction(compactionsBefore).includes(compactionGapsGuidance), 'and the bot\'s own instruction carries none');
    await topic.waitForMessage('the completion line', (message) => message.message_id > messageBefore && message.text.startsWith('✅'));
    await waitForSendQueueToDrain();

    const texts = listTextsAfter(messageBefore);
    assert.ok(!texts.some((text) => text.includes(enDict['compact.instructionGapsHeader']) || text.includes(instructionGapsText)), `the section is not posted although the summary holds one: ${JSON.stringify(texts)}`);
    assert.ok(!texts.some((text) => text.includes(summaryBody) || text.includes(closingText)), 'the full summary stays hidden');
  });

  it('`/compact_mistakes off`: the server\'s own compaction posts no section either', async () => {
    const sessionId = getTopicSessionId();
    const messageBefore = getNewestMessageId();
    fakeOpenCode.emitAssistantText(sessionId, 'msg_work_off', `${agentWorkText} (off)`);
    await topic.waitForMessage('the agent\'s text', (message) => message.message_id > messageBefore && message.text.includes(`${agentWorkText} (off)`));
    await fakeOpenCode.emitCompactionSummary(sessionId, { messageId: 'msg_summary_off', chunks: cutSummary(buildSummary(instructionGapsText)) });
    assert.deepEqual(getLatestPluginContext(), [getOpenCodeCompactPluginContext(false)], 'the plugin asks for no section in the server\'s own compaction either');
    await waitForSendQueueToDrain();

    const texts = listTextsAfter(messageBefore);
    assert.ok(!texts.some((text) => text.includes(enDict['compact.instructionGapsHeader']) || text.includes(instructionGapsText)), `no section is posted: ${JSON.stringify(texts)}`);
    assert.ok(!texts.some((text) => text.includes(summaryBody) || text.includes(closingText)), 'the full summary stays hidden');
  });

  it('`/compact_mistakes on` again: the flag is gone, /compact asks for the section again, and /compact and the server\'s own compaction post it', async () => {
    await topic.sendAndAwaitReply('/compact_mistakes on', getMistakesSwitchConfirmation(true));
    assert.equal(fs.existsSync(getOffFlagPath(getTopicSessionId())), false, 'the flag is gone');
    const compactionsBefore = fakeOpenCode.listRequests('POST', `/session/${getTopicSessionId()}/summarize`).length;
    const messageBefore = getNewestMessageId();
    await runCompact(buildSummary(instructionGapsText), 'msg_summary_6');
    assert.deepEqual(getLatestPluginContext(), [getOpenCodeCompactPluginContext(true)], 'the plugin asks for the section again');
    assert.ok(!getSummarizeInstruction(compactionsBefore).includes(compactionGapsGuidance), 'the plugin, not the bot, asks: the plugin is loaded');
    await topic.waitForMessage('the section', (message) => message.message_id > messageBefore && message.text.includes(enDict['compact.instructionGapsHeader']));

    const ownMessageBefore = getNewestMessageId();
    await fakeOpenCode.emitCompactionSummary(getTopicSessionId(), { messageId: 'msg_summary_on_again', chunks: cutSummary(buildSummary(instructionGapsText)) });
    await topic.waitForMessage('the section of the server\'s own compaction', (message) => message.message_id > ownMessageBefore && message.text.includes(enDict['compact.instructionGapsHeader']));
    assert.deepEqual(getLatestPluginContext(), [getOpenCodeCompactPluginContext(true)], 'the plugin asks for the section in the server\'s own compaction again');
  });
});
