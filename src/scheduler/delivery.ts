import { t } from '../i18n';
import { getReminderScheduleText } from '../utils/reminderScheduleText';
import { formatLocalClock } from '../utils/localClock';
import {
  buildCheckFailurePrompt,
  checkAlertOutputMaxChars,
  checkIsCheckPassing,
  defaultCheckTimeoutSec,
  describeCheckFailure,
  getCheckAlertCommand,
  getCheckAlertDecision,
  getOutputTail,
  type CheckRunResult,
} from './checkRun';
import { checkIsCheckSchedule, checkIsReminderSchedule } from './deliveryKind';
import { describeSchedule } from './recurrence';
import type { DeliveryOutcome, FireContext, ScheduleRecord } from './types';

/**
 * @description Scheduler delivery (plan S4): the real `deliver(job, fireContext)`
 * callback the engine (S3) invokes at fire time. The flow is locked by the plan:
 *
 *   1. announce — post a visible message into the topic (job name + human
 *      schedule text + the prompt; a "missed at HH:MM" note for a catch-up run).
 *   2. pin      — pin that announcement (silent ONLY when the job opted in;
 *      default notifies all members). A pin failure degrades to a `console.warn`
 *      and the flow continues — the announcement is already visible.
 *   3. ensure session — if the thread's agent is active but BUSY, poll its busy
 *      probe every {@link busyPollIntervalMs} up to {@link waitIdleTimeoutMs}
 *      (do NOT interrupt live work), then forward (forwarding interrupts only as
 *      the timeout fallback — existing `forwardPromptToAgent` semantics). If no
 *      session, start one (with the job's `lastAdapterName` snapshot as the
 *      adapter fallback — a topic that never picked an agent and carries no
 *      snapshot fails with `no agent selected`). An unbound topic → outcome
 *      `failed` with a distinct error string the engine records (S8 turns that
 *      into a pause).
 *   4. forward — hand the prefixed prompt to the agent.
 *
 * A REMINDER record (`deliveryKind: 'reminder'`) stops after step 2: its whole
 * delivery IS the announcement plus its pin, which is what pierces a muted topic.
 * Steps 3–4 are skipped entirely, so a reminder fires in an unbound topic and in
 * General — there is no session to ensure, nothing to interrupt, and no agent to
 * tell about the run.
 *
 * A CHECK record (`deliveryKind: 'check'`) runs its command FIRST and decides
 * from the result and its persisted failing flag: a pass after a pass, or a
 * failure after a failure, posts nothing; a pass after a failure posts one
 * unpinned "passes again" line; the first failure posts the alert, pins it, and
 * then wakes the agent through steps 3–4 with the failure details ahead of the
 * job's prompt. An unbound topic fails with the same distinct error as a prompt
 * job, so it is paused the same way.
 *
 * It owns NO bot.ts import: every side effect is injected via
 * {@link ScheduleDeliveryDeps} (announce / pin / busy probe / ensure-session /
 * forward / clock / sleep), so bot.ts wires its existing functions in with thin
 * lambdas (S8) and the wait-loop is unit-testable on a fake clock.
 */

/** Poll cadence for the wait-for-idle loop: re-check the busy probe every 5s. */
export const busyPollIntervalMs = 5000;

/**
 * Upper bound on waiting for a busy session to go idle before forwarding anyway
 * (10 min, per plan IDEAL "after waitIdleTimeoutMs deliver anyway"). The forward
 * then takes the normal interrupt path (`forwardPromptToAgent` interrupts a
 * still-running turn), so a wedged turn never blocks a scheduled run forever.
 */
export const waitIdleTimeoutMs = 10 * 60 * 1000;

/** Distinct error string the engine records when a fire hits an unbound topic. */
export const unboundDeliveryError = 'thread is unbound';

/**
 * @name EnsureSessionResult
 * @description What {@link ScheduleDeliveryDeps.ensureSession} reports back. It
 * mirrors bot.ts's `ensureAgentSession` outcome without importing it: `ok` means
 * a session is ready (active, mid-startup, or just started — a prompt forwarded
 * now is delivered or buffered-then-replayed); `unbound`/`no-adapter`/
 * `start-failed` are the three failure reasons (`no-adapter` = bound topic that
 * never picked an agent and the job carried no `lastAdapterName`).
 */
export type EnsureSessionResult =
  | { ok: true }
  | { ok: false; reason: 'unbound' | 'no-adapter' | 'start-failed' };

/**
 * @name ScheduleDeliveryDeps
 * @description Everything the delivery callback needs from bot.ts, injected so
 * the module stays free of bot.ts imports and the poll loop is testable.
 * `threadKey` is the serialized `"<chatId>:<threadId>"` string carried on the
 * record; the bot's lambdas parse it back into a `SessionKey` where needed.
 */
