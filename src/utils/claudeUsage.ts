/**
 * @description Per-profile Claude USAGE — how much of each subscription window an account profile
 * (`utils/claudeProfiles.ts`) has used, and which profile a new process should run on.
 *
 * Two sources feed one snapshot per profile (`ClaudeProfileRecord.usage`):
 *   - the OAuth usage endpoint (`GET https://api.anthropic.com/api/oauth/usage`, the profile's own access
 *     token off its `.credentials.json`), polled by the bot (`claudeUsageRefresher.ts`) and on demand — its
 *     `limits[]` carry the three windows: `session` (five hours), `weekly_all` (seven days, every model) and
 *     `weekly_scoped` (seven days, ONE model — Fable; `scope.model.display_name`), measured on 2026-10-12;
 *   - the `rate_limit_event` frames of a json-stream session, one per API request, whose `unifiedWindows`
 *     carry the same windows under their CLI names (`five_hour`, `seven_day`, `seven_day_overage_included`
 *     — the last one IS the Fable window: same utilization and reset instant as the endpoint's scoped limit).
 *
 * Token refresh is the CLI's job: a token past its `expiresAt` is never used (nor refreshed here) — the
 * snapshot is marked stale and the next CLI run renews it. The token itself is never logged or returned.
 *
 * Pure except {@link readClaudeOAuthToken} (one file read) and {@link fetchClaudeUsage} (one GET through an
 * injectable `fetch`), so the rest is unit-tested without the network.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ClaudeProfileRecord } from '../state';
import { getClaudeAccountKind, resolveClaudeProfileDir, resolveHomeClaudeDir, type ClaudeAccountKind } from './claudeProfiles';

export const claudeUsageEndpoint = 'https://api.anthropic.com/api/oauth/usage';

/** The OAuth beta header the CLI sends with its subscription token. */
const claudeOAuthBetaHeader = 'oauth-2025-04-20';

export const claudeUsageFetchTimeoutMs = 15_000;

/** The one usage window kind set, named by what it bounds rather than by the API's spelling. */
export type ClaudeUsageBucketKind = 'session' | 'weekly_all' | 'weekly_scoped';

export const claudeUsageBucketKinds: readonly ClaudeUsageBucketKind[] = ['session', 'weekly_all', 'weekly_scoped'];

export interface ClaudeUsageBucket {
  kind: ClaudeUsageBucketKind;
  /** 0..100, the endpoint's `percent` (the CLI's `utilization` × 100), rounded. */
  percent: number;
  /** ISO instant the window resets; `null` when the source carried none. */
  resetsAt: string | null;
  /** The model a `weekly_scoped` bucket is for (`"Fable"`); `null` for the shared windows. */
  scopeModel: string | null;
}

/** The cached usage of one profile — what `ClaudeProfileRecord.usage` holds. */
export interface ClaudeUsageSnapshot {
  /** ISO instant of the last write (either source). */
  fetchedAt: string;
  source: 'api' | 'stream';
  buckets: ClaudeUsageBucket[];
  /**
   * The profile's token had expired when the poll ran (the CLI renews it at its next run) or the fetch
   * failed: the buckets are the LAST known ones, not fresh.
   */
  isStale?: boolean;
  /** Why the last poll did not refresh (short, never the token). */
  error?: string;
}

// ── the token ──

export interface ClaudeOAuthToken {
  accessToken: string;
  /** Epoch ms; `null` when the file carries none. */
  expiresAtMs: number | null;
}

/**
 * @description The subscription access token of a profile, off `<configDir>/.credentials.json`
 * (`~/.claude/.credentials.json` for the default profile). `null` when the file or the OAuth entry is absent —
 * a logged-out directory. The caller never logs the result.
 */
