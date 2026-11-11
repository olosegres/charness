/**
 * `/access` — who may talk to the agent in a topic (`topicTalkers.ts`): the list of that topic's talkers (General's own list is
 * group-wide), added three ways (a tap on someone who wrote here and was ignored, a reply to their message, an @username that
 * waits for their first message when the bot has not seen it) and revoked with one tap. ADMINS only: the command and every
 * button keep the admin gate, so a talker cannot edit the list. Everything is one message redrawn in place; every grant is
 * flushed at once. See `utils/topicAccessScreenPlan.ts` for the screens and the button codec, README.md in this folder.
 *
 * The warning that a talker can make the agent run any command in the topic's folder is shown BEFORE a grant takes effect:
 * the add screen carries it above the buttons that add, and a typed add (a reply, an @username) goes through a confirmation
 * that carries it and takes effect only on «Add».
 */
import { Markup, type Context } from 'telegraf';
import type { Message, User } from 'telegraf/typings/core/types/typegram';
import type { SessionKey } from '../../../sessionKey';
import { keyToString } from '../../../sessionKey';
import { t } from '../../../i18n';
import type { RecentWriters, SeenPerson, SeenSenders } from '../../../topicTalkerMemory';
import { topicInviteTtlMs, type TopicGranter, type TopicTalkersEntry } from '../../../topicTalkers';
import { formatPersonLabel } from '../../../utils/personLabel';
import {
  accessCallbackRe,
  buildAccessAddScreen,
  buildAccessConfirmScreen,
  buildAccessEntryScreen,
  buildAccessGrantedNotice,
  buildAccessInvitedNotice,
  buildAccessListScreen,
  decideAccessAdd,
  listAccessRows,
  parseAccessCallback,
  parseAccessCommand,
  parseAccessUsername,
  type AccessAddContext,
  type AccessPendingAdd,
  type AccessScope,
  type AccessScreen,
  type AccessTarget,
} from '../../../utils/topicAccessScreenPlan';
import { getDisplayName } from '../inbound';
import { getTelegramThreadId } from '../sessionKeyCodec';
import type { BotCore } from './botCore';
import { buildMessageSnapshotKey, getCallbackMessageId, rememberBoundedSnapshot } from './callbackMessage';
import { answerCallbackQuerySafely } from './callbackToast';

/** How many add / confirm screens are remembered at once; an older one is «out of date». */
const screenSnapshotLimit = 50;

/** Telegram's own service user («Telegram»: the automatic copy of a linked channel's post into the group): never a person to add. */
const telegramServiceUserId = 777000;

/** What the module needs from the bot: the shared core and the things only the composition root knows. */
export interface TopicAccessPorts
  extends Pick<BotCore, 'bot' | 'command' | 'getState' | 'replyToThread' | 'editThreadMessageDetailed' | 'authoriseContext' | 'withThreadLocale' | 'checkIsGeneral'> {
  /** The ids of the group's admins (the admin cache): an admin is never added. */
  getAdminIds: () => Promise<ReadonlySet<string>>;
  /** This bot's own Telegram user id, once known. */
  getBotUserId: () => number | undefined;
  /** The General topic of the group `key` is in: the key of the group-wide list. */
  getGroupGeneralKey: (key: SessionKey) => SessionKey;
  /** Whether `key` is the owner's private chat: it has no talkers. */
  checkIsDmKey: (key: SessionKey) => boolean;
  /** The people who wrote in a topic and were ignored (memory only). */
  recentWriters: RecentWriters;
  /** The @usernames the bot has seen write in the group since it started (memory only). */
  seenSenders: SeenSenders;
}

/** What a message-bound screen remembers: the people its buttons point at, or the add it waits to confirm. */
type ScreenSnapshot = { id: number } & ({ kind: 'add'; writers: SeenPerson[] } | { kind: 'confirm'; pending: AccessPendingAdd });

/** @description A Telegram user as an add's target: a bot (or the «Telegram» service user) is refused by the decision. */
function getPersonTarget(user: User): AccessTarget {
  return {
    kind: 'person',
    userId: user.id.toString(),
    ...(user.username !== undefined ? { username: user.username } : {}),
    name: getDisplayName(user),
    isBot: user.is_bot || user.id === telegramServiceUserId,
  };
}