export interface ScheduleDeliveryDeps {
  /**
   * Post the announcement into the topic (the bot bakes in priority
   * `'interactive'`). Resolves with the sent message id, or `null` when the
   * send failed — pinning is skipped on `null`.
   */
  announce: (threadKey: string, text: string) => Promise<number | null>;
  /** Pin the announcement. `isSilent` ⇒ `disable_notification`. Rejects on failure. */
  pin: (threadKey: string, messageId: number, isSilent: boolean) => Promise<void>;
  /** Whether the thread's agent is mid-turn right now (sync, in-memory probe). */
  checkBusy: (threadKey: string) => boolean;
  /** Ensure a session is ready, starting one with `fallbackAdapterName` if needed. */
  ensureSession: (threadKey: string, fallbackAdapterName?: string) => Promise<EnsureSessionResult>;
  /** Forward the (already-prefixed) prompt to the thread's agent. */
  forwardPrompt: (threadKey: string, text: string) => Promise<void>;
  /** Run a check job's command in the thread's bound folder; `null` when the thread is unbound. */
  runCheck: (threadKey: string, command: string, timeoutMs: number) => Promise<CheckRunResult | null>;
  /** Persist a check job's failing flag (it decides whether the next run alerts). */
  setCheckFailing: (jobId: string, isFailing: boolean) => Promise<void>;
  /** Current epoch ms — injected so the wait loop runs on a fake clock in tests. */
  now: () => number;
  /** Sleep `ms` — injected so the wait loop's pauses are driven by a fake timer in tests. */
  sleep: (ms: number) => Promise<void>;
}

/**
 * @description Prefix a scheduled job's prompt with a single English line that
 * tells the agent THIS turn is a scheduled run — `[Scheduled run "<name>"]`.
 * Pure, English-stable (same convention as the `[Telegram thread context]`
 * preamble): the agent may have no memory of the schedule being created (a
 * different session, or created by the human, not the agent), so the visible
 * topic announcement alone is not enough — the forwarded prompt itself must
 * carry the marker so the agent acts on it as a scheduled task, not a stray
 * message. Kept to one line so it never overwhelms a short prompt.
 */
export function prependScheduledRunMarker(jobName: string, prompt: string): string {
  return `[Scheduled run "${jobName}"]\n${prompt}`;
}

/**
 * @description Build the visible fire-announcement text via i18n, per delivery
 * kind: a prompt job frames the run as a scheduled prompt for the agent, a
 * reminder leads with its own text (the pin notification previews it, so the
 * operator reads the reminder without opening the topic). Both interpolate the
 * SAME `{missedNote}` — the catch-up annotation (host-local HH:MM of the missed
 * instant) for a `catch-up` fire, empty for an `on-time` run — so a replayed run
 * is annotated identically whichever kind it is.
 *
 * The `{schedule}` text differs per kind ON PURPOSE. A prompt job keeps
 * English-only {@link describeSchedule} (its announcement is read alongside the
 * agent-facing prompt). A reminder uses the LOCALIZED
 * {@link getReminderScheduleText} — the very same words its `/reminders` list row
 * and card show, because describing one reminder two different ways is a defect.
 */
export function buildFireAnnouncement(job: ScheduleRecord, fireContext: FireContext): string {
  const missedNote = getMissedNote(fireContext);
  if (checkIsReminderSchedule(job)) {
    return t('reminders.fired', {
      text: job.prompt,
      schedule: getReminderScheduleText(job.spec),
      missedNote,
    });
  }
  return t('schedule.fired', {
    name: job.name,
    schedule: describeSchedule(job.spec),
    prompt: job.prompt,
    missedNote,
  });
}

/** @description The catch-up note of a fire, empty for an on-time run. */
function getMissedNote(fireContext: FireContext): string {
  return fireContext.kind === 'catch-up' && fireContext.missedAtMs !== undefined
    ? t('schedule.missedNote', { time: formatLocalClock(fireContext.missedAtMs) })
    : '';
}

/** @description The topic alert of a check's first failure: what failed, how, and the output tail. */
export function buildCheckFailedAnnouncement(
  job: ScheduleRecord,
  fireContext: FireContext,
  failure: string,
  output: string,
): string {
  return t('schedule.checkFailed', {
    name: job.name,
    schedule: describeSchedule(job.spec),
    missedNote: getMissedNote(fireContext),
    failure,
    command: getCheckAlertCommand(job.checkCommand ?? ''),
    output: getOutputTail(output.trim(), checkAlertOutputMaxChars) || '—',
  });
}

/**
 * @description Wait for a busy session to go idle, polling the busy probe every
 * {@link busyPollIntervalMs} until it reports idle or {@link waitIdleTimeoutMs}
 * elapses (whichever comes first). Returns when it is time to forward — the
 * caller forwards regardless (a timeout falls through to the normal interrupt
 * path). Driven by the injected `now`/`sleep` so a test can advance a fake clock
 * and assert the exact number of polls.
 */
