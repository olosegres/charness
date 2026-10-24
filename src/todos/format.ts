import { formatLocalClock } from '../utils/localClock';
import { formatReminderDateIso, getLocalDateAtDayOffset } from '../utils/reminderWizard';
import { getClosedTodoItems, getInWorkTodoItems, getQueuedTodoItems } from './order';
import type { TodoItem } from './types';

/**
 * @description What a list shows and how the agent reads it. The view model ({@link getTodoListView}) is the one
 * place that decides which items a list shows; the agent's text here and the Telegram `/todo` view render it.
 * Agent-facing text is English on every surface.
 */

/** How many local days of done items a list shows: today and yesterday (D4). */
export const todoRecentDoneDays = 2;

/** @name TodoDoneDay @description The done items of one local day, the most recently closed first. */
export interface TodoDoneDay {
  /** `YYYY-MM-DD`, local. */
  date: string;
  items: TodoItem[];
}

/** @name TodoListView @description What a list shows: in work, the queue in order, the recent done by day. */
export interface TodoListView {
  inWork: TodoItem[];
  queue: TodoItem[];
  doneDays: TodoDoneDay[];
}

/** @description The local calendar date (`YYYY-MM-DD`) of an instant. */
export function getLocalDateOf(epochMs: number): string {
  return formatReminderDateIso(new Date(epochMs));
}

/** @description The view of `items` at `nowMs`, with the done items of the last `doneDayCount` local days. */
export function getTodoListView(items: readonly TodoItem[], nowMs: number, doneDayCount: number = todoRecentDoneDays): TodoListView {
  const firstShownDate = formatReminderDateIso(getLocalDateAtDayOffset(nowMs, 1 - doneDayCount));
  const doneDays: TodoDoneDay[] = [];
  for (const item of getClosedTodoItems(items)) {
    if (item.status !== 'done' || item.closedAt === undefined) continue;
    const date = getLocalDateOf(item.closedAt);
    if (date < firstShownDate) continue;
    const day = doneDays.find((candidate) => candidate.date === date);
    if (day) day.items.push(item);
    else doneDays.push({ date, items: [item] });
  }
  return { inWork: getInWorkTodoItems(items), queue: getQueuedTodoItems(items), doneDays };
}

/** @description Whether the view shows nothing at all. */
export function checkIsTodoListViewEmpty(view: TodoListView): boolean {
  return view.inWork.length === 0 && view.queue.length === 0 && view.doneDays.length === 0;
}

/** @description `title`, cut to `maxLength` characters with an ellipsis. */
export function getTrimmedTodoTitle(title: string, maxLength: number): string {
  const characters = [...title];
  return characters.length <= maxLength ? title : `${characters.slice(0, maxLength - 1).join('')}…`;
}

/** @description The details after an item's title in the agent's own list: its ref and note. */
function formatOwnItemDetails(item: TodoItem): string {
  return `${item.ref === undefined ? '' : ` [${item.ref}]`}${item.note === undefined ? '' : ` · note: ${item.note}`}`;
}

/** @description The agent's own list as the `todo_*` results show it — with the ids it patches by. */
export function formatOwnTodoList(items: readonly TodoItem[], nowMs: number): string {
  const view = getTodoListView(items, nowMs);
  if (checkIsTodoListViewEmpty(view)) return 'Your published todo list is empty.';
  const lines = ['Your published todo list:'];
  if (view.inWork.length > 0) {
    lines.push('▶ in work:');
    for (const item of view.inWork) {
      const since = item.startedAt === undefined ? '' : ` — since ${formatLocalClock(item.startedAt)}`;
      lines.push(`  ${item.id} ${item.title}${formatOwnItemDetails(item)}${since}`);
    }
  }
  if (view.queue.length > 0) {
    lines.push('▷ queue (take it top-down):');
    view.queue.forEach((item, index) => lines.push(`  ${index + 1}. ${item.id} ${item.title}${formatOwnItemDetails(item)}`));
  }
  for (const day of view.doneDays) {
    lines.push(`✓ done ${day.date}:`);
    for (const item of day.items) lines.push(`  ${item.id} ${item.title}${formatOwnItemDetails(item)} (${formatLocalClock(item.closedAt ?? item.updatedAt)})`);
  }
  return lines.join('\n');
}

/** @description Older closed items (done and dropped) for `todo_read`'s history, most recent first. */
export function formatTodoHistory(items: readonly TodoItem[]): string {
  if (items.length === 0) return 'History: nothing closed yet.';
  const lines = ['History (closed items, most recent first):'];
  for (const item of items) {
    const closedAt = item.closedAt ?? item.updatedAt;
    lines.push(`  ${getLocalDateOf(closedAt)} ${formatLocalClock(closedAt)} ${item.status === 'done' ? '✓' : '✗ dropped'} ${item.id} ${item.title}${formatOwnItemDetails(item)}`);
  }
  return lines.join('\n');
}
