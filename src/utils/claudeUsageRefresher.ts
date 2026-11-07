/**
 * @description The usage poller behind `/account`, the `claude_profiles` MCP tool and the stream frames: keeps
 * one `ClaudeUsageSnapshot` per account profile current (`utils/claudeUsage.ts`), reading every signed-in
 * profile's own token — and, beside them, the usage of the OpenCode subscriptions (`utils/openCodeUsage.ts`). Runs on a modest timer (`claudeUsageRefreshIntervalMs`), on `/account` open and on
 * demand (`refreshAll({ maxAgeMs })` skips a snapshot fresher than that), and folds in the `rate_limit_event`
 * windows a json-stream session reports (`noteStreamWindows`), persisting only when a bucket actually moved.
 *
 * A profile whose token has expired is NOT refreshed here (the CLI renews tokens; a bot-side refresh would
 * race it and could invalidate the CLI's own) — its snapshot is marked stale instead. Every dependency is
 * injected, so the unit test drives it without the network, the file system or a `StateStore`.
 */

import type { ClaudeProfileBilling } from './claudeProfiles';
import { waitUpTo } from './waitUpTo';
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

/**
 * The longest ONE poll (a profile's, or the OpenCode providers') may run before the refresher gives up on it. Above the
 * fetch's own 15 s timeout, so a healthy abort is never cut short: it only fires when a poll outlives every timeout it has.
 * Without it the poll in flight is shared by every caller (the timer, `/limits`, the `claude_profiles` tool), so ONE poll
 * that never settles keeps all of them waiting for the rest of the process's life.
 */
export const claudeUsagePollDeadlineMs = 30_000;

/**
 * The longest the `claude_profiles` answer waits for fresh figures. A poll is ~0.5 s (6 s at its slowest in the tool's
 * history); past this the tool answers from the cached figures — each profile carries when they were read — and the refresh
 * goes on in the background. Well under the 300 s after which the agent's own client drops a silent tool call.
 */
export const claudeLaunchRefreshBudgetMs = 10_000;

export interface ClaudeUsageRefresherProfile {
  name: string;
  configDir: string | null;
  /** The last auth probe; a profile known to be signed out is skipped. */
  loggedIn: boolean | undefined;
  /**
   * An account billed to API credits (`api`) is never polled: it has no subscription windows, and a console login's
   * own token would only be refused by the usage endpoint and mark it stale for nothing.
   */
  billing?: ClaudeProfileBilling | null;
}

