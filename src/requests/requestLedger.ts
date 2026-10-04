import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { keyToString, type SessionKey } from '../sessionKey';
import { resolveDataDir, type StateStore } from '../state';
import { RotatingJsonlFile } from '../utils/rotatingJsonlFile';
import { emptyRequester, getRequestGroupKey, tryRequestGroupKeyFromString, type RequestGroupKey } from './requestGroup';
import type {
  ClosedRequestRecord,
  OpenRequestState,
  OpenRequestUpdate,
  RequestCloseReason,
  RequestLookup,
  RequestOrigin,
  RequestOriginKind,
  UnreleasedRequestAlert,
} from './types';

/**
 * @description The request ledger (core plan S2): which unit of work each
 * conversation's agent still owes an answer to.
 *
 *   open set  — `state.json` `openRequests`, at most ONE per request GROUP
 *               (`requestGroup.ts`: the platform-agnostic `SessionKey` of the
 *               conversation — Telegram topics and tracker issues alike — plus
 *               the requester). A new request SUPERSEDES the group's open one;
 *               other requesters' requests in the conversation stay open.
 *   history   — `DATA_DIR/requests.jsonl`, one line per CLOSED request
 *               (append-only, one rotated backup).
 *
 * A recently closed request stays known by id — an answer to it is still
 * delivered, it just changes no request — so the history is indexed in memory
 * at {@link RequestLedger.load}, bounded to the most recent
 * {@link closedRequestIndexMaxSize} closed requests. A new request is durably
 * saved before its id is handed out. Until the load resolves the ledger refuses every call
 * (it throws): the bot MCP server starts serving before sessions re-attach, and
 * an answer looked up against a not-yet-loaded history would wrongly be refused
 * as an unknown id. Tool handlers gate on {@link RequestLedger.whenLoaded}.
 *
 * Crash ordering: the history line is written BEFORE the open entry is dropped,
 * and `load` drops any open entry the history already shows closed — so a crash
 * between the two writes never leaves a request both open and closed.
 */

/** History size bound per file before it rolls to `.1` (same as the run ledger). */
export const requestHistoryMaxBytes = 10 * 1024 * 1024;
/** The longest prompt an open request keeps for a re-post (R21); `state.json` is rewritten whole. */
export const requestPromptMaxLength = 64_000;

/** Request ids read `req_<random>`: short enough for a prompt header, unguessable across topics. */
const requestIdPrefix = 'req_';
/** 6 random bytes → 8 base64url chars, 48 bits. */
const requestIdRandomByteLength = 6;
/**
 * How many replaced ids a request carries (`supersededRequestIds`): a requester
 * who keeps writing without an answer in between builds a chain, and the header
 * naming it must stay short. The newest ones are kept.
 */
export const supersededRequestIdsMaxLength = 10;

/**
 * How many CLOSED requests stay known by id (the most recent ones). A closed id
 * is looked up only for a late answer — a turn still running when a newer
 * request superseded its own — which arrives minutes, at most hours (a usage
 * limit wait) after the close. 5 000 covers weeks of traffic even with every
 * operator message a request (a few hundred a day), while keeping memory fixed
 * (~1–2 MB) regardless of how long the bot runs. An answer to an id that fell
 * out of the window is refused as unknown.
 */
export const closedRequestIndexMaxSize = 5_000;

/** Thrown when the ledger is used before {@link RequestLedger.load} resolved. */
export class RequestLedgerNotLoadedError extends Error {
  constructor() {
    super('request ledger used before load() resolved');
    this.name = 'RequestLedgerNotLoadedError';
  }
}

/** The part of the state store the ledger reads and writes. */
export type RequestLedgerStore = Pick<
  StateStore,
  | 'getOpenRequests'
  | 'getOpenRequest'
  | 'updateOpenRequest'
  | 'flush'
  | 'getUnreleasedRequestAlerts'
  | 'addUnreleasedRequestAlert'
  | 'removeUnreleasedRequestAlert'
>;

/**
 * @name RequestLedgerDeps
 * @description `history`, `now` and `closedIndexMaxSize` are injectable for
 * tests; production uses the `DATA_DIR` history file, the wall clock and
 * {@link closedRequestIndexMaxSize}.
 */
