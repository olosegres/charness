import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { keyToString, tryKeyFromString, type SessionKey } from '../sessionKey';
import { resolveDataDir, type StateStore } from '../state';
import { RotatingJsonlFile } from '../utils/rotatingJsonlFile';
import type {
  ClosedRequestRecord,
  OpenRequestState,
  OpenRequestUpdate,
  RequestCloseReason,
  RequestLookup,
  RequestOrigin,
  RequestOriginKind,
} from './types';

/**
 * @description The request ledger (core plan S2): which unit of work each
 * conversation's agent still owes an answer to.
 *
 *   open set  — `state.json` `openRequests`, at most ONE per conversation, keyed
 *               by the platform-agnostic `SessionKey` (Telegram topics and
 *               tracker issues alike). A new request SUPERSEDES the open one.
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

/** Request ids read `req_<random>`: short enough for a prompt header, unguessable across topics. */
const requestIdPrefix = 'req_';
/** 6 random bytes → 8 base64url chars, 48 bits. */
const requestIdRandomByteLength = 6;

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
export type RequestLedgerStore = Pick<StateStore, 'getOpenRequests' | 'getOpenRequest' | 'updateOpenRequest' | 'flush'>;

/**
 * @name RequestLedgerDeps
 * @description `history`, `now` and `closedIndexMaxSize` are injectable for
 * tests; production uses the `DATA_DIR` history file, the wall clock and
 * {@link closedRequestIndexMaxSize}.
 */
export interface RequestLedgerDeps {
  store: RequestLedgerStore;
  /**
   * Called once for every request that closes, by any path (an answer, a newer
   * request, a cancellation) — after its history line is written. The boot uses
   * it to release a platform alert the request still holds. Must not throw.
   */
  onRequestClosed?: (record: ClosedRequestRecord) => void;
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

/** @description An open request together with its conversation. */
export interface OpenRequestEntry {
  key: SessionKey;
  request: OpenRequestState;
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
  };
}

export class RequestLedger {
  private readonly store: RequestLedgerStore;
  private readonly history: RotatingJsonlFile<ClosedRequestRecord>;
  private readonly now: () => number;
  private readonly closedIndexMaxSize: number;
  private readonly onRequestClosed: ((record: ClosedRequestRecord) => void) | undefined;
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
    this.onRequestClosed = deps.onRequestClosed;
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
      await this.store.updateOpenRequest(entry.key, (current) => (current?.id === entry.request.id ? undefined : current));
      droppedOpenCount += 1;
    }
    this.isLoaded = true;
    this.resolveLoaded();
    console.log(
      `[requests] ledger loaded: ${this.getOpenEntries().length} open, ${this.closedById.size} recently closed known` +
        (droppedOpenCount > 0 ? `, ${droppedOpenCount} open entries already closed dropped` : '') +
        (skippedLineCount > 0 ? `, ${skippedLineCount} unreadable history lines skipped` : ''),
    );
  }

  private assertLoaded(): void {
    if (!this.isLoaded) throw new RequestLedgerNotLoadedError();
  }

  /** Open entries whose key still decodes (a key of an unregistered platform is left alone). */
  private getOpenEntries(): OpenRequestEntry[] {
    const entries: OpenRequestEntry[] = [];
    for (const [keyString, request] of Object.entries(this.store.getOpenRequests())) {
      const key = tryKeyFromString(keyString);
      if (key) entries.push({ key, request });
    }
    return entries;
  }

  private createRequestId(): string {
    const openIds = new Set(Object.values(this.store.getOpenRequests()).map((request) => request.id));
    for (;;) {
      const id = `${requestIdPrefix}${randomBytes(requestIdRandomByteLength).toString('base64url')}`;
      if (!openIds.has(id) && !this.closedById.has(id)) return id;
    }
  }

  private appendClosed(record: ClosedRequestRecord): void {
    if (!this.history.append(record)) {
      console.warn(`[requests] could not append ${record.id} to ${this.history.filePath}; it is closed in memory only`);
    }
    this.indexClosed(record);
    this.onRequestClosed?.(record);
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
   * @description Open a new request for `key`'s conversation. The conversation's
   * open request, if any, is closed as `superseded` first, in the same atomic
   * step — the latest message is the one that matters. Resolves only once the
   * new request is DURABLY saved: its id is about to reach an agent, and an id
   * the agent was told about but a crash lost would make its answer refused as
   * unknown — a dropped result.
   */
  async createRequest(key: SessionKey, origin: RequestOrigin): Promise<OpenRequestState> {
    this.assertLoaded();
    const createdAt = this.now();
    const conversationKey = keyToString(key);
    const request: OpenRequestState = {
      id: this.createRequestId(),
      origin,
      createdAt,
      progressAnswerCount: 0,
      silentTurnCount: 0,
      wakeCount: 0,
      isWakeStopped: false,
    };
    await this.store.updateOpenRequest(key, (current) => {
      if (current) this.appendClosed({ ...current, conversationKey, closedAt: createdAt, closeReason: 'superseded' });
      return request;
    });
    await this.store.flush();
    return request;
  }

  /** @description A request by id, open or closed, or `null` for an unknown id. */
  getRequest(id: string): RequestLookup | null {
    this.assertLoaded();
    const open = this.getOpenEntries().find((entry) => entry.request.id === id);
    if (open) return { isOpen: true, conversationKey: keyToString(open.key), request: open.request };
    const closed = this.closedById.get(id);
    return closed ? { isOpen: false, conversationKey: closed.conversationKey, request: closed } : null;
  }

  /** @description The open request of `key`'s conversation, or `undefined`. */
  getOpenRequest(key: SessionKey): OpenRequestState | undefined {
    this.assertLoaded();
    return this.store.getOpenRequest(key);
  }

  /** @description Every open request with its conversation. */
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
    const entry = this.getOpenEntries().find((candidate) => candidate.request.id === id);
    if (!entry) return null;
    let updated: OpenRequestState | null = null;
    await this.store.updateOpenRequest(entry.key, (current) => {
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
    const entry = this.getOpenEntries().find((candidate) => candidate.request.id === id);
    if (!entry) return null;
    const conversationKey = keyToString(entry.key);
    let closed: ClosedRequestRecord | null = null;
    await this.store.updateOpenRequest(entry.key, (current) => {
      if (current?.id !== id) return current;
      const record: ClosedRequestRecord = { ...current, conversationKey, closedAt: this.now(), closeReason: reason };
      this.appendClosed(record);
      closed = record;
      return undefined;
    });
    return closed;
  }
}
