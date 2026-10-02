import type { CallApiHost } from '../../outputTrace';

/**
 * @description An instance that does not serve Telegram (Jira connector plan J3,
 * D9) still constructs the Telegram client — `bot.ts` is built around it — but
 * must never reach the Bot API: no token is configured, and a call slipping
 * through means a Telegram path a Jira conversation was supposed to stay out of.
 * Installed OUTERMOST, so the call fails before anything is sent or traced.
 */
export class TelegramDisabledError extends Error {
  constructor(method: string) {
    super(`Telegram API call "${method}" refused: the telegram connector is off for this instance`);
    this.name = 'TelegramDisabledError';
  }
}

export function installTelegramCallGuard(host: CallApiHost): void {
  host.callApi = async (method) => {
    throw new TelegramDisabledError(method);
  };
}