export interface RequestLedgerDeps {
  store: RequestLedgerStore;
  /**
   * Release the alert a closed request held (Telegram: unpin it). The ledger
   * keeps the alert in `state.json` until this resolves, and retries every one
   * still unreleased at the next load — a rejection leaves it for that retry.
   */
  releaseAlert?: (alert: UnreleasedRequestAlert) => Promise<void>;
  /**
   * Called for every new request once it is durably saved, before its id is
   * handed out — whoever opened it. The boot uses it to tell a request opened
   * during a usage-limit wait about that wait. Must not throw.
   */
  onRequestCreated?: (key: SessionKey, request: OpenRequestState) => void;
  history?: RotatingJsonlFile<ClosedRequestRecord>;
  now?: () => number;
  closedIndexMaxSize?: number;
}

/**
 * @name OpenRequestUpdater
 * @description How to change an open request: a patch, or a function of the
 * CURRENT request run under the per-conversation lock (for a read-modify-write
 * such as a counter increment that must not lose a concurrent one).
 */
export type OpenRequestUpdater = OpenRequestUpdate | ((current: OpenRequestState) => OpenRequestUpdate);

/** @description An open request together with its conversation (`key`) and its group. */
export interface OpenRequestEntry {
  key: SessionKey;
  group: RequestGroupKey;
  request: OpenRequestState;
}

/**
 * @name CreateRequestOptions
 * @description `createPrompt` builds the prompt the request keeps for a re-post
 * (R21) from the id just drawn and the ids of the open requests it replaces —
 * the same inputs the header is built from, so the kept prompt and the forwarded
 * one read the same.
 */
export interface CreateRequestOptions {
  createPrompt?: (requestId: string, supersededRequestIds: readonly string[]) => string;
}

const closeReasons: ReadonlySet<RequestCloseReason> = new Set(['final', 'question', 'superseded', 'cancelled']);
const originKinds: ReadonlySet<RequestOriginKind> = new Set(['message', 'scheduledRun', 'trackerEvent']);

/** Default history path under the live `DATA_DIR`. */
function getDefaultHistoryPath(): string {
  return path.join(resolveDataDir(), 'requests.jsonl');
}

/**
 * @description Parse one history line, or `null` for a line that is not a
 * closed request (truncated by a crash, hand-edited, written by a different
 * version). Every field is checked and the record rebuilt from them.
 */
export function parseClosedRequestLine(line: string): ClosedRequestRecord | null {
  let parsed: Partial<ClosedRequestRecord> | null;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const {
    id, conversationKey, closedAt, closeReason, origin, createdAt,
    progressAnswerCount, silentTurnCount, wakeCount, isWakeStopped, nextWakeAt, lastTurnActivityAt, alertRef,
    isLimitStopped, limitWaitAnsweredFor, supersededBy, supersededRequestIds,
  } = parsed;
  if (typeof id !== 'string' || typeof conversationKey !== 'string') return null;
  if (closeReason === undefined || !closeReasons.has(closeReason)) return null;
  if (typeof origin !== 'object' || origin === null || !originKinds.has(origin.kind)) return null;
  const { attributes } = origin;
  // The answer sink of a closed request's platform reads these back verbatim.
  if (typeof attributes !== 'object' || attributes === null || Array.isArray(attributes)) return null;
  if (!Object.values(attributes).every((value) => typeof value === 'string')) return null;
  if (
    typeof closedAt !== 'number' || typeof createdAt !== 'number' || typeof progressAnswerCount !== 'number' ||
    typeof silentTurnCount !== 'number' || typeof wakeCount !== 'number' || typeof isWakeStopped !== 'boolean'
  ) {
    return null;
  }
  return {
    id,
    conversationKey,
    closedAt,
    closeReason,
    origin: { kind: origin.kind, attributes },
    createdAt,
    progressAnswerCount,
    silentTurnCount,
    wakeCount,
    isWakeStopped,
    // Optional fields keep their absence (`state.json` omits them when unset).
    ...(typeof nextWakeAt === 'number' ? { nextWakeAt } : {}),
    ...(typeof lastTurnActivityAt === 'number' ? { lastTurnActivityAt } : {}),
    ...(typeof alertRef === 'string' ? { alertRef } : {}),
    ...(typeof isLimitStopped === 'boolean' ? { isLimitStopped } : {}),
    ...(typeof limitWaitAnsweredFor === 'string' ? { limitWaitAnsweredFor } : {}),
    ...(typeof supersededBy === 'string' ? { supersededBy } : {}),
    ...(Array.isArray(supersededRequestIds) && supersededRequestIds.every((value) => typeof value === 'string')
      ? { supersededRequestIds }
      : {}),
  };
}

