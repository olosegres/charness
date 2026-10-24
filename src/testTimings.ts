import { z } from 'zod';
import { openCodeServerRestartRetryBudgetMs } from './adapters/openCodeAdapter';
import { unconfirmedLimitProbeDelayMs } from './apiErrorRetry';
import { jiraPollIntervalMinSeconds } from './connectors/jira/config';
import { globalSendIntervalMs } from './rateLimiter';
import { unwatchedSweepMs } from './requests/wakeUpEngine';
import { postRetryDelaysMs } from './requests/wakeUpRules';
import { DEFAULT_SAVE_DEBOUNCE_MS } from './state';
import { pendingWorkHoldDefaultMs } from './utils/jsonStreamPendingWork';

/**
 * @description The ONE test-only timing seam: `CHARNESS_TEST_TIMINGS`, a JSON object of named overrides for the
 * production windows the process-level flows would otherwise wait out in real time (the Telegram send pacer's 2 s, the
 * Jira poll's 10 s floor, the wake-up sweep's minute, the first re-post retry's minute, the two-minute probe of an
 * unconfirmed usage limit, `state.json`'s save debounce, the OpenCode server's 60 s of retries, the 6 h pending-work hold). It is NOT a setting: no
 * operator sets it and it is documented only for developers (DEVELOPMENT.md); settings live in `settings.json`.
 *
 * Unset (every production instance) = every built-in window as it is. Set, it is validated strictly at boot: an unknown
 * key or a bad value fails the start with the key named, and a valid one prints one line, so an instance that carries it
 * by mistake is visible at once. A value may only SHORTEN its window: each key is capped at its production value (and at
 * the longest delay Node's timers keep).
 */

/** The variable the instance reads; set only by a test's env file. */
export const testTimingsEnvName = 'CHARNESS_TEST_TIMINGS';

/** The longest delay Node's `setTimeout` / `setInterval` keep; a longer one fires after 1 ms (a `TimeoutOverflowWarning`). */
const timerMaxDelayMs = 2_147_483_647;
const msPerSecond = 1000;

/** A window in whole ms that may only shorten `productionMs`. */
function createShorterWindowSchema(productionMs: number): z.ZodNumber {
  return z.number().int().positive().max(Math.min(productionMs, timerMaxDelayMs));
}

const testTimingsSchema = z.strictObject({
  /** The global Telegram send pacer's interval (production: `globalSendIntervalMs`, 2 s). */
  telegramSendIntervalMs: createShorterWindowSchema(globalSendIntervalMs).optional(),
  /** The Jira poll's interval, at most `jira.json`'s 10 s floor (production: `pollIntervalSeconds`, 10–600 s). */
  jiraPollIntervalMs: createShorterWindowSchema(jiraPollIntervalMinSeconds * msPerSecond).optional(),
  /** How often the wake-up engine sweeps the unwatched open requests (production: `unwatchedSweepMs`, 1 min). */
  requestSweepIntervalMs: createShorterWindowSchema(unwatchedSweepMs).optional(),
  /** The first retry of a request whose prompt could not be posted (production: `postRetryDelaysMs[0]`, 1 min). */
  requestFirstPostRetryDelayMs: createShorterWindowSchema(postRetryDelaysMs[0]).optional(),
  /** The short retry that probes an unconfirmed usage limit (production: `unconfirmedLimitProbeDelayMs`, 2 min). */
  limitProbeDelayMs: createShorterWindowSchema(unconfirmedLimitProbeDelayMs).optional(),
  /**
   * How long `state.json` waits for more changes before it is written (production: 500 ms, restarted by every change):
   * short, a flow reading the file after what the bot showed reads what it did.
   */
  stateSaveDebounceMs: createShorterWindowSchema(DEFAULT_SAVE_DEBOUNCE_MS).optional(),
  /** The bound on the retries that bring a downed OpenCode server up (production: `openCodeServerRestartRetryBudgetMs`, 60 s). */
  openCodeServerUpBudgetMs: createShorterWindowSchema(openCodeServerRestartRetryBudgetMs).optional(),
  /**
   * How long the agent's own pending work (background tasks, `CronCreate` jobs) holds a json-stream process after its
   * last turn (production: `pendingWorkHoldDefaultMs`, 6 h).
   */
  backgroundHoldMaxMs: createShorterWindowSchema(pendingWorkHoldDefaultMs).optional(),
});

/** @name TestTimings @description The overrides in force; an absent key keeps its production window. */
export type TestTimings = z.infer<typeof testTimingsSchema>;

/** Every key the seam accepts — each must reach its consumer (`bot.ts`, the composition root, reads it). */
export const testTimingKeys = testTimingsSchema.keyof().options;

export type TestTimingsParse = { ok: true; timings: TestTimings } | { ok: false; errors: string[] };

/**
 * @description Read `CHARNESS_TEST_TIMINGS`. Unset or blank = no overrides. Every error names the variable and, for a
 * field, the key (`CHARNESS_TEST_TIMINGS limitProbeDelayMs: …`).
 */
export function parseTestTimings(rawValue: string | undefined): TestTimingsParse {
  if (rawValue === undefined || rawValue.trim() === '') return { ok: true, timings: {} };
  let parsedJson: object;
  try {
    parsedJson = JSON.parse(rawValue);
  } catch (error) {
    return { ok: false, errors: [`${testTimingsEnvName} is not JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const parsed = testTimingsSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((issue) => `${testTimingsEnvName} ${issue.path.join('.') || '(root)'}: ${issue.message}`) };
  }
  return { ok: true, timings: parsed.data };
}

/** @description The boot line of an instance running with overrides; `null` when none is set. */
export function formatTestTimingsBootLine(timings: TestTimings): string | null {
  const entries = Object.entries(timings);
  if (entries.length === 0) return null;
  return `[test-timings] ${testTimingsEnvName} overrides active: ${entries.map(([name, valueMs]) => `${name}=${valueMs}`).join(', ')}`;
}
