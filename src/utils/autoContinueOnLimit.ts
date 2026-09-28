/**
 * @description Pure resolver for the `/auto_continue_limits` toggle — whether the bot may
 * wait out a provider USAGE/SESSION limit and resume the topic by itself once the
 * window resets.
 *
 * Scope is deliberately narrow: it gates ONLY the `usageLimit` error class. The
 * short transient retries (rate-limited / overloaded, 5·10·20 min) stay
 * unconditional — nobody wants to hand-restart after a 30-second hiccup — and an
 * `auth` error is surfaced, never retried, so neither class consults this.
 *
 * Kept out of `bot.ts` (which cannot be imported by tests — its module-scope
 * `parseEnv()` exits without a bot token), mirroring `resolveCompactOnIdleEnabled`
 * in `compactOnIdle.ts`.
 */

import { resolveDefaultOnThreadToggle } from './threadToggle';

/**
 * @description Resolve whether limit auto-continue is enabled for a thread. A
 * per-thread override always wins; otherwise the instance-wide default applies,
 * which is ON when unset — the feature predates the toggle and was
 * unconditional, so ON is the behaviour-preserving default.
 */
export function resolveAutoContinueOnLimitEnabled(
  globalDefault: boolean | undefined,
  threadOverride: boolean | undefined,
): boolean {
  return resolveDefaultOnThreadToggle(globalDefault, threadOverride);
}

/** `callback_data` prefix of the «skip this resume once» button. */
export const skipArmedRetryCallbackPrefix = 'acl_skip_';

/**
 * @description Build the «skip once» button's `callback_data`. The armed record's
 * `fireAt` is BAKED IN because inline buttons stay tappable forever: without it a
 * tap on an OLD notice would cancel whatever episode happens to be armed NOW (the
 * same class of bug as the `/disconnect` picker resolving a stale index against a
 * fresh provider list). Prefix + a 13-digit epoch is ~22 bytes, far inside
 * Telegram's 64-byte `callback_data` cap.
 */
export function buildSkipArmedRetryCallbackData(fireAt: number): string {
  return `${skipArmedRetryCallbackPrefix}${fireAt}`;
}

/** Inverse of {@link buildSkipArmedRetryCallbackData}; `null` for foreign data. */
export function parseSkipArmedRetryCallbackData(data: string): number | null {
  if (!data.startsWith(skipArmedRetryCallbackPrefix)) return null;
  const raw = data.slice(skipArmedRetryCallbackPrefix.length);
  if (!/^\d+$/.test(raw)) return null;
  return Number(raw);
}

/**
 * @description What a «skip once» tap should do: `skip` only when the thread still
 * has that EXACT armed resume pending, `expired` when nothing is armed any more or
 * a DIFFERENT episode is (the notice the user tapped is stale). `expired` must
 * change no state — silently skipping the newer episode would cancel a resume the
 * user never asked to cancel.
 *
 * @param armedFireAt `fireAt` of the thread's currently pending limit resume, or
 *   `null` when none is armed.
 */
export function getArmedRetrySkipDecision(input: {
  armedFireAt: number | null;
  requestedFireAt: number;
}): 'skip' | 'expired' {
  if (input.armedFireAt === null) return 'expired';
  return input.armedFireAt === input.requestedFireAt ? 'skip' : 'expired';
}
