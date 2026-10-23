/**
 * @description One failure of an OpenCode turn reaches the topic ONCE. OpenCode publishes most failures on two
 * channels — `session.error` and the failed assistant message's `message.updated` (`info.error`) — in either order, and
 * may update that message more than once. Both were surfaced, each as the provider's whole text: a Gemini 400 relayed by
 * an auth plugin came as two 500-character dumps, its `[Debug Info]` block (the user's Google project id, part of the
 * tool schema) included, and nothing recovered.
 *
 * Load-bearing intent:
 * - either arrival order posts one line and hands the failure to the auto-retry once;
 * - a failure that comes ONLY on the message (a compaction, a structured-output step) is still posted, once;
 * - a sub-agent's failed message is not the topic's failure;
 * - a new prompt starts a new turn: the same failure again is handled again (the retry's give-up depends on it);
 * - Gemini's "Requests ending with a model turn are not supported" is not posted at all: it is handed to the
 *   auto-retry, whose one localized notice is the topic's line.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { OpenCodeAdapter, getOpenCodeErrorLogText, getOpenCodeErrorMessage } from '../adapters/openCodeAdapter';
import { type AgentApiErrorClass } from '../types';
import { keyToString, type SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { createOpenCodeSessionFixture } from './openCodeSessionFixture';

const own = 'ses_own';
const child = 'ses_child';
const key: SessionKey = makeTelegramKey(-1001111111111, 7);

/** The plugin's tail as opencode-antigravity-auth appends it (values are placeholders). */
const debugInfoTail = '\n\n[Debug Info]\nRequested Model: gemini-3-pro\nProject: example-project-123\nEndpoint: https://example.invalid/v1internal\nTool Debug Payload: [{"name":"bash","description":"Executes a given W';
const modelTurnReason = 'Requests ending with a model turn are not supported.';
const modelTurnError = { name: 'APIError', data: { message: `${modelTurnReason}${debugInfoTail}`, statusCode: 400, isRetryable: false } };
const quotaError = { name: 'APIError', data: { message: 'You exceeded your current quota (requests per day).', statusCode: 429, isRetryable: false } };
const contextError = { name: 'APIError', data: { message: 'context window exceeded', statusCode: 400, isRetryable: false } };

function createAdapterWithSession(): { adapter: OpenCodeAdapter; outputs: string[]; apiErrors: AgentApiErrorClass[] } {
  const adapter = new OpenCodeAdapter();
  adapter['sessions'].set(keyToString(key), createOpenCodeSessionFixture({ key, sessionId: own }));
  adapter['sessionLineage'].set(child, own);
  // A prompt reaches no server here: only its turn bookkeeping matters.
  adapter['apiRequest'] = (async () => ({})) as OpenCodeAdapter['apiRequest'];
  const outputs: string[] = [];
  adapter.on('output', (_k: SessionKey, text: string) => outputs.push(text));
  const apiErrors: AgentApiErrorClass[] = [];
  adapter.on('apiError', (_k: SessionKey, apiError: AgentApiErrorClass) => apiErrors.push(apiError));
  return { adapter, outputs, apiErrors };
}

function emitSessionError(adapter: OpenCodeAdapter, sessionId: string, error: object): void {
  adapter['handleSessionError'](key, sessionId, { error });
}

function emitFailedMessage(adapter: OpenCodeAdapter, sessionId: string, error: object, messageId = 'msg_failed'): void {
  adapter['handleMessageUpdate'](key, { info: { id: messageId, sessionID: sessionId, role: 'assistant', error } });
}

test('session.error, then the failed message: one line, one retry hand-over', () => {
  const { adapter, outputs, apiErrors } = createAdapterWithSession();
  emitSessionError(adapter, own, quotaError);
  emitFailedMessage(adapter, own, quotaError);
  assert.deepEqual(outputs, [`OpenCode error: ${quotaError.data.message}`]);
  assert.deepEqual(apiErrors.map((apiError) => apiError.kind), ['usageLimit']);
});

test('the failed message, then session.error: one line, one retry hand-over', () => {
  const { adapter, outputs, apiErrors } = createAdapterWithSession();
  emitFailedMessage(adapter, own, quotaError);
  emitSessionError(adapter, own, quotaError);
  assert.deepEqual(outputs, [`Error: ${quotaError.data.message}`]);
  assert.deepEqual(apiErrors.map((apiError) => apiError.kind), ['usageLimit']);
});

test('a failure only on the message (a compaction): posted once, however often the message is updated', () => {
  const { adapter, outputs } = createAdapterWithSession();
  emitFailedMessage(adapter, own, contextError);
  emitFailedMessage(adapter, own, contextError);
  assert.deepEqual(outputs, [`Error: ${contextError.data.message}`]);
});

test('a sub-agent\'s failed message is not the topic\'s failure: not posted, nothing handed to the retry', () => {
  const { adapter, outputs, apiErrors } = createAdapterWithSession();
  emitFailedMessage(adapter, child, quotaError);
  assert.deepEqual(outputs, []);
  assert.deepEqual(apiErrors, []);
});

test('a new prompt is a new turn: the same failure again is handled again', () => {
  const { adapter, outputs } = createAdapterWithSession();
  emitSessionError(adapter, own, contextError);
  adapter['sendPromptAsync'](key, 'Continue from where you left off.');
  emitSessionError(adapter, own, contextError);
  assert.deepEqual(outputs, [`OpenCode error: ${contextError.data.message}`, `OpenCode error: ${contextError.data.message}`]);
});

test('Gemini\'s "model turn" refusal on both channels: nothing posted, one conversation-tail retry', () => {
  for (const order of [['session', 'message'], ['message', 'session']] as const) {
    const { adapter, outputs, apiErrors } = createAdapterWithSession();
    for (const channel of order) {
      if (channel === 'session') emitSessionError(adapter, own, modelTurnError);
      else emitFailedMessage(adapter, own, modelTurnError);
    }
    assert.deepEqual(outputs, [], `${order.join(' → ')}: the retry's notice is the topic's line`);
    assert.deepEqual(apiErrors, [{ kind: 'conversationTail' }], `${order.join(' → ')}: handed to the retry once`);
  }
});

test('the plugin\'s [Debug Info] tail is cut from the posted text; the log keeps it', () => {
  assert.equal(getOpenCodeErrorMessage(modelTurnError), modelTurnReason);
  assert.equal(getOpenCodeErrorMessage(`${modelTurnReason}${debugInfoTail}`), modelTurnReason, 'the string shape too');
  assert.ok(getOpenCodeErrorLogText(modelTurnError).includes('Project: example-project-123'), 'the full text stays findable in the bot log');
  // Posted when the classifier does not know it: the reason only, no project, no tool schema.
  const { adapter, outputs } = createAdapterWithSession();
  emitSessionError(adapter, own, { name: 'APIError', data: { message: `Invalid argument: tool schema rejected.${debugInfoTail}`, statusCode: 400 } });
  assert.deepEqual(outputs, ['OpenCode error: Invalid argument: tool schema rejected.']);
});

test('the log text is redacted like the posted one', () => {
  const logText = getOpenCodeErrorLogText({ message: `bad key sk-ant-api03-leakedvalue${debugInfoTail}` });
  assert.ok(!logText.includes('sk-ant-api03-leakedvalue'));
  assert.ok(logText.includes('[Debug Info]'));
});
