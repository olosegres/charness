/**
 * @description The heartbeat lease of a foreground run, in a module of its own so the CLI reads it without loading the bot: a
 * runner kills a job whose caller stopped writing its heartbeat byte for this long — a stock sshd never notices a half-open
 * connection, so this is the only thing that ends an orphaned job.
 *
 * The test seam `CHARNESS_TEST_TIMINGS` (`testTimings.ts`) may only SHORTEN it (key `remoteRunLeaseMs`). The CLI cannot import
 * `testTimings.ts` (its graph reaches the bot), so it reads this one key through `testTimingsSeam.ts`.
 */

import { readShorterTestWindowMs } from '../testTimingsSeam';

/** Production lease: no heartbeat for this long → the job is killed. */
export const remoteRunLeaseMs = 45 * 1000;
/** The caller beats nine times per lease, so a few lost beats never kill a healthy job (production: every 5 s). */
const beatsPerLease = 9;
/** A shorter lease than this would kill a healthy job on one slow second of the runner's. */
export const remoteRunLeaseMinMs = 3000;

/** @description The lease in force: the production one, or the test seam's shorter `remoteRunLeaseMs` when it is a whole number of ms within [min, production]. */
export function readRemoteRunLeaseMs(env: NodeJS.ProcessEnv): number {
  return readShorterTestWindowMs(env, 'remoteRunLeaseMs', remoteRunLeaseMs, remoteRunLeaseMinMs);
}

/** @description How often the caller writes its heartbeat byte for a lease of `leaseMs`. */
export function getHeartbeatIntervalMs(leaseMs: number): number {
  return Math.floor(leaseMs / beatsPerLease);
}
