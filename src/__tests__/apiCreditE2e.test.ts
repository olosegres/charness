/**
 * @description The bonus API credit of an account billed to API credits, at PROCESS level: the BUILT charness started the
 * way an isolated instance is (`scripts/run-isolated.sh`) against the fake Bot API (`telegramE2e/fakeTelegram.ts`) and
 * the fake `claude` (`jiraE2e/fakeClaude.ts`), whose every turn reports the same cost. The operator gives the figure
 * through the BUILT command line — `charness claude-profiles credit …`, a second process — while the bot runs. One flow,
 * in order:
 *
 *   boot → the topic is bound and its agent runs; an account holding a pasted key (seeded while the bot is down) is
 *     picked, so the topic runs on it; with no figure given `/accounts` writes no credit line
 *   → `credit <profile> 67.71 --of 200 --expires …`: exit 0, the figure is in `claudeApiCredit.json` and NOT in
 *     `state.json` (the live bot rewrites that file from its memory), and `/accounts` and the `/limits` message show
 *     `🎁 API credit ≈ $67.71 of $200.00 · $0.00 spent via the bot since … · expires …` at once
 *   → a turn on the account runs the estimate down by exactly its own cost, and the bot keeps the count in its own record
 *   → a NEW figure starts the count over (the old turn is not subtracted from it)
 *   → the credits run out («Credit balance is too low») after the figure: `/accounts` says the credit is used up, and a
 *     figure given after that brings the estimate back
 *   → `--clear` takes the line away; a subscription account is refused with a reason and nothing written
 *
 * What the unit tests cover instead: the estimate and the file (`claudeApiCredit.test.ts`), every wording of the line
 * (`claudeProfileUsageLines.test.ts`), the command line's arguments (`claudeProfilesCredit.test.ts`).
 *
 * Nothing leaves the machine: the Bot API is on loopback and the agent is a fake. Everything the test starts is stopped
 * in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram, generalTopicThreadId } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import { fakeClaudeApiErrorOnceFileName, fakeTurnCostUsd, getLaunchSessionId } from './jiraE2e/fakeClaudeContract';
import {
  builtCliPath,
  createIsolatedInstanceLayout,
  exitOnSignal,
  getFlowDeadlineMs,
  getFreeFixedPort,
  getFreePort,
  getIsolatedPath,
  IsolatedCharness,
  listTmuxSessions,
  removeIsolatedInstanceSync,
  writeFakeClaudeLauncher,
  writeInstanceEnvFile,
  type IsolatedInstanceLayout,
} from './e2e/isolatedCharness';
import {
  getAccountConfigDir,
  getAgentTurns,
  getSessionLaunches,
  openLimitsBoard,
  readPersistedState,
  restartCharnessWithState,
  startCharnessOnInstance,
  waitForSessionRespawn,
  type PersistedState,
} from './e2e/fallbackFlowKit';
import { claudeApiCreditFileName } from '../utils/claudeApiCredit';
import { createClaudeProfileLayout, writeClaudeProfileApiKey } from '../utils/claudeProfiles';
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const topicThreadId = 131;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const folder = 'api-credit';
/** The account billed to API credits (a pasted key, seeded), and the subscription the command line must refuse. */
const apiAccount = 'credits';
const subscriptionAccount = 'default';
/** A key that belongs to no one. */
const pastedApiKey = `sk-ant-api03-${'p'.repeat(40)}`;
const creditBalanceError = 'Credit balance is too low';
/** The expiry day given to the command line, and how the line writes it (the year, as it is not this one). */
const expiresOn = '2099-12-31';
const expiresShown = '31.12.2099';

const replyTimeoutMs = 20 * 1000;
const agentStartTimeoutMs = 60 * 1000;
const commandTimeoutMs = 30 * 1000;

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let general: TopicDriver;
let topic: TopicDriver;
let defaultTmuxSessionsBefore: string[] = [];
let sessionId = '';

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

async function restartWithState(edit: (state: PersistedState) => void): Promise<void> {
  charness = await restartCharnessWithState(getLayout(), fakeTelegram, getCharness(), edit);
}

