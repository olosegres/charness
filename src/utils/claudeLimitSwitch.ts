/**
 * @description Pure decisions behind SWITCHING A TOPIC TO ANOTHER CLAUDE ACCOUNT when its own hits a usage
 * limit (`utils/claudeProfiles.ts`, `utils/claudeUsage.ts`): which profiles may take the work over, ranked like a
 * new agent's launch (the soonest weekly reset first), and until when the exhausted one is marked limited.
 * This ranking is what the fallback chain (`utils/fallbackChain.ts`) falls back to when the operator configured no
 * chain: the within-Claude account→account switch as it existed before the chain. The auto / offer decision, the
 * notice's buttons and the auto-switch toggle (`/limits_autoswitch`; ON by default, also with one account) live in
 * the chain module.
 *
 * No I/O, no `Date.now()`: the caller passes the clock and the profile views, so every rule is unit-tested.
 */

import {
  checkHaveClaudeUsageWindowsReset,
  checkIsClaudeProfileLaunchable,
  getClaudeUsageBucket,
  getRelevantClaudeUsageKinds,
  sortClaudeProfilesByLaunchRank,
  type ClaudeProfileUsageView,
  type ClaudeUsageSnapshot,
} from './claudeUsage';

/** The toggle's resolver (OFF when unset) lives beside `/auto_continue_limits`'s, where `state.ts` reads it. */
export { resolveClaudeAutoSwitchOnLimitEnabled } from './autoContinueOnLimit';

/**
 * @description The profiles that may take a topic's work over, best first: signed in, not marked limited, with
 * KNOWN and fresh usage that leaves room on the windows `model` drains — below 100 % on each, and the five-hour window
 * below the launch ceiling (`checkIsClaudeProfileLaunchable`) — and not the profile that just hit the limit. The order is
 * the launch pick's: the account whose weekly window resets soonest first (`sortClaudeProfilesByLaunchRank`), the one
 * ranking a new agent's account too. A profile whose usage is unknown or stale is left out on purpose — the switch is sold
 * as "this one has room", and a guess could land the topic in a second limit — except a stale one whose every window has
 * since passed its reset: only the old windows are known to be over (what the account has used since, through a login on
 * another machine or host user, is not visible here), but an idle account whose token expired (no CLI run renews it, no poll
 * can re-read it) would otherwise stay out for good; if it was used elsewhere in the meantime, the topic meets the limit
 * again and the chain moves it on. An account billed to API credits is never
 * one of them: it has no windows to have room on, and only the operator decides to spend money (the chain's rung).
 */
export function pickClaudeLimitSwitchCandidates(input: {
  profiles: readonly ClaudeProfileUsageView[];
  /** The profile the topic runs on — the one at its limit. */
  currentName: string;
  model: string | null;
  nowMs: number;
}): string[] {
  const kinds = getRelevantClaudeUsageKinds(input.model);
  const candidates = input.profiles.filter((profile) => profile.name !== input.currentName
    && profile.loggedIn === true
    && (profile.usage?.isStale !== true || checkHaveClaudeUsageWindowsReset(profile.usage, input.model, input.nowMs))
    && kinds.some((kind) => getClaudeUsageBucket(profile.usage, kind) !== null)
    && checkIsClaudeProfileLaunchable(profile, input.model, input.nowMs));
  return sortClaudeProfilesByLaunchRank(candidates, input.model, input.nowMs).map((profile) => profile.name);
}

/**
 * @description Until when the profile that hit the limit is marked limited, so the ranking skips it before the
 * window resets: the instant the error named, else the profile's own session-window reset when that lies ahead,
 * else `fallbackMs` from now (the retry's blind delay). A mark already further in the future is kept.
 */
export function resolveClaudeLimitedUntil(input: {
  resetAtMs: number | undefined;
  usage: ClaudeUsageSnapshot | undefined;
  existingLimitedUntil: string | null;
  nowMs: number;
  fallbackMs: number;
}): string {
  const sessionReset = getClaudeUsageBucket(input.usage, 'session')?.resetsAt ?? null;
  const sessionResetMs = sessionReset === null ? Number.NaN : Date.parse(sessionReset);
  let untilMs = input.resetAtMs !== undefined && input.resetAtMs > input.nowMs
    ? input.resetAtMs
    : Number.isFinite(sessionResetMs) && sessionResetMs > input.nowMs
      ? sessionResetMs
      : input.nowMs + input.fallbackMs;
  const existingMs = input.existingLimitedUntil === null ? Number.NaN : Date.parse(input.existingLimitedUntil);
  if (Number.isFinite(existingMs) && existingMs > untilMs) untilMs = existingMs;
  return new Date(untilMs).toISOString();
}
