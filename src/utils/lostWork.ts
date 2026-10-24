/**
 * @description The agent's own pending work that a json-stream process took with it when it ended anyway: a crash,
 * a process found gone after a restart, a `/model` / `/effort` / account re-spawn, or the pending-work hold running
 * out (`utils/jsonStreamPendingWork.ts`). Nothing else would ever tell the agent — a background task's result, its
 * `CronCreate` jobs and a finished task it had not read yet are gone with the process, so the agent would keep waiting
 * for a notification that never comes. The bot tells it once, in a short prompt, and the topic gets one plain line.
 *
 * A turn the bot itself cut off (a re-spawn, a backend switch) is lost work too: nothing else re-prompts it. A turn a
 * crash cut off is the request core's: it re-posts and wakes an open request (R21). An explicit release (`/quit`,
 * `/new`) drops the record — the person ended that conversation.
 */

import type { ClaudeBackgroundTask } from './claudeStreamJson';
import type { JsonStreamTailOffset } from '../types';
import type { Translate } from '../i18n';

/** @name LostWork @description What a process held when it ended: none of it survives the process. */
export interface LostWork {
  backgroundTasks: ClaudeBackgroundTask[];
  /** Session-only `CronCreate` jobs (one-shot jobs that already fired may still be counted). */
  scheduledJobCount: number;
  /** A background task had finished and its own turn — the agent reading the result — had not run yet. */
  hasUnreadTaskResult: boolean;
  /** The bot cut off the turn the agent was in the middle of (a re-spawn, a backend switch). */
  wasTurnInFlight: boolean;
}

/**
 * @name LostWorkReason
 * @description Why the process ended with work pending:
 *  - `exited` — the CLI exited by itself (a crash, an OOM kill);
 *  - `foundDead` — the process was gone when the bot came back (a host reboot, a killed tmux server);
 *  - `restarted` — the bot re-spawned it for a model, effort or account change;
 *  - `holdExpired` — the idle stop after the pending-work hold ran out (no turn for that long);
 *  - `switched` — the conversation moved to another backend (a usage-limit fallback, the operator's switch).
 */
export type LostWorkReason = 'exited' | 'foundDead' | 'restarted' | 'holdExpired' | 'switched';

/** @name LostWorkRecord @description A loss the agent has not been told about yet (persisted in `state.json`). */
export interface LostWorkRecord extends LostWork {
  reason: LostWorkReason;
  lostAt: number;
  /**
   * The part of this loss the agent of the backend the conversation moved to was told about first (a backend switch
   * tells both agents): the parked conversation's agent checks that part before it starts anything again. Only that
   * part — a loss merged in later (the cut-off work of the side being left) is this agent's alone.
   */
  otherAgentTold?: LostWork;
}

/**
 * Within this long after an automatic resume, a second loss does not resume the conversation again: a process that
 * keeps dying with work pending must not be restarted in a loop. The note then waits for the next message.
 */
export const lostWorkResumeCooldownMs = 10 * 60 * 1000;

/** @description Whether any work was lost. */
export function checkHasLostWork(lostWork: LostWork): boolean {
  return lostWork.backgroundTasks.length > 0 || lostWork.scheduledJobCount > 0 || lostWork.hasUnreadTaskResult || lostWork.wasTurnInFlight;
}

const noLostWork: LostWork = { backgroundTasks: [], scheduledJobCount: 0, hasUnreadTaskResult: false, wasTurnInFlight: false };

/**
 * @description What a process that is GONE held, by its persisted tail record — read for a process found dead at
 * boot. A process that ended while the bot watched left no pending work in its record ({@link getTailRecordWithoutPendingWork}).
 * A record of another conversation holds nothing of this one, and neither does a record written before the pending work
 * was tracked (its bare `backgroundTaskIds` were never cleared after a crash: they may be weeks old) — only a record that
 * carries the hold's start or an announced turn speaks for a process that was alive with work pending.
 */
