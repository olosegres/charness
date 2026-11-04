/**
 * @description What a run left of the long timers it asked for — by NAME, not by counting the process's active timers. Counting
 * (`process.getActiveResourcesInfo()` before and after) is not a measurement of one call: the test runner's own timers, and those another test of the file left,
 * come and go meanwhile, and a drop of two between the samples failed a test about a timer that was in fact cleared. Here every `setTimeout` of `minDelayMs`
 * or more that the run makes is followed until it fires or is cleared; what is neither is returned. Not a test itself.
 */

export interface TrackedTimers<TResult> {
  result: TResult;
  /** Timers of at least the minimum delay that were set during the run and neither fired nor were cleared when it ended. */
  leftCount: number;
}

/** @description Run `run` with every global `setTimeout` / `clearTimeout` of this process watched; resolves with its result and how many long timers it left pending. */
export async function trackLongTimers<TResult>(minDelayMs: number, run: () => Promise<TResult>): Promise<TrackedTimers<TResult>> {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const pending = new Set<NodeJS.Timeout>();
  globalThis.setTimeout = Object.assign(
    // The two-argument form: what the code under test uses (a timer with extra arguments is not tracked).
    (callback: () => void, delay?: number): NodeJS.Timeout => {
      const handle: NodeJS.Timeout = originalSetTimeout(() => {
        pending.delete(handle);
        callback();
      }, delay);
      if ((delay ?? 0) >= minDelayMs) pending.add(handle);
      return handle;
    },
    { __promisify__: originalSetTimeout.__promisify__ },
  );
  globalThis.clearTimeout = (handle?: NodeJS.Timeout | string | number): void => {
    if (typeof handle === 'object') pending.delete(handle);
    originalClearTimeout(handle);
  };
  try {
    const result = await run();
    return { result, leftCount: pending.size };
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    for (const handle of pending) originalClearTimeout(handle);
  }
}
