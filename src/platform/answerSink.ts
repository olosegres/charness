import { tryKeyFromString, type PlatformId, type SessionKey } from '../sessionKey';
import type { RequestAlertReason, RequestAnswerKind, RequestOrigin, UnreleasedRequestAlert } from '../requests/types';

/**
 * @description The core-side contract for delivering an agent's answer to a
 * request back to the surface the request came from (request/answer core S3).
 * Each platform registers ONE sink; the core picks it by the conversation key's
 * `platform` and never branches on a platform itself. It is separate from
 * `ConnectorOutbound` on purpose: the stream (`deliver`) is fire-and-forget,
 * while an answer must report whether it landed — a failed answer leaves the
 * request untouched so the agent can retry.
 */

/**
 * @name RequestAnswerDelivery
 * @description One answer to deliver. `origin` is the request's own (its
 * connector-owned attributes say where on the platform to deliver); a request
 * that is no longer open (`isRequestOpen: false`) is still delivered.
 */
export interface RequestAnswerDelivery {
  requestId: string;
  kind: RequestAnswerKind;
  body: string;
  origin: RequestOrigin;
  isRequestOpen: boolean;
}

/**
 * @name AnswerDeliveryResult
 * @description `warning` reports a partial success the agent should know about
 * but must NOT retry (the answer itself landed).
 */
export type AnswerDeliveryResult = { ok: true; warning?: string } | { ok: false; error: string };

/**
 * @name RequestAlertDelivery
 * @description The alert raised when the wake-up rules give up on an open
 * request: "something went technically wrong", addressed to a person.
 */
export interface RequestAlertDelivery {
  requestId: string;
  reason: RequestAlertReason;
  origin: RequestOrigin;
}

/**
 * @name AlertDeliveryResult
 * @description `alertRef` is the sink's own handle on what it posted, kept with
 * the request and handed back to {@link AnswerSink.releaseAlert} when it closes.
 */
export type AlertDeliveryResult = { ok: true; alertRef?: string } | { ok: false; error: string };

/** @description A platform's answer and alert delivery. */
export interface AnswerSink {
  deliverAnswer(key: SessionKey, delivery: RequestAnswerDelivery): Promise<AnswerDeliveryResult>;
  deliverAlert(key: SessionKey, alert: RequestAlertDelivery): Promise<AlertDeliveryResult>;
  /** Undo what keeps an alert prominent (Telegram: unpin it) once its request closed. */
  releaseAlert(key: SessionKey, alertRef: string): Promise<void>;
}

/** @description The sinks of the platforms this process serves. */
export type AnswerSinks = ReadonlyMap<PlatformId, AnswerSink>;

/**
 * @name AnswerSinkLookup
 * @description The conversation's sink, or why there is none.
 */
export type AnswerSinkLookup = { ok: true; sink: AnswerSink } | { ok: false; error: string };

/**
 * @description The sink of a conversation's platform — the ONE lookup every
 * answer, alert and alert release goes through, so a platform this process does
 * not serve is reported the same way everywhere.
 */
export function getAnswerSink(answerSinks: AnswerSinks, key: SessionKey): AnswerSinkLookup {
  const sink = answerSinks.get(key.platform);
  return sink ? { ok: true, sink } : { ok: false, error: `no answer sink serves platform "${key.platform}"` };
}

/**
 * @description Release an alert a closed request held (Telegram: unpin it),
 * through its platform's sink. The request ledger calls it for every close and
 * again at boot for every alert still unreleased. Rejects when this process
 * cannot release it (its platform is not served here), so the ledger keeps the
 * alert for a later start that can.
 */
export async function releaseRequestAlert(answerSinks: AnswerSinks, alert: UnreleasedRequestAlert): Promise<void> {
  const key = tryKeyFromString(alert.conversationKey);
  if (!key) throw new Error(`no answer sink serves ${alert.conversationKey}`);
  const lookup = getAnswerSink(answerSinks, key);
  if (!lookup.ok) throw new Error(lookup.error);
  await lookup.sink.releaseAlert(key, alert.alertRef);
}
