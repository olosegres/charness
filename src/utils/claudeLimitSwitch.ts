/**
 * @description Pure decisions behind SWITCHING A TOPIC TO ANOTHER CLAUDE ACCOUNT when its own hits a usage
 * limit (`utils/claudeProfiles.ts`, `utils/claudeUsage.ts`): which profiles may take the work over, whether the
 * bot switches by itself (`/account` → auto-switch, OFF by default — the operator opts in, because moving work
 * between subscriptions is an account-policy decision) or only OFFERS the switch as buttons on the limit
 * notice, and the `callback_data` codec of those buttons.
 *
 * The notice's buttons stay tappable forever, so a button BAKES both the profile name (a slug of at most 32
 * characters) and the limit EPISODE it belongs to: a tap on an old notice can never move the topic after the
 * limit it was about has ended (`getClaudeLimitSwitchTapDecision`, the `acl_skip_<fireAt>` precedent).
 *
 * No I/O, no `Date.now()`: the caller passes the clock and the profile views, so every rule is unit-tested.
 */

import { checkIsValidClaudeProfileName, defaultClaudeProfileName } from './claudeProfiles';
import { buildClaudeProfilesReport, getClaudeUsageBucket, type ClaudeProfileUsageView, type ClaudeUsageSnapshot } from './claudeUsage';

/** The toggle's resolver (OFF when unset) lives beside `/auto_continue_limits`'s, where `state.ts` reads it. */
export { resolveClaudeAutoSwitchOnLimitEnabled } from './autoContinueOnLimit';

/** The most buttons a limit notice offers (best first); the rest of the ranking is reachable through `/account`. */
export const claudeLimitSwitchMaxOffers = 2;

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

export type ClaudeLimitSwitchPlan =
  /** Auto-switch is on and a profile has room: move the topic to `to` now. */
  | { action: 'auto'; to: string }
  /** Offer the switch on the limit notice, best first. */
  | { action: 'offer'; candidates: string[] }
  /** No profile can take over: the existing wait-for-reset behaviour stands. */
  | { action: 'none' };

/**
 * @description What a usage limit on a Claude topic leads to, given the ranked candidates and the toggle. An
 * empty candidate list is `none` whatever the toggle says — the auto-switch NEVER loops onto an account without
 * room; the bot then waits for the reset as before.
 */
export function decideClaudeLimitSwitch(input: { candidates: readonly string[]; isAutoSwitchEnabled: boolean }): ClaudeLimitSwitchPlan {
  if (input.candidates.length === 0) return { action: 'none' };
  if (input.isAutoSwitchEnabled) return { action: 'auto', to: input.candidates[0] };
  return { action: 'offer', candidates: input.candidates.slice(0, claudeLimitSwitchMaxOffers) };
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

// ── the button ──

/** `callback_data` prefix of a «switch to <profile>» button on a limit notice. */
export const claudeLimitSwitchCallbackPrefix = 'acsw_';

/** Prefix + a 13-digit episode + `_` + a 32-character name = 51 bytes, under Telegram's 64-byte cap. */
export const claudeLimitSwitchCallbackRe = new RegExp(`^${claudeLimitSwitchCallbackPrefix}(\\d+)_([a-z0-9][a-z0-9_-]{0,31})$`);

/**
 * @description The data of a switch button: the limit EPISODE it belongs to (an epoch ms that identifies the
 * limit error — the armed resume's `fireAt`, or the error's instant when no resume is armed) and the profile.
 */
export function buildClaudeLimitSwitchCallbackData(episodeId: number, name: string): string {
  return `${claudeLimitSwitchCallbackPrefix}${episodeId}_${name}`;
}

/** Inverse of {@link buildClaudeLimitSwitchCallbackData}; `null` for foreign data or an impossible name. */
export function parseClaudeLimitSwitchCallbackData(data: string): { episodeId: number; name: string } | null {
  const match = data.match(claudeLimitSwitchCallbackRe);
  if (!match) return null;
  const name = match[2];
  if (name !== defaultClaudeProfileName && !checkIsValidClaudeProfileName(name)) return null;
  return { episodeId: Number(match[1]), name };
}

/**
 * @description What a tap on a switch button does: `switch` only while the topic's OPEN limit episode is the
 * one the button was posted for; `expired` when the episode ended (the operator wrote, the work resumed, the
 * topic was switched already) or a newer limit replaced it. `expired` changes nothing.
 */
export function getClaudeLimitSwitchTapDecision(input: { openEpisodeId: number | null; requestedEpisodeId: number }): 'switch' | 'expired' {
  if (input.openEpisodeId === null) return 'expired';
  return input.openEpisodeId === input.requestedEpisodeId ? 'switch' : 'expired';
}
