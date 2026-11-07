/**
 * @description How often a linked runner looks after its own Node.js again (a newer release of its line; `nodeUpkeep.ts`) after the look it makes when its
 * link starts. In a module of its own so the runner utility reads it without loading the bot.
 *
 * The test seam `CHARNESS_TEST_TIMINGS` (`testTimings.ts`) may only SHORTEN it (key `runnerNodeUpkeepMs`); it is read through `testTimingsSeam.ts`, because this
 * module cannot import `testTimings.ts` (its graph reaches the bot).
 */

import { readShorterTestWindowMs } from '../testTimingsSeam';

/** Production: once a day. */
export const nodeUpkeepIntervalMs = 24 * 60 * 60 * 1000;
/** A shorter look than this is a request loop, not a check. */
export const nodeUpkeepMinMs = 1000;

/** @description The interval in force: the production one, or the seam's shorter `runnerNodeUpkeepMs` when it is a whole number of ms within [min, production]. */
export function readNodeUpkeepIntervalMs(env: NodeJS.ProcessEnv): number {
  return readShorterTestWindowMs(env, 'runnerNodeUpkeepMs', nodeUpkeepIntervalMs, nodeUpkeepMinMs);
}
