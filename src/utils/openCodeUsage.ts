/**
 * @description The USAGE of OpenCode providers signed in through a SUBSCRIPTION — what `/limits` and `/accounts` print
 * beside an OpenCode provider the way they print a Claude account's windows. v1 knows one provider: `openai` signed in
 * with a ChatGPT subscription (an `oauth` record in OpenCode's `auth.json`), read off
 * `GET https://chatgpt.com/backend-api/wham/usage` — the endpoint the Codex CLI and ChatGPT's own settings page use. It
 * has no published schema; the field names below (`rate_limit.primary_window` / `secondary_window`, each with
 * `used_percent`, `limit_window_seconds`, `reset_after_seconds`, `reset_at`) come from third-party documentation of it
 * (the codex-lb proxy's API reference), so the parser is tolerant and an unknown shape yields no windows — the row just
 * has no usage. API-key providers and other subscriptions have no reader: they show their auth kind only.
 *
 * Like a Claude profile's usage (`claudeUsage.ts`): the stored token is used as is and NEVER refreshed here (OpenCode
 * renews it; a bot-side refresh would race it) — a token past its expiry is not sent and marks the snapshot stale; the
 * token is never logged. Snapshots reuse the Claude shape (`ClaudeUsageSnapshot`: the primary window is `session`, the
 * secondary `weekly_all`), so `formatClaudeProfileUsageLines` renders them unchanged. Pure except
 * {@link readOpenCodeCredentials} (one file read) and the injectable fetch.
 */

import * as fs from 'fs';
import {
  fetchUsageBuckets,
  markClaudeUsageSnapshotStale,
  mergeClaudeUsageSnapshot,
  type ClaudeUsageBucket,
  type ClaudeUsageBucketKind,
  type ClaudeUsageFetchResult,
  type ClaudeUsageSnapshot,
  type UsageFetchLike,
} from './claudeUsage';

export const chatGptUsageEndpoint = 'https://chatgpt.com/backend-api/wham/usage';

/** How a provider is signed in: through a subscription (`oauth`), an API key (`api`), or any other record. */
export type OpenCodeAuthKind = 'subscription' | 'apiKey' | 'unknown';

/**
 * What `state.json` keeps per OpenCode provider (`openCodeProviderUsage`): how it is signed in, and for a subscription
 * with a reader the last usage snapshot. Written by the poller only; a provider it does not list is never touched.
 */
export interface OpenCodeProviderUsageRecord {
  authKind: OpenCodeAuthKind;
  usage?: ClaudeUsageSnapshot;
}

/** A window up to this long counts as the short (5-hour) one, a longer window as the weekly one. */
const shortWindowMaxSeconds = 24 * 3600;

/**
 * One provider's record in `auth.json`: its kind, and for a subscription the access token, its expiry and the account
 * id. The token stays inside this object — nothing here logs or returns it other than to the reader that needs it.
 */
export interface OpenCodeProviderCredential {
  kind: OpenCodeAuthKind;
  accessToken: string | null;
  /** Epoch ms; `null` when the record carries none. */
  expiresAtMs: number | null;
  accountId: string | null;
}

function checkIsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readAuthKind(type: unknown): OpenCodeAuthKind {
  if (type === 'oauth') return 'subscription';
  if (type === 'api') return 'apiKey';
  return 'unknown';
}

/**
 * @description The providers of a parsed `auth.json` with their credential kind; a malformed entry is skipped, never
 * thrown on. `null` when the document is not an object.
 */
export function parseOpenCodeCredentials(authJson: unknown): Record<string, OpenCodeProviderCredential> | null {
  if (!checkIsRecord(authJson)) return null;
  const credentials: Record<string, OpenCodeProviderCredential> = {};
  for (const [providerId, entry] of Object.entries(authJson)) {
    if (!checkIsRecord(entry)) continue;
    credentials[providerId] = {
      kind: readAuthKind(entry.type),
      accessToken: typeof entry.access === 'string' && entry.access !== '' ? entry.access : null,
      expiresAtMs: typeof entry.expires === 'number' ? entry.expires : null,
      accountId: typeof entry.accountId === 'string' && entry.accountId !== '' ? entry.accountId : null,
    };
  }
  return credentials;
}

