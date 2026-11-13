/**
 * @description The skills restore after a compaction on the Claude json-stream backends, at PROCESS level: the BUILT
 * charness started the way an isolated instance is (`scripts/run-isolated.sh`) against the fake Bot API of
 * `telegramE2e/fakeTelegram.ts`, with the fake `claude` (`jiraE2e/fakeClaude.ts`) loading the project's skills when a turn
 * says `[skill:<name>]` and running the launch's `SessionStart` `compact` hooks after every compaction the way the real CLI
 * 2.1.322 was measured to (before the compaction reaches the transcript; the hook text stored in the transcript and held by
 * every later model request). One flow, in order:
 *
 *   boot → a topic is bound, the agent loads a small skill and a big one (Claude's own re-attach keeps a skill whole only
 *     up to 20,000 characters) — nothing to restore yet
 *   → the CLI compacts by itself MID-TURN and the agent goes on alone: that continuation already holds the restore — the
 *     whole current text of both skills (Claude's own re-attach of the small one is not relied on: a resumed process may not
 *     know it)
 *   → `/compact` with the summary SHOWN, then a message: that message's request holds the restore; the posted summary has no
 *     skills block, no marker
 *   → `/compact` with the summary HIDDEN, then a message: the same
 *   → per-turn: a compaction in a turn, the process stops after it, the bot restarts, the next message starts a NEW process
 *     that resumes the conversation — and holds the restore, from the transcript
 *   → the small skill's folder is deleted: the next compaction calls it "not available now" and still restores the big one
 *   → NOTHING of the restore reached the topic, in any message or edit
 *
 * The tmux backend's launches carry no restore (`claudeTmuxUsageWarningE2e.test.ts`); the hook itself, the parts and the
 * transcript reading are pinned in `claudeSkillsRestoreHook.test.ts` and `skillsRestore.test.ts`.
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
import { getSessionLaunches, restartCharnessWithState } from './e2e/fallbackFlowKit';
import {
  fakeClaudeCompactionSummaryFileName,
  fakeClaudeLogFileNames,
  getFlagValues,
  type FakeClaudeRestoreContext,
  type FakeClaudeSessionStartHookRun,
  type FakeClaudeTurn,
} from './jiraE2e/fakeClaudeContract';
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
import { compactionChecklistSkillsItem, compactionSkillsBlockEndMarker, compactionSkillsBlockStartMarker } from '../utils/compactOnIdle';
import { claudeSkillsRestoreHookSettingsFileNames } from '../utils/claudeCompactHook';
import { claudeSkillBaseDirPrefix, skillsRestoreHeader, skillsRestorePartMaxChars, skillsRestoreSlotCount } from '../utils/skillsRestore';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const topicThreadId = 111;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const projectFolder = 'skills-restore';
const topicKey = `${group.id}:${topicThreadId}`;
const launchLine = 'Launching Telegraf bot (long polling';

const bootTimeoutMs = 60 * 1000;
const replyTimeoutMs = 20 * 1000;
const agentStartTimeoutMs = 60 * 1000;
const compactionTimeoutMs = 60 * 1000;

const smallSkillName = 'small-skill';
const bigSkillName = 'big-skill';
const smallSkillMarker = 'SMALL-SKILL-BODY-MARK';
const bigSkillHeadMarker = 'BIG-SKILL-HEAD-MARK';
const bigSkillTailMarker = 'BIG-SKILL-TAIL-MARK';
/** Longer than Claude's own re-attach keeps whole (20,000 characters), so only the bot brings it back whole. */
const bigSkillBody = [bigSkillHeadMarker, ...Array.from({ length: 900 }, (_value, index) => `Rule ${index}: follow the big skill's step ${index}.`), bigSkillTailMarker, ''].join('\n');
const smallSkillBody = `# small\n\n${smallSkillMarker}: keep the counter 4242.\n`;

const summaryBody = 'SR-SUMMARY-BODY: the refactor is half done.';
/** Item 1 as a model writes it when it follows the guidance: the guidance's own text, then the names. */
const checklistLine = `1. ${compactionChecklistSkillsItem} ${bigSkillName}, ${smallSkillName}`;

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

