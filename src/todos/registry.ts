import type { SessionKey } from '../sessionKey';
import { formatOwnTodoList, formatTodoHistory } from './format';
import { applyTodoUpdate, type TodoUpdateArgs } from './merge';
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
}

/** @description The opening line of a `todo_update` result: what the call did. */
function formatUpdateSummary(isChanged: boolean, createdIds: readonly string[]): string {
  if (!isChanged) return 'Noted: your list is still accurate.';
  return createdIds.length === 0 ? 'Saved.' : `Saved. New ${createdIds.length === 1 ? 'item' : 'items'}: ${createdIds.join(', ')}.`;
}

export function createTodoRegistry(deps: TodoRegistryDeps): TodoRegistry {
  const { store, getNowMs } = deps;
  return {
    updateTodos(key, args) {
      const nowMs = getNowMs();
      const result = applyTodoUpdate(store.getTopic(key), args, nowMs);
      if (!result.ok) return { ok: false, error: `Nothing was saved:\n${result.errors.map((error) => `• ${error}`).join('\n')}` };
      const saved = store.saveTopic(key, result.file);
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
  };
}
