/**
 * @description The credit of an account billed to API credits when the balance runs out and comes back, at PROCESS level:
 * the BUILT charness started the way an isolated instance is (`scripts/run-isolated.sh`) against the fake Bot API
 * (`telegramE2e/fakeTelegram.ts`), the fake `claude` (`jiraE2e/fakeClaude.ts`) and a FAKE ANTHROPIC API on loopback
 * (`ANTHROPIC_BASE_URL`, the root the account's own sessions would use) that records every request it gets. The daily
 * recheck window is shortened to 10 s through the test-timing seam (`creditRecheckIntervalMs`). One flow, in order:
 *
 *   boot → the topic runs on an API account holding a pasted key; two OTHER accounts hold keys too — an API account that is
 *     not marked used up, and a SUBSCRIPTION account that is (due since long before the first poll) — and the operator gives
 *     the API account a Console figure with a grant
 *   → a turn counts; then the balance is refused: `/accounts` says «probably used up · … spent since …», one line
 *   → one interval later the bot asks the API ONCE, on that account's OWN key, with a one-token request on the cheapest
 *     model; the API still refuses for the balance, so nothing changes — and the attempt is persisted
 *   → the bot restarts: it does NOT ask again before a full interval has passed since that attempt
 *   → the API answers: the credit is RENEWED — the mark ends, the spend counter is at 0 from that moment, and `/accounts`
 *     shows the renewal on the last given grant, the expiry left to the Console; the next turn counts from 0
 *   → `charness claude-profiles --json` (the `claude_profiles` tool's report) carries the same: spent, remaining estimate,
 *     no expiry, not probably used up, the renewal instant
 *   → used up again, and a REAL turn that goes through is a recheck too: renewed at once, the API asked no more
 *   → used up once more and the operator PICKS the account on /limits, as the refusal notice asks: it works at once, the mark
 *     is lifted but the refusal stays «unconfirmed» (no «used up», no stale remainder), and the first turn that goes through
 *     still renews it — the counter at 0 from that turn, nothing carried over from before the refusal
 *   → through all of it the subscription account and the unmarked API account were never asked, and the API never twice within an interval
 *
 * What the unit tests cover instead: the probe's request and its reading, the due rule, a pass over the accounts
 * (`claudeApiCreditRecheck.test.ts`), the period and the estimate (`claudeApiCredit.test.ts`), every wording of the line
 * (`claudeProfileUsageLines.test.ts`).
 *
 * Nothing leaves the machine: the Bot API and the Anthropic API are on loopback and the agent is a fake. Everything the test
 * starts is stopped in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
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
import { findCreditLine, readAccountRowLines as readAccountRowLinesOf, runClaudeProfilesCommand, runCreditCommand as runCreditCommandOf } from './e2e/apiCreditKit';
import { claudeApiCreditProbeModel } from '../utils/claudeApiCreditRecheck';
import { createClaudeProfileLayout, writeClaudeProfileApiKey } from '../utils/claudeProfiles';
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const topicThreadId = 141;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const folder = 'api-renewal';
/** The API account the topic runs on, another API account that is never marked, and a subscription account that IS marked. */
const apiAccount = 'credits';
const idleAccount = 'idle';
const subscriptionAccount = 'sub';
/** Keys that belong to no one: the fake API tells the accounts apart by them. */
const apiKey = `sk-ant-api03-${'a'.repeat(40)}`;
const idleKey = `sk-ant-api03-${'i'.repeat(40)}`;
const subscriptionKey = `sk-ant-api03-${'s'.repeat(40)}`;
const creditBalanceError = 'Credit balance is too low';
const expiresOn = '2099-12-31';
/** The recheck day, shortened through the test-timing seam; the poll finds a due account within half a second. */
const recheckIntervalMs = 10 * 1000;
const recheckPollMs = 500;

