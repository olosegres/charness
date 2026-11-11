/**
 * @description Pure routing-decision logic — extracted from `bot.ts` so
 * the gating rules (plan §8) can be unit-tested without booting Telegraf,
 * parsing ENV, or pulling in 30+ adapter dependencies.
 *
 * The Telegram `Context` object carries everything we need:
 *   - `ctx.chat` → forum supergroup detection + chat-id allowlist gate
 *   - `ctx.message` (or `ctx.callbackQuery.message`) →
 *     `message_thread_id` + `is_topic_message`
 *
 * Both fields are passed in by `bot.ts:getThreadKey` after pulling them
 * from the live context, so this module can stay free of Telegraf imports.
 *
 * The `GENERAL_THREAD_ID = 1` constant is the magic number for the
 * General forum topic — Telegram returns the thread id either as `1` or
 * (sometimes) as `undefined` for posts in General; we normalise both to 1.
 *
 * Plan §11 Этап 7 / R2.
 */

import type { SessionKey } from './sessionKey';
import {
  checkIsTelegramKey,
  getTelegramChatId,
  getTelegramThreadId,
  makeTelegramKey,
} from './connectors/telegram/sessionKeyCodec';

/** Telegram's stable id for the General forum topic. */
export const GENERAL_THREAD_ID = 1;

/**
 * @description "General" thread id in the owner-DM surface. A message posted to
 * the DM's main thread carries NO `message_thread_id`; we normalise that to `0`
 * (distinct from the supergroup's `1`) so the two surfaces never collide in a
 * persisted `SessionKey` and `checkIsGeneral` can stay mode-aware.
 */
export const DM_GENERAL_THREAD_ID = 0;

/**
 * @description Which Telegram surface(s) the bot serves.
 *
 * - `group` — only the forum supergroup (creator/admins gated, paired by
 *   `ALLOWED_GROUP_ID`).
 * - `dm` — only the owner's 1:1 private chat with forum-topic mode (owner-id gated).
 * - `both` — DEFAULT. ONE instance serves the owner DM AND the group at once,
 *   decided PER CHAT (the DM surface is inert if no `OWNER_USER_ID` is set, so a
 *   bare deploy stays group-only).
 */
export type ChatMode = 'group' | 'dm' | 'both';

/** The valid {@link ChatMode} values, for env validation. */
export const chatModeValues: readonly ChatMode[] = ['group', 'dm', 'both'];

/** Type guard: is `value` a valid {@link ChatMode}? */
export function checkIsChatMode(value: string): value is ChatMode {
  return (chatModeValues as readonly string[]).includes(value);
}

/**
 * @description Minimal shape of the bits of `ctx.chat` we read. We accept
 * `unknown` widths on optional fields so callers can pass a Telegraf
 * `Chat` union without casting.
 */
export interface RouteChat {
  id: number;
  type?: string;
  /** Present (and `true`) only on forum-enabled supergroups. */
  is_forum?: boolean;
}

/**
 * @description Minimal shape of the bits of `ctx.message` /
 * `ctx.callbackQuery.message` we read.
 */
export interface RouteMessage {
  message_thread_id?: number;
  is_topic_message?: boolean;
}

export interface RouteInput {
  chat: RouteChat | undefined;
  /** From `ctx.message` (top-level update). */
  message?: RouteMessage | undefined;
  /** From `ctx.callbackQuery?.message` (inline-button presses). */
  callbackQueryMessage?: RouteMessage | undefined;
}

/**
 * @description Compute the `SessionKey` for an incoming Telegram update,
 * or return `null` if the bot should silently ignore it.
 *
 * Gating rules (plan §8):
 *   1. Chat is a forum supergroup (`type === 'supergroup'` AND `is_forum`).
 *   2. `chat.id === allowedGroupId`.
 *   3. If a `message_thread_id` is present, `is_topic_message` must be
 *      `true` — guards against plain reply-threads in non-forum
 *      supergroups, which also carry `message_thread_id` but are NOT
 *      topics (plan §4.3 point 2, T7).
 *   4. Missing `message_thread_id` → General topic (id 1).
 */
