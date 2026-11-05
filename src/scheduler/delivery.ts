import { t } from '../i18n';
import { getReminderScheduleText } from '../utils/reminderScheduleText';
import { formatLocalClock, formatLocalDateAndClock } from '../utils/localClock';
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
import {
  buildCheckStatusLine,
  checkIsCheckStatusDue,
  checkIsFinalCheckRun,
  checkStatusCommandTimeoutSec,
  getCheckStatusActivityFromOutput,
  getCheckStatusIntervalMs,
  getCheckStatusSinceMs,
} from './checkStatus';
import { checkIsCheckSchedule, checkIsReminderSchedule } from './deliveryKind';
import { describeSchedule } from './recurrence';
import type { DeliveryOutcome, FireContext, ScheduleRecord } from './types';
import { postToSession, type PostToSessionDeps } from '../postToSession';

/**
 * @description Scheduler delivery (plan S4): the real `deliver(job, fireContext)`
 * callback the engine (S3) invokes at fire time. The flow is locked by the plan:
 *
 *   1. announce — post a visible message into the topic (job name + human
 *      schedule text + the prompt; a "missed at HH:MM" note for a catch-up run).
 *   2. pin      — pin that announcement (silent ONLY when the job opted in;
 *      default notifies all members). A pin failure degrades to a `console.warn`
 *      and the flow continues — the announcement is already visible.
 *   3–4. post the prefixed prompt to the session ({@link postToSession}, shared
 *      with the Jira connector): ensure a session (starting one with the job's
 *      `lastAdapterName` snapshot as the adapter fallback — a topic that never
 *      picked an agent and carries no snapshot fails with `no agent selected`),
 *      let a BUSY one finish its turn up to the wait bound, then forward. An
 *      unbound topic → outcome `failed` with a distinct error string the engine
 *      records (S8 turns that into a pause).
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

/** Distinct error string the engine records when a fire hits an unbound topic. */
export const unboundDeliveryError = 'thread is unbound';

/**
 * @name ScheduleDeliveryDeps
 * @description Everything the delivery callback needs from bot.ts, injected so
 * the module stays free of bot.ts imports and the poll loop is testable.
 * `threadKey` is the serialized `"<chatId>:<threadId>"` string carried on the
 * record; the bot's lambdas parse it back into a `SessionKey` where needed.
 */
export interface ScheduleDeliveryDeps extends PostToSessionDeps {
  /**
   * Post the announcement into the topic (the bot bakes in priority
   * `'interactive'`). Resolves with the sent message id, or `null` when the
   * send failed — pinning is skipped on `null`.
   */
  announce: (threadKey: string, text: string) => Promise<number | null>;
  /** Pin the announcement. `isSilent` ⇒ `disable_notification`. Rejects on failure. */
  pin: (threadKey: string, messageId: number, isSilent: boolean) => Promise<void>;
  /** Run a check job's command in the thread's bound folder; `null` when the thread is unbound. */
  runCheck: (threadKey: string, command: string, timeoutMs: number) => Promise<CheckRunResult | null>;
  /** Persist a check job's failing flag (it decides whether the next run alerts). */
  setCheckFailing: (jobId: string, isFailing: boolean) => Promise<void>;
  /** Remember a check alert's pinned message on its job, so cancelling the job unpins it. */
  recordAlertPin: (jobId: string, messageId: number) => Promise<void>;
  /** Whether this conversation shows status lines at all (a Telegram topic whose view shows the agent's stream). */
  checkIsStatusShown: (threadKey: string) => boolean;
  /**
   * Post a status line SILENTLY (no notification, never pinned) and resolve with its message id, or `null` when the send
   * failed. It is the bot's own message: it never reaches an agent.
   */
  postStatus: (threadKey: string, text: string) => Promise<number | null>;
  /** Delete a message of the topic, best effort: one that is gone or too old to delete is not an error. */
  deleteMessage: (threadKey: string, messageId: number) => Promise<void>;
  /** What the worker whose run directory is `runDir` (relative to the bound folder, or absolute) did last; `null` when unreadable. */
  readWorkerActivity: (threadKey: string, runDir: string) => Promise<string | null>;
  /**
   * Persist the status line a job now has in the topic (`null`: it has none). Resolves `false` when the job no longer
   * exists (it was cancelled while the line was being posted), so the caller can delete the line it just posted.
   */
  recordStatusLine: (jobId: string, line: CheckStatusLine | null) => Promise<boolean>;
  /** Test seam (`CHARNESS_TEST_TIMINGS`): the status interval in place of the job's `statusEveryMinutes`. */
  statusIntervalOverrideMs?: number;
}

