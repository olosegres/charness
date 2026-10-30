/**
 * @description Plan §11 Этап 7 / R8 — Telegram send-error classification.
 *
 * The bot's `handleSendError` does three things based on the classifier
 * output:
 *   - thread-deleted → wipe binding + agents + in-memory state
 *   - topic-closed   → mark binding closed:true, notify in General
 *   - other          → log only
 *
 * If the classifier mislabels an error the bot will either drop a
 * binding the user cares about (treating a closed topic as deleted) or
 * leak state for a deleted topic (treating it as merely closed). Both
 * regressions silently corrupt state, so we exhaustively cover the real
 * Telegram description strings observed in the wild plus a few
 * defensive cases.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { classifySendError, getErrorCode, getErrorDescription, checkIsApiError, checkIsConnectionResetError } from '../sendErrorClassifier';

// Helper: build an error in Telegraf's shape.
function tgError(code: number, description: string): unknown {
  return { response: { error_code: code, description } };
}

test('R8: 400 "Bad Request: message thread not found" → thread-deleted', () => {
  assert.equal(
    classifySendError(tgError(400, 'Bad Request: message thread not found')),
    'thread-deleted',
  );
});

test('R8: 400 "message thread not found" (sans prefix) → thread-deleted', () => {
  assert.equal(
    classifySendError(tgError(400, 'message thread not found')),
    'thread-deleted',
  );
});

test('R8: 400 case-insensitive thread-not-found is still caught', () => {
  assert.equal(
    classifySendError(tgError(400, 'Bad Request: MESSAGE THREAD NOT FOUND')),
    'thread-deleted',
  );
});

test('R8: 400 "Bad Request: TOPIC_CLOSED" → topic-closed', () => {
  // Plan §13.10 E5: closure must NOT trigger cleanup; the binding has to
  // survive a topic being closed and re-opened.
  assert.equal(
    classifySendError(tgError(400, 'Bad Request: TOPIC_CLOSED')),
    'topic-closed',
  );
});

test('R8: 400 "topic is closed" variant → topic-closed', () => {
  assert.equal(
    classifySendError(tgError(400, 'Bad Request: topic is closed')),
    'topic-closed',
  );
});

test('R8: 400 unrelated description → other (binding untouched)', () => {
  // Permission errors, parse-mode errors, etc. must not trigger cleanup.
  assert.equal(
    classifySendError(tgError(400, "Bad Request: can't parse entities: Unsupported start tag")),
    'other',
  );
  assert.equal(
    classifySendError(tgError(400, 'Bad Request: not enough rights')),
    'other',
  );
});

test('R8: 403 "Forbidden: bot was kicked" → other (we do not auto-cleanup on kick)', () => {
  // Plan §13.10: only 400-thread-not-found and 400-TOPIC_CLOSED have
  // surgical handling. A 403 kick is a different beast — admin
  // intervention, possibly transient — and the operator needs the
  // binding intact for re-adding the bot.
  assert.equal(
    classifySendError(tgError(403, 'Forbidden: bot was kicked from the supergroup chat')),
    'other',
  );
});

test('R8: 429 rate limit → other (handled by rateLimiter.ts, not the GC path)', () => {
  assert.equal(
    classifySendError(tgError(429, 'Too Many Requests: retry after 30')),
    'other',
  );
});

test('R8: non-API errors classify as other', () => {
  // The rest of the stack reads `kind === 'other'` and logs without
  // touching state — that's the safe default for unexpected shapes.
  assert.equal(classifySendError(new Error('socket hang up')), 'other');
  assert.equal(classifySendError(null), 'other');
  assert.equal(classifySendError(undefined), 'other');
  assert.equal(classifySendError('a string'), 'other');
  assert.equal(classifySendError({}), 'other');
});

test('R8: flat description (Telegraf legacy shape) is read', () => {
  // Some Telegraf versions surface a flat `err.description`; the
  // classifier must look at both shapes so we never miss a cleanup.
  const err = { description: 'Bad Request: message thread not found' };
  assert.equal(classifySendError(err), 'other'); // no code → other
  assert.equal(getErrorDescription(err as never), 'Bad Request: message thread not found');
  assert.equal(checkIsApiError(err), true);
});

test('R8: classifier accessors are stable for downstream logging', () => {
  // The bot's fallthrough branch logs `getErrorCode + getErrorDescription`.
  // Verify those helpers report exactly what was set on `response`.
  const err = tgError(400, 'TOPIC_CLOSED');
  assert.equal(getErrorCode(err as never), 400);
  assert.equal(getErrorDescription(err as never), 'TOPIC_CLOSED');
});

// The shapes below are what node-fetch throws around a socket error (`FetchError`: its message, `type: 'system'`, and the
// system error's `code` copied on); a real one is produced by `botApiConnection.test.ts` against a server that hangs up.
function createFetchSystemError(message: string, code: string): Error {
  return Object.assign(new Error(message), { type: 'system', errno: code, code });
}

test('a connection the other side reset before answering is a connection-reset error: ECONNRESET, EPIPE, «socket hang up»', () => {
  assert.equal(checkIsConnectionResetError(createFetchSystemError('request to https://api.example.org/bot1/sendMessage failed, reason: socket hang up', 'ECONNRESET')), true);
  assert.equal(checkIsConnectionResetError(createFetchSystemError('request to https://api.example.org/bot1/sendMessage failed, reason: read ECONNRESET', 'ECONNRESET')), true);
  assert.equal(checkIsConnectionResetError(createFetchSystemError('request to https://api.example.org/bot1/sendMessage failed, reason: write EPIPE', 'EPIPE')), true);
  assert.equal(checkIsConnectionResetError(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })), true);
  // Node's own wording, without a code on the object.
  assert.equal(checkIsConnectionResetError(new Error('socket hang up')), true);
});

test('a timeout, a refused or unreachable host and an abort are NOT connection-reset errors: the server may be working on the request', () => {
  // node-fetch's own timer: no `code` at all, `type: 'request-timeout'`.
  assert.equal(checkIsConnectionResetError(Object.assign(new Error('network timeout at: https://api.example.org/bot1/getUpdates'), { type: 'request-timeout' })), false);
  assert.equal(checkIsConnectionResetError(createFetchSystemError('request to https://api.example.org failed, reason: connect ETIMEDOUT 1.2.3.4:443', 'ETIMEDOUT')), false);
  assert.equal(checkIsConnectionResetError(createFetchSystemError('request to https://api.example.org failed, reason: connect ECONNREFUSED 1.2.3.4:443', 'ECONNREFUSED')), false);
  assert.equal(checkIsConnectionResetError(createFetchSystemError('request to https://api.example.org failed, reason: getaddrinfo EAI_AGAIN api.example.org', 'EAI_AGAIN')), false);
  assert.equal(checkIsConnectionResetError(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })), false);
});

test('an answer of the Bot API is never a connection-reset error, whatever its words: the server did process the request', () => {
  assert.equal(checkIsConnectionResetError(tgError(429, 'Too Many Requests: retry after 5')), false);
  assert.equal(checkIsConnectionResetError(tgError(502, 'socket hang up')), false);
  assert.equal(checkIsConnectionResetError({ description: 'socket hang up' }), false);
});

test('values that are not errors are not connection-reset errors', () => {
  for (const value of [null, undefined, 'socket hang up', 0, {}, { code: 'ECONNRESET_NOT' }]) {
    assert.equal(checkIsConnectionResetError(value), false, JSON.stringify(value) ?? 'undefined');
  }
});
