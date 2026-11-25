/**
 * @description Shapes of the request ledger (core plan S2). A REQUEST is one unit
 * of work the agent owes an answer to — an operator message, a scheduled run, a
 * tracker event. At most one request per REQUEST GROUP (conversation + requester,
 * `requestGroup.ts`) is OPEN; a closed one moves to the append-only history.
 */

/**
 * @name RequestOriginKind
 * @description What raised a request, for the agent-facing header and the logs.
 *  - `message`      — a person wrote in the conversation.
 *  - `scheduledRun` — a scheduled prompt fired.
 *  - `trackerEvent` — a tracker connector picked an issue up (e.g. an assignment).
 *  - `trackerMention` — a tracker connector was mentioned in a comment of an issue that is NOT handed to it: the
 *    request asks for an answer only, and nothing is handed over or back.
 */
export type RequestOriginKind = 'message' | 'scheduledRun' | 'trackerEvent' | 'trackerMention';

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
 *  - `superseded` — a newer request of the same group (same conversation, same
 *    requester) arrived; the answer to that one covers what this one asked
 *    (or, when this one was answered first, only what the newer one adds).
 *  - `cancelled`  — the work was stopped without an answer (interrupt, quit,
 *    leaving the folder, a view switch that turns requests off).
 */
export type RequestCloseReason = 'final' | 'question' | 'superseded' | 'cancelled';

/**
 * @name RequestPromptOutcome
 * @description What became of a request's prompt (Jira prompt context C4).
 *  - `takenIn` — the agent took it in: `isPromptTakenIn` was set, or the request
 *    was closed by its own `question` / `final` answer.
 *  - `dropped` — the request closed otherwise (superseded, cancelled) before that.
 */
export type RequestPromptOutcome = 'takenIn' | 'dropped';

/**
 * @name OpenRequestState
 * @description An open request as persisted in `state.json` `openRequests`
 * (keyed by its serialized request group, `requestGroup.ts`). The wake-up fields are
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
  /** Wake-ups delivered since the agent last answered one with a progress note (the loop-guard cap counts these). */
  wakeCount: number;
  /**
   * A tracker's rules only (`wakeUpRules.ts` `WakeUpRuleSet`): the turn ends in a row that left the request open with nothing armed to
   * wake the agent — a progress note with no job armed under it, or a silent turn. The first gets the nudge (`nothingArmed`), the second
   * gives the request up. A delivered answer does not reset it (a note changes nothing about what wakes the agent); a turn end the
   * request's schedule holds does, and so do a person's words forwarded for the request and the end of a limit wait. Absent = 0.
   */
  stalledTurnCount?: number;
  /** Epoch ms of the next scheduled wake-up, when one is armed. */
  nextWakeAt?: number;
  /** Epoch ms the agent was last seen working on it (the backstop counts from here). */
  lastTurnActivityAt?: number;
  /** Set once the wake-up rules gave up (alert or cap): nothing wakes it again. */
  isWakeStopped: boolean;
  /**
   * The request's own prompt, kept so a request whose prompt never reached the
   * agent — its post failed, a restart came first, a usage-limit wait held it —
   * gets the prompt again on its next wake-up instead of a bare reminder (Jira
   * plan R21). Absent when the request was opened without one, or it was over
   * `requestPromptMaxLength`.
   */
  prompt?: string;
  /** Set once a turn that carried `prompt` was seen taken in by the session. */
  isPromptTakenIn?: boolean;
  /** Post retries scheduled so far after the prompt's post failed (R28); absent = none. */
  postRetryCount?: number;
  /** Epoch ms of the next post retry, while one is due (R28). */
  nextPostRetryAt?: number;
  /**
   * Set while a usage-limit wait will not end by itself (auto-resume off, the
   * operator skipped or disabled the resume, the bot gave up its attempts):
   * nothing wakes the request, as with `isWakeStopped`, but this one is LIFTED
   * when a limit wait later ends with a resume. Absent = not stopped.
   */
  isLimitStopped?: boolean;
  /**
   * A person's words reached the agent after the request's last answer (an issue update, a re-posted prompt) and nothing was
   * answered yet. Persisted, because the engine's watches are in memory: a request that waits for its schedule is held between
   * turns only while it owes nobody an answer (`checkIsAnswerOwed`), so a turn whose watch was lost (a restart, a dead process)
   * still reaches the backstop. Cleared when an answer is delivered. Absent = none owed beyond the ones the other fields show.
   */
  isPersonInputUnanswered?: boolean;
  /**
   * Which limit wait the bot already answered this request about (see
   * `getUsageLimitWaitIdentity`), so each request hears about each wait once.
   */
  limitWaitAnsweredFor?: string;
  /**
   * The platform's handle on the alert posted when the wake-up rules gave up
   * (Telegram: the pinned message id), so the alert is released when the
   * request closes. Opaque to the core.
   */
  alertRef?: string;
  /**
   * The still-open requests of the same group this one replaced when it was
   * created — the one open at the time and, through it, the ones that one had
   * replaced (oldest first, bounded by `supersededRequestIdsMaxLength`). The
   * header names them so the agent gives ONE answer covering them all. Absent
   * when nothing was replaced.
   */
  supersededRequestIds?: string[];
}

