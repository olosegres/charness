/**
 * @description Gemini's "Requests ending with a model turn are not supported" on OpenCode, at PROCESS level: the BUILT
 * charness started the way an isolated instance is (`scripts/run-isolated.sh`) against the fake Bot API
 * (`telegramE2e/fakeTelegram.ts`) and the fake OpenCode server (`openCodeE2e/fakeOpenCodeServer.ts`). OpenCode v1's
 * agent loop resends a history that ends on the model's own turn (after a step that finished `unknown`, or on its
 * max-steps prompt) and Gemini answers 400; an auth plugin (opencode-antigravity-auth) appends a `[Debug Info]` block —
 * the user's Google project id, part of the tool schema — to the provider's message. One flow, in order:
 *
 *   boot → a topic bound to a folder runs an OpenCode session on Gemini; a prompt is in flight
 *   → the turn fails with the refusal, reported the way OpenCode does — `session.error` AND the failed assistant
 *     message (`message.updated` with `info.error`): the topic gets ONE short localized line, no raw text, no
 *     `[Debug Info]`, no project id, and the bot sends its "continue" (a user turn) to the same session at once. It
 *     used to post the plugin's whole message twice, cut at 500 characters, and recover nothing
 *   → the same refusal on that "continue": the usual give-up line, no third prompt.
 *
 * What the unit tests cover instead: the classifier and the retry plan (`apiErrorRetry.test.ts`), the channel de-dup,
 * the child-session guard and the `[Debug Info]` cut (`openCodeTurnFailure.test.ts`), the kick posting no second line
 * (`apiRetryKick.test.ts`).
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
import { openLimitsBoard, startCharnessOnInstance } from './e2e/fallbackFlowKit';
import { enDict } from '../i18n/en';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';

const geminiTopic = { threadId: 161, folder: 'gemini-model-turn' };
const fakeOpenCodeVersion = '1.17.11';
const geminiModel = 'google/gemini-3-pro';
const openCodeModels = [geminiModel] as const;
const promptLabel = 'TAIL-1';
const replyTimeoutMs = 20 * 1000;

/** The project id the plugin's block names (a placeholder): it must never reach the topic. */
const pluginProjectId = 'example-project-123';
const debugInfoTail = `\n\n[Debug Info]\nRequested Model: gemini-3-pro\nProject: ${pluginProjectId}\nEndpoint: https://example.invalid/v1internal:streamGenerateContent\nTool Debug Summary: idx=0, hasCustom=true\nTool Debug Payload: [{"name":"bash","description":"Executes a given W`;
const modelTurnReason = 'Requests ending with a model turn are not supported.';
const modelTurnError = {
  name: 'APIError',
  data: {
    message: `${modelTurnReason}${debugInfoTail}`,
    statusCode: 400,
    isRetryable: false,
    responseBody: JSON.stringify({ error: { code: 400, message: modelTurnReason, status: 'INVALID_ARGUMENT' } }),
  },
};
const continueNudge = enDict['apiRetry.continueNudge'];
const tailNotice = enDict['apiRetry.conversationTailNotice'];
const giveUpLine = enDict['apiRetry.giveUp'].replace('{attempts}', '1');

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

/** Every text the bot SENT to the topic or EDITED anywhere (the Bot API call log), oldest first, from call `fromCall`. */
function listTopicTexts(fromCall: number): string[] {
  return fakeTelegram.calls.slice(fromCall)
    .filter((call) => (call.method === 'sendMessage' && call.payload.message_thread_id === geminiTopic.threadId) || call.method === 'editMessageText')
    .map((call) => (typeof call.payload.text === 'string' ? call.payload.text : ''));
}

/** The messages the bot SENT to the topic since `fromCall`, the `/limits` boards (the barrier's own replies) left out. */
function listSentLines(fromCall: number): string[] {
  return fakeTelegram.calls.slice(fromCall)
    .filter((call) => call.method === 'sendMessage' && call.payload.message_thread_id === geminiTopic.threadId && !JSON.stringify(call.payload.reply_markup ?? null).includes('lim_'))
    .map((call) => (typeof call.payload.text === 'string' ? call.payload.text : ''));
}

function getTopicSessionId(): string {
  const folderPath = path.join(getLayout().workRoot, geminiTopic.folder);
  const session = [...fakeOpenCode.sessions.values()].find((candidate) => candidate.directory === folderPath);
  assert.ok(session, `a fake OpenCode session for ${folderPath}`);
  return session.id;
}

function countSessionPrompts(sessionId: string): number {
  return fakeOpenCode.prompts.filter((prompt) => prompt.sessionId === sessionId).length;
}

/** The turn fails the way OpenCode reports it: `session.error`, then the failed assistant message. */
function failTheTurn(sessionId: string, messageId: string): void {
  fakeOpenCode.emitSessionError(sessionId, modelTurnError);
  fakeOpenCode.emitFailedAssistantMessage(sessionId, messageId, modelTurnError);
}

describe('Gemini\'s "model turn" refusal on OpenCode end to end: built charness, fake Bot API, fake OpenCode', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-ocmodelturn-', [geminiTopic.folder], getFlowDeadlineMs());
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
    fakeTelegram.pushOperatorMessage(geminiTopic.threadId, `${promptLabel} refactor the parser`);
    await getCharness().waitFor('the prompt to reach the server', replyTimeoutMs, () => fakeOpenCode.prompts.some((prompt) => prompt.text.includes(promptLabel)));
  });

  it('the refusal on both channels: one localized line, no raw text or [Debug Info], and the "continue" goes to the same session', async () => {
    const sessionId = getTopicSessionId();
    const promptsBefore = countSessionPrompts(sessionId);
    const callsBefore = fakeTelegram.calls.length;
    failTheTurn(sessionId, 'msg_failed_1');

    await getCharness().waitFor('the "continue" prompt', replyTimeoutMs, () => countSessionPrompts(sessionId) > promptsBefore);
    const nudge = fakeOpenCode.prompts.filter((prompt) => prompt.sessionId === sessionId)[promptsBefore];
    assert.ok(nudge.text.includes(continueNudge), `the bot's "continue" is the new user turn, got: ${nudge.text}`);
    // A barrier that cannot race: the sends are paced first come, first served, so the board comes after every line
    // the failure queued.
    await openLimitsBoard(fakeTelegram, topic, geminiTopic.threadId);
    assert.deepEqual(listSentLines(callsBefore), [tailNotice], 'one localized line for the failure, nothing else');
    for (const text of listTopicTexts(callsBefore)) {
      assert.ok(!text.includes('[Debug Info]') && !text.includes(pluginProjectId), `no plugin diagnostics in the topic: ${text}`);
      assert.ok(!text.includes(modelTurnReason), `no raw provider text in the topic: ${text}`);
    }
  });

  it('the same refusal on that "continue": the usual give-up line, and no third prompt', async () => {
    const sessionId = getTopicSessionId();
    const promptsBefore = countSessionPrompts(sessionId);
    const callsBefore = fakeTelegram.calls.length;
    failTheTurn(sessionId, 'msg_failed_2');

    await topic.waitForMessage('the give-up line', (message) => message.text === giveUpLine);
    await openLimitsBoard(fakeTelegram, topic, geminiTopic.threadId);
    assert.equal(countSessionPrompts(sessionId), promptsBefore, 'no further "continue"');
    assert.deepEqual(listSentLines(callsBefore), [giveUpLine], 'the give-up line alone: no second "continuing…", no raw text');
  });
});