export class RequestLedger {
  private readonly store: RequestLedgerStore;
  private readonly history: RotatingJsonlFile<ClosedRequestRecord>;
  private readonly now: () => number;
  private readonly closedIndexMaxSize: number;
  private readonly releaseAlert: ((alert: UnreleasedRequestAlert) => Promise<void>) | undefined;
  private readonly onRequestCreated: ((key: SessionKey, request: OpenRequestState) => void) | undefined;
  /** Request ids whose alert release is under way, so two paths never release one twice at once. */
  private readonly alertReleasesInFlight = new Set<string>();
  /** Insertion order = close order, so the first key is always the oldest. */
  private readonly closedById = new Map<string, ClosedRequestRecord>();
  private loadPromise: Promise<void> | null = null;
  private isLoaded = false;
  private resolveLoaded: () => void = () => {};
  private readonly loadedPromise = new Promise<void>((resolve) => {
    this.resolveLoaded = resolve;
  });

  constructor(deps: RequestLedgerDeps) {
    this.store = deps.store;
    this.history = deps.history ?? new RotatingJsonlFile(getDefaultHistoryPath(), requestHistoryMaxBytes);
    this.now = deps.now ?? Date.now;
    this.closedIndexMaxSize = deps.closedIndexMaxSize ?? closedRequestIndexMaxSize;
    this.releaseAlert = deps.releaseAlert;
    this.onRequestCreated = deps.onRequestCreated;
  }

  /**
   * @description Index the closed-request history and drop open entries it
   * already shows closed. Idempotent: every call returns the same promise. A
   * history that cannot be read rejects (the boot surfaces it) and leaves the
   * ledger unloaded rather than serving a partial index as the truth.
   */
  load(): Promise<void> {
    this.loadPromise ??= this.runLoad();
    return this.loadPromise;
  }

  /** @description Resolves once {@link load} has finished; never rejects. */
  whenLoaded(): Promise<void> {
    return this.loadedPromise;
  }

  /** @description True once {@link load} has finished. */
  checkIsLoaded(): boolean {
    return this.isLoaded;
  }

  private async runLoad(): Promise<void> {
    let skippedLineCount = 0;
    for (const line of await this.history.readLines()) {
      const record = parseClosedRequestLine(line);
      if (record) this.indexClosed(record);
      else skippedLineCount += 1;
    }
    let droppedOpenCount = 0;
    for (const entry of this.getOpenEntries()) {
      if (!this.closedById.has(entry.request.id)) continue;
      // It closed before the crash, so its alert was never handed to a release.
      // Listed BEFORE the entry goes, so no crash between the two can lose it.
      const { alertRef } = entry.request;
      if (alertRef !== undefined) {
        this.store.addUnreleasedRequestAlert(entry.request.id, { conversationKey: keyToString(entry.key), alertRef });
      }
      await this.store.updateOpenRequest(entry.group, (current) => (current?.id === entry.request.id ? undefined : current));
      droppedOpenCount += 1;
    }
    this.isLoaded = true;
    this.resolveLoaded();
    for (const [requestId, alert] of Object.entries(this.store.getUnreleasedRequestAlerts())) {
      void this.releaseAlertOf(requestId, alert);
    }
    console.log(
      `[requests] ledger loaded: ${this.getOpenEntries().length} open, ${this.closedById.size} recently closed known` +
        (droppedOpenCount > 0 ? `, ${droppedOpenCount} open entries already closed dropped` : '') +
        (skippedLineCount > 0 ? `, ${skippedLineCount} unreadable history lines skipped` : ''),
    );
  }

  private assertLoaded(): void {
    if (!this.isLoaded) throw new RequestLedgerNotLoadedError();
  }

  /** Open entries whose group key still decodes (a key of an unregistered platform is left alone), oldest first. */
  private getOpenEntries(): OpenRequestEntry[] {
    const entries: OpenRequestEntry[] = [];
    for (const [groupString, request] of Object.entries(this.store.getOpenRequests())) {
      const group = tryRequestGroupKeyFromString(groupString);
      if (group) entries.push({ key: group.conversation, group, request });
    }
    return entries.sort((a, b) => a.request.createdAt - b.request.createdAt);
  }

  private getOpenEntryById(id: string): OpenRequestEntry | undefined {
    return this.getOpenEntries().find((entry) => entry.request.id === id);
  }

  private createRequestId(): string {
    const openIds = new Set(Object.values(this.store.getOpenRequests()).map((request) => request.id));
    for (;;) {
      const id = `${requestIdPrefix}${randomBytes(requestIdRandomByteLength).toString('base64url')}`;
      if (!openIds.has(id) && !this.closedById.has(id)) return id;
    }
  }

