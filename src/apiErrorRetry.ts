/**
 * @description Pure decision layer for the auto-retry-after-API-error feature
 * (plan `agent/tasks/actual/2026-06-09-api-error-auto-retry.md`, S1). No I/O and
 * no `Date.now()` inside: every caller passes `now` so the module is fully
 * deterministic and unit-testable on a fixed clock.
 *
 * Two responsibilities:
 *  - {@link classifyAgentApiError} — read a terminal error string and decide
 *    whether (and how) it should be auto-retried. ORDER MATTERS (see the fn doc).
 *  - {@link getRetryPlan} — given a class + the current attempt, decide the next
 *    backoff delay or that we should give up.
 *
 * The same classifier serves BOTH backends: Claude surfaces the provider's
 * "API Error" line in its TUI pane; OpenCode surfaces the same provider text
 * through `session.error`.
 */

import type { AgentApiErrorClass } from './types';
import { maxTimeoutMs } from './scheduler/engine';

/** One minute in milliseconds — the unit the backoff schedules are expressed in. */
const msPerMinute = 60_000;
/** One hour in milliseconds. */
const msPerHour = 60 * msPerMinute;

/**
 * Transient backoff schedule (one entry per attempt): attempt 1 → 5m,
 * 2 → 10m, 3 → 20m. After the last entry the retry gives up.
 */
export const transientBackoffMinutes = [5, 10, 20] as const;
/** Max transient attempts before giving up (= `transientBackoffMinutes.length`). */
export const transientMaxAttempts = transientBackoffMinutes.length;

/**
 * Fixed delay for a usage-limit error whose text exposed no reset time (the
 * common case for Claude's "blocked" message): 60 minutes, re-armed on each
 * repeat until {@link usageLimitMaxAttempts}.
 */
export const usageLimitDefaultMs = 60 * msPerMinute;
/** Max usage-limit attempts before giving up (~6h with the default delay). */
export const usageLimitMaxAttempts = 6;
/**
 * Grace window after a retry fires: another API error within this window counts
 * as the SAME error episode (escalate to attempt+1, longer backoff); an error
 * later than this is a FRESH episode (reset to attempt 1). Decouples the
 * decision from session-end events — a recovered turn just leaves a stale record
 * that the next, much-later error resets to attempt 1.
 */
export const retryRecurrenceGraceMs = 2 * msPerMinute;
/**
 * Padding added to a parsed reset time so the retry fires just AFTER the window
 * actually rolls over, never a hair before it (which would re-error instantly).
 */
export const resetBufferMs = 60_000;

/** Matches reset phrasings like "resets in 2h", "in 45m", "in 90 min". */
const relativeResetRegex = /\bin\s+(\d+)\s*(h|hours?|m|min|minutes?)\b/i;
/**
 * Matches absolute clock phrasings after a reset trigger word. The trigger is
 * either `at` (`resets at 3pm`, `at 15:00`) OR a BARE `reset`/`resets` — Claude's
 * session-limit render drops the "at" entirely (`resets 10:50pm (UTC)`), which
 * the old `at`-only pattern missed, leaving the retry on its blind 60-min delay.
 * The hour's `(?!\d)` guard stops a leading ISO date (`2026-09-24`) from being
 * read as an hour before the ISO branch gets its turn.
 */
const clockResetRegex = /\b(?:reset(?:s|ting)?|at)\s+(\d{1,2})(?!\d)(?::(\d{2}))?\s*(am|pm)?/i;
/**
 * An EXPLICIT timezone immediately after the clock — `(UTC)`, ` UTC`, `Z`,
 * `+05:00`, `-0700`. Anchored at the remainder's start so only a suffix of THAT
 * clock counts, and `\b`-terminated so a word merely starting with `Z` (`Zulu`,
 * `Zoom`) is not read as the Zulu zone.
 */
const trailingZoneRegex = /^\s*\(?\s*(UTC|GMT|Z|[+-]\d{2}:?\d{2})\b\s*\)?/i;
/** Matches an ISO-8601 timestamp anywhere in the text. */
const isoTimestampRegex = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/;

const hoursPerDay = 24;
const minutesPerHour = 60;
const msPerDay = hoursPerDay * msPerHour;

/**
 * @description The auth / logged-out phrases (`please run /login`, `not logged
 * in`, `invalid authentication credentials`). Shared with the Claude scrape
 * detector (`getClaudeAgentErrorLine`) so the two never drift. NOT global — used
 * with `.test()`, so lastIndex never carries between calls.
 */
