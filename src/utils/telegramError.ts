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
