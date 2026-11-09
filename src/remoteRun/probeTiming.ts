/**
 * @description How long the view of the runners (`charness remote-run runners`, the bot's `/runners`, the probe that picks a runner for a run) waits for every runner's answer in all — in a leaf module of its own
 * so the CLI reads it without loading the bot (like `leaseTiming.ts`).
 *
 * The test seam `CHARNESS_TEST_TIMINGS` (`testTimings.ts`) may only SHORTEN it (key `remoteRunProbeDeadlineMs`): a flow that has to see a runner that is BUSY (its probe does not finish in time) cannot wait out 20 s of
 * production deadline, and no step of the probe may take that long any more (every one is bounded well under it). The CLI cannot import `testTimings.ts` (its graph reaches the bot), so it reads this one key through
 * `testTimingsSeam.ts`.
 */

import { readShorterTestWindowMs } from '../testTimingsSeam';

const msPerSecond = 1000;
/** The whole probing of all runners ends by then (a dead host costs its ssh connect timeout, once, in parallel with the others). */
export const probeAllTimeoutMs = 20 * msPerSecond;
/** A shorter deadline than this would report a healthy runner as busy for the time its ssh handshake takes. */
export const probeDeadlineMinMs = 1000;

/** @description The deadline in force: the production one, or the test seam's shorter `remoteRunProbeDeadlineMs` when it is a whole number of ms within [min, production]. */
export function readProbeDeadlineMs(env: NodeJS.ProcessEnv): number {
  return readShorterTestWindowMs(env, 'remoteRunProbeDeadlineMs', probeAllTimeoutMs, probeDeadlineMinMs);
}
