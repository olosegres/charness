/**
 * `/topic` — open another forum topic on a folder: the name, the folder, then the topic. See README.md in this folder.
 */
import { randomBytes } from 'node:crypto';
import { Markup, type Context } from 'telegraf';
import type { Chat } from 'telegraf/typings/core/types/typegram';
import type { SessionKey } from '../../../sessionKey';
import { keyToString } from '../../../sessionKey';
import { t } from '../../../i18n';
import { checkIsApiError, getErrorDescription } from '../../../sendErrorClassifier';
import { getTelegramChatId, makeTelegramKey } from '../sessionKeyCodec';
import { BIND_PAGE_SIZE, buildBindKeyboard, type BindPickerCallbacks } from '../bindPicker';
import { getCallbackMessageId } from './callbackMessage';
import type { BotCore } from './botCore';

/** The Bot API accepts a topic name of 1–128 characters (`createForumTopic`). */
export const topicNameMaxLength = 128;

/** In-flight wizards kept in memory, the newest; an older one's keyboard answers «out of date». */
const topicWizardLimit = 20;

/** How long a wizard stays tappable. Memory only: a restart drops every wizard, so its old keyboards expire anyway. */
const topicWizardTtlMs = 30 * 60 * 1000;

/** Bytes of randomness in a wizard id (rendered as hex, so twice as many characters in a callback). */
const topicWizardIdBytes = 3;

/** The id a private supergroup carries in the Bot API (`-100` + the id the t.me/c/ links use). */
const privateSupergroupIdPrefix = '-100';

// ── callback data: `topic_<action>_<wizard id>[_<n>]`, every id baked in, well under the 64-byte cap ──

const wizardIdPattern = '([0-9a-f]+)';

export const buildTopicSameFolderCallback = (wizardId: string): string => `topic_here_${wizardId}`;
export const topicSameFolderCallbackRe = new RegExp(`^topic_here_${wizardIdPattern}$`);
export const buildTopicOtherFolderCallback = (wizardId: string): string => `topic_other_${wizardId}`;
export const topicOtherFolderCallbackRe = new RegExp(`^topic_other_${wizardIdPattern}$`);
export const buildTopicFolderCallback = (wizardId: string, index: number): string => `topic_folder_${wizardId}_${index}`;
export const topicFolderCallbackRe = new RegExp(`^topic_folder_${wizardIdPattern}_(\\d+)$`);
export const buildTopicPageCallback = (wizardId: string, page: number): string => `topic_page_${wizardId}_${page}`;
export const topicPageCallbackRe = new RegExp(`^topic_page_${wizardIdPattern}_(\\d+)$`);
export const buildTopicCreateFolderCallback = (wizardId: string): string => `topic_create_${wizardId}`;
export const topicCreateFolderCallbackRe = new RegExp(`^topic_create_${wizardIdPattern}$`);

/** @description The picker's buttons pointing at the wizard `wizardId` instead of at the topic the keyboard sits in. */
export function buildTopicPickerCallbacks(wizardId: string): BindPickerCallbacks {
  return {
    getFolderCallback: (_subdir, index) => buildTopicFolderCallback(wizardId, index),
    getPageCallback: (page) => buildTopicPageCallback(wizardId, page),
    createFolderCallback: buildTopicCreateFolderCallback(wizardId),
  };
}

/** @description A typed topic name as the Bot API gets it: whitespace runs collapsed, the ends trimmed. */
export function normaliseTopicName(rawName: string): string {
  return rawName.replace(/\s+/g, ' ').trim();
}

/**
 * @description The link that opens a forum topic: `https://t.me/<username>/<topic id>` for a public group,
 * `https://t.me/c/<chat id without -100>/<topic id>` for a private one. The topic id is the id of the topic's creation
 * service message, so the link is the message link to it, which a client opens as the topic
 * (https://core.telegram.org/api/links, «Forum topic links»). `null` for a chat id that is no supergroup's.
 */