/** @name CheckStatusLine @description A status line as the topic holds it: its message and when it was posted. */
export interface CheckStatusLine {
  messageId: number;
  postedAtMs: number;
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
export function prependScheduledRunMarker(jobName: string, prompt: string, options: { dueAtMs?: number } = {}): string {
  const dueNote = options.dueAtMs === undefined ? '' : ` · was due at ${formatLocalDateAndClock(options.dueAtMs)}`;
  return `[Scheduled run "${jobName}"${dueNote}]\n${prompt}`;
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
 * @description Steps 1–2: post the announcement and pin it; resolves with the pinned message id. A pin failure only
 * logs — the announcement is already visible — and resolves null, as a failed send does.
 */
async function announceAndPin(deps: ScheduleDeliveryDeps, job: ScheduleRecord, text: string): Promise<number | null> {
  const messageId = await deps.announce(job.threadKey, text);
  if (messageId === null) return null;
  try {
    await deps.pin(job.threadKey, messageId, job.isPinSilent === true);
    return messageId;
  } catch (error) {
    console.warn(
      `[scheduler] pin announcement for job ${job.id} failed:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/**
 * @description Steps 3–4: post `prompt` (already carrying its marker) into the
 * thread's session through {@link postToSession} and map its outcome onto the
 * engine's delivery outcome.
 */
async function deliverToAgent(
  deps: ScheduleDeliveryDeps,
  job: ScheduleRecord,
  prompt: string,
  options: { heldText?: string } = {},
): Promise<DeliveryOutcome> {
  // 3–4. ensure a session, let a busy one finish its turn, forward the prefixed prompt
  const posted = await postToSession(deps, job.threadKey, prompt, job.lastAdapterName, options);
  if (posted.ok) {
    // A run held during a usage-limit wait reaches the agent once the wait ends —
    // with its resume, the operator's next message, or the next session (R23).
    if (posted.isHeld) console.log(`[scheduler] job ${job.id}: held until the usage-limit wait ends`);
    return { status: 'delivered' };
  }
  // Unbound → distinct error the engine records; S8 pauses the job on it.
  // no-adapter → the topic never picked an agent; start-failed → a start
  // that threw; a failed forward keeps its own message.
  switch (posted.reason) {
    case 'unbound':
      return { status: 'failed', error: unboundDeliveryError };
    case 'no-adapter':
      return { status: 'failed', error: 'no agent selected for this topic' };
    case 'start-failed':
      return { status: 'failed', error: 'failed to start agent session' };
    case 'forward-failed':
      return { status: 'failed', error: posted.error };
  }
}

/**
 * @description Take a job's status line out of the topic and out of its record. The record is cleared first: a crash between
 * the two leaves an orphan line in the topic, never a record that points at a message that was already deleted. Never
 * rejects — the alert of a failed check runs right after it, and a status line must not be able to stop that.
 */
async function clearCheckStatusLine(deps: ScheduleDeliveryDeps, job: ScheduleRecord): Promise<void> {
  if (job.statusMessageId === undefined) return;
  try {
    await deps.recordStatusLine(job.id, null);
    await deps.deleteMessage(job.threadKey, job.statusMessageId);
  } catch (error) {
    console.warn(`[scheduler] clearing the status line of job ${job.id} failed:`, error instanceof Error ? error.message : error);
  }
}

/**
 * @description The «now» of a due status line: the worker's last activity for a run-directory source, the first output line
 * of an exit-0 run for a command source; `null` (the line is posted without its «now») when nothing readable came back.
 */
async function readCheckStatusActivity(deps: ScheduleDeliveryDeps, job: ScheduleRecord): Promise<string | null> {
  if (job.statusWorkerRunDir !== undefined) return deps.readWorkerActivity(job.threadKey, job.statusWorkerRunDir);
  if (job.statusCommand === undefined) return null;
  const result = await deps.runCheck(job.threadKey, job.statusCommand, checkStatusCommandTimeoutSec * 1000);
  return result !== null && checkIsCheckPassing(result) ? getCheckStatusActivityFromOutput(result.output) : null;
}

/**
 * @description The status line of a PASSING check run. No status source → nothing, exactly as a plain check. A topic that does
 * not show the agent's stream (the answers-only view, a tracker issue) or the job's final run → the existing line is taken
 * away and no new one is posted. A line not yet due → nothing. A due line is posted SILENTLY, recorded, and only then is the
 * previous one deleted — the topic always holds one line per check, at the bottom of the activity (an edit in place would
 * not bump the topic). A failed post changes nothing: the old line stays and the next run tries again. This path never
 * touches {@link postToSession}: the agent is not woken, so it costs no tokens and works while the agent is idle,
 * compacting or stopped. A failure here only costs the line — it is logged and never turns a passing check into a failed run.
 */
async function updateCheckStatus(deps: ScheduleDeliveryDeps, job: ScheduleRecord): Promise<void> {
  if (job.statusWorkerRunDir === undefined && job.statusCommand === undefined) return;
  try {
    if (!deps.checkIsStatusShown(job.threadKey) || checkIsFinalCheckRun(job)) {
      await clearCheckStatusLine(deps, job);
      return;
    }
    const nowMs = deps.now();
    const intervalMs = deps.statusIntervalOverrideMs ?? getCheckStatusIntervalMs(job);
    if (!checkIsCheckStatusDue({ sinceMs: getCheckStatusSinceMs(job), nowMs, intervalMs })) return;

    const activity = await readCheckStatusActivity(deps, job);
    const text = buildCheckStatusLine({ name: job.name, elapsedMs: nowMs - Date.parse(job.createdAt), activity });
    const messageId = await deps.postStatus(job.threadKey, text);
    if (messageId === null) return;
    const isRecorded = await deps.recordStatusLine(job.id, { messageId, postedAtMs: deps.now() });
    // A job cancelled while its line was being posted has nothing to point at it: the line goes at once.
    const staleMessageId = isRecorded ? job.statusMessageId : messageId;
    if (staleMessageId !== undefined) await deps.deleteMessage(job.threadKey, staleMessageId);
  } catch (error) {
    console.warn(`[scheduler] status line of job ${job.id} failed:`, error instanceof Error ? error.message : error);
  }
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
  if (!result) {
    // An unbound topic parks the job, which then never runs again: its last «works …» line would stay frozen under it.
    await clearCheckStatusLine(deps, job);
    return { status: 'failed', error: unboundDeliveryError };
  }

  const isPassing = checkIsCheckPassing(result);
  const decision = getCheckAlertDecision({ isPassing, wasFailing: job.isCheckFailing === true });
  if (decision === 'quiet') {
    // `quiet` is also a failure that keeps failing: its line went with the alert, and a failing check posts none.
    if (isPassing) await updateCheckStatus(deps, job);
    return { status: 'delivered' };
  }
  if (decision === 'recovered') {
    await deps.setCheckFailing(job.id, false);
    await deps.announce(job.threadKey, t('schedule.checkRecovered', { name: job.name }));
    await updateCheckStatus(deps, job);
    return { status: 'delivered' };
  }

  // The failure is the worker's end (or hang): its status line would now be a lie under the alert.
  await clearCheckStatusLine(deps, job);
  await deps.setCheckFailing(job.id, true);
  const failure = describeCheckFailure(result, timeoutSec);
  const alertPinId = await announceAndPin(deps, job, buildCheckFailedAnnouncement(job, fireContext, failure, result.output));
  if (alertPinId !== null) await deps.recordAlertPin(job.id, alertPinId);
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
    // Read before the paced announce and pin, which can take a while under load:
    // a run held over a usage-limit wait says when it was due (R27).
    const dueAtMs = fireContext.kind === 'catch-up' && fireContext.missedAtMs !== undefined ? fireContext.missedAtMs : deps.now();

    // 1–2. announce and pin
    await announceAndPin(deps, job, buildFireAnnouncement(job, fireContext));

    // A reminder is done here: announced and pinned, with no agent involved at
    // all. Returning before `ensureSession` is also what lets it fire in an
    // unbound topic and in General — there is no session to fail to ensure.
    if (checkIsReminderSchedule(job)) return { status: 'delivered' };

    // 3–4. wake the agent with the prompt. A run held over a usage-limit wait
    // reaches the agent later: it says when it was due (R27).
    return deliverToAgent(deps, job, prependScheduledRunMarker(job.name, job.prompt), {
      heldText: prependScheduledRunMarker(job.name, job.prompt, { dueAtMs }),
    });
  };
}
