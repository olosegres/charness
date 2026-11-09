/**
 * @description The agent-mistakes section of a compaction summary, at PROCESS level: the BUILT charness started the way an
 * isolated instance is (`scripts/run-isolated.sh`) against the fake Bot API of `telegramE2e/fakeTelegram.ts`, with the fake
 * `claude` (`jiraE2e/fakeClaude.ts`) leaving the summary a flow gives it in its transcript at every compaction, as the real
 * CLI does. One flow, in order:
 *
 *   boot → a topic is bound and the agent started → it answers a first message, and its turn ends
 *   → `/compact` asks the agent for the section (the guidance is in the instruction it reads)
 *   → the summary HIDDEN (the default): the topic gets the two notices and then the section ALONE under its own header —
 *     no summary header, no summary text, no marker
 *   → the summary SHOWN: the full summary is posted and carries the section; it is in exactly one message
 *   → the CLI's own overflow compaction (no `/compact` ran): the section is posted in BOTH modes, since nobody posts that
 *     compaction's summary
 *   → a section that says there were no mistakes: nothing is posted for it, and the none line reaches the topic nowhere
 *   → `/compact_mistakes off`: the agent is NOT asked for the section — not by `/compact`, and not by the CLI's own overflow
 *     compaction, whose `PreCompact` hook finds the flag the bot keeps for the session — and nothing of it is posted, even
 *     though the fake's summary still holds one (the bot's own gate); the same after the agent is stopped and started anew
 *     (a NEW session id, flagged at its start) and after the bot restarts with a flag missing (flagged again at boot); back
 *     `on`: the flag is gone, both ask again and the section is posted again
 *
 * The idle compaction and the OpenCode stream are pinned through the compaction module in `compactionInstructionGaps.test.ts`.
 *
 * Nothing leaves the machine: the Bot API is on loopback and the agent is a fake. Everything the test starts is
 * stopped in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import { restartCharnessWithState } from './e2e/fallbackFlowKit';
import { fakeClaudeCompactionSummaryFileName, fakeClaudeLogFileNames, type FakeClaudePreCompactHookRun, type FakeClaudeTurn } from './jiraE2e/fakeClaudeContract';
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
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';
import { claudeJsonStreamUsageLogPrefix } from '../adapters/claudeJsonStreamAdapter';
import { enDict } from '../i18n/en';
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
import { getHookCompactionInstruction } from '../utils/claudeCompactHook';
import { getClaudeCompactMistakesOffDir } from '../utils/compactMistakesFlags';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const topicThreadId = 111;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const projectFolder = 'compaction-gaps';
const topicKey = `${group.id}:${topicThreadId}`;
const launchLine = 'Launching Telegraf bot (long polling';
const firstPromptLabel = 'GAP-1';

const bootTimeoutMs = 60 * 1000;
const replyTimeoutMs = 20 * 1000;
const agentStartTimeoutMs = 60 * 1000;
const compactionTimeoutMs = 30 * 1000;

const summaryBody = 'FAKE-SUMMARY-BODY: the refactor is half done.';
const instructionGapsText = '1. Mistake (repeated): pushed without asking. Change: add a never-push-without-permission rule to CLAUDE.md.\n2. Mistake: skipped the lint step. Change: a lint line in the commit skill.';
const closingText = 'FAKE-CLOSING: next, run the suite.';

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
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

function listAgentTurns(label: string): FakeClaudeTurn[] {
  return readJsonLines<FakeClaudeTurn>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.turns)).filter((turn) => turn.issueKey === label);
}

function listCompactions(): Array<{ sessionId: string; pid: number; instruction: string }> {
  return readJsonLines<{ sessionId: string; pid: number; instruction: string }>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.compactions));
}

/** What the `PreCompact` hooks printed for each compaction the fake ran, in order: the instruction the real CLI appends to its own. */
function listPreCompactHookRuns(): FakeClaudePreCompactHookRun[] {
  return readJsonLines<FakeClaudePreCompactHookRun>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.preCompactHooks));
}

/** The flag the bot keeps for a session while its topic has the section OFF — where the hook looks (`utils/compactMistakesFlags.ts`). */
function getOffFlagPath(sessionId: string): string {
  return path.join(getClaudeCompactMistakesOffDir(getLayout().dataDir), sessionId);
}