const replyTimeoutMs = 20 * 1000;
const agentStartTimeoutMs = 60 * 1000;
const recheckWaitMs = recheckIntervalMs + 30 * 1000;

/** What the fake Anthropic API was asked. */
interface ApiRequest {
  /** When it arrived (ms since the epoch). */
  at: number;
  method: string | undefined;
  url: string | undefined;
  apiKey: string | undefined;
  version: string | undefined;
  body: string;
}

/** A loopback stand-in for the Anthropic API: refuses for the balance, or answers, as told; remembers every request. */
class FakeAnthropicApi {
  mode: 'balance' | 'answer' = 'balance';
  readonly requests: ApiRequest[] = [];
  private server: http.Server | null = null;

  async start(): Promise<string> {
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const header = (name: string): string | undefined => {
          const value = request.headers[name];
          return Array.isArray(value) ? value[0] : value;
        };
        this.requests.push({ at: Date.now(), method: request.method, url: request.url, apiKey: header('x-api-key'), version: header('anthropic-version'), body: Buffer.concat(chunks).toString('utf8') });
        response.setHeader('content-type', 'application/json');
        if (this.mode === 'answer') {
          response.writeHead(200);
          response.end(JSON.stringify({ id: 'msg_fake', type: 'message', role: 'assistant', model: claudeApiCreditProbeModel, content: [{ type: 'text', text: '.' }], stop_reason: 'max_tokens', usage: { input_tokens: 1, output_tokens: 1 } }));
          return;
        }
        response.writeHead(400);
        response.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } }));
      });
    });
    this.server = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('the fake Anthropic API has no port');
    return `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let fakeApi: FakeAnthropicApi;
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

const readAccountRowLines = (): Promise<string[]> => readAccountRowLinesOf(topic, apiAccount);
const getApiRecord = () => readPersistedState(getLayout()).claudeProfiles?.[apiAccount];

/** The fake `claude` ends the NEXT turn on «Credit balance is too low»; the labelled message starts that turn. */
function runOutOfCredits(label: string): void {
  fs.writeFileSync(path.join(getLayout().fakeStateDir, fakeClaudeApiErrorOnceFileName), creditBalanceError);
  fakeTelegram.pushOperatorMessage(topicThreadId, `${label} please carry on`);
}

/** Wait for the fake API to have been asked `count` times. */
async function waitForApiRequests(description: string, count: number): Promise<void> {
  await getCharness().waitFor(description, recheckWaitMs, () => fakeApi.requests.length >= count);
}

describe('A used-up API credit that comes back, end to end: built charness, fake Bot API, fake claude, fake Anthropic API', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-apirenew-', [folder], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    fakeApi = new FakeAnthropicApi();
    general = new TopicDriver(fakeTelegram, getCharness, generalTopicThreadId, replyTimeoutMs);
    topic = new TopicDriver(fakeTelegram, getCharness, topicThreadId, replyTimeoutMs);
    const apiRoot = await fakeTelegram.start();
    const anthropicRoot = await fakeApi.start();
    writeInstanceEnvFile(layout, {
      TELEGRAM_BOT_TOKEN: fakeBotToken,
      TELEGRAM_API_ROOT: apiRoot,
      ALLOWED_GROUP_ID: group.id.toString(),
      CHAT_MODE: 'group',
      DATA_DIR: layout.dataDir,
      WORK_ROOT: layout.workRoot,
      TMUX_TMPDIR: layout.tmuxTmpDir,
      CLAUDE_BIN: writeFakeClaudeLauncher(layout, null),
      // The root the recheck's request goes to (the variable Claude Code itself honours): the fake API, never the real one.
      ANTHROPIC_BASE_URL: anthropicRoot,
      // A free port nothing listens on: the boot's OpenCode pre-start finds no server and no binary, and gives up.
      OPENCODE_URL: `http://127.0.0.1:${await getFreePort()}`,
      SCHEDULER_MCP_PORT: (await getFreeFixedPort()).toString(),
      ...getTelegramFlowTestTimingsEnv({ creditRecheckIntervalMs: recheckIntervalMs, creditRecheckPollMs: recheckPollMs }),
    });
  });

  after(async () => {
    await charness?.stop();
    removeInstanceSync();
    await fakeTelegram?.stop();
    await fakeApi?.stop();
    process.off('exit', removeInstanceSync);
    process.off('SIGINT', exitOnSignal);
    process.off('SIGTERM', exitOnSignal);
    assert.deepEqual(listTmuxSessions([]), defaultTmuxSessionsBefore, 'the default tmux server was not touched');
  });

  it('boots and binds the topic; the API account is picked; a subscription account that is marked used up and an unmarked API account hold keys too; the operator gives a figure with a grant', async () => {
    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    await general.sendAndAwaitReply('/timezone UTC', 'Timezone: UTC');
    await topic.sendAndAwaitReply(`/bind ${folder}`, `Bound to \`${folder}\``);
    await topic.sendAndAwaitReply('/claude', 'ready in');
    await getCharness().waitFor('the first session launch', agentStartTimeoutMs, () => getSessionLaunches(getLayout()).length === 1);
    sessionId = getLaunchSessionId(getSessionLaunches(getLayout())[0].argv) ?? '';
    assert.ok(sessionId);

    for (const name of [apiAccount, idleAccount, subscriptionAccount]) {
      createClaudeProfileLayout({ dataDir: getLayout().dataDir, name, homeClaudeDir: path.join(getLayout().instanceHome, '.claude') });
    }
    writeClaudeProfileApiKey(getAccountConfigDir(getLayout(), apiAccount), apiKey);
    writeClaudeProfileApiKey(getAccountConfigDir(getLayout(), idleAccount), idleKey);
    // The subscription account's key sits where a Console login keeps one — the bot can read it, and the fake CLI still reports a
    // subscription login for the directory: only the account's billing keeps the recheck away from it.
    fs.writeFileSync(path.join(getAccountConfigDir(getLayout(), subscriptionAccount), '.claude.json'), JSON.stringify({ primaryApiKey: subscriptionKey }));
    await restartWithState((persisted) => {
      const createdAt = new Date().toISOString();
      persisted.claudeProfiles = {
        ...persisted.claudeProfiles,
        [apiAccount]: { createdAt, loggedIn: true, billing: 'api' },
        [idleAccount]: { createdAt, loggedIn: true, billing: 'api' },
        // Marked used up long before the first poll — due from the start; it is no API account, so it must never be asked.
        [subscriptionAccount]: { createdAt, loggedIn: true, billing: 'subscription', creditExhaustedAt: new Date(Date.now() - 3_600_000).toISOString() },
      };
      persisted.fallbackChain = [{ backend: 'claude', profile: apiAccount, model: null }];
    });
    const launchesBefore = getSessionLaunches(getLayout()).length;
    await topic.sendAndAwaitReply(`/accounts use ${apiAccount}`, `Claude account for this topic: ${apiAccount}`);
    await waitForSessionRespawn(getCharness(), getLayout(), 'the session under the API account', getAccountConfigDir(getLayout(), apiAccount), sessionId, launchesBefore);

    const given = runCreditCommandOf(getLayout(), apiAccount, '67.71', '--of', '200', '--expires', expiresOn);
    assert.equal(given.code, 0, given.stderr);
    assert.match(findCreditLine(await readAccountRowLines()) ?? '', /^ {4}🎁 API credit ≈ \$67\.71 of \$200\.00 · \$0\.00 spent via the bot since /);
  });

  it('a turn counts; then the balance is refused: /accounts says «probably used up», with what was spent since the figure — one credit line, no second used-up line', async () => {
    fakeTelegram.pushOperatorMessage(topicThreadId, 'RENEW-1 please carry on');
    await getCharness().waitFor('the turn to be counted', agentStartTimeoutMs, () => getApiRecord()?.creditSpend?.usd === fakeTurnCostUsd);

    runOutOfCredits('RENEW-2');
    await topic.waitForMessage('the credits notice', (message) => message.text.startsWith('💸'));
    await getCharness().waitFor('the account to be marked out of credits', replyTimeoutMs, () => getApiRecord()?.creditExhaustedAt !== undefined);

    const lines = await readAccountRowLines();
    assert.equal(lines.length, 2, `the spend and ONE credit line: ${lines.join(' | ')}`);
    assert.match(lines[1], /^ {4}🎁 API credit probably used up · \$0\.25 spent since \d{2}\.\d{2} — top it up, then pick the account again$/);
    assert.equal(fakeApi.requests.length, 0, `nothing asks the API before a day is up: ${JSON.stringify(fakeApi.requests)}; state ${JSON.stringify(getApiRecord())}`);
  });

  it('one interval after the refusal the bot asks the API ONCE, on the account\'s OWN key, with a one-token request on the cheapest model; still refused, nothing changes — and the attempt is persisted', async () => {
    const markedAtMs = Date.parse(getApiRecord()?.creditExhaustedAt ?? '');
    assert.ok(markedAtMs > 0);
    await waitForApiRequests('the first recheck', 1);
    const [first] = fakeApi.requests;
    assert.ok(first.at >= markedAtMs + recheckIntervalMs, 'not before a full interval after the refusal');
    assert.equal(first.method, 'POST');
    assert.equal(first.url, '/v1/messages');
    assert.equal(first.apiKey, apiKey, 'the account\'s own key');
    assert.equal(first.version, '2023-06-01');
    const body: { model: string; max_tokens: number; messages: object[] } = JSON.parse(first.body);
    assert.deepEqual([body.model, body.max_tokens, body.messages.length], [claudeApiCreditProbeModel, 1, 1]);

    await getCharness().waitFor('the attempt to be persisted', replyTimeoutMs, () => getApiRecord()?.creditRecheckedAt !== undefined);
    assert.ok(getApiRecord()?.creditExhaustedAt, 'still refused: the mark holds');
    const lines = await readAccountRowLines();
    assert.match(lines[1], /^ {4}🎁 API credit probably used up · .* — top it up, then pick the account again$/);
    assert.equal(fakeApi.requests.length, 1);
  });

  it('a restart does not bring the recheck round sooner: the next request comes a full interval after the persisted attempt', async () => {
    const attemptedAtMs = Date.parse(getApiRecord()?.creditRecheckedAt ?? '');
    assert.ok(attemptedAtMs > 0);
    fakeApi.mode = 'answer';
    await restartWithState(() => undefined);
    await waitForApiRequests('the second recheck', 2);
    assert.ok(fakeApi.requests[1].at >= attemptedAtMs + recheckIntervalMs, 'a restart is no new day');
    assert.equal(fakeApi.requests[1].apiKey, apiKey);
  });

  it('the API answers: the credit is RENEWED — the mark ends, the counter is at 0 from that moment, /accounts shows the renewal on the last given grant with the expiry left to the Console; the next turn counts from 0', async () => {
    await getCharness().waitFor('the renewal to be recorded', replyTimeoutMs, () => getApiRecord()?.creditRenewedAt !== undefined);
    const record = getApiRecord();
    assert.equal(record?.creditExhaustedAt, undefined, 'the mark ended');
    assert.deepEqual(record?.creditSpend, { since: record?.creditRenewedAt, usd: 0 }, 'the counter starts at 0 at the renewal');

    const lines = await readAccountRowLines();
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^ {4}💳 \$0\.25 spent since /, 'the account\'s whole spend stays');
    assert.match(lines[1], /^ {4}🎁 API credit renewed ≈ \d{2}\.\d{2} · ≈ \$200\.00 of \$200\.00 · \$0\.00 spent via the bot · check expiry in Console › Billing$/);

    fakeTelegram.pushOperatorMessage(topicThreadId, 'RENEW-3 please carry on');
    await getCharness().waitFor('the turn after the renewal', agentStartTimeoutMs, () => getAgentTurns(getLayout(), 'RENEW-3').length === 1);
    await getCharness().waitFor('the turn to be counted from 0', replyTimeoutMs, () => getApiRecord()?.creditSpend?.usd === fakeTurnCostUsd);
    assert.match((await readAccountRowLines())[1], /^ {4}🎁 API credit renewed ≈ \d{2}\.\d{2} · ≈ \$199\.75 of \$200\.00 · \$0\.25 spent via the bot · /);
  });

  it('`charness claude-profiles --json` — what the claude_profiles tool answers — carries the estimate: spent, remaining, no expiry after a renewal, not used up, the renewal instant', () => {
    const result = runClaudeProfilesCommand(getLayout(), '--json');
    assert.equal(result.code, 0, result.stderr);
    const report: { profiles: Array<{ name: string; spentUsd: number | null; remainingEstimateUsd: number | null; expiresOn: string | null; probablyUsedUp: boolean; renewedAt: string | null }> } = JSON.parse(result.stdout);
    const entry = report.profiles.find((profile) => profile.name === apiAccount);
    assert.deepEqual(
      [entry?.spentUsd, entry?.remainingEstimateUsd, entry?.expiresOn, entry?.probablyUsedUp, entry?.renewedAt],
      [0.25, 199.75, null, false, getApiRecord()?.creditRenewedAt],
    );
    const subscription = report.profiles.find((profile) => profile.name === subscriptionAccount);
    assert.deepEqual([subscription?.spentUsd, subscription?.remainingEstimateUsd, subscription?.probablyUsedUp], [null, null, false], 'a subscription account has no credit estimate');
  });

  it('used up again, a REAL turn that goes through is a recheck too: renewed at once, and the API is asked no more', async () => {
    fakeApi.mode = 'balance';
    const renewedBefore = getApiRecord()?.creditRenewedAt ?? '';
    runOutOfCredits('RENEW-4');
    await getCharness().waitFor('the account to be marked out of credits again', replyTimeoutMs, () => getApiRecord()?.creditExhaustedAt !== undefined);
    assert.match((await readAccountRowLines())[1], /^ {4}🎁 API credit probably used up · \$0\.25 spent since \d{2}\.\d{2} — top it up, then pick the account again$/, 'counted since the renewal');

    fakeTelegram.pushOperatorMessage(topicThreadId, 'RENEW-5 please carry on');
    await getCharness().waitFor('the turn that goes through to renew the credit', agentStartTimeoutMs, () => {
      const record = getApiRecord();
      return record?.creditExhaustedAt === undefined && (record?.creditRenewedAt ?? '') > renewedBefore;
    });
    assert.deepEqual(getApiRecord()?.creditSpend?.usd, fakeTurnCostUsd, 'the turn that proved it counts in the new period');
    assert.equal(fakeApi.requests.length, 2, 'renewed by the turn: the API was asked no more');
    assert.match((await readAccountRowLines())[1], /^ {4}🎁 API credit renewed ≈ \d{2}\.\d{2} · ≈ \$199\.75 of \$200\.00 · \$0\.25 spent via the bot · /);
  });

  it('used up with a subscription to fall back on: the topic moves there; the operator PICKS the account again on /limits, as the notice asks — it works at once, the refusal stays «unconfirmed», and the first turn that goes through renews it with the counter at 0', async () => {
    // The refusal now has a place to go: the subscription is next in the chain, so the topic leaves the exhausted account by itself.
    await restartWithState((persisted) => {
      persisted.fallbackChain = [{ backend: 'claude', profile: apiAccount, model: null }, { backend: 'claude', profile: 'default', model: null }];
      persisted.claudeAutoSwitchOnLimitEnabled = true;
    });
    const renewedBefore = getApiRecord()?.creditRenewedAt ?? '';
    assert.ok((getApiRecord()?.creditSpend?.usd ?? 0) > 0, 'the period before the refusal has spend that must NOT be carried over');
    let launchesBefore = getSessionLaunches(getLayout()).length;
    runOutOfCredits('RENEW-6');
    await waitForSessionRespawn(getCharness(), getLayout(), 'the topic to move to the subscription', null, sessionId, launchesBefore);
    await getCharness().waitFor('the account to be marked out of credits again', replyTimeoutMs, () => getApiRecord()?.creditExhaustedAt !== undefined);

    // The topic is on the subscription now, so the API account's row on the board is a PICK (the current account's row opens its model page).
    const board = await openLimitsBoard(fakeTelegram, topic, topicThreadId);
    launchesBefore = getSessionLaunches(getLayout()).length;
    await topic.tapAndAwaitAnswer(board.message, board.rowData(`Claude · ${apiAccount}`));
    await waitForSessionRespawn(getCharness(), getLayout(), 'the session back under the API account', getAccountConfigDir(getLayout(), apiAccount), sessionId, launchesBefore);
    const picked = getApiRecord();
    assert.equal(picked?.creditExhaustedAt, undefined, 'the pick ended the mark: the account works');
    assert.ok(picked?.creditUnconfirmedSince, 'and the refusal is kept, awaiting the answer that confirms the renewal');
    const unconfirmedLines = await readAccountRowLines();
    assert.match(unconfirmedLines[1], /^ {4}🎁 API credit: refused \d{2}\.\d{2} — the next turn that goes through shows it is back$/);
    assert.ok(!unconfirmedLines.some((line) => line.includes('used up') || line.includes('≈')), 'neither «used up» nor the stale remainder');

    fakeTelegram.pushOperatorMessage(topicThreadId, 'RENEW-7 please carry on');
    await getCharness().waitFor('the turn that goes through to record the renewal', agentStartTimeoutMs, () => {
      const record = getApiRecord();
      return record?.creditUnconfirmedSince === undefined && (record?.creditRenewedAt ?? '') > renewedBefore;
    });
    const record = getApiRecord();
    assert.deepEqual(record?.creditSpend, { since: record?.creditRenewedAt, usd: fakeTurnCostUsd }, 'counted from 0: only the turn that proved it, nothing from before the refusal');
    assert.match((await readAccountRowLines())[1], /^ {4}🎁 API credit renewed ≈ \d{2}\.\d{2} · ≈ \$199\.75 of \$200\.00 · \$0\.25 spent via the bot · /);
  });

  it('through all of it the API was asked only on the one account\'s key — never for the subscription account that was due all along, never for the API account that was not marked — and never twice within a day', () => {
    assert.ok(fakeApi.requests.length >= 2);
    assert.ok(fakeApi.requests.every((request) => request.apiKey === apiKey), 'only the account\'s own key');
    for (let index = 1; index < fakeApi.requests.length; index += 1) {
      assert.ok(fakeApi.requests[index].at - fakeApi.requests[index - 1].at >= recheckIntervalMs - 1_000, `request ${index + 1} came a full interval after request ${index}`);
    }
    const profiles = readPersistedState(getLayout()).claudeProfiles ?? {};
    assert.equal(profiles[subscriptionAccount]?.creditRecheckedAt, undefined, 'no attempt recorded for the subscription account');
    assert.equal(profiles[idleAccount]?.creditRecheckedAt, undefined, 'none for the account that was never marked');
    assert.ok(profiles[subscriptionAccount]?.creditExhaustedAt, 'the subscription account stayed marked (it was due, and left alone)');
    assert.ok(!fakeApi.requests.some((request) => request.apiKey === subscriptionKey || request.apiKey === idleKey));
  });
});