export interface ClaudeUsageRefresherDeps {
  listProfiles: () => ClaudeUsageRefresherProfile[];
  getSnapshot: (name: string) => ClaudeUsageSnapshot | undefined;
  saveSnapshot: (name: string, snapshot: ClaudeUsageSnapshot) => void;
  readToken: (configDir: string | null) => ClaudeOAuthToken | null;
  /** One GET of the usage endpoint; `signal` cancels it — the refresher aborts it when it gives up on the poll. */
  fetchUsage: (accessToken: string, signal?: AbortSignal) => Promise<ClaudeUsageFetchResult>;
  /**
   * The OpenCode providers' usage (`openCodeUsage.ts`) is polled on the same timer and by the same on-demand call; a
   * failure there never reaches the Claude profiles' polls. `signal` is the poll's cancel: once it is aborted the poll
   * saves nothing.
   */
  refreshOpenCode?: (options: { maxAgeMs?: number; signal?: AbortSignal }) => Promise<void>;
  /** The OpenCode twin of a profile's give-up mark: their stored figures are marked stale with `reason`. */
  markOpenCodeStale?: (reason: string) => void;
  /** {@link claudeUsagePollDeadlineMs} unless a test sets it. */
  pollDeadlineMs?: number;
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

/** The stale mark a poll that was given up on leaves on its figures. */
const usagePollGaveUpReason = 'usage poll did not finish';

/** The key of the OpenCode providers' poll beside the profiles' (a profile is keyed by its name). */
const openCodePollLabel = 'OpenCode providers';

/** One poll per target (a profile, or the OpenCode providers) may be pending; `done` ends when it settles or is given up on. */
interface PendingPoll {
  isAbandoned: boolean;
  done: Promise<void>;
}

type PollEnd = 'finished' | 'threw';

export function createClaudeUsageRefresher(deps: ClaudeUsageRefresherDeps): ClaudeUsageRefresher {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((line: string) => console.log(line));
  const pollDeadlineMs = deps.pollDeadlineMs ?? claudeUsagePollDeadlineMs;
  const pendingPolls = new Map<string, PendingPoll>();
  let inFlight: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;

  async function pollProfile(profile: ClaudeUsageRefresherProfile, signal: AbortSignal): Promise<void> {
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
    const result = await deps.fetchUsage(token.accessToken, signal);
    // The refresher gave up on this poll while it ran: a newer reading may have been stored since, so this one writes nothing.
    if (signal.aborted) return;
    if (!result.ok) {
      log(`[usage] ${profile.name}: usage poll failed (${result.error})`);
      deps.saveSnapshot(profile.name, markClaudeUsageSnapshotStale(previous, result.error, now()));
      return;
    }
    deps.saveSnapshot(profile.name, mergeClaudeUsageSnapshot(previous, result.buckets, 'api', now()));
  }

  /** Run a poll and log how it ended — whenever that is, so a failure after the deadline is seen too. Never rejects. */
  async function runLoggingFailure(label: string, poll: (signal: AbortSignal) => Promise<void>, signal: AbortSignal): Promise<PollEnd> {
    try {
      await poll(signal);
      return 'finished';
    } catch (e) {
      log(`[usage] ${label}: usage poll threw: ${e instanceof Error ? e.message : String(e)}`);
      return 'threw';
    }
  }

  /**
   * Run the poll of one target, waiting for it at most {@link claudeUsagePollDeadlineMs}. At the deadline the poll is given
   * up on: its request is cancelled, `markStale` leaves a stale mark on the figures, and it is left pending until it finally
   * settles — saving nothing, and logging when and how it ended — so a stuck target is never polled twice at once. A call for
   * a target whose earlier poll was given up on returns at once; one whose poll is still within its deadline joins it.
   */
  function runPoll(label: string, poll: (signal: AbortSignal) => Promise<void>, markStale: () => void): Promise<void> {
    const pending = pendingPolls.get(label);
    if (pending) return pending.isAbandoned ? Promise.resolve() : pending.done;
    const controller = new AbortController();
    const startedAtMs = now();
    const entry: PendingPoll = { isAbandoned: false, done: Promise.resolve() };
    pendingPolls.set(label, entry);
    const ended = runLoggingFailure(label, poll, controller.signal);
    void ended.then((end) => {
      if (pendingPolls.get(label) === entry) pendingPolls.delete(label);
      if (!entry.isAbandoned) return;
      const duration = `${((now() - startedAtMs) / 1000).toFixed(1)} s`;
      log(`[usage] ${label}: the abandoned usage poll ${end === 'finished' ? `finished after ${duration}; its answer was dropped` : `failed after ${duration}`}`);
    });
    entry.done = waitUpTo(ended.then(() => undefined), pollDeadlineMs).then((isSettled) => {
      if (isSettled) return;
      entry.isAbandoned = true;
      controller.abort();
      markStale();
      log(`[usage] ${label}: usage poll did not finish within ${pollDeadlineMs / 1000} s; not waiting for it any more`);
    });
    return entry.done;
  }

  function markProfileStale(name: string): void {
    deps.saveSnapshot(name, markClaudeUsageSnapshotStale(deps.getSnapshot(name), usagePollGaveUpReason, now()));
  }

  function runProfilePoll(profile: ClaudeUsageRefresherProfile): Promise<void> {
    return runPoll(profile.name, (signal) => pollProfile(profile, signal), () => markProfileStale(profile.name));
  }

  function checkNeedsPoll(profile: ClaudeUsageRefresherProfile, maxAgeMs: number | undefined): boolean {
    if (profile.loggedIn === false || profile.billing === 'api') return false;
    if (maxAgeMs === undefined) return true;
    const snapshot = deps.getSnapshot(profile.name);
    if (!snapshot || snapshot.isStale) return true;
    return now() - Date.parse(snapshot.fetchedAt) >= maxAgeMs;
  }

  async function refreshAll(options: { maxAgeMs?: number } = {}): Promise<void> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const due = deps.listProfiles().filter((profile) => checkNeedsPoll(profile, options.maxAgeMs));
      const refreshOpenCode = deps.refreshOpenCode;
      await Promise.all([
        ...due.map((profile) => runProfilePoll(profile)),
        refreshOpenCode && runPoll(
          openCodePollLabel,
          (signal) => refreshOpenCode({ ...options, signal }),
          () => deps.markOpenCodeStale?.(usagePollGaveUpReason),
        ),
      ]);
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  async function refreshOne(name: string): Promise<void> {
    const profile = deps.listProfiles().find((candidate) => candidate.name === name);
    if (profile && profile.billing !== 'api') await runProfilePoll(profile);
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

/**
 * @description The readings behind a launch pick (`claude_profiles`): when the session being resumed was STOPPED BY A
 * LIMIT, its account is re-read first, unconditionally — its cached figures may lag the limit that just hit — then every
 * other profile whose snapshot is older than `maxAgeMs`. Waits at most `budgetMs` ({@link claudeLaunchRefreshBudgetMs}) for the
 * whole of it; past that it logs one line and returns, and the caller answers from the cached figures. The refresh is not
 * cancelled: it finishes in the background.
 */
export async function refreshClaudeUsageForLaunch(
  refresher: Pick<ClaudeUsageRefresher, 'refreshOne' | 'refreshAll'>,
  options: { currentProfile: string | null; isStoppedByLimit: boolean; maxAgeMs: number; budgetMs?: number; log?: (line: string) => void },
): Promise<void> {
  const budgetMs = options.budgetMs ?? claudeLaunchRefreshBudgetMs;
  const log = options.log ?? ((line: string) => console.log(line));
  const refresh = async (): Promise<void> => {
    try {
      if (options.isStoppedByLimit && options.currentProfile !== null) await refresher.refreshOne(options.currentProfile);
      await refresher.refreshAll({ maxAgeMs: options.maxAgeMs });
    } catch (e) {
      // Whenever it fails — inside the budget or long after it — the answer is the cached figures, and the failure is on record.
      log(`[usage] claude_profiles: the usage refresh threw: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  if (!(await waitUpTo(refresh(), budgetMs))) {
    log(`[usage] claude_profiles: the usage refresh did not finish within ${budgetMs / 1000} s; answering from the cached figures`);
  }
}
