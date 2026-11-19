/**
 * @description `connectors/telegram/telegramFailureRetry.ts`: what a failed send says — whether trying again later may help (the one rule the
 * unpins use too) and whether Telegram refused with 403, the bot may not write to that chat at all (a person who never opened a private chat
 * with it, or blocked it), which `/runners` reads to send a pairing line to the topic when it cannot go privately.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkIsTelegramFailureRetryable, getFailedSendOutcome } from '../connectors/telegram/telegramFailureRetry';
import { RateLimitedError } from '../rateLimiter';

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

describe('checkIsTelegramFailureRetryable', () => {
  it('a Bot API answer is judged by its code: a 4xx other than 429 is final (a 400, a 403, a 404), a 429 and any 5xx may pass later', () => {
    for (const code of [400, 403, 404]) assert.equal(checkIsTelegramFailureRetryable(createBotApiError(code, 'refused')), false, `${code}`);
    for (const code of [429, 500, 502, 504]) assert.equal(checkIsTelegramFailureRetryable(createBotApiError(code, 'try later')), true, `${code}`);
  });

  it('the pacer\'s own «rate limit survived the wait» error may pass later', () => {
    assert.equal(checkIsTelegramFailureRetryable(new RateLimitedError(-1001111111111, 5_000)), true);
  });

  it('with no answer at all only the NETWORK may be at fault: a reset, a hang-up, a timeout pass; a bug of ours, a thrown string and a flat description with no code never will', () => {
    assert.equal(checkIsTelegramFailureRetryable(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })), true);
    assert.equal(checkIsTelegramFailureRetryable(new Error('socket hang up')), true);
    assert.equal(checkIsTelegramFailureRetryable(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })), true);
    assert.equal(checkIsTelegramFailureRetryable(new TypeError('x is not a function')), false);
    assert.equal(checkIsTelegramFailureRetryable('boom'), false);
    assert.equal(checkIsTelegramFailureRetryable({ description: 'Bad Request: something odd' }), false);
    assert.equal(checkIsTelegramFailureRetryable(null), false);
  });
});
