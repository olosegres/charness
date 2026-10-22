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
 *     retry, NO usage-limit notice — the headers used to be read too, making it a usage limit "until" that stamp
 *   → a sub-agent's CHILD session (lineage from `session.updated`) and a FOREIGN session in the same folder report a
 *     daily quota: neither arms the topic — it used to be held, its model marked limited.
 *     These run BEFORE the transient steps: a pending retry makes the bot ignore later errors, which would hide it
 *   → in a second topic, Anthropic's "This request would exceed your account's rate limit" (OpenCode's next attempt
 *     three hours away): UNCONFIRMED on its own — a two-minute probe retry, no limit notice; the same error right
 *     after the probe's resume confirms it, and only then is the wait to the reset announced
 *   → in a third topic, OpenCode Go's usage limit "It will reset in 2 hours 30 minutes": the notice names the reset
 *     two and a half hours ahead — only the "2 hours" used to be read
 *   → in a fourth topic, a usage limit whose reset is a ZONE-LESS ISO stamp: the plain hourly retry, not a reset time
 *     guessed in the bot's zone.
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
import { FakeTelegram, generalTopicThreadId } from './telegramE2e/fakeTelegram';
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
import { openLimitsBoard, readPersistedState, startCharnessOnInstance } from './e2e/fallbackFlowKit';
import { skipArmedRetryCallbackPrefix as skipOnceCallbackPrefix } from '../utils/autoContinueOnLimit';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';

const geminiTopic = { threadId: 151, folder: 'gemini-throttle' };
/** A second topic for the Anthropic wording, so the transient retry the Gemini steps leave pending cannot hide its errors. */
const anthropicTopic = { threadId: 152, folder: 'anthropic-unconfirmed' };
/** A third topic for OpenCode Go's usage limit, whose reset is written in several parts. */
const goTopic = { threadId: 153, folder: 'opencode-go-limit' };
/** A fourth topic for a usage limit whose reset is a zone-less ISO stamp. */
const zonelessTopic = { threadId: 154, folder: 'zoneless-reset' };
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
const anthropicUnconfirmedMessage = "This request would exceed your account's rate limit. Please try again later.";
const msPerMinute = 60 * msPerSecond;
/** How far OpenCode's next attempt sits for the Anthropic wording: the window's reset, per its Retry-After. */
const anthropicRetryAfterMs = 3 * 60 * msPerMinute;
/** The probe retry (two minutes) plus the resume's round trip. */
const probeTimeoutMs = 4 * msPerMinute;
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
function listSentTexts(threadId: number = geminiTopic.threadId): string[] {
  return fakeTelegram
    .listCalls('sendMessage')
    .filter((call) => call.payload.message_thread_id === threadId)
    .map((call) => (typeof call.payload.text === 'string' ? call.payload.text : ''));
}

function getTopicSessionId(folder: string = geminiTopic.folder): string {
  const folderPath = path.join(getLayout().workRoot, folder);
  const session = [...fakeOpenCode.sessions.values()].find((candidate) => candidate.directory === folderPath);
  assert.ok(session, `a fake OpenCode session for ${folderPath}`);
  return session.id;
}

function getTopicKey(threadId: number = geminiTopic.threadId): string {
  return `${group.id}:${threadId}`;
}

