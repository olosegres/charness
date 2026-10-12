/**
 * @description The usage poller behind `/account`, the `claude_profiles` MCP tool and the stream frames: keeps
 * one `ClaudeUsageSnapshot` per account profile current (`utils/claudeUsage.ts`), reading every signed-in
 * profile's own token. Runs on a modest timer (`claudeUsageRefreshIntervalMs`), on `/account` open and on
 * demand (`refreshAll({ maxAgeMs })` skips a snapshot fresher than that), and folds in the `rate_limit_event`
 * windows a json-stream session reports (`noteStreamWindows`), persisting only when a bucket actually moved.
 *
 * A profile whose token has expired is NOT refreshed here (the CLI renews tokens; a bot-side refresh would
 * race it and could invalidate the CLI's own) — its snapshot is marked stale instead. Every dependency is
 * injected, so the unit test drives it without the network, the file system or a `StateStore`.
 */

import {
  buildBucketsFromRateLimitWindows,
  checkClaudeUsageBucketsChanged,
  checkIsClaudeTokenExpired,
  markClaudeUsageSnapshotStale,
  mergeClaudeUsageSnapshot,
  type ClaudeOAuthToken,
  type ClaudeRateLimitWindow,
  type ClaudeUsageFetchResult,
  type ClaudeUsageSnapshot,
} from './claudeUsage';

export const claudeUsageRefreshIntervalMs = 10 * 60_000;

/** A snapshot younger than this is served as is by the on-demand readers (`/account`, the MCP tool). */
export const claudeUsageOnDemandMaxAgeMs = 60_000;

export interface ClaudeUsageRefresherProfile {
  name: string;
  configDir: string | null;
  /** The last auth probe; a profile known to be signed out is skipped. */
  loggedIn: boolean | undefined;
}

export interface ClaudeUsageRefresherDeps {
  listProfiles: () => ClaudeUsageRefresherProfile[];
  getSnapshot: (name: string) => ClaudeUsageSnapshot | undefined;
  saveSnapshot: (name: string, snapshot: ClaudeUsageSnapshot) => void;
  readToken: (configDir: string | null) => ClaudeOAuthToken | null;
  fetchUsage: (accessToken: string) => Promise<ClaudeUsageFetchResult>;
  now?: () => number;
  log?: (line: string) => void;
}

export interface ClaudeUsageRefresher {
  /** Poll every signed-in profile; with `maxAgeMs`, only those whose snapshot is older (or stale). One poll in flight at a time. */
  refreshAll: (options?: { maxAgeMs?: number }) => Promise<void>;
  /** Poll one profile now (a fresh sign-in, a tap). */
  refreshOne: (name: string) => Promise<void>;
  /** A json-stream frame's windows for the profile the session runs on. */
  noteStreamWindows: (name: string, windows: readonly ClaudeRateLimitWindow[]) => void;
  start: (intervalMs?: number) => void;
  stop: () => void;
}

export function createClaudeUsageRefresher(deps: ClaudeUsageRefresherDeps): ClaudeUsageRefresher {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((line: string) => console.log(line));
  let inFlight: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;

  async function pollProfile(profile: ClaudeUsageRefresherProfile): Promise<void> {
    const previous = deps.getSnapshot(profile.name);
    const token = deps.readToken(profile.configDir);
    if (token === null) {
      // No credentials on disk: nothing to poll, nothing to keep — an old snapshot of a signed-out directory is noise.
      if (previous && !previous.isStale) deps.saveSnapshot(profile.name, markClaudeUsageSnapshotStale(previous, 'not signed in', now()));
      return;
    }
    if (checkIsClaudeTokenExpired(token, now())) {
      if (!previous?.isStale || previous.error !== 'token expired') {
        deps.saveSnapshot(profile.name, markClaudeUsageSnapshotStale(previous, 'token expired', now()));
      }
      return;
    }
    const result = await deps.fetchUsage(token.accessToken);
    if (!result.ok) {
      log(`[usage] ${profile.name}: usage poll failed (${result.error})`);
      deps.saveSnapshot(profile.name, markClaudeUsageSnapshotStale(previous, result.error, now()));
      return;
    }
    deps.saveSnapshot(profile.name, mergeClaudeUsageSnapshot(previous, result.buckets, 'api', now()));
  }

  function checkNeedsPoll(profile: ClaudeUsageRefresherProfile, maxAgeMs: number | undefined): boolean {
    if (profile.loggedIn === false) return false;
    if (maxAgeMs === undefined) return true;
    const snapshot = deps.getSnapshot(profile.name);
    if (!snapshot || snapshot.isStale) return true;
    return now() - Date.parse(snapshot.fetchedAt) >= maxAgeMs;
  }

  async function refreshAll(options: { maxAgeMs?: number } = {}): Promise<void> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const due = deps.listProfiles().filter((profile) => checkNeedsPoll(profile, options.maxAgeMs));
      await Promise.all(due.map((profile) => pollProfile(profile).catch((e) => {
        log(`[usage] ${profile.name}: usage poll threw: ${e instanceof Error ? e.message : String(e)}`);
      })));
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  async function refreshOne(name: string): Promise<void> {
    const profile = deps.listProfiles().find((candidate) => candidate.name === name);
    if (profile) await pollProfile(profile);
  }

  function noteStreamWindows(name: string, windows: readonly ClaudeRateLimitWindow[]): void {
    const buckets = buildBucketsFromRateLimitWindows(windows);
    if (buckets.length === 0) return;
    const previous = deps.getSnapshot(name);
    if (!checkClaudeUsageBucketsChanged(previous, buckets)) return;
    deps.saveSnapshot(name, mergeClaudeUsageSnapshot(previous, buckets, 'stream', now()));
  }

  function start(intervalMs: number = claudeUsageRefreshIntervalMs): void {
    stop();
    timer = setInterval(() => { void refreshAll(); }, intervalMs);
    timer.unref?.();
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { refreshAll, refreshOne, noteStreamWindows, start, stop };
}
