import { readShorterTestWindowMs } from '../testTimingsSeam';

/**
 * @description How often a Mac's link looks at its lid (`lidState.ts`). In a module of its own so the runner utility reads it without loading the bot, like `versionPollTiming.ts`:
 * the test seam `CHARNESS_TEST_TIMINGS` (`testTimings.ts`) may only SHORTEN it (key `runnerLidPollMs`), read through `testTimingsSeam.ts`.
 */

/** Production: as often as the hub's gate takes its own heartbeat. */
export const lidPollMs = 10 * 1000;
/** A shorter poll than this is a loop of `ioreg` calls, not a look. */
export const lidPollMinMs = 500;

/** @description The poll interval in force: the production one, or the seam's shorter `runnerLidPollMs` when it is a whole number of ms within [min, production]. */
export function readLidPollMs(env: NodeJS.ProcessEnv): number {
  return readShorterTestWindowMs(env, 'runnerLidPollMs', lidPollMs, lidPollMinMs);
}
