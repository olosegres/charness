import type { PlatformId, SessionKey } from '../sessionKey';
import type { RequestAnswerKind, RequestOrigin } from '../requests/types';

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

/** @description A platform's answer delivery. */
export interface AnswerSink {
  deliverAnswer(key: SessionKey, delivery: RequestAnswerDelivery): Promise<AnswerDeliveryResult>;
}

/** @description The sinks of the platforms this process serves. */
export type AnswerSinks = ReadonlyMap<PlatformId, AnswerSink>;
