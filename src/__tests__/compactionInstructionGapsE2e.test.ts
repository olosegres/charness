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
import { fakeClaudeCompactionSummaryFileName, fakeClaudeLogFileNames, type FakeClaudeTurn } from './jiraE2e/fakeClaudeContract';
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
  compactionClosingEndMarker,
  compactionClosingStartMarker,
  compactionGapsEndMarker,
  compactionGapsGuidance,
  compactionGapsStartMarker,
  compactionNoGapsLine,
} from '../utils/compactOnIdle';

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
    assert.ok(!texts.some((text) => text.includes(enDict['compact.instructionGapsHeader'])), 'no separate section message');
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
});
