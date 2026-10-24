/**
 * `/todo` — the shared agent todo registry seen from Telegram: a topic's published list. Read-only: an item is changed
 * by telling the agent. See README.md in this folder.
 */
import { t } from '../../../i18n';
import type { SessionKey } from '../../../sessionKey';
import { checkIsTodoListViewEmpty, getTodoListView, getTrimmedTodoTitle, type TodoListView } from '../../../todos/format';
import type { TodoRegistry } from '../../../todos/registry';
import type { TodoItem } from '../../../todos/types';
import { formatLocalClock } from '../../../utils/localClock';
import type { BotCore } from './botCore';

/** How many characters of an item's title a Telegram line shows. */
const todoViewTitleMaxLength = 120;
/** The `/todo` view shows the done items of today only (the agent's own list shows two days). */
const todoViewDoneDayCount = 1;
/** The indent of an item line under its section header. */
const todoViewItemIndent = '   ';

/** @description One item line of the view: the title and, when known, the clock it carries. */
function formatTodoViewItem(item: TodoItem, prefix: string, clockText: string | null): string {
  const title = getTrimmedTodoTitle(item.title, todoViewTitleMaxLength);
  return `${todoViewItemIndent}${prefix}${title}${clockText === null ? '' : ` — ${clockText}`}`;
}

/**
 * @description The `/todo` text of a topic (port-free: its test renders it without booting the bot). `topicLabel`
 * names the topic in the title line.
 */
export function renderTodoTopicView(view: TodoListView, topicLabel: string): string {
  const title = t('todo.topicTitle', { topic: topicLabel });
  if (checkIsTodoListViewEmpty(view)) return `${title}\n\n${t('todo.emptyList')}`;
  const sections: string[] = [];
  if (view.inWork.length > 0) {
    sections.push([
      t('todo.inWorkHeader'),
      ...view.inWork.map((item) => formatTodoViewItem(item, '', item.startedAt === undefined ? null : t('todo.sinceClock', { time: formatLocalClock(item.startedAt) }))),
    ].join('\n'));
  }
  if (view.queue.length > 0) {
    sections.push([t('todo.queueHeader'), ...view.queue.map((item, index) => formatTodoViewItem(item, `${index + 1}. `, null))].join('\n'));
  }
  const doneToday = view.doneDays[0]?.items ?? [];
  if (doneToday.length > 0) {
    sections.push([t('todo.doneTodayHeader'), ...doneToday.map((item) => formatTodoViewItem(item, '', formatLocalClock(item.closedAt ?? item.updatedAt)))].join('\n'));
  }
  return [title, ...sections].join('\n\n');
}

type TodoPorts = Pick<BotCore, 'command' | 'getState' | 'replyToThread' | 'checkIsGeneral'> & {
  getTodoRegistry: () => TodoRegistry;
};

export function createTodo(ports: TodoPorts) {
  const { command, getState, replyToThread, checkIsGeneral, getTodoRegistry } = ports;

  /** The name a topic's view is titled with: its topic name when the bot knows it, else its folder. */
  function getTopicLabel(key: SessionKey): string {
    const binding = getState().getBinding(key);
    return binding?.topicName ?? binding?.subdir ?? key.thread;
  }

  async function showTopicList(key: SessionKey): Promise<void> {
    if (checkIsGeneral(key) || getState().getBinding(key) === null) {
      await replyToThread(key, t('thread.bind_required'));
      return;
    }
    const view = getTodoListView(getTodoRegistry().getTopic(key).items, Date.now(), todoViewDoneDayCount);
    await replyToThread(key, renderTodoTopicView(view, getTopicLabel(key)));
  }

  function registerTodoCommands(): void {
    command('todo', async (_ctx, key) => {
      await showTopicList(key);
    });
  }

  return { registerTodoCommands };
}