export const authErrorPhrasesRe = /please run \/login|not logged in|invalid authentication credentials/i;

/**
 * The wordings that name a usage WINDOW or an exhausted balance EXPLICITLY: the
 * qualified window limits (`session limit`, `weekly limit`, `5-hour limit`), the
 * `hit your … limit` phrasings Claude now uses, and the balance/quota exhaustion
 * wordings that are not spelled as a "limit" at all. Kept apart from the bare
 * `limit reached` below because this subset is what exempts a text from
 * {@link nonUsageLimitRe} — "hit your weekly token limit" IS a usage window, a bare
 * "context limit exceeded" is not.
 */
const usageWindowPhrases = [
  String.raw`(?:session|usage|weekly|daily|monthly|hourly|\d+-hours?)[\s_]+limit`,
  String.raw`(?:hit|reached|exceeded)\s+your\s+(?:[\w-]+\s+){0,3}limit`,
  String.raw`credit balance (?:is )?too low`,
  String.raw`out of (?:credits|usage)`,
  String.raw`quota`,
  String.raw`resource[\s_]+(?:has been )?exhausted`,
  String.raw`billing\s+(?:hard\s+)?limit`,
];

/**
 * The provider error CODES that mean an exhausted quota or subscription window — what the OpenCode backend
 * relays verbatim from OpenAI (`insufficient_quota`, `usage_limit_reached`), Google (`RESOURCE_EXHAUSTED`) and
 * the OpenAI Codex subscription (`You've hit your usage limit`). These arrive with HTTP 429, the status the
 * transient branch reads as "rate limited", so they are tested BEFORE it: a quota that is used up for the
 * month is not cleared by a 5-minute retry, and the fallback chain must see a usage limit to switch provider.
 */
const exhaustedQuotaCodesRe = /insufficient_quota|exceeded your current quota|usage_limit_reached|resource_exhausted|hit your usage limit/i;

/** Observed subscription-window wording; do not generalize it to every bare rate limit. */
const subscriptionLimitMessageRe = /this request would exceed your account's rate limit\.\s*please try again later\./i;

/**
 * @description Alternation SOURCE (no anchors, no flags) of the explicit
 * usage/session-limit wordings — {@link usageWindowPhrases} plus a bare
 * `limit reached`. Exported as a source string — not just a compiled
 * regex — because the Claude scrape detector (`getClaudeAgentErrorLine`) has to
 * ANCHOR the same phrases at the start of a pane row, and a single source keeps
 * the two from drifting (the `authErrorPhrasesRe` precedent).
 */
export const usageLimitPhraseSource = [
  ...usageWindowPhrases,
  String.raw`limit\s+(?:reached|exceeded)`,
].join('|');

/** {@link usageLimitPhraseSource} compiled for a whole-text `.test()`. */
export const usageLimitPhrasesRe = new RegExp(usageLimitPhraseSource, 'i');
/** {@link usageWindowPhrases} compiled — the {@link nonUsageLimitRe} exemption. */
const usageWindowPhrasesRe = new RegExp(usageWindowPhrases.join('|'), 'i');

/**
 * A limit that WAITING can never clear: a context / token / prompt-length overflow
 * is fixed by sending less, not by sitting out a window. The real provider wording
 * ("input length and `max_tokens` exceed context limit: … decrease input length …
 * and try again") carries both a limit mention and a retry hint, so without this
 * guard the generic fallback below classified it as `usageLimit` and armed a 6-hour
 * futile wait instead of surfacing an error the operator has to act on.
 */
const nonUsageLimitRe = /\b(?:context|token|input|output|prompt|character)\s+(?:length\s+)?limits?\b/i;

/**
 * The GENERIC fallback's two required signals: the text mentions a limit AND
 * carries a reset/retry hint. BOTH are required on purpose — "limit" alone
 * matches ordinary prose ("the API limit is 5 requests per minute"), while the
 * pairing is what every real limit message has (it always tells you when you get
 * back in).
 */
const limitMentionRe = /\blimits?\b/i;
const limitResetHintRe = /\breset(?:s|ting)?\b|\btry again\b|\bresumes?\b/i;

/**
 * @description Whether an error text is a usage / session / window limit.
 *
 * Two tiers, and the second one is the point: the explicit
 * {@link usageLimitPhraseSource} list catches every wording we have actually
 * seen, and the GENERIC fallback (a limit mention PLUS a reset/retry hint) still
 * catches a wording the provider invents later — a rephrased limit message must
 * not silently fall back to "relay the raw text and look hung", which is exactly
 * what happened to `You've hit your session limit · resets 10:50pm (UTC)`.
 *
 * Ahead of both tiers sits {@link nonUsageLimitRe}: a context/token overflow is a
 * limit no wait can clear, so it must never arm one.
 */
