/**
 * `/todo` — the shared agent todo registry seen from Telegram: a topic's published list, and in General the settings
 * (on / off, the staleness reminder's interval). The lists are read-only here: an item is changed by telling the
 * agent. See README.md in this folder.
 */
import { Markup, type Context } from 'telegraf';
import { t } from '../../../i18n';
import { loadInstanceSettingsForUpdate, saveInstanceSettingsChange } from '../../../instanceSettings';
import { keyToString, tryKeyFromString, type SessionKey } from '../../../sessionKey';
import { checkIsTodoListViewEmpty, getTodoListView, getTrimmedTodoTitle, type TodoListView } from '../../../todos/format';
import { todoReminderMinuteOptions, todoReminderOffMinutes, type TodoReminderSettings } from '../../../todos/nag';
import type { TodoProject, TodoProjectOverride } from '../../../todos/projects';
import type { TodoRegistry } from '../../../todos/registry';
import type { TodoItem } from '../../../todos/types';
import { formatLocalClock } from '../../../utils/localClock';
import { getTopicNameOrFolder } from '../../../utils/topicLabel';
import type { BotCore } from './botCore';
import { buildMessageSnapshotKey, getCallbackMessageId, rememberBoundedSnapshot } from './callbackMessage';
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

/**
 * @name TodoBoardMember
 * @description One conversation on the General board: its label, whether it sleeps, what it has in work and how
 * long its queue is.
 */
export interface TodoBoardMember {
  label: string;
  isAsleep: boolean;
  inWorkTitles: string[];
  queueCount: number;
}

/** @name TodoBoardProject @description One project on the General board. */
export interface TodoBoardProject {
  name: string;
  members: TodoBoardMember[];
}

/** How many characters of an in-work title a General board line shows. */
const generalBoardTitleMaxLength = 60;

/** @description One member's line on the General board: `#docs   asleep · ▶ README · queue 2`. */
function formatTodoBoardMemberLine(member: TodoBoardMember): string {
  const [firstInWork, ...otherInWork] = member.inWorkTitles;
  const parts = [
    ...(member.isAsleep ? [t('todo.generalAsleep')] : []),
    firstInWork === undefined
      ? t('todo.generalNothingInWork')
      : `▶ ${getTrimmedTodoTitle(firstInWork, generalBoardTitleMaxLength)}${otherInWork.length > 0 ? ` (+${otherInWork.length})` : ''}`,
    ...(member.queueCount > 0 ? [t('todo.generalQueueCount', { count: member.queueCount })] : []),
  ];
  return `${todoViewItemIndent}${member.label}   ${parts.join(' · ')}`;
}

/** @description The General screen: every project's board (D17 for people) and the way to the settings. */
export function renderTodoGeneralScreen(settings: TodoReminderSettings, projects: readonly TodoBoardProject[]): TodoScreen {
  const projectBlocks = projects.map((project) => [
    t('todo.generalProjectLine', { name: project.name, count: project.members.length }),
    ...project.members.map(formatTodoBoardMemberLine),
  ].join('\n'));
  const lines = [
    t('todo.generalTitle'),
    ...(settings.isEnabled ? [] : ['', t('todo.disabledNote')]),
    '',
    projectBlocks.length === 0 ? t('todo.generalNoProjects') : projectBlocks.join('\n\n'),
  ];
  return { text: lines.join('\n'), rows: [[{ label: t('todo.settingsButton'), data: todoSettingsCallback }]] };
}

/**
 * @name TodoProjectState
 * @description A topic's project as the picker shows it: the project's name and size, the topic's override, and the
 * other topics it may join (conversation key + label).
 */
export interface TodoProjectState {
  name: string;
  memberCount: number;
  override: TodoProjectOverride | null;
  candidates: Array<{ conversationKey: string; label: string }>;
}

/** How many «Join the project of …» buttons one picker page holds. */
export const todoProjectPickerPageSize = 6;
const todoProjectAutomaticCallback = 'todo_prj_auto';
const todoProjectOwnCallback = 'todo_prj_own';
export const todoProjectPickerCallback = 'todo_prj';
export const todoListCallback = 'todo_list';
const todoProjectJoinCallbackRe = /^todo_prj_join_(\d+)$/;
const todoProjectPageCallbackRe = /^todo_prj_page_(\d+)$/;