export function readClaudeOAuthToken(configDir: string | null, homeClaudeDir: string = resolveHomeClaudeDir()): ClaudeOAuthToken | null {
  const file = path.join(configDir ?? homeClaudeDir, '.credentials.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const oauth = checkIsRecord(parsed) && checkIsRecord(parsed.claudeAiOauth) ? parsed.claudeAiOauth : null;
  if (!oauth || typeof oauth.accessToken !== 'string' || oauth.accessToken === '') return null;
  return { accessToken: oauth.accessToken, expiresAtMs: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null };
}

/** Whether the token is past its expiry at `nowMs` (a token without expiry counts as live). */
export function checkIsClaudeTokenExpired(token: ClaudeOAuthToken, nowMs: number): boolean {
  return token.expiresAtMs !== null && token.expiresAtMs <= nowMs;
}

// ── the endpoint ──

export type ClaudeUsageFetchResult =
  | { ok: true; buckets: ClaudeUsageBucket[] }
  | { ok: false; error: string; isAuthError: boolean };

type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;

/**
 * @description One GET of the usage endpoint with the profile's token. A 401/403 is an auth error (the
 * token is no longer accepted — the CLI's next run renews it); anything else is a plain failure. Never
 * throws; never includes the token in the result.
 */
export async function fetchClaudeUsage(
  token: string,
  options: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<ClaudeUsageFetchResult> {
  const fetchImpl: FetchLike = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? claudeUsageFetchTimeoutMs);
  try {
    const response = await fetchImpl(claudeUsageEndpoint, {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': claudeOAuthBetaHeader, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) return { ok: false, error: `http ${response.status}`, isAuthError: true };
    if (response.status !== 200) return { ok: false, error: `http ${response.status}`, isAuthError: false };
    const buckets = parseClaudeUsageResponse(await response.json());
    if (buckets.length === 0) return { ok: false, error: 'no limits in the response', isAuthError: false };
    return { ok: true, buckets };
  } catch (e) {
    const reason = e instanceof Error ? (e.name === 'AbortError' ? 'timeout' : e.message) : String(e);
    return { ok: false, error: reason.slice(0, 120), isAuthError: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @description The buckets of a usage response. Reads `limits[]` (`kind` session / weekly_all /
 * weekly_scoped, `percent`, `resets_at`, `scope.model.display_name`); a response without it (an older
 * shape) falls back to the top-level `five_hour` / `seven_day` objects (`utilization` already 0..100).
 * Unknown kinds are dropped, so a window the API adds later never breaks a reader.
 */
export function parseClaudeUsageResponse(body: unknown): ClaudeUsageBucket[] {
  if (!checkIsRecord(body)) return [];
  if (Array.isArray(body.limits)) {
    const buckets: ClaudeUsageBucket[] = [];
    for (const limit of body.limits) {
      if (!checkIsRecord(limit)) continue;
      const kind = readBucketKind(limit.kind);
      if (!kind || typeof limit.percent !== 'number') continue;
      const scope = checkIsRecord(limit.scope) && checkIsRecord(limit.scope.model) ? limit.scope.model : null;
      buckets.push({
        kind,
        percent: clampPercent(limit.percent),
        resetsAt: readIso(limit.resets_at),
        scopeModel: scope && typeof scope.display_name === 'string' ? scope.display_name : null,
      });
    }
    if (buckets.length > 0) return buckets;
  }
  const buckets: ClaudeUsageBucket[] = [];
  for (const [field, kind] of [['five_hour', 'session'], ['seven_day', 'weekly_all']] as const) {
    const window = body[field];
    if (!checkIsRecord(window) || typeof window.utilization !== 'number') continue;
    buckets.push({ kind, percent: clampPercent(window.utilization), resetsAt: readIso(window.resets_at), scopeModel: null });
  }
  return buckets;
}

function readBucketKind(value: unknown): ClaudeUsageBucketKind | null {
  return value === 'session' || value === 'weekly_all' || value === 'weekly_scoped' ? value : null;
}

// ── the stream frames ──

/** One `unifiedWindows` entry of a `rate_limit_event` frame, as `claudeStreamJson.ts` lifts it. */
export interface ClaudeRateLimitWindow {
  /** `five_hour` / `seven_day` / `seven_day_overage_included` (the CLI's names). */
  name: string;
  /** 0..1 */
  utilization: number;
  /** Epoch ms; `null` when absent. */
  resetsAtMs: number | null;
}

/** The CLI's window names → bucket kinds; `seven_day_overage_included` is the Fable window (see the module doc). */
const rateLimitWindowKinds: Record<string, { kind: ClaudeUsageBucketKind; scopeModel: string | null }> = {
  five_hour: { kind: 'session', scopeModel: null },
  seven_day: { kind: 'weekly_all', scopeModel: null },
  seven_day_overage_included: { kind: 'weekly_scoped', scopeModel: 'Fable' },
};

/** The buckets a frame's windows carry (unknown window names are dropped). */
export function buildBucketsFromRateLimitWindows(windows: readonly ClaudeRateLimitWindow[]): ClaudeUsageBucket[] {
  const buckets: ClaudeUsageBucket[] = [];
  for (const window of windows) {
    const mapping = rateLimitWindowKinds[window.name];
    if (!mapping) continue;
    buckets.push({
      kind: mapping.kind,
      percent: clampPercent(window.utilization * 100),
      resetsAt: window.resetsAtMs === null ? null : new Date(window.resetsAtMs).toISOString(),
      scopeModel: mapping.scopeModel,
    });
  }
  return buckets;
}

// ── the snapshot ──

/**
 * @description Fold fresh buckets into a profile's snapshot. The endpoint answers with EVERY window, so an
 * `api` read replaces the set; a frame carries only the windows the request touched, so a `stream` read
 * upserts those and keeps the rest. Either way the snapshot is fresh (not stale) afterwards.
 */
export function mergeClaudeUsageSnapshot(
  previous: ClaudeUsageSnapshot | undefined,
  incoming: readonly ClaudeUsageBucket[],
  source: ClaudeUsageSnapshot['source'],
  nowMs: number,
): ClaudeUsageSnapshot {
  let buckets: ClaudeUsageBucket[];
  if (source === 'api' || !previous) {
    buckets = [...incoming];
  } else {
    buckets = previous.buckets.filter((bucket) => !incoming.some((fresh) => fresh.kind === bucket.kind));
    buckets.push(...incoming);
  }
  buckets.sort((a, b) => claudeUsageBucketKinds.indexOf(a.kind) - claudeUsageBucketKinds.indexOf(b.kind));
  return { fetchedAt: new Date(nowMs).toISOString(), source, buckets };
}

/** The snapshot kept as it was, marked stale with the reason (a failed or impossible poll). */
export function markClaudeUsageSnapshotStale(previous: ClaudeUsageSnapshot | undefined, error: string, nowMs: number): ClaudeUsageSnapshot {
  return { fetchedAt: previous?.fetchedAt ?? new Date(nowMs).toISOString(), source: previous?.source ?? 'api', buckets: previous?.buckets ?? [], isStale: true, error };
}

/** Whether `next` says anything `previous` did not — a stream frame per API request must not rewrite state.json each time. */
export function checkClaudeUsageBucketsChanged(previous: ClaudeUsageSnapshot | undefined, next: readonly ClaudeUsageBucket[]): boolean {
  if (!previous || previous.isStale) return true;
  return next.some((bucket) => {
    const old = previous.buckets.find((candidate) => candidate.kind === bucket.kind);
    return !old || old.percent !== bucket.percent || old.resetsAt !== bucket.resetsAt;
  });
}

export function getClaudeUsageBucket(snapshot: ClaudeUsageSnapshot | undefined, kind: ClaudeUsageBucketKind): ClaudeUsageBucket | null {
  return snapshot?.buckets.find((bucket) => bucket.kind === kind) ?? null;
}

// ── which profile for a model ──

/** Whether a model name (`fable`, `claude-fable-5-1`, …) runs on the scoped weekly window. */
export function checkIsScopedWeeklyModel(model: string | null): boolean {
  return model !== null && /fable/i.test(model);
}

/** The windows that bound a launch of `model`: the session window plus the weekly one the model drains. */
export function getRelevantClaudeUsageKinds(model: string | null): ClaudeUsageBucketKind[] {
  return ['session', checkIsScopedWeeklyModel(model) ? 'weekly_scoped' : 'weekly_all'];
}

/** What the ranking needs to know about one profile (the bot reads it off state, the CLI off state.json). */
export interface ClaudeProfileUsageView {
  name: string;
  configDir: string | null;
  loggedIn: boolean | undefined;
  email: string | null;
  subscriptionType: string | null;
  usage: ClaudeUsageSnapshot | undefined;
  limitedUntil: string | null;
}

/** One profile in the report the MCP tool and the CLI hand to an agent. */
export interface ClaudeProfileReportEntry {
  name: string;
  /** The `CLAUDE_CONFIG_DIR` to launch under; `null` for the default profile (set nothing). */
  configDir: string | null;
  email: string | null;
  kind: ClaudeAccountKind;
  subscriptionType: string | null;
  /** `null` when never probed. */
  loggedIn: boolean | null;
  buckets: ClaudeUsageBucket[];
  usageFetchedAt: string | null;
  isUsageStale: boolean;
  limitedUntil: string | null;
  /** Signed in, not limited, and not at 100 % on a window the model drains. */
  isEligible: boolean;
  /** `100 − max(relevant percent)`; `null` when the usage is unknown. */
  headroomPercent: number | null;
  isRecommended: boolean;
}

export interface ClaudeProfilesReport {
  model: string | null;
  /** The windows the ranking looked at for `model`. */
  relevantBuckets: ClaudeUsageBucketKind[];
  /** The profile a new process of `model` should run on; `null` when none is eligible. */
  recommended: string | null;
  profiles: ClaudeProfileReportEntry[];
}

/**
 * @description Rank the profiles for a launch of `model`: a profile that is signed out, marked limited
 * (`limitedUntil` in the future) or at 100 % on a relevant window is out; the rest are ordered by headroom on
 * the relevant windows (most first; unknown usage ranks after any known one; a tie goes to the lower total of
 * the relevant percentages). The first in that order is `recommended`. The entries keep the input order.
 */
export function buildClaudeProfilesReport(profiles: readonly ClaudeProfileUsageView[], model: string | null, nowMs: number): ClaudeProfilesReport {
  const relevantBuckets = getRelevantClaudeUsageKinds(model);
  const entries = profiles.map((profile): ClaudeProfileReportEntry => {
    const relevant = relevantBuckets
      .map((kind) => getClaudeUsageBucket(profile.usage, kind))
      .filter((bucket): bucket is ClaudeUsageBucket => bucket !== null);
    const maxPercent = relevant.length === 0 ? null : Math.max(...relevant.map((bucket) => bucket.percent));
    const isLimited = profile.limitedUntil !== null && Date.parse(profile.limitedUntil) > nowMs;
    const isEligible = profile.loggedIn !== false && !isLimited && (maxPercent === null || maxPercent < 100);
    return {
      name: profile.name,
      configDir: profile.configDir,
      email: profile.email,
      kind: getClaudeAccountKind(profile.subscriptionType),
      subscriptionType: profile.subscriptionType,
      loggedIn: profile.loggedIn ?? null,
      buckets: profile.usage?.buckets ?? [],
      usageFetchedAt: profile.usage?.fetchedAt ?? null,
      isUsageStale: profile.usage?.isStale === true,
      limitedUntil: profile.limitedUntil,
      isEligible,
      headroomPercent: maxPercent === null ? null : 100 - maxPercent,
      isRecommended: false,
    };
  });
  const ranked = entries
    .filter((entry) => entry.isEligible)
    .sort((a, b) => {
      if (a.headroomPercent === null || b.headroomPercent === null) {
        return (a.headroomPercent === null ? 1 : 0) - (b.headroomPercent === null ? 1 : 0);
      }
      if (a.headroomPercent !== b.headroomPercent) return b.headroomPercent - a.headroomPercent;
      return sumRelevantPercent(a, relevantBuckets) - sumRelevantPercent(b, relevantBuckets);
    });
  const recommended = ranked[0] ?? null;
  if (recommended) recommended.isRecommended = true;
  return { model, relevantBuckets, recommended: recommended?.name ?? null, profiles: entries };
}

function sumRelevantPercent(entry: ClaudeProfileReportEntry, kinds: readonly ClaudeUsageBucketKind[]): number {
  return entry.buckets.filter((bucket) => kinds.includes(bucket.kind)).reduce((sum, bucket) => sum + bucket.percent, 0);
}

/**
 * @description The ranking's view of every profile off the registry: `default` (its hidden record, when the
 * bot has written one) first, then the added profiles in creation order. Shared by the bot (live state) and
 * the CLI (`state.json` read directly).
 */
export function buildClaudeProfileUsageViews(input: {
  dataDir: string;
  /** Every record, the hidden `default` one included (`StateStore.getClaudeProfileInfo` / the raw file). */
  records: Readonly<Record<string, ClaudeProfileRecord>>;
}): ClaudeProfileUsageView[] {
  // A `default` the operator signed out through /accounts stays out of every ranking until it is signed in again.
  const isDefaultRemoved = input.records.default?.isRemoved === true;
  const toView = (name: string, record: ClaudeProfileRecord | undefined): ClaudeProfileUsageView => ({
    name,
    configDir: resolveClaudeProfileDir(input.dataDir, name),
    loggedIn: record?.loggedIn,
    email: record?.email ?? null,
    subscriptionType: record?.subscriptionType ?? null,
    usage: record?.usage,
    limitedUntil: record?.limitedUntil ?? null,
  });
  const added = Object.entries(input.records)
    .filter(([name]) => name !== 'default')
    .sort(([, a], [, b]) => a.createdAt.localeCompare(b.createdAt));
  return [...(isDefaultRemoved ? [] : [toView('default', input.records.default)]), ...added.map(([name, record]) => toView(name, record))];
}

/** The profile registry as `state.json` holds it — the CLI's read, no `StateStore` (which would migrate and lock). */
export function readClaudeProfileRecordsFromStateFile(dataDir: string): Readonly<Record<string, ClaudeProfileRecord>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  } catch {
    return {};
  }
  const records = checkIsRecord(parsed) && checkIsRecord(parsed.claudeProfiles) ? parsed.claudeProfiles : {};
  const result: Record<string, ClaudeProfileRecord> = {};
  for (const [name, record] of Object.entries(records)) {
    if (checkIsRecord(record) && typeof record.createdAt === 'string') result[name] = record as unknown as ClaudeProfileRecord;
  }
  return result;
}

// ── rendering ──

/**
 * @description A reset instant for a human, in the instance zone: `16:00` when it is today there, `Sat 00:00`
 * within the week, `17.10 00:00` beyond. The weekday is English on purpose (a three-letter token every locale
 * reads; the surrounding line is localised).
 */
export function formatClaudeUsageResetAt(resetsAt: string | null, timezone: string, nowMs: number): string {
  if (resetsAt === null) return '?';
  const exact = Date.parse(resetsAt);
  if (Number.isNaN(exact)) return '?';
  // Windows reset on a minute boundary; the endpoint's instant carries jitter below a second (`13:00:00.40`,
  // once `12:59:59.9`), which must not read as a minute earlier.
  const at = Math.round(exact / 60_000) * 60_000;
  const read = (options: Intl.DateTimeFormatOptions, instant: number): string =>
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hourCycle: 'h23', ...options }).format(instant);
  const time = read({ hour: '2-digit', minute: '2-digit' }, at);
  const dayOf = (instant: number) => read({ year: 'numeric', month: '2-digit', day: '2-digit' }, instant);
  if (dayOf(at) === dayOf(nowMs)) return time;
  if (at - nowMs < 6 * 24 * 3_600_000) return `${read({ weekday: 'short' }, at)} ${time}`;
  return `${read({ day: '2-digit' }, at)}.${read({ month: '2-digit' }, at)} ${time}`;
}

/** The words a relative reset is spelled with: `pattern` carries `{time}`, the units are appended to their numbers. */
export interface ClaudeRelativeResetWords {
  pattern: string;
  day: string;
  hour: string;
  minute: string;
}

/** English words, the CLI's (the bot passes its localised ones). */
export const englishRelativeResetWords: ClaudeRelativeResetWords = { pattern: '🔄 in {time}', day: 'd', hour: 'h', minute: 'm' };

/**
 * @description A reset instant as a time from now: `🔄 in 2d 1h`, `🔄 in 2h`, `🔄 in 30m`. The two largest
 * units at most, minutes only under an hour: from a day up it is days + hours (hours dropped when zero), from
 * an hour up whole hours (rounded), below that minutes (at least one). An instant already past reads as
 * `🔄 in 1m` (the window is about to roll over). `?` for a missing or unparseable instant.
 */
export function formatClaudeUsageRelativeReset(resetsAt: string | null, nowMs: number, words: ClaudeRelativeResetWords = englishRelativeResetWords): string {
  if (resetsAt === null) return '?';
  const at = Date.parse(resetsAt);
  if (Number.isNaN(at)) return '?';
  const totalMinutes = Math.max(1, Math.round((at - nowMs) / 60_000));
  let time: string;
  if (totalMinutes < 60) {
    time = `${totalMinutes}${words.minute}`;
  } else if (totalMinutes < 24 * 60) {
    // 23h40m rounds to 24h: that is a day.
    time = totalMinutes / 60 >= 23.5 ? `1${words.day}` : `${Math.round(totalMinutes / 60)}${words.hour}`;
  } else {
    let days = Math.floor(totalMinutes / 1440);
    let hours = Math.round((totalMinutes % 1440) / 60);
    if (hours === 24) { days += 1; hours = 0; }
    time = hours === 0 ? `${days}${words.day}` : `${days}${words.day} ${hours}${words.hour}`;
  }
  return words.pattern.replace('{time}', time);
}

/**
 * @description `81% → 🔄 in 2h` for a bucket, `—` for a missing one. A bucket whose reset is unknown shows
 * `fallbackResetsAt` instead (the session window's reset is often missing while the weekly one is known).
 */
export function formatClaudeUsageBucket(
  bucket: ClaudeUsageBucket | null,
  nowMs: number,
  options: { fallbackResetsAt?: string | null; words?: ClaudeRelativeResetWords } = {},
): string {
  if (bucket === null) return '—';
  const known = bucket.resetsAt !== null && !Number.isNaN(Date.parse(bucket.resetsAt));
  const resetsAt = known ? bucket.resetsAt : options.fallbackResetsAt ?? null;
  return `${bucket.percent}% → ${formatClaudeUsageRelativeReset(resetsAt, nowMs, options.words)}`;
}

// ── small readers ──

function checkIsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readIso(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}