export function buildTopicLink(chat: { chatId: number; username: string | null }, threadId: number): string | null {
  if (chat.username) return `https://t.me/${chat.username}/${threadId}`;
  const chatIdText = chat.chatId.toString();
  if (!chatIdText.startsWith(privateSupergroupIdPrefix)) return null;
  return `https://t.me/c/${chatIdText.slice(privateSupergroupIdPrefix.length)}/${threadId}`;
}

/** @description Whether `createForumTopic` was refused for want of the `can_manage_topics` admin right. */
export function checkIsMissingTopicRightsError(error: unknown): boolean {
  return checkIsApiError(error) && /not enough rights|CHAT_ADMIN_REQUIRED|administrator/i.test(getErrorDescription(error));
}

/** What `createWorkFolder` (the `/bind` «create new folder» mkdir) made of a typed name; it has already told the topic of a refusal. */
export type WorkFolderResult = { outcome: 'invalid' } | { outcome: 'failed' } | { outcome: 'ready'; subdir: string };

export interface TopicCommandPorts extends Pick<BotCore, 'bot' | 'command' | 'getState' | 'replyToThread' | 'editThreadMessage' | 'authoriseContext'> {
  /** Whether the key is the owner's private chat — it has no topics to create. */
  checkIsDmKey: (key: SessionKey) => boolean;
  /** The `WORK_ROOT` subfolders the picker lists. */
  listAvailableSubdirs: () => string[];
  /** Validate and create the folder a user typed (what `/bind`'s «create new folder» does); reports a refusal to `key`'s topic. */
  createWorkFolder: (key: SessionKey, rawName: string) => Promise<WorkFolderResult>;
  /**
   * Bind the freshly created topic `key` to `subdir` (remembering its name) and greet it with the usual binding
   * welcome. Resolves the text saying why it could not bind, `null` once it is bound.
   */
  bindNewTopic: (key: SessionKey, subdir: string, topicName: string) => Promise<string | null>;
}

/** What the next plain message of a topic answers. */
type CaptureStep = 'topicName' | 'folderName';

/**
 * One `/topic` run. Kept in MEMORY on purpose: a restart drops an unfinished wizard (a few taps), and what it makes is a
 * real topic. `messageId` is the ONE message the folder question, the picker and the answer share.
 */
interface TopicWizard {
  id: string;
  /** The topic `/topic` ran in: its questions and its answer live there. */
  originKey: SessionKey;
  /** The group's public username (for the link), `null` for a private group. */
  chatUsername: string | null;
  name: string | null;
  /** The folder the origin topic is bound to when the question was asked; `null` in General or an unbound topic. */
  currentSubdir: string | null;
  /** The folders the picker listed: its buttons index into this list. */
  folders: string[];
  messageId: number | null;
  /** Set by the tap that starts creating the topic, so a second tap of the same keyboard makes no second topic. */
  isCreating: boolean;
  createdAtMs: number;
}

/** @description The public username of the chat an update came from, `null` for a private group (or no chat). */
export function getPublicChatUsername(chat: Chat | undefined): string | null {
  return chat && 'username' in chat && chat.username ? chat.username : null;
}

/**
 * @description Build the `/topic` feature over its ports: the command, its five buttons, and the capture of the topic
 * name and the new folder's name (the text handler asks `checkIsAwaitingTopicInput` / `submitTopicInput`; `/esc` and any
 * other command end it through `cancelTopicInput`).
 */
