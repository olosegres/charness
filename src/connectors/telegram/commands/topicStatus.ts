/**
 * `/topic_status` — the status mark at the end of topic names (`utils/topicIndicatorPlan.ts`, applied by `topicIndicator.ts`): which
 * marks and counts show. In General it sets the instance default (`settings.json` `topicStatus`, only the switches that differ from the
 * defaults) and lists the topics whose own name the bot does not know yet — one tap names each; in a topic it sets that topic's own set
 * (`state.json`) or «as General». One message, re-rendered in place on every tap (a tap carries the switch and its new value, so a stale
 * keyboard means exactly what it says). See README.md in this folder.
 */
import { Markup, type Context } from 'telegraf';
import type { SessionKey } from '../../../sessionKey';
import { t } from '../../../i18n';
import { saveInstanceSettingsChange } from '../../../instanceSettings';
import {
  defaultTopicStatusPrefs,
  resolveTopicStatusPrefs,
  topicIndicatorSwitches,
  type TopicStatusPrefs,
} from '../../../utils/topicIndicatorPlan';
import {
  applyTopicStatusTap,
  buildTopicStatusGeneralScreen,
  buildTopicStatusTopicScreen,
  parseTopicStatusCallback,
  topicStatusCallbackRe,
  type TopicStatusCallback,
  type TopicStatusScreen,
  type TopicStatusUnknownNameTopic,
} from '../../../utils/topicStatusPlan';
import { getTelegramChatId, getTelegramThreadId, makeTelegramKey } from '../sessionKeyCodec';
import type { TopicIndicatorHealth } from '../topicIndicator';
import type { BotCore } from './botCore';
import { getCallbackMessageId } from './callbackMessage';
import { answerCallbackWithFittedText } from './callbackToast';

/** What the module needs from the bot: the shared core and what only the composition root knows. */
export interface TopicStatusPorts extends Pick<BotCore, 'bot' | 'command' | 'getState' | 'replyToThread' | 'editThreadMessage' | 'authoriseContext' | 'withThreadLocale' | 'checkIsGeneral'> {
  /** The switches `settings.json` names (those that differ from the defaults); `{}` when it names none. */
  readInstanceTopicStatus: () => Partial<TopicStatusPrefs>;
  /** Where `settings.json` lives (the config directory of the instance's real env file). */
  getSettingsPath: () => string;
  /** How the marks stand in the key's chat: the right to rename refused, the bot's own «renamed» lines that stay. */
  getHealth: (key: SessionKey) => TopicIndicatorHealth;
  /** What a topic's name shows changed: one topic's (`key`) or every topic's (`null`) — look at it now, the change being the owner's. */
  noteTopicStatusChanged: (key: SessionKey | null) => void;
}

/**
 * @description Build the `/topic_status` screen over its ports: the command and its buttons. A tap writes the choice and re-renders the
 * picker (a repeated-use one, like `/compact_summary`).
 */
