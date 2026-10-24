/**
 * `/todo` — the shared agent todo registry seen from Telegram: a topic's published list, and in General the settings
 * (on / off, the staleness reminder's interval). The lists are read-only here: an item is changed by telling the
 * agent. See README.md in this folder.
 */
import { Markup, type Context } from 'telegraf';
import { t } from '../../../i18n';
import { loadInstanceSettingsForUpdate, saveInstanceSettingsChange } from '../../../instanceSettings';
import type { SessionKey } from '../../../sessionKey';
import { checkIsTodoListViewEmpty, getTodoListView, getTrimmedTodoTitle, type TodoListView } from '../../../todos/format';
import { todoReminderMinuteOptions, todoReminderOffMinutes, type TodoReminderSettings } from '../../../todos/nag';
import type { TodoRegistry } from '../../../todos/registry';
import type { TodoItem } from '../../../todos/types';
import { formatLocalClock } from '../../../utils/localClock';
import type { BotCore } from './botCore';
import { getCallbackMessageId } from './callbackMessage';
import { answerCallbackQuerySafely } from './callbackToast';

/** How many characters of an item's title a Telegram line shows. */
const todoViewTitleMaxLength = 120;
/** The `/todo` view shows the done items of today only (the agent's own list shows two days). */
const todoViewDoneDayCount = 1;
/** The indent of an item line under its section header. */
const todoViewItemIndent = '   ';
const minutesPerHour = 60;

/** The buttons: open the settings, back to the General screen, the switch, an interval. */
export const todoSettingsCallback = 'todo_cfg';
export const todoGeneralCallback = 'todo_general';
const todoSwitchCallbackRe = /^todo_(on|off)$/;
const todoIntervalCallbackRe = /^todo_rem_(\d+)$/;
const todoSwitchOnWord = 'on';

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

/** @description An interval as the settings show it: «off», «30 min», «1 h». */
export function formatTodoReminderInterval(minutes: number): string {
  if (minutes === todoReminderOffMinutes) return t('todo.reminderOff');
  return minutes % minutesPerHour === 0 ? t('todo.intervalHours', { count: minutes / minutesPerHour }) : t('todo.intervalMinutes', { count: minutes });
}

/** @name TodoScreen @description A rendered screen: its text and its button rows (label + callback data). */
export interface TodoScreen {
  text: string;
  rows: Array<Array<{ label: string; data: string }>>;
}

/** @description The settings screen (General): the switch and, while on, the reminder's intervals with ✓ on the current one. */
export function renderTodoSettingsScreen(settings: TodoReminderSettings): TodoScreen {
  const lines = [
    t('todo.settingsTitle'),
    '',
    t('todo.settingsEnabledLine', { state: t(settings.isEnabled ? 'todo.stateOn' : 'todo.stateOff') }),
    ...(settings.isEnabled ? [t('todo.settingsReminderLine', { interval: formatTodoReminderInterval(settings.reminderMinutes) })] : []),
  ];
  const switchRow = [settings.isEnabled ? { label: t('todo.turnOffButton'), data: 'todo_off' } : { label: t('todo.turnOnButton'), data: 'todo_on' }];
  const intervalRow = todoReminderMinuteOptions.map((minutes) => {
    const label = formatTodoReminderInterval(minutes);
    return { label: minutes === settings.reminderMinutes ? `✓ ${label}` : label, data: `todo_rem_${minutes}` };
  });
  return {
    text: lines.join('\n'),
    rows: [switchRow, ...(settings.isEnabled ? [intervalRow] : []), [{ label: t('todo.backButton'), data: todoGeneralCallback }]],
  };
}

/** @description The General screen: every project's board (shared todo registry S3) and the way to the settings. */
export function renderTodoGeneralScreen(settings: TodoReminderSettings): TodoScreen {
  const lines = [t('todo.generalTitle'), ...(settings.isEnabled ? [] : ['', t('todo.disabledNote')])];
  return { text: lines.join('\n'), rows: [[{ label: t('todo.settingsButton'), data: todoSettingsCallback }]] };
}

/** @description A screen's buttons as the inline keyboard. */
function buildTodoKeyboard(screen: TodoScreen): object {
  return screen.rows.length === 0 ? {} : Markup.inlineKeyboard(screen.rows.map((row) => row.map((button) => Markup.button.callback(button.label, button.data))));
}

