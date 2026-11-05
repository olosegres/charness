interface TelegramErrorLike {
  response?: {
    error_code?: number;
    description?: string;
  };
  on?: {
    method?: string;
  };
}

function checkIsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function checkIsStaleAnswerCallbackQueryError(err: unknown): boolean {
  if (!checkIsRecord(err)) return false;
  const e = err as TelegramErrorLike;
  const description = e.response?.description ?? '';
  return (
    e.response?.error_code === 400 &&
    e.on?.method === 'answerCallbackQuery' &&
    /query is too old|query ID is invalid/i.test(description)
  );
}

/**
 * @description Whether a Telegram error says the message is not there (any more): the answer to deleting or editing a
 * message that was already deleted, by the person or by someone else. Not the one for a message Telegram refuses to delete
 * (older than 48 hours, no right) — that message stays.
 */
export function checkIsMessageNotFoundError(err: unknown): boolean {
  if (!checkIsRecord(err)) return false;
  const e = err as TelegramErrorLike;
  return e.response?.error_code === 400 && /message to (delete|edit) not found/i.test(e.response.description ?? '');
}

/**
 * @description Whether a failed Bot API call is worth trying again later: Telegram never answered (a dropped connection, a
 * timeout — the error carries no Bot API answer), asked the bot to slow down (429) or failed on its side (5xx). Any other answer
 * is final — the message is not there any more, is too old to delete, the bot lost its right, the chat is gone — and trying
 * again changes nothing.
 */
export function checkIsRetryableTelegramError(err: unknown): boolean {
  if (!checkIsRecord(err)) return true;
  const errorCode = (err as TelegramErrorLike).response?.error_code;
  if (errorCode === undefined) return true;
  return errorCode === 429 || errorCode >= 500;
}
