/**
 * @description Per-profile Claude USAGE — how much of each subscription window an account profile
 * (`utils/claudeProfiles.ts`) has used, and which profile a process should run on: a NEW agent goes to the
 * account whose weekly window resets soonest (spend first what burns soonest), a WARM session stays on the
 * account it worked on ({@link getClaudeLaunchPick}).
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
import { getClaudeAccountKind, resolveClaudeProfileDir, resolveHomeClaudeDir, type ClaudeAccountKind, type ClaudeProfileBilling } from './claudeProfiles';
import type { ClaudeApiSpend } from './claudeApiSpend';

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

export type UsageFetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;

/** What one GET of a usage endpoint needs: where, with which headers, and how its body becomes buckets. */
export interface UsageEndpointRequest {
  url: string;
  headers: Record<string, string>;
  parse: (body: unknown) => ClaudeUsageBucket[];
  fetchImpl?: UsageFetchLike;
  timeoutMs?: number;
}

/**
 * @description One GET of a usage endpoint, the shared mechanics of every subscription usage reader (Claude's own, the
 * ChatGPT one of `openCodeUsage.ts`): a 401/403 is an auth error (the token is no longer accepted — the CLI's next run
 * renews it), anything else non-200 a plain failure, an empty parse a failure too. Never throws; the headers (the token)
 * never appear in the result.
 */