describe('A Gemini per-minute quota on OpenCode end to end: built charness, fake Bot API, fake OpenCode', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-octhrottle-', [geminiTopic.folder, anthropicTopic.folder, goTopic.folder, zonelessTopic.folder], getFlowDeadlineMs());
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
    // The notices name reset times in the instance zone: UTC, so the flow can compute them.
    await new TopicDriver(fakeTelegram, getCharness, generalTopicThreadId, replyTimeoutMs).sendAndAwaitReply('/timezone UTC', 'Timezone: UTC');
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

  it('a sub-agent CHILD session and a FOREIGN session in the same folder hit a daily quota: the topic is not armed', async () => {
    const parentSessionId = getTopicSessionId();
    const childSessionId = 'ses_fakechild1';
    const dailyQuotaError = {
      name: 'APIError',
      data: { message: 'You exceeded your current quota (requests per day).', statusCode: 429, isRetryable: false, responseBody: '{"error":{"status":"RESOURCE_EXHAUSTED"}}' },
    };
    // One event stream, read in order: the lineage is known before the child's error arrives.
    fakeOpenCode.emitChildSession(parentSessionId, childSessionId);
    fakeOpenCode.emitSessionError(childSessionId, dailyQuotaError);
    await getCharness().waitFor('the child\'s error to be handled', replyTimeoutMs, () => getCharness().output.includes(`session.error of session ${childSessionId}, not the topic's own`));
    const foreignSessionId = 'ses_fakeforeign1';
    fakeOpenCode.emitSessionError(foreignSessionId, dailyQuotaError, path.join(getLayout().workRoot, geminiTopic.folder));
    await getCharness().waitFor('the foreign session\'s error to be handled', replyTimeoutMs, () => getCharness().output.includes(`session.error of session ${foreignSessionId}, not the topic's own`));

    // A barrier that cannot race: `/limits` is handled after these events, and offers «⏭ Skip once» exactly when a
    // limit wait is armed for the topic (in memory, set synchronously by the error handling).
    const board = await openLimitsBoard(fakeTelegram, topic, geminiTopic.threadId);
    assert.equal(topic.getKeyboardData(board.message).flat().some((data) => data.startsWith(skipOnceCallbackPrefix)), false, 'no limit wait armed for the topic');
    assert.deepEqual(listSentTexts().filter((text) => text.startsWith(limitNoticeMark)), [], 'no usage-limit notice');
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


  it('Anthropic\'s "would exceed your account\'s rate limit" alone: a two-minute probe, no limit notice', async () => {
    const driver = new TopicDriver(fakeTelegram, getCharness, anthropicTopic.threadId, replyTimeoutMs);
    await driver.sendAndAwaitReply(`/bind ${anthropicTopic.folder}`, `Bound to \`${anthropicTopic.folder}\``);
    await driver.sendAndAwaitReply('/opencode', 'ready in');
    fakeTelegram.pushOperatorMessage(anthropicTopic.threadId, 'ANT-1 refactor the parser');
    await getCharness().waitFor('the prompt to reach the server', replyTimeoutMs, () => fakeOpenCode.prompts.some((prompt) => prompt.text.includes('ANT-1')));
    fakeOpenCode.emitProviderRetry(getTopicSessionId(anthropicTopic.folder), { attempt: 1, message: anthropicUnconfirmedMessage, next: Date.now() + anthropicRetryAfterMs });

    await getCharness().waitFor('the probe notice', replyTimeoutMs, () => listSentTexts(anthropicTopic.threadId).some((text) => text.startsWith(transientNoticeStart) && text.includes('2 min')));
    assert.deepEqual(listSentTexts(anthropicTopic.threadId).filter((text) => text.startsWith(limitNoticeMark)), [], 'not announced as a usage limit on the wording alone');
    assert.equal(readPersistedState(getLayout()).apiRetries?.[getTopicKey(anthropicTopic.threadId)]?.kind, 'transient', 'a short probe is armed, not a limit wait');
  });

  it('the same error right after the probe\'s resume confirms the limit: the wait to the reset is announced', async () => {
    const sessionId = getTopicSessionId(anthropicTopic.folder);
    const promptsBefore = fakeOpenCode.prompts.filter((prompt) => prompt.sessionId === sessionId).length;
    await getCharness().waitFor('the probe to resume the topic', probeTimeoutMs, () => fakeOpenCode.prompts.filter((prompt) => prompt.sessionId === sessionId).length > promptsBefore);
    fakeOpenCode.emitSessionBusy(sessionId);
    const resetAt = Date.now() + anthropicRetryAfterMs;
    fakeOpenCode.emitProviderRetry(sessionId, { attempt: 1, message: anthropicUnconfirmedMessage, next: resetAt });

    await getCharness().waitFor('the usage-limit notice', replyTimeoutMs, () => listSentTexts(anthropicTopic.threadId).some((text) => text.startsWith(limitNoticeMark)));
    const notice = listSentTexts(anthropicTopic.threadId).find((text) => text.startsWith(limitNoticeMark)) ?? '';
    assert.match(notice, /will auto-resume after reset/, `the wait to the reset, got: ${notice}`);
  });

  it('OpenCode Go\'s "It will reset in 2 hours 30 minutes": the notice names the whole duration', async () => {
    const driver = new TopicDriver(fakeTelegram, getCharness, goTopic.threadId, replyTimeoutMs);
    await driver.sendAndAwaitReply(`/bind ${goTopic.folder}`, `Bound to \`${goTopic.folder}\``);
    await driver.sendAndAwaitReply('/opencode', 'ready in');
    fakeTelegram.pushOperatorMessage(goTopic.threadId, 'GO-1 one more module');
    await getCharness().waitFor('the prompt to reach the server', replyTimeoutMs, () => fakeOpenCode.prompts.some((prompt) => prompt.text.includes('GO-1')));
    const sentAt = Date.now();
    const resetInMs = (2 * 60 + 30) * msPerMinute;
    fakeOpenCode.emitProviderRetry(getTopicSessionId(goTopic.folder), {
      attempt: 1,
      message: 'Go usage limit reached. It will reset in 2 hours 30 minutes. To continue using this model now, enable usage from your available balance - https://opencode.ai/workspace/wrk_example/go',
      next: sentAt + resetInMs,
    });

    await getCharness().waitFor('the usage-limit notice', replyTimeoutMs, () => listSentTexts(goTopic.threadId).some((text) => text.startsWith(limitNoticeMark)));
    const notice = listSentTexts(goTopic.threadId).find((text) => text.startsWith(limitNoticeMark)) ?? '';
    // The bot reads its clock a moment after `sentAt`: the reset's minute is that of `sentAt` + 2:30, or the next one.
    const expectedClocks = [0, msPerMinute].map((driftMs) => new Date(sentAt + resetInMs + driftMs).toISOString().slice(11, 16));
    // The bot adds the date when the reset is not today (the run may cross midnight UTC).
    assert.ok(expectedClocks.some((clock) => new RegExp(`~(?:\\d{4}-\\d{2}-\\d{2} )?${clock}\\)`).test(notice)), `the reset 2 h 30 min ahead (${expectedClocks.join(' or ')}), got: ${notice}`);
  });

  it('a usage limit whose reset is a zone-less ISO stamp: the plain hourly retry, no guessed reset time', async () => {
    const driver = new TopicDriver(fakeTelegram, getCharness, zonelessTopic.threadId, replyTimeoutMs);
    await driver.sendAndAwaitReply(`/bind ${zonelessTopic.folder}`, `Bound to \`${zonelessTopic.folder}\``);
    await driver.sendAndAwaitReply('/opencode', 'ready in');
    const zonelessStamp = new Date(Date.now() + 3 * 60 * msPerMinute).toISOString().slice(0, 19).replace('T', ' ');
    fakeOpenCode.emitSessionError(getTopicSessionId(zonelessTopic.folder), {
      name: 'APIError',
      data: { message: `Usage limit reached for this key. It resets at ${zonelessStamp}.`, statusCode: 403, isRetryable: false },
    });

    await getCharness().waitFor('the usage-limit notice', replyTimeoutMs, () => listSentTexts(zonelessTopic.threadId).some((text) => text.startsWith(limitNoticeMark)));
    const notice = listSentTexts(zonelessTopic.threadId).find((text) => text.startsWith(limitNoticeMark)) ?? '';
    assert.match(notice, /retrying in 60 min/, `an unknown reset, got: ${notice}`);
  });
});