/**
 * @name OpenRequestUpdate
 * @description The fields of an open request the answer handling and the
 * wake-up engine may change.
 */
export type OpenRequestUpdate = Partial<
  Pick<
    OpenRequestState,
    | 'progressAnswerCount'
    | 'silentTurnCount'
    | 'wakeCount'
    | 'stalledTurnCount'
    | 'nextWakeAt'
    | 'lastTurnActivityAt'
    | 'isWakeStopped'
    | 'isLimitStopped'
    | 'isPersonInputUnanswered'
    | 'limitWaitAnsweredFor'
    | 'alertRef'
    | 'isPromptTakenIn'
    | 'postRetryCount'
    | 'nextPostRetryAt'
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
  /** For `superseded`: the id of the request that replaced it (an answer to it covers this one). */
  supersededBy?: string;
}

/**
 * @name RequestLookup
 * @description A request found by id, open or closed. A closed request is still
 * known so an answer to it can be delivered without changing any request.
 */
export type RequestLookup =
  | { isOpen: true; conversationKey: string; request: OpenRequestState }
  | { isOpen: false; conversationKey: string; request: ClosedRequestRecord };

/**
 * @name RequestAnswerKind
 * @description What an `answer_request` call is.
 *  - `progress` — an interim note; the request stays open.
 *  - `question` — the agent needs the requester; closes the request (their reply
 *    is a new request).
 *  - `final`    — the result; closes the request.
 */
export type RequestAnswerKind = 'progress' | 'question' | 'final';

/**
 * @name RequestWakeUpReason
 * @description Why the agent is reminded of an open request.
 *  - `silentTurn` — its turn ended without any answer.
 *  - `progressFollowUp` — it sent a progress note and the follow-up delay passed (a topic's rules).
 *  - `nothingArmed` — a tracker's rules: its turn ended with a progress note while nothing is armed to wake it (no job under the
 *    request): the one nudge, sent at once, in place of a follow-up on a clock.
 *  - `backstop` — nothing was seen working on it for the backstop window (a dead
 *    process, or tracking lost across a restart).
 *  - `postRetry` — the request's prompt could not be posted; tried again soon
 *    (Jira plan R28).
 *  - `restarted` — a tracker conversation's process was found gone (the bot came
 *    back without it, or it died with its own work pending) while the request was
 *    open: woken at once instead of at the backstop.
 */
export type RequestWakeUpReason = 'silentTurn' | 'progressFollowUp' | 'nothingArmed' | 'backstop' | 'postRetry' | 'restarted';

/**
 * @name RequestAlertReason
 * @description Why the wake-up rules gave up and a person is told.
 *  - `silentTurns` — the agent ended turns without answering twice in a row (a tracker's rules: or left the request open with
 *    nothing armed to wake it twice in a row, the nudge between them, progress notes or not).
 *  - `wakeCap` — the request used up its wake-ups (the loop guard).
 *  - `wakeFailed` — the session could not be reached to deliver a reminder.
 */
export type RequestAlertReason = 'silentTurns' | 'wakeCap' | 'wakeFailed';

/**
 * @name UnreleasedRequestAlert
 * @description The alert of a closed request that still has to be released: its
 * conversation (serialized key) and the platform's alert handle.
 */
export interface UnreleasedRequestAlert {
  conversationKey: string;
  alertRef: string;
}
