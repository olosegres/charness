import { keyToString, type SessionKey } from '../sessionKey';
import type { RequestLedger } from './requestLedger';
import type { OpenRequestState, RequestAlertReason, RequestWakeUpReason } from './types';
import {
  decideTurnEnd,
  decideUnwatchedRequest,
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
 * @description `deliverWakeUp` forwards the reminder into the conversation's
 * session (resuming a dead one) and resolves `false` when it could not;
 * `deliverAlert` tells a person and resolves the platform's alert handle, `null`
 * when nothing needs releasing later; `releaseAlert` undoes it (used here only
 * when the request closed while its alert was being posted — every other close
 * releases through the ledger's close callback). `now` is injectable for tests.
 */
export interface RequestWakeUpEngineDeps {
  ledger: Pick<RequestLedger, 'getOpenRequest' | 'listOpenRequests' | 'updateOpenRequest' | 'closeRequest'>;
  probeTurn: (key: SessionKey) => SessionTurnProbe;
  deliverWakeUp: (key: SessionKey, request: OpenRequestState, reason: RequestWakeUpReason) => Promise<boolean>;
  deliverAlert: (key: SessionKey, request: OpenRequestState, reason: RequestAlertReason) => Promise<string | null>;
  releaseAlert: (key: SessionKey, alertRef: string) => Promise<void>;
  backstopMs: number;
  now?: () => number;
}

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

  /** @description Start the poll and sweep timers (unref'd: they never keep the process alive). */
  start(): void {
    this.pollTimer ??= setInterval(() => { void this.pollWatchedTurns(); }, watchedTurnPollMs);
    this.sweepTimer ??= setInterval(() => { void this.sweepUnwatchedRequests(); }, unwatchedSweepMs);
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
   */
  async trackForwardedTurn(key: SessionKey, requestId: string): Promise<void> {
    const request = this.deps.ledger.getOpenRequest(key);
    if (request?.id !== requestId) return;
    this.watched.set(keyToString(key), {
      key,
      requestId,
      progressCountAtTurnStart: request.progressAnswerCount,
      hasSeenBusy: false,
      hasSeenOutput: false,
    });
    await this.recordTurnActivity(request, true);
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

  /** @description One poll over the watched turns; exported for tests (the timer calls it). */
  async pollWatchedTurns(): Promise<void> {
    if (this.isPolling) return;
    this.isPolling = true;
    try {
      for (const [keyString, turn] of [...this.watched]) {
        await this.pollWatchedTurn(keyString, turn);
      }
    } finally {
      this.isPolling = false;
    }
  }

  private async pollWatchedTurn(keyString: string, turn: WatchedConversation): Promise<void> {
    const request = this.deps.ledger.getOpenRequest(turn.key);
    if (request?.id !== turn.requestId) {
      // Answered, cancelled or superseded meanwhile — nothing left to watch.
      this.watched.delete(keyString);
      return;
    }
    const probe = this.deps.probeTurn(turn.key);
    if (probe.isBusy) turn.hasSeenBusy = true;
    const turnState = getWatchedTurnState(turn, probe);
    if (turnState === 'running') {
      if (probe.isBusy) await this.recordTurnActivity(request, false);
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
        const probe = this.deps.probeTurn(key);
        if (probe.isBusy) {
          await this.recordTurnActivity(request, false);
          continue;
        }
        await this.applyDecision(key, request, decideUnwatchedRequest(request, probe, this.now(), this.deps.backstopMs));
      }
    } finally {
      this.isSweeping = false;
    }
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
    const updated = await this.deps.ledger.updateOpenRequest(request.id, decision.update);
    // Closed or superseded while we decided: the decision belonged to the old one.
    if (!updated) return;
    if (decision.kind === 'followUpLater') return;
    if (decision.kind === 'alert') {
      await this.raiseAlert(key, updated, decision.reason);
      return;
    }
    if (await this.deps.deliverWakeUp(key, updated, decision.reason)) {
      await this.trackForwardedTurn(key, updated.id);
      return;
    }
    const stopped = await this.deps.ledger.updateOpenRequest(updated.id, { isWakeStopped: true, nextWakeAt: undefined });
    if (stopped) await this.raiseAlert(key, stopped, 'wakeFailed');
  }

  private async raiseAlert(key: SessionKey, request: OpenRequestState, reason: RequestAlertReason): Promise<void> {
    const alertRef = await this.deps.deliverAlert(key, request, reason);
    if (alertRef === null) return;
    const stored = await this.deps.ledger.updateOpenRequest(request.id, { alertRef });
    // It closed while the alert was going out: its close found no alert to release.
    if (!stored) await this.deps.releaseAlert(key, alertRef);
  }
}