/** @description {@link parseOpenCodeCredentials} of the file at `authFilePath`; `null` when it is missing or unreadable. */
export function readOpenCodeCredentials(authFilePath: string): Record<string, OpenCodeProviderCredential> | null {
  try {
    return parseOpenCodeCredentials(JSON.parse(fs.readFileSync(authFilePath, 'utf8')));
  } catch {
    return null;
  }
}

// ── the ChatGPT reader ──

/** The account id inside a ChatGPT access token (a JWT): the claim `chatgpt_account_id` under `https://api.openai.com/auth`. */
function readAccountIdFromJwt(accessToken: string): string | null {
  const payload = accessToken.split('.')[1];
  if (payload === undefined) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const auth = checkIsRecord(claims) ? claims['https://api.openai.com/auth'] : null;
    return checkIsRecord(auth) && typeof auth.chatgpt_account_id === 'string' ? auth.chatgpt_account_id : null;
  } catch {
    return null;
  }
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** A window's reset as an ISO instant: its own `reset_at` (Unix seconds), else `reset_after_seconds` from now. */
function readResetsAt(window: Record<string, unknown>, nowMs: number): string | null {
  if (typeof window.reset_at === 'number') return new Date(window.reset_at * 1000).toISOString();
  if (typeof window.reset_after_seconds === 'number') return new Date(nowMs + window.reset_after_seconds * 1000).toISOString();
  return null;
}

/**
 * @description The windows of a ChatGPT usage response as Claude-shaped buckets. A window is the 5-hour `session` when
 * its length (`limit_window_seconds`) is a day or less, else the weekly one; a window that names no length is read by
 * its place (primary = 5-hour, secondary = weekly). An account with one window only (a weekly-only plan) yields that
 * bucket. A body of another shape yields none.
 */
export function parseChatGptUsageResponse(body: unknown, nowMs: number): ClaudeUsageBucket[] {
  const rateLimit = checkIsRecord(body) ? body.rate_limit : null;
  if (!checkIsRecord(rateLimit)) return [];
  const buckets: ClaudeUsageBucket[] = [];
  for (const [field, placeKind] of [['primary_window', 'session'], ['secondary_window', 'weekly_all']] as const) {
    const window = rateLimit[field];
    if (!checkIsRecord(window) || typeof window.used_percent !== 'number') continue;
    const length = window.limit_window_seconds;
    const kind: ClaudeUsageBucketKind = typeof length === 'number' ? (length <= shortWindowMaxSeconds ? 'session' : 'weekly_all') : placeKind;
    if (buckets.some((bucket) => bucket.kind === kind)) continue;
    buckets.push({ kind, percent: clampPercent(window.used_percent), resetsAt: readResetsAt(window, nowMs), scopeModel: null });
  }
  return buckets;
}

/**
 * @description One GET of the ChatGPT usage endpoint with the subscription's token and account id (the id off the record,
 * else off the token). Never throws; the token never appears in the result.
 */
export function fetchChatGptUsage(
  credential: OpenCodeProviderCredential,
  options: { fetchImpl?: UsageFetchLike; timeoutMs?: number; nowMs?: number } = {},
): Promise<ClaudeUsageFetchResult> {
  const accessToken = credential.accessToken ?? '';
  const accountId = credential.accountId ?? readAccountIdFromJwt(accessToken);
  const nowMs = options.nowMs ?? Date.now();
  return fetchUsageBuckets({
    url: chatGptUsageEndpoint,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...(accountId === null ? {} : { 'ChatGPT-Account-Id': accountId }),
    },
    parse: (body) => parseChatGptUsageResponse(body, nowMs),
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });
}

/** A provider's subscription usage reader: one poll with the stored credential. */
export type OpenCodeUsageReader = (credential: OpenCodeProviderCredential) => Promise<ClaudeUsageFetchResult>;

/** The subscription usage readers by provider id; a provider not here shows only its auth kind. */
export const openCodeUsageReaders: Readonly<Record<string, OpenCodeUsageReader>> = {
  openai: (credential) => fetchChatGptUsage(credential),
};

// ── the poller ──

