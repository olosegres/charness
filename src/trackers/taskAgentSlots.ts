import { keyToString, tryKeyFromString, type PlatformId, type SessionKey } from '../sessionKey';
import type { RequestLedger } from '../requests/requestLedger';
import type { ClosedRequestRecord, OpenRequestState, RequestOriginKind } from '../requests/types';
import type { StateStore } from '../state';
import { checkIsTaskAgentLimitRaised, taskAgentsNoLimit } from './taskAgentLimit';
import type { TaskAgentWaitEntry } from './types';

/**
 * @description The slots of the tracker task agents (decision D10): ONE cap for the whole bot on how many tracker
 * conversations are working on a hand-over at once, and ONE persisted FIFO list of those that wait for a slot. The cap
 * itself is `taskAgentLimit.ts`; this module is the bookkeeping behind it.
 *
 * A slot is a tracker CONVERSATION with an OPEN hand-over request (origin `trackerEvent`) — one agent, however many people's
 * hand-overs it holds at once; a mention request (answer only) never takes one. The slots in use are read off the request
 * ledger on every question, so nothing about them is stored: a request that closes — an answer, a cancel — frees its slot at
 * once, and a restart cannot get the count wrong. A request the wake-up engine gave up on (`isWakeStopped`: the alert is out
 * and the issue handed back) is not an agent at work and holds no slot either.
 *
 * A connector asks {@link TaskAgentSlots.checkIn} before it opens a hand-over request. `granted` — it may open it now, and the
 * slot is RESERVED until the connector says the request is open ({@link TaskAgentSlots.noteStarted}) or gave up
 * ({@link TaskAgentSlots.noteStartFailed}), so two connectors polling at once never share the last free slot. `queued` — no
 * slot is free (or someone waits ahead): the conversation joins the list, oldest first, and asks again at its next poll. It is
 * granted only when it is within the free slots counted from the HEAD of the list, so the order of the list is the order of
 * the starts, whatever order a poll happens to return the issues in.
 *
 * A place whose last start FAILED (the issue could not be fetched, the folder not bound) does not count as ahead of the places
 * behind it, so one broken issue never holds the others up; after {@link taskAgentStartFailureLimit} failed starts in a row it
 * moves to the end of the list.
 */

/** The request origin that holds a slot. */
const slotHoldingOriginKind: RequestOriginKind = 'trackerEvent';

/** How many starts of one waiting issue may fail in a row before it moves to the end of the wait list. */
export const taskAgentStartFailureLimit = 3;

/**
 * @name TaskAgentSlotDecision
 * @description `granted` — open the request. `queued` — wait: `isNewlyQueued` is true the first time the conversation joins
 * the list (the moment to say so), `aheadCount` how many conversations were in front of it, `maxConcurrent` the cap that held it.
 */
export type TaskAgentSlotDecision =
  | { kind: 'granted' }
  | { kind: 'queued'; isNewlyQueued: boolean; aheadCount: number; maxConcurrent: number };

/** What the screen and the logs say of the slots right now. */
export interface TaskAgentSlotStatus {
  /** The cap in force; `0` = no limit. */
  maxConcurrent: number;
  /** Tracker conversations working on a hand-over. */
  runningCount: number;
  /** Tracker conversations waiting for a slot. */
  waitingCount: number;
}

export interface TaskAgentSlotsDeps {
  /** The cap in force, read at every question (`taskAgentLimit.ts`); `0` = no limit. */
  getMaxConcurrent: () => number;
  ledger: Pick<RequestLedger, 'listOpenRequests'>;
  /** Where the wait list lives (`state.json`). */
  store: Pick<StateStore, 'getTaskAgentWaitList' | 'setTaskAgentWaitList' | 'flush'>;
  now?: () => number;
}

export class TaskAgentSlots {
  private readonly now: () => number;
  /** Conversations a `granted` answer was given to and whose request is not open yet; memory only. */
  private readonly reservedConversationKeys = new Set<string>();
  /** Per waiting conversation, how many starts failed in a row (absent = none); memory only, so a restart gives every place a fresh start. */
  private readonly failedStartCounts = new Map<string, number>();
  /** The cap as the last read saw it; `null` before the first read. */
  private lastReadMaxConcurrent: number | null = null;
  private readonly slotFreedListeners = new Set<() => void>();

