/**
 * @description A Gemini topic on OpenCode that hits Google's PER-MINUTE quota, at PROCESS level: the BUILT charness
 * started the way an isolated instance is (`scripts/run-isolated.sh`) against the fake Bot API
 * (`telegramE2e/fakeTelegram.ts`) and the fake OpenCode server (`openCodeE2e/fakeOpenCodeServer.ts`). One flow, in order:
 *
 *   boot → a topic bound to a folder runs an OpenCode session on `google/gemini-2.5-flash`; a prompt is in flight
 *   → OpenCode retries the provider by itself with Google's per-minute wording ("You exceeded your current quota …
 *     Please retry in 40.15s"): the topic sees OpenCode's own short retry notice, NO usage-limit notice, and the bot
 *     does not abort OpenCode's retry (the turn goes on) — it used to read the wording as an exhausted quota, abort
 *     the retry and arm a wait of an hour
 *   → a plain 400 whose headers name limits and resets: shown as an error, nothing armed — the headers alone made
 *     it a usage limit
 *   → the same quota as a `session.error` whose response HEADERS carry an ISO reset a day away: a short transient
 *     retry, NO usage-limit notice — the headers used to be read too, making it a usage limit "until" that stamp.
 *
 * What the unit tests cover instead: every wording (`apiErrorRetry.test.ts`), what a `session.error` is classified from
 * and its Retry-After reset (`openCodeSessionErrorClassification.test.ts`).
 *
 * Nothing leaves the machine: the Bot API and the OpenCode server are on loopback. Everything the test starts is
 * stopped in `after`.
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
import { readPersistedState, startCharnessOnInstance } from './e2e/fallbackFlowKit';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';

const geminiTopic = { threadId: 151, folder: 'gemini-throttle' };
const fakeOpenCodeVersion = '1.17.11';
const geminiModel = 'google/gemini-2.5-flash';
const openCodeModels = [geminiModel] as const;
const promptLabel = 'THR-1';

const replyTimeoutMs = 20 * 1000;
const msPerSecond = 1000;
const msPerDay = 24 * 60 * 60 * 1000;
const googleRetryDelayMs = 40 * msPerSecond;
/** Google's wording for a used-up per-minute free-tier quota (it says the same of a per-day one; only the quota id differs). */
const googlePerMinuteQuotaMessage = 'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10, model: gemini-2.5-flash\nPlease retry in 40.15s.';
/** The bot's usage-limit wait notice («🚧 Usage limit reached — …»), its transient retry notice, and OpenCode's own. */
const limitNoticeMark = '🚧';
const transientNoticeStart = '⏳ API rate-limited';
const openCodeRetryNoticeStart = '⏳ Provider error — OpenCode retries';

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

/** What the bot SENT to the topic (the Bot API call log), oldest first. */
function listSentTexts(): string[] {
  return fakeTelegram
    .listCalls('sendMessage')
    .filter((call) => call.payload.message_thread_id === geminiTopic.threadId)
    .map((call) => (typeof call.payload.text === 'string' ? call.payload.text : ''));
}

function getTopicSessionId(): string {
  const folderPath = path.join(getLayout().workRoot, geminiTopic.folder);
  const session = [...fakeOpenCode.sessions.values()].find((candidate) => candidate.directory === folderPath);
  assert.ok(session, `a fake OpenCode session for ${folderPath}`);
  return session.id;
}

function getTopicKey(): string {
  return `${group.id}:${geminiTopic.threadId}`;
}

