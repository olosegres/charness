import { openTodoStatuses, type TodoItem, type TodoPosition } from './types';

/**
 * @description The ONE total order over a conversation's items (D23): in-work items lead, then the queue in its
 * order, then the closed items by the time they were closed, newest first. The queue order is the order of the open
 * items in the stored array; these helpers read and rearrange it, never a number of their own.
 */

/** @description Whether an item is still to be done. */
export function checkIsOpenTodoItem(item: TodoItem): boolean {
  return openTodoStatuses.includes(item.status);
}

/** @description The in-work items, in their stored order. */
export function getInWorkTodoItems(items: readonly TodoItem[]): TodoItem[] {
  return items.filter((item) => item.status === 'inWork');
}

/** @description The queue: the queued items, in their stored order — the order the agent takes them in. */
export function getQueuedTodoItems(items: readonly TodoItem[]): TodoItem[] {
  return items.filter((item) => item.status === 'queued');
}

/** @description The closed items (done and dropped), the most recently closed first. */
export function getClosedTodoItems(items: readonly TodoItem[]): TodoItem[] {
  return items.filter((item) => !checkIsOpenTodoItem(item)).sort((left, right) => (right.closedAt ?? 0) - (left.closedAt ?? 0));
}

/** @description The whole list in the total order (D23). */
export function getTodoItemsInOrder(items: readonly TodoItem[]): TodoItem[] {
  return [...getInWorkTodoItems(items), ...getQueuedTodoItems(items), ...getClosedTodoItems(items)];
}

/** @description `items` with the item `id` moved before (`top`) or after (`bottom`) every open item. */
export function getTodoItemsWithMovedItem(items: readonly TodoItem[], id: string, position: TodoPosition): TodoItem[] {
  const moved = items.find((item) => item.id === id);
  if (!moved) return [...items];
  const rest = items.filter((item) => item.id !== id);
  if (position === 'bottom') return [...rest, moved];
  const firstOpenIndex = rest.findIndex(checkIsOpenTodoItem);
  const insertAt = firstOpenIndex === -1 ? rest.length : firstOpenIndex;
  return [...rest.slice(0, insertAt), moved, ...rest.slice(insertAt)];
}

/**
 * @description `items` with the open ones rearranged: the ids of `orderedIds` first, in that order, then the open
 * items it does not list in their relative order. The closed items keep their places — their order is their close
 * time. Ids that are not open items are ignored (the caller rejects them first).
 */
export function getTodoItemsInRequestedOrder(items: readonly TodoItem[], orderedIds: readonly string[]): TodoItem[] {
  const openItems = items.filter(checkIsOpenTodoItem);
  const listed = orderedIds.flatMap((id) => openItems.filter((item) => item.id === id));
  const unlisted = openItems.filter((item) => !orderedIds.includes(item.id));
  const reordered = [...listed, ...unlisted];
  let nextOpenIndex = 0;
  return items.map((item) => (checkIsOpenTodoItem(item) ? reordered[nextOpenIndex++] : item));
}
