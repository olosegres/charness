/**
 * @description The skills restore after a compaction on OpenCode, at PROCESS level: the BUILT charness started the way an
 * isolated instance is (`scripts/run-isolated.sh`) against the fake Bot API (`telegramE2e/fakeTelegram.ts`) and the fake
 * OpenCode server (`openCodeE2e/fakeOpenCodeServer.ts`), which keeps the session's history (the agent's skill calls
 * included), serves `GET /skill`, and runs every model request — each prompt, and its own "Continue…" after an overflow
 * compaction — through the transform hook of the compaction plugin the bot installs, the way the real fork does (measured for
 * the plan's S0). One flow, in order:
 *
 *   boot → a topic bound to a folder runs an OpenCode session; the agent loads a skill — no compaction yet, nothing added
 *   → the server compacts by itself MID-TURN and goes on alone: that very request holds the skill's whole current text
 *   → `/compact` with the summary SHOWN, then a message: the message's request holds the restore — a skill loaded after the
 *     summary is only named — and the summary streamed to the topic carries no skills block
 *   → the server restarts (a new plugin instance, nothing kept): the same restore is rebuilt from the stored history
 *   → `GET /skill` hangs: the request still comes within the lookup timeout, the skills named with load lines; the next
 *     STEP of the same turn, with the server answering again, gets the whole restore — the provider too, although the turn's
 *     conversion of the earlier messages is reused (the fork's `appendOnlyModelMessages`) — and so does a new turn
 *   → NOTHING of the restore reached the topic, in any message or edit
 *
 * The plugin's own branches (no summary, the retained tail, the cache, refusals, the log line) are pinned in
 * `openCodeCompactPlugin.test.ts`; the self-contained functions it embeds in `skillsRestore.test.ts` and `compactOnIdle.test.ts`.
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
import { FakeOpenCodeServer, loadBuiltOpenCodeCompactPlugin, writeFakeOpenCodeBinary, type FakeOpenCodeModelRequest } from './openCodeE2e/fakeOpenCodeServer';
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
import { compactionChecklistSkillsItem, compactionSkillsBlockEndMarker, compactionSkillsBlockStartMarker } from '../utils/compactOnIdle';
import { openCodeAncestryLookupTimeoutMs } from '../utils/openCodeCompactPlugin';
import { claudeSkillBaseDirPrefix, skillsRestoreHeader } from '../utils/skillsRestore';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';

const openCodeTopic = { threadId: 181, folder: 'skills-restore-opencode' };
const fakeOpenCodeVersion = '1.17.11';
const openCodeModel = 'anthropic/claude-sonnet-4-5';
const replyTimeoutMs = 20 * 1000;

const reviewSkillName = 'oc-review';
const commitSkillName = 'oc-commit';
const reviewBodyMarker = 'OC-REVIEW-BODY-MARK';
const commitBodyMarker = 'OC-COMMIT-BODY-MARK';
const summaryBody = 'OC-SUMMARY-BODY: the parser is half read.';
/** Item 1 as a model writes it when it follows the guidance: the guidance's own text, then the names. */
const checklistLine = `1. ${compactionChecklistSkillsItem} ${reviewSkillName}`;

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

function getSkillDir(name: string): string {
  return path.join(getLayout().workRoot, openCodeTopic.folder, '.opencode', 'skills', name);
}

function getTopicSessionId(): string {
  const folderPath = path.join(getLayout().workRoot, openCodeTopic.folder);
  const session = [...fakeOpenCode.sessions.values()].find((candidate) => candidate.directory === folderPath);
  assert.ok(session, `a fake OpenCode session for ${folderPath}`);
  return session.id;
}

/** OpenCode's global plugin folder of the INSTANCE (its temp home), never this process's real one. */
function getInstancePluginDir(): string {
  const pluginDir = path.join(getLayout().instanceHome, '.config', 'opencode', 'plugins');
  assert.ok(pluginDir.startsWith(getLayout().testRoot + path.sep), `the plugin folder is inside the instance's own root: ${pluginDir}`);
  return pluginDir;
}

