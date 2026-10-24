import { checkIsOpenTodoItem, getTodoItemsInRequestedOrder, getTodoItemsWithMovedItem } from './order';
import type { TodoItem, TodoPosition, TodoStatus, TodoTopicFile } from './types';

/**
 * @description `todo_update` as an UPSERT (D3): an item without an id is new (queued, at the bottom, unless it says
 * otherwise); an item with an id patches only the fields it names; removal is the status `dropped`; `order` lists
 * open items in the wanted queue order. Nothing disappears by omission, and a call with neither part only says the
 * list is still accurate. All or nothing: a call with any error changes nothing.
 */

/** @name TodoItemPatch @description One entry of `todo_update`'s `items`. */
export interface TodoItemPatch {
  id?: string;
  title?: string;
  status?: TodoStatus;
  /** An empty note removes it. */
  note?: string;
  /** An empty ref removes it. */
  ref?: string;
  position?: TodoPosition;
}

/** @name TodoUpdateArgs @description A whole `todo_update` call. */
export interface TodoUpdateArgs {
  items?: readonly TodoItemPatch[];
  order?: readonly string[];
}

/**
 * @name TodoUpdateResult
 * @description The updated file, or the reasons nothing was applied. `isChanged` = the content moved (a new
 * revision); `createdIds` are the ids given to the new items, in call order.
 */
export type TodoUpdateResult =
  | { ok: true; file: TodoTopicFile; isChanged: boolean; createdIds: string[] }
  | { ok: false; errors: string[] };

/** Line breaks, tabs and the other control characters, in runs, with the spaces around them. */
const lineBreakingRunRe = /[\s\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/**
 * @description An agent's text as ONE line: every run of whitespace and control characters becomes one space. A
 * title, note or ref is pasted into other agents' prompts as a line of the board; a line break in it would break that
 * layout and let one agent's text pass for a bot-made block (`[Request …]`, `[Project board …]`) in another's prompt.
 */
export function getSingleLineTodoText(text: string): string {
  return text.replace(lineBreakingRunRe, ' ').trim();
}

/** The prefix of every item id; the number after it counts per conversation. */
const todoItemIdPrefix = 't';

function buildTodoItemId(itemNumber: number): string {
  return `${todoItemIdPrefix}${itemNumber}`;
}

/** @description The item fields a status change sets: when it went in work, when it closed. */
function getStatusTimes(item: TodoItem, status: TodoStatus, nowMs: number): Pick<TodoItem, 'startedAt' | 'closedAt'> {
  if (status === item.status) return { startedAt: item.startedAt, closedAt: item.closedAt };
  const isClosing = status === 'done' || status === 'dropped';
  return {
    startedAt: status === 'inWork' ? nowMs : item.startedAt,
    closedAt: isClosing ? nowMs : undefined,
  };
}

/** @description `item` with the optional text field `name` set, or removed for an empty value. */
function getItemWithTextField(item: TodoItem, name: 'note' | 'ref', value: string | undefined): TodoItem {
  if (value === undefined) return item;
  const trimmed = getSingleLineTodoText(value);
  if (trimmed.length > 0) return { ...item, [name]: trimmed };
  const withoutField = { ...item };
  delete withoutField[name];
  return withoutField;
}

/** @description Whether two items carry the same content (what a peer would see change). */
function checkIsSameTodoContent(left: TodoItem, right: TodoItem): boolean {
  return left.title === right.title && left.status === right.status && left.note === right.note && left.ref === right.ref;
}

/** @description Apply one `todo_update` call to `file` at `nowMs`. */
export function applyTodoUpdate(file: TodoTopicFile, args: TodoUpdateArgs, nowMs: number): TodoUpdateResult {
  const errors: string[] = [];
  let items = [...file.items];
  let nextItemNumber = file.nextItemNumber;
  const createdIds: string[] = [];
  let isOrderChanged = false;
  let isContentChanged = false;

  (args.items ?? []).forEach((patch, index) => {
    const label = `items[${index}]`;
    if (patch.id === undefined) {
      const title = getSingleLineTodoText(patch.title ?? '');
      if (title.length === 0) {
        errors.push(`${label}: a new item needs a title (an item without an id is a new one).`);
        return;
      }
      const id = buildTodoItemId(nextItemNumber);
      nextItemNumber += 1;
      const status = patch.status ?? 'queued';
      const created: TodoItem = {
        id,
        title,
        status,
        source: 'agent',
        createdAt: nowMs,
        updatedAt: nowMs,
        ...(status === 'inWork' ? { startedAt: nowMs } : {}),
        ...(status === 'done' || status === 'dropped' ? { closedAt: nowMs } : {}),
      };
      items.push(getItemWithTextField(getItemWithTextField(created, 'note', patch.note), 'ref', patch.ref));
      if (patch.position === 'top') items = getTodoItemsWithMovedItem(items, id, 'top');
      createdIds.push(id);
      return;
    }
    const current = items.find((item) => item.id === patch.id);
    if (!current) {
      errors.push(`${label}: there is no item "${patch.id}" in your list.`);
      return;
    }
    if (patch.title !== undefined && getSingleLineTodoText(patch.title).length === 0) {
      errors.push(`${label}: the title of "${patch.id}" cannot be empty.`);
      return;
    }
    const status = patch.status ?? current.status;
    const patched = getItemWithTextField(getItemWithTextField({
      ...current,
      ...(patch.title === undefined ? {} : { title: getSingleLineTodoText(patch.title) }),
      status,
      ...getStatusTimes(current, status, nowMs),
    }, 'note', patch.note), 'ref', patch.ref);
    const isItemChanged = !checkIsSameTodoContent(current, patched);
    isContentChanged ||= isItemChanged;
    const updated = isItemChanged ? { ...patched, updatedAt: nowMs } : patched;
    items = items.map((item) => (item.id === current.id ? updated : item));
    if (patch.position !== undefined && checkIsOpenTodoItem(updated)) {
      const before = items.map((item) => item.id).join();
      items = getTodoItemsWithMovedItem(items, current.id, patch.position);
      isOrderChanged ||= before !== items.map((item) => item.id).join();
    }
  });

  if (args.order !== undefined) {
    const openIds = new Set(items.filter(checkIsOpenTodoItem).map((item) => item.id));
    const foreignIds = args.order.filter((id) => !openIds.has(id));
    const repeatedIds = args.order.filter((id, index) => args.order?.indexOf(id) !== index);
    if (foreignIds.length > 0) errors.push(`order: ${foreignIds.join(', ')} ${foreignIds.length === 1 ? 'is' : 'are'} not an open item of your list.`);
    if (repeatedIds.length > 0) errors.push(`order: ${[...new Set(repeatedIds)].join(', ')} listed more than once.`);
    if (foreignIds.length === 0 && repeatedIds.length === 0) {
      const before = items.map((item) => item.id).join();
      items = getTodoItemsInRequestedOrder(items, args.order);
      isOrderChanged ||= before !== items.map((item) => item.id).join();
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const isChanged = createdIds.length > 0 || isOrderChanged || isContentChanged;
  return {
    ok: true,
    isChanged,
    createdIds,
    file: {
      ...file,
      items,
      nextItemNumber,
      lastUpdateAt: nowMs,
      ...(isChanged ? { revision: file.revision + 1, changedAt: nowMs } : {}),
    },
  };
}
