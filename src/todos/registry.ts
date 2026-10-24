import { keyToString, type SessionKey } from '../sessionKey';
import { formatOwnTodoList, formatTodoHistory } from './format';
import { applyTodoUpdate, type TodoUpdateArgs } from './merge';
import {
  buildTodoReminderText,
  checkIsTodoNagStale,
  createTodoNagState,
  decidePromptTodoReminder,
  decideStandaloneTodoReminder,
  getTodoNagStateAfterPersonActivity,
  getTodoNagStateAfterReminder,
  getTodoNagStateAtTurnEnd,
  getTodoNagStateWithWork,
  type TodoNagState,
  type TodoReminderDecision,
  type TodoStandaloneGate,
} from './nag';
import { getClosedTodoItems, getInWorkTodoItems } from './order';
import type { TodoStore } from './store';
import type { TodoTopicFile } from './types';

/**
 * @description The todo registry's agent-facing service: what `todo_update` and `todo_read` do and answer, and the
 * hint a `final` answer gets while the list still shows work in progress (D8). Platform-neutral — a Telegram topic
 * and a Jira issue publish alike; the MCP surface only routes the conversation its token names here.
 */

/** The most closed items `todo_read`'s history returns (D5). */
export const todoHistoryMaxItems = 50;

/** @name TodoReadArgs @description A `todo_read` call: the conversation's own list, optionally with its history. */
export interface TodoReadArgs {
  includeHistory?: boolean;
}

/** @description What a `todo_*` tool answers. */
export type TodoToolOutcome = { ok: true; message: string } | { ok: false; error: string };

/** @name TodoRegistryDeps @description The file store and the clock. */
export interface TodoRegistryDeps {
  store: TodoStore;
  getNowMs: () => number;
}

/** @name TodoRegistry @description The registry's operations over the conversations' lists. */
export interface TodoRegistry {
  updateTodos(key: SessionKey, args: TodoUpdateArgs): TodoToolOutcome;
  readTodos(key: SessionKey, args: TodoReadArgs): TodoToolOutcome;
  /** The line a `final` answer's result carries when the list was not touched during the request (D8), else `null`. */
  getFinalAnswerNote(key: SessionKey, requestCreatedAt: number): string | null;
  /** The conversation's stored record (the `/todo` view reads it). */
  getTopic(key: SessionKey): TodoTopicFile;
  /** The session was busy for `elapsedMs` (the reminder engine's poll); kept in memory until the turn ends. */
  addTurnWork(key: SessionKey, elapsedMs: number): void;
  /** A turn of the conversation ended: the work is stored, and the reminder's clock starts at the first one. */
  noteTurnEnd(key: SessionKey, nowMs: number): void;
  /**
   * Form a (D11): the reminder line the next prompt carries when the list is stale, else `null`. Taking it counts as
   * a delivered reminder.
   */
  takePromptReminder(key: SessionKey, intervalMs: number | null, nowMs: number): string | null;
  /** Form b (D12): whether a standalone reminder goes out now, and its text. */
  decideStandaloneReminder(key: SessionKey, intervalMs: number | null, gate: TodoStandaloneGate, nowMs: number): TodoReminderDecision & { text: string; isStale: boolean };
  /** A standalone reminder reached the agent. */
  noteReminderDelivered(key: SessionKey, nowMs: number): void;
  /** A person wrote in the conversation: the silence after ignored reminders ends (D13). */
  notePersonActivity(key: SessionKey): void;
}

/** @description The opening line of a `todo_update` result: what the call did. */
function formatUpdateSummary(isChanged: boolean, createdIds: readonly string[]): string {
  if (!isChanged) return 'Noted: your list is still accurate.';
  return createdIds.length === 0 ? 'Saved.' : `Saved. New ${createdIds.length === 1 ? 'item' : 'items'}: ${createdIds.join(', ')}.`;
}

