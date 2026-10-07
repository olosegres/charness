import { keyToString, type SessionKey } from '../sessionKey';
import type { RequestLedger } from './requestLedger';
import type { OpenRequestState, RequestAlertReason, RequestAnswerKind } from './types';
import { getWakeUpMessage, type WakeUpMessage } from './requestHeader';
import {
  addAnswerTailOutput,
  answerTailMaxReminders,
  buildAnswerTailReminder,
  createAnswerTail,
  decideAnswerTail,
  type AnswerTail,
} from './answerTail';
import {
  checkIsTurnInputConsumed,
  checkIsWakingStopped,
  checkIsWatchedTurnStale,
  decideTurnEnd,
  decideUnwatchedRequest,
  getPostRetryUpdate,
  getWatchedTurnState,
  type SessionTurnProbe,
  type WakeUpDecision,
  type WatchedTurn,
} from './wakeUpRules';

/**
 * @description The wake-up engine of the request/answer core (S4): it watches
 * the turn each request (or reminder) started until that turn ends — one watch
 * per REQUEST, so two requesters' open requests in one conversation are each
 * followed to their own turn end (`requestGroup.ts`) — and runs a
 * slower sweep over the open requests nobody is watching (the 15-minute
 * follow-up after a progress note, and the backstop). Every decision is made by
 * `wakeUpRules.ts`; this module only observes, persists and acts. The same sweep
 * follows the agent's text after a final answer in a view that hides the stream
 * (`answerTail.ts`), and reminds the agent once when that text is worth it.
 *
 * No adapter emits a turn-end event, so turns are POLLED through the injected
 * `probeTurn` (the precedent is the deferred-compaction poll). The watch state is
 * in memory: after a restart the persisted request times drive the sweep, and the
 * backstop covers a turn whose tracking was lost.
 *
 * A wake-up is a reminder forwarded into the SAME session — never a request.
 * The answer tails are in memory as well: a restart forgets them.
 */

/** How often a watched turn is polled for its end. */
export const watchedTurnPollMs = 10_000;
/** How often the unwatched open requests are swept (follow-ups, backstop). */
export const unwatchedSweepMs = 60_000;
/** A live turn's activity is persisted at most this often (it pushes the backstop back). */
export const turnActivityPersistStepMs = 60_000;

/**
 * @name RequestWakeUpEngineDeps
 * @description `prepareWakeUpSession` makes sure the conversation has a live
 * session for `message` (resuming a dead one) and resolves `false` when it could
 * not; `forwardWakeUp` then writes the message into it. They are two steps because
 * a resume takes seconds, and the request may be answered, cancelled or
 * superseded meanwhile — the engine re-checks in between. `deliverAlert` tells a
 * person and resolves the platform's alert handle, `null` when nothing needs
 * releasing later (the ledger stores and releases it). `now` is injectable for tests.
 */
export interface RequestWakeUpEngineDeps {
  ledger: Pick<RequestLedger, 'getOpenRequestById' | 'listOpenRequestsOf' | 'listOpenRequests' | 'updateOpenRequest' | 'closeRequest' | 'recordAlert'>;
  probeTurn: (key: SessionKey) => SessionTurnProbe;
  prepareWakeUpSession: (key: SessionKey, message: WakeUpMessage) => Promise<boolean>;
  /** Forward the wake-up's message (the request's prompt again, or a reminder) into the session. */
  forwardWakeUp: (key: SessionKey, request: OpenRequestState, message: WakeUpMessage) => Promise<void>;
  deliverAlert: (key: SessionKey, request: OpenRequestState, reason: RequestAlertReason) => Promise<string | null>;
  backstopMs: number;
  /** Whether the conversation's view hides the agent's stream: only then is a final answer's tail followed. Absent: never. */
  checkIsAnswerTailWatched?: (key: SessionKey) => boolean;
  /** Bring the session up (resume only) and forward the answer-tail reminder; `false` when it could not be reached. */
  remindAnswerTail?: (key: SessionKey, text: string) => Promise<boolean>;
  now?: () => number;
}

type WakeUpDeliveryOutcome = 'delivered' | 'failed' | 'requestGone';

interface WatchedRequestTurn extends WatchedTurn {
  key: SessionKey;
}

