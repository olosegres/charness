/**
 * @description The agent's own pending work that a json-stream process took with it when it ended anyway: a crash,
 * a process found gone after a restart, a `/model` / `/effort` / account re-spawn, or the pending-work hold running
 * out (`utils/jsonStreamPendingWork.ts`). Nothing else would ever tell the agent — a background task's result, its
 * `CronCreate` jobs and a finished task it had not read yet are gone with the process, so the agent would keep waiting
 * for a notification that never comes. The bot tells it once, in a short prompt, and the topic gets one plain line.
 *
 * An interrupted TURN is not lost work here: the request core already re-posts and wakes an open request. An explicit
 * release (`/quit`, `/new`, a backend switch) drops the record — the person ended that conversation.
 */

import type { ClaudeBackgroundTask } from './claudeStreamJson';
import type { JsonStreamTailOffset } from '../types';
import { resolveAdoptedTail } from './jsonStreamHost';

/** @name LostWork @description What a process held when it ended: none of it survives the process. */
export interface LostWork {
  backgroundTasks: ClaudeBackgroundTask[];
  /** Session-only `CronCreate` jobs (one-shot jobs that already fired may still be counted). */
  scheduledJobCount: number;
  /** A background task had finished and its own turn — the agent reading the result — had not run yet. */
  hasUnreadTaskResult: boolean;
}

/**
 * @name LostWorkReason
 * @description Why the process ended with work pending:
 *  - `exited` — the CLI exited by itself (a crash, an OOM kill);
 *  - `foundDead` — the process was gone when the bot came back (a host reboot, a killed tmux server);
 *  - `restarted` — the bot re-spawned it for a model, effort or account change;
 *  - `holdExpired` — the idle stop after the pending-work hold ran out (no turn for that long).
 */
export type LostWorkReason = 'exited' | 'foundDead' | 'restarted' | 'holdExpired';

/** @name LostWorkRecord @description A loss the agent has not been told about yet (persisted in `state.json`). */
export interface LostWorkRecord extends LostWork {
  reason: LostWorkReason;
  lostAt: number;
}

/**
 * Within this long after an automatic resume, a second loss does not resume the conversation again: a process that
 * keeps dying with work pending must not be restarted in a loop. The note then waits for the next message.
 */
export const lostWorkResumeCooldownMs = 10 * 60 * 1000;

/** @description Whether any work was lost. */
export function checkHasLostWork(lostWork: LostWork): boolean {
  return lostWork.backgroundTasks.length > 0 || lostWork.scheduledJobCount > 0 || lostWork.hasUnreadTaskResult;
}

/**
 * @description What a process that is GONE held, by its persisted tail record — read for a process found dead at
 * boot. A process that ended while the bot watched left no pending work in its record ({@link getTailRecordWithoutPendingWork}).
 * A record of another conversation holds nothing of this one.
 */
export function getLostWorkFromTailRecord(tail: JsonStreamTailOffset | null, claudeSessionId: string): LostWork {
  const resolved = resolveAdoptedTail(tail, claudeSessionId, 0);
  return {
    backgroundTasks: resolved.backgroundTasks,
    scheduledJobCount: resolved.scheduledJobs.length,
    // The bot was away: an announced turn that the record still holds never reached it.
    hasUnreadTaskResult: resolved.notificationTurnPendingSinceMs !== null,
  };
}

/** @description The tail record of a process whose pending work was handled (told, or released): the rest as it was. */
export function getTailRecordWithoutPendingWork(tail: JsonStreamTailOffset): JsonStreamTailOffset {
  const { backgroundTasks: _backgroundTasks, scheduledJobs: _scheduledJobs, notificationTurnPendingSinceMs: _notificationTurnPendingSinceMs, lastTurnEndedAtMs: _lastTurnEndedAtMs, ...rest } = tail;
  return { ...rest, backgroundTaskIds: [] };
}

/** @name LostWorkPlan @description `isAutoResume`: the bot resumes the conversation now with the note as its prompt; otherwise the note rides the next prompt. */
export interface LostWorkPlan {
  isAutoResume: boolean;
}

