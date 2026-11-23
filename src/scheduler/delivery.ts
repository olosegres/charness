import { t } from '../i18n';
import { getReminderScheduleText } from '../utils/reminderScheduleText';
import { formatLocalClock, formatLocalDateAndClock } from '../utils/localClock';
import {
  buildCheckFailurePrompt,
  checkAlertOutputMaxChars,
  checkIsCheckPassing,
  defaultCheckTimeoutSec,
  describeCheckFailure,
  getCheckAlertDecision,
  getOutputTail,
  type CheckRunResult,
} from './checkRun';
import {
  buildCheckStatusLine,
  checkIsCheckStatusDue,
  checkStatusCommandTimeoutSec,
  getCheckShownName,
  getCheckStatusActivityFromOutput,
  getCheckStatusElapsedText,
  getCheckStatusIntervalMs,
  getCheckStatusSinceMs,
  msPerMinute,
} from './checkStatus';
import { checkIsCheckSchedule, checkIsReminderSchedule } from './deliveryKind';
import { checkIsFinalRun } from './recurrence';
import { getAnnouncedScheduleText } from './scheduleText';
import type { CheckStatusLine, DeliveryOutcome, FireContext, ScheduleRecord } from './types';
import { getWorkerWatchEnd, workerWatchSilenceMinutes, workerWatchUnreportedMinutes } from './workerWatch';
import { postToSession, type PostToSessionDeps, type SessionPromptText } from '../postToSession';
import type { OpenRequestState } from '../requests/types';
import { KeyedTransitionQueue } from '../utils/keyedTransitionQueue';
import {
  buildTopicScheduledRunHeader,
  buildTrackerScheduledRunHeader,
  getRiddenRequest,
  pickTopicRunTarget,
  pickTrackerRunTarget,
  type RiddenRequest,
  type TopicRunTarget,
  type TrackerRunTarget,
} from './scheduledRunTarget';

/**
 * @description Scheduler delivery (plan S4): the real `deliver(job, fireContext)`
 * callback the engine (S3) invokes at fire time. The flow is locked by the plan:
 *
 *   1. announce — post a SILENT message into the topic: «⏰ Scheduled: <name> ·
 *      <human schedule>» (+ a "missed at HH:MM" note for a catch-up run), with the
 *      prompt folded under it (an agent instruction, not something to read by
 *      default). Never pinned: a scheduled run is ordinary output.
 *   3–4. post the prefixed prompt to the session ({@link postToSession}, shared
 *      with the Jira connector): ensure a session (starting one with the job's
 *      `lastAdapterName` snapshot as the adapter fallback — a topic that never
 *      picked an agent and carries no snapshot fails with `no agent selected`),
 *      let a BUSY one finish its turn up to the wait bound, then forward. An
 *      unbound topic → outcome `failed` with a distinct error string the engine
 *      records (S8 turns that into a pause).
 *
 * A REMINDER record (`deliveryKind: 'reminder'`) is the one thing still pinned:
 * its whole delivery IS the announcement plus its pin, which is what pierces a
 * muted topic, and it stops there. Steps 3–4 are skipped entirely, so a reminder
 * fires in an unbound topic and in General — there is no session to ensure,
 * nothing to interrupt, and no agent to tell about the run.
 *
 * A CHECK record (`deliveryKind: 'check'`) runs its command FIRST and decides
 * from the result and its persisted failing flag: a pass after a pass, or a
 * failure after a failure, posts nothing; a pass after a failure posts one
 * "is back to normal" line; the first failure posts a one-sentence silent notice
 * (never the command; a worker watch says "finished" or "silent", any other check
 * folds the output under "fired") and then wakes the agent through steps 3–4 with
 * the command, the failure details and the output ahead of the job's prompt. An
 * unbound topic fails with the same distinct error as a prompt job, so it is
 * paused the same way.
 *
 * A TRACKER conversation (a Jira issue, `ScheduleDeliveryDeps.trackerRun`) has no feed the bot may post into — a comment
 * always notifies the requester and the issue's watchers — so the scheduler posts NOTHING there: no announcement, no
 * «back to normal» line, no status line, no check alert. A fire only wakes the agent, and the prompt it is woken with rides
 * the request that is open (`scheduledRunTarget.ts`): it starts with a header naming that request, and the turn it starts is
 * watched as that request's turn (a scheduled run's). A job armed under a request that is finished says so in its header.
 *
 * A TOPIC whose view has requests (`ScheduleDeliveryDeps.topicRun`) meets them by the same model: the fire rides the request its job
 * was armed under, else the scheduler's own open request, behind a header naming it — and opens the scheduler's request only when
 * there is none to ride (`scheduledRunTarget.ts`, `src/requests/README.md` § Scheduled runs). A fire never replaces a live request.
 *
 * It owns NO bot.ts import: every side effect is injected via
 * {@link ScheduleDeliveryDeps} (announce / pin / busy probe / ensure-session /
 * forward / clock / sleep), so bot.ts wires its existing functions in with thin
 * lambdas (S8) and the wait-loop is unit-testable on a fake clock.
 */