function getSkillDir(name: string): string {
  return path.join(getLayout().workRoot, projectFolder, '.claude', 'skills', name);
}

function writeSkill(name: string, body: string): void {
  fs.mkdirSync(getSkillDir(name), { recursive: true });
  fs.writeFileSync(path.join(getSkillDir(name), 'SKILL.md'), `---\nname: ${name}\ndescription: A skill of the restore flow.\n---\n\n${body}`);
}

function listAgentTurns(label: string): FakeClaudeTurn[] {
  return readJsonLines<FakeClaudeTurn>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.turns)).filter((turn) => turn.issueKey === label);
}

function listCompactions(): Array<{ sessionId: string; pid: number }> {
  return readJsonLines<{ sessionId: string; pid: number }>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.compactions));
}

function listSessionStartHookRuns(): FakeClaudeSessionStartHookRun[] {
  return readJsonLines<FakeClaudeSessionStartHookRun>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.sessionStartHooks));
}

function listRestoreContexts(): FakeClaudeRestoreContext[] {
  return readJsonLines<FakeClaudeRestoreContext>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.restoreContexts));
}

/** How many agent turns have ended so far: the usage line the bot logs at each. */
function countEndedTurns(): number {
  return getCharness().output.split(`${claudeJsonStreamUsageLogPrefix}${topicKey}`).length - 1;
}

/** Send a turn and wait until the agent has taken it and the turn has ended (the bot refuses `/compact` while one runs). */
async function runAgentTurn(label: string, text: string): Promise<void> {
  const turnsBefore = countEndedTurns();
  fakeTelegram.pushOperatorMessage(topicThreadId, `${label} ${text}`);
  await getCharness().waitFor(`the ${label} prompt to reach the agent`, agentStartTimeoutMs, () => listAgentTurns(label).length === 1);
  await getCharness().waitFor(`the ${label} turn to end`, agentStartTimeoutMs, () => countEndedTurns() > turnsBefore);
}

/** The restore record the fake logged for the turn that started after `recordsBefore` records, in `phase`. */
function getRestoreContextAfter(recordsBefore: number, phase: FakeClaudeRestoreContext['phase']): FakeClaudeRestoreContext {
  const record = listRestoreContexts().slice(recordsBefore).find((candidate) => candidate.phase === phase);
  assert.ok(record, `a ${phase} request after record ${recordsBefore}`);
  return record;
}

/** A restore that brings both skills back whole — the small one too, whatever Claude's own re-attach does. */
function assertRestored(contexts: readonly string[], description: string): void {
  assert.ok(contexts.length > 1, `${description}: the big skill takes several parts (${contexts.length})`);
  assert.ok(contexts.every((context) => context.startsWith(skillsRestoreHeader) && context.length <= skillsRestorePartMaxChars), `${description}: every part is labelled and fits a hook's cap`);
  const joined = contexts.join('\n');
  assert.ok(joined.includes(`- ${bigSkillName}: its current full text is below (base directory: ${getSkillDir(bigSkillName)})`), `${description}: the big skill is listed as restored`);
  assert.ok(joined.includes(`- ${smallSkillName}: its current full text is below (base directory: ${getSkillDir(smallSkillName)})`), `${description}: the small one too`);
  for (const marker of [bigSkillHeadMarker, 'Rule 450: follow the big skill', bigSkillTailMarker]) assert.ok(joined.includes(marker), `${description}: the big skill comes back whole (${marker})`);
  assert.ok(joined.includes(`${claudeSkillBaseDirPrefix}${getSkillDir(bigSkillName)}`), `${description}: with its base directory`);
  assert.ok(joined.includes(smallSkillMarker), `${description}: the small skill's text is given`);
}