export function resolveThreadKey(input: RouteInput, allowedGroupId: number): SessionKey | null {
  const chat = input.chat;
  if (!chat || chat.type !== 'supergroup') return null;
  if (!chat.is_forum) return null;
  if (chat.id !== allowedGroupId) return null;

  // Callback-query updates carry the originating message under
  // `ctx.callbackQuery.message`. Either source is fine — they share the
  // forum-topic fields by Telegram's data model.
  const msg = input.message ?? input.callbackQueryMessage;

  const rawThreadId = msg?.message_thread_id;
  const isTopicMessage = msg?.is_topic_message;

  // Reply-threads in non-forum supergroups also carry message_thread_id.
  // We've already gated on `is_forum`, but a forum supergroup can still
  // host a reply on the General-topic root — `is_topic_message` is `false`
  // in that case and we should NOT mis-route it to a custom topic id.
  if (rawThreadId && !isTopicMessage) return null;

  const threadId = rawThreadId ?? GENERAL_THREAD_ID;
  return makeTelegramKey(chat.id, threadId);
}

/**
 * @description Compute the `SessionKey` for an incoming update in DM mode, or
 * `null` if the bot should ignore it.
 *
 * The DM surface accepts updates ONLY from the OWNER'S private chat — and the
 * owner's private-chat id IS the owner's user id, so a single equality both
 * gates the chat and identifies the owner:
 *   1. `chat.type === 'private'` — any non-DM update is ignored here.
 *   2. `chat.id === ownerUserId` — only the owner's DM, never another user's.
 *
 * The thread is the DM-topic's `message_thread_id`; a message in the DM's main
 * thread carries none → normalised to {@link DM_GENERAL_THREAD_ID} (0). Unlike
 * the supergroup path there is no `is_topic_message` gate: a private chat has no
 * reply-thread/topic ambiguity to disambiguate.
 */
export function resolveDmThreadKey(input: RouteInput, ownerUserId: number): SessionKey | null {
  const chat = input.chat;
  if (!chat || chat.type !== 'private') return null;
  if (chat.id !== ownerUserId) return null;

  const msg = input.message ?? input.callbackQueryMessage;
  const threadId = msg?.message_thread_id ?? DM_GENERAL_THREAD_ID;
  return makeTelegramKey(chat.id, threadId);
}

/** Runtime surface config for {@link resolveThreadKeyForMode} / {@link checkIsDmThreadKey}. */
export interface SurfaceRouting {
  /** The served surface(s) for this process. */
  mode: ChatMode;
  /** The owner's user id (= the owner's DM chat id), or `NaN` when no DM owner. */
  ownerUserId: number;
  /** The effective forum supergroup id, or `NaN` while unpaired. */
  allowedGroupId: number;
  /** Whether the DM surface is live (false ⇒ the owner-DM resolver is skipped). */
  isDmSurfaceActive: boolean;
}

/**
 * @description Per-chat discriminator: does `key` belong to the DM surface? A DM
 * key's `chatId` is the owner's user id (`resolveDmThreadKey` gates
 * `chat.id === ownerUserId`), so the equality both identifies the surface and
 * re-asserts the owner. Always false when the DM surface is inert — then
 * `ownerUserId` is `NaN`, which never equals a real chat id anyway, but the guard
 * makes a group-only `both` unambiguously group.
 */
export function checkIsDmThreadKey(
  key: SessionKey,
  ownerUserId: number,
  isDmSurfaceActive: boolean,
): boolean {
  if (!isDmSurfaceActive) return false;
  // A predicate must answer, not throw: a key from another platform simply
  // isn't this Telegram surface's DM.
  if (!checkIsTelegramKey(key)) return false;
  return getTelegramChatId(key) === ownerUserId;
}

/**
 * @description Resolve the `SessionKey` for an update across BOTH surfaces, per
 * {@link ChatMode}. The two resolvers are disjoint (a private chat vs. a forum
 * supergroup), so trying both in `both` is unambiguous — an update matches at
 * most one. The owner-DM resolver runs first when the DM surface is live
 * (skipped when inert); the group resolver runs unless we are DM-only. A
 * non-matching surface returns `null` → drop. The single composition behind
 * `bot.ts:getThreadKey`, kept pure here so it is unit-testable.
 */
export function resolveThreadKeyForMode(
  input: RouteInput,
  routing: SurfaceRouting,
): SessionKey | null {
  if (routing.isDmSurfaceActive) {
    const dmKey = resolveDmThreadKey(input, routing.ownerUserId);
    if (dmKey) return dmKey;
  }
  if (routing.mode === 'dm') return null;
  return resolveThreadKey(input, routing.allowedGroupId);
}