export function getLostWorkFromTailRecord(tail: JsonStreamTailOffset | null, claudeSessionId: string): LostWork {
  if (tail === null || tail.sessionId !== claudeSessionId) return noLostWork;
  if (tail.lastTurnEndedAtMs === undefined && tail.notificationTurnPendingSinceMs === undefined) return noLostWork;
  return {
    backgroundTasks: tail.backgroundTasks ?? [],
    scheduledJobCount: tail.scheduledJobs?.length ?? 0,
    // The bot was away: an announced turn that the record still holds never reached it.
    hasUnreadTaskResult: tail.notificationTurnPendingSinceMs !== undefined,
    // A turn in flight at a crash is the request core's (see the module).
    wasTurnInFlight: false,
  };
}

/** @description The tail record of a process whose pending work was handled (told, or released): the rest as it was. */
export function getTailRecordWithoutPendingWork(tail: JsonStreamTailOffset): JsonStreamTailOffset {
  const { backgroundTasks: _backgroundTasks, scheduledJobs: _scheduledJobs, notificationTurnPendingSinceMs: _notificationTurnPendingSinceMs, lastTurnEndedAtMs: _lastTurnEndedAtMs, ...rest } = tail;
  return { ...rest, backgroundTaskIds: [] };
}

/**
 * @name LostWorkPlan
 * @description `isAutoResume`: the bot resumes the conversation now with the note as its prompt. Otherwise the note
 * rides the next prompt, and `isResumedByNextMessage` says whether that is the person's next message waking a stopped
 * process (`false`: the process is alive, or an armed limit wait resumes it — the note rides that prompt).
 */
export interface LostWorkPlan {
  isAutoResume: boolean;
  isResumedByNextMessage: boolean;
}

/**
 * @description What the bot does about a loss. A spent hold means nobody heard from the work for hours: the agent is
 * told on the next message, not woken (it would only re-arm the same forgotten task). An armed usage-limit wait has
 * its own resume, whose nudge carries the note. A loss right after an automatic resume waits for a person. A
 * conversation that answers only through a request (a tracker issue, `isRequestRequired`) is not resumed by a bare
 * note it could not answer: the note rides its next request's prompt.
 */
export function getLostWorkPlan(input: {
  reason: LostWorkReason;
  isLimitWaitArmed: boolean;
  msSinceLastAutoResume: number | null;
  isRequestRequired: boolean;
}): LostWorkPlan {
  const isInCooldown = input.msSinceLastAutoResume !== null && input.msSinceLastAutoResume < lostWorkResumeCooldownMs;
  const isAutoResume = input.reason !== 'holdExpired' && input.reason !== 'switched' && !input.isLimitWaitArmed && !isInCooldown && !input.isRequestRequired;
  return isAutoResume ? { isAutoResume: true, isResumedByNextMessage: false } : getHeldLostWorkPlan(input);
}

/**
 * @description The plan of a loss whose note waits for the next prompt — no automatic resume, or one that failed: the
 * person's next message resumes a STOPPED process; a live one (a re-spawn, a switch) or an armed limit wait's own
 * resume hears it with the next prompt it gets.
 */
export function getHeldLostWorkPlan(input: { reason: LostWorkReason; isLimitWaitArmed: boolean }): LostWorkPlan {
  const isProcessAlive = input.reason === 'restarted' || input.reason === 'switched';
  return { isAutoResume: false, isResumedByNextMessage: !isProcessAlive && !input.isLimitWaitArmed };
}

/** The agent-facing wording of each reason (English on purpose, like every agent-facing template). */
const lostWorkReasonTexts: Record<LostWorkReason, string> = {
  exited: 'it exited unexpectedly',
  foundDead: 'it was gone when the bot came back after a restart',
  restarted: 'the bot restarted it for a model, effort or account change',
  holdExpired: 'the bot stopped it after a long time without a turn',
  switched: 'the conversation moved to another backend',
};

/** @description What was lost, as the agent reads it: the tasks by id and description, the jobs, the unread result. */
function describeLostWorkForAgent(lostWork: LostWork): string {
  const parts: string[] = [];
  if (lostWork.backgroundTasks.length > 0) {
    const tasks = lostWork.backgroundTasks.map((task) => (task.description ? `${task.taskId} «${task.description}»` : task.taskId));
    parts.push(`background tasks ${tasks.join(', ')}`);
  }
  if (lostWork.scheduledJobCount > 0) parts.push(`${lostWork.scheduledJobCount} session-only CronCreate job(s)`);
  if (lostWork.hasUnreadTaskResult) parts.push('the result of a background task that had just finished, which you had not read');
  if (lostWork.wasTurnInFlight) parts.push('the turn you were in the middle of, which was cut off');
  return parts.join('; ');
}

