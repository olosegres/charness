/**
 * @description The inbound half of the platform seam: what the core consumes
 * from ANY surface.
 *
 * The core must not know that a message arrived as a Telegram update, a tracker
 * comment or a Teams activity. It consumes {@link InboundEvent} — already
 * normalized, already addressed by a {@link SessionKey}, already parsed into a
 * platform-neutral command when the text carried one. The connector owns every
 * step of that translation, plus the membership lookup that access control
 * depends on.
 *
 * Deliberately NOT here: rendering, message limits, markup dialects, and any
 * notion of what an update "is" on the wire. Those are outbound / connector
 * concerns.
 */

import type { SessionKey } from '../sessionKey';

/**
 * @description Who sent an inbound event, reduced to what the core can use on
 * ANY surface.
 *
 * `id` is a string because only Telegram's user ids happen to be numeric — a
 * tracker account id or a Teams AAD object id is not. The core only ever
 * compares and displays it.
 *
 * **There is deliberately no `isAdmin` flag.** `AdminCache` already owns that
 * answer behind a TTL with failure backoff; a per-event snapshot would disagree
 * with the cache after a demotion and leave the access policy with two sources
 * of truth. The policy keeps asking the cache.
 */
export interface InboundAuthor {
  id: string;
  displayName: string;
}

/**
 * @name AttachmentKind
 * @description The media families the core can reason about, independent of
 * what any one platform calls them. A connector maps its own richer taxonomy
 * (Telegram splits `video` / `video_note` / `animation`) onto these.
 */
export type AttachmentKind = 'photo' | 'document' | 'video' | 'audio' | 'voice';

/**
 * @description One attachment on an inbound event, normalized.
 *
 * `handle` is opaque to the core: it is whatever the ORIGINATING connector
 * needs to fetch the bytes later (a Telegram `file_id`, a tracker attachment
 * URL). The core stores and passes it back; it never interprets it.
 */
export interface NormalizedAttachment {
  kind: AttachmentKind;
  handle: string;
  /** Stable, non-reusable id for naming the saved copy, when the platform has one. */
  uniqueId: string | null;
  fileName: string | null;
  sizeBytes: number | null;
  /** Text accompanying the attachment, when the platform carries one. */
  caption: string | null;
}

/**
 * @description A command parsed out of the inbound text by the connector, in a
 * form the neutral router can dispatch.
 *
 * - `name` — verbatim, without the platform's trigger syntax (`/` on Telegram,
 *   an `@mention` on a tracker). Case is NOT folded here: the router matches
 *   exactly, and a surface whose commands are case-insensitive normalises in
 *   its own recogniser.
 * - `args` — whitespace-split remainder, empties dropped.
 * - `argsText` — the remainder verbatim (trimmed at the ends only). Kept
 *   alongside `args` because commands that take free-form prose (a session
 *   title, a schedule description) must preserve the user's inner spacing,
 *   which `args.join(' ')` would not.
 */
export interface InboundCommand {
  name: string;
  args: string[];
  argsText: string;
}

/**
 * @description The message an inbound event replies to, reduced to what the
 * core renders into the agent prompt.
 *
 * `isFromAssistant` is carried explicitly rather than left for the core to
 * derive: only the connector knows which account is the integration's own, and
 * the rendered quote attributes the text to `assistant` or `user` from it.
 */
export interface InboundReplyTo {
  text: string;
  author: InboundAuthor | null;
  isFromAssistant: boolean;
}

/**
 * @description One normalized inbound message from any surface.
 *
 * `raw` is the connector-private escape hatch — the original platform payload,
 * opaque to the core. It exists so a connector's own handlers can recover full
 * fidelity without the core growing platform fields; core code reading `raw` is
 * a seam violation.
 */
export interface InboundEvent {
  key: SessionKey;
  author: InboundAuthor;
  text: string;
  attachments: NormalizedAttachment[];
  replyTo?: InboundReplyTo;
  command?: InboundCommand;
  raw: unknown;
}

/** What the core hands a connector to receive normalized events. */
export type InboundEventHandler = (event: InboundEvent) => Promise<void> | void;

/**
 * @description A member of a space, reduced to what access control needs.
 *
 * Replaces the telegraf `ChatMember` that `accessControl.ts` used to import:
 * the policy cares only about "is this a real person with elevated rights",
 * never about Telegram's nine membership statuses. Mapping a platform's status
 * vocabulary onto `hasElevatedRights` is the connector's job.
 */
export interface PlatformMember {
  id: string;
  displayName: string;
  isBot: boolean;
  hasElevatedRights: boolean;
}

/**
 * @description The inbound side of a connector.
 *
 * `listMembersWithElevatedRights` is part of the interface rather than a
 * separate service because membership is inherently platform knowledge: only
 * the connector knows which of its status values count as elevated. It returns
 * ids (not members) because that is all the access policy compares against.
 */
export interface ConnectorInbound {
  /** Begin delivering normalized events to `onEvent`. Idempotent. */
  start(onEvent: InboundEventHandler): Promise<void>;
  /** Stop delivering events and release the transport. Idempotent. */
  stop(): Promise<void>;
  /**
   * Ids of the members of `space` who hold elevated rights there.
   *
   * A lookup that cannot be answered must REJECT. Resolving `[]` is a valid
   * answer meaning "this space has no elevated members", and `AdminCache` caches
   * it as a successful fetch — so a failure disguised as `[]` locks every
   * operator out for the full TTL, with no retry and nothing logged. Only a
   * rejection keeps the last-known set and re-tries on the failure backoff.
   */
  listMembersWithElevatedRights(space: string): Promise<string[]>;
}