/**
 * @description What the bot does about a loss. A spent hold means nobody heard from the work for hours: the agent is
 * told on the next message, not woken (it would only re-arm the same forgotten task). An armed usage-limit wait has
 * its own resume, whose nudge carries the note. A loss right after an automatic resume waits for a person.
 */
export function getLostWorkPlan(input: { reason: LostWorkReason; isLimitWaitArmed: boolean; msSinceLastAutoResume: number | null }): LostWorkPlan {
  if (input.reason === 'holdExpired' || input.isLimitWaitArmed) return { isAutoResume: false };
  const isInCooldown = input.msSinceLastAutoResume !== null && input.msSinceLastAutoResume < lostWorkResumeCooldownMs;
  return { isAutoResume: !isInCooldown };
}

/** The agent-facing wording of each reason (English on purpose, like every agent-facing template). */
const lostWorkReasonTexts: Record<LostWorkReason, string> = {
  exited: 'it exited unexpectedly',
  foundDead: 'it was gone when the bot came back after a restart',
  restarted: 'the bot restarted it for a model, effort or account change',
  holdExpired: 'the bot stopped it after a long time without a turn',
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
  return parts.join('; ');
}

/**
 * @description The note the agent gets — as the automatic resume's prompt, or ahead of the next prompt. English with
 * the baked reply-language directive (`replyLanguage` is the topic's language endonym).
 */
export function buildLostWorkNote(record: LostWorkRecord, replyLanguage: string): string {
  return [
    `[charness] Your Claude Code process ended while your own work was still pending (${lostWorkReasonTexts[record.reason]}): ${describeLostWorkForAgent(record)}.`,
    'That work died with the process: no notification will ever arrive for it.',
    `Check its state yourself (output files, processes, the repository), start again what is still needed — prefer the bot's schedule_* tools for anything that must survive a restart — and tell the user in one or two lines what happened, IN ${replyLanguage}.`,
  ].join('\n');
}

/**
 * @description One loss from two: a loss the agent was not told about yet stays, and a newer one adds to it — the
 * tasks by id, the larger job count, the reason and time of the newer loss.
 */
export function mergeLostWorkRecords(untold: LostWorkRecord | undefined, newer: LostWorkRecord): LostWorkRecord {
  if (!untold) return newer;
  const tasksById = new Map(untold.backgroundTasks.map((task) => [task.taskId, task]));
  for (const task of newer.backgroundTasks) tasksById.set(task.taskId, task);
  return {
    backgroundTasks: [...tasksById.values()],
    scheduledJobCount: Math.max(untold.scheduledJobCount, newer.scheduledJobCount),
    hasUnreadTaskResult: untold.hasUnreadTaskResult || newer.hasUnreadTaskResult,
    reason: newer.reason,
    lostAt: newer.lostAt,
  };
}

/** @name LostWorkTranslate @description The i18n lookup the topic line is worded with (`t`). */
export type LostWorkTranslate = (code: string, vars?: Record<string, string | number>) => string;

/** How a background task is named in the topic line: its description, else its id. */
function getTopicTaskName(task: ClaudeBackgroundTask): string {
  return task.description ? `«${task.description}»` : task.taskId;
}

/**
 * @description The ONE plain line a topic gets about a loss (never pinned: no action is needed from the person) —
 * what ended, what was pending, and whether the bot resumed the agent now or the next message will. `holdHours` names
 * the pending-work hold for a `holdExpired` loss.
 */
export function formatLostWorkTopicLine(record: LostWorkRecord, plan: LostWorkPlan, holdHours: number, translate: LostWorkTranslate): string {
  const parts: string[] = [];
  if (record.backgroundTasks.length > 0) parts.push(translate('lostWork.work.tasks', { list: record.backgroundTasks.map(getTopicTaskName).join(', ') }));
  if (record.scheduledJobCount > 0) parts.push(translate('lostWork.work.jobs', { count: record.scheduledJobCount }));
  if (record.hasUnreadTaskResult) parts.push(translate('lostWork.work.unreadResult'));
  const reason = translate(`lostWork.reason.${record.reason}`, { hours: holdHours });
  return translate(plan.isAutoResume ? 'lostWork.line.resumed' : 'lostWork.line.held', { reason, work: parts.join('; ') });
}