export interface OpenCodeUsagePollerDeps {
  /** `auth.json` as parsed; `null` when it is missing or unreadable (nothing is touched then). */
  readCredentials: () => Record<string, OpenCodeProviderCredential> | null;
  getRecord: (providerId: string) => OpenCodeProviderUsageRecord | undefined;
  saveRecord: (providerId: string, record: OpenCodeProviderUsageRecord) => void;
  /** The reader of a provider's subscription usage; absent ⇒ none exists. Injectable so a test never reaches a network. */
  readers?: Readonly<Record<string, OpenCodeUsageReader>>;
  now?: () => number;
  log?: (line: string) => void;
}

export interface OpenCodeUsagePoller {
  /** Poll every provider `auth.json` lists; with `maxAgeMs`, only the subscriptions whose snapshot is older (or stale). */
  refreshAll: (options?: { maxAgeMs?: number }) => Promise<void>;
}

/**
 * @description The poller of OpenCode providers' usage. For each provider in `auth.json`: an API key or an unknown record
 * is stored as its kind alone (no usage); a subscription with a reader is polled — an expired token is not sent and marks
 * the snapshot stale, a failed poll keeps the last figures marked stale. A provider `auth.json` does not list (one
 * enabled by an environment variable) is left as it is. A failure is logged once per change of its reason — a poll every
 * ten minutes must not fill the log — and never reported to error tracking (nothing for us to fix).
 */
export function createOpenCodeUsagePoller(deps: OpenCodeUsagePollerDeps): OpenCodeUsagePoller {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((line: string) => console.log(line));
  const readers = deps.readers ?? openCodeUsageReaders;

  function saveIfChanged(providerId: string, previous: OpenCodeProviderUsageRecord | undefined, next: OpenCodeProviderUsageRecord): void {
    if (JSON.stringify(previous) !== JSON.stringify(next)) deps.saveRecord(providerId, next);
  }

  function logFailureOnce(providerId: string, previous: OpenCodeProviderUsageRecord | undefined, reason: string): void {
    if (previous?.usage?.isStale && previous.usage.error === reason) return;
    log(`[usage] OpenCode ${providerId}: usage unavailable (${reason})`);
  }

  async function pollSubscription(providerId: string, credential: OpenCodeProviderCredential, previous: OpenCodeProviderUsageRecord | undefined): Promise<void> {
    const reader = readers[providerId];
    if (reader === undefined) {
      saveIfChanged(providerId, previous, { authKind: 'subscription' });
      return;
    }
    const markStale = (reason: string): void => {
      logFailureOnce(providerId, previous, reason);
      saveIfChanged(providerId, previous, { authKind: 'subscription', usage: markClaudeUsageSnapshotStale(previous?.usage, reason, now()) });
    };
    if (credential.accessToken === null) { markStale('not signed in'); return; }
    if (credential.expiresAtMs !== null && credential.expiresAtMs <= now()) { markStale('token expired'); return; }
    const result = await reader(credential);
    if (!result.ok) { markStale(result.error); return; }
    deps.saveRecord(providerId, { authKind: 'subscription', usage: mergeClaudeUsageSnapshot(previous?.usage, result.buckets, 'api', now()) });
  }

  function checkNeedsPoll(previous: OpenCodeProviderUsageRecord | undefined, maxAgeMs: number | undefined): boolean {
    if (maxAgeMs === undefined || !previous?.usage || previous.usage.isStale) return true;
    return now() - Date.parse(previous.usage.fetchedAt) >= maxAgeMs;
  }

  async function refreshAll(options: { maxAgeMs?: number } = {}): Promise<void> {
    const credentials = deps.readCredentials();
    if (credentials === null) return;
    await Promise.all(Object.entries(credentials).map(async ([providerId, credential]) => {
      const previous = deps.getRecord(providerId);
      try {
        if (credential.kind !== 'subscription') {
          saveIfChanged(providerId, previous, { authKind: credential.kind });
        } else if (checkNeedsPoll(previous, options.maxAgeMs)) {
          await pollSubscription(providerId, credential, previous);
        }
      } catch (e) {
        log(`[usage] OpenCode ${providerId}: usage poll threw: ${e instanceof Error ? e.message : String(e)}`);
      }
    }));
  }

  return { refreshAll };
}