export function checkIsUsageLimitText(text: string): boolean {
  if (nonUsageLimitRe.test(text) && !usageWindowPhrasesRe.test(text)) return false;
  if (usageLimitPhrasesRe.test(text)) return true;
  return limitMentionRe.test(text) && limitResetHintRe.test(text);
}

/**
 * @description Classify a backend error string into an error class, or `null`
 * when it is not a recognised provider error.
 *
 * ORDER IS LOAD-BEARING — branches are evaluated top to bottom and return on
 * first match:
 *  1. auth / logged out (login, bad credentials) → `{ kind: 'auth' }`. Must win:
 *     a wait never fixes these (they need a re-login or server restart), so they
 *     are SURFACED (a pinned notice), never auto-retried. Used to return `null`.
 *  2. an exhausted-quota provider CODE ({@link exhaustedQuotaCodesRe}) or the observed
 *     subscription wording ({@link subscriptionLimitMessageRe}) → `usageLimit`.
 *     Ahead of transient because these ride a 429 (OpenAI `insufficient_quota`,
 *     Google `RESOURCE_EXHAUSTED`), which the next branch would read as a hiccup.
 *  3. transient (rate-limited, overloaded, 429/503/529) → `{ kind: 'transient' }`.
 *     Tested BEFORE the usage wordings on purpose: the live transient string literally reads
 *     "...(not your usage limit)...", so a naive usage check would false-match it.
 *     Because transient returns here, the usage branch never sees that substring.
 *  4. usage / session / window limit → `{ kind: 'usageLimit', resetAt? }`, decided
 *     by {@link checkIsUsageLimitText} (explicit wordings + a generic fallback).
 * Anything else (normal prose, unrelated text) → `null`.
 *
 * @param now Current epoch ms — only consulted to resolve a relative/absolute
 *   reset time for the usage class; the transient/auth branches ignore it.
 */
export function classifyAgentApiError(text: string, now: number): AgentApiErrorClass | null {
  if (authErrorPhrasesRe.test(text)) {
    return { kind: 'auth' };
  }
  if (exhaustedQuotaCodesRe.test(text) || subscriptionLimitMessageRe.test(text)) {
    return { kind: 'usageLimit', resetAt: parseResetAt(text, now) };
  }
  // The observed subscription wording is handled above, including a 429 wrapper.
  // Ordinary rate-limit errors must not fall into the generic limit + retry-hint branch.
  if (/rate.?limit(?:ed)?|temporarily limiting requests|too many requests|overloaded|\b(429|503|529)\b/i.test(text)) {
    return { kind: 'transient' };
  }
  if (checkIsUsageLimitText(text)) {
    return { kind: 'usageLimit', resetAt: parseResetAt(text, now) };
  }
  return null;
}

/**
 * @description Best-effort parse of a "reset time" out of a usage-limit message.
 * Never throws: any unparseable / absent time yields `undefined`, which the
 * caller treats as "use the fixed delay". Handles three shapes, in order:
 *  - relative: "resets in 2h" / "in 45m" → `now + duration`.
 *  - absolute clock: "resets at 3pm" / "at 15:00" / "resets 10:50pm (UTC)" → the
 *    NEXT occurrence of that clock time at or after `now`. An EXPLICIT zone
 *    suffix is load-bearing: the clock is then resolved IN THAT ZONE, not in the
 *    instance/host zone. Without it a `10:50pm (UTC)` reset on a `+04:00` box
 *    resolved four hours EARLY — the retry fires while the limit still holds,
 *    re-errors, and burns one of the six attempts for nothing.
 *  - ISO timestamp anywhere in the text → `Date.parse`.
 *
 * A clock shape that fails to resolve (out-of-range hour) falls THROUGH to the
 * ISO branch rather than giving up, so a message carrying both still parses.
 *
 * @param now Current epoch ms, used to resolve relative durations and to pick
 *   the next occurrence of an absolute clock time.
 */