export function createTopicCommand(ports: TopicCommandPorts) {
  const {
    bot, command, getState, replyToThread, editThreadMessage, authoriseContext, checkIsDmKey,
    listAvailableSubdirs, createWorkFolder, bindNewTopic,
  } = ports;

  const wizards = new Map<string, TopicWizard>();
  /** Per origin topic, the one wizard whose next plain message is an answer. */
  const captures = new Map<string, { wizardId: string; step: CaptureStep }>();

  function getWizard(wizardId: string): TopicWizard | null {
    const wizard = wizards.get(wizardId);
    if (!wizard) return null;
    if (Date.now() - wizard.createdAtMs > topicWizardTtlMs) {
      forgetWizard(wizard);
      return null;
    }
    return wizard;
  }

  function forgetWizard(wizard: TopicWizard): void {
    wizards.delete(wizard.id);
    const originKeyText = keyToString(wizard.originKey);
    if (captures.get(originKeyText)?.wizardId === wizard.id) captures.delete(originKeyText);
  }

  function createWizard(originKey: SessionKey, ctx: Context): TopicWizard {
    let id = randomBytes(topicWizardIdBytes).toString('hex');
    while (wizards.has(id)) id = randomBytes(topicWizardIdBytes).toString('hex');
    const wizard: TopicWizard = {
      id, originKey, chatUsername: getPublicChatUsername(ctx.chat), name: null, currentSubdir: null, folders: [],
      messageId: null, isCreating: false, createdAtMs: Date.now(),
    };
    wizards.set(id, wizard);
    while (wizards.size > topicWizardLimit) {
      const oldest = wizards.values().next().value;
      if (oldest === undefined) break;
      forgetWizard(oldest);
    }
    return wizard;
  }

  function armCapture(wizard: TopicWizard, step: CaptureStep): void {
    captures.set(keyToString(wizard.originKey), { wizardId: wizard.id, step });
  }

  // ── the capture the text handler consults ──

  function getCapture(key: SessionKey): { wizard: TopicWizard; step: CaptureStep } | null {
    const capture = captures.get(keyToString(key));
    if (!capture) return null;
    const wizard = getWizard(capture.wizardId);
    if (!wizard) {
      captures.delete(keyToString(key));
      return null;
    }
    return { wizard, step: capture.step };
  }

  /** Whether the topic's next plain message answers the wizard (the text handler asks before forwarding it to the agent). */
  function checkIsAwaitingTopicInput(key: SessionKey): boolean {
    return getCapture(key) !== null;
  }

  /** End the topic's pending question and its wizard (`/esc`, or any other command). Returns whether one was pending. */
  function cancelTopicInput(key: SessionKey): boolean {
    const capture = getCapture(key);
    if (!capture) return false;
    forgetWizard(capture.wizard);
    return true;
  }

  /** The captured answer: the topic's name, or the new folder's. */
  async function submitTopicInput(key: SessionKey, text: string): Promise<void> {
    const capture = getCapture(key);
    if (!capture) return;
    if (capture.step === 'topicName') await acceptTopicName(capture.wizard, text);
    else await acceptFolderName(capture.wizard, text);
  }

  // ── the steps ──

  async function askTopicName(wizard: TopicWizard, problem: string | null): Promise<void> {
    armCapture(wizard, 'topicName');
    const question = [problem, t('topic.askName'), t('login.esc_hint')].filter((line) => line !== null).join('\n');
    await replyToThread(wizard.originKey, question);
  }

  async function acceptTopicName(wizard: TopicWizard, rawName: string): Promise<void> {
    const name = normaliseTopicName(rawName);
    if (name.length > topicNameMaxLength) {
      await askTopicName(wizard, t('topic.nameTooLong', { max: topicNameMaxLength }));
      return;
    }
    if (name.length === 0) {
      await askTopicName(wizard, null);
      return;
    }
    wizard.name = name;
    captures.delete(keyToString(wizard.originKey));
    await askFolder(wizard);
  }

  /** The folder question: «as here» or «other» in a bound topic, the picker at once in General or an unbound one. */
  async function askFolder(wizard: TopicWizard): Promise<void> {
    const name = wizard.name ?? '';
    wizard.currentSubdir = getState().getBinding(wizard.originKey)?.subdir ?? null;
    if (wizard.currentSubdir === null) {
      await showPicker(wizard);
      return;
    }
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback(t('topic.sameFolderButton', { subdir: wizard.currentSubdir }), buildTopicSameFolderCallback(wizard.id))],
      [Markup.button.callback(t('topic.otherFolderButton'), buildTopicOtherFolderCallback(wizard.id))],
    ]);
    wizard.messageId = await replyToThread(wizard.originKey, t('topic.askFolder', { name }), keyboard);
  }

  /** The `/bind` folder picker, pointing at the wizard: in place of the question when there is one, else as a new message. */
  async function showPicker(wizard: TopicWizard): Promise<void> {
    wizard.folders = listAvailableSubdirs();
    const keyboard = buildBindKeyboard(wizard.folders, 0, BIND_PAGE_SIZE, false, buildTopicPickerCallbacks(wizard.id));
    const text = t('topic.pickFolder', { name: wizard.name ?? '' });
    if (wizard.messageId !== null && await editThreadMessage(wizard.originKey, wizard.messageId, text, keyboard)) return;
    wizard.messageId = await replyToThread(wizard.originKey, text, keyboard);
  }

  async function acceptFolderName(wizard: TopicWizard, rawName: string): Promise<void> {
    // Claimed before the folder is made: a second message meanwhile is not a second folder name.
    captures.delete(keyToString(wizard.originKey));
    const folder = await createWorkFolder(wizard.originKey, rawName);
    // A refused name keeps the question open (the refusal was told); a failed mkdir ends the wizard.
    if (folder.outcome === 'invalid') {
      armCapture(wizard, 'folderName');
      return;
    }
    if (folder.outcome === 'failed') {
      forgetWizard(wizard);
      return;
    }
    await createTopic(wizard, folder.subdir);
  }

  /** Create the topic, bind it, greet it, and turn the wizard's message into the answer with the link to the new topic. */
  async function createTopic(wizard: TopicWizard, subdir: string): Promise<void> {
    wizard.isCreating = true;
    const name = wizard.name ?? '';
    const chatId = getTelegramChatId(wizard.originKey);
    let threadId: number;
    try {
      threadId = (await bot.telegram.createForumTopic(chatId, name)).message_thread_id;
    } catch (error) {
      forgetWizard(wizard);
      const reason = checkIsMissingTopicRightsError(error)
        ? t('error.tg.perm.manage_topics')
        : t('topic.createFailed', { reason: checkIsApiError(error) ? getErrorDescription(error) : String(error) });
      console.warn(`[topic] createForumTopic failed for ${keyToString(wizard.originKey)}:`, error instanceof Error ? error.message : error);
      await showAnswer(wizard, reason, null, { parse_mode: 'Markdown' });
      return;
    }
    forgetWizard(wizard);
    const bindFailure = await bindNewTopic(makeTelegramKey(chatId, threadId), subdir, name);
    const text = bindFailure === null ? t('topic.created', { name, subdir }) : t('topic.createdNotBound', { name, reason: bindFailure });
    const link = buildTopicLink({ chatId, username: wizard.chatUsername }, threadId);
    const keyboard = link === null ? null : Markup.inlineKeyboard([[Markup.button.url(t('topic.openButton'), link)]]);
    await showAnswer(wizard, text, keyboard);
  }

  /** The answer takes the wizard's message (consuming its keyboard); a message that cannot be edited any more gets a new one. */
  async function showAnswer(wizard: TopicWizard, text: string, keyboard: ReturnType<typeof Markup.inlineKeyboard> | null, extra: object = {}): Promise<void> {
    const options = { ...extra, ...(keyboard ?? {}) };
    if (wizard.messageId !== null && await editThreadMessage(wizard.originKey, wizard.messageId, text, options)) return;
    await replyToThread(wizard.originKey, text, options);
  }

  // ── the command and the buttons ──

  function registerTopicCommand(): void {
    command('topic', async (ctx, key, parsed) => {
      if (checkIsDmKey(key)) {
        await replyToThread(key, t('topic.dmUnsupported'));
        return;
      }
      const wizard = createWizard(key, ctx);
      const rawName = parsed.args.join(' ');
      if (rawName.trim() === '') {
        await askTopicName(wizard, null);
        return;
      }
      await acceptTopicName(wizard, rawName);
    });
  }

  /**
   * Gate one tap: an authorised admin, a wizard that is still alive and not creating its topic yet, on the keyboard's
   * own message. The toast says what is wrong, otherwise the tap is answered (empty, or `toast`) before the work
   * starts. `null` when the tap is refused.
   */
  async function takeWizardTap(ctx: Context, wizardId: string, options: { toast?: string; startsCreating?: boolean } = {}): Promise<TopicWizard | null> {
    const key = await authoriseContext(ctx);
    if (!key) {
      await ctx.answerCbQuery(t('cb.access_denied'));
      return null;
    }
    const wizard = getWizard(wizardId);
    if (!wizard || getCallbackMessageId(ctx) !== wizard.messageId) {
      await ctx.answerCbQuery(t('topic.staleChoice'));
      return null;
    }
    // A second tap of the same keyboard while the topic is being created: the first one is answering it.
    if (wizard.isCreating) {
      await ctx.answerCbQuery();
      return null;
    }
    // Claimed before the next await, so two taps in flight cannot both pass the check above.
    if (options.startsCreating) wizard.isCreating = true;
    await ctx.answerCbQuery(options.toast);
    return wizard;
  }

  function registerTopicCallbacks(): void {
    bot.action(topicSameFolderCallbackRe, async (ctx) => {
      const wizard = await takeWizardTap(ctx, ctx.match[1], { toast: t('topic.creatingToast'), startsCreating: true });
      if (!wizard || wizard.currentSubdir === null) return;
      await createTopic(wizard, wizard.currentSubdir);
    });

    bot.action(topicOtherFolderCallbackRe, async (ctx) => {
      const wizard = await takeWizardTap(ctx, ctx.match[1]);
      if (wizard) await showPicker(wizard);
    });

    bot.action(topicFolderCallbackRe, async (ctx) => {
      const subdirIndex = Number(ctx.match[2]);
      const wizard = await takeWizardTap(ctx, ctx.match[1], { toast: t('topic.creatingToast'), startsCreating: true });
      if (!wizard) return;
      const subdir = wizard.folders[subdirIndex];
      if (subdir === undefined) {
        wizard.isCreating = false;
        return;
      }
      await createTopic(wizard, subdir);
    });

    bot.action(topicPageCallbackRe, async (ctx) => {
      const wizard = await takeWizardTap(ctx, ctx.match[1]);
      if (!wizard) return;
      const keyboard = buildBindKeyboard(wizard.folders, Number(ctx.match[2]), BIND_PAGE_SIZE, false, buildTopicPickerCallbacks(wizard.id));
      try {
        await ctx.editMessageReplyMarkup(keyboard.reply_markup);
      } catch (error) {
        const description = checkIsApiError(error) ? getErrorDescription(error) : '';
        if (!/message is not modified/i.test(description)) console.warn('[topic] picker page edit failed:', description || error);
      }
    });

    bot.action(topicCreateFolderCallbackRe, async (ctx) => {
      const wizard = await takeWizardTap(ctx, ctx.match[1], { toast: t('bind.create_cb') });
      if (!wizard || wizard.messageId === null) return;
      armCapture(wizard, 'folderName');
      // The picker is consumed: the message becomes the question for the folder's name.
      await editThreadMessage(wizard.originKey, wizard.messageId, `${t('topic.createFolderPrompt', { name: wizard.name ?? '' })}\n${t('login.esc_hint')}`);
    });
  }

  return { registerTopicCommand, registerTopicCallbacks, checkIsAwaitingTopicInput, submitTopicInput, cancelTopicInput };
}