/** @description How a topic's project was formed, as the topic view and the picker word it. */
function formatTodoProjectMode(override: TodoProjectOverride | null): string {
  if (override === null) return t('todo.projectModeAutomatic');
  return override.kind === 'own' ? t('todo.projectModeOwn') : t('todo.projectModeJoined');
}

/** @description The topic view's project line: `Project: charness · topics: 3 (automatic)`. */
export function formatTodoProjectLine(project: TodoProjectState): string {
  return t('todo.projectLine', { name: project.name, count: project.memberCount, mode: formatTodoProjectMode(project.override) });
}

/** @description The project picker of a topic (one page of join candidates, ✓ on the current choice). */
export function renderTodoProjectPicker(topicLabel: string, project: TodoProjectState, page: number): TodoScreen {
  const pageCount = Math.max(1, Math.ceil(project.candidates.length / todoProjectPickerPageSize));
  const shownPage = Math.min(Math.max(page, 0), pageCount - 1);
  const mark = (isCurrent: boolean, label: string): string => (isCurrent ? `✓ ${label}` : label);
  const joinRows = project.candidates
    .map((candidate, index) => ({ candidate, index }))
    .slice(shownPage * todoProjectPickerPageSize, (shownPage + 1) * todoProjectPickerPageSize)
    .map(({ candidate, index }) => [{
      label: mark(project.override?.kind === 'join' && project.override.conversationKey === candidate.conversationKey, t('todo.projectJoinButton', { topic: candidate.label })),
      data: `todo_prj_join_${index}`,
    }]);
  const pageRow = pageCount > 1
    ? [[
      ...(shownPage > 0 ? [{ label: '‹', data: `todo_prj_page_${shownPage - 1}` }] : []),
      ...(shownPage < pageCount - 1 ? [{ label: '›', data: `todo_prj_page_${shownPage + 1}` }] : []),
    ]]
    : [];
  return {
    text: [
      t('todo.projectPickerTitle', { topic: topicLabel }),
      '',
      t('todo.projectPickerNow', { name: project.name, mode: formatTodoProjectMode(project.override), count: project.memberCount }),
    ].join('\n'),
    rows: [
      [{ label: mark(project.override === null, t('todo.projectAutomaticButton')), data: todoProjectAutomaticCallback }],
      ...joinRows,
      [{ label: mark(project.override?.kind === 'own', t('todo.projectOwnButton')), data: todoProjectOwnCallback }],
      ...pageRow,
      [{ label: t('todo.backButton'), data: todoListCallback }],
    ],
  };
}

/** @description A screen's buttons as the inline keyboard. */
function buildTodoKeyboard(screen: TodoScreen): object {
  return screen.rows.length === 0 ? {} : Markup.inlineKeyboard(screen.rows.map((row) => row.map((button) => Markup.button.callback(button.label, button.data))));
}

/** The picker snapshots kept: one per picker message, the oldest dropped. */
const projectPickerSnapshotLimit = 200;

type TodoPorts = Pick<BotCore, 'bot' | 'command' | 'getState' | 'replyToThread' | 'editThreadMessage' | 'authoriseContext' | 'withThreadLocale' | 'checkIsGeneral'> & {
  getTodoRegistry: () => TodoRegistry;
  readTodoSettings: () => TodoReminderSettings;
  /** Where `settings.json` lives (the config directory of the instance's real env file). */
  getSettingsPath: () => string;
  listTodoProjects: () => Promise<TodoProject[]>;
  /** How a conversation is named on a board and in the picker. */
  getConversationLabel: (conversationKey: string) => string;
  /** Whether a conversation's session sleeps (no live process). */
  checkIsConversationAsleep: (conversationKey: string) => boolean;
};