/** How many agent turns have ended so far: the usage line the bot logs at each. */
function countEndedTurns(): number {
  return getCharness().output.split(`${claudeJsonStreamUsageLogPrefix}${topicKey}`).length - 1;
}

/** The summary the fake leaves in its transcript at every compaction: a body, the section in its markers, the closing section. */
function writeFakeSummary(sectionBody: string): void {
  const summary = [summaryBody, compactionGapsStartMarker, sectionBody, compactionGapsEndMarker, compactionClosingStartMarker, closingText, compactionClosingEndMarker].join('\n');
  fs.writeFileSync(path.join(getLayout().fakeStateDir, fakeClaudeCompactionSummaryFileName), summary);
}

/** The id of the newest message of the topic, whoever wrote it: what a later step's messages are told apart from. */
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

/** Set `/compact_summary` and wait for the bot's confirmation. */
async function setSummaryVisible(isVisible: boolean): Promise<void> {
  await topic.sendAndAwaitReply(`/compact_summary ${isVisible ? 'on' : 'off'}`, getSummarySwitchConfirmation(isVisible));
}

/**
 * Everything the bot posted for the compaction, once it is over: the picker of `/compact_summary` (changes nothing) answered
 * after it is the barrier — the bot's sends go out in order, so nothing the compaction posted can still be on its way once
 * this one is here.
 */
async function waitForSendQueueToDrain(afterMessageId: number): Promise<void> {
  const barrier = await topic.sendAndAwaitReply('/compact_summary', enDict['compactSummary.title'].split('{state}')[0]);
  assert.ok(barrier.message_id > afterMessageId);
}