export function parseResetAt(text: string, now: number): number | undefined {
  const relativeMatch = relativeResetRegex.exec(text);
  if (relativeMatch) {
    const amount = Number.parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2].toLowerCase();
    const isHours = unit.startsWith('h');
    return now + amount * (isHours ? msPerHour : msPerMinute);
  }

  const clockMatch = clockResetRegex.exec(text);
  if (clockMatch) {
    const resolved = resolveNextClockTime(clockMatch, text, now);
    if (resolved !== undefined) return resolved;
  }

  const isoMatch = isoTimestampRegex.exec(text);
  if (isoMatch) {
    const parsed = Date.parse(isoMatch[0]);
    if (!Number.isNaN(parsed)) return parsed;
  }

  return undefined;
}

/**
 * Read an explicit zone token to an offset from UTC in ms, or `undefined` when it
 * is not a zone we can resolve arithmetically. `Z`/`UTC`/`GMT` are zero;
 * `±HH:MM` / `±HHMM` are taken literally (a fixed offset needs no DST rules).
 */
function getZoneOffsetMs(zone: string): number | undefined {
  const upper = zone.toUpperCase();
  if (upper === 'UTC' || upper === 'GMT' || upper === 'Z') return 0;
  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
  if (!match) return undefined;
  const hours = Number.parseInt(match[2], 10);
  const minutes = Number.parseInt(match[3], 10);
  if (hours >= hoursPerDay || minutes >= minutesPerHour) return undefined;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (hours * msPerHour + minutes * msPerMinute);
}

/**
 * Resolve a clock match to the next epoch ms at or after `now` that lands on that
 * wall-clock time. When the text carries an explicit zone right after the clock
 * the arithmetic is done in THAT zone (pure offset math, no `Intl`); otherwise it
 * falls back to the process-local zone (which `/timezone` already re-bases).
 * Returns `undefined` for an out-of-range hour/minute rather than guessing.
 */
function resolveNextClockTime(match: RegExpExecArray, text: string, now: number): number | undefined {
  const rawHour = Number.parseInt(match[1], 10);
  const minute = match[2] ? Number.parseInt(match[2], 10) : 0;
  const meridiem = match[3]?.toLowerCase();

  let hour = rawHour;
  if (meridiem === 'pm' && rawHour < 12) hour = rawHour + 12;
  else if (meridiem === 'am' && rawHour === 12) hour = 0;

  if (hour < 0 || hour >= hoursPerDay || minute < 0 || minute >= minutesPerHour) {
    return undefined;
  }

  const zoneMatch = trailingZoneRegex.exec(text.slice(match.index + match[0].length));
  const offsetMs = zoneMatch ? getZoneOffsetMs(zoneMatch[1]) : undefined;
  if (offsetMs !== undefined) {
    // Shift onto the zone's timeline, snap to that zone's midnight, then shift
    // back — `Date`'s local-zone getters are unusable for a foreign zone.
    const shiftedNow = now + offsetMs;
    const zoneDayStart = Math.floor(shiftedNow / msPerDay) * msPerDay;
    let candidateShifted = zoneDayStart + hour * msPerHour + minute * msPerMinute;
    if (candidateShifted < shiftedNow) candidateShifted += msPerDay;
    return candidateShifted - offsetMs;
  }

  const candidate = new Date(now);
  candidate.setHours(hour, minute, 0, 0);
  let candidateMs = candidate.getTime();
  if (candidateMs < now) {
    // Already past today — roll to the same clock time tomorrow.
    candidate.setDate(candidate.getDate() + 1);
    candidateMs = candidate.getTime();
  }
  return candidateMs;
}

export interface RetryPlanArgs {
  kind: AgentApiErrorClass['kind'];
  /** 1-based attempt number for the delay we are about to schedule. */
  attempt: number;
  /** Parsed reset time (usage class only); absent → the fixed default delay. */
  resetAt?: number;
  /** Current epoch ms (to size a reset-time-relative delay). */
  now: number;
}

export type RetryPlan = { delayMs: number } | { giveUp: true };

/**
 * @description Decide the next backoff for an attempt, or that the retry loop
 * should give up. Every returned `delayMs` is clamped to `[0, maxTimeoutMs]`
 * (the same `setTimeout` cap the scheduler engine uses) so a far-future reset
 * time never overflows the timer.
 *  - transient: {@link transientBackoffMinutes}[attempt-1]; giveUp once attempt
 *    exceeds {@link transientMaxAttempts}.
 *  - usageLimit: `resetAt` present → `resetAt - now + resetBufferMs`; else
 *    {@link usageLimitDefaultMs}; giveUp once attempt exceeds
 *    {@link usageLimitMaxAttempts}.
 */