export async function fetchUsageBuckets(request: UsageEndpointRequest): Promise<ClaudeUsageFetchResult> {
  const fetchImpl: UsageFetchLike = request.fetchImpl ?? (globalThis.fetch as unknown as UsageFetchLike);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? claudeUsageFetchTimeoutMs);
  try {
    const response = await fetchImpl(request.url, { headers: request.headers, signal: controller.signal });
    if (response.status === 401 || response.status === 403) return { ok: false, error: `http ${response.status}`, isAuthError: true };
    if (response.status !== 200) return { ok: false, error: `http ${response.status}`, isAuthError: false };
    const buckets = request.parse(await response.json());
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
 * @description One GET of the Claude usage endpoint with the profile's token (see {@link fetchUsageBuckets}).
 */
export async function fetchClaudeUsage(
  token: string,
  options: { fetchImpl?: UsageFetchLike; timeoutMs?: number } = {},
): Promise<ClaudeUsageFetchResult> {
  return fetchUsageBuckets({
    url: claudeUsageEndpoint,
    headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': claudeOAuthBetaHeader, Accept: 'application/json' },
    parse: parseClaudeUsageResponse,
    ...options,
  });
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

/** Whether a model name (`fable`, `claude-fable-5-1`, …) also drains Fable's own weekly window. */
export function checkIsScopedWeeklyModel(model: string | null): boolean {
  return model !== null && /fable/i.test(model);
}

/**
 * The windows that bound a launch of `model`. The session window and the weekly «all models» window are shared by EVERY model,
 * Fable included; Fable additionally drains its own weekly window (`weekly_scoped`). So an exhausted shared window stops Fable
 * too, while an exhausted Fable window stops Fable alone.
 */
export function getRelevantClaudeUsageKinds(model: string | null): ClaudeUsageBucketKind[] {
  return checkIsScopedWeeklyModel(model) ? ['session', 'weekly_all', 'weekly_scoped'] : ['session', 'weekly_all'];
}

/**
 * @description Whether every window a launch of `model` drains is KNOWN and below 100 % — the model is clear of an exhausted
 * window: a Fable-only weekly limit does not stop `sonnet`, while an exhausted session or shared weekly window stops every
 * model, Fable included. Unknown figures (no snapshot, a window the snapshot lacks) are `false`: a limit nobody can tell the
 * scope of is taken to cover the model. A stale snapshot still counts — its last figures are the best there are.
 */
export function checkHasHeadroomForClaudeModel(usage: ClaudeUsageSnapshot | undefined, model: string | null): boolean {
  return getRelevantClaudeUsageKinds(model).every((kind) => {
    const bucket = getClaudeUsageBucket(usage, kind);
    return bucket !== null && bucket.percent < 100;
  });
}

/**
 * @description Whether the usage reading SHOWS a window `model` drains at 100 % NOW (`nowMs`) — the proof an
 * unconfirmed usage-limit wording lacks. Unknown figures prove nothing (`false`), unlike
 * {@link checkHasHeadroomForClaudeModel}, which takes an unknown window as covering the model; neither does an
 * out-of-date reading — a snapshot marked stale, or a 100 % window whose reset has passed since it was read.
 */
export function checkIsClaudeUsageExhausted(usage: ClaudeUsageSnapshot | undefined, model: string | null, nowMs: number): boolean {
  if (!usage || usage.isStale === true) return false;
  return getRelevantClaudeUsageKinds(model).some((kind) => {
    const bucket = getClaudeUsageBucket(usage, kind);
    if (!bucket || bucket.percent < 100) return false;
    const resetsAtMs = bucket.resetsAt === null ? Number.NaN : Date.parse(bucket.resetsAt);
    return !(Number.isFinite(resetsAtMs) && resetsAtMs <= nowMs);
  });
}

/**
 * @description Whether a pick of `pickedModel`, on the account a usage limit stopped while it ran `limitedModel`, is clear of that
 * limit. The window that stopped the limited model is one of the windows IT drains, so a picked model that drains all of them
 * (the same model, a model on the same windows, or Fable after any other model — Fable drains the shared windows too) is covered
 * by the limit however far the figures lag behind it. Only a model draining FEWER windows — a non-Fable model after Fable, which
 * may have stopped on its own weekly window alone — is judged by {@link checkHasHeadroomForClaudeModel}. An unknown
 * `limitedModel` leaves it to the figures.
 */
export function checkIsClaudeModelClearOfLimit(usage: ClaudeUsageSnapshot | undefined, limitedModel: string | null, pickedModel: string): boolean {
  if (limitedModel !== null) {
    const pickedKinds = getRelevantClaudeUsageKinds(pickedModel);
    if (getRelevantClaudeUsageKinds(limitedModel).every((kind) => pickedKinds.includes(kind))) return false;
  }
  return checkHasHeadroomForClaudeModel(usage, pickedModel);
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
  /** How the account pays; `null` when never recorded (a subscription account added before billing was). */
  billing: ClaudeProfileBilling | null;
  /** When its prepaid API credits were found used up; `null` while they are not (or the operator acted since). */
  creditExhaustedAt: string | null;
  /** What an account billed to API credits spent through the bot; absent before its first counted turn. */
  apiSpend?: ClaudeApiSpend;
}

/** One profile in the report the MCP tool and the CLI hand to an agent. */
export interface ClaudeProfileReportEntry {
  name: string;
  /** The `CLAUDE_CONFIG_DIR` to launch under; `null` for the default profile (set nothing). */
  configDir: string | null;
  email: string | null;
  kind: ClaudeAccountKind;
  subscriptionType: string | null;
  /**
   * `api`: billed per request to a Claude Console organization's API credits — no windows, so no headroom figure, and
   * NEVER picked for a NEW agent (it would look inexhaustible and spend money); only a warm session already on it stays.
   * `null`: a subscription not recorded as such.
   */
  billing: ClaudeProfileBilling | null;
  /** `null` when never probed. */
  loggedIn: boolean | null;
  buckets: ClaudeUsageBucket[];
  usageFetchedAt: string | null;
  isUsageStale: boolean;
  limitedUntil: string | null;
  /** When its prepaid API credits were found used up (`null`: not marked). */
  creditExhaustedAt: string | null;
  /** Signed in, not limited, its API credits not used up, and not at 100 % on a window the model drains — by the figures AS RECORDED. */
  isEligible: boolean;
  /** `100 − max(relevant percent)`; `null` when the usage is unknown. Informational: the pick ranks by reset, not by headroom. */
  headroomPercent: number | null;
  /** The profile {@link getClaudeLaunchPick} chose (the figures read as of now). */
  isRecommended: boolean;
}

export interface ClaudeProfilesReport {
  model: string | null;
  /** The windows the pick looked at for `model`. */
  relevantBuckets: ClaudeUsageBucketKind[];
  /** The profile a process of `model` should run on (see {@link getClaudeLaunchPick}); `null` when none is usable. */
  recommended: string | null;
  /** Why `recommended` is what it is. */
  pickReason: ClaudeLaunchPickReason;
  /** With nothing usable: the account and instant that frees up first, so a resume can be scheduled for it. */
  nextAvailable: ClaudeNextAvailable | null;
  profiles: ClaudeProfileReportEntry[];
}

// ── the launch pick ──

/** A new agent never starts on an account whose five-hour window is already this full: it would hit the limit within minutes. */
export const claudeLaunchSessionCeilingPercent = 90;

/** Two weekly resets closer than this count as the same moment (the endpoint's instants carry sub-second jitter); the five-hour percent then decides. */
export const claudeLaunchResetTieMs = 60_000;

export const claudeWeeklyWindowMs = 7 * 24 * 3_600_000;
export const claudeSessionWindowMs = 5 * 3_600_000;

/** `warm`: the session stays on its account; `movedFromLimited`: it was stopped by a limit and goes elsewhere; `soonestWeeklyReset`: a new agent; `none`: nothing is usable. */
export type ClaudeLaunchPickReason = 'warm' | 'movedFromLimited' | 'soonestWeeklyReset' | 'none';

/** The account that frees up first and the ISO instant it does. */
export interface ClaudeNextAvailable {
  profile: string;
  at: string;
}

export interface ClaudeLaunchPick {
  pick: string | null;
  reason: ClaudeLaunchPickReason;
  nextAvailable: ClaudeNextAvailable | null;
}

/** What the pick needs besides the profiles, the model and the clock. */
export interface ClaudeLaunchPickOptions {
  /** The account a WARM session last ran on; absent for a new agent (an unknown name counts as absent). */
  currentProfile?: string | null;
  /** The session broke off on a usage limit of `currentProfile`: it is left out of this answer whatever the figures say. */
  isStoppedByLimit?: boolean;
  /** Accounts the operator switched off in the `/limits` list (every rung disabled): never picked for a new agent. */
  excludedNames?: ReadonlySet<string>;
}

/**
 * The account itself can run: signed in, not marked limited, its API credits not used up, and none of the windows
 * the model drains (`relevantBuckets`, read by the caller) at 100 %. The one hard-eligibility rule of the report's
 * `isEligible` (figures as recorded) and of the launch pick (figures as of now).
 */
function checkIsClaudeProfileEligible(profile: ClaudeProfileUsageView, relevantBuckets: readonly ClaudeUsageBucket[], nowMs: number): boolean {
  const isLimited = profile.limitedUntil !== null && Date.parse(profile.limitedUntil) > nowMs;
  return profile.loggedIn !== false && !isLimited && profile.creditExhaustedAt === null && relevantBuckets.every((bucket) => bucket.percent < 100);
}

/** The reset instant in epoch ms; `NaN` when the bucket names none. */
function getBucketResetMs(bucket: ClaudeUsageBucket): number {
  return bucket.resetsAt === null ? Number.NaN : Date.parse(bucket.resetsAt);
}

function getRelevantClaudeUsageBuckets(usage: ClaudeUsageSnapshot | undefined, model: string | null): ClaudeUsageBucket[] {
  return getRelevantClaudeUsageKinds(model)
    .map((kind) => getClaudeUsageBucket(usage, kind))
    .filter((bucket): bucket is ClaudeUsageBucket => bucket !== null);
}

/**
 * A bucket as it stands at `nowMs`: a window whose reset instant has passed since the figure was read is empty again
 * (0 %) and resets one window length per elapsed period later. A bucket without a usable reset stays as read.
 */
function readClaudeBucketAsOf(bucket: ClaudeUsageBucket, nowMs: number): ClaudeUsageBucket {
  const resetMs = getBucketResetMs(bucket);
  if (!Number.isFinite(resetMs) || resetMs > nowMs) return bucket;
  const windowMs = bucket.kind === 'session' ? claudeSessionWindowMs : claudeWeeklyWindowMs;
  const rolledMs = resetMs + (Math.floor((nowMs - resetMs) / windowMs) + 1) * windowMs;
  return { ...bucket, percent: 0, resetsAt: new Date(rolledMs).toISOString() };
}

function getRelevantClaudeBucketsAsOf(profile: ClaudeProfileUsageView, model: string | null, nowMs: number): ClaudeUsageBucket[] {
  return getRelevantClaudeUsageBuckets(profile.usage, model).map((bucket) => readClaudeBucketAsOf(bucket, nowMs));
}

/**
 * @description Whether a NEW agent of `model` may start on the profile now: a subscription account that is eligible by the
 * figures as of `nowMs` and whose five-hour window is below {@link claudeLaunchSessionCeilingPercent}. Switching it off
 * in the `/limits` list is the caller's filter.
 */
export function checkIsClaudeProfileLaunchable(profile: ClaudeProfileUsageView, model: string | null, nowMs: number): boolean {
  if (profile.billing === 'api') return false;
  const buckets = getRelevantClaudeBucketsAsOf(profile, model, nowMs);
  if (!checkIsClaudeProfileEligible(profile, buckets, nowMs)) return false;
  const session = buckets.find((bucket) => bucket.kind === 'session');
  return session === undefined || session.percent < claudeLaunchSessionCeilingPercent;
}

interface ClaudeLaunchRankKey<T extends ClaudeProfileUsageView> {
  profile: T;
  index: number;
  /** The soonest reset among the weekly windows the model drains (the shared one; for Fable the earlier of it and Fable's own); `null` when none is known. */
  weeklyResetMs: number | null;
  /** `null` when the five-hour window is unknown. */
  sessionPercent: number | null;
  hasUsage: boolean;
}

/** 0: a known weekly reset; 1: a snapshot without one; 2: no snapshot at all. */
function getRankTier(key: ClaudeLaunchRankKey<ClaudeProfileUsageView>): number {
  if (key.weeklyResetMs !== null) return 0;
  return key.hasUsage ? 1 : 2;
}

function compareRankKeysBySession(a: ClaudeLaunchRankKey<ClaudeProfileUsageView>, b: ClaudeLaunchRankKey<ClaudeProfileUsageView>): number {
  const aSession = a.sessionPercent ?? Number.POSITIVE_INFINITY;
  const bSession = b.sessionPercent ?? Number.POSITIVE_INFINITY;
  if (aSession !== bSession) return aSession < bSession ? -1 : 1;
  return a.index - b.index;
}

/**
 * @description The profiles in the order a launch of `model` prefers them: the soonest weekly reset first (the figures as of
 * `nowMs`: a passed reset rolled forward), an unknown reset after every known one, no snapshot last. Resets within
 * {@link claudeLaunchResetTieMs} of the group's first count as one moment, ordered by the lower five-hour percent, then by
 * input order. Pure ordering: the caller filters who may be picked at all. Shared by the report's pick and the bot's
 * own topic switch (`claudeLimitSwitch.ts`) — ONE ranking.
 */
export function sortClaudeProfilesByLaunchRank<T extends ClaudeProfileUsageView>(profiles: readonly T[], model: string | null, nowMs: number): T[] {
  const keys = profiles.map((profile, index): ClaudeLaunchRankKey<T> => {
    const buckets = getRelevantClaudeBucketsAsOf(profile, model, nowMs);
    const resets = buckets
      .filter((bucket) => bucket.kind !== 'session')
      .map(getBucketResetMs)
      .filter((resetMs) => Number.isFinite(resetMs));
    return {
      profile,
      index,
      weeklyResetMs: resets.length === 0 ? null : Math.min(...resets),
      sessionPercent: buckets.find((bucket) => bucket.kind === 'session')?.percent ?? null,
      hasUsage: (profile.usage?.buckets.length ?? 0) > 0,
    };
  });
  keys.sort((a, b) => getRankTier(a) - getRankTier(b) || (a.weeklyResetMs ?? 0) - (b.weeklyResetMs ?? 0) || a.index - b.index);
  // A tie group is anchored at its first member, so the rule is a partition, not a comparator that could contradict itself.
  const ordered: T[] = [];
  let group: ClaudeLaunchRankKey<T>[] = [];
  const flushGroup = (): void => {
    ordered.push(...group.sort(compareRankKeysBySession).map((key) => key.profile));
    group = [];
  };
  for (const key of keys) {
    const anchor = group[0];
    const isTied = anchor !== undefined
      && getRankTier(anchor) === getRankTier(key)
      && (key.weeklyResetMs === null || anchor.weeklyResetMs === null || key.weeklyResetMs - anchor.weeklyResetMs <= claudeLaunchResetTieMs);
    if (anchor !== undefined && !isTied) flushGroup();
    group.push(key);
  }
  flushGroup();
  return ordered;
}

/**
 * The instant the profile becomes usable for a new agent once every blocker clears: its limited mark, a weekly window the
 * model drains at 100 %, a five-hour window at the launch ceiling (each at its reset, figures as of now). `nowMs` when
 * nothing blocks it; `null` when a blocker names no reset (nobody can tell when it frees up).
 */
function getClaudeProfileFreeAtMs(profile: ClaudeProfileUsageView, model: string | null, nowMs: number): number | null {
  let freeAtMs = nowMs;
  const limitedUntilMs = profile.limitedUntil === null ? Number.NaN : Date.parse(profile.limitedUntil);
  if (Number.isFinite(limitedUntilMs) && limitedUntilMs > nowMs) freeAtMs = limitedUntilMs;
  for (const bucket of getRelevantClaudeBucketsAsOf(profile, model, nowMs)) {
    const ceilingPercent = bucket.kind === 'session' ? claudeLaunchSessionCeilingPercent : 100;
    if (bucket.percent < ceilingPercent) continue;
    const resetMs = getBucketResetMs(bucket);
    if (!Number.isFinite(resetMs)) return null;
    freeAtMs = Math.max(freeAtMs, resetMs);
  }
  return freeAtMs;
}

/** The subscription account that frees up first, when nothing is usable now; `null` when no account names a time. */
function getClaudeNextAvailable(profiles: readonly ClaudeProfileUsageView[], model: string | null, nowMs: number, excludedNames: ReadonlySet<string>): ClaudeNextAvailable | null {
  let next: { profile: string; atMs: number } | null = null;
  for (const profile of profiles) {
    // These never come back at a known time: switched off, signed out, API-billed, out of credits.
    if (excludedNames.has(profile.name) || profile.loggedIn === false || profile.billing === 'api' || profile.creditExhaustedAt !== null) continue;
    const freeAtMs = getClaudeProfileFreeAtMs(profile, model, nowMs);
    if (freeAtMs === null || freeAtMs <= nowMs) continue;
    if (next === null || freeAtMs < next.atMs) next = { profile: profile.name, atMs: freeAtMs };
  }
  return next === null ? null : { profile: next.profile, at: new Date(next.atMs).toISOString() };
}

/**
 * @description The account a process of `model` should run on.
 *
 * NEW agent (no `currentProfile`): of the USABLE accounts — subscription, signed in, not marked limited, not out of API
 * credits, not switched off (`excludedNames`), every weekly window the model drains below 100 % and the five-hour window
 * below {@link claudeLaunchSessionCeilingPercent} — the one whose weekly window resets soonest
 * ({@link sortClaudeProfilesByLaunchRank}): spend first what burns first, and move to a farther reset only when the
 * five-hour window is exhausted. Fable's own window at 100 % takes only Fable out.
 *
 * WARM session (`currentProfile` known): it stays on that account unless the account is signed out, marked limited, out
 * of API credits or at 100 % on a window the model drains — the ceiling does not apply, and an API-billed account the
 * session already works on is kept (the spend was approved). `isStoppedByLimit` takes `currentProfile` out of the answer
 * whatever the figures say (they may lag the limit); the rest follows the new-agent rule.
 *
 * Nothing usable → `pick: null` and {@link ClaudeLaunchPick.nextAvailable}.
 */
export function getClaudeLaunchPick(input: ClaudeLaunchPickOptions & {
  profiles: readonly ClaudeProfileUsageView[];
  model: string | null;
  nowMs: number;
}): ClaudeLaunchPick {
  const excludedNames = input.excludedNames ?? new Set<string>();
  const current = input.currentProfile ? input.profiles.find((profile) => profile.name === input.currentProfile) : undefined;
  if (current && input.isStoppedByLimit !== true
    && checkIsClaudeProfileEligible(current, getRelevantClaudeBucketsAsOf(current, input.model, input.nowMs), input.nowMs)) {
    return { pick: current.name, reason: 'warm', nextAvailable: null };
  }
  const movedFrom = current && input.isStoppedByLimit === true ? current.name : null;
  const usable = input.profiles.filter((profile) => profile.name !== movedFrom
    && !excludedNames.has(profile.name)
    && checkIsClaudeProfileLaunchable(profile, input.model, input.nowMs));
  const [first] = sortClaudeProfilesByLaunchRank(usable, input.model, input.nowMs);
  if (first) return { pick: first.name, reason: movedFrom === null ? 'soonestWeeklyReset' : 'movedFromLimited', nextAvailable: null };
  return { pick: null, reason: 'none', nextAvailable: getClaudeNextAvailable(input.profiles, input.model, input.nowMs, excludedNames) };
}

/**
 * @description The report of every profile for a launch of `model`, with the pick of {@link getClaudeLaunchPick}
 * (`options`: the warm account, the limit stop, the switched-off accounts). `isEligible` is the strict reading — signed in,
 * not marked limited, its API credits not used up, not at 100 % on a relevant window as recorded — which the explicit
 * fallback chain's availability reads; `recommended` is the pick, an account billed to API credits only when a warm
 * session already runs on it. The entries keep the input order.
 */
export function buildClaudeProfilesReport(profiles: readonly ClaudeProfileUsageView[], model: string | null, nowMs: number, options: ClaudeLaunchPickOptions = {}): ClaudeProfilesReport {
  const relevantBuckets = getRelevantClaudeUsageKinds(model);
  const entries = profiles.map((profile): ClaudeProfileReportEntry => {
    const relevant = getRelevantClaudeUsageBuckets(profile.usage, model);
    const maxPercent = relevant.length === 0 ? null : Math.max(...relevant.map((bucket) => bucket.percent));
    return {
      name: profile.name,
      configDir: profile.configDir,
      email: profile.email,
      kind: getClaudeAccountKind(profile.subscriptionType),
      subscriptionType: profile.subscriptionType,
      billing: profile.billing,
      loggedIn: profile.loggedIn ?? null,
      buckets: profile.usage?.buckets ?? [],
      usageFetchedAt: profile.usage?.fetchedAt ?? null,
      isUsageStale: profile.usage?.isStale === true,
      limitedUntil: profile.limitedUntil,
      creditExhaustedAt: profile.creditExhaustedAt,
      isEligible: checkIsClaudeProfileEligible(profile, relevant, nowMs),
      headroomPercent: maxPercent === null ? null : 100 - maxPercent,
      isRecommended: false,
    };
  });
  const launch = getClaudeLaunchPick({ ...options, profiles, model, nowMs });
  const recommended = entries.find((entry) => entry.name === launch.pick);
  if (recommended) recommended.isRecommended = true;
  return { model, relevantBuckets, recommended: launch.pick, pickReason: launch.reason, nextAvailable: launch.nextAvailable, profiles: entries };
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
    billing: record?.billing ?? null,
    creditExhaustedAt: record?.creditExhaustedAt ?? null,
    ...(record?.apiSpend ? { apiSpend: record.apiSpend } : {}),
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
 * @description `81% 🔄 in 2h` for a bucket, `—` for a missing one. A bucket whose reset is unknown shows
 * `fallbackResetsAt` instead (the session window's reset is often missing while the weekly one is known);
 * with neither it is the bare percent — a «?» after a number would read as a doubt about the number.
 */
export function formatClaudeUsageBucket(
  bucket: ClaudeUsageBucket | null,
  nowMs: number,
  options: { fallbackResetsAt?: string | null; words?: ClaudeRelativeResetWords } = {},
): string {
  if (bucket === null) return '—';
  const known = bucket.resetsAt !== null && !Number.isNaN(Date.parse(bucket.resetsAt));
  const resetsAt = known ? bucket.resetsAt : options.fallbackResetsAt ?? null;
  if (resetsAt === null || Number.isNaN(Date.parse(resetsAt))) return `${bucket.percent}%`;
  return `${bucket.percent}% ${formatClaudeUsageRelativeReset(resetsAt, nowMs, options.words)}`;
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