/** A summary as the model writes it with the instruction followed: a body, the skills block, the checklist. */
function buildSummary(): string {
  return ['## Goals', summaryBody, compactionSkillsBlockStartMarker, reviewSkillName, compactionSkillsBlockEndMarker, checklistLine].join('\n');
}

/** The summary in pieces that cut the block's start marker and one of its names, as a stream may. */
function cutSummary(summary: string): string[] {
  const cuts = [summary.indexOf(compactionSkillsBlockStartMarker) + 6, summary.indexOf(`\n${reviewSkillName}\n`) + 4].sort((a, b) => a - b);
  return [summary.slice(0, cuts[0]), summary.slice(cuts[0], cuts[1]), summary.slice(cuts[1])];
}

/** The bot's output formatting HTML-escapes `<<<`: a topic text is checked for both forms. */
function hasMarker(text: string): boolean {
  return text.includes('<<<') || text.includes('&lt;&lt;&lt;');
}

function getSummarySwitchConfirmation(isVisible: boolean): string {
  return enDict['compactSummary.setThisTopic'].replace('{state}', isVisible ? enDict['compactSummary.on'] : enDict['compactSummary.off']);
}

async function setSummaryVisible(isVisible: boolean): Promise<void> {
  await topic.sendAndAwaitReply(`/compact_summary ${isVisible ? 'on' : 'off'}`, getSummarySwitchConfirmation(isVisible));
}

function getNewestMessageId(): number {
  return topic.listMessages().at(-1)?.message_id ?? 0;
}

/**
 * A message from the person: the prompt reaches the server, the model request that answers it runs through the plugin, and
 * the agent answers and goes idle. Resolves the model request.
 */
async function sendPromptAndAnswer(label: string): Promise<FakeOpenCodeModelRequest> {
  const requestsBefore = fakeOpenCode.modelRequests.length;
  fakeTelegram.pushOperatorMessage(openCodeTopic.threadId, `${label} please go on`);
  await getCharness().waitFor(`the ${label} model request`, replyTimeoutMs, () => fakeOpenCode.modelRequests.length > requestsBefore);
  const request = fakeOpenCode.modelRequests[requestsBefore];
  const sessionId = getTopicSessionId();
  fakeOpenCode.emitAssistantText(sessionId, `msg_answer_${label}`, `Answer to ${label}.`);
  await topic.waitForMessage(`the answer to ${label}`, (message) => message.text.includes(`Answer to ${label}.`));
  fakeOpenCode.emitSessionIdle(sessionId);
  return request;
}

/** The server compacting by itself mid-turn and going on: resolves the model request of its own continuation. */
async function compactByServerAndContinue(messageId: string): Promise<FakeOpenCodeModelRequest> {
  const requestsBefore = fakeOpenCode.modelRequests.length;
  await fakeOpenCode.emitCompactionSummary(getTopicSessionId(), { messageId, chunks: cutSummary(buildSummary()) }, { isContinued: true });
  const request = fakeOpenCode.modelRequests.slice(requestsBefore).find((candidate) => candidate.phase === 'continuation');
  assert.ok(request, 'the server went on with a model request of its own');
  return request;
}

/** The restore of the review skill, whole, with its current text. */
function assertReviewRestored(request: FakeOpenCodeModelRequest, description: string): string {
  const text = request.restoreText;
  assert.ok(text, `${description}: the restore is in the request`);
  assert.equal(request.providerRestoreText, text, `${description}: and the provider got it as it is`);
  assert.ok(text.startsWith(skillsRestoreHeader), description);
  assert.ok(text.includes(`- ${reviewSkillName}: its current full text is below (base directory: ${getSkillDir(reviewSkillName)})`), `${description}: listed as restored`);
  assert.ok(text.includes(`${claudeSkillBaseDirPrefix}${getSkillDir(reviewSkillName)}`) && text.includes(reviewBodyMarker), `${description}: the skill whole`);
  return text;
}

