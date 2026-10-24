import type { TodoNagState } from './nag';

/**
 * @description Shapes of the shared agent todo registry: one published list per conversation (a Telegram topic, a
 * Jira issue), kept in its own file under `DATA_DIR/todos/` (`store.ts`). A list belongs to the CONVERSATION, never to
 * a session: `/new`, `/quit`, a backend switch and a restart keep it.
 */

/**
 * @name TodoStatus
 * @description Where an item stands: `queued` — waiting, in queue order; `inWork` — being worked on now; `done` —
 * finished; `dropped` — will not be done (the removal: nothing disappears by omission).
 */
export const todoStatuses = ['queued', 'inWork', 'done', 'dropped'] as const;
export type TodoStatus = (typeof todoStatuses)[number];

/** The statuses of an item still to be done. */
export const openTodoStatuses: readonly TodoStatus[] = ['queued', 'inWork'];

/**
 * @name TodoSource
 * @description Who put the item on the list: the agent itself, the owner (a tracker), or a tracker item linked to the
 * conversation. Only `agent` exists until the trackers ship.
 */
export const todoSources = ['agent', 'owner', 'link'] as const;
export type TodoSource = (typeof todoSources)[number];

/** Where `position` puts an item among the open ones. */
export const todoPositions = ['top', 'bottom'] as const;
export type TodoPosition = (typeof todoPositions)[number];

/** The longest item title and note accepted. */
export const todoTitleMaxLength = 200;
export const todoNoteMaxLength = 500;
/** The longest `ref` (a tracker key, id or link). */
export const todoRefMaxLength = 200;

/**
 * @name TodoItem
 * @description One published item. Its queue position is its place in {@link TodoTopicFile.items} among the open
 * items (the array order IS the queue order — one source of truth). Times are epoch ms.
 */
export interface TodoItem {
  /** `t1`, `t2`, … per conversation, never reused. */
  id: string;
  title: string;
  status: TodoStatus;
  note?: string;
  source: TodoSource;
  /** A tracker id / key / link the item names (a ticket the agent created on the way). */
  ref?: string;
  createdAt: number;
  updatedAt: number;
  /** When the item last went in work. */
  startedAt?: number;
  /** When the item was closed (done or dropped). */
  closedAt?: number;
}

/**
 * @name TodoTopicFile
 * @description A conversation's whole todo record, as stored. `revision` counts content changes (what a peer's
 * board compares); `lastUpdateAt` is the last `todo_update` call of any kind — a call that changes nothing still
 * says "the list is accurate".
 */
export interface TodoTopicFile {
  version: 1;
  /** The conversation's serialized `SessionKey`. */
  conversationKey: string;
  /** The number the next new item's id takes. */
  nextItemNumber: number;
  items: TodoItem[];
  revision: number;
  /** When the content last changed (`revision` moved). */
  changedAt?: number;
  /** When the agent last called `todo_update`. */
  lastUpdateAt?: number;
  /** The staleness reminder's bookkeeping (`nag.ts`); absent = nothing worked or reminded since the last update. */
  nag?: TodoNagState;
}