export function createTopicStatus(ports: TopicStatusPorts) {
  const { bot, command, getState, replyToThread, editThreadMessage, authoriseContext, withThreadLocale, checkIsGeneral, readInstanceTopicStatus, getSettingsPath, getHealth, noteTopicStatusChanged } = ports;

  /** The switches in force for a topic: its own set, else the instance's over the defaults. */
  function getTopicPrefs(key: SessionKey): { prefs: TopicStatusPrefs; isOwnSet: boolean } {
    const own = getState().getTopicStatusOverride(key);
    return { prefs: resolveTopicStatusPrefs(readInstanceTopicStatus(), own), isOwnSet: own !== undefined };
  }

  /** The bound topics of `generalKey`'s chat whose own name the bot does not know, with the name each was created with when it is known. */
  function listUnknownNameTopics(generalKey: SessionKey): TopicStatusUnknownNameTopic[] {
    const chatId = getTelegramChatId(generalKey);
    return getState().listBindings()
      .filter(({ key, data }) => getTelegramChatId(key) === chatId && data.topicName === undefined)
      .map(({ key, data }) => ({ threadId: getTelegramThreadId(key), candidate: data.topicNameCandidate }));
  }

  /** The screen of `key`'s topic (or General), worded in its language. A dropped mark of the owner's is told here once, then forgotten. */
  async function buildScreen(key: SessionKey): Promise<TopicStatusScreen> {
    if (checkIsGeneral(key)) {
      const { isRenameRefused } = getHealth(key);
      return withThreadLocale(key, () => buildTopicStatusGeneralScreen({
        prefs: resolveTopicStatusPrefs(readInstanceTopicStatus(), undefined),
        unknownNameTopics: listUnknownNameTopics(key),
        isRenameRefused,
      }));
    }
    const binding = getState().getBinding(key);
    const { prefs, isOwnSet } = getTopicPrefs(key);
    const health = getHealth(key);
    const screen = withThreadLocale(key, () => buildTopicStatusTopicScreen({
      prefs,
      isOwnSet,
      isBound: binding !== null,
      base: binding?.topicName,
      candidate: binding?.topicNameCandidate,
      threadId: getTelegramThreadId(key),
      isRenameRefused: health.isRenameRefused,
      isLineDeletionRefused: health.isLineDeletionRefused,
      droppedMark: binding?.indicatorDroppedMark,
    }));
    if (binding?.indicatorDroppedMark !== undefined) await getState().setBindingTopicNaming(key, { indicatorDroppedMark: null });
    return screen;
  }

  function toExtra(screen: TopicStatusScreen): object {
    return Markup.inlineKeyboard(screen.keyboard.map((row) => row.map((button) => Markup.button.callback(button.label, button.callbackData))));
  }

  /**
   * Write a tap on the switches: General's goes to the instance (`settings.json`, only what differs from the defaults), a topic's is
   * its own whole set (copied from the set it followed before the tap) or, for «as General», none. Resolves the errno code of a
   * settings file that could not be written, else `null`.
   */
  async function applySwitchTap(key: SessionKey, tap: TopicStatusCallback): Promise<string | null> {
    if (checkIsGeneral(key)) {
      if (tap.kind === 'sameAsGeneral') return null;
      const next = applyTopicStatusTap(resolveTopicStatusPrefs(readInstanceTopicStatus(), undefined), tap);
      const changed = Object.fromEntries(topicIndicatorSwitches.filter((name) => next[name] !== defaultTopicStatusPrefs[name]).map((name) => [name, next[name]]));
      const code = saveInstanceSettingsChange(getSettingsPath(), { topicStatus: changed });
      if (code === null) noteTopicStatusChanged(null);
      return code;
    }
    if (tap.kind === 'sameAsGeneral') {
      await getState().setTopicStatusOverride(key, null);
    } else {
      await getState().setTopicStatusOverride(key, applyTopicStatusTap(getTopicPrefs(key).prefs, tap));
    }
    noteTopicStatusChanged(key);
    return null;
  }

  /** «Yes, that's its name»: the topic's candidate becomes its own name (the one the topic shows now), and its mark is looked at at once. Resolves whether it was applied. */
  async function confirmTopicName(key: SessionKey, threadId: number): Promise<boolean> {
    const topicKey = makeTelegramKey(getTelegramChatId(key), threadId);
    const binding = getState().getBinding(topicKey);
    if (!binding || binding.topicName !== undefined || binding.topicNameCandidate === undefined) return false;
    const name = binding.topicNameCandidate;
    await getState().setBindingTopicNaming(topicKey, { topicName: name, topicNameCandidate: null, indicatorAppliedName: name });
    noteTopicStatusChanged(topicKey);
    return true;
  }

  /** A tap: apply what it says to the topic it was tapped in (or General), answer with a toast, re-render the picker. */
  async function handleTopicStatusTap(ctx: Context, tap: TopicStatusCallback | null): Promise<void> {
    const key = await authoriseContext(ctx);
    if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
    if (tap === null) { await answerCallbackWithFittedText(ctx, withThreadLocale(key, () => t('topicStatus.staleToast'))); return; }
    if (tap.kind === 'confirmName') {
      const isConfirmed = await confirmTopicName(key, tap.threadId);
      await answerCallbackWithFittedText(ctx, withThreadLocale(key, () => t(isConfirmed ? 'topicStatus.savedToast' : 'topicStatus.staleToast')));
    } else {
      const code = await applySwitchTap(key, tap);
      if (code !== null) {
        await answerCallbackWithFittedText(ctx, withThreadLocale(key, () => t('update.cmd.writeFailed', { path: getSettingsPath(), code })));
        return;
      }
      await answerCallbackWithFittedText(ctx, withThreadLocale(key, () => t('topicStatus.savedToast')));
    }
    const messageId = getCallbackMessageId(ctx);
    if (messageId === null) return;
    const screen = await buildScreen(key);
    await editThreadMessage(key, messageId, screen.text, toExtra(screen));
  }

  function registerTopicStatusCommands(): void {
    // `/topic_status` — in General the instance default, in a topic that topic's own set. Not gated on an adapter or a session: the marks
    // follow the agent's state whenever it has one. Bare opens the picker.
    command('topic_status', async (_ctx, key) => {
      const screen = await buildScreen(key);
      await replyToThread(key, screen.text, toExtra(screen));
    });
  }

  function registerTopicStatusCallbacks(): void {
    bot.action(topicStatusCallbackRe, async (ctx) => {
      await handleTopicStatusTap(ctx, parseTopicStatusCallback(ctx.match[0]));
    });
  }

  return { registerTopicStatusCommands, registerTopicStatusCallbacks };
}
