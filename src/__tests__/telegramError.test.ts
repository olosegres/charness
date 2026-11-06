import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkIsMessageNotFoundError, checkIsNetworkError, checkIsRetryableTelegramError, checkIsStaleAnswerCallbackQueryError } from '../utils/telegramError';

describe('checkIsStaleAnswerCallbackQueryError', () => {
  it('matches stale answerCallbackQuery Telegram 400 errors', () => {
    assert.equal(
      checkIsStaleAnswerCallbackQueryError({
        response: { error_code: 400, description: 'Bad Request: query is too old and response timeout expired or query ID is invalid' },
        on: { method: 'answerCallbackQuery' },
      }),
      true,
    );
  });

  it('does not match unrelated Telegram 400 errors', () => {
    assert.equal(
      checkIsStaleAnswerCallbackQueryError({
        response: { error_code: 400, description: 'Bad Request: message is not modified' },
        on: { method: 'editMessageText' },
      }),
      false,
    );
  });
});

describe('checkIsMessageNotFoundError', () => {
  it('matches the Bot API\'s answer for a message that is not there any more, as a delete or an edit meets it', () => {
    assert.equal(checkIsMessageNotFoundError({ response: { error_code: 400, description: 'Bad Request: message to delete not found' }, on: { method: 'deleteMessage' } }), true);
    assert.equal(checkIsMessageNotFoundError({ response: { error_code: 400, description: 'Bad Request: message to edit not found' }, on: { method: 'editMessageReplyMarkup' } }), true);
  });

  it('does not match a message Telegram refuses to delete, nor anything that is no Telegram error', () => {
    assert.equal(checkIsMessageNotFoundError({ response: { error_code: 400, description: 'Bad Request: message can\'t be deleted' }, on: { method: 'deleteMessage' } }), false);
    assert.equal(checkIsMessageNotFoundError(new Error('message to delete not found')), false);
    assert.equal(checkIsMessageNotFoundError(null), false);
  });
});

describe('checkIsRetryableTelegramError', () => {
  it('is true for a call Telegram never answered, a 429 and a 5xx — the moments a later try can fix', () => {
    assert.equal(checkIsRetryableTelegramError(new Error('request to https://api.telegram.org failed, reason: socket hang up')), true, 'no Bot API answer at all');
    assert.equal(checkIsRetryableTelegramError({ response: { error_code: 429, description: 'Too Many Requests: retry after 5' } }), true);
    assert.equal(checkIsRetryableTelegramError({ response: { error_code: 500, description: 'Internal Server Error' } }), true);
    assert.equal(checkIsRetryableTelegramError({ response: { error_code: 502, description: 'Bad Gateway' } }), true);
    assert.equal(checkIsRetryableTelegramError('a thrown string'), true, 'whatever is not a Telegram answer is treated as a bad moment');
  });

  it('is false for a final answer: the message is gone, too old to delete, or the bot lost its right', () => {
    assert.equal(checkIsRetryableTelegramError({ response: { error_code: 400, description: 'Bad Request: message to delete not found' } }), false);
    assert.equal(checkIsRetryableTelegramError({ response: { error_code: 400, description: 'Bad Request: message can\'t be deleted' } }), false);
    assert.equal(checkIsRetryableTelegramError({ response: { error_code: 403, description: 'Forbidden: bot was kicked from the supergroup chat' } }), false);
    assert.equal(checkIsRetryableTelegramError({ response: { error_code: 404, description: 'Not Found' } }), false);
  });
});

describe('checkIsNetworkError', () => {
  it('is true for what the network does: node-fetch\'s FetchError, a Node socket or DNS code, «socket hang up», «network timeout»', () => {
    assert.equal(checkIsNetworkError(Object.assign(new Error('request to https://api.telegram.org/bot/x failed, reason: connect ETIMEDOUT'), { name: 'FetchError', type: 'system' })), true);
    assert.equal(checkIsNetworkError(Object.assign(new Error('x'), { code: 'ECONNRESET' })), true);
    assert.equal(checkIsNetworkError(Object.assign(new Error('x'), { code: 'EAI_AGAIN' })), true);
    assert.equal(checkIsNetworkError(Object.assign(new Error('x'), { code: 'UND_ERR_CONNECT_TIMEOUT' })), true);
    assert.equal(checkIsNetworkError(new Error('request to https://api.telegram.org failed, reason: socket hang up')), true);
    assert.equal(checkIsNetworkError(new Error('network timeout at: https://api.telegram.org/bot/getMe')), true);
  });

  it('is false for a bug of ours, a Bot API answer and anything that is no error object', () => {
    assert.equal(checkIsNetworkError(new TypeError('Cannot read properties of undefined (reading \'chatId\')')), false);
    assert.equal(checkIsNetworkError(new Error('boom')), false);
    assert.equal(checkIsNetworkError(Object.assign(new Error('x'), { code: 'ERR_INVALID_ARG_TYPE' })), false, 'a Node code that is not a network one');
    assert.equal(checkIsNetworkError({ response: { error_code: 400, description: 'Bad Request: chat not found' } }), false);
    assert.equal(checkIsNetworkError('socket hang up'), false, 'a thrown string');
    assert.equal(checkIsNetworkError(null), false);
    assert.equal(checkIsNetworkError(undefined), false);
  });
});