describe('A Gemini per-minute quota on OpenCode end to end: built charness, fake Bot API, fake OpenCode', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-octhrottle-', [geminiTopic.folder], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    topic = new TopicDriver(fakeTelegram, getCharness, geminiTopic.threadId, replyTimeoutMs);
    const apiRoot = await fakeTelegram.start();
    fakeOpenCode = new FakeOpenCodeServer({ version: fakeOpenCodeVersion, models: openCodeModels, defaultModel: geminiModel });
    const openCodeUrl = await fakeOpenCode.start(await getFreePort());
    writeFakeOpenCodeBinary(layout.binDir, { version: fakeOpenCodeVersion, models: openCodeModels });
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

  it('boots, binds the topic and starts a Gemini session; a prompt is in flight', async () => {
    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    await topic.sendAndAwaitReply(`/bind ${geminiTopic.folder}`, `Bound to \`${geminiTopic.folder}\``);
    await topic.sendAndAwaitReply('/opencode', 'ready in');
    fakeTelegram.pushOperatorMessage(geminiTopic.threadId, `${promptLabel} summarise the module`);
    await getCharness().waitFor('the prompt to reach the server', replyTimeoutMs, () => fakeOpenCode.prompts.some((prompt) => prompt.text.includes(promptLabel)));
  });

  it('OpenCode retrying the per-minute quota by itself: its short notice, no usage-limit notice, and its retry is not aborted', async () => {
    const sessionId = getTopicSessionId();
    const abortsBefore = fakeOpenCode.listRequests('POST', `/session/${sessionId}/abort`).length;
    fakeOpenCode.emitProviderRetry(sessionId, { attempt: 1, message: googlePerMinuteQuotaMessage, next: Date.now() + googleRetryDelayMs });

    await getCharness().waitFor('OpenCode\'s retry notice', replyTimeoutMs, () => listSentTexts().some((text) => text.startsWith(openCodeRetryNoticeStart)));
    assert.deepEqual(listSentTexts().filter((text) => text.startsWith(limitNoticeMark)), [], 'a per-minute quota is not a usage limit');
    assert.equal(fakeOpenCode.listRequests('POST', `/session/${sessionId}/abort`).length, abortsBefore, 'OpenCode\'s retry goes on — the turn continues');
    assert.equal(readPersistedState(getLayout()).apiRetries?.[getTopicKey()], undefined, 'no limit wait armed');
  });

  it('a plain 400 whose response headers name limits and resets: the error is shown, no retry and no limit is armed', async () => {
    const sessionId = getTopicSessionId();
    const sentBefore = listSentTexts().length;
    fakeOpenCode.emitSessionError(sessionId, {
      name: 'APIError',
      data: {
        message: "Unsupported parameter: 'reasoning.summary'",
        statusCode: 400,
        isRetryable: false,
        responseHeaders: { 'x-codex-primary-reset-after-seconds': '9000', 'x-codex-primary-over-secondary-limit-percent': '0' },
        responseBody: '{"error":{"message":"Unsupported parameter: \'reasoning.summary\'","type":"invalid_request_error"}}',
      },
    });

    await getCharness().waitFor('the error shown in the topic', replyTimeoutMs, () => listSentTexts().slice(sentBefore).some((text) => text.includes('Unsupported parameter')));
    assert.deepEqual(listSentTexts().slice(sentBefore).filter((text) => text.startsWith(limitNoticeMark)), [], 'headers are not the provider\'s words');
    // Nothing is armed yet, so any apiError would arm (and persist) a retry before the error text — paced behind it — is sent.
    assert.equal(readPersistedState(getLayout()).apiRetries?.[getTopicKey()], undefined, 'nothing armed');
  });
  it('the same quota as a session.error whose HEADERS carry an ISO reset a day away: a short retry, no usage-limit notice', async () => {
    const sessionId = getTopicSessionId();
    fakeOpenCode.emitSessionError(sessionId, {
      name: 'APIError',
      data: {
        message: googlePerMinuteQuotaMessage,
        statusCode: 429,
        isRetryable: true,
        responseHeaders: { 'x-ratelimit-reset': new Date(Date.now() + msPerDay).toISOString(), 'content-type': 'application/json' },
        responseBody: JSON.stringify({ error: { code: 429, message: googlePerMinuteQuotaMessage, status: 'RESOURCE_EXHAUSTED' } }),
        metadata: { url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent' },
      },
    });

    await getCharness().waitFor('the transient retry notice', replyTimeoutMs, () => listSentTexts().some((text) => text.startsWith(transientNoticeStart)));
    assert.deepEqual(listSentTexts().filter((text) => text.startsWith(limitNoticeMark)), [], 'neither the wording nor a header makes it a usage limit');
    assert.equal(readPersistedState(getLayout()).apiRetries?.[getTopicKey()]?.kind, 'transient', 'a short retry is armed, not a limit wait');
  });

});