  private appendClosed(closing: ClosedRequestRecord): void {
    // The prompt was kept for a re-post only; a closed request is never re-posted,
    // and the history must not grow by every prompt (issue text included).
    const { prompt: _prompt, isPromptTakenIn: _isPromptTakenIn, ...record } = closing;
    if (!this.history.append(record)) {
      console.warn(`[requests] could not append ${record.id} to ${this.history.filePath}; it is closed in memory only`);
    }
    this.indexClosed(record);
    if (record.alertRef !== undefined) {
      this.queueAlertRelease(record.id, { conversationKey: record.conversationKey, alertRef: record.alertRef });
    }
  }

  /**
   * Record a closed request's alert as still to release (synchronously, so it
   * rides the close's own save), then release it.
   */
  private queueAlertRelease(requestId: string, alert: UnreleasedRequestAlert): void {
    this.store.addUnreleasedRequestAlert(requestId, alert);
    void this.releaseAlertOf(requestId, alert);
  }

  /** Release an alert; it leaves the unreleased list only once the release succeeded. */
  private async releaseAlertOf(requestId: string, alert: UnreleasedRequestAlert): Promise<void> {
    if (!this.releaseAlert || this.alertReleasesInFlight.has(requestId)) return;
    this.alertReleasesInFlight.add(requestId);
    try {
      await this.releaseAlert(alert);
      this.store.removeUnreleasedRequestAlert(requestId);
    } catch (e) {
      console.warn(`[requests] releasing the alert of ${requestId} failed; retried at the next start:`, e instanceof Error ? e.message : e);
    } finally {
      this.alertReleasesInFlight.delete(requestId);
    }
  }

  /**
   * @description Store the alert a request now holds, DURABLY (flushed): a crash
   * that lost it would leave the alert pinned forever. Resolves `false` when the
   * request closed meanwhile — its close found no alert, so it is released here.
   */
  async recordAlert(key: SessionKey, requestId: string, alertRef: string): Promise<boolean> {
    this.assertLoaded();
    const stored = await this.updateOpenRequest(requestId, { alertRef });
    if (stored) {
      await this.store.flush();
      return true;
    }
    this.queueAlertRelease(requestId, { conversationKey: keyToString(key), alertRef });
    return false;
  }

  /** Remember a closed request by id, forgetting the oldest beyond the window. */
  private indexClosed(record: ClosedRequestRecord): void {
    this.closedById.delete(record.id);
    this.closedById.set(record.id, record);
    while (this.closedById.size > this.closedIndexMaxSize) {
      const oldestId = this.closedById.keys().next().value;
      if (oldestId === undefined) break;
      this.closedById.delete(oldestId);
    }
  }

  /**
   * @description Open a new request for `key`'s conversation. The open request of
   * the same GROUP (same conversation, same requester — `getRequestGroupKey`), if
   * any, is closed as `superseded` first, in the same atomic step — the latest
   * message of a requester is the one that matters, and the new request names it
   * (and what it had replaced in turn) in `supersededRequestIds`, so one answer
   * covers them all. Another requester's open request in the conversation is
   * untouched. A request WITHOUT a requester (persisted before requesters
   * existed, or raised by an origin that names none) keeps the old rule: the
   * conversation's next request supersedes it whoever raised that one — else it
   * would linger, woken again and again, with nothing left that could close it.
   * Resolves only once the new request is DURABLY saved: its id is
   * about to reach an agent, and an id the agent was told about but a crash lost
   * would make its answer refused as unknown — a dropped result.
   */
  async createRequest(key: SessionKey, origin: RequestOrigin, options: CreateRequestOptions = {}): Promise<OpenRequestState> {
    this.assertLoaded();
    const createdAt = this.now();
    const conversationKey = keyToString(key);
    const group = getRequestGroupKey(key, origin);
    const id = this.createRequestId();
    const requesterlessGroup: RequestGroupKey = { conversation: key, requester: emptyRequester };
    const requesterless = group.requester === emptyRequester ? undefined : this.store.getOpenRequest(requesterlessGroup);
    let request: OpenRequestState | null = null;
    await this.store.updateOpenRequest(group, (current) => {
      const supersededRequestIds = [requesterless, current]
        .flatMap((replaced) => (replaced ? [...(replaced.supersededRequestIds ?? []), replaced.id] : []))
        .slice(-supersededRequestIdsMaxLength);
      const prompt = options.createPrompt?.(id, supersededRequestIds);
      if (prompt !== undefined && prompt.length > requestPromptMaxLength) {
        console.warn(`[requests] ${id}: prompt of ${prompt.length} chars not kept (over ${requestPromptMaxLength}); a wake-up sends a reminder instead`);
      }
      const created: OpenRequestState = {
        id,
        origin,
        createdAt,
        progressAnswerCount: 0,
        silentTurnCount: 0,
        wakeCount: 0,
        isWakeStopped: false,
        ...(prompt !== undefined && prompt.length <= requestPromptMaxLength ? { prompt } : {}),
        ...(supersededRequestIds.length > 0 ? { supersededRequestIds } : {}),
      };
      if (current) this.appendClosed({ ...current, conversationKey, closedAt: createdAt, closeReason: 'superseded', supersededBy: id });
      request = created;
      return created;
    });
    if (!request) throw new Error(`[requests] ${id}: the store did not run the create`);
    if (requesterless) {
      // Its own group, so a separate step AFTER the create: a crash between the two
      // leaves it open for the conversation's next request, never a lost new one.
      await this.store.updateOpenRequest(requesterlessGroup, (current) => {
        if (current?.id !== requesterless.id) return current;
        this.appendClosed({ ...current, conversationKey, closedAt: createdAt, closeReason: 'superseded', supersededBy: id });
        return undefined;
      });
    }
    await this.store.flush();
    this.onRequestCreated?.(key, request);
    return request;
  }

