import { z } from 'zod';
import { openCodeServerRestartRetryBudgetMs } from './adapters/openCodeAdapter';
import { unconfirmedLimitProbeDelayMs } from './apiErrorRetry';
import { tscWatchCheckIntervalMs, tscWatchStaleGraceMs } from './cli/tscWatchGuard';
import { jiraPollIntervalMinSeconds } from './connectors/jira/config';
import { bindPickerClaimLimit } from './connectors/telegram/bindPickerClaims';
import { globalSendIntervalMs, telegramSendOperationDeadlineMs } from './rateLimiter';
import { restartWakeStaggerMs, unwatchedSweepMs, watchedTurnPollMs } from './requests/wakeUpEngine';
import { postRetryDelaysMs } from './requests/wakeUpRules';
import { busyPollIntervalMs, waitIdleTimeoutMs } from './postToSession';
import { DEFAULT_SAVE_DEBOUNCE_MS } from './state';
import { pendingWorkHoldDefaultMs } from './utils/jsonStreamPendingWork';
import { basePollIntervalMs } from './utils/pollBackoff';
import { claudeApiCreditRecheckIntervalMs, claudeApiCreditRecheckPollMs } from './utils/claudeApiCreditRecheck';
import { todoReminderDefaultMinutes } from './todos/nag';
import { longestQuestionWaitMs, setAsideRetryDelayMs } from './utils/questionWaitChoices';
import { todoReminderPollMs } from './todos/reminderEngine';
import { indicatorBootWaveDelayMs, indicatorMinRenameGapMs, indicatorSettleMs, indicatorSweepIntervalMs } from './utils/topicIndicatorPlan';
import { minFireIntervalMs } from './scheduler/recurrence';
import { defaultCheckStatusEveryMinutes } from './scheduler/checkStatus';
import { remoteRunLeaseMinMs, remoteRunLeaseMs } from './remoteRun/leaseTiming';
import { lidPollMinMs, lidPollMs } from './runnerUtility/lidPollTiming';
import { nodeUpkeepIntervalMs, nodeUpkeepMinMs } from './runnerUtility/nodeUpkeepTiming';
import { runnerVersionPollMinMs, runnerVersionPollMs } from './runnerUtility/versionPollTiming';
import { pairingLifetimeMinMs, pairingLifetimeMs } from './runners/pairingTiming';
import { probeAllTimeoutMs, probeDeadlineMinMs } from './remoteRun/probeTiming';
import { runnerWaitPollMinMs, runnerWaitPollMs } from './remoteRun/runnerWaitTiming';

