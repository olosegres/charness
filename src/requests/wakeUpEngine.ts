import { keyToString, type SessionKey } from '../sessionKey';
import type { RequestLedger } from './requestLedger';
import type { OpenRequestState, RequestAlertReason } from './types';
import { getWakeUpMessage, type WakeUpMessage } from './requestHeader';
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
 * the turn each request (or reminder) started until that turn ends, and runs a
 * slower sweep over the open requests nobody is watching (the 15-minute
 * follow-up after a progress note, and the backstop). Every decision is made by
 * `wakeUpRules.ts`; this module only observes, persists and acts.
 *
 * No adapter emits a turn-end event, so turns are POLLED through the injected
 * `probeTurn` (the precedent is the deferred-compaction poll). The watch state is
 * in memory: after a restart the persisted request times drive the sweep, and the
 * backstop covers a turn whose tracking was lost.
 *
 * A wake-up is a reminder forwarded into the SAME session — never a request.
 */

/** How often a watched turn is polled for its end. */
export const watchedTurnPollMs = 3_000;
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
  ledger: Pick<RequestLedger, 'getOpenRequest' | 'listOpenRequests' | 'updateOpenRequest' | 'closeRequest' | 'recordAlert'>;
  probeTurn: (key: SessionKey) => SessionTurnProbe;
  prepareWakeUpSession: (key: SessionKey, message: WakeUpMessage) => Promise<boolean>;
  /** Forward the wake-up's message (the request's prompt again, or a reminder) into the session. */
  forwardWakeUp: (key: SessionKey, request: OpenRequestState, message: WakeUpMessage) => Promise<void>;
  deliverAlert: (key: SessionKey, request: OpenRequestState, reason: RequestAlertReason) => Promise<string | null>;
  backstopMs: number;
  now?: () => number;
}

type WakeUpDeliveryOutcome = 'delivered' | 'failed' | 'requestGone';

interface WatchedConversation extends WatchedTurn {
  key: SessionKey;
}

export class RequestWakeUpEngine {
  private readonly deps: RequestWakeUpEngineDeps;
  private readonly now: () => number;
  private readonly watched = new Map<string, WatchedConversation>();
  /** Last persisted live-turn activity per request id, for the persist step. */
  private readonly activityPersistedAt = new Map<string, number>();
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

  /**
   * @description A request's message (or a reminder for it) was just forwarded to
   * the conversation's session: watch the turn it starts. A watch already there
   * for the conversation is replaced — the newest message is the one that counts.
   * A post retry still pending is moot from now on (R28): the session has the request.
   */
  async trackForwardedTurn(key: SessionKey, requestId: string, options: { isRequestPrompt: boolean } = { isRequestPrompt: false }): Promise<void> {
    const request = this.deps.ledger.getOpenRequest(key);
    if (request?.id !== requestId) return;
    this.watched.set(keyToString(key), {
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
    const request = this.deps.ledger.getOpenRequest(key);
    if (request?.id !== requestId) return;
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
    const turn = this.watched.get(keyToString(key));
    if (turn) turn.hasSeenOutput = true;
  }

  /**
   * @description The person took over (interrupted, quit, restarted, switched or
   * resumed the session, left the folder): the open request closes silently and
   * nothing wakes it.
   */
  async cancelConversation(key: SessionKey): Promise<void> {
    this.watched.delete(keyToString(key));
    const request = this.deps.ledger.getOpenRequest(key);
    if (request) await this.deps.ledger.closeRequest(request.id, 'cancelled');
  }

  /**
   * @description The bot itself forwarded a "continue" nudge into the session (an
   * API-error retry fired, or a usage-limit wait ended): watch the turn it starts
   * as a fresh one, so the idle the error left behind is never read as its end.
   * `isCountersReset` (the end of a limit wait) starts the open request's
   * wake-up bookkeeping from zero — the wait was not the agent's silence — and
   * lifts a limit stop: the work continues, so does the waking. A request the
   * rules already gave up on stays given up.
   */
  async trackContinuationTurn(key: SessionKey, options: { isCountersReset: boolean; isRequestPrompt?: boolean }): Promise<void> {
    const request = this.deps.ledger.getOpenRequest(key);
    if (!request) return;
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
    this.watched.delete(keyToString(key));
    const request = this.deps.ledger.getOpenRequest(key);
    if (!request) return;
    try {
      await this.deps.ledger.updateOpenRequest(request.id, { isLimitStopped: true, nextWakeAt: undefined });
    } catch (e) {
      logWakeUpFailure(`stopping the wake-ups of ${request.id}`, e);
    }
  }

  /** @description One poll over the watched turns; exported for tests (the timer calls it). */
  async pollWatchedTurns(): Promise<void> {
    if (this.isPolling) return;
    this.isPolling = true;
    try {
      for (const [keyString, turn] of [...this.watched]) {
        // One conversation's failure must not stop the others from being polled.
        await this.pollWatchedTurn(keyString, turn).catch((e) => logWakeUpFailure(`polling ${keyString}`, e));
      }
    } finally {
      this.isPolling = false;
    }
  }

  private async pollWatchedTurn(keyString: string, turn: WatchedConversation): Promise<void> {
    // Replaced or dropped since this poll took its snapshot: the newer watch (if any) decides.
    if (this.watched.get(keyString) !== turn) return;
    const request = this.deps.ledger.getOpenRequest(turn.key);
    if (request?.id !== turn.requestId) {
      // Answered, cancelled or superseded meanwhile — nothing left to watch.
      this.watched.delete(keyString);
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
      else if (checkIsWatchedTurnStale(request, probe, this.now(), this.deps.backstopMs)) this.watched.delete(keyString);
      return;
    }
    this.watched.delete(keyString);
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
        if (this.watched.has(keyToString(key))) continue;
        // One conversation's failure must not stop the others from being swept.
        await this.sweepOpenRequest(key, request).catch((e) => logWakeUpFailure(`sweeping ${keyToString(key)}`, e));
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
      const current = this.deps.ledger.getOpenRequest(key);
      if (current?.id !== request.id || checkIsWakingStopped(current)) return 'requestGone';
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