  /** @description A request by id, open or closed, or `null` for an unknown id. */
  getRequest(id: string): RequestLookup | null {
    this.assertLoaded();
    const open = this.getOpenEntryById(id);
    if (open) return { isOpen: true, conversationKey: keyToString(open.key), request: open.request };
    const closed = this.closedById.get(id);
    return closed ? { isOpen: false, conversationKey: closed.conversationKey, request: closed } : null;
  }

  /** @description The open request `id`, with its conversation, or `undefined` when `id` is not open. */
  getOpenRequestById(id: string): OpenRequestEntry | undefined {
    this.assertLoaded();
    return this.getOpenEntryById(id);
  }

  /**
   * @description The open requests of `key`'s conversation, oldest first — one per
   * requester at most (see `requestGroup.ts`).
   */
  listOpenRequestsOf(key: SessionKey): OpenRequestState[] {
    this.assertLoaded();
    const conversationKey = keyToString(key);
    return this.getOpenEntries()
      .filter((entry) => keyToString(entry.key) === conversationKey)
      .map((entry) => entry.request);
  }

  /**
   * @description The NEWEST open request of `key`'s conversation, or `undefined`.
   * A conversation may hold one open request per requester; a caller that must
   * act on all of them uses {@link listOpenRequestsOf}.
   */
  getNewestOpenRequest(key: SessionKey): OpenRequestState | undefined {
    this.assertLoaded();
    return this.listOpenRequestsOf(key).at(-1);
  }

  /** @description Every open request with its conversation, oldest first. */
  listOpenRequests(): OpenRequestEntry[] {
    this.assertLoaded();
    return this.getOpenEntries();
  }

  /**
   * @description Change the answer and wake-up bookkeeping of an open request.
   * Resolves the updated request, or `null` when `id` is not open (closed or
   * superseded in the meantime — the update is then dropped, never applied to
   * its successor).
   */
  async updateOpenRequest(id: string, update: OpenRequestUpdater): Promise<OpenRequestState | null> {
    this.assertLoaded();
    const entry = this.getOpenEntryById(id);
    if (!entry) return null;
    let updated: OpenRequestState | null = null;
    await this.store.updateOpenRequest(entry.group, (current) => {
      if (current?.id !== id) return current;
      const next: OpenRequestState = { ...current, ...(typeof update === 'function' ? update(current) : update) };
      updated = next;
      return next;
    });
    return updated;
  }

  /**
   * @description Close an open request. Resolves the closed record, or `null` when
   * `id` is not open (an already closed request is never closed twice).
   */
  async closeRequest(id: string, reason: RequestCloseReason): Promise<ClosedRequestRecord | null> {
    this.assertLoaded();
    const entry = this.getOpenEntryById(id);
    if (!entry) return null;
    const conversationKey = keyToString(entry.key);
    let closed: ClosedRequestRecord | null = null;
    await this.store.updateOpenRequest(entry.group, (current) => {
      if (current?.id !== id) return current;
      const record: ClosedRequestRecord = { ...current, conversationKey, closedAt: this.now(), closeReason: reason };
      this.appendClosed(record);
      closed = record;
      return undefined;
    });
    return closed;
  }
}