type TodoPorts = Pick<BotCore, 'bot' | 'command' | 'getState' | 'replyToThread' | 'editThreadMessage' | 'authoriseContext' | 'withThreadLocale' | 'checkIsGeneral'> & {
  getTodoRegistry: () => TodoRegistry;
  readTodoSettings: () => TodoReminderSettings;
  /** Where `settings.json` lives (the config directory of the instance's real env file). */
  getSettingsPath: () => string;
};

export function createTodo(ports: TodoPorts) {
  const { bot, command, getState, replyToThread, editThreadMessage, authoriseContext, withThreadLocale, checkIsGeneral, getTodoRegistry, readTodoSettings, getSettingsPath } = ports;

  /** The name a topic's view is titled with: its topic name when the bot knows it, else its folder. */
  function getTopicLabel(key: SessionKey): string {
    const binding = getState().getBinding(key);
    return binding?.topicName ?? binding?.subdir ?? key.thread;
  }

  async function showTopicList(key: SessionKey): Promise<void> {
    if (getState().getBinding(key) === null) {
      await replyToThread(key, t('thread.bind_required'));
      return;
    }
    const view = getTodoListView(getTodoRegistry().getTopic(key).items, Date.now(), todoViewDoneDayCount);
    const disabledNote = readTodoSettings().isEnabled ? '' : `\n\n${t('todo.disabledNote')}`;
    await replyToThread(key, `${renderTodoTopicView(view, getTopicLabel(key))}${disabledNote}`);
  }

  /** Re-render the message a tap came from in its topic's language. */
  async function rerender(ctx: Context, key: SessionKey, render: () => TodoScreen): Promise<void> {
    const messageId = getCallbackMessageId(ctx);
    if (messageId === null) return;
    const screen = withThreadLocale(key, render);
    await editThreadMessage(key, messageId, screen.text, buildTodoKeyboard(screen));
  }

  /** A tap on a General screen: the topic it came from, `null` when refused (already answered). */
  async function authoriseGeneralTap(ctx: Context): Promise<SessionKey | null> {
    const key = await authoriseContext(ctx);
    if (!key) {
      await answerCallbackQuerySafely(ctx, t('cb.access_denied'));
      return null;
    }
    if (!checkIsGeneral(key)) {
      await answerCallbackQuerySafely(ctx, withThreadLocale(key, () => t('todo.generalOnly')));
      return null;
    }
    return key;
  }

  async function handleSettingTap(ctx: Context, change: Partial<TodoReminderSettings>): Promise<void> {
    const key = await authoriseGeneralTap(ctx);
    if (key === null) return;
    const filePath = getSettingsPath();
    // Only the field tapped is written: the file says only what the operator chose.
    const code = saveInstanceSettingsChange(filePath, { todo: { ...loadInstanceSettingsForUpdate(filePath).todo, ...change } });
    await answerCallbackQuerySafely(ctx, withThreadLocale(key, () => (code === null ? t('todo.settingsSavedToast') : t('update.cmd.writeFailed', { path: filePath, code }))));
    await rerender(ctx, key, () => renderTodoSettingsScreen(readTodoSettings()));
  }

  function registerTodoCommands(): void {
    command('todo', async (_ctx, key) => {
      if (checkIsGeneral(key)) {
        const screen = renderTodoGeneralScreen(readTodoSettings());
        await replyToThread(key, screen.text, buildTodoKeyboard(screen));
        return;
      }
      await showTopicList(key);
    });
  }

  function registerTodoCallbacks(): void {
    bot.action(todoSettingsCallback, async (ctx) => {
      const key = await authoriseGeneralTap(ctx);
      if (key === null) return;
      await answerCallbackQuerySafely(ctx);
      await rerender(ctx, key, () => renderTodoSettingsScreen(readTodoSettings()));
    });

    bot.action(todoGeneralCallback, async (ctx) => {
      const key = await authoriseGeneralTap(ctx);
      if (key === null) return;
      await answerCallbackQuerySafely(ctx);
      await rerender(ctx, key, () => renderTodoGeneralScreen(readTodoSettings()));
    });

    bot.action(todoSwitchCallbackRe, async (ctx) => {
      await handleSettingTap(ctx, { isEnabled: ctx.match[1] === todoSwitchOnWord });
    });

    bot.action(todoIntervalCallbackRe, async (ctx) => {
      const minutes = Number(ctx.match[1]);
      // Only the offered intervals: an old or forged button never writes a value the screen does not show.
      if (!todoReminderMinuteOptions.includes(minutes)) {
        await answerCallbackQuerySafely(ctx);
        return;
      }
      await handleSettingTap(ctx, { reminderMinutes: minutes });
    });
  }

  return { registerTodoCommands, registerTodoCallbacks };
}