/**
 * @description The person a replied-to message names. A reply to the topic's own root message is Telegram's «post in this topic»,
 * not a reply to anybody; a post made as the group or a channel (it carries `sender_chat`) is no person.
 */
function getReplyTarget(message: Message.TextMessage): AccessTarget | null {
  const replied = message.reply_to_message;
  if (!replied || 'forum_topic_created' in replied || replied.message_id === message.message_thread_id) return null;
  if (replied.sender_chat || !replied.from) return { kind: 'chatIdentity' };
  return getPersonTarget(replied.from);
}

/** @description The person a mention picked from the member list names (`text_mention` carries the user id), or `null`. */
function getTextMentionTarget(message: Message.TextMessage): AccessTarget | null {
  const mention = message.entities?.find((entity) => entity.type === 'text_mention');
  return mention?.type === 'text_mention' ? getPersonTarget(mention.user) : null;
}

/**
 * @description Build the `/access` screen over its ports: the command, its typed forms and its buttons.
 */
export function createTopicAccess(ports: TopicAccessPorts) {
  const { bot, command, getState, replyToThread, editThreadMessageDetailed, authoriseContext, withThreadLocale, checkIsGeneral, getAdminIds, getBotUserId, getGroupGeneralKey, checkIsDmKey, recentWriters, seenSenders } = ports;

  /** Per MESSAGE, keyed by chat + message id (`buildMessageSnapshotKey`): a message id is unique only within one chat. */
  const screenSnapshots = new Map<string, ScreenSnapshot>();
  let lastSnapshotId = 0;

  const getScope = (key: SessionKey): AccessScope => (checkIsGeneral(key) ? 'general' : 'topic');
  const getScopeWords = (scope: AccessScope): string => (scope === 'general' ? t('access.scopeEveryTopic') : t('access.scopeHere'));
  const toMarkup = (screen: AccessScreen) =>
    Markup.inlineKeyboard(screen.keyboard.map((row) => row.map((button) => Markup.button.callback(button.label, button.callbackData))));

  /** The topics (other than General) that have talkers of their own, named for General's summary line. */
  function listTopicsWithTalkers(generalKey: SessionKey): { name: string; talkerCount: number }[] {
    return getState().getTopicTalkerCounts()
      .filter((topic) => keyToString(topic.key) !== keyToString(generalKey))
      .map((topic) => ({ name: getState().getBinding(topic.key)?.topicName || `#${getTelegramThreadId(topic.key)}`, talkerCount: topic.talkerCount }));
  }

  function buildListScreen(key: SessionKey, page: number, footerNote?: string): AccessScreen {
    const scope = getScope(key);
    const generalKey = getGroupGeneralKey(key);
    return buildAccessListScreen({
      scope,
      entry: getState().getTopicTalkers(key),
      page,
      generalTalkerCount: scope === 'topic' ? getState().getTopicTalkers(generalKey).talkers.length : 0,
      topicsWithTalkers: scope === 'general' ? listTopicsWithTalkers(generalKey) : [],
      ...(footerNote !== undefined ? { footerNote } : {}),
    });
  }

  /** Remember what the buttons of the screen on message `messageId` point at. */
  function rememberScreen(key: SessionKey, messageId: number | null, snapshot: ScreenSnapshot): void {
    if (messageId !== null) rememberBoundedSnapshot(screenSnapshots, buildMessageSnapshotKey(key, messageId), snapshot, screenSnapshotLimit);
  }

  /**
   * @description Put `screen` on the message a tap sat on, in place; when that message cannot be edited (it is gone), post it
   * anew. Resolves the id of the message the screen is on, for a screen whose buttons point into a snapshot.
   */
  async function showScreen(key: SessionKey, tappedMessageId: number | null, screen: AccessScreen): Promise<number | null> {
    const markup = toMarkup(screen);
    if (tappedMessageId !== null && (await editThreadMessageDetailed(key, tappedMessageId, screen.text, markup)) === 'edited') return tappedMessageId;
    return replyToThread(key, screen.text, markup);
  }

  /** Redraw the CURRENT list in the tapped message — what every stale or finished action ends in. */
  async function showList(key: SessionKey, tappedMessageId: number | null, page = 0, footerNote?: string): Promise<void> {
    await showScreen(key, tappedMessageId, buildListScreen(key, page, footerNote));
  }

  async function buildAddContext(key: SessionKey): Promise<AccessAddContext> {
    const scope = getScope(key);
    return {
      botUserId: getBotUserId()?.toString(),
      adminIds: await getAdminIds(),
      ownEntry: getState().getTopicTalkers(key),
      generalEntry: scope === 'topic' ? getState().getTopicTalkers(getGroupGeneralKey(key)) : undefined,
      now: Date.now(),
    };
  }

  const getGranter = (user: User | undefined): TopicGranter => ({ userId: user?.id.toString() ?? '', name: user ? getDisplayName(user) : '' });

  /**
   * @description Make an add take effect, deciding AGAIN at this moment (the person may have become an admin, or been added by
   * another admin, since the screen was drawn): a granted person (or a waiting invitation) is written, flushed, and announced in
   * the topic. Resolves the refusal line instead when the add no longer stands.
   */
  async function applyAdd(key: SessionKey, pending: AccessPendingAdd, granter: TopicGranter): Promise<string | null> {
    const scope = getScope(key);
    const target: AccessTarget = pending.kind === 'person' ? { kind: 'person', ...pending.person, isBot: false } : { kind: 'username', username: pending.username };
    const decision = decideAccessAdd(target, await buildAddContext(key));
    if (decision.kind === 'refused') return t(decision.refusalKey, { person: decision.person ?? '' });
    if (decision.kind === 'person') {
      await getState().addTopicTalker(key, decision.person, granter);
      recentWriters.forgetWriter(keyToString(key), decision.person.userId);
      await replyToThread(key, buildAccessGrantedNotice({ scope, person: decision.person, folder: getState().getBinding(key)?.subdir ?? null }));
      return null;
    }
    await getState().addTopicInvite(key, decision.username, granter);
    await replyToThread(key, buildAccessInvitedNotice({ scope, username: decision.username, expiresAt: Date.now() + topicInviteTtlMs }));
    return null;
  }

  // ─── the typed forms ──────────────────────────────────────────────────

  /** The person or @username a typed `add` / `remove` names: a mention picked from the member list, a typed @username, or the replied-to message's author. */
  function getTypedTarget(message: Message.TextMessage, usernameArgument: string | null): AccessTarget | 'badUsername' | null {
    const mention = getTextMentionTarget(message);
    if (mention) return mention;
    if (usernameArgument !== null) {
      const username = parseAccessUsername(usernameArgument);
      if (username === null) return 'badUsername';
      const seen = seenSenders.findSenderByUsername(username);
      return seen
        ? { kind: 'person', userId: seen.userId, ...(seen.username !== undefined ? { username: seen.username } : {}), name: seen.name, isBot: false }
        : { kind: 'username', username };
    }
    return getReplyTarget(message);
  }

  /** `/access add …`: decide, then ask for the confirmation that carries the warning — the grant waits for «Add». */
  async function handleTypedAdd(message: Message.TextMessage, key: SessionKey, usernameArgument: string | null): Promise<void> {
    const target = getTypedTarget(message, usernameArgument);
    if (target === null) { await replyToThread(key, t('access.addUsage')); return; }
    if (target === 'badUsername') { await replyToThread(key, t('access.refuseBadUsername')); return; }
    const decision = decideAccessAdd(target, await buildAddContext(key));
    if (decision.kind === 'refused') { await replyToThread(key, t(decision.refusalKey, { person: decision.person ?? '' })); return; }
    const pending: AccessPendingAdd = decision;
    const snapshot: ScreenSnapshot = { id: ++lastSnapshotId, kind: 'confirm', pending };
    const screen = buildAccessConfirmScreen({ scope: getScope(key), snapshotId: snapshot.id, pending });
    rememberScreen(key, await replyToThread(key, screen.text, toMarkup(screen)), snapshot);
  }

  /** `/access remove …`: one tap-free step — a revoke is cheap to undo (add them back). */
  async function handleTypedRemove(message: Message.TextMessage, key: SessionKey, usernameArgument: string | null): Promise<void> {
    const target = getTypedTarget(message, usernameArgument);
    if (target === null) { await replyToThread(key, t('access.removeUsage')); return; }
    if (target === 'badUsername') { await replyToThread(key, t('access.refuseBadUsername')); return; }
    if (target.kind === 'chatIdentity') { await replyToThread(key, t('access.removeNotFound')); return; }
    const entry = getState().getTopicTalkers(key);
    const scopeWords = getScopeWords(getScope(key));
    const lowercase = target.kind === 'username' ? target.username.toLowerCase() : (target.username ?? '').toLowerCase();
    const talker = entry.talkers.find((candidate) => (target.kind === 'person' ? candidate.userId === target.userId : candidate.username?.toLowerCase() === lowercase));
    if (talker) {
      await getState().removeTopicTalker(key, talker.userId);
      await replyToThread(key, t('access.removedNotice', { person: formatPersonLabel(talker), scope: scopeWords }));
      return;
    }
    const invite = lowercase === '' ? undefined : entry.invites.find((candidate) => candidate.username === lowercase);
    if (invite) {
      await getState().removeTopicInvite(key, invite.username);
      await replyToThread(key, t('access.inviteRemovedNotice', { username: invite.username }));
      return;
    }
    await replyToThread(key, t('access.removeNotFound'));
  }

  // ─── the buttons ──────────────────────────────────────────────────────

  /** The person a list row points at, as a label for a toast. */
  const describeRow = (entry: TopicTalkersEntry, index: number): { label: string; row: ReturnType<typeof listAccessRows>[number] } | null => {
    const row = listAccessRows(entry)[index];
    if (!row) return null;
    return { row, label: row.kind === 'invite' ? `@${row.username}` : formatPersonLabel(row) };
  };

  /** A tap on a list that changed since it was drawn, or on a screen whose memory is gone: say so and show the list as it is. */
  async function answerStale(ctx: Context, key: SessionKey, tappedMessageId: number | null): Promise<void> {
    await answerCallbackQuerySafely(ctx, t('access.listChangedToast'));
    await showList(key, tappedMessageId);
  }

  function takeScreenSnapshot<TKind extends ScreenSnapshot['kind']>(key: SessionKey, messageId: number | null, snapshotId: number, kind: TKind): Extract<ScreenSnapshot, { kind: TKind }> | null {
    if (messageId === null) return null;
    const snapshot = screenSnapshots.get(buildMessageSnapshotKey(key, messageId));
    return snapshot?.id === snapshotId && snapshot.kind === kind ? (snapshot as Extract<ScreenSnapshot, { kind: TKind }>) : null;
  }

  async function handleAccessCallback(ctx: Context): Promise<void> {
    // The admin gate: a talker's tap never gets here (one middleware refuses it with a toast), and a stranger's is answered as one.
    const key = await authoriseContext(ctx);
    if (!key) { await answerCallbackQuerySafely(ctx, t('access.adminOnlyButtonToast')); return; }
    const data = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
    const callback = data === undefined ? null : parseAccessCallback(data);
    if (callback === null) { await answerCallbackQuerySafely(ctx); return; }
    const messageId = getCallbackMessageId(ctx);
    await withThreadLocale(key, async () => {
      const entry = getState().getTopicTalkers(key);
      switch (callback.kind) {
        case 'noop':
          await answerCallbackQuerySafely(ctx);
          return;
        case 'page':
          if (callback.revision !== entry.revision) { await answerStale(ctx, key, messageId); return; }
          await answerCallbackQuerySafely(ctx);
          await showList(key, messageId, callback.page);
          return;
        case 'open': {
          const described = callback.revision === entry.revision ? describeRow(entry, callback.index) : null;
          if (!described) { await answerStale(ctx, key, messageId); return; }
          await answerCallbackQuerySafely(ctx);
          await showScreen(key, messageId, buildAccessEntryScreen({ scope: getScope(key), entry, row: described.row }));
          return;
        }
        case 'add': {
          if (callback.revision !== entry.revision) { await answerStale(ctx, key, messageId); return; }
          await answerCallbackQuerySafely(ctx);
          const context = await buildAddContext(key);
          const writers = recentWriters.getRecentWriters(keyToString(key))
            .filter((writer) => !context.adminIds.has(writer.userId) && !getState().getEffectiveTalkerIds(key, getGroupGeneralKey(key)).has(writer.userId));
          const snapshot: ScreenSnapshot = { id: ++lastSnapshotId, kind: 'add', writers };
          const shownOn = await showScreen(key, messageId, buildAccessAddScreen({ scope: getScope(key), revision: entry.revision, snapshotId: snapshot.id, writers }));
          rememberScreen(key, shownOn, snapshot);
          return;
        }
        case 'writer': {
          const snapshot = takeScreenSnapshot(key, messageId, callback.snapshotId, 'add');
          const writer = snapshot?.writers[callback.index];
          if (!writer) { await answerStale(ctx, key, messageId); return; }
          const refusal = await applyAdd(key, { kind: 'person', person: writer }, getGranter(ctx.from));
          if (refusal !== null) {
            await answerCallbackQuerySafely(ctx, refusal);
            await showList(key, messageId);
            return;
          }
          await answerCallbackQuerySafely(ctx);
          await showList(key, messageId);
          return;
        }
        case 'confirm': {
          const snapshot = takeScreenSnapshot(key, messageId, callback.snapshotId, 'confirm');
          if (!snapshot) {
            await answerCallbackQuerySafely(ctx, t('access.confirmExpiredToast'));
            await showList(key, messageId);
            return;
          }
          if (messageId !== null) screenSnapshots.delete(buildMessageSnapshotKey(key, messageId));
          const refusal = await applyAdd(key, snapshot.pending, getGranter(ctx.from));
          await answerCallbackQuerySafely(ctx, refusal ?? undefined);
          await showList(key, messageId);
          return;
        }
        case 'dismiss': {
          if (messageId !== null) screenSnapshots.delete(buildMessageSnapshotKey(key, messageId));
          await answerCallbackQuerySafely(ctx);
          await showList(key, messageId);
          return;
        }
        case 'revoke': {
          const described = callback.revision === entry.revision ? describeRow(entry, callback.index) : null;
          if (!described) { await answerStale(ctx, key, messageId); return; }
          const { row, label } = described;
          if (row.kind === 'talker') {
            await getState().removeTopicTalker(key, row.userId);
            await answerCallbackQuerySafely(ctx, t('access.revokedToast', { person: label, scope: getScopeWords(getScope(key)) }));
            await showList(key, messageId, 0, t('access.stillReadsNote', { person: label }));
            return;
          }
          await getState().removeTopicInvite(key, row.username);
          await answerCallbackQuerySafely(ctx, t('access.inviteCancelledToast', { username: row.username }));
          await showList(key, messageId);
          return;
        }
      }
    });
  }

  function registerTopicAccessCommands(): void {
    // `/access` — admins only (no talker flag): the list of who may talk to the agent in THIS topic, in General the group-wide
    // one. Not gated on an agent or a binding: a list can be made before the topic has either.
    command('access', async (ctx, key, parsed) => {
      if (checkIsDmKey(key)) {
        await replyToThread(key, t('access.dmHint'));
        return;
      }
      // A mention picked from the member list spreads over the words after `add`: only the first word is the action.
      const hasMention = getTextMentionTarget(ctx.message) !== null;
      const accessCommand = parseAccessCommand(hasMention ? parsed.args.slice(0, 1) : parsed.args);
      switch (accessCommand.kind) {
        case 'open': {
          const screen = buildListScreen(key, 0);
          await replyToThread(key, screen.text, toMarkup(screen));
          return;
        }
        case 'add':
          await handleTypedAdd(ctx.message, key, hasMention ? null : accessCommand.usernameArgument);
          return;
        case 'remove':
          await handleTypedRemove(ctx.message, key, hasMention ? null : accessCommand.usernameArgument);
          return;
        case 'unknown':
          await replyToThread(key, t('access.usage'));
          return;
      }
    });
  }

  function registerTopicAccessCallbacks(): void {
    bot.action(accessCallbackRe, handleAccessCallback);
  }

  return { registerTopicAccessCommands, registerTopicAccessCallbacks };
}