interface WatchedAnswerTail {
  key: SessionKey;
  tail: AnswerTail;
}

export class RequestWakeUpEngine {
  private readonly deps: RequestWakeUpEngineDeps;
  private readonly now: () => number;
  /** The watched turns by REQUEST id (a conversation may hold one per requester). */
  private readonly watched = new Map<string, WatchedRequestTurn>();
  /** Last persisted live-turn activity per request id, for the persist step. */
  private readonly activityPersistedAt = new Map<string, number>();
  /** The tail after the latest final answer, by serialized conversation key. */
  private readonly answerTails = new Map<string, WatchedAnswerTail>();
  /** The request whose tail was last reminded and how often, by serialized conversation key (the reminder cap). */
  private readonly answerTailReminders = new Map<string, { requestId: string; count: number }>();
  private pollTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private isPolling = false;
  private isSweeping = false;

  constructor(deps: RequestWakeUpEngineDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /**
   * @description Start the poll and sweep timers (unref'd: they never keep the
   * process alive). A rejected tick is logged: unhandled, it would end the whole
   * process (Node's default for an unhandled rejection).
   */
  start(): void {
    this.pollTimer ??= setInterval(() => {
      void this.pollWatchedTurns().catch((e) => logWakeUpFailure('the watched-turn poll', e));
    }, watchedTurnPollMs);
    this.sweepTimer ??= setInterval(() => {
      void this.sweepUnwatchedRequests().catch((e) => logWakeUpFailure('the open-request sweep', e));
    }, unwatchedSweepMs);
    this.pollTimer.unref?.();
    this.sweepTimer.unref?.();
  }

  /** @description Stop both timers (shutdown). The persisted request times survive. */
  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.pollTimer = null;
    this.sweepTimer = null;
  }

  /** The open request `requestId` when it belongs to `key`'s conversation, else `undefined`. */
  private getOpenRequestOf(key: SessionKey, requestId: string): OpenRequestState | undefined {
    const entry = this.deps.ledger.getOpenRequestById(requestId);
    return entry && keyToString(entry.key) === keyToString(key) ? entry.request : undefined;
  }

  /** The watched turns of `key`'s conversation. */
  private getWatchedTurnsOf(key: SessionKey): WatchedRequestTurn[] {
    const conversationKey = keyToString(key);
    return [...this.watched.values()].filter((turn) => keyToString(turn.key) === conversationKey);
  }

  /**
   * @description A request's message (or a reminder for it) was just forwarded to
   * the conversation's session: watch the turn it starts. A watch already there
   * for the SAME request is replaced — its newest message is the one that counts;
   * another requester's request in the conversation keeps its own watch. A post
   * retry still pending is moot from now on (R28): the session has the request.
   */
  async trackForwardedTurn(key: SessionKey, requestId: string, options: { isRequestPrompt: boolean } = { isRequestPrompt: false }): Promise<void> {
    const request = this.getOpenRequestOf(key, requestId);
    if (!request) return;
    // The agent works on an open request now: what it writes is owed to that one, not a tail.
    this.answerTails.delete(keyToString(key));
    this.watched.set(requestId, {
      key,
      requestId,
      progressCountAtTurnStart: request.progressAnswerCount,
      hasSeenBusy: false,
      hasSeenOutput: false,
      isRequestPrompt: options.isRequestPrompt,
    });
    if (request.nextPostRetryAt !== undefined) await this.deps.ledger.updateOpenRequest(request.id, { nextPostRetryAt: undefined });
    await this.recordTurnActivity(request, true);
  }

  /**
   * @description The request's prompt could not be posted to the session (no
   * session came up, the forward failed): try again soon (R28). Once the retries
   * are spent nothing is scheduled — the backstop and its alert take over. Never
   * rejects: its caller is a post that already failed.
   */
  async notePostFailed(key: SessionKey, requestId: string): Promise<void> {
    const request = this.getOpenRequestOf(key, requestId);
    if (!request) return;
    const retry = getPostRetryUpdate(request, this.now());
    if (!retry) return;
    try {
      await this.deps.ledger.updateOpenRequest(request.id, retry);
    } catch (e) {
      logWakeUpFailure(`scheduling a post retry of ${request.id}`, e);
    }
  }

