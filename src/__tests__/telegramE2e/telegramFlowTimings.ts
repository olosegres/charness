/**
 * @description The production windows a Telegram flow's instance would wait out, shortened through the one test-only
 * timing seam (`CHARNESS_TEST_TIMINGS`, `testTimings.ts`): the global send pacer releases a send every 200 ms instead of
 * every 2 s. It is still the one process-wide first-come-first-served gate, so a flow's barrier — a command whose reply
 * comes after every send queued before it — holds as before; only the spacing shrinks. The real 2 s cadence is the
 * pacer's own unit tests' (`rateLimiter.test.ts`) and the live check's. `state.json` is written 10 ms after a change
 * instead of 500 ms (a timer every further change restarts): the 2 s pacing used to give a read of the file after a
 * message the time to see what the bot did before it, 200 ms does not. Matches neither runner glob.
 */

import { testTimingsEnvName, type TestTimings } from '../../testTimings';

/** What every Telegram flow runs its instance with. */
const telegramFlowTestTimings = { telegramSendIntervalMs: 200, stateSaveDebounceMs: 10 } satisfies TestTimings;

/**
 * @description The env-file variable carrying a Telegram flow's timings: {@link telegramFlowTestTimings}, plus the
 * flow's own `extraTimings` (a flow that waits out another window too).
 */
export function getTelegramFlowTestTimingsEnv(extraTimings: TestTimings = {}): Record<string, string> {
  return { [testTimingsEnvName]: JSON.stringify({ ...telegramFlowTestTimings, ...extraTimings }) };
}
