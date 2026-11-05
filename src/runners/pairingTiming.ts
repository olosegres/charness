/**
 * @description How long a pairing code works. In a module of its own so the headless CLI reads it without loading the bot.
 *
 * The test seam `CHARNESS_TEST_TIMINGS` (`testTimings.ts`) may only SHORTEN it (key `pairingLifetimeMs`, at least
 * {@link pairingLifetimeMinMs}: sshd's `expiry-time` has a granularity of a second). Like the remote-run lease it is read through `testTimingsSeam.ts`,
 * because this module cannot import `testTimings.ts` (its graph reaches the bot).
 */

import { readShorterTestWindowMs } from '../testTimingsSeam';

const msPerMinute = 60 * 1000;
export const pairingLifetimeMinutes = 10;
/** Production: a code works for ten minutes, once. */
export const pairingLifetimeMs = pairingLifetimeMinutes * msPerMinute;
/** sshd compares `expiry-time` in whole seconds: a shorter window would be rounding. */
export const pairingLifetimeMinMs = 5000;

/** @description The lifetime in force: the production one, or the seam's shorter `pairingLifetimeMs` when it is a whole number of ms within [min, production]. */
export function readPairingLifetimeMs(env: NodeJS.ProcessEnv): number {
  return readShorterTestWindowMs(env, 'pairingLifetimeMs', pairingLifetimeMs, pairingLifetimeMinMs);
}

/** @description «10 minutes», or «5 seconds» for a window shorter than a minute (only a test's). */
export function formatLifetime(lifetimeMs: number): string {
  return lifetimeMs >= msPerMinute ? `${Math.round(lifetimeMs / msPerMinute)} minutes` : `${Math.round(lifetimeMs / 1000)} seconds`;
}