  constructor(private readonly deps: TaskAgentSlotsDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** The conversations that hold a slot now: an open, not given-up hand-over request, or a reservation. */
  private getOccupiedConversationKeys(): Set<string> {
    const occupied = new Set(this.reservedConversationKeys);
    for (const { key, request } of this.deps.ledger.listOpenRequests()) {
      if (request.origin.kind === slotHoldingOriginKind && !request.isWakeStopped) occupied.add(keyToString(key));
    }
    return occupied;
  }

  /** The wait list without the conversations that hold a slot already (a start whose entry was not dropped yet). */
  private getWaitingEntries(occupied: ReadonlySet<string>): TaskAgentWaitEntry[] {
    return this.deps.store.getTaskAgentWaitList().filter((entry) => !occupied.has(entry.conversationKey));
  }

  /**
   * @description May `key`'s conversation open a hand-over request now? `triggerId` names the hand-over for the logs. A
   * conversation that holds a slot already — a newer hand-over of the same issue supersedes its open request — needs no new one.
   * A `queued` answer that changes the list (a new place, a newer trigger) saves it, flushed: a restart right after keeps the place.
   */
  async checkIn(key: SessionKey, triggerId: string): Promise<TaskAgentSlotDecision> {
    const conversationKey = keyToString(key);
    // A check-in is made by the poll that deals with every waiting issue, so a raised cap needs no wake-up here.
    const maxConcurrent = this.readMaxConcurrent(false);
    const occupied = this.getOccupiedConversationKeys();
    const waiting = this.getWaitingEntries(occupied);
    const ownIndex = waiting.findIndex((entry) => entry.conversationKey === conversationKey);
    const placesAhead = ownIndex === -1 ? waiting : waiting.slice(0, ownIndex);
    // A place whose last start failed does not hold up the ones behind it.
    const position = placesAhead.filter((entry) => !this.failedStartCounts.has(entry.conversationKey)).length;
    const freeCount = maxConcurrent === taskAgentsNoLimit ? Number.POSITIVE_INFINITY : maxConcurrent - occupied.size;
    if (occupied.has(conversationKey) || position < freeCount) {
      this.reservedConversationKeys.add(conversationKey);
      return { kind: 'granted' };
    }
    const isNewlyQueued = ownIndex === -1;
    let isListChanged = isNewlyQueued;
    if (isNewlyQueued) {
      waiting.push({ conversationKey, triggerId, queuedAt: this.now() });
    } else if (waiting[ownIndex].triggerId !== triggerId) {
      // A newer hand-over of the issue replaces the waiting one and keeps its place.
      waiting[ownIndex] = { ...waiting[ownIndex], triggerId };
      isListChanged = true;
    }
    // Every poll asks again for a waiting issue: only a change is written.
    if (isListChanged) {
      this.deps.store.setTaskAgentWaitList(waiting);
      await this.deps.store.flush();
    }
    return { kind: 'queued', isNewlyQueued, aheadCount: position, maxConcurrent };
  }

  /** @description The granted conversation's request is open (and counted by the ledger now): drop the reservation and its place in the list. */
  noteStarted(key: SessionKey): void {
    const conversationKey = keyToString(key);
    this.reservedConversationKeys.delete(conversationKey);
    this.removeWaiting((entry) => entry.conversationKey === conversationKey);
  }

  /**
   * @description The granted conversation could not open its request: the slot goes back and a place in the list (if any) stays, but
   * the place no longer holds up the ones behind it. The {@link taskAgentStartFailureLimit}th failure in a row moves it to the end
   * of the list (logged once) and gives it a fresh start there. A conversation with no place has nothing to move: it asks again at its next poll.
   */
  noteStartFailed(key: SessionKey): void {
    const conversationKey = keyToString(key);
    this.reservedConversationKeys.delete(conversationKey);
    const waitList = this.deps.store.getTaskAgentWaitList();
    const place = waitList.find((entry) => entry.conversationKey === conversationKey);
    if (!place) return;
    const failedCount = (this.failedStartCounts.get(conversationKey) ?? 0) + 1;
    if (failedCount < taskAgentStartFailureLimit) {
      this.failedStartCounts.set(conversationKey, failedCount);
      return;
    }
    this.failedStartCounts.delete(conversationKey);
    this.deps.store.setTaskAgentWaitList([...waitList.filter((entry) => entry !== place), place]);
    console.warn(`[tasks] ${conversationKey} failed to start ${taskAgentStartFailureLimit} times in a row; it moves to the end of the wait list`);
  }

  /** @description The conversation no longer waits (its hand-over was withdrawn, refused or handled another way): drop its place. */
  dropWaiting(key: SessionKey): void {
    const conversationKey = keyToString(key);
    this.removeWaiting((entry) => entry.conversationKey === conversationKey);
  }

  /**
   * @description Drop the places of `platform`'s conversations that `checkIsStillWaiting` no longer vouches for — a connector's
   * poll calls it after a complete poll with what it found (an issue that left the hand-over statuses is no longer waiting).
   */
  pruneWaiting(platform: PlatformId, checkIsStillWaiting: (key: SessionKey) => boolean): void {
    this.removeWaiting((entry) => {
      const key = tryKeyFromString(entry.conversationKey);
      return key !== null && key.platform === platform && !checkIsStillWaiting(key);
    });
  }

  /** @description Drop the places of conversations nobody in this process serves any more (a connector taken out of `CONNECTORS`): they could never start and would hold up the others. */
  dropUnserved(checkIsServed: (key: SessionKey) => boolean): void {
    this.removeWaiting((entry) => {
      const key = tryKeyFromString(entry.conversationKey);
      return key === null || !checkIsServed(key);
    });
  }

  private removeWaiting(checkIsRemoved: (entry: TaskAgentWaitEntry) => boolean): void {
    const waitList = this.deps.store.getTaskAgentWaitList();
    const kept = waitList.filter((entry) => !checkIsRemoved(entry));
    if (kept.length === waitList.length) return;
    for (const entry of waitList) {
      if (checkIsRemoved(entry)) this.failedStartCounts.delete(entry.conversationKey);
    }
    this.deps.store.setTaskAgentWaitList(kept);
  }

  /**
   * @description The cap, the conversations working and the conversations waiting. Reading the cap here notices a raise like any read
   * outside a poll (see {@link TaskAgentSlots.noteLimitMayHaveChanged}).
   */
  getStatus(): TaskAgentSlotStatus {
    const maxConcurrent = this.readMaxConcurrent(true);
    const occupied = this.getOccupiedConversationKeys();
    return { maxConcurrent, runningCount: occupied.size, waitingCount: this.getWaitingEntries(occupied).length };
  }

  /**
   * The cap in force. `isWakingOnRaise`: when it went up since the last read and somebody waits, the listeners are woken — a raise
   * is room for the waiting issues, found by whoever reads it first (the `/task_agents` screen, a hand edit of `settings.json`).
   */
  private readMaxConcurrent(isWakingOnRaise: boolean): number {
    const maxConcurrent = this.deps.getMaxConcurrent();
    const previous = this.lastReadMaxConcurrent;
    this.lastReadMaxConcurrent = maxConcurrent;
    if (isWakingOnRaise && previous !== null && checkIsTaskAgentLimitRaised(previous, maxConcurrent)) this.wakeListenersWhileWaiting();
    return maxConcurrent;
  }

  /**
   * @description The cap may have changed — General's value was just written: read it, and wake the listeners when it went up while
   * somebody waits. A hand edit of `settings.json` is noticed the same way, by the first read that is not a poll's own check-in.
   */
  noteLimitMayHaveChanged(): void {
    this.readMaxConcurrent(true);
  }

  /**
   * @description Be told when a slot may have freed while someone waits for one (a connector polls again at once, instead of at
   * its next interval). Returns the function that stops the listening.
   */
  onSlotFreed(listener: () => void): () => void {
    this.slotFreedListeners.add(listener);
    return () => {
      this.slotFreedListeners.delete(listener);
    };
  }

  /**
   * @description The request ledger's word that a request closed: a hand-over that is not merely replaced by a newer one of its
   * conversation may have freed a slot, which wakes the listeners — only while somebody waits. It runs inside the ledger's own
   * close, so the listeners get the news, not the state: they act after the close completed.
   */
  noteRequestClosed(closed: ClosedRequestRecord): void {
    if (closed.origin.kind !== slotHoldingOriginKind || closed.closeReason === 'superseded') return;
    this.wakeListenersWhileWaiting();
  }

  /**
   * @description The request ledger's word that the wake-up engine gave up on a request (it stays open, but holds no slot any more):
   * the same wake-up as a close.
   */
  noteRequestWakeStopped(request: Pick<OpenRequestState, 'origin'>): void {
    if (request.origin.kind !== slotHoldingOriginKind) return;
    this.wakeListenersWhileWaiting();
  }

  private wakeListenersWhileWaiting(): void {
    if (this.deps.store.getTaskAgentWaitList().length === 0) return;
    for (const listener of this.slotFreedListeners) {
      try {
        listener();
      } catch (error) {
        console.warn(`[tasks] a slot listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
