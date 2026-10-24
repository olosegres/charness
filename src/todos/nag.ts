/**
 * @description The staleness reminder of the todo registry (D10–D14), as pure decisions — modelled on
 * `getIdleFireDecision`: every "no" names its reasons, so a log line says why nothing fired.
 *
 *   stale = the agent WORKED (its session reported busy) for ≥ the interval since its last `todo_update`; the clock
 *           starts at the first turn end after that update, so a topic quiet for days is not reminded on its first turn
 *   form a — a reminder line on the next prompt the conversation gets, from any source (no extra turn)
 *   form b — a standalone technical prompt at a turn end, only when nothing else would reach the agent and every gate
 *            of D12 holds (live, idle, nothing holding the turn, nothing unread, no open request, no answer tail, not
 *            limited, not billed to API credits)
 *   after 2 reminders in a row with no update the bot stays silent until the agent updates or a person writes
 */

/** The reminder interval nobody chose (D10). */
export const todoReminderDefaultMinutes = 60;
/** The intervals General offers; `0` is "off". */
export const todoReminderOffMinutes = 0;
export const todoReminderMinuteOptions: readonly number[] = [todoReminderOffMinutes, 30, 60, 120, 240];
/** After this many reminders in a row with no update the bot stays silent (D13). */
export const todoReminderMaxIgnored = 2;
const msPerMinute = 60 * 1000;

/**
 * @name TodoNagState
 * @description The reminder's bookkeeping of a conversation, persisted with its list. `clockStartedAt` = the first
 * turn end after the last update (absent until then); `workedMs` = the busy time since; `ignoredCount` = reminders
 * delivered in a row with no update.
 */
export interface TodoNagState {
  clockStartedAt?: number;
  workedMs: number;
  ignoredCount: number;
  lastRemindedAt?: number;
}

/** @name TodoReminderSettings @description The instance's settings, defaults filled in (`settings.json` `todo`). */
export interface TodoReminderSettings {
  isEnabled: boolean;
  /** `0` = the reminder is off. */
  reminderMinutes: number;
}

/**
 * @name TodoStandaloneGate
 * @description What a standalone reminder (form b) needs to hold at a turn end (D12). The first four are the
 * wake-up engine's turn probe.
 */
export interface TodoStandaloneGate {
  isActive: boolean;
  isBusy: boolean;
  isTurnEndBlocked: boolean;
  hasUnconsumedInput: boolean | null;
  hasOpenRequest: boolean;
  /** The agent's text after a final answer is being followed (`requests/answerTail.ts`). */
  isAnswerTailFollowed: boolean;
  /** The account or model the conversation runs on is marked limited. */
  isLimited: boolean;
  /** The conversation runs on an account billed to API credits: never spend money unasked. */
  isApiBilled: boolean;
}

/** @description What the reminder decided: the text to deliver, or why not. */
export type TodoReminderDecision = { shouldRemind: true } | { shouldRemind: false; skipReasons: string[] };

/** @description The bookkeeping right after an update: nothing worked, nobody reminded, the clock not started. */
export function createTodoNagState(): TodoNagState {
  return { workedMs: 0, ignoredCount: 0 };
}

/** @description `nag` with `elapsedMs` of busy time added — counted only once the clock started. */
export function getTodoNagStateWithWork(nag: TodoNagState, elapsedMs: number): TodoNagState {
  if (nag.clockStartedAt === undefined || elapsedMs <= 0) return nag;
  return { ...nag, workedMs: nag.workedMs + elapsedMs };
}

/** @description `nag` at a turn end: the clock starts at the first one after the update. */
export function getTodoNagStateAtTurnEnd(nag: TodoNagState, nowMs: number): TodoNagState {
  return nag.clockStartedAt === undefined ? { ...nag, clockStartedAt: nowMs } : nag;
}

/** @description `nag` after a reminder reached the agent: the work counts afresh, one more ignored until it updates. */
export function getTodoNagStateAfterReminder(nag: TodoNagState, nowMs: number): TodoNagState {
  return { ...nag, workedMs: 0, ignoredCount: nag.ignoredCount + 1, lastRemindedAt: nowMs };
}

/** @description `nag` after a person wrote in the conversation: the silence after ignored reminders ends (D13). */
export function getTodoNagStateAfterPersonActivity(nag: TodoNagState): TodoNagState {
  return nag.ignoredCount === 0 ? nag : { ...nag, ignoredCount: 0 };
}

/** @description The interval in ms, or `null` when the reminder is off. `overrideMs` is the test-only timing seam. */
export function getTodoReminderIntervalMs(settings: TodoReminderSettings, overrideMs: number | undefined): number | null {
  if (!settings.isEnabled || settings.reminderMinutes === todoReminderOffMinutes) return null;
  return overrideMs ?? settings.reminderMinutes * msPerMinute;
}

/** @description Whether the agent worked the whole interval since its last update (the reminder is due, gates aside). */
export function checkIsTodoNagStale(nag: TodoNagState, intervalMs: number | null): boolean {
  return intervalMs !== null && nag.clockStartedAt !== undefined && nag.workedMs >= intervalMs;
}

/** @description The reasons a list is not due for a reminder in either form (empty = due). */
function getStaleSkipReasons(nag: TodoNagState, intervalMs: number | null): string[] {
  return [
    intervalMs === null && 'the reminder is off',
    nag.clockStartedAt === undefined && 'no turn ended since the last update',
    intervalMs !== null && nag.workedMs < intervalMs && `worked ${Math.round(nag.workedMs / 1000)} s of ${Math.round(intervalMs / 1000)} s`,
    nag.ignoredCount >= todoReminderMaxIgnored && `silent after ${todoReminderMaxIgnored} ignored reminders`,
  ].filter((reason): reason is string => typeof reason === 'string');
}

/** @description Form a: whether the next prompt carries the reminder line. */
export function decidePromptTodoReminder(nag: TodoNagState, intervalMs: number | null): TodoReminderDecision {
  const skipReasons = getStaleSkipReasons(nag, intervalMs);
  return skipReasons.length === 0 ? { shouldRemind: true } : { shouldRemind: false, skipReasons };
}

/** @description Form b: whether a standalone reminder goes out at this turn end (D12). */
export function decideStandaloneTodoReminder(nag: TodoNagState, intervalMs: number | null, gate: TodoStandaloneGate): TodoReminderDecision {
  const skipReasons = [
    ...getStaleSkipReasons(nag, intervalMs),
    !gate.isActive && 'no live session (never woken for it)',
    gate.isBusy && 'busy',
    gate.isTurnEndBlocked && 'something holds the turn open',
    gate.hasUnconsumedInput === true && 'input not taken in yet',
    gate.hasOpenRequest && 'an open request',
    gate.isAnswerTailFollowed && 'the text after a final answer is followed',
    gate.isLimited && 'the account or model is limited',
    gate.isApiBilled && 'billed to API credits',
  ].filter((reason): reason is string => typeof reason === 'string');
  return skipReasons.length === 0 ? { shouldRemind: true } : { shouldRemind: false, skipReasons };
}

/** @description The agent-facing reminder (D14): factual, asks for no text reply. */
export function buildTodoReminderText(lastUpdateAt: number | undefined, nowMs: number): string {
  const opening = lastUpdateAt === undefined
    ? 'You have not published a todo list yet and you have been working.'
    : `Your published todo list was last updated ${Math.max(1, Math.round((nowMs - lastUpdateAt) / msPerMinute))} min ago and you have worked since.`;
  return `[Todo] ${opening} todo_update records in-work / queued / done; with no items it confirms the list is still accurate. No text reply is needed.`;
}