/** Distinct error string the engine records when a fire hits an unbound topic. */
export const unboundDeliveryError = 'thread is unbound';

/**
 * @name ScheduleAnnounceOptions
 * @description How a topic message of the scheduler is sent.
 */
export interface ScheduleAnnounceOptions {
  /** Send without a notification: the bot's ordinary output. Absent only for a reminder, which is meant to ring. */
  isSilent?: boolean;
  /**
   * Text folded under the message: the reader opens it on demand (Telegram: an expandable quote). Plain text — the
   * platform escapes it.
   */
  foldedDetail?: string;
}

/** @name ScheduleAnnouncement @description What a fire or an alert says in the topic: the sentence, and the detail folded under it. */
export interface ScheduleAnnouncement {
  text: string;
  foldedDetail?: string;
}

/**
 * @name ScheduleDeliveryDeps
 * @description Everything the delivery callback needs from bot.ts, injected so
 * the module stays free of bot.ts imports and the poll loop is testable.
 * `threadKey` is the serialized `"<chatId>:<threadId>"` string carried on the
 * record; the bot's lambdas parse it back into a `SessionKey` where needed.
 */
export interface ScheduleDeliveryDeps extends PostToSessionDeps {
  /**
   * Post a message into the topic (the bot bakes in priority `'interactive'`). Resolves with the sent message id, or
   * `null` when the send failed — a reminder's pin is skipped on `null`.
   */
  announce: (threadKey: string, text: string, options?: ScheduleAnnounceOptions) => Promise<number | null>;
  /** Pin a REMINDER's announcement, notifying (that is how a reminder pierces a muted topic). Rejects on failure. */
  pin: (threadKey: string, messageId: number) => Promise<void>;
  /**
   * Unpin these messages of the topic and resolve with the ids that are STILL pinned and worth another try (Telegram did not
   * answer, asked to slow down, failed on its side). A message that is gone, was never pinned or cannot be unpinned any more
   * is final, so it is not in the list. Never rejects.
   */
  unpinMessages: (threadKey: string, messageIds: readonly number[]) => Promise<number[]>;
  /** Run a check job's command in the thread's bound folder; `null` when the thread is unbound. */
  runCheck: (threadKey: string, command: string, timeoutMs: number) => Promise<CheckRunResult | null>;
  /** Persist a check job's failing flag (it decides whether the next run alerts). */
  setCheckFailing: (jobId: string, isFailing: boolean) => Promise<void>;
  /** Forget these alert pins of an earlier version on a job (`ScheduleRecord.alertPinMessageIds`), once they are unpinned. */
  clearAlertPins: (jobId: string, releasedMessageIds: readonly number[]) => Promise<void>;
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
  /** What a TRACKER conversation's fires need; absent: every conversation is a topic the bot posts into. */
  trackerRun?: TrackerRunPorts;
  /** How a TOPIC's fires meet its requests; absent: a topic's fire is the shared `forwardPrompt` as it is. */
  topicRun?: TopicRunPorts;
}

