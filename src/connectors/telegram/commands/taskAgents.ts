/**
 * The cap on tracker task agents (`/task_agents`) — how many tracker conversations may work on a hand-over at once, for the
 * WHOLE bot. One value, so it is read everywhere and changed in General only: a number from the picker or typed after the
 * command. See `trackers/taskAgentLimit.ts` for the precedence and `trackers/taskAgentSlots.ts` for what the cap does.
 */
import { Markup, type Context } from 'telegraf';
import { t } from '../../../i18n';
import {
  parseTaskAgentLimitArgument,
  taskAgentsMaxConcurrentUpperBound,
  taskAgentsNoLimit,
  taskAgentsPickerValues,
  type TaskAgentLimit,
  type TaskAgentLimitSource,
} from '../../../trackers/taskAgentLimit';
import type { TaskAgentSlotStatus } from '../../../trackers/taskAgentSlots';
import type { BotCore } from './botCore';
import { getCallbackMessageId } from './callbackMessage';

/** The picker's buttons: `tka_<number>`, `tka_0` for «no limit» — the value itself, so an old keyboard can only set a number it shows. */
const taskAgentsCallbackPrefix = 'tka_';
/** Picker buttons per row. */
const pickerButtonsPerRow = 3;

/** What the module needs from the bot: the shared core and the readings and the signal only the composition root has. */
export interface TaskAgentsPorts
  extends Pick<BotCore, 'bot' | 'command' | 'getState' | 'replyToThread' | 'editThreadMessage' | 'authoriseContext' | 'withThreadLocale' | 'checkIsGeneral'> {
  /** The cap in force and the layer it comes from (General's own value, `settings.json`'s seed, the built-in default). */
  readTaskAgentLimit: () => TaskAgentLimit;
  /** Told after General's value was written: the cap may have gone up, which starts the waiting issues at once. */
  noteTaskAgentLimitChanged: () => void;
  /** The slots in use and the places waiting; `null` while this instance serves no tracker, where the cap decides nothing. */
  readTaskAgentStatus: () => TaskAgentSlotStatus | null;
}

/**
 * @description Build the «Task agents» screen over its ports: `/task_agents` and its picker. In General the picker sets the cap
 * (a one-shot picker: a tap edits it into its confirmation) and the typed `/task_agents <number>` sets any other number; in a
 * topic the screen only reports the value in force and where to change it.
 */
export function createTaskAgents(ports: TaskAgentsPorts) {
  const { bot, command, getState, replyToThread, editThreadMessage, authoriseContext, withThreadLocale, checkIsGeneral, readTaskAgentLimit, readTaskAgentStatus, noteTaskAgentLimitChanged } = ports;

  const sourceKeys: Record<TaskAgentLimitSource, string> = {
    general: 'taskAgents.sourceGeneral',
    settingsFile: 'taskAgents.sourceSettingsFile',
    builtInDefault: 'taskAgents.sourceBuiltIn',
  };

  const formatLimit = (maxConcurrent: number): string => (maxConcurrent === taskAgentsNoLimit ? t('taskAgents.noLimitValue') : maxConcurrent.toString());

  /** The screen's text: the value in force and where it comes from, what it limits, the slots now, and how to change it. */
  function buildScreenText(isGeneral: boolean): string {
    const limit = readTaskAgentLimit();
    const status = readTaskAgentStatus();
    return [
      t('taskAgents.title', { value: formatLimit(limit.maxConcurrent), source: t(sourceKeys[limit.source]) }),
      t('taskAgents.explanationText'),
      ...(status === null ? [] : [t('taskAgents.statusText', { running: status.runningCount.toString(), waiting: status.waitingCount.toString() })]),
      isGeneral ? t('taskAgents.manualEntryText') : t('taskAgents.topicNote'),
    ].join('\n\n');
  }

  /** The picker's numbers and «No limit», the one in force marked ✓ (a number typed by hand is on no button, so none is marked). */
  function buildKeyboard() {
    const { maxConcurrent } = readTaskAgentLimit();
    const mark = (value: number): string => (value === maxConcurrent ? ' ✓' : '');
    const buttons = [
      ...taskAgentsPickerValues.map((value) => Markup.button.callback(`${value}${mark(value)}`, `${taskAgentsCallbackPrefix}${value}`)),
      Markup.button.callback(`${t('taskAgents.noLimitButton')}${mark(taskAgentsNoLimit)}`, `${taskAgentsCallbackPrefix}${taskAgentsNoLimit}`),
    ];
    const rows: ReturnType<typeof Markup.button.callback>[][] = [];
    for (let start = 0; start < buttons.length; start += pickerButtonsPerRow) rows.push(buttons.slice(start, start + pickerButtonsPerRow));
    return Markup.inlineKeyboard(rows);
  }

  /** Write General's value and RETURN the confirmation — the one write path behind the typed number and the buttons. */
  async function applyTaskAgentsLimit(maxConcurrent: number): Promise<string> {
    await getState().setTaskAgentsMaxConcurrentGlobalValue(maxConcurrent);
    noteTaskAgentLimitChanged();
    return t('taskAgents.setConfirmation', { value: formatLimit(maxConcurrent) });
  }

  /** A tap: set the cap, then turn the picker into the confirmation. */
  async function handleTaskAgentsCallback(ctx: Context, maxConcurrent: number): Promise<void> {
    const key = await authoriseContext(ctx);
    if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
    await ctx.answerCbQuery();
    await withThreadLocale(key, async () => {
      // The picker only ever stands in General, but a tap is checked where it lands.
      const text = checkIsGeneral(key) ? await applyTaskAgentsLimit(maxConcurrent) : t('taskAgents.generalOnlyText');
      const messageId = getCallbackMessageId(ctx);
      if (messageId === null) await replyToThread(key, text);
      else if (!(await editThreadMessage(key, messageId, text))) console.warn('[tka_cb] picker relabel failed');
    });
  }

  function registerTaskAgentsCommands(): void {
    // `/task_agents` — in General the picker, or the number typed after it (`0` / `off` = no limit); anywhere else the value
    // in force and where to change it. Not gated on an adapter or a session: it is a bot setting.
    command('task_agents', async (_ctx, key, parsed) => {
      const isGeneral = checkIsGeneral(key);
      const argument = parseTaskAgentLimitArgument(parsed.args.join(' '));
      if (argument.kind === 'none') {
        await replyToThread(key, buildScreenText(isGeneral), isGeneral ? buildKeyboard() : undefined);
        return;
      }
      if (!isGeneral) {
        await replyToThread(key, t('taskAgents.generalOnlyText'));
        return;
      }
      await replyToThread(
        key,
        argument.kind === 'number'
          ? await applyTaskAgentsLimit(argument.value)
          : t('taskAgents.invalidArgumentText', { max: taskAgentsMaxConcurrentUpperBound.toString() }),
      );
    });
  }

  function registerTaskAgentsCallbacks(): void {
    for (const value of [...taskAgentsPickerValues, taskAgentsNoLimit]) {
      bot.action(`${taskAgentsCallbackPrefix}${value}`, (ctx) => handleTaskAgentsCallback(ctx, value));
    }
  }

  return { registerTaskAgentsCommands, registerTaskAgentsCallbacks };
}
