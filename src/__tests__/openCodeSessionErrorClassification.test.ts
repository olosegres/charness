/**
 * @description What a `session.error` is classified from (path 5 of the OpenCode false-limit investigation). OpenCode
 * relays the provider failure as `{ name: 'APIError', data: { message, statusCode, responseHeaders, responseBody,
 * metadata } }`; the bot used to run its limit regexes over the WHOLE serialized object. Response headers name limits
 * and resets of their own (`x-…-limit-…`, `…-reset…`, `anthropic-ratelimit-requests-reset: <ISO>`), so a plain 400
 * read as a usage limit, and a usage limit took the first ISO stamp in its headers — a per-minute counter's reset — as
 * the window's. Now only the message, the body and the status code are read, and a reset comes from the `retry-after`
 * header as a field.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { OpenCodeAdapter } from '../adapters/openCodeAdapter';
import { type AgentApiErrorClass } from '../types';
import { keyToString, type SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { createOpenCodeSessionFixture } from './openCodeSessionFixture';

const own = 'ses_own';
const key: SessionKey = makeTelegramKey(-1001111111111, 9);
const msPerHour = 60 * 60 * 1000;
/** How far the measured reset may sit from the expected one (the adapter reads its own clock). */
const clockToleranceMs = 5_000;

function createAdapterWithSession(): { adapter: OpenCodeAdapter; apiErrors: AgentApiErrorClass[] } {
  const adapter = new OpenCodeAdapter();
  adapter['sessions'].set(keyToString(key), createOpenCodeSessionFixture({ key, sessionId: own }));
  const apiErrors: AgentApiErrorClass[] = [];
  adapter.on('apiError', (_k: SessionKey, apiError: AgentApiErrorClass) => apiErrors.push(apiError));
  return { adapter, apiErrors };
}

function buildApiError(data: Record<string, string | number | boolean | Record<string, string>>): { name: string; data: typeof data } {
  return { name: 'APIError', data };
}

test('a 400 whose response HEADERS name limits and resets is not a usage limit', () => {
  const { adapter, apiErrors } = createAdapterWithSession();
  adapter['handleSessionError'](key, own, { error: buildApiError({
    message: "Unsupported parameter: 'reasoning.summary'",
    statusCode: 400,
    isRetryable: false,
    responseHeaders: { 'x-codex-primary-reset-after-seconds': '9000', 'x-codex-primary-used-percent': '12', 'x-codex-primary-window-minutes': '300', 'x-codex-primary-over-secondary-limit-percent': '0', 'x-request-id': 'req_1' },
    responseBody: '{"error":{"message":"Unsupported parameter: \'reasoning.summary\'","type":"invalid_request_error"}}',
    metadata: { url: 'https://chatgpt.com/backend-api/codex/responses' },
  }) });
  assert.deepEqual(apiErrors, [], 'nothing in the message or the body is a provider limit');
});

test('a usage limit takes its reset from the retry-after header, never from an ISO stamp of another header', () => {
  const { adapter, apiErrors } = createAdapterWithSession();
  const startedAt = Date.now();
  adapter['handleSessionError'](key, own, { error: buildApiError({
    message: "You've hit your usage limit.",
    statusCode: 429,
    isRetryable: false,
    // A per-minute counter's reset, a few seconds away — not the usage window's.
    responseHeaders: { 'anthropic-ratelimit-requests-reset': new Date(startedAt + 30_000).toISOString(), 'retry-after': '7200' },
    responseBody: '{"type":"error","error":{"type":"rate_limit_error","message":"You\'ve hit your usage limit."}}',
  }) });
  assert.equal(apiErrors.length, 1);
  assert.equal(apiErrors[0].kind, 'usageLimit');
  const resetAt = apiErrors[0].resetAt ?? 0;
  assert.ok(Math.abs(resetAt - (startedAt + 2 * msPerHour)) < clockToleranceMs, `the reset is retry-after's two hours, got ${new Date(resetAt).toISOString()}`);
});

test('the status code still counts: a bare 429 APIError is a transient hiccup', () => {
  const { adapter, apiErrors } = createAdapterWithSession();
  adapter['handleSessionError'](key, own, { error: buildApiError({ message: 'Too Many Requests', statusCode: 429, isRetryable: true }) });
  assert.deepEqual(apiErrors, [{ kind: 'transient' }]);
});

test('the response body still counts: a quota code only in the body is read', () => {
  const { adapter, apiErrors } = createAdapterWithSession();
  adapter['handleSessionError'](key, own, { error: buildApiError({
    message: 'Request failed',
    statusCode: 429,
    isRetryable: false,
    responseBody: '{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","code":"insufficient_quota"}}',
  }) });
  assert.equal(apiErrors[0]?.kind, 'usageLimit');
});

// Paths 6 and 7: a `session.error` routed to the topic is not always the topic's OWN session's. A sub-agent's child
// session (often on another model or provider) reports its own quota, and a foreign session in the same folder (the
// operator's own `opencode` TUI, an old session still retrying) is routed to the folder's one topic. Armed as the
// topic's limit, the parent — still working — was held, its model marked limited, the operator told «Usage limit reached».
const quotaError = buildApiError({ message: 'You exceeded your current quota (requests per day).', statusCode: 429, isRetryable: false });

test('a CHILD (sub-agent) session\'s quota error does not arm the topic\'s limit wait', () => {
  const { adapter, apiErrors } = createAdapterWithSession();
  adapter['sessionLineage'].set('ses_child', own);
  adapter['handleSessionError'](key, 'ses_child', { error: quotaError });
  assert.deepEqual(apiErrors, []);
});

test('a FOREIGN session\'s quota error, routed by the folder, does not arm the topic\'s limit wait', () => {
  const { adapter, apiErrors } = createAdapterWithSession();
  adapter['handleSessionError'](key, 'ses_foreign_in_same_folder', { error: quotaError });
  assert.deepEqual(apiErrors, []);
});

test('the topic\'s OWN session\'s quota error still does', () => {
  const { adapter, apiErrors } = createAdapterWithSession();
  adapter['handleSessionError'](key, own, { error: quotaError });
  assert.equal(apiErrors[0]?.kind, 'usageLimit');
});