/**
 * @description Convenience: is this the General topic? Used by command
 * handlers that have different semantics in General vs. a thematic topic
 * (e.g. `/ls` is General-only, `/bind` is topic-only).
 *
 * Mode-aware: the supergroup surface marks General with `1`, the DM surface
 * with `0` (no `message_thread_id`). Pass the active {@link ChatMode} so the
 * right marker is checked.
 */
export function checkIsGeneralTopic(key: SessionKey, mode: ChatMode = 'group'): boolean {
  if (!checkIsTelegramKey(key)) return false;
  const generalThreadId = mode === 'dm' ? DM_GENERAL_THREAD_ID : GENERAL_THREAD_ID;
  return getTelegramThreadId(key) === generalThreadId;
}

/** Inputs for the auto-pairing decision (side-effect free). */
export interface PairingInput {
  chat: RouteChat | undefined;
  /** Already-effective group id (env or previously paired), or `null`. */
  currentGroupId: number | null;
  /** True when `ALLOWED_GROUP_ID` env is set numerically — pairing disabled. */
  isEnvLocked: boolean;
}

/**
 * @description Decide whether an incoming update's chat is STRUCTURALLY a
 * pairing candidate. Returns the chat id to pair, or `null`.
 *
 * Eligible only when ALL hold:
 *   1. Not locked by a numeric `ALLOWED_GROUP_ID` env.
 *   2. No effective group id yet (`currentGroupId === null`).
 *   3. The chat is a forum supergroup (same gate as {@link resolveThreadKey}).
 *
 * Who may pair is decided separately ({@link getPairingRefusal}): being an
 * administrator of the candidate group proves nothing — whoever made the group
 * is its creator.
 */
export function resolvePairingCandidate(input: PairingInput): number | null {
  if (input.isEnvLocked) return null;
  if (input.currentGroupId !== null) return null;
  const { chat } = input;
  if (!chat || chat.type !== 'supergroup' || !chat.is_forum) return null;
  return chat.id;
}

/**
 * @name PairingRefusal
 * @description Why a sender may not pair the bot with a group: `notOwner` — an owner is set (`OWNER_USER_ID`) and the sender
 * is not the owner; `notCurrentCreator` — no owner is set, the bot serves another group, and the sender did not create that
 * group; `notAdmin` — the sender does not administer the group to pair (the bot serves that group's administrators).
 */
export type PairingRefusal = 'notOwner' | 'notCurrentCreator' | 'notAdmin';

/** What {@link getPairingRefusal} decides from. */
export interface PairingAuthorityInput {
  /** `OWNER_USER_ID`, or `null` when the instance has none. */
  ownerUserId: number | null;
  senderId: number;
  /** The group the bot serves now, `null` while unpaired. */
  currentGroupId: number | null;
  /** The group the sender wants it to serve. */
  targetGroupId: number;
}

/** The Telegram reads {@link getPairingRefusal} needs, asked only when the rule gets to them. */
export interface PairingAuthorityProbes {
  /** Whether the sender is an administrator or the creator of the group to pair. */
  checkIsTargetGroupAdmin(): Promise<boolean>;
  /** Whether the sender is the creator of the group served now. */
  checkIsCurrentGroupCreator(): Promise<boolean>;
}

/**
 * @description Who may pair the bot with a group — by auto-pairing or `/pair` alike — or why not (`null`: allowed). Anyone
 * can make a group and add the bot to it, and is then that group's creator, so administering the group to pair is never
 * enough on its own:
 *  - with an owner (`OWNER_USER_ID`): the owner alone, the first pairing and every later one;
 *  - without one: the FIRST pairing by an administrator of that group (nothing better tells who installed the bot); once
 *    the bot serves a group, moving it only by the CREATOR of that group (`/pair` in the group it serves already changes
 *    nothing and stays open to its administrators).
 * In every case the sender must administer the group to pair.
 */
export async function getPairingRefusal(input: PairingAuthorityInput, probes: PairingAuthorityProbes): Promise<PairingRefusal | null> {
  if (input.ownerUserId !== null) {
    if (input.senderId !== input.ownerUserId) return 'notOwner';
  } else if (input.currentGroupId !== null && input.currentGroupId !== input.targetGroupId) {
    if (!(await probes.checkIsCurrentGroupCreator())) return 'notCurrentCreator';
  }
  if (!(await probes.checkIsTargetGroupAdmin())) return 'notAdmin';
  return null;
}