/**
 * @name TrackerRunPorts
 * @description How a fire is delivered in a tracker conversation (see the module header). `describeConversation` is read
 * once per fire: `null` — not a tracker conversation (a Telegram topic), the fire is delivered as there; else the
 * label the header names the conversation by (`Jira issue PROJ-12 (<link>)`). `listOpenRequests` and `forwardRun` are read
 * at forward time, when the post may have waited behind a running turn: `forwardRun` writes the text into the session and
 * watches the turn it starts as the scheduled run of the request it rides (`null`: no request is open, nothing to watch), told whether
 * the fire's job is one of that request's own (`RiddenRequest.isRequestJob`).
 * `fallbackAdapterName` is the connector's own backend, which a session that cannot be resumed starts on.
 */
export interface TrackerRunPorts {
  describeConversation: (threadKey: string) => string | null;
  listOpenRequests: (threadKey: string) => OpenRequestState[];
  forwardRun: (threadKey: string, text: string, ridden: RiddenRequest | null) => Promise<void>;
  fallbackAdapterName: string;
}

/**
 * @name TopicRunPorts
 * @description How a fire meets a topic's requests, all read at FORWARD time (the post may have waited behind a running turn, and the
 * view may have changed). `getRequestView` — `null`: the view has no requests (the stream view), the fire is a plain prompt; else
 * whether the requester sees the agent's plain text. `forwardRun` writes the text into the session and watches the turn it starts as
 * the scheduled run of the request it rides (`RiddenRequest`, as a tracker's); `forwardOwnRequestRun` opens the scheduler's request for the text, forwards
 * it behind that request's header and watches the turn as the request's own scheduled run.
 */
