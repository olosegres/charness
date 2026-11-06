/**
 * @description Coverage for `connectors/telegram/unpinMessages.ts`: which unpin failures count as «released» (the caller
 * forgets the pin) and which as «still pinned, try again». The errors are shaped like the Bot API's (`response.error_code` +
 * `description`) and like the ones that carry no answer at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unpinMessagesReportingRetryable } from '../connectors/telegram/unpinMessages';

/** An error the way Telegraf raises a Bot API answer. */
function createBotApiError(errorCode: number, description: string): Error & { response: { error_code: number; description: string } } {
  return Object.assign(new Error(`${errorCode}: ${description}`), { response: { error_code: errorCode, description } });
}

/** Unpin that fails with the error listed for the id, and succeeds for any other. */
function createUnpin(errors: Record<number, Error>): { unpinOne: (messageId: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    unpinOne: async (messageId) => {
      calls.push(messageId);
      if (errors[messageId]) throw errors[messageId];
    },
  };
}

test('every unpin that goes through: nothing to try again', async () => {
  const { unpinOne, calls } = createUnpin({});
  assert.deepEqual(await unpinMessagesReportingRetryable([1, 2, 3], unpinOne, () => {}), []);
  assert.deepEqual(calls, [1, 2, 3], 'one call per message, in order');
});

test('an answer that is final counts as released: the message is gone or was never pinned, the right is lost, the chat is gone', async () => {
  const { unpinOne } = createUnpin({
    1: createBotApiError(400, 'Bad Request: message to unpin not found'),
    2: createBotApiError(400, 'Bad Request: not enough rights to manage pinned messages in the chat'),
    3: createBotApiError(403, 'Forbidden: bot was kicked from the supergroup chat'),
    4: createBotApiError(400, 'Bad Request: chat not found'),
  });
  assert.deepEqual(await unpinMessagesReportingRetryable([1, 2, 3, 4], unpinOne, () => {}), [], 'a retry would change nothing');
});

test('a failure that may pass is reported back: no answer at all, a rate limit, a server error', async () => {
  const { unpinOne } = createUnpin({
    1: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    2: createBotApiError(429, 'Too Many Requests: retry after 5'),
    3: createBotApiError(502, 'Bad Gateway'),
    4: createBotApiError(400, 'Bad Request: message to unpin not found'),
  });
  assert.deepEqual(await unpinMessagesReportingRetryable([1, 2, 3, 4, 5], unpinOne, () => {}), [1, 2, 3], '4 is final and 5 went through');
});

test('one failing message never stops the others, and every failure is told to the logger', async () => {
  const { unpinOne, calls } = createUnpin({ 2: createBotApiError(500, 'Internal Server Error') });
  const told: number[] = [];
  assert.deepEqual(await unpinMessagesReportingRetryable([1, 2, 3], unpinOne, (messageId) => told.push(messageId)), [2]);
  assert.deepEqual(calls, [1, 2, 3]);
  assert.deepEqual(told, [2]);
});