async function waitForIdle(deps: ScheduleDeliveryDeps, threadKey: string): Promise<void> {
  const deadline = deps.now() + waitIdleTimeoutMs;
  while (deps.checkBusy(threadKey)) {
    if (deps.now() >= deadline) return;
    await deps.sleep(busyPollIntervalMs);
  }
}

/**
 * @description Steps 1–2: post the announcement and pin it. A pin failure only
 * logs — the announcement is already visible.
 */
async function announceAndPin(deps: ScheduleDeliveryDeps, job: ScheduleRecord, text: string): Promise<void> {
  const messageId = await deps.announce(job.threadKey, text);
  if (messageId === null) return;
  try {
    await deps.pin(job.threadKey, messageId, job.isPinSilent === true);
  } catch (error) {
    console.warn(
      `[scheduler] pin announcement for job ${job.id} failed:`,
      error instanceof Error ? error.message : error,
    );
  }
}

/**
 * @description Steps 3–4: make sure the thread has a session, wait for a busy one
 * to go idle, and forward `prompt` (already carrying its marker).
 */
async function deliverToAgent(
  deps: ScheduleDeliveryDeps,
  job: ScheduleRecord,
  prompt: string,
): Promise<DeliveryOutcome> {
  const { threadKey } = job;

  // 3. ensure a session and (if busy) wait for idle
  const session = await deps.ensureSession(threadKey, job.lastAdapterName);
  if (!session.ok) {
    // Unbound → distinct error the engine records; S8 pauses the job on it.
    // no-adapter → the topic never picked an agent; start-failed → a start
    // that threw. Both surface their own readable ledger reason.
    const error =
      session.reason === 'unbound'
        ? unboundDeliveryError
        : session.reason === 'no-adapter'
          ? 'no agent selected for this topic'
          : 'failed to start agent session';
    return { status: 'failed', error };
  }

  if (deps.checkBusy(threadKey)) {
    await waitForIdle(deps, threadKey);
  }

  // 4. forward the prefixed prompt (forward interrupts only as the fallback)
  try {
    await deps.forwardPrompt(threadKey, prompt);
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
  }

  return { status: 'delivered' };
}

/**
 * @description The check flow: run the command, then stay quiet, post the
 * "passes again" line, or raise the alert and wake the agent. The failing flag is
 * stored BEFORE the agent is woken, so a restart mid-delivery cannot raise the
 * same alert twice.
 */
async function deliverCheck(
  deps: ScheduleDeliveryDeps,
  job: ScheduleRecord,
  fireContext: FireContext,
): Promise<DeliveryOutcome> {
  const timeoutSec = job.checkTimeoutSec ?? defaultCheckTimeoutSec;
  const command = job.checkCommand ?? '';
  const result = await deps.runCheck(job.threadKey, command, timeoutSec * 1000);
  if (!result) return { status: 'failed', error: unboundDeliveryError };

  const decision = getCheckAlertDecision({
    isPassing: checkIsCheckPassing(result),
    wasFailing: job.isCheckFailing === true,
  });
  if (decision === 'quiet') return { status: 'delivered' };
  if (decision === 'recovered') {
    await deps.setCheckFailing(job.id, false);
    await deps.announce(job.threadKey, t('schedule.checkRecovered', { name: job.name }));
    return { status: 'delivered' };
  }

  await deps.setCheckFailing(job.id, true);
  const failure = describeCheckFailure(result, timeoutSec);
  await announceAndPin(deps, job, buildCheckFailedAnnouncement(job, fireContext, failure, result.output));
  return deliverToAgent(
    deps,
    job,
    buildCheckFailurePrompt({ name: job.name, command, failure, output: result.output, prompt: job.prompt }),
  );
}

/**
 * @description Build the engine's `deliver(job, fireContext)` callback bound to
 * the injected deps. See the module header for the locked flow.
 */
export function createScheduleDelivery(
  deps: ScheduleDeliveryDeps,
): (job: ScheduleRecord, fireContext: FireContext) => Promise<DeliveryOutcome> {
  return async (job, fireContext) => {
    if (checkIsCheckSchedule(job)) return deliverCheck(deps, job, fireContext);

    // 1–2. announce and pin
    await announceAndPin(deps, job, buildFireAnnouncement(job, fireContext));

    // A reminder is done here: announced and pinned, with no agent involved at
    // all. Returning before `ensureSession` is also what lets it fire in an
    // unbound topic and in General — there is no session to fail to ensure.
    if (checkIsReminderSchedule(job)) return { status: 'delivered' };

    // 3–4. wake the agent with the prompt
    return deliverToAgent(deps, job, prependScheduledRunMarker(job.name, job.prompt));
  };
}