export interface TopicRunPorts {
  getRequestView: (threadKey: string) => { isPlainTextHidden: boolean } | null;
  listOpenRequests: (threadKey: string) => OpenRequestState[];
  forwardRun: (threadKey: string, text: string, ridden: RiddenRequest) => Promise<void>;
  forwardOwnRequestRun: (threadKey: string, text: string) => Promise<void>;
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
 * @description Build the visible fire announcement via i18n, per delivery kind. A prompt job says «⏰ Scheduled: <name> ·
 * <schedule>» and folds its prompt under it: the prompt is an instruction for the agent, not something a person reads by
 * default. A reminder leads with its own text (the pin notification previews it, so the operator reads the reminder
 * without opening the topic) and carries nothing folded. Both interpolate the SAME `{missedNote}` — the catch-up annotation
 * (host-local HH:MM of the missed instant) for a `catch-up` fire, empty for an `on-time` run.
 *
 * A reminder's `{schedule}` is always the LOCALIZED {@link getReminderScheduleText} — the very same words its `/reminders`
 * list row and card show, because describing one reminder two different ways is a defect. A prompt job's goes through
 * {@link getAnnouncedScheduleText}, which counts the next run from `nowMs` where nothing phrases the shape.
 */
export function buildFireAnnouncement(job: ScheduleRecord, fireContext: FireContext, nowMs: number): ScheduleAnnouncement {
  const missedNote = getMissedNote(fireContext);
  if (checkIsReminderSchedule(job)) {
    return {
      text: t('reminders.fired', {
        text: job.prompt,
        schedule: getReminderScheduleText(job.spec),
        missedNote,
      }),
    };
  }
  return {
    text: t('schedule.fired', {
      name: job.name,
      schedule: getAnnouncedScheduleText(job.spec, nowMs),
      missedNote,
    }),
    foldedDetail: job.prompt,
  };
}

/** @description The catch-up note of a fire, empty for an on-time run. */
function getMissedNote(fireContext: FireContext): string {
  return fireContext.kind === 'catch-up' && fireContext.missedAtMs !== undefined
    ? t('schedule.missedNote', { time: formatLocalClock(fireContext.missedAtMs) })
    : '';
}

/**
 * @name CheckFailedAnnouncementInput
 * @description What the notice of a check's first failure is built from: the job, the failed run, its short description
 * ({@link describeCheckFailure}) and the instant the notice is made at (how long a worker ran).
 */
export interface CheckFailedAnnouncementInput {
  job: ScheduleRecord;
  result: CheckRunResult;
  failure: string;
  nowMs: number;
}

/**
 * @description The topic notice of a check's first failure, in one sentence and never with the command (that goes to the
 * agent's prompt only). A worker watch (a check with a status source of a worker's run directory) says what happened to
 * the worker: finished (its process is gone), silent for {@link workerWatchSilenceMinutes} minutes, or running for
 * {@link workerWatchUnreportedMinutes} minutes since the watch was armed without a report. Any other check — and a
 * worker watch that failed some other way, a timeout say — says it fired, with what failed and the output tail folded under
 * it, because the failure is the only thing a person can use to tell why.
 */
export function buildCheckFailedAnnouncement(input: CheckFailedAnnouncementInput): ScheduleAnnouncement {
  const { job, result, failure } = input;
  if (job.statusWorkerRunDir !== undefined) {
    const workerEnd = getWorkerWatchEnd(result);
    const name = getCheckShownName(job.name);
    if (workerEnd === 'finished') {
      return { text: t('schedule.workerFinished', { name, elapsed: getCheckStatusElapsedText(input.nowMs - Date.parse(job.createdAt)) }) };
    }
    if (workerEnd === 'silent') return { text: t('schedule.workerSilent', { name, minutes: workerWatchSilenceMinutes }) };
    if (workerEnd === 'unreported') {
      return { text: t('schedule.workerUnreported', { name, elapsed: getCheckStatusElapsedText(workerWatchUnreportedMinutes * msPerMinute) }) };
    }
  }
  const outputTail = getOutputTail(result.output.trim(), checkAlertOutputMaxChars);
  return {
    text: t('schedule.checkFired', { name: job.name }),
    foldedDetail: outputTail === '' ? failure : `${failure}\n\n${outputTail}`,
  };
}

/**
 * @description The line for a check that passes again, in the words of its failure notice: a worker watch speaks of the worker
 * (and its shown name, without the recipe's `watch `), any other check of the check.
 */
export function buildCheckRecoveredText(job: ScheduleRecord): string {
  return job.statusWorkerRunDir !== undefined
    ? t('schedule.workerResumed', { name: getCheckShownName(job.name) })
    : t('schedule.checkRecovered', { name: job.name });
}

/**
 * @description A REMINDER's step 1–2: post the announcement and pin it (notifying: the pin is what pierces a muted topic);
 * a pin failure only logs — the announcement is already visible. The only pin the scheduler still makes.
 */
async function announceAndPinReminder(deps: ScheduleDeliveryDeps, job: ScheduleRecord, text: string): Promise<void> {
  const messageId = await deps.announce(job.threadKey, text);
  if (messageId === null) return;
  try {
    await deps.pin(job.threadKey, messageId);
  } catch (error) {
    console.warn(
      `[scheduler] pin announcement for job ${job.id} failed:`,
      error instanceof Error ? error.message : error,
    );
  }
}

/**
 * @description Earlier versions pinned every check alert and remembered the pinned ids on the job. They are released at the
 * job's next run: unpinned, then forgotten (in that order — a crash in between repeats the harmless unpin). Only the ids that
 * ARE released are forgotten: one Telegram did not answer for stays on the job and is tried again at the next run, so no old
 * alert stays pinned for good. Never rejects — a check must run whatever happens to an old pin. A job that never runs again
 * (paused) keeps them until `schedule_cancel`, which releases them too.
 */
async function releaseLegacyAlertPins(deps: ScheduleDeliveryDeps, job: ScheduleRecord): Promise<void> {
  const messageIds = job.alertPinMessageIds ?? [];
  if (messageIds.length === 0) return;
  try {
    const stillPinnedIds = await deps.unpinMessages(job.threadKey, messageIds);
    const releasedIds = messageIds.filter((messageId) => !stillPinnedIds.includes(messageId));
    if (releasedIds.length > 0) await deps.clearAlertPins(job.id, releasedIds);
  } catch (error) {
    console.warn(`[scheduler] releasing the old alert pins of job ${job.id} failed:`, error instanceof Error ? error.message : error);
  }
}

/**
 * @description A tracker conversation's post of one fire: the prompt behind its header, and the forward that watches the
 * turn as the picked request's. The target is picked each time the text is built — at forward time the post may have
 * waited behind a running turn, so the request the job was armed under may have closed or been replaced — and the forward
 * carries whatever the LAST build picked. `heldText` is the same text for a run held over a usage-limit wait.
 */
function createTrackerPost(
  deps: ScheduleDeliveryDeps,
  ports: TrackerRunPorts,
  job: ScheduleRecord,
  conversationLabel: string,
  prompt: string,
  heldPrompt: string | undefined,
): { postDeps: PostToSessionDeps; promptText: SessionPromptText; heldText: string | undefined } {
  let target: TrackerRunTarget = { kind: 'none' };
  const buildText = (body: string): string => {
    target = pickTrackerRunTarget(job, ports.listOpenRequests(job.threadKey));
    return `${buildTrackerScheduledRunHeader({ jobName: job.name, conversationLabel, target })}${body}`;
  };
  const promptText: SessionPromptText = { fullText: buildText(prompt), buildText: () => buildText(prompt) };
  const heldText = heldPrompt === undefined ? undefined : buildText(heldPrompt);
  const postDeps: PostToSessionDeps = {
    ...deps,
    forwardPrompt: (conversationKey, text) => ports.forwardRun(conversationKey, text, target.kind === 'request' ? getRiddenRequest(job, target.request) : null),
  };
  return { postDeps, promptText, heldText };
}

/**
 * One topic fire's forward at a time per conversation: the pick and the forward run together, so two fires at the same moment (two
 * hourly jobs at :00) cannot both find nothing to ride and both open the scheduler's request — the second would replace the first, and
 * an answer to the first would be lost. Module-wide: the serialisation is per conversation, whichever delivery instance forwards.
 */
const topicRunForwardQueue = new KeyedTransitionQueue();

/**
 * @description A topic's post of one fire (`TopicRunPorts`): picked each time the text is built, as a tracker's — the request it rides
 * gets its header in front of the prompt and the forward watches the turn as that request's scheduled run; with none to ride the
 * forward opens the scheduler's request (its header is that request's, added by the forward); a view without requests forwards the
 * prompt as it is. The forward picks once more inside {@link topicRunForwardQueue}, so it rides what another fire opened a moment
 * before. A held run keeps the text of its build, like a tracker's.
 */
function createTopicPost(
  deps: ScheduleDeliveryDeps,
  ports: TopicRunPorts,
  job: ScheduleRecord,
  prompt: string,
  heldPrompt: string | undefined,
): { postDeps: PostToSessionDeps; promptText: SessionPromptText; heldText: string | undefined } {
  let target: TopicRunTarget | null = null;
  const buildText = (body: string): string => {
    const view = ports.getRequestView(job.threadKey);
    target = view === null ? null : pickTopicRunTarget(job, ports.listOpenRequests(job.threadKey));
    if (target?.kind !== 'request' || view === null) return body;
    return `${buildTopicScheduledRunHeader({ jobName: job.name, request: target.request, isPlainTextHidden: view.isPlainTextHidden })}${body}`;
  };
  const promptText: SessionPromptText = { fullText: buildText(prompt), buildText: () => buildText(prompt) };
  const heldText = heldPrompt === undefined ? undefined : buildText(heldPrompt);
  const forwardPrompt = (conversationKey: string): Promise<void> => topicRunForwardQueue.run(conversationKey, () => {
    const text = buildText(prompt);
    const picked: TopicRunTarget | null = target;
    if (picked === null) return deps.forwardPrompt(conversationKey, text);
    return picked.kind === 'request' ? ports.forwardRun(conversationKey, text, getRiddenRequest(job, picked.request)) : ports.forwardOwnRequestRun(conversationKey, text);
  });
  return { postDeps: { ...deps, forwardPrompt }, promptText, heldText };
}

/**
 * @description Steps 3–4: post `prompt` (already carrying its marker) into the
 * thread's session through {@link postToSession} and map its outcome onto the
 * engine's delivery outcome. In a tracker conversation (`trackerLabel` is its label) the prompt goes behind the tracker
 * header and the forward watches the request's turn ({@link createTrackerPost}); in a topic with the topic ports it meets the
 * topic's requests the same way ({@link createTopicPost}).
 */
async function deliverToAgent(
  deps: ScheduleDeliveryDeps,
  job: ScheduleRecord,
  prompt: string,
  options: { heldText?: string; trackerLabel?: string | null } = {},
): Promise<DeliveryOutcome> {
  return getDeliveryOutcome(job, await postRunToAgent(deps, job, prompt, options));
}

/** Steps 3–4 of {@link deliverToAgent}: ensure a session, let a busy one finish its turn, forward the prefixed prompt. */
function postRunToAgent(
  deps: ScheduleDeliveryDeps,
  job: ScheduleRecord,
  prompt: string,
  options: { heldText?: string; trackerLabel?: string | null },
): ReturnType<typeof postToSession> {
  const ports = deps.trackerRun;
  return ports !== undefined && options.trackerLabel !== undefined && options.trackerLabel !== null
    ? postTrackerRun(deps, ports, job, options.trackerLabel, prompt, options.heldText)
    : postTopicRun(deps, job, prompt, options.heldText);
}

/** The engine's delivery outcome of a run's post ({@link postRunToAgent}). */
function getDeliveryOutcome(job: ScheduleRecord, posted: Awaited<ReturnType<typeof postToSession>>): DeliveryOutcome {
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

/** A tracker conversation's post: a session that cannot be resumed starts on the connector's own backend, not the job's snapshot. */
function postTrackerRun(
  deps: ScheduleDeliveryDeps,
  ports: TrackerRunPorts,
  job: ScheduleRecord,
  conversationLabel: string,
  prompt: string,
  heldPrompt: string | undefined,
): ReturnType<typeof postToSession> {
  const { postDeps, promptText, heldText } = createTrackerPost(deps, ports, job, conversationLabel, prompt, heldPrompt);
  return postToSession(postDeps, job.threadKey, promptText, ports.fallbackAdapterName, { heldText });
}

/** A topic's post: through its request ports when it has them ({@link createTopicPost}), else the shared forward as it is. */
function postTopicRun(deps: ScheduleDeliveryDeps, job: ScheduleRecord, prompt: string, heldPrompt: string | undefined): ReturnType<typeof postToSession> {
  if (deps.topicRun === undefined) return postToSession(deps, job.threadKey, prompt, job.lastAdapterName, { heldText: heldPrompt });
  const { postDeps, promptText, heldText } = createTopicPost(deps, deps.topicRun, job, prompt, heldPrompt);
  return postToSession(postDeps, job.threadKey, promptText, job.lastAdapterName, { heldText });
}

/**
 * @description Take a job's status line out of the topic and out of its record — the ONE place that does it, for a failed or
 * unbound run, a topic that stopped showing the stream, a final run, and the `/unbind` pause (`unbindPause.ts`). The record is
 * cleared first: a crash between the two leaves an orphan line in the topic, never a record that points at a message that was
 * already deleted. Never rejects — the alert of a failed check runs right after it, and a status line must not be able to stop
 * that (nor an unbind be stopped by it).
 */
export async function clearCheckStatusLine(
  deps: Pick<ScheduleDeliveryDeps, 'recordStatusLine' | 'deleteMessage'>,
  job: Pick<ScheduleRecord, 'id' | 'threadKey' | 'statusMessageId'>,
): Promise<void> {
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
    // The job's last run: its line would be deleted at once by the finished check, so none is posted and the existing one goes.
    if (!deps.checkIsStatusShown(job.threadKey) || checkIsFinalRun(job.spec)) {
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
 * "back to normal" line, or raise the alert and wake the agent. The failing flag is
 * stored BEFORE the agent is woken, so a restart mid-delivery cannot raise the
 * same alert twice — and cleared again when the wake's post failed at its forward
 * (a startup window dropped it, its write failed), so the next failing run wakes
 * the agent, whom nothing else would tell.
 */
async function deliverCheck(deps: ScheduleDeliveryDeps, job: ScheduleRecord, trackerLabel: string | null): Promise<DeliveryOutcome> {
  const timeoutSec = job.checkTimeoutSec ?? defaultCheckTimeoutSec;
  const command = job.checkCommand ?? '';
  await releaseLegacyAlertPins(deps, job);
  const result = await deps.runCheck(job.threadKey, command, timeoutSec * 1000);
  if (!result) {
    // A binding that went without `/unbind` (the unbind itself clears the line when it parks the job — `unbindPause.ts`): the
    // job is parked right after this and never runs again, so its last «works …» line would stay frozen under it.
    await clearCheckStatusLine(deps, job);
    return { status: 'failed', error: unboundDeliveryError };
  }

  const isPassing = checkIsCheckPassing(result);
  const decision = getCheckAlertDecision({ isPassing, wasFailing: job.isCheckFailing === true });
  if (decision === 'quiet') {
    // `quiet` is also a failure that keeps failing: its line went with the alert, and a failing check posts none.
    // A tracker conversation has no status line at all: its status arguments are accepted and do nothing.
    if (isPassing && trackerLabel === null) await updateCheckStatus(deps, job);
    return { status: 'delivered' };
  }
  if (decision === 'recovered') {
    await deps.setCheckFailing(job.id, false);
    // A tracker conversation has no feed: the check passing again is no comment on the issue.
    if (trackerLabel === null) {
      await deps.announce(job.threadKey, buildCheckRecoveredText(job), { isSilent: true });
      await updateCheckStatus(deps, job);
    }
    return { status: 'delivered' };
  }

  // The failure is the worker's end (or hang): its status line would now be a lie under the alert.
  await clearCheckStatusLine(deps, job);
  await deps.setCheckFailing(job.id, true);
  const failure = describeCheckFailure(result, timeoutSec);
  if (trackerLabel === null) {
    const alert = buildCheckFailedAnnouncement({ job, result, failure, nowMs: deps.now() });
    await deps.announce(job.threadKey, alert.text, { isSilent: true, foldedDetail: alert.foldedDetail });
  }
  const posted = await postRunToAgent(
    deps,
    job,
    buildCheckFailurePrompt({ name: job.name, command, failure, output: result.output, prompt: job.prompt, isTracker: trackerLabel !== null }),
    { trackerLabel },
  );
  // The wake reached a session but not the agent — a startup window dropped it, its write failed: nothing else tells the agent, and the
  // flag would keep every later failing run quiet. Cleared, the next failing run alerts and wakes it again. A session that could not be
  // started (or no agent, no folder) keeps the flag: its alert stands, and the next runs would only repeat it.
  if (!posted.ok && posted.reason === 'forward-failed') await deps.setCheckFailing(job.id, false);
  return getDeliveryOutcome(job, posted);
}

/**
 * @description Build the engine's `deliver(job, fireContext)` callback bound to
 * the injected deps. See the module header for the locked flow.
 */
export function createScheduleDelivery(
  deps: ScheduleDeliveryDeps,
): (job: ScheduleRecord, fireContext: FireContext) => Promise<DeliveryOutcome> {
  return async (job, fireContext) => {
    // Read once per fire: a tracker conversation posts nothing, whatever the kind of the job.
    const trackerLabel = deps.trackerRun?.describeConversation(job.threadKey) ?? null;
    if (checkIsCheckSchedule(job)) return deliverCheck(deps, job, trackerLabel);
    // Read before the paced announce, which can take a while under load:
    // a run held over a usage-limit wait says when it was due (R27).
    const dueAtMs = fireContext.kind === 'catch-up' && fireContext.missedAtMs !== undefined ? fireContext.missedAtMs : deps.now();

    // 1. announce
    const announcement = buildFireAnnouncement(job, fireContext, deps.now());

    // A reminder is done after its announcement and its pin, with no agent involved at
    // all. Returning before `ensureSession` is also what lets it fire in an
    // unbound topic and in General — there is no session to fail to ensure.
    if (checkIsReminderSchedule(job)) {
      await announceAndPinReminder(deps, job, announcement.text);
      return { status: 'delivered' };
    }
    if (trackerLabel === null) await deps.announce(job.threadKey, announcement.text, { isSilent: true, foldedDetail: announcement.foldedDetail });

    // 3–4. wake the agent with the prompt. A run held over a usage-limit wait
    // reaches the agent later: it says when it was due (R27).
    return deliverToAgent(deps, job, prependScheduledRunMarker(job.name, job.prompt), {
      heldText: prependScheduledRunMarker(job.name, job.prompt, { dueAtMs }),
      trackerLabel,
    });
  };
}