describe('The agent-mistakes section of a compaction summary: built charness, fake Bot API, fake claude', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-compact-gaps-', [projectFolder], getFlowDeadlineMs());
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

  it('boots, binds the topic, starts the agent and gets a first answer', async () => {
    charness = new IsolatedCharness(getLayout());
    const pollsBefore = fakeTelegram.listCalls('getUpdates').length;
    await charness.start(bootTimeoutMs, (runOutput) => runOutput.includes(launchLine) && fakeTelegram.listCalls('getUpdates').length > pollsBefore);
    await topic.sendAndAwaitReply(`/bind ${projectFolder}`, `Bound to \`${projectFolder}\``);
    await topic.sendAndAwaitReply('/claude', 'ready in');
    fakeTelegram.pushOperatorMessage(topicThreadId, `${firstPromptLabel} [fake:answer] hello`);
    await getCharness().waitFor('the first prompt to reach the agent', agentStartTimeoutMs, () => listAgentTurns(firstPromptLabel).length === 1);
    // The bot refuses `/compact` while a turn runs: the turn's usage line is logged right before the agent stops counting as busy.
    await getCharness().waitFor('the first turn to end', agentStartTimeoutMs, () => getCharness().output.includes(`${claudeJsonStreamUsageLogPrefix}${topicKey}`));
  });

  it('summary HIDDEN (the default): /compact asks for the section, and the topic gets the notices and then the section ALONE', async () => {
    writeFakeSummary(instructionGapsText);
    const compactionsBefore = listCompactions().length;
    const messageBefore = getNewestMessageId();
    fakeTelegram.pushOperatorMessage(topicThreadId, '/compact');
    await getCharness().waitFor('the compaction to reach the agent', compactionTimeoutMs, () => listCompactions().length > compactionsBefore);
    assert.ok(listCompactions()[compactionsBefore].instruction.includes(compactionGapsGuidance), 'the agent is asked for the agent-mistakes section');

    await topic.waitForMessage('the section', (message) => message.message_id > messageBefore && message.text.includes(enDict['compact.instructionGapsHeader']));
    const texts = listTextsAfter(messageBefore);
    assert.ok(texts.some((text) => text.startsWith('🧹')), `the start notice: ${JSON.stringify(texts)}`);
    assert.ok(texts.some((text) => text.startsWith('✅ Context compacted')), 'the completion notice');
    const sectionMessages = texts.filter((text) => text.includes(instructionGapsText));
    assert.deepEqual(sectionMessages, [`${enDict['compact.instructionGapsHeader']}\n\n${instructionGapsText}`], 'the section is posted once, alone under its header');
    assert.ok(!texts.some((text) => text.includes(summaryBody) || text.includes(closingText) || text.includes(enDict['compact.summaryHeader'])), 'the full summary stays hidden');
    assert.ok(!texts.some((text) => text.includes('<<<')), 'no marker reaches the topic');
    assert.ok(texts.findIndex((text) => text.startsWith('✅ Context compacted')) < texts.findIndex((text) => text.includes(instructionGapsText)), 'the section comes after the completion notice');
  });

  it('summary SHOWN: the full summary is posted and carries the section — one message, markers stripped, not posted twice', async () => {
    await setSummaryVisible(true);
    const compactionsBefore = listCompactions().length;
    const messageBefore = getNewestMessageId();
    fakeTelegram.pushOperatorMessage(topicThreadId, '/compact');
    await getCharness().waitFor('the compaction to reach the agent', compactionTimeoutMs, () => listCompactions().length > compactionsBefore);
    const summaryMessage = await topic.waitForMessage('the full summary', (message) => message.message_id > messageBefore && message.text.startsWith(enDict['compact.summaryHeader']));
    await waitForSendQueueToDrain(summaryMessage.message_id);

    const texts = listTextsAfter(messageBefore);
    assert.ok(summaryMessage.text.includes(summaryBody) && summaryMessage.text.includes(closingText), 'the summary body and its closing section are posted');
    assert.equal(texts.filter((text) => text.includes(instructionGapsText)).length, 1, 'the section is in exactly one message');
    assert.ok(summaryMessage.text.includes(instructionGapsText), 'and that message is the full summary');
    // The proposals are labelled where they stand, so they do not read as more of the numbered next steps after them.
    assert.ok(summaryMessage.text.includes(`${enDict['compact.instructionGapsHeader']}\n${instructionGapsText}\n`), `the section sits under its header: ${summaryMessage.text}`);
    assert.ok(!texts.some((text) => text.startsWith(enDict['compact.instructionGapsHeader'])), 'no separate section message');
    assert.ok(!summaryMessage.text.includes('<<<'), 'the markers of both sections are stripped');
  });

  it('the CLI\'s own overflow compaction: the section is posted in BOTH modes, since nobody posts that compaction\'s summary', async () => {
    for (const [index, isVisible] of [false, true].entries()) {
      await setSummaryVisible(isVisible);
      const messageBefore = getNewestMessageId();
      const overflowLabel = `GAP-${index + 2}`;
      fakeTelegram.pushOperatorMessage(topicThreadId, `${overflowLabel} [fake:overflow] hello`);
      await getCharness().waitFor(`the ${overflowLabel} prompt to reach the agent`, agentStartTimeoutMs, () => listAgentTurns(overflowLabel).length === 1);

      const sectionMessage = await topic.waitForMessage(`the section of the overflow compaction (summary visible: ${isVisible})`, (message) => message.message_id > messageBefore && message.text.includes(enDict['compact.instructionGapsHeader']));
      // The CLI's own compaction asked for the section through the `PreCompact` hook of the launch, which the fake runs as the CLI does.
      assert.equal(listPreCompactHookRuns().at(-1)?.instruction, getHookCompactionInstruction(true), `the hook asks for the section (summary visible: ${isVisible})`);
      assert.equal(sectionMessage.text, `${enDict['compact.instructionGapsHeader']}\n\n${instructionGapsText}`);
      assert.ok(!listTextsAfter(messageBefore).some((text) => text.includes(summaryBody)), `the full summary of a compaction the bot did not run is never posted (visible: ${isVisible})`);
      // The turn ends before the next step: the bot refuses `/compact` while one runs.
      await getCharness().waitFor(`the ${overflowLabel} turn to end`, agentStartTimeoutMs, () => getCharness().output.split(`${claudeJsonStreamUsageLogPrefix}${topicKey}`).length - 1 >= 2 + index + 1);
    }
  });

  it('a section that says there were no mistakes posts nothing — and the none line reaches the topic nowhere', async () => {
    writeFakeSummary(compactionNoGapsLine);
    for (const isVisible of [false, true]) {
      await setSummaryVisible(isVisible);
      const compactionsBefore = listCompactions().length;
      const messageBefore = getNewestMessageId();
      fakeTelegram.pushOperatorMessage(topicThreadId, '/compact');
      await getCharness().waitFor('the compaction to reach the agent', compactionTimeoutMs, () => listCompactions().length > compactionsBefore);
      await topic.waitForMessage('the completion notice', (message) => message.message_id > messageBefore && message.text.startsWith('✅ Context compacted'));
      await waitForSendQueueToDrain(messageBefore);

      const texts = listTextsAfter(messageBefore);
      assert.ok(!texts.some((text) => text.includes(enDict['compact.instructionGapsHeader'])), `no section message (summary visible: ${isVisible})`);
      assert.ok(!texts.some((text) => text.includes(compactionNoGapsLine)), `the none line never reaches the topic (summary visible: ${isVisible})`);
    }
  });

  // The fake's summary keeps its section through the steps below, whatever it is asked: a real model that is not asked
  // writes none, so what keeps the topic clean here is the bot's own gate — the part a real agent never exercises.
  it('`/compact_mistakes off`: /compact asks for no section — the skills and the checklist stay — and nothing of the section is posted', async () => {
    writeFakeSummary(instructionGapsText);
    await setSummaryVisible(false);
    await topic.sendAndAwaitReply('/compact_mistakes off', getMistakesSwitchConfirmation(false));
    const compactionsBefore = listCompactions().length;
    const hookRunsBefore = listPreCompactHookRuns().length;
    const messageBefore = getNewestMessageId();
    fakeTelegram.pushOperatorMessage(topicThreadId, '/compact');
    await getCharness().waitFor('the compaction to reach the agent', compactionTimeoutMs, () => listCompactions().length > compactionsBefore);
    const compaction = listCompactions()[compactionsBefore];
    assert.ok(!compaction.instruction.includes(compactionGapsGuidance), 'the agent is not asked for the section');
    assert.ok(!compaction.instruction.includes(compactionGapsStartMarker), 'nor shown its markers');
    assert.ok(compaction.instruction.includes(compactionSkillsGuidance) && compaction.instruction.includes(compactionChecklistGuidance), 'the skills and the checklist are still asked for');
    assert.ok(fs.existsSync(getOffFlagPath(compaction.sessionId)), 'the bot keeps the flag the hook reads for this session');

    await topic.waitForMessage('the completion notice', (message) => message.message_id > messageBefore && message.text.startsWith('✅ Context compacted'));
    await waitForSendQueueToDrain(messageBefore);
    const texts = listTextsAfter(messageBefore);
    assert.ok(!texts.some((text) => text.includes(enDict['compact.instructionGapsHeader']) || text.includes(instructionGapsText)), `the section is not posted although the summary holds one: ${JSON.stringify(texts)}`);
    assert.ok(!texts.some((text) => text.includes(summaryBody) || text.includes(closingText)), 'the full summary stays hidden');
    // The hook finds the bot's own instruction in the compaction and adds nothing: no second copy of the skills and the checklist.
    assert.deepEqual(listPreCompactHookRuns().slice(hookRunsBefore).map((run) => run.instruction), [''], 'the hook of the /compact turn printed nothing');
  });

  it('`/compact_mistakes off`: the CLI\'s own overflow compaction is not asked for the section either — its hook finds the session\'s flag — and nothing is posted', async () => {
    const messageBefore = getNewestMessageId();
    const hookRunsBefore = listPreCompactHookRuns().length;
    const turnsBefore = countEndedTurns();
    fakeTelegram.pushOperatorMessage(topicThreadId, 'GAP-6 [fake:overflow] hello');
    await getCharness().waitFor('the GAP-6 prompt to reach the agent', agentStartTimeoutMs, () => listAgentTurns('GAP-6').length === 1);
    await getCharness().waitFor('the GAP-6 turn to end', agentStartTimeoutMs, () => countEndedTurns() > turnsBefore);
    await waitForSendQueueToDrain(messageBefore);

    const hookRuns = listPreCompactHookRuns().slice(hookRunsBefore);
    assert.equal(hookRuns.length, 1, 'the overflow compaction ran the hook once');
    assert.equal(hookRuns[0].trigger, 'auto');
    assert.equal(hookRuns[0].instruction, getHookCompactionInstruction(false), 'the hook adds the instruction WITHOUT the section request');
    assert.ok(!hookRuns[0].instruction.includes(compactionGapsGuidance));
    const texts = listTextsAfter(messageBefore);
    assert.ok(!texts.some((text) => text.includes(enDict['compact.instructionGapsHeader']) || text.includes(instructionGapsText)), `no section is posted: ${JSON.stringify(texts)}`);
  });

  it('`/compact_mistakes off` holds when the agent is started anew: the NEW session is flagged at its start, so its own overflow compaction is not asked for the section either', async () => {
    const flaggedSessionId = listPreCompactHookRuns().at(-1)?.sessionId;
    assert.ok(flaggedSessionId, 'the step before compacted a session');
    await topic.sendAndAwaitReply('/quit', 'stopped');
    await topic.sendAndAwaitReply('/claude', 'ready in');
    const messageBefore = getNewestMessageId();
    const hookRunsBefore = listPreCompactHookRuns().length;
    const turnsBefore = countEndedTurns();
    fakeTelegram.pushOperatorMessage(topicThreadId, 'GAP-8 [fake:overflow] hello');
    await getCharness().waitFor('the GAP-8 prompt to reach the agent', agentStartTimeoutMs, () => listAgentTurns('GAP-8').length === 1);
    await getCharness().waitFor('the GAP-8 turn to end', agentStartTimeoutMs, () => countEndedTurns() > turnsBefore);
    await waitForSendQueueToDrain(messageBefore);

    const hookRun = listPreCompactHookRuns().slice(hookRunsBefore).at(-1);
    assert.ok(hookRun, 'the overflow compaction ran the hook');
    assert.notEqual(hookRun.sessionId, flaggedSessionId, 'a stopped agent starts a new session (`/quit` releases the id)');
    assert.ok(fs.existsSync(getOffFlagPath(hookRun.sessionId)), 'the bot flagged the new session at its start');
    assert.equal(hookRun.instruction, getHookCompactionInstruction(false), 'the hook adds the instruction WITHOUT the section request');
    assert.ok(!listTextsAfter(messageBefore).some((text) => text.includes(enDict['compact.instructionGapsHeader'])), 'no section is posted');
  });

  it('`/compact_mistakes off` holds across a restart of the bot: a flag that is missing at boot is made again for the session of an OFF topic', async () => {
    const sessionId = listPreCompactHookRuns().at(-1)?.sessionId;
    assert.ok(sessionId);
    const flagPath = getOffFlagPath(sessionId);
    assert.ok(fs.existsSync(flagPath));
    // The flag is lost while the bot is down (the saved setting is what stays): the next boot makes it again.
    charness = await restartCharnessWithState(getLayout(), fakeTelegram, getCharness(), () => fs.rmSync(flagPath));
    await getCharness().waitFor('the boot to flag the session of the OFF topic again', bootTimeoutMs, () => fs.existsSync(flagPath));
  });

  it('`/compact_mistakes on` again: the flag is gone, /compact and the CLI\'s own compaction ask for the section again, and it is posted', async () => {
    await topic.sendAndAwaitReply('/compact_mistakes on', getMistakesSwitchConfirmation(true));
    const compactionsBefore = listCompactions().length;
    const messageBefore = getNewestMessageId();
    fakeTelegram.pushOperatorMessage(topicThreadId, '/compact');
    await getCharness().waitFor('the compaction to reach the agent', compactionTimeoutMs, () => listCompactions().length > compactionsBefore);
    const compaction = listCompactions()[compactionsBefore];
    assert.ok(compaction.instruction.includes(compactionGapsGuidance), 'the agent is asked for the section again');
    assert.equal(fs.existsSync(getOffFlagPath(compaction.sessionId)), false, 'the flag is gone');
    const sectionMessage = await topic.waitForMessage('the section', (message) => message.message_id > messageBefore && message.text.includes(enDict['compact.instructionGapsHeader']));
    assert.equal(sectionMessage.text, `${enDict['compact.instructionGapsHeader']}\n\n${instructionGapsText}`);

    const hookRunsBefore = listPreCompactHookRuns().length;
    const overflowMessageBefore = getNewestMessageId();
    const turnsBefore = countEndedTurns();
    fakeTelegram.pushOperatorMessage(topicThreadId, 'GAP-7 [fake:overflow] hello');
    await getCharness().waitFor('the GAP-7 prompt to reach the agent', agentStartTimeoutMs, () => listAgentTurns('GAP-7').length === 1);
    await topic.waitForMessage('the section of the overflow compaction', (message) => message.message_id > overflowMessageBefore && message.text.includes(enDict['compact.instructionGapsHeader']));
    await getCharness().waitFor('the GAP-7 turn to end', agentStartTimeoutMs, () => countEndedTurns() > turnsBefore);
    assert.equal(listPreCompactHookRuns().slice(hookRunsBefore).at(-1)?.instruction, getHookCompactionInstruction(true), 'the hook asks for the section again');
  });
});
