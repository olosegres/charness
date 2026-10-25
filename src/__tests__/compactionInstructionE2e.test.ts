/**
 * @description The instruction a manual `/compact` gives the agent, at PROCESS level: the BUILT charness started the
 * way an isolated instance is (`scripts/run-isolated.sh`) against the fake Bot API of `telegramE2e/fakeTelegram.ts`,
 * with the fake `claude` (`jiraE2e/fakeClaude.ts`) recording what follows `/compact` in the user turn the bot writes.
 * One flow, in order:
 *
 *   boot → a topic is bound and the agent started → it answers a first message, and its turn ends
 *   → `/compact`: the agent gets the summary guidance, the loaded skills and the next-steps checklist, the checklist
 *     being the LAST thing it reads (no closing section is asked for, so it ends the summary) — without it the
 *     continuing session skipped reloading its skills and worked without them
 *
 * The idle compaction (which asks for the closing section too) is pinned in `backgroundTaskStopE2e.test.ts`, the one
 * the agent arms itself (`compact_conversation`) in `jiraPromptE2e.test.ts`; the CLI's own overflow compaction goes
 * through the `PreCompact` hook (`claudeCompactHook.test.ts`) and OpenCode's through its plugin
 * (`openCodeCompactPlugin.test.ts`).
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
import { fakeClaudeLogFileNames, type FakeClaudeTurn } from './jiraE2e/fakeClaudeContract';
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
import {
  compactionChecklistGuidance,
  compactionClosingEndMarker,
  compactionClosingStartMarker,
  compactionResumeGuidance,
  compactionSummaryGuidance,
} from '../utils/compactOnIdle';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const topicThreadId = 111;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const projectFolder = 'compaction-instruction';
const topicKey = `${group.id}:${topicThreadId}`;
const launchLine = 'Launching Telegraf bot (long polling';
const firstPromptLabel = 'CMP-1';

const bootTimeoutMs = 60 * 1000;
const replyTimeoutMs = 20 * 1000;
const agentStartTimeoutMs = 60 * 1000;
const compactionTimeoutMs = 30 * 1000;

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

describe('The instruction a manual /compact gives the agent: built charness, fake Bot API, fake claude', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-compact-instruction-', [projectFolder], getFlowDeadlineMs());
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

  it('a manual /compact tells the agent to end the summary with the skills-first next-steps checklist, and asks for no closing section', async () => {
    const compactionsBefore = listCompactions().length;
    fakeTelegram.pushOperatorMessage(topicThreadId, '/compact');
    await getCharness().waitFor('the compaction to reach the agent', compactionTimeoutMs, () => listCompactions().length > compactionsBefore);

    const { instruction } = listCompactions()[compactionsBefore];
    assert.equal(instruction, `${compactionSummaryGuidance}\n\n${compactionResumeGuidance}`, 'the summary guidance, then the loaded skills and the checklist');
    assert.ok(instruction.endsWith(compactionChecklistGuidance), 'the checklist is the last thing the agent reads');
    assert.ok(!instruction.includes(compactionClosingStartMarker) && !instruction.includes(compactionClosingEndMarker), 'a manual /compact asks for no closing section');
  });
});
