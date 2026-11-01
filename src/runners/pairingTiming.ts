/**
 * @description How long a pairing code works. In a module of its own so the headless CLI reads it without loading the bot.
 *
 * The test seam `CHARNESS_TEST_TIMINGS` (`testTimings.ts`) may only SHORTEN it (key `pairingLifetimeMs`, at least
 * {@link pairingLifetimeMinMs}: sshd's `expiry-time` has a granularity of a second). Like the remote-run lease it is read tolerantly here,
 * because this module cannot import `testTimings.ts` (its graph reaches the bot); the boot of an instance that carries a bad value is what
 * refuses it by name.
 */

const msPerMinute = 60 * 1000;
export const pairingLifetimeMinutes = 10;
/** Production: a code works for ten minutes, once. */
export const pairingLifetimeMs = pairingLifetimeMinutes * msPerMinute;
/** sshd compares `expiry-time` in whole seconds: a shorter window would be rounding. */
export const pairingLifetimeMinMs = 5000;

const testTimingsVariableName = 'CHARNESS_TEST_TIMINGS';

/** @description The lifetime in force: the production one, or the seam's shorter `pairingLifetimeMs` when it is a whole number of ms within [min, production]. */
export function readPairingLifetimeMs(env: NodeJS.ProcessEnv): number {
  const rawTestTimings = env[testTimingsVariableName];
  if (rawTestTimings === undefined || rawTestTimings.trim() === '') return pairingLifetimeMs;
  let overrides: { pairingLifetimeMs?: number } | null;
  try {
    overrides = JSON.parse(rawTestTimings);
  } catch {
    return pairingLifetimeMs;
  }
  const overrideMs = overrides?.pairingLifetimeMs;
  if (overrideMs === undefined || !Number.isInteger(overrideMs)) return pairingLifetimeMs;
  return overrideMs >= pairingLifetimeMinMs && overrideMs <= pairingLifetimeMs ? overrideMs : pairingLifetimeMs;
}

/** @description «10 minutes», or «5 seconds» for a window shorter than a minute (only a test's). */
export function formatLifetime(lifetimeMs: number): string {
  return lifetimeMs >= msPerMinute ? `${Math.round(lifetimeMs / msPerMinute)} minutes` : `${Math.round(lifetimeMs / 1000)} seconds`;
}
