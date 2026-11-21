/**
 * `/limits_reminders` (hidden alias `/limit_reminders`) — how often an agent that launches workers is told where the accounts' limits
 * stand (`limitNotes/`): every 1 h (default) / 2 h / 4 h / Off. In General it sets the instance value (`settings.json`
 * `limitReminders.everyMinutes`; a Jira conversation follows it), in a topic that topic's own choice or «as in General»
 * (`state.json`). A ONE-SHOT picker, like `/bot_skills`: a tap writes the choice and edits the picker into its confirmation, dropping
 * the buttons. The screens are `utils/limitRemindersScreenPlan.ts`; the `/limits` board's row opens the same picker. See README.md in
 * this folder.
 */
import { Markup, type Context } from 'telegraf';
import type { SessionKey } from '../../../sessionKey';
import { t } from '../../../i18n';
import { saveInstanceSettingsChange } from '../../../instanceSettings';
import type { LimitReminderChoice } from '../../../limitNotes/reminderChoices';
import {
  buildLimitRemindersConfirmation,
  buildLimitRemindersRowLabel,
  buildLimitRemindersScreen,
  limitRemindersCallbackRe,
  parseLimitRemindersCallbackData,
  type LimitRemindersPick,
} from '../../../utils/limitRemindersScreenPlan';
import type { BotCore } from './botCore';
import { getCallbackMessageId } from './callbackMessage';
import { answerCallbackWithFittedText } from './callbackToast';

/** What the module needs from the bot: the shared core and what only the composition root knows. */
export interface LimitRemindersPorts extends Pick<BotCore, 'bot' | 'command' | 'getState' | 'replyToThread' | 'editThreadMessage' | 'authoriseContext' | 'withThreadLocale' | 'checkIsGeneral'> {
  /** The instance's interval as `settings.json` holds it; `null` when the file says nothing (the built-in default then applies). */
  readInstanceLimitReminders: () => LimitReminderChoice | null;
  /** Where `settings.json` lives (the config directory of the instance's real env file). */
  getSettingsPath: () => string;
}

/**
 * @description Build the `/limits_reminders` screen over its ports: the command, its buttons, the opener the `/limits` board's row
 * calls and the label of that row.
 */
export function createLimitReminders(ports: LimitRemindersPorts) {
  const { bot, command, getState, replyToThread, editThreadMessage, authoriseContext, withThreadLocale, checkIsGeneral, readInstanceLimitReminders, getSettingsPath } = ports;

  /** What the screens of `key`'s scope are built from: where it is opened and what is stored now. */
  function readScope(key: SessionKey, isGeneral: boolean): { isGeneral: boolean; generalChoice: LimitReminderChoice | null; ownChoice: LimitReminderChoice | undefined } {
    return { isGeneral, generalChoice: readInstanceLimitReminders(), ownChoice: isGeneral ? undefined : getState().getLimitRemindersOverride(key) };
  }

  function buildKeyboard(rows: ReturnType<typeof buildLimitRemindersScreen>['rows']) {
    return Markup.inlineKeyboard(rows.map((row) => row.map((button) => Markup.button.callback(button.label, button.data))));
  }

  /** The picker as a fresh message in `key`'s topic, worded in its language. */
  async function openPicker(key: SessionKey): Promise<void> {
    await withThreadLocale(key, async () => {
      const screen = buildLimitRemindersScreen(readScope(key, checkIsGeneral(key)));
      await replyToThread(key, screen.text, buildKeyboard(screen.rows));
    });
  }

  /** The `/limits` row's label for `key`'s scope: `🔔 Reminders: every 1 h` (the value in force). Read under the topic's locale. */
  function getRowLabel(key: SessionKey): string {
    return withThreadLocale(key, () => buildLimitRemindersRowLabel(readScope(key, checkIsGeneral(key))));
  }

  /**
   * Write a pick: General's goes to the instance (`settings.json`), a topic's is its own (`general`: it follows General again).
   * Resolves the errno code of a settings file that could not be written, else `null`. «As in General» means nothing in General.
   */
  async function applyPick(key: SessionKey, isGeneral: boolean, pick: LimitRemindersPick): Promise<string | null> {
    if (isGeneral) {
      if (pick === 'general') return null;
      return saveInstanceSettingsChange(getSettingsPath(), { limitReminders: { everyMinutes: pick } });
    }
    await getState().setLimitRemindersOverride(key, pick === 'general' ? null : pick);
    return null;
  }

  /** A tap: apply the pick to the tapped topic (or General), then turn the picker into the confirmation — the keyboard is consumed. */
  async function handleTap(ctx: Context, pick: LimitRemindersPick): Promise<void> {
    const key = await authoriseContext(ctx);
    if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
    const isGeneral = checkIsGeneral(key);
    const code = await applyPick(key, isGeneral, pick);
    if (code !== null) {
      await answerCallbackWithFittedText(ctx, withThreadLocale(key, () => t('update.cmd.writeFailed', { path: getSettingsPath(), code })));
      return;
    }
    await ctx.answerCbQuery();
    await withThreadLocale(key, async () => {
      const confirmation = buildLimitRemindersConfirmation({ ...readScope(key, isGeneral), pick });
      const messageId = getCallbackMessageId(ctx);
      if (messageId === null) await replyToThread(key, confirmation);
      else if (!(await editThreadMessage(key, messageId, confirmation))) console.warn('[lrm_cb] picker relabel failed');
    });
  }

  function registerLimitRemindersCommands(): void {
    // `/limits_reminders` — in General the instance value, in a topic that topic's own choice. Not gated on an adapter or a session: the
    // choice is read when a note is next due. Bare opens the one-shot picker.
    command(['limits_reminders', 'limit_reminders'], async (_ctx, key) => {
      await openPicker(key);
    });
  }

  function registerLimitRemindersCallbacks(): void {
    bot.action(limitRemindersCallbackRe, async (ctx) => {
      const pick = parseLimitRemindersCallbackData(ctx.match[0]);
      if (pick === null) return;
      await handleTap(ctx, pick);
    });
  }

  return { registerLimitRemindersCommands, registerLimitRemindersCallbacks, openPicker, getRowLabel };
}
