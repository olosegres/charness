import { z } from 'zod';
import { openCodeServerRestartRetryBudgetMs } from './adapters/openCodeAdapter';
import { unconfirmedLimitProbeDelayMs } from './apiErrorRetry';
import { tscWatchCheckIntervalMs, tscWatchStaleGraceMs } from './cli/tscWatchGuard';
import { jiraPollIntervalMinSeconds } from './connectors/jira/config';
import { bindPickerClaimLimit } from './connectors/telegram/bindPickerClaims';
import { globalSendIntervalMs } from './rateLimiter';
import { unwatchedSweepMs, watchedTurnPollMs } from './requests/wakeUpEngine';
import { postRetryDelaysMs } from './requests/wakeUpRules';
import { DEFAULT_SAVE_DEBOUNCE_MS } from './state';
import { pendingWorkHoldDefaultMs } from './utils/jsonStreamPendingWork';
import { todoReminderDefaultMinutes } from './todos/nag';
import { todoReminderPollMs } from './todos/reminderEngine';
import { minFireIntervalMs } from './scheduler/recurrence';
import { remoteRunLeaseMinMs, remoteRunLeaseMs } from './remoteRun/leaseTiming';
import { runnerVersionPollMinMs, runnerVersionPollMs } from './runnerUtility/versionPollTiming';
import { pairingLifetimeMinMs, pairingLifetimeMs } from './runners/pairingTiming';

/**
 * @description The ONE test-only timing seam: `CHARNESS_TEST_TIMINGS`, a JSON object of named overrides for the
 * production windows the process-level flows would otherwise wait out in real time (the Telegram send pacer's 2 s, the
 * Jira poll's 10 s floor, the wake-up engine's 10 s turn poll and its sweep's minute, the first re-post retry's minute, the two-minute probe of an
 * unconfirmed usage limit, `state.json`'s save debounce, the OpenCode server's 60 s of retries, the 6 h pending-work hold, the
 * todo reminder's 10 s poll and its interval, the 45 s heartbeat lease of a foreground `charness remote-run`, and — a count, not a window —
 * the 200 `/bind` picker claims). It is NOT a setting: no
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
  /** How often the wake-up engine polls the turns it watches for their end (production: `watchedTurnPollMs`, 10 s). */
  requestTurnPollMs: createShorterWindowSchema(watchedTurnPollMs).optional(),
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
  /** How often the todo reminder polls the sessions for their work and turn ends (production: `todoReminderPollMs`, 10 s). */
  todoReminderPollMs: createShorterWindowSchema(todoReminderPollMs).optional(),
  /** The todo reminder's interval, in place of the `settings.json` one (production default: 60 min; off stays off). */
  todoReminderIntervalMs: createShorterWindowSchema(todoReminderDefaultMinutes * 60 * msPerSecond).optional(),
  /** How many `/bind` picker claims the bot keeps before it drops the oldest — a COUNT, not a window (production: `bindPickerClaimLimit`, 200). */
  bindPickerClaimLimit: z.number().int().positive().max(bindPickerClaimLimit).optional(),
  /** How long a runner waits for the heartbeat of a foreground `charness remote-run` before it kills the job (production: `remoteRunLeaseMs`, 45 s; at least `remoteRunLeaseMinMs`). Read by the remote-run CLI, not by the bot. */
  remoteRunLeaseMs: createShorterWindowSchema(remoteRunLeaseMs).min(remoteRunLeaseMinMs).optional(),
  /** How often a linked `charness-runner` asks the hub for its current package (production: `runnerVersionPollMs`, 5 min; at least `runnerVersionPollMinMs`). Read by the runner utility, not by the bot. */
  runnerVersionPollMs: createShorterWindowSchema(runnerVersionPollMs).min(runnerVersionPollMinMs).optional(),
  /** How long a runner pairing code works (production: `pairingLifetimeMs`, 10 min; at least `pairingLifetimeMinMs`). Read by `charness runners pair`, not by the bot's boot. */
  pairingLifetimeMs: createShorterWindowSchema(pairingLifetimeMs).min(pairingLifetimeMinMs).optional(),
  /** The shortest gap between two fires of a cron schedule (production: `minFireIntervalMs`, 5 min). */
  scheduleMinFireIntervalMs: createShorterWindowSchema(minFireIntervalMs).optional(),
  /** How often the hot supervisor compares its `tsc -w` with the sources (production: `tscWatchCheckIntervalMs`, 30 s). Read by `charness hot`, not by the bot. */
  tscWatchCheckIntervalMs: createShorterWindowSchema(tscWatchCheckIntervalMs).optional(),
  /** How long a source may stay newer than its output before the hot supervisor blames its `tsc -w` (production: `tscWatchStaleGraceMs`, 1 min). Read by `charness hot`, not by the bot. */
  tscWatchStaleGraceMs: createShorterWindowSchema(tscWatchStaleGraceMs).optional(),
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