/**
 * @description The note the agent gets — as the automatic resume's prompt, or ahead of the next prompt. English with
 * the baked reply-language directive (`replyLanguage` is the topic's language endonym).
 */
export function buildLostWorkNote(record: LostWorkRecord, replyLanguage: string): string {
  return [
    `[charness] This conversation's agent process ended while its own work was still pending (${lostWorkReasonTexts[record.reason]}): ${describeLostWorkForAgent(record)}.`,
    'That work died with the process: no notification will ever arrive for it.',
    ...(record.otherAgentTold && checkHasLostWork(record.otherAgentTold)
      ? [`The agent this conversation moved to meanwhile was told first about ${describeLostWorkForAgent(record.otherAgentTold)}, and may have started some of it again: look before you start that twice.`]
      : []),
    `Check its state yourself (output files, processes, the repository), start again what is still needed — prefer the bot's schedule_* tools for anything that must survive a restart — and tell the user in one or two lines what happened, IN ${replyLanguage}.`,
  ].join('\n');
}

/**
 * @description One loss from two: a loss the agent was not told about yet stays, and a newer one adds to it — the
 * tasks by id, the larger job count, the reason and time of the newer loss. The parts another agent was told first
 * merge only with each other, never with the rest.
 */
export function mergeLostWorkRecords(untold: LostWorkRecord | undefined, newer: LostWorkRecord): LostWorkRecord {
  if (!untold) return newer;
  const otherAgentTold = untold.otherAgentTold && newer.otherAgentTold
    ? mergeLostWork(untold.otherAgentTold, newer.otherAgentTold)
    : untold.otherAgentTold ?? newer.otherAgentTold;
  return {
    ...mergeLostWork(untold, newer),
    reason: newer.reason,
    lostAt: newer.lostAt,
    ...(otherAgentTold ? { otherAgentTold } : {}),
  };
}

/** Two losses as one: the tasks by id, the larger job count, either flag. */
function mergeLostWork(older: LostWork, newer: LostWork): LostWork {
  const tasksById = new Map(older.backgroundTasks.map((task) => [task.taskId, task]));
  for (const task of newer.backgroundTasks) tasksById.set(task.taskId, task);
  return {
    backgroundTasks: [...tasksById.values()],
    scheduledJobCount: Math.max(older.scheduledJobCount, newer.scheduledJobCount),
    hasUnreadTaskResult: older.hasUnreadTaskResult || newer.hasUnreadTaskResult,
    wasTurnInFlight: older.wasTurnInFlight || newer.wasTurnInFlight,
  };
}

/** How a background task is named in the topic line: its description, else its id. */
function getTopicTaskName(task: ClaudeBackgroundTask): string {
  return task.description ? `«${task.description}»` : task.taskId;
}

/** The topic line's ending: resumed now, resumed by the person's next message, or told with the next prompt it gets. */
function getTopicLineKey(plan: LostWorkPlan): string {
  if (plan.isAutoResume) return 'lostWork.line.resumed';
  return plan.isResumedByNextMessage ? 'lostWork.line.held' : 'lostWork.line.toldNext';
}

/**
 * @description The ONE plain line a topic gets about a loss (never pinned: no action is needed from the person) —
 * what ended, what was pending, and when the agent hears about it. `holdHours` names the pending-work hold for a
 * `holdExpired` loss.
 */
export function formatLostWorkTopicLine(record: LostWorkRecord, plan: LostWorkPlan, holdHours: number, translate: Translate): string {
  const parts: string[] = [];
  if (record.backgroundTasks.length > 0) parts.push(translate('lostWork.work.tasks', { list: record.backgroundTasks.map(getTopicTaskName).join(', ') }));
  if (record.scheduledJobCount > 0) parts.push(translate('lostWork.work.jobs', { count: record.scheduledJobCount }));
  if (record.hasUnreadTaskResult) parts.push(translate('lostWork.work.unreadResult'));
  if (record.wasTurnInFlight) parts.push(translate('lostWork.work.turn'));
  const reason = translate(`lostWork.reason.${record.reason}`, { hours: holdHours });
  return translate(getTopicLineKey(plan), { reason, work: parts.join('; ') });
}
