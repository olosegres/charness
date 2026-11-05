/**
 * @description The ONE tolerant reader of the test-only timing seam `CHARNESS_TEST_TIMINGS` (`testTimings.ts`) for the processes that cannot import `testTimings.ts` — its graph
 * reaches the bot — such as the `remote-run` CLI and the runner utility. Each of them reads its own key through {@link readShorterTestWindowMs}. A leaf: it imports nothing.
 *
 * The seam may only SHORTEN a production window. This reader is tolerant on purpose (an unset or blank variable, text that is not JSON, a key that is absent or not a whole number
 * of ms, or one outside [min, production] all give the production window); the boot of an instance that carries a bad value is what refuses it by name.
 */

const testTimingsVariableName = 'CHARNESS_TEST_TIMINGS';

/** @description The window in force: `productionMs`, or the seam's `key` when it is a whole number of ms within [`minMs`, `productionMs`]. */
export function readShorterTestWindowMs(env: NodeJS.ProcessEnv, key: string, productionMs: number, minMs: number): number {
  const rawTestTimings = env[testTimingsVariableName];
  if (rawTestTimings === undefined || rawTestTimings.trim() === '') return productionMs;
  let overrides: Record<string, number | undefined> | null;
  try {
    overrides = JSON.parse(rawTestTimings);
  } catch {
    return productionMs;
  }
  const overrideMs = overrides?.[key];
  if (overrideMs === undefined || !Number.isInteger(overrideMs)) return productionMs;
  return overrideMs >= minMs && overrideMs <= productionMs ? overrideMs : productionMs;
}
