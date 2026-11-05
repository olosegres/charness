/**
 * @description How long `charness remote-run --needs <capability>` waits for a paired runner that is offline, and how often it looks
 * again — in a leaf module of its own so the CLI reads them without loading the bot (like `leaseTiming.ts`).
 *
 * The test seam `CHARNESS_TEST_TIMINGS` (`testTimings.ts`) may only SHORTEN the poll (key `remoteRunRunnerPollMs`); the CLI cannot import
 * `testTimings.ts` (its graph reaches the bot), so it reads this one key through `testTimingsSeam.ts`, as the lease does.
 */

import { readShorterTestWindowMs } from '../testTimingsSeam';

const msPerSecond = 1000;
/** `--runner-wait` when the command line does not say: a laptop that slept or a link that restarts is back well within this. */
export const defaultRunnerWaitSeconds = 15 * 60;
/** How often the wait looks at the runners again. */
export const runnerWaitPollMs = 10 * msPerSecond;
/** A shorter poll would probe every runner (an ssh call each) in a tight loop. */
export const runnerWaitPollMinMs = 200;

/** @description The poll in force: the production one, or the test seam's shorter `remoteRunRunnerPollMs` when it is a whole number of ms within [min, production]. */
export function readRunnerWaitPollMs(env: NodeJS.ProcessEnv): number {
  return readShorterTestWindowMs(env, 'remoteRunRunnerPollMs', runnerWaitPollMs, runnerWaitPollMinMs);
}
