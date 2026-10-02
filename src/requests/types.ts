/**
 * @description Shapes of the request ledger (core plan S2). A REQUEST is one unit
 * of work the agent owes an answer to — an operator message, a scheduled run, a
 * tracker event. At most one request per conversation is OPEN; a closed one moves
 * to the append-only history.
 */

/**
 * @name RequestOriginKind
 * @description What raised a request, for the agent-facing header and the logs.
 *  - `message`      — a person wrote in the conversation.
 *  - `scheduledRun` — a scheduled prompt fired.
 *  - `trackerEvent` — a tracker connector picked an issue up (e.g. an assignment).
 */
export type RequestOriginKind = 'message' | 'scheduledRun' | 'trackerEvent';

/**
 * @name RequestOrigin
 * @description Where a request came from. `attributes` are connector-owned facts
 * the platform's answer sink needs to deliver back (a tracker's issue key and
 * trigger id, the requester to hand back to); the core stores them verbatim and
 * never interprets them.
 */
export interface RequestOrigin {
  kind: RequestOriginKind;
  attributes: Record<string, string>;
}

/**
 * @name RequestCloseReason
 * @description Why a request left the open set.
 *  - `final`      — the agent answered with the result.
 *  - `question`   — the agent asked the requester; their reply is a new request.
 *  - `superseded` — a newer request arrived in the same conversation.
 *  - `cancelled`  — the work was stopped without an answer (interrupt, quit,
 *    leaving the folder, a view switch that turns requests off).
 */
export type RequestCloseReason = 'final' | 'question' | 'superseded' | 'cancelled';

/**
 * @name OpenRequestState
 * @description An open request as persisted in `state.json` `openRequests`
 * (keyed by the conversation's serialized `SessionKey`). The wake-up fields are
 * owned by the wake-up engine (S4) and persisted here so a restart keeps them.
 */
export interface OpenRequestState {
  id: string;
  origin: RequestOrigin;
  /** Epoch ms the request was created. */
  createdAt: number;
  /** `progress` answers delivered so far (a `question` / `final` closes it). */
  progressAnswerCount: number;
  /** Consecutive turns that ended without any answer. */
  silentTurnCount: number;
  /** Wake-ups delivered for this request (the loop-guard cap counts these). */
  wakeCount: number;
  /** Epoch ms of the next scheduled wake-up, when one is armed. */
  nextWakeAt?: number;
  /** Epoch ms the agent was last seen working on it (the backstop counts from here). */
  lastTurnActivityAt?: number;
  /** Set once the wake-up rules gave up (alert or cap): nothing wakes it again. */
  isWakeStopped: boolean;
}

/**
 * @name OpenRequestUpdate
 * @description The fields of an open request the answer handling and the
 * wake-up engine may change.
 */
export type OpenRequestUpdate = Partial<
  Pick<
    OpenRequestState,
    'progressAnswerCount' | 'silentTurnCount' | 'wakeCount' | 'nextWakeAt' | 'lastTurnActivityAt' | 'isWakeStopped'
  >
>;

/**
 * @name ClosedRequestRecord
 * @description One line of the request history (`DATA_DIR/requests.jsonl`): the
 * request as it was when it closed, plus its conversation and why it closed.
 */
export interface ClosedRequestRecord extends OpenRequestState {
  /** The conversation's serialized `SessionKey`. */
  conversationKey: string;
  /** Epoch ms the request closed. */
  closedAt: number;
  closeReason: RequestCloseReason;
}

/**
 * @name RequestLookup
 * @description A request found by id, open or closed. A closed request is still
 * known so an answer to it can be delivered without changing any request.
 */
export type RequestLookup =
  | { isOpen: true; conversationKey: string; request: OpenRequestState }
  | { isOpen: false; conversationKey: string; request: ClosedRequestRecord };