  /** @description The agent produced output in this conversation (a turn is under way). */
  noteAgentOutput(key: SessionKey): void {
    for (const turn of this.getWatchedTurnsOf(key)) turn.hasSeenOutput = true;
  }

  /**
   * @description An answer to `requestId` was delivered. Any answer ends the
   * tail of the one before: the agent spoke to the requester. A final answer
   * starts a fresh tail where the view hides the stream, unless its request
   * already had all its reminders.
   */
  noteAnswerDelivered(key: SessionKey, requestId: string, kind: RequestAnswerKind): void {
    const conversationKey = keyToString(key);
    this.answerTails.delete(conversationKey);
    if (kind !== 'final') return;
    const reminded = this.answerTailReminders.get(conversationKey);
    if (reminded?.requestId === requestId && reminded.count >= answerTailMaxReminders) return;
    if (this.deps.checkIsAnswerTailWatched?.(key) !== true) return;
    this.answerTails.set(conversationKey, { key, tail: createAnswerTail(requestId, this.now()) });
  }

  /** @description The agent wrote text of its own in this conversation (not a sub-agent's, not a block the bot made). */
  noteAnswerTailOutput(key: SessionKey): void {
    const entry = this.answerTails.get(keyToString(key));
    if (entry) entry.tail = addAnswerTailOutput(entry.tail, this.now());
  }

  /** Drop every watch of `key`'s conversation, its answer tail included. */
  private unwatchConversation(key: SessionKey): void {
    for (const turn of this.getWatchedTurnsOf(key)) this.watched.delete(turn.requestId);
    this.answerTails.delete(keyToString(key));
  }

  /**
   * @description The person took over (interrupted, quit, restarted, switched or
   * resumed the session, left the folder): every open request of the
   * conversation closes silently and nothing wakes them.
   */
  async cancelConversation(key: SessionKey): Promise<void> {
    this.unwatchConversation(key);
    for (const request of this.deps.ledger.listOpenRequestsOf(key)) await this.deps.ledger.closeRequest(request.id, 'cancelled');
  }

  /**
   * @description The bot itself forwarded a "continue" nudge into the session (an
   * API-error retry fired, or a usage-limit wait ended): watch the turn it starts
   * as a fresh one, so the idle the error left behind is never read as its end.
   * `isCountersReset` (the end of a limit wait) starts every open request's
   * wake-up bookkeeping from zero — the wait was not the agent's silence — and
   * lifts a limit stop: the work continues, so does the waking. A request the
   * rules already gave up on stays given up. The one session turn the nudge
   * starts is watched for every open request of the conversation.
   */
  async trackContinuationTurn(key: SessionKey, options: { isCountersReset: boolean; isRequestPrompt?: boolean }): Promise<void> {
    for (const request of this.deps.ledger.listOpenRequestsOf(key)) {
      if (options.isCountersReset) {
        await this.deps.ledger.updateOpenRequest(request.id, {
          silentTurnCount: 0,
          wakeCount: 0,
          nextWakeAt: undefined,
          isLimitStopped: undefined,
          limitWaitAnsweredFor: undefined,
        });
      }
      await this.trackForwardedTurn(key, request.id, { isRequestPrompt: options.isRequestPrompt === true });
    }
  }

  /**
   * @description A usage-limit wait will not end by itself (auto-resume is off,
   * the operator skipped or disabled this resume, or the bot gave up after its
   * last attempt): nothing wakes the open request, the backstop included — a
   * reminder would only spend an attempt against the same limit — until a limit
   * wait ends with a resume or the operator's next message supersedes it. Never
   * rejects: its callers are command handlers and the error path, and a failed
   * write is logged instead.
   */
  async stopWakingForLimitWait(key: SessionKey): Promise<void> {
    this.unwatchConversation(key);
    for (const request of this.deps.ledger.listOpenRequestsOf(key)) {
      try {
        await this.deps.ledger.updateOpenRequest(request.id, { isLimitStopped: true, nextWakeAt: undefined });
      } catch (e) {
        logWakeUpFailure(`stopping the wake-ups of ${request.id}`, e);
      }
    }
  }

