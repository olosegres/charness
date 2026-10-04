import { tryKeyFromString } from '../sessionKey';
import { getAnswerSink, type AnswerSinks } from '../platform/answerSink';
import type { RequestLedger } from './requestLedger';
import type { ClosedRequestRecord, RequestAnswerKind, RequestCloseReason } from './types';

/**
 * @description The `answer_request` contract (request/answer core S3), kept out
 * of the MCP surface so the rules are testable without HTTP:
 *
 *   unknown id, or an id outside the caller's scope → refused, nothing sent
 *     (the two read the same, so a session cannot probe other topics' ids)
 *   delivery through the request platform's answer sink fails → refused, the
 *     request is unchanged and the agent may retry
 *   delivered, request open:   progress → counted, stays open
 *                              question / final → closes the request
 *   delivered, request closed: nothing changes (a late answer from a turn that
 *     outlived its request is still delivered — content is never dropped); a
 *     superseded request's result names the request that replaced it, so the
 *     agent knows which one its answer should have gone to
 */

/** The longest answer body accepted; the sinks split it to their surface's limits. */
export const answerBodyMaxLength = 100_000;

/** The answer kinds that close an open request, and the close reason each records. */
const closingAnswerReasons: Readonly<Record<RequestAnswerKind, RequestCloseReason | null>> = {
  progress: null,
  question: 'question',
  final: 'final',
};

/**
 * @name AnswerRequestDeps
 * @description The ledger (awaited until loaded — the bot MCP server serves
 * before the boot finished) and the answer sinks by platform.
 */
export interface AnswerRequestDeps {
  ledger: Pick<RequestLedger, 'whenLoaded' | 'getRequest' | 'updateOpenRequest' | 'closeRequest'>;
  answerSinks: AnswerSinks;
}

/**
 * @name AnswerRequestArgs
 * @description One `answer_request` call. `checkIsConversationInScope` answers
 * whether the calling session's token covers a conversation (serialized key).
 */
export interface AnswerRequestArgs {
  requestId: string;
  kind: RequestAnswerKind;
  body: string;
  checkIsConversationInScope: (conversationKey: string) => boolean;
}

/** @description What the tool reports back to the agent. */
export type AnswerRequestOutcome = { ok: true; message: string } | { ok: false; error: string };

function buildUnknownRequestError(requestId: string): string {
  return `Unknown request id "${requestId}". Answer only the request ids given to you in this conversation; nothing was sent.`;
}

/** The agent-facing line for an answer to a request that was open when it was delivered. */
function buildOpenAnswerMessage(requestId: string, kind: RequestAnswerKind, wasClosedMeanwhile: boolean): string {
  if (wasClosedMeanwhile) {
    return `Delivered. Request ${requestId} had just been closed (by a newer request or another answer), so nothing about it changed.`;
  }
  if (kind === 'progress') {
    return `Delivered. Request ${requestId} stays open — send the full result with kind "final" (or "question" if you need the requester) at the end of your turn.`;
  }
  return `Delivered. Request ${requestId} is now closed (${kind}).`;
}

/** The agent-facing line for an answer delivered to a request that was already closed. */
function buildClosedAnswerMessage(requestId: string, closed: ClosedRequestRecord): string {
  const replacedBy = closed.closeReason === 'superseded' && closed.supersededBy !== undefined
    ? ` by request ${closed.supersededBy} from the same requester — answer that one, it covers this request too`
    : '';
  return `Delivered. Request ${requestId} was already closed (${closed.closeReason}${replacedBy}), so nothing about it changed.`;
}

/** @description Deliver one answer and apply the close rules. */
export async function answerRequest(deps: AnswerRequestDeps, args: AnswerRequestArgs): Promise<AnswerRequestOutcome> {
  await deps.ledger.whenLoaded();
  const lookup = deps.ledger.getRequest(args.requestId);
  if (!lookup || !args.checkIsConversationInScope(lookup.conversationKey)) {
    return { ok: false, error: buildUnknownRequestError(args.requestId) };
  }
  const key = tryKeyFromString(lookup.conversationKey);
  if (!key) {
    return { ok: false, error: `Request ${args.requestId} belongs to a conversation this bot cannot address; nothing was sent.` };
  }
  const sinkLookup = getAnswerSink(deps.answerSinks, key);
  if (!sinkLookup.ok) {
    return { ok: false, error: `Answers cannot be delivered to platform "${key.platform}" by this bot; nothing was sent.` };
  }

  const delivery = await sinkLookup.sink.deliverAnswer(key, {
    requestId: args.requestId,
    kind: args.kind,
    body: args.body,
    origin: lookup.request.origin,
    isRequestOpen: lookup.isOpen,
  });
  if (!delivery.ok) {
    return { ok: false, error: `The answer was NOT delivered: ${delivery.error}. Request ${args.requestId} is unchanged; you may retry.` };
  }
  const warning = delivery.warning ? ` Note: ${delivery.warning}` : '';

  if (!lookup.isOpen) {
    return { ok: true, message: `${buildClosedAnswerMessage(args.requestId, lookup.request)}${warning}` };
  }
  const closeReason = closingAnswerReasons[args.kind];
  const changed = closeReason
    ? await deps.ledger.closeRequest(args.requestId, closeReason)
    : await deps.ledger.updateOpenRequest(args.requestId, (current) => ({
      progressAnswerCount: current.progressAnswerCount + 1,
      // An answer proves the agent read the request: a later wake-up reminds, never re-posts it (R21),
      // and a post retry still pending is moot (R28).
      ...(current.prompt !== undefined && current.isPromptTakenIn !== true ? { isPromptTakenIn: true } : {}),
      ...(current.nextPostRetryAt !== undefined ? { nextPostRetryAt: undefined } : {}),
    }));
  return { ok: true, message: `${buildOpenAnswerMessage(args.requestId, args.kind, changed === null)}${warning}` };
}
