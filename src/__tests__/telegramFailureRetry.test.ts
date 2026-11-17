/**
 * @description `connectors/telegram/telegramFailureRetry.ts`: what a failed send says — whether trying again later may help (the one rule the
 * unpins use too) and whether Telegram refused with 403, the bot may not write to that chat at all (a person who never opened a private chat
 * with it, or blocked it), which `/runners` reads to send a pairing line to the topic when it cannot go privately.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getFailedSendOutcome } from '../connectors/telegram/telegramFailureRetry';

function createBotApiError(code: number, description: string): unknown {
  return { response: { error_code: code, description } };
}

describe('getFailedSendOutcome', () => {
  it('403 is a refusal for good that says so: not retryable, and forbidden — the person never opened a private chat with the bot, or blocked it', () => {
    assert.deepEqual(getFailedSendOutcome(createBotApiError(403, "Forbidden: bot can't initiate conversation with a user")), { kind: 'failed', isRetryable: false, isForbidden: true });
    assert.deepEqual(getFailedSendOutcome(createBotApiError(403, 'Forbidden: bot was blocked by the user')), { kind: 'failed', isRetryable: false, isForbidden: true });
  });

  it('any other refusal is not «forbidden», and the flag is absent rather than false: 400 is final, 429 and 5xx may pass later', () => {
    assert.deepEqual(getFailedSendOutcome(createBotApiError(400, 'Bad Request: chat not found')), { kind: 'failed', isRetryable: false });
    assert.deepEqual(getFailedSendOutcome(createBotApiError(429, 'Too Many Requests: retry after 5')), { kind: 'failed', isRetryable: true });
    assert.deepEqual(getFailedSendOutcome(createBotApiError(502, 'Bad Gateway')), { kind: 'failed', isRetryable: true });
  });

  it('a failure that is no answer of Telegram: only a network one may pass later; a bug of ours never will', () => {
    assert.deepEqual(getFailedSendOutcome(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })), { kind: 'failed', isRetryable: true });
    assert.deepEqual(getFailedSendOutcome(new TypeError('x is not a function')), { kind: 'failed', isRetryable: false });
  });
});
