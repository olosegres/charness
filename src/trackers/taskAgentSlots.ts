import { keyToString, tryKeyFromString, type PlatformId, type SessionKey } from '../sessionKey';
import type { RequestLedger } from '../requests/requestLedger';
import type { ClosedRequestRecord, RequestOriginKind } from '../requests/types';
import type { StateStore } from '../state';
import { taskAgentsNoLimit } from './taskAgentLimit';
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
 * ({@link TaskAgentSlots.releaseReservation}), so two connectors polling at once never share the last free slot. `queued` — no
 * slot is free (or someone waits ahead): the conversation joins the list, oldest first, and asks again at its next poll. It is
 * granted only when it is within the free slots counted from the HEAD of the list, so the order of the list is the order of
 * the starts, whatever order a poll happens to return the issues in.
 */

/** The request origin that holds a slot. */
const slotHoldingOriginKind: RequestOriginKind = 'trackerEvent';

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
    const maxConcurrent = this.deps.getMaxConcurrent();
    const occupied = this.getOccupiedConversationKeys();
    const waiting = this.getWaitingEntries(occupied);
    const ownIndex = waiting.findIndex((entry) => entry.conversationKey === conversationKey);
    const position = ownIndex === -1 ? waiting.length : ownIndex;
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

  /** @description The granted conversation could not open its request: the slot goes back, its place in the list (if any) stays. */
  releaseReservation(key: SessionKey): void {
    this.reservedConversationKeys.delete(keyToString(key));
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
    if (kept.length !== waitList.length) this.deps.store.setTaskAgentWaitList(kept);
  }

  /** @description The cap, the conversations working and the conversations waiting. */
  getStatus(): TaskAgentSlotStatus {
    const occupied = this.getOccupiedConversationKeys();
    return { maxConcurrent: this.deps.getMaxConcurrent(), runningCount: occupied.size, waitingCount: this.getWaitingEntries(occupied).length };
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