  /** @description One poll over the watched turns; exported for tests (the timer calls it). */
  async pollWatchedTurns(): Promise<void> {
    if (this.isPolling) return;
    this.isPolling = true;
    try {
      for (const turn of [...this.watched.values()]) {
        // One request's failure must not stop the others from being polled.
        await this.pollWatchedTurn(turn).catch((e) => logWakeUpFailure(`polling ${turn.requestId}`, e));
      }
    } finally {
      this.isPolling = false;
    }
  }

  private async pollWatchedTurn(turn: WatchedRequestTurn): Promise<void> {
    // Replaced or dropped since this poll took its snapshot: the newer watch (if any) decides.
    if (this.watched.get(turn.requestId) !== turn) return;
    const request = this.getOpenRequestOf(turn.key, turn.requestId);
    if (!request) {
      // Answered, cancelled or superseded meanwhile — nothing left to watch.
      this.watched.delete(turn.requestId);
      return;
    }
    const probe = this.deps.probeTurn(turn.key);
    if (probe.isBusy) turn.hasSeenBusy = true;
    if (turn.isRequestPrompt && request.isPromptTakenIn !== true && probe.isActive && checkIsTurnInputConsumed(turn, probe)) {
      // R21: from now on a wake-up is a reminder — the agent has read the request.
      await this.deps.ledger.updateOpenRequest(request.id, { isPromptTakenIn: true });
    }
    const turnState = getWatchedTurnState(turn, probe);
    if (turnState === 'running') {
      if (probe.isBusy) await this.recordTurnActivity(request, false);
      // Its end can no longer be seen: the sweep's backstop takes the request over.
      else if (checkIsWatchedTurnStale(request, probe, this.now(), this.deps.backstopMs)) this.watched.delete(turn.requestId);
      return;
    }
    this.watched.delete(turn.requestId);
    // A dead session is not a turn end: the backstop resumes it later.
    if (turnState === 'sessionGone') return;
    await this.applyDecision(turn.key, request, decideTurnEnd(request, turn.progressCountAtTurnStart, this.now()));
  }

  /** @description One sweep over the open requests nobody watches; exported for tests. */
  async sweepUnwatchedRequests(): Promise<void> {
    if (this.isSweeping) return;
    this.isSweeping = true;
    try {
      const openRequests = this.deps.ledger.listOpenRequests();
      const openIds = new Set(openRequests.map(({ request }) => request.id));
      for (const requestId of [...this.activityPersistedAt.keys()]) {
        if (!openIds.has(requestId)) this.activityPersistedAt.delete(requestId);
      }
      for (const { key, request } of openRequests) {
        if (this.watched.has(request.id)) continue;
        // One conversation's failure must not stop the others from being swept.
        await this.sweepOpenRequest(key, request).catch((e) => logWakeUpFailure(`sweeping ${keyToString(key)}`, e));
      }
      for (const [conversationKey, entry] of [...this.answerTails]) {
        await this.sweepAnswerTail(conversationKey, entry).catch((e) => logWakeUpFailure(`the answer tail of ${conversationKey}`, e));
      }
    } finally {
      this.isSweeping = false;
    }
  }

  private async sweepOpenRequest(key: SessionKey, request: OpenRequestState): Promise<void> {
    const probe = this.deps.probeTurn(key);
    if (probe.isBusy) {
      await this.recordTurnActivity(request, false);
      return;
    }
    await this.applyDecision(key, request, decideUnwatchedRequest(request, probe, this.now(), this.deps.backstopMs));
  }

  private async sweepAnswerTail(conversationKey: string, entry: WatchedAnswerTail): Promise<void> {
    if (this.answerTails.get(conversationKey) !== entry) return;
    if (this.deps.checkIsAnswerTailWatched?.(entry.key) !== true || this.deps.ledger.listOpenRequestsOf(entry.key).length > 0) {
      // The stream is shown again, or a newer request is open and its own answer is owed.
      this.answerTails.delete(conversationKey);
      return;
    }
    const decision = decideAnswerTail(entry.tail, this.deps.probeTurn(entry.key), this.now());
    if (decision === 'wait') return;
    this.answerTails.delete(conversationKey);
    if (decision === 'drop') return;
    const { requestId } = entry.tail;
    const reminded = this.answerTailReminders.get(conversationKey);
    this.answerTailReminders.set(conversationKey, { requestId, count: reminded?.requestId === requestId ? reminded.count + 1 : 1 });
    const isDelivered = (await this.deps.remindAnswerTail?.(entry.key, buildAnswerTailReminder(requestId))) ?? false;
    console.log(`[requests] answer-tail reminder for ${requestId} ${isDelivered ? 'forwarded' : 'NOT delivered (the session could not be reached)'}`);
  }

