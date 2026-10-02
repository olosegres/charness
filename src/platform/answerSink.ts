import { tryKeyFromString, type PlatformId, type SessionKey } from '../sessionKey';
import type { ClosedRequestRecord, RequestAlertReason, RequestAnswerKind, RequestOrigin } from '../requests/types';

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
 * @description Release the alert a closing request still holds (Telegram: unpin
 * it), through its platform's sink. The request ledger's close callback, so every
 * close path — an answer, a newer request, a cancellation — releases it.
 * Fire-and-forget: a failed release is logged, never thrown into the close.
 */
export function releaseClosedRequestAlert(answerSinks: AnswerSinks, record: ClosedRequestRecord): void {
  if (record.alertRef === undefined) return;
  const key = tryKeyFromString(record.conversationKey);
  const sink = key ? answerSinks.get(key.platform) : undefined;
  if (!key || !sink) return;
  void sink.releaseAlert(key, record.alertRef).catch((e) =>
    console.warn(`[requests] releasing the alert of ${record.id} failed:`, e instanceof Error ? e.message : e),
  );
}
