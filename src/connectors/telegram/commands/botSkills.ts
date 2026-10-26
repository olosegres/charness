/**
 * The «Bot skills» switch — whether the skills Charness ships with its agents (`agent-plugin/`) and the hint to load the
 * manager reach them, per topic or (in General) for the instance. See `utils/botSkills.ts` for the precedence and what OFF
 * does, and README.md in this folder.
 */
import { Markup, type Context } from 'telegraf';
import type { SessionKey } from '../../../sessionKey';
import { t } from '../../../i18n';
import type { BotSkillsReader } from '../../../utils/botSkills';
import type { BotCore } from './botCore';
import { getCallbackMessageId } from './callbackMessage';

/** The picker's buttons. */
const botSkillsOnCallback = 'bsk_on';
const botSkillsOffCallback = 'bsk_off';
const botSkillsSameAsGeneralCallback = 'bsk_same';

/** The word of `/bot_skills <word>` that hands a topic back to General's value. */
const sameAsGeneralArgument = 'general';

/** What a topic or General can choose: on, off, or (a topic only) «as in General». */
type BotSkillsChoice = boolean | null;

/** What the module needs from the bot: the shared core and the two things only the composition root knows. */
export interface BotSkillsPorts
  extends Pick<BotCore, 'bot' | 'command' | 'getState' | 'replyToThread' | 'editThreadMessage' | 'authoriseContext' | 'withThreadLocale' | 'checkIsGeneral'> {
  /** Whether the switch is on for a conversation; `null` asks for the instance value (General's, else `settings.json`'s, else ON). */
  readBotSkills: BotSkillsReader;
  /** Whether the topic's backend is OpenCode, whose one server serves every topic and so cannot hide the skills from one. */
  checkIsOpenCodeTopic: (key: SessionKey) => boolean;
}

/**
 * @description Build the «Bot skills» screen over its ports: `/bot_skills` and its three buttons. A tap writes the choice
 * and edits the picker into its confirmation (a one-shot picker, like `/language`): the menu is gone once a choice is made.
 */
