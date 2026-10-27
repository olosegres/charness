import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkIsMessageNotFoundError, checkIsStaleAnswerCallbackQueryError } from '../utils/telegramError';

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