/**
 * @description The ONE test-only timing seam: `CHARNESS_TEST_TIMINGS`, a JSON object of named overrides for the
 * production windows the process-level flows would otherwise wait out in real time (the Telegram send pacer's 2 s, a send
 * queue call's 30 s deadline, the
 * Jira poll's 10 s floor, the wake-up engine's 10 s turn poll and its sweep's minute, the first re-post retry's minute, the 30 s stagger of the wakes after a restart, the two-minute probe of an
 * unconfirmed usage limit, `state.json`'s save debounce, the OpenCode server's 60 s of retries, the 6 h pending-work hold, the 300 ms to the first read of an adopted json-stream session's output, the 15-minute gap of a passing check's status lines, the
 * todo reminder's 10 s poll and its interval, the 24 h between two rechecks of a used-up API credit and the 30 min poll that finds one due, the 45 s heartbeat lease of a foreground `charness remote-run` and its 10 s poll while it waits for a paired runner, and — a count, not a window —
 * the 200 `/bind` picker claims, the question wait — how long an unanswered agent question waits before it is set aside —, the 5 s / 10 min a prompt the bot delivers waits for a busy session, and the four windows of a topic's status mark: the 20 s a name holds before it is written (a turn runs that long before its ⏳ shows), the 60 s between two renames, the 5-minute sweep and the 5 s the boot's wave waits). It is NOT a setting: no
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
  /** The deadline of one Bot API call of a topic's send queue (production: `telegramSendOperationDeadlineMs`, 30 s). */
  telegramSendOperationDeadlineMs: createShorterWindowSchema(telegramSendOperationDeadlineMs).optional(),
  /** The Jira poll's interval, at most `jira.json`'s 10 s floor (production: `pollIntervalSeconds`, 10–600 s). */
  jiraPollIntervalMs: createShorterWindowSchema(jiraPollIntervalMinSeconds * msPerSecond).optional(),
  /** How often the wake-up engine polls the turns it watches for their end (production: `watchedTurnPollMs`, 10 s). */
  requestTurnPollMs: createShorterWindowSchema(watchedTurnPollMs).optional(),
  /** How often the wake-up engine sweeps the unwatched open requests (production: `unwatchedSweepMs`, 1 min). */
  requestSweepIntervalMs: createShorterWindowSchema(unwatchedSweepMs).optional(),
  /** The first retry of a request whose prompt could not be posted (production: `postRetryDelaysMs[0]`, 1 min). */
  requestFirstPostRetryDelayMs: createShorterWindowSchema(postRetryDelaysMs[0]).optional(),
  /** The gap between two wakes of tracker requests whose process was found gone, and before the first (production: `restartWakeStaggerMs`, 30 s). */
  requestRestartWakeStaggerMs: createShorterWindowSchema(restartWakeStaggerMs).optional(),
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
  /**
   * How long after the boot releases an adopted json-stream session its stdout is first read (production:
   * `basePollIntervalMs`, 300 ms; a write to the session meanwhile re-arms the read at that cadence). A flow reads it at
   * once to land the downtime replay right behind the boot's restore step.
   */
  adoptedTailFirstReadMs: createShorterWindowSchema(basePollIntervalMs).optional(),
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
  /** How often a linked `charness-runner` looks after its own Node.js again (production: `nodeUpkeepIntervalMs`, 24 h; at least `nodeUpkeepMinMs`). Read by the runner utility, not by the bot. */
  runnerNodeUpkeepMs: createShorterWindowSchema(nodeUpkeepIntervalMs).min(nodeUpkeepMinMs).optional(),
  /** How often a Mac's `charness-runner` looks at its lid (production: `lidPollMs`, 10 s; at least `lidPollMinMs`). Read by the runner utility, not by the bot. */
  runnerLidPollMs: createShorterWindowSchema(lidPollMs).min(lidPollMinMs).optional(),
  /** How long a runner pairing code works (production: `pairingLifetimeMs`, 10 min; at least `pairingLifetimeMinMs`). Read by `charness runners pair`, not by the bot's boot. */
  pairingLifetimeMs: createShorterWindowSchema(pairingLifetimeMs).min(pairingLifetimeMinMs).optional(),
  /** How often `charness remote-run --needs <capability>` looks again while it waits for an offline paired runner (production: `runnerWaitPollMs`, 10 s; at least `runnerWaitPollMinMs`). Read by the remote-run CLI, not by the bot. */
  remoteRunRunnerPollMs: createShorterWindowSchema(runnerWaitPollMs).min(runnerWaitPollMinMs).optional(),
  /** How long a view of the runners or a pick waits for every runner's answer in all (production: `probeAllTimeoutMs`, 20 s; at least `probeDeadlineMinMs`): a flow that needs a BUSY runner (its probe does not finish in time) cannot wait out 20 s. Read by the remote-run CLI and by the bot's `/runners` probe. */
  remoteRunProbeDeadlineMs: createShorterWindowSchema(probeAllTimeoutMs).min(probeDeadlineMinMs).optional(),
  /** The shortest gap between two fires of a cron schedule (production: `minFireIntervalMs`, 5 min). */
  scheduleMinFireIntervalMs: createShorterWindowSchema(minFireIntervalMs).optional(),
  /** The gap between two status lines of a passing check, in place of the check's own `statusEveryMinutes` (production: `defaultCheckStatusEveryMinutes`, 15 min; a job's own value is 5–240 min). */
  checkStatusIntervalMs: createShorterWindowSchema(defaultCheckStatusEveryMinutes * 60 * msPerSecond).optional(),
  /** How long an API account marked used up waits between two rechecks of its credit (production: `claudeApiCreditRecheckIntervalMs`, 24 h). */
  creditRecheckIntervalMs: createShorterWindowSchema(claudeApiCreditRecheckIntervalMs).optional(),
  /** How often the bot looks for an API account whose recheck day is up (production: `claudeApiCreditRecheckPollMs`, 30 min). */
  creditRecheckPollMs: createShorterWindowSchema(claudeApiCreditRecheckPollMs).optional(),
  /** How often a prompt the bot delivers (a scheduled one) looks again whether the busy session has finished its turn (production: `busyPollIntervalMs`, 5 s). */
  postBusyPollMs: createShorterWindowSchema(busyPollIntervalMs).optional(),
  /** How long such a prompt waits for the busy session before it is written to it anyway (production: `waitIdleTimeoutMs`, 10 min). */
  postWaitForIdleMs: createShorterWindowSchema(waitIdleTimeoutMs).optional(),
  /** The question wait, cut to at most this (production: `longestQuestionWaitMs`, the hour the setting's longest finite choice waits); `Don't wait` and `Wait for my answer` stay as they are. */
  questionSetAsideWaitMs: createShorterWindowSchema(longestQuestionWaitMs).optional(),
  /** The pause before the bot tries again to set a question aside after the agent's server did not take it (production: `setAsideRetryDelayMs`, 30 s). */
  questionSetAsideRetryMs: createShorterWindowSchema(setAsideRetryDelayMs).optional(),
  /** How long a name must have been the wanted one before it is written to the topic — a turn runs this long before its ⏳ shows (production: `indicatorSettleMs`, 20 s). */
  topicIndicatorSettleMs: createShorterWindowSchema(indicatorSettleMs).optional(),
  /** The least time between two renames of one topic (production: `indicatorMinRenameGapMs`, 60 s). */
  topicIndicatorMinRenameGapMs: createShorterWindowSchema(indicatorMinRenameGapMs).optional(),
  /** How often the bot looks at every topic's status again for the changes no event announces (production: `indicatorSweepIntervalMs`, 5 min). */
  topicIndicatorSweepMs: createShorterWindowSchema(indicatorSweepIntervalMs).optional(),
  /** How long after the polling starts the boot's rename wave waits for the first pending updates (production: `indicatorBootWaveDelayMs`, 5 s). */
  topicIndicatorBootWaveDelayMs: createShorterWindowSchema(indicatorBootWaveDelayMs).optional(),
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