  /** Persist that the agent is working on it, at most once per step unless forced. */
  private async recordTurnActivity(request: OpenRequestState, isForced: boolean): Promise<void> {
    const nowMs = this.now();
    const persistedAt = this.activityPersistedAt.get(request.id);
    if (!isForced && persistedAt !== undefined && nowMs - persistedAt < turnActivityPersistStepMs) return;
    this.activityPersistedAt.set(request.id, nowMs);
    await this.deps.ledger.updateOpenRequest(request.id, { lastTurnActivityAt: nowMs });
  }

  private async applyDecision(key: SessionKey, request: OpenRequestState, decision: WakeUpDecision): Promise<void> {
    if (decision.kind === 'none') return;
    let isStoppedMeanwhile = false;
    const updated = await this.deps.ledger.updateOpenRequest(request.id, (current) => {
      // `request` is a snapshot: a limit wait may have stopped the wake-ups since (no alert either).
      isStoppedMeanwhile = checkIsWakingStopped(current);
      return isStoppedMeanwhile ? {} : decision.update;
    });
    // Closed or superseded while we decided: the decision belonged to the old one.
    if (!updated || isStoppedMeanwhile) return;
    if (decision.kind === 'followUpLater') return;
    if (decision.kind === 'alert') {
      await this.raiseAlert(key, updated, decision.reason);
      return;
    }
    const message = getWakeUpMessage(updated, decision.reason);
    const outcome = await this.deliverWakeUpSafely(key, updated, message);
    if (outcome === 'delivered') {
      await this.trackForwardedTurn(key, updated.id, { isRequestPrompt: message.isRequestPrompt });
      return;
    }
    if (outcome === 'requestGone') return;
    if (decision.reason === 'postRetry') {
      // R28: a retry that failed again tries later; once spent, the backstop decides — no alert yet.
      const retry = getPostRetryUpdate(updated, this.now());
      if (retry) await this.deps.ledger.updateOpenRequest(updated.id, retry);
      return;
    }
    const stopped = await this.deps.ledger.updateOpenRequest(updated.id, { isWakeStopped: true, nextWakeAt: undefined });
    if (stopped) await this.raiseAlert(key, stopped, 'wakeFailed');
  }

  /**
   * Resume the session if needed, re-check the request, forward the reminder. A
   * step that threw did not reach the session: same as one that could not.
   */
  private async deliverWakeUpSafely(
    key: SessionKey,
    request: OpenRequestState,
    message: WakeUpMessage,
  ): Promise<WakeUpDeliveryOutcome> {
    try {
      if (!(await this.deps.prepareWakeUpSession(key, message))) return 'failed';
      // The resume took a while: a reminder for a request that closed, was replaced
      // or stopped being woken meanwhile is stale.
      const current = this.getOpenRequestOf(key, request.id);
      if (!current || checkIsWakingStopped(current)) return 'requestGone';
      await this.deps.forwardWakeUp(key, request, message);
      return 'delivered';
    } catch (e) {
      logWakeUpFailure(`delivering the reminder for ${request.id}`, e);
      return 'failed';
    }
  }

  private async raiseAlert(key: SessionKey, request: OpenRequestState, reason: RequestAlertReason): Promise<void> {
    const alertRef = await this.deps.deliverAlert(key, request, reason);
    if (alertRef !== null) await this.deps.ledger.recordAlert(key, request.id, alertRef);
  }
}

/** Log a wake-up step that failed; the engine keeps running for every other request. */
function logWakeUpFailure(step: string, error: unknown): void {
  console.warn(`[requests] ${step} failed:`, error instanceof Error ? error.message : error);
}