export function getRetryPlan(args: RetryPlanArgs): RetryPlan {
  // auth is never retried (it is surfaced by `decideRetryAction` before this is
  // reached); guard so it can never fall through into the usageLimit branch.
  if (args.kind === 'auth') return { giveUp: true };

  if (args.kind === 'transient') {
    if (args.attempt > transientMaxAttempts) return { giveUp: true };
    const minutes = transientBackoffMinutes[args.attempt - 1];
    return { delayMs: clampDelay(minutes * msPerMinute) };
  }

  if (args.attempt > usageLimitMaxAttempts) return { giveUp: true };
  const rawDelayMs =
    typeof args.resetAt === 'number' ? args.resetAt - args.now + resetBufferMs : usageLimitDefaultMs;
  return { delayMs: clampDelay(rawDelayMs) };
}

/** Clamp a delay into `[0, maxTimeoutMs]` (the Node `setTimeout` safe range). */
function clampDelay(delayMs: number): number {
  return Math.min(Math.max(0, delayMs), maxTimeoutMs);
}

/**
 * @description A read-only view of the bot's per-thread armed-retry record, fed
 * into {@link decideRetryAction}. The bot owns the live `Map`; this snapshot is
 * the only state the pure decision needs.
 */
export interface RetryEntrySnapshot {
  /** 1-based attempt of the currently / last armed retry. */
  attempt: number;
  /** Epoch ms when the last armed retry actually fired, or `null` if still pending. */
  firedAt: number | null;
  /** True while a retry timer is armed and has not fired yet. */
  pending: boolean;
}

/**
 * @description The action the bot must take in response to one `apiError`:
 *  - `surface` — an auth / logged-out error: post a pinned notice, arm NO timer
 *    (a wait never fixes it). The bot dedups repeats via its own per-thread
 *    auth-notice flag, so no attempt bookkeeping is needed here.
 *  - `ignore`  — a retry is already armed and waiting; dedup this duplicate
 *    error frame (Claude re-scrapes the same line; OpenCode can repeat
 *    `session.error`).
 *  - `arm`     — arm a timer for `attempt` after `delayMs` (firing at `fireAt`).
 *  - `giveUp`  — the retry cap was reached; `attempts` is how many were already
 *    made before giving up.
 */
export type RetryAction =
  | { action: 'surface' }
  | { action: 'ignore' }
  | { action: 'arm'; attempt: number; delayMs: number; fireAt: number }
  | { action: 'giveUp'; attempts: number };

export interface DecideRetryActionArgs {
  kind: AgentApiErrorClass['kind'];
  /** Parsed reset time (usage class only); absent → the fixed default delay. */
  resetAt?: number;
  /** Current epoch ms. */
  now: number;
  /** The thread's existing armed-retry snapshot, or `null` if none. */
  prev: RetryEntrySnapshot | null;
}

/**
 * @description Decide the bot's reaction to an incoming API error, combining the
 * episode/attempt bookkeeping with {@link getRetryPlan}. Pure — the caller
 * passes `now` and the `prev` snapshot, so the decision is deterministic.
 *
 * Rules (evaluated in order):
 *  0. `auth` → `surface` (never a timer, no attempt bookkeeping — the bot posts
 *     a deduped pinned notice; a wait can't recover a logged-out session).
 *  1. `prev.pending` → `ignore` (a retry is already armed — dedup the episode;
 *     this is what stops Claude's repeated scrape frames AND any duplicate
 *     `session.error` from re-arming).
 *  2. same episode (a `prev` that fired within {@link retryRecurrenceGraceMs}) →
 *     escalate to `prev.attempt + 1`; otherwise a fresh episode → attempt 1.
 *  3. ask {@link getRetryPlan}: `giveUp` → `giveUp` with `attempts` already made
 *     (= attempt − 1); else `arm` at `now + delayMs`.
 */
export function decideRetryAction(args: DecideRetryActionArgs): RetryAction {
  const { kind, resetAt, now, prev } = args;
  if (kind === 'auth') return { action: 'surface' };
  if (prev?.pending) return { action: 'ignore' };

  const sameEpisode = !!prev && prev.firedAt != null && now - prev.firedAt <= retryRecurrenceGraceMs;
  const attempt = sameEpisode ? prev.attempt + 1 : 1;

  const plan = getRetryPlan({ kind, attempt, resetAt, now });
  if ('giveUp' in plan) return { action: 'giveUp', attempts: attempt - 1 };
  return { action: 'arm', attempt, delayMs: plan.delayMs, fireAt: now + plan.delayMs };
}