/** The summary the fake leaves in its transcript at every compaction: a body, the skills block, the checklist. */
function writeFakeSummary(): void {
  const summary = [summaryBody, compactionSkillsBlockStartMarker, bigSkillName, smallSkillName, compactionSkillsBlockEndMarker, checklistLine].join('\n');
  fs.writeFileSync(path.join(getLayout().fakeStateDir, fakeClaudeCompactionSummaryFileName), summary);
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

/** `/compact`, then its completion notice in the topic. */
async function compactByCommand(): Promise<void> {
  const compactionsBefore = listCompactions().length;
  const messageBefore = getNewestMessageId();
  fakeTelegram.pushOperatorMessage(topicThreadId, '/compact');
  await getCharness().waitFor('the compaction to reach the agent', compactionTimeoutMs, () => listCompactions().length > compactionsBefore);
  await topic.waitForMessage('the completion notice', (message) => message.message_id > messageBefore && message.text.startsWith('✅ Context compacted'));
}

/** Every text the bot sent or edited into the chat, whatever the method. */
function listEveryBotText(): string[] {
  return ['sendMessage', 'editMessageText', 'sendDocument', 'sendMessageDraft'].flatMap((method) => fakeTelegram.listCalls(method).map((call) => JSON.stringify(call.payload)));
}

describe('The skills restore after a compaction (Claude json-stream and per-turn): built charness, fake Bot API, fake claude', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-skills-restore-', [projectFolder], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);
    writeSkill(smallSkillName, smallSkillBody);
    writeSkill(bigSkillName, bigSkillBody);

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

  it('boots, binds the topic, and the agent loads a small skill and a big one — nothing to restore yet', async () => {
    charness = new IsolatedCharness(getLayout());
    const pollsBefore = fakeTelegram.listCalls('getUpdates').length;
    await charness.start(bootTimeoutMs, (runOutput) => runOutput.includes(launchLine) && fakeTelegram.listCalls('getUpdates').length > pollsBefore);
    await topic.sendAndAwaitReply(`/bind ${projectFolder}`, `Bound to \`${projectFolder}\``);
    await topic.sendAndAwaitReply('/claude', 'ready in');
    writeFakeSummary();
    const recordsBefore = listRestoreContexts().length;
    await runAgentTurn('SR-1', `[skill:${smallSkillName}] [skill:${bigSkillName}] [fake:answer] load the skills`);
    assert.deepEqual(getRestoreContextAfter(recordsBefore, 'turn').contexts, [], 'no compaction yet, nothing restored');

    const launch = getSessionLaunches(getLayout()).at(-1);
    assert.ok(launch, 'the agent was launched');
    const settingsPath = getFlagValues(launch.argv, '--settings').at(-1);
    assert.equal(settingsPath, path.join(getLayout().dataDir, claudeSkillsRestoreHookSettingsFileNames.withBotSkills), 'a json-stream launch with the bot\'s skills');
    const sessionStart: Array<{ matcher: string; hooks: object[] }> = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).hooks.SessionStart;
    assert.equal(sessionStart[0].matcher, 'compact');
    assert.equal(sessionStart[0].hooks.length, skillsRestoreSlotCount);
  });

  it('the CLI compacts by itself MID-TURN and the agent goes on alone: that continuation already holds the restore', async () => {
    const recordsBefore = listRestoreContexts().length;
    const hookRunsBefore = listSessionStartHookRuns().length;
    await runAgentTurn('SR-2', '[fake:overflow] go on');
    const hookRuns = listSessionStartHookRuns().slice(hookRunsBefore);
    assert.equal(hookRuns.length, 1, 'the overflow compaction ran the SessionStart hooks once');
    assert.equal(hookRuns[0].trigger, 'auto');
    assertRestored(getRestoreContextAfter(recordsBefore, 'continuation').contexts, 'the continuation after the CLI\'s own compaction');
  });

  it('`/compact` with the summary SHOWN, then a message: that message\'s request holds the restore; the posted summary has no skills block', async () => {
    await setSummaryVisible(true);
    const messageBefore = getNewestMessageId();
    await compactByCommand();
    const summaryMessage = await topic.waitForMessage('the full summary', (message) => message.message_id > messageBefore && message.text.startsWith(enDict['compact.summaryHeader']));
    assert.ok(summaryMessage.text.includes(summaryBody) && summaryMessage.text.includes(checklistLine), 'the summary and its checklist are posted');
    assert.ok(!summaryMessage.text.includes('<<<') && !summaryMessage.text.includes('LOADED_SKILLS'), 'no marker');
    assert.ok(!summaryMessage.text.includes(`\n${bigSkillName}\n`) && !summaryMessage.text.endsWith(`\n${smallSkillName}`), `the block's names are gone with it: ${summaryMessage.text}`);

    const recordsBefore = listRestoreContexts().length;
    await runAgentTurn('SR-3', '[fake:answer] what next');
    assertRestored(getRestoreContextAfter(recordsBefore, 'turn').contexts, 'the message after /compact (summary shown)');
  });

  it('`/compact` with the summary HIDDEN, then a message: the same restore', async () => {
    await setSummaryVisible(false);
    await compactByCommand();
    const recordsBefore = listRestoreContexts().length;
    await runAgentTurn('SR-4', '[fake:answer] what next');
    assertRestored(getRestoreContextAfter(recordsBefore, 'turn').contexts, 'the message after /compact (summary hidden)');
  });

  it('per-turn: a compaction in a turn, the process stops, the bot restarts — the next message resumes in a NEW process that holds the restore', async () => {
    await topic.sendAndAwaitReply('/claude_mode perturn', 'same conversation resumed');
    const hookRunsBefore = listSessionStartHookRuns().length;
    await runAgentTurn('SR-5', '[fake:overflow] go on');
    const compactedPid = listSessionStartHookRuns().slice(hookRunsBefore).at(-1)?.pid;
    assert.ok(compactedPid, 'the turn compacted');

    charness = await restartCharnessWithState(getLayout(), fakeTelegram, getCharness(), () => {});
    const recordsBefore = listRestoreContexts().length;
    await runAgentTurn('SR-6', '[fake:answer] after the restart');
    const record = getRestoreContextAfter(recordsBefore, 'turn');
    assert.notEqual(record.pid, compactedPid, 'a new process took the message');
    const launch = getSessionLaunches(getLayout()).filter((candidate) => candidate.pid === record.pid).at(-1);
    assert.equal(getFlagValues(launch?.argv ?? [], '--resume').length, 1, 'it resumed the conversation');
    assertRestored(record.contexts, 'the resumed process after a bot restart');
  });

  it('a skill whose folder is gone since: "not available now", no text, no crash — the big one still comes back', async () => {
    fs.rmSync(getSkillDir(smallSkillName), { recursive: true, force: true });
    const recordsBefore = listRestoreContexts().length;
    await runAgentTurn('SR-7', '[fake:overflow] go on');
    const joined = getRestoreContextAfter(recordsBefore, 'continuation').contexts.join('\n');
    assert.ok(joined.includes(`- ${smallSkillName}: was loaded before but is not available now (base directory: ${getSkillDir(smallSkillName)})`), 'the gone skill is named as not available');
    assert.ok(!joined.includes(smallSkillMarker));
    assert.ok(joined.includes(bigSkillHeadMarker) && joined.includes(bigSkillTailMarker), 'the big skill still comes back whole');
  });

  it('nothing of the restore reached the topic — in no message and no edit', () => {
    const texts = listEveryBotText();
    assert.ok(texts.length > 10, `the flow posted plenty: ${texts.length}`);
    for (const forbidden of [skillsRestoreHeader, 'Charness: skills restored', bigSkillHeadMarker, bigSkillTailMarker, 'Rule 450: follow the big skill', smallSkillMarker, claudeSkillBaseDirPrefix, compactionSkillsBlockStartMarker, compactionSkillsBlockEndMarker, 'hook_response', 'SessionStart']) {
      const leaks = texts.filter((text) => text.includes(forbidden));
      assert.deepEqual(leaks, [], `"${forbidden}" never reaches the topic`);
    }
  });
});
