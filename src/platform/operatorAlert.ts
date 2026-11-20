/**
 * @description A channel the bot tells its OPERATOR on — something broke that only they can fix (a Claude account signed out,
 * `utils/claudeAccountAlert.ts`). Telegram's is General, which `bot.ts` posts to itself; a connector without a General offers
 * one of its own (Jira: the operator issue, `connectors/jira/operatorIssue.ts`). The core hands every channel the same English
 * text; the channel decides how it reaches the operator.
 */

/** What one alert asks of the channel. */
export interface OperatorAlertPostOptions {
  /** The operator must act (a channel that can notify them does: a Jira mention); `false` for a recovery line. */
  isActionRequired: boolean;
}

export type OperatorAlertPostResult = { ok: true } | { ok: false; error: string };

export interface OperatorAlertChannel {
  /** Where it posts, for the log (`jira OPS-12`). */
  label: string;
  /** Post `text` (Markdown, English). Never rejects; a failure is the result's `error`. Never retried by the caller: a second post could tell it twice. */
  post(text: string, options: OperatorAlertPostOptions): Promise<OperatorAlertPostResult>;
}
