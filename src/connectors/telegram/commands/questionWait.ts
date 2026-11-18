/**
 * `/question_wait` — how long the agent's unanswered question waits before the agent is told to go on without it
 * (`utils/questionWaitPlan.ts`; the set-aside itself is `questionSetAside.ts`). In General it sets the instance default
 * (`settings.json` `questionWait`), in a topic that topic's own choice or «as in General» (`state.json`). One message, re-rendered in
 * place on every tap (the choice is the button's own data, so a keyboard that has gone stale still means exactly what it says). See
 * README.md in this folder.
 */
import { Markup, type Context } from 'telegraf';
import type { SessionKey } from '../../../sessionKey';
import { t } from '../../../i18n';
import { saveInstanceSettingsChange } from '../../../instanceSettings';
import { questionWaitChoices, type QuestionWaitChoice } from '../../../utils/questionWaitChoices';
import { resolveQuestionWait } from '../../../utils/questionWaitPlan';
import type { BotCore } from './botCore';
import { getCallbackMessageId } from './callbackMessage';
import { answerCallbackWithFittedText } from './callbackToast';

/** The picker's buttons: `qw_<choice>` for a wait, `qw_same` for «as in General» (a topic only). */
const questionWaitCallbackPrefix = 'qw_';
const sameAsGeneralChoice = 'same';
const callbackRe = new RegExp(`^${questionWaitCallbackPrefix}(${[...questionWaitChoices, sameAsGeneralChoice].join('|')})$`);

/** The waits as rows of the picker: the waits that end, then the one that never does. */
const choiceRows: QuestionWaitChoice[][] = [['dontWait', 'tenMinutes', 'thirtyMinutes', 'oneHour'], ['untilAnswered']];

/** What the module needs from the bot: the shared core and what only the composition root knows. */
export interface QuestionWaitPorts extends Pick<BotCore, 'bot' | 'command' | 'getState' | 'replyToThread' | 'editThreadMessage' | 'authoriseContext' | 'withThreadLocale' | 'checkIsGeneral'> {
  /** The instance's wait as `settings.json` holds it; `null` when the file says nothing (the built-in default then applies). */
  readInstanceQuestionWait: () => QuestionWaitChoice | null;
  /** Where `settings.json` lives (the config directory of the instance's real env file). */
  getSettingsPath: () => string;
  /** The wait of one topic (`key`), or of every topic that follows the instance (`null`), changed: the questions that wait now are timed again. */
  noteQuestionWaitChanged: (key: SessionKey | null) => void;
}

/**
 * @description Build the `/question_wait` screen over its ports: the command and its buttons. A tap writes the choice and re-renders
 * the picker (a repeated-use one, like `/compact_summary`), the ✓ following the value in force.
 */
export function createQuestionWait(ports: QuestionWaitPorts) {
  const { bot, command, getState, replyToThread, editThreadMessage, authoriseContext, withThreadLocale, checkIsGeneral, readInstanceQuestionWait, getSettingsPath, noteQuestionWaitChanged } = ports;

  const getChoiceName = (choice: QuestionWaitChoice): string => t(`questionWait.${choice}`);

  /** The wait every topic without a choice of its own has: the instance value, else the built-in default. */
  const getInstanceChoice = (): QuestionWaitChoice => resolveQuestionWait(undefined, readInstanceQuestionWait() ?? undefined);

  /** The value in force as the title and the toast name it: a topic that follows General says so, with General's. */
  function getValueText(key: SessionKey, isGeneral: boolean): string {
    const own = isGeneral ? undefined : getState().getQuestionWaitOverride(key);
    if (own !== undefined) return getChoiceName(own);
    return isGeneral ? getChoiceName(getInstanceChoice()) : t('questionWait.valueAsGeneral', { value: getChoiceName(getInstanceChoice()) });
  }

  /** The screen of `key`'s topic, worded in its language: the value in force, what the wait is for, and the buttons — the current choice marked ✓. */
  function buildScreen(key: SessionKey, isGeneral: boolean): { text: string; extra: object } {
    return withThreadLocale(key, () => {
      const instanceChoice = getInstanceChoice();
      const own = isGeneral ? undefined : getState().getQuestionWaitOverride(key);
      const current = isGeneral ? instanceChoice : own;
      const title = t(isGeneral ? 'questionWait.titleGeneral' : 'questionWait.titleTopic', { value: getValueText(key, isGeneral) });
      const text = [title, t('questionWait.explanationText'), ...(isGeneral ? [t('questionWait.generalScopeNote')] : [])].join('\n\n');
      const rows = choiceRows.map((row) => row.map((choice) => Markup.button.callback(`${getChoiceName(choice)}${choice === current ? ' ✓' : ''}`, `${questionWaitCallbackPrefix}${choice}`)));
      if (!isGeneral) {
        rows.push([Markup.button.callback(`${t('questionWait.sameAsGeneralButton', { value: getChoiceName(instanceChoice) })}${own === undefined ? ' ✓' : ''}`, `${questionWaitCallbackPrefix}${sameAsGeneralChoice}`)]);
      }
      return { text, extra: Markup.inlineKeyboard(rows) };
    });
  }

  /**
   * Write a choice: General's goes to the instance (`settings.json`), a topic's is its own (`null`: it follows General again).
   * Resolves the errno code of a settings file that could not be written, else `null`. «As in General» means nothing in General.
   */
  async function applyChoice(key: SessionKey, isGeneral: boolean, choice: QuestionWaitChoice | null): Promise<string | null> {
    if (isGeneral) {
      if (choice === null) return null;
      const code = saveInstanceSettingsChange(getSettingsPath(), { questionWait: choice });
      if (code === null) noteQuestionWaitChanged(null);
      return code;
    }
    await getState().setQuestionWaitOverride(key, choice);
    noteQuestionWaitChanged(key);
    return null;
  }

  /** A tap: apply the choice it names to the topic it was tapped in (or General), answer with the value now in force, re-render the picker. */
  async function handleQuestionWaitTap(ctx: Context, choice: QuestionWaitChoice | null): Promise<void> {
    const key = await authoriseContext(ctx);
    if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
    const isGeneral = checkIsGeneral(key);
    const code = await applyChoice(key, isGeneral, choice);
    if (code !== null) {
      await answerCallbackWithFittedText(ctx, withThreadLocale(key, () => t('update.cmd.writeFailed', { path: getSettingsPath(), code })));
      return;
    }
    await answerCallbackWithFittedText(ctx, withThreadLocale(key, () => t('questionWait.appliedToast', { value: getValueText(key, isGeneral) })));
    const messageId = getCallbackMessageId(ctx);
    if (messageId === null) return;
    const screen = buildScreen(key, isGeneral);
    await editThreadMessage(key, messageId, screen.text, screen.extra);
  }

  function registerQuestionWaitCommands(): void {
    // `/question_wait` — in General the instance default, in a topic that topic's own choice. Not gated on an adapter or a session: the
    // choice is read when the agent next asks a question, and applied to a question that waits now. Bare opens the picker.
    command('question_wait', async (_ctx, key) => {
      const screen = buildScreen(key, checkIsGeneral(key));
      await replyToThread(key, screen.text, screen.extra);
    });
  }

  function registerQuestionWaitCallbacks(): void {
    bot.action(callbackRe, async (ctx) => {
      const name = ctx.match[1];
      const choice = questionWaitChoices.find((candidate) => candidate === name) ?? null;
      await handleQuestionWaitTap(ctx, choice);
    });
  }

  return { registerQuestionWaitCommands, registerQuestionWaitCallbacks };
}