/** Every text the bot sent or edited into the chat, whatever the method. */
function listEveryBotText(): string[] {
  return ['sendMessage', 'editMessageText', 'sendDocument', 'sendMessageDraft'].flatMap((method) => fakeTelegram.listCalls(method).map((call) => JSON.stringify(call.payload)));
}

describe('The skills restore after a compaction on OpenCode: built charness, fake Bot API, fake OpenCode', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-ocrestore-', [openCodeTopic.folder], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    topic = new TopicDriver(fakeTelegram, getCharness, openCodeTopic.threadId, replyTimeoutMs);
    const apiRoot = await fakeTelegram.start();
    const pluginDir = getInstancePluginDir();
    // The built bot's plugin, as the bot installs it (the runner's copy of the module would name another file).
    assert.equal(loadBuiltOpenCodeCompactPlugin().installOpenCodeCompactPlugin(pluginDir), 'written');
    const skills = [
      { name: reviewSkillName, location: path.join(getSkillDir(reviewSkillName), 'SKILL.md'), content: `# review\n\n${reviewBodyMarker}: read the diff line by line.\n` },
      { name: commitSkillName, location: path.join(getSkillDir(commitSkillName), 'SKILL.md'), content: `# commit\n\n${commitBodyMarker}\n` },
    ];
    fakeOpenCode = new FakeOpenCodeServer({ version: fakeOpenCodeVersion, models: [openCodeModel], defaultModel: openCodeModel, pluginDir, skills, isModelRequestSimulated: true });
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
    assert.deepEqual(fakeOpenCode.unhandled, [], 'the bot (and its plugin) asked the fake OpenCode for nothing it does not model');
  });

  it('boots, binds the topic, starts an OpenCode session; the agent loads a skill — no compaction yet, nothing is added', async () => {
    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    await topic.sendAndAwaitReply(`/bind ${openCodeTopic.folder}`, `Bound to \`${openCodeTopic.folder}\``);
    await topic.sendAndAwaitReply('/opencode', 'ready in');
    const request = await sendPromptAndAnswer('OCR-1');
    assert.equal(request.restoreText, null, 'no summary yet: the request is left as it is');
    fakeOpenCode.recordSkillCall(getTopicSessionId(), reviewSkillName, getSkillDir(reviewSkillName));
  });

  it('the server compacts by itself MID-TURN and goes on alone: that very request holds the skill\'s whole current text', async () => {
    const request = await compactByServerAndContinue('msg_summary_1');
    assert.equal(request.summaryId, 'msg_summary_1');
    assertReviewRestored(request, 'the continuation after the server\'s own compaction');
  });

  it('`/compact` with the summary SHOWN, then a message: the restore is in that request — a skill loaded after the summary only named — and the streamed summary carries no block', async () => {
    await setSummaryVisible(true);
    const messageBefore = getNewestMessageId();
    const summarizesBefore = fakeOpenCode.listRequests('POST', `/session/${getTopicSessionId()}/summarize`).length;
    fakeOpenCode.setNextSummarize({ messageId: 'msg_summary_2', chunks: cutSummary(buildSummary()) });
    fakeTelegram.pushOperatorMessage(openCodeTopic.threadId, '/compact');
    await getCharness().waitFor('the compaction to reach the server', replyTimeoutMs, () => fakeOpenCode.listRequests('POST', `/session/${getTopicSessionId()}/summarize`).length > summarizesBefore);
    const summaryMessage = await topic.waitForMessage('the streamed summary', (message) => message.message_id > messageBefore && message.text.includes(summaryBody));
    await topic.waitForMessage('the completion line', (message) => message.message_id > messageBefore && message.text.startsWith('✅'));
    const shown = topic.listMessages().find((message) => message.message_id === summaryMessage.message_id)?.text ?? '';
    assert.ok(shown.includes(checklistLine), `the checklist names the skill for the person: ${shown}`);
    assert.ok(!hasMarker(shown) && !shown.split('\n').includes(reviewSkillName), `the block — markers and names — is not shown: ${shown}`);

    // The agent loads another skill after the summary: it is in what the model sees already.
    fakeOpenCode.recordSkillCall(getTopicSessionId(), commitSkillName, getSkillDir(commitSkillName));
    const request = await sendPromptAndAnswer('OCR-2');
    assert.equal(request.summaryId, 'msg_summary_2');
    const text = assertReviewRestored(request, 'the message after /compact');
    assert.ok(text.includes(`- ${commitSkillName}: its full text is already in your context`), 'the skill loaded after the summary is only named');
    assert.ok(!text.includes(commitBodyMarker), 'and not given twice');
  });

  it('the server restarts — a new plugin instance, nothing kept: the same restore is rebuilt from the stored history', async () => {
    const before = fakeOpenCode.modelRequests.at(-1)?.restoreText;
    assert.ok(before);
    fakeOpenCode.restartPluginInstance();
    const request = await sendPromptAndAnswer('OCR-3');
    assert.equal(request.restoreText, before, 'the same text: the prompt cache still holds');
  });

  it('`GET /skill` hangs: the request still comes within the lookup timeout, every skill named with a load line — and once the server answers again, the next step of the SAME turn gets the whole restore, at the provider too', async () => {
    let releaseSkillList: (status: number | null) => void = () => {};
    fakeOpenCode.holdNextRequest('GET', /^\/skill$/, new Promise((resolve) => { releaseSkillList = resolve; }));
    const startedAt = Date.now();
    const request = await compactByServerAndContinue('msg_summary_3');
    releaseSkillList(null);
    // The compaction itself streams its pieces with gaps; what is bounded is the request's wait for the lookup on top of them.
    assert.ok(Date.now() - startedAt < 3 * 650 + openCodeAncestryLookupTimeoutMs + 3000, `the request did not wait on the hung lookup: ${Date.now() - startedAt} ms`);
    const text = request.restoreText ?? '';
    assert.ok(text.includes(`- ${reviewSkillName}: not restored here: load it with the skill tool`), `the load line: ${text}`);
    assert.ok(text.includes(`- ${commitSkillName}: not restored here: load it with the skill tool`));
    assert.ok(!text.includes(reviewBodyMarker), 'no text it could not get');

    assert.equal(request.providerRestoreText, text, 'the provider got that partial restore');

    // The agent goes on in the SAME turn (a tool call, the model asked again) and the server answers by now: that restore was
    // not whole, so it was not kept and is built again — and the provider must get the whole one, although the turn's
    // conversion of the messages before is kept and reused.
    const sameTurnStep = await fakeOpenCode.continueTurn(getTopicSessionId());
    assert.equal(sameTurnStep.summaryId, 'msg_summary_3');
    assert.ok((sameTurnStep.providerRestoreText ?? '').includes(reviewBodyMarker), `the provider gets the repaired restore within the same turn: ${sameTurnStep.providerRestoreText}`);
    assertReviewRestored(sameTurnStep, 'the next step of the same turn');
    // A later step with nothing changed keeps it.
    assertReviewRestored(await fakeOpenCode.continueTurn(getTopicSessionId()), 'one more step of the same turn');

    // A new turn gets it too.
    const next = await sendPromptAndAnswer('OCR-4');
    assert.equal(next.summaryId, 'msg_summary_3');
    assertReviewRestored(next, 'the request after the server answers again');
  });

  it('nothing of the restore reached the topic — in no message and no edit', () => {
    const texts = listEveryBotText();
    assert.ok(texts.length > 10, `the flow posted plenty: ${texts.length}`);
    for (const forbidden of [skillsRestoreHeader, 'Charness: skills restored', reviewBodyMarker, commitBodyMarker, claudeSkillBaseDirPrefix, compactionSkillsBlockStartMarker, compactionSkillsBlockEndMarker, '&lt;&lt;&lt;LOADED_SKILLS']) {
      assert.deepEqual(texts.filter((text) => text.includes(forbidden)), [], `"${forbidden}" never reaches the topic`);
    }
  });
});