/** The built `charness claude-profiles credit …` of this instance (its env file names the data dir), as the operator runs it. */
function runCreditCommand(...args: string[]): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [builtCliPath, 'claude-profiles', 'credit', ...args], {
    env: { ENV_FILE: getLayout().envFile, PATH: getIsolatedPath(getLayout()), HOME: getLayout().instanceHome },
    encoding: 'utf8',
    timeout: commandTimeoutMs,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The anchors file as the command line wrote it, by profile. */
function readCreditFile(): Record<string, { remainingUsd: number; grantUsd?: number; anchoredAt: string; expiresOn?: string }> {
  return JSON.parse(fs.readFileSync(path.join(getLayout().dataDir, claudeApiCreditFileName), 'utf8'));
}

/** The lines `/accounts` writes under the API account's row (the row's own line first). */
async function readAccountRowLines(): Promise<string[]> {
  const screen = await topic.sendAndAwaitReply('/accounts', 'This topic runs on');
  const lines = screen.text.split('\n');
  const rowIndex = lines.findIndex((line) => line.includes(`• ${apiAccount} —`) || line.includes(`✓ ${apiAccount} —`));
  assert.ok(rowIndex >= 0, `the API account's row is on the screen: ${screen.text}`);
  // The usage lines hang under the row, each indented by four spaces; the next row or the footer is not indented.
  const hanging: string[] = [];
  for (const line of lines.slice(rowIndex + 1)) {
    if (!line.startsWith('    ')) break;
    hanging.push(line);
  }
  return hanging;
}

function findCreditLine(lines: readonly string[]): string | undefined {
  return lines.find((line) => line.includes('🎁'));
}

const leftOfGrant = (left: string): RegExp => new RegExp(`^ {4}🎁 API credit ≈ \\$${left} of \\$200\\.00 · `);

describe('The bonus API credit end to end: built charness, built command line, fake Bot API, fake claude', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-apicredit-', [folder], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    general = new TopicDriver(fakeTelegram, getCharness, generalTopicThreadId, replyTimeoutMs);
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

  it('boots, binds the topic and starts its agent; an account holding a pasted key is picked and the topic runs on it — with no credit line yet', async () => {
    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    await general.sendAndAwaitReply('/timezone UTC', 'Timezone: UTC');
    await topic.sendAndAwaitReply(`/bind ${folder}`, `Bound to \`${folder}\``);
    await topic.sendAndAwaitReply('/claude', 'ready in');
    await getCharness().waitFor('the first session launch', agentStartTimeoutMs, () => getSessionLaunches(getLayout()).length === 1);
    const [firstLaunch] = getSessionLaunches(getLayout());
    sessionId = getLaunchSessionId(firstLaunch.argv) ?? '';
    assert.ok(sessionId);

    const keyDir = getAccountConfigDir(getLayout(), apiAccount);
    createClaudeProfileLayout({ dataDir: getLayout().dataDir, name: apiAccount, homeClaudeDir: path.join(getLayout().instanceHome, '.claude') });
    writeClaudeProfileApiKey(keyDir, pastedApiKey);
    await restartWithState((persisted) => {
      persisted.claudeProfiles = { ...persisted.claudeProfiles, [apiAccount]: { createdAt: new Date().toISOString(), loggedIn: true, billing: 'api' } };
      // The only rung: a refused balance has nowhere to switch to, so the topic stays and the notice is all.
      persisted.fallbackChain = [{ backend: 'claude', profile: apiAccount, model: null }];
    });
    const launchesBefore = getSessionLaunches(getLayout()).length;
    await topic.sendAndAwaitReply(`/accounts use ${apiAccount}`, `Claude account for this topic: ${apiAccount}`);
    await waitForSessionRespawn(getCharness(), getLayout(), 'the session under the API account', keyDir, sessionId, launchesBefore);

    assert.equal(findCreditLine(await readAccountRowLines()), undefined, 'no figure given: no credit line');
  });

  it('the command line gives the figure while the bot runs: it is in its own file, not in state.json, and /accounts and /limits show the estimate at once', async () => {
    const result = runCreditCommand(apiAccount, '67.71', '--of', '200', '--expires', expiresOn);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`API credit of "${apiAccount}": \\$67\\.71 left of \\$200\\.00, usable through ${expiresOn}\\.`));

    const anchor = readCreditFile()[apiAccount];
    assert.deepEqual([anchor.remainingUsd, anchor.grantUsd, anchor.expiresOn], [67.71, 200, expiresOn]);
    assert.ok(!fs.readFileSync(path.join(getLayout().dataDir, 'state.json'), 'utf8').includes('remainingUsd'), 'the figure is not in state.json');
    assert.equal(readPersistedState(getLayout()).claudeProfiles?.[apiAccount]?.creditSpend, undefined, 'and the bot has counted nothing yet');

    const creditLine = findCreditLine(await readAccountRowLines());
    assert.match(creditLine ?? '', new RegExp(`${leftOfGrant('67\\.71').source}\\$0\\.00 spent via the bot since \\d{2}\\.\\d{2} · expires ${expiresShown.replaceAll('.', '\\.')}$`));

    const board = await openLimitsBoard(fakeTelegram, topic, topicThreadId);
    assert.match(board.message.text, new RegExp(`${apiAccount} — [^\\n]*\\n(?: {4}[^\\n]*\\n)* {4}🎁 API credit ≈ \\$67\\.71 of \\$200\\.00`), '/limits writes the very same line');
  });

  it('a turn on the account runs the estimate down by exactly its own cost, counted by the bot in its own record', async () => {
    fakeTelegram.pushOperatorMessage(topicThreadId, 'CREDIT-1 please carry on');
    await getCharness().waitFor('the turn on the API account', agentStartTimeoutMs, () => getAgentTurns(getLayout(), 'CREDIT-1').length === 1);
    await getCharness().waitFor('the turn to be counted against the figure', replyTimeoutMs, () => readPersistedState(getLayout()).claudeProfiles?.[apiAccount]?.creditSpend?.usd === fakeTurnCostUsd);

    const creditLine = findCreditLine(await readAccountRowLines());
    assert.match(creditLine ?? '', new RegExp(`${leftOfGrant('67\\.46').source}\\$0\\.25 spent via the bot since `), '67.71 − 0.25');
  });

  it('a NEW figure starts the count over: the turn before it is not subtracted from it', async () => {
    const result = runCreditCommand(apiAccount, '50', '--of', '200', '--expires', expiresOn);
    assert.equal(result.code, 0, result.stderr);
    const creditLine = findCreditLine(await readAccountRowLines());
    assert.match(creditLine ?? '', new RegExp(`${leftOfGrant('50\\.00').source}\\$0\\.00 spent via the bot since `));

    const newAnchoredAt = readCreditFile()[apiAccount]?.anchoredAt;
    assert.ok(newAnchoredAt);
    fakeTelegram.pushOperatorMessage(topicThreadId, 'CREDIT-2 please carry on');
    // The earlier count (the old figure's, $0.25 too) is replaced only by a turn counted against the new anchor.
    await getCharness().waitFor('the next turn to be counted against the NEW figure', agentStartTimeoutMs, () => {
      const spend = readPersistedState(getLayout()).claudeProfiles?.[apiAccount]?.creditSpend;
      return spend?.anchoredAt === newAnchoredAt && spend.usd === fakeTurnCostUsd;
    });
    const after = findCreditLine(await readAccountRowLines());
    assert.match(after ?? '', new RegExp(`${leftOfGrant('49\\.75').source}\\$0\\.25 spent via the bot since `), '50 − 0.25, not 50 − 0.50');
  });

  it('credits that run out after the figure: /accounts says the credit is used up; a figure given after that brings the estimate back', async () => {
    fs.writeFileSync(path.join(getLayout().fakeStateDir, fakeClaudeApiErrorOnceFileName), creditBalanceError);
    fakeTelegram.pushOperatorMessage(topicThreadId, 'CREDIT-3 please carry on');
    await topic.waitForMessage('the credits notice', (message) => message.text.startsWith('💸'));
    await getCharness().waitFor('the account to be marked out of credits', replyTimeoutMs, () => readPersistedState(getLayout()).claudeProfiles?.[apiAccount]?.creditExhaustedAt !== undefined);

    const usedUpLines = await readAccountRowLines();
    assert.equal(usedUpLines.length, 2, `the spend and ONE used-up line, no second one: ${usedUpLines.join(' | ')}`);
    assert.match(usedUpLines[0], /^ {4}💳 \$0\.50 spent since \d{2}\.\d{2} · last turn \$0\.25$/);
    assert.equal(usedUpLines[1], `    🎁 API credit used up · expires ${expiresShown} — top it up, then pick the account again`);
    assert.ok(readPersistedState(getLayout()).claudeProfiles?.[apiAccount]?.creditExhaustedAt, 'the stored mark holds until the operator acts');

    // A figure given after the refusal is the operator saying there is money: it ends the mark, and the row tells one story.
    assert.equal(runCreditCommand(apiAccount, '30', '--of', '200', '--expires', expiresOn).code, 0);
    const toppedUpLines = await readAccountRowLines();
    assert.equal(toppedUpLines.length, 2, `the spend and the estimate, no used-up line: ${toppedUpLines.join(' | ')}`);
    assert.match(toppedUpLines[1], leftOfGrant('30\\.00'));
    await getCharness().waitFor('the new figure to end the used-up mark', replyTimeoutMs, () => readPersistedState(getLayout()).claudeProfiles?.[apiAccount]?.creditExhaustedAt === undefined);
  });

  it('--clear takes the line away; a subscription account is refused with the reason and nothing is written for it', async () => {
    assert.match(findCreditLine(await readAccountRowLines()) ?? '', leftOfGrant('30\\.00'), 'the figure is on the screen before it is cleared');
    const cleared = runCreditCommand(apiAccount, '--clear');
    assert.equal(cleared.code, 0, cleared.stderr);
    assert.equal(findCreditLine(await readAccountRowLines()), undefined);
    assert.equal(readCreditFile()[apiAccount], undefined);

    const refused = runCreditCommand(subscriptionAccount, '5');
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, new RegExp(`"${subscriptionAccount}" is not an account billed to API credits.*\\(${apiAccount}\\)`));
    assert.equal(readCreditFile()[subscriptionAccount], undefined);
  });
});
