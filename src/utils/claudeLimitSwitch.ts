/**
 * @description Pure decisions behind SWITCHING A TOPIC TO ANOTHER CLAUDE ACCOUNT when its own hits a usage
 * limit (`utils/claudeProfiles.ts`, `utils/claudeUsage.ts`): which profiles may take the work over, ranked by
 * headroom, and until when the exhausted one is marked limited. This ranking is what the fallback chain
 * (`utils/fallbackChain.ts`) falls back to when the operator configured no chain: the within-Claude
 * account→account switch as it existed before the chain. The auto / offer decision, the notice's buttons and
 * the auto-switch toggle (`/account`, `/fallback`; OFF by default — the operator opts in, because moving work
 * between subscriptions is an account-policy decision) live in the chain module.
 *
 * No I/O, no `Date.now()`: the caller passes the clock and the profile views, so every rule is unit-tested.
 */

import { buildClaudeProfilesReport, getClaudeUsageBucket, type ClaudeProfileUsageView, type ClaudeUsageSnapshot } from './claudeUsage';

/** The toggle's resolver (OFF when unset) lives beside `/auto_continue_limits`'s, where `state.ts` reads it. */
export { resolveClaudeAutoSwitchOnLimitEnabled } from './autoContinueOnLimit';

/**
 * @description The profiles that may take a topic's work over, best first: signed in, not marked limited, with
 * KNOWN and fresh usage that leaves headroom on the windows `model` drains, and not the profile that just hit
 * the limit. A profile whose usage is unknown or stale is left out on purpose — the switch is sold as "this
 * one has room", and a guess could land the topic in a second limit.
 */
export function pickClaudeLimitSwitchCandidates(input: {
  profiles: readonly ClaudeProfileUsageView[];
  /** The profile the topic runs on — the one at its limit. */
  currentName: string;
  model: string | null;
  nowMs: number;
}): string[] {
  const report = buildClaudeProfilesReport(input.profiles, input.model, input.nowMs);
  return report.profiles
    .filter((entry) => entry.name !== input.currentName)
    .filter((entry) => entry.isEligible && entry.loggedIn === true && !entry.isUsageStale)
    .filter((entry) => entry.headroomPercent !== null && entry.headroomPercent > 0)
    .sort((a, b) => (b.headroomPercent ?? 0) - (a.headroomPercent ?? 0))
    .map((entry) => entry.name);
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