export function createTodoRegistry(deps: TodoRegistryDeps): TodoRegistry {
  const { store, getNowMs } = deps;
  /** Busy time polled since the conversation's last turn end, not stored yet (a write per poll would be wasted). */
  const unsavedWorkMs = new Map<string, number>();

  /** The conversation's reminder bookkeeping with the unsaved work folded in. */
  function getCurrentNag(key: SessionKey): TodoNagState {
    const nag = store.getTopic(key).nag ?? createTodoNagState();
    return getTodoNagStateWithWork(nag, unsavedWorkMs.get(keyToString(key)) ?? 0);
  }

  /** Store `nag` (the unsaved work is in it now). */
  function saveNag(key: SessionKey, nag: TodoNagState): void {
    unsavedWorkMs.delete(keyToString(key));
    store.saveTopic(key, { ...store.getTopic(key), nag });
  }

  return {
    updateTodos(key, args) {
      const nowMs = getNowMs();
      const result = applyTodoUpdate(store.getTopic(key), args, nowMs);
      if (!result.ok) return { ok: false, error: `Nothing was saved:\n${result.errors.map((error) => `• ${error}`).join('\n')}` };
      // Any call says the list is accurate: the reminder's clock waits for the next turn end (D10).
      unsavedWorkMs.delete(keyToString(key));
      const saved = store.saveTopic(key, { ...result.file, nag: createTodoNagState() });
      return { ok: true, message: `${formatUpdateSummary(result.isChanged, result.createdIds)}\n\n${formatOwnTodoList(saved.items, nowMs)}` };
    },

    readTodos(key, args) {
      const topic = store.getTopic(key);
      const ownList = formatOwnTodoList(topic.items, getNowMs());
      if (args.includeHistory !== true) return { ok: true, message: ownList };
      const liveClosed = getClosedTodoItems(topic.items);
      const archived = liveClosed.length >= todoHistoryMaxItems ? [] : store.readArchivedItems(key, todoHistoryMaxItems - liveClosed.length);
      return { ok: true, message: `${ownList}\n\n${formatTodoHistory([...liveClosed, ...archived].slice(0, todoHistoryMaxItems))}` };
    },

    getFinalAnswerNote(key, requestCreatedAt) {
      const topic = store.getTopic(key);
      if ((topic.lastUpdateAt ?? 0) >= requestCreatedAt) return null;
      const inWork = getInWorkTodoItems(topic.items);
      if (inWork.length === 0) return null;
      const titles = inWork.map((item) => `${item.id} «${item.title}»`).join(', ');
      return `Your published todo list still shows in work: ${titles}. If that changed, record it with todo_update (done, dropped or queued) now.`;
    },

    getTopic: (key) => store.getTopic(key),

    addTurnWork(key, elapsedMs) {
      // Before the clock starts nothing counts (the turn the update was made in included).
      if (store.getTopic(key).nag?.clockStartedAt === undefined || elapsedMs <= 0) return;
      const conversationKey = keyToString(key);
      unsavedWorkMs.set(conversationKey, (unsavedWorkMs.get(conversationKey) ?? 0) + elapsedMs);
    },

    noteTurnEnd(key, nowMs) {
      const stored = store.getTopic(key).nag;
      const nag = getTodoNagStateAtTurnEnd(getCurrentNag(key), nowMs);
      if (stored !== undefined && nag.workedMs === stored.workedMs && nag.clockStartedAt === stored.clockStartedAt) return;
      saveNag(key, nag);
    },

    takePromptReminder(key, intervalMs, nowMs) {
      const nag = getCurrentNag(key);
      if (!decidePromptTodoReminder(nag, intervalMs).shouldRemind) return null;
      saveNag(key, getTodoNagStateAfterReminder(nag, nowMs));
      return buildTodoReminderText(store.getTopic(key).lastUpdateAt, nowMs);
    },

    decideStandaloneReminder(key, intervalMs, gate, nowMs) {
      const nag = getCurrentNag(key);
      return {
        ...decideStandaloneTodoReminder(nag, intervalMs, gate),
        text: buildTodoReminderText(store.getTopic(key).lastUpdateAt, nowMs),
        isStale: checkIsTodoNagStale(nag, intervalMs),
      };
    },

    noteReminderDelivered(key, nowMs) {
      saveNag(key, getTodoNagStateAfterReminder(getCurrentNag(key), nowMs));
    },

    notePersonActivity(key) {
      const stored = store.getTopic(key).nag;
      if (stored === undefined || stored.ignoredCount === 0) return;
      saveNag(key, getTodoNagStateAfterPersonActivity(getCurrentNag(key)));
    },
  };
}