export function createTodo(ports: TodoPorts) {
  const {
    bot, command, getState, replyToThread, editThreadMessage, authoriseContext, withThreadLocale, checkIsGeneral,
    getTodoRegistry, readTodoSettings, getSettingsPath, listTodoProjects, getConversationLabel, checkIsConversationAsleep,
  } = ports;
  /** Per picker message: the join candidates its indexes point at (the topic list changes under an old keyboard). */
  const pickerSnapshots = new Map<string, string[]>();

  /** The name a topic's view is titled with: its topic name when the bot knows it, else its folder. */
  function getTopicLabel(key: SessionKey): string {
    return getTopicNameOrFolder(getState().getBinding(key)) ?? key.thread;
  }

  /** `key`'s project as the topic view and the picker show it. */
  async function getProjectState(key: SessionKey): Promise<TodoProjectState> {
    const projects = await listTodoProjects();
    const conversationKey = keyToString(key);
    const project = projects.find((candidate) => candidate.memberKeys.includes(conversationKey));
    const candidates = projects
      .flatMap((candidate) => candidate.memberKeys)
      .filter((memberKey) => memberKey !== conversationKey && tryKeyFromString(memberKey)?.platform === key.platform)
      .map((memberKey) => ({ conversationKey: memberKey, label: getConversationLabel(memberKey) }))
      .sort((left, right) => left.label.localeCompare(right.label));
    return {
      name: project?.name ?? getTopicLabel(key),
      memberCount: project?.memberKeys.length ?? 1,
      override: getState().getTodoProjectOverrides()[conversationKey] ?? null,
      candidates,
    };
  }

  /** The topic's list view with its project line and button (re-rendered in place from the picker's «Back»). */
  async function buildTopicListScreen(key: SessionKey): Promise<TodoScreen> {
    const project = await getProjectState(key);
    return withThreadLocale(key, () => {
      const view = getTodoListView(getTodoRegistry().getTopic(key).items, Date.now(), todoViewDoneDayCount);
      const disabledNote = readTodoSettings().isEnabled ? '' : `\n\n${t('todo.disabledNote')}`;
      return {
        text: `${renderTodoTopicView(view, getTopicLabel(key))}\n\n${formatTodoProjectLine(project)}${disabledNote}`,
        rows: [[{ label: t('todo.projectButton'), data: todoProjectPickerCallback }]],
      };
    });
  }

  /** Every project with its members, for the General board. */
  async function buildGeneralScreen(key: SessionKey): Promise<TodoScreen> {
    const projects = await listTodoProjects();
    const boardProjects = projects
      .map((project) => ({
        name: project.name,
        members: project.memberKeys.flatMap((memberKey) => {
          const memberSessionKey = tryKeyFromString(memberKey);
          if (memberSessionKey === null) return [];
          const view = getTodoListView(getTodoRegistry().getTopic(memberSessionKey).items, Date.now());
          return [{ label: getConversationLabel(memberKey), isAsleep: checkIsConversationAsleep(memberKey), inWorkTitles: view.inWork.map((item) => item.title), queueCount: view.queue.length }];
        }),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    return withThreadLocale(key, () => renderTodoGeneralScreen(readTodoSettings(), boardProjects));
  }

  async function showTopicList(key: SessionKey): Promise<void> {
    if (getState().getBinding(key) === null) {
      await replyToThread(key, t('thread.bind_required'));
      return;
    }
    const screen = await buildTopicListScreen(key);
    await replyToThread(key, screen.text, buildTodoKeyboard(screen));
  }

  /** Re-render the message a tap came from with `screen`. */
  async function rerender(ctx: Context, key: SessionKey, screen: TodoScreen): Promise<void> {
    const messageId = getCallbackMessageId(ctx);
    if (messageId === null) return;
    await editThreadMessage(key, messageId, screen.text, buildTodoKeyboard(screen));
  }

  /** Render `key`'s picker on page `page` into the tapped message, and remember the candidates its buttons point at. */
  async function showProjectPicker(ctx: Context, key: SessionKey, page: number): Promise<void> {
    const messageId = getCallbackMessageId(ctx);
    if (messageId === null) return;
    const project = await getProjectState(key);
    rememberBoundedSnapshot(pickerSnapshots, buildMessageSnapshotKey(key, messageId), project.candidates.map((candidate) => candidate.conversationKey), projectPickerSnapshotLimit);
    await rerender(ctx, key, withThreadLocale(key, () => renderTodoProjectPicker(getTopicLabel(key), project, page)));
  }

  /** A tap in a topic's view or picker: the topic, `null` when refused (already answered). */
  async function authoriseTopicTap(ctx: Context): Promise<SessionKey | null> {
    const key = await authoriseContext(ctx);
    if (!key) {
      await answerCallbackQuerySafely(ctx, t('cb.access_denied'));
      return null;
    }
    if (checkIsGeneral(key) || getState().getBinding(key) === null) {
      await answerCallbackQuerySafely(ctx, withThreadLocale(key, () => t('thread.bind_required')));
      return null;
    }
    return key;
  }

  async function handleProjectChoice(ctx: Context, override: TodoProjectOverride | null): Promise<void> {
    const key = await authoriseTopicTap(ctx);
    if (key === null) return;
    await getState().setTodoProjectOverride(key, override);
    const project = await getProjectState(key);
    await answerCallbackQuerySafely(ctx, withThreadLocale(key, () => t('todo.projectSavedToast', { name: project.name })));
    await showProjectPicker(ctx, key, 0);
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
    await rerender(ctx, key, withThreadLocale(key, () => renderTodoSettingsScreen(readTodoSettings())));
  }

  function registerTodoCommands(): void {
    command('todo', async (_ctx, key) => {
      if (checkIsGeneral(key)) {
        const screen = await buildGeneralScreen(key);
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
      await rerender(ctx, key, withThreadLocale(key, () => renderTodoSettingsScreen(readTodoSettings())));
    });

    bot.action(todoGeneralCallback, async (ctx) => {
      const key = await authoriseGeneralTap(ctx);
      if (key === null) return;
      await answerCallbackQuerySafely(ctx);
      await rerender(ctx, key, await buildGeneralScreen(key));
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

    bot.action(todoProjectPickerCallback, async (ctx) => {
      const key = await authoriseTopicTap(ctx);
      if (key === null) return;
      await answerCallbackQuerySafely(ctx);
      await showProjectPicker(ctx, key, 0);
    });

    bot.action(todoProjectPageCallbackRe, async (ctx) => {
      const key = await authoriseTopicTap(ctx);
      if (key === null) return;
      await answerCallbackQuerySafely(ctx);
      await showProjectPicker(ctx, key, Number(ctx.match[1]));
    });

    bot.action(todoListCallback, async (ctx) => {
      const key = await authoriseTopicTap(ctx);
      if (key === null) return;
      await answerCallbackQuerySafely(ctx);
      await rerender(ctx, key, await buildTopicListScreen(key));
    });

    bot.action(todoProjectAutomaticCallback, (ctx) => handleProjectChoice(ctx, null));
    bot.action(todoProjectOwnCallback, (ctx) => handleProjectChoice(ctx, { kind: 'own' }));

    bot.action(todoProjectJoinCallbackRe, async (ctx) => {
      const key = await authoriseTopicTap(ctx);
      if (key === null) return;
      const messageId = getCallbackMessageId(ctx);
      const snapshot = messageId === null ? undefined : pickerSnapshots.get(buildMessageSnapshotKey(key, messageId));
      const conversationKey = snapshot?.[Number(ctx.match[1])];
      const target = conversationKey === undefined ? null : tryKeyFromString(conversationKey);
      // A keyboard whose list is gone (a restart, a newer picker) never joins a neighbour of the one printed on it,
      // and a topic unbound meanwhile is no project to join.
      if (conversationKey === undefined || target === null || getState().getBinding(target) === null) {
        await answerCallbackQuerySafely(ctx, withThreadLocale(key, () => t('todo.pickerStale')));
        if (messageId !== null) await showProjectPicker(ctx, key, 0);
        return;
      }
      await getState().setTodoProjectOverride(key, { kind: 'join', conversationKey });
      const project = await getProjectState(key);
      await answerCallbackQuerySafely(ctx, withThreadLocale(key, () => t('todo.projectSavedToast', { name: project.name })));
      await showProjectPicker(ctx, key, 0);
    });
  }

  return { registerTodoCommands, registerTodoCallbacks };
}