export function createBotSkills(ports: BotSkillsPorts) {
  const { bot, command, getState, replyToThread, editThreadMessage, authoriseContext, withThreadLocale, checkIsGeneral, readBotSkills, checkIsOpenCodeTopic } = ports;

  const formatState = (isEnabled: boolean): string => (isEnabled ? t('botSkills.on') : t('botSkills.off'));

  /** The OpenCode topic's note: its server is shared, so this switch cannot take the listed skills away from it. */
  const getOpenCodeNote = (key: SessionKey): string[] => (checkIsOpenCodeTopic(key) ? [t('botSkills.openCodeTopicNote')] : []);

  /**
   * @description Write a choice and RETURN the confirmation — the one write path behind the typed form and the buttons.
   * General: the instance value (`null` — «as in General» — is not offered there and changes nothing). A topic: its own
   * choice, `null` drops it.
   */
  async function applyBotSkills(key: SessionKey, isGeneral: boolean, choice: BotSkillsChoice): Promise<string> {
    if (isGeneral) {
      if (choice !== null) await getState().setBotSkillsGlobalValue(choice);
      return t('botSkills.setGeneralConfirmation', { state: formatState(readBotSkills(null)) });
    }
    await getState().setBotSkillsOverride(key, choice);
    const state = formatState(readBotSkills(key));
    const confirmation = choice === null ? t('botSkills.followGeneralConfirmation', { state }) : t('botSkills.setTopicConfirmation', { state });
    return [confirmation, ...getOpenCodeNote(key)].join('\n\n');
  }

  /** The screen's text: the value in force and where it comes from, what the switch is, and for OpenCode what it cannot do. */
  function buildScreenText(key: SessionKey, isGeneral: boolean): string {
    if (isGeneral) {
      return [t('botSkills.titleGeneral', { state: formatState(readBotSkills(null)) }), t('botSkills.explanationText'), t('botSkills.generalScopeNote')].join('\n\n');
    }
    const source = getState().getBotSkillsOverride(key) === undefined ? t('botSkills.sourceGeneral') : t('botSkills.sourceTopic');
    return [t('botSkills.titleTopic', { state: formatState(readBotSkills(key)), source }), t('botSkills.explanationText'), ...getOpenCodeNote(key)].join('\n\n');
  }

  /**
   * The screen's buttons, the current choice marked ✓. General: On / Off on the instance value in force. A topic: On / Off
   * and «As in General» (with the value it would give); its mark is the topic's own choice, or «As in General» when it has none.
   */
  function buildKeyboard(key: SessionKey, isGeneral: boolean) {
    const mark = (isCurrent: boolean): string => (isCurrent ? ' ✓' : '');
    if (isGeneral) {
      const isEnabled = readBotSkills(null);
      return Markup.inlineKeyboard([[
        Markup.button.callback(`${t('botSkills.onButton')}${mark(isEnabled)}`, botSkillsOnCallback),
        Markup.button.callback(`${t('botSkills.offButton')}${mark(!isEnabled)}`, botSkillsOffCallback),
      ]]);
    }
    const own = getState().getBotSkillsOverride(key);
    return Markup.inlineKeyboard([
      [
        Markup.button.callback(`${t('botSkills.onButton')}${mark(own === true)}`, botSkillsOnCallback),
        Markup.button.callback(`${t('botSkills.offButton')}${mark(own === false)}`, botSkillsOffCallback),
      ],
      [Markup.button.callback(`${t('botSkills.sameAsGeneralButton', { state: formatState(readBotSkills(null)) })}${mark(own === undefined)}`, botSkillsSameAsGeneralCallback)],
    ]);
  }

  /** The choice a typed argument names; `undefined` for none (the screen opens), and `general` means nothing in General. */
  function parseChoice(argument: string, isGeneral: boolean): BotSkillsChoice | undefined {
    if (argument === 'on') return true;
    if (argument === 'off') return false;
    if (argument === sameAsGeneralArgument && !isGeneral) return null;
    return undefined;
  }

  /** A tap: apply the choice to the tapped topic (or General), then turn the picker into the confirmation. */
  async function handleBotSkillsCallback(ctx: Context, choice: BotSkillsChoice): Promise<void> {
    const key = await authoriseContext(ctx);
    if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
    await ctx.answerCbQuery();
    await withThreadLocale(key, async () => {
      const confirmation = await applyBotSkills(key, checkIsGeneral(key), choice);
      const messageId = getCallbackMessageId(ctx);
      if (messageId === null) await replyToThread(key, confirmation);
      else if (!(await editThreadMessage(key, messageId, confirmation))) console.warn('[bsk_cb] picker relabel failed');
    });
  }

  function registerBotSkillsCommands(): void {
    // `/bot_skills` — in General the instance value, in a topic that topic's own choice. Not gated on an adapter or a
    // session: a topic may choose before its agent starts, and the choice is read at the agent's next start. `on` / `off`
    // (and `general` in a topic) apply at once; bare opens the one-shot picker.
    command('bot_skills', async (_ctx, key, parsed) => {
      const isGeneral = checkIsGeneral(key);
      const choice = parseChoice(parsed.args.join(' ').trim().toLowerCase(), isGeneral);
      if (choice !== undefined) {
        await replyToThread(key, await applyBotSkills(key, isGeneral, choice));
        return;
      }
      await replyToThread(key, buildScreenText(key, isGeneral), buildKeyboard(key, isGeneral));
    });
  }

  function registerBotSkillsCallbacks(): void {
    bot.action(botSkillsOnCallback, (ctx) => handleBotSkillsCallback(ctx, true));
    bot.action(botSkillsOffCallback, (ctx) => handleBotSkillsCallback(ctx, false));
    bot.action(botSkillsSameAsGeneralCallback, (ctx) => handleBotSkillsCallback(ctx, null));
  }

  return { registerBotSkillsCommands, registerBotSkillsCallbacks };
}
