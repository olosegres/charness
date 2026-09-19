/**
 * @description The outbound half of the platform seam: what the core hands ANY
 * surface, and what it may assume that surface can do.
 *
 * The core emits SEMANTIC content — text plus the structure it means (a set of
 * options the user should pick from, a request to keep the message visible) —
 * and never a rendered message. Telegram's HTML subset, a tracker's document
 * format and Teams' cards are mutually incompatible, and so are their length
 * limits, so rendering and splitting belong to the connector on the far side of
 * this file.
 *
 * Deliberately NOT here: markup dialects, message limits, keyboards, pins,
 * edit-in-place vs draft-cursor streaming. Those are connector-internal.
 */

import type { SessionKey } from '../sessionKey';
import type { SendFilesToThreadOptions, SendFilesToThreadResult } from '../utils/fileSendService';

/**
 * @name MarkupDialect
 * @description How a connector wants the semantic text spelled. Advertised
 * rather than assumed, because a renderer that guesses wrong produces visible
 * garbage (raw `<b>` tags) instead of failing.
 *
 * - `telegramHtml` — Telegram's small HTML subset.
 * - `markdown` — CommonMark-ish, what most trackers accept.
 * - `plain` — no markup at all; a renderer must strip rather than escape.
 */
export type MarkupDialect = 'telegramHtml' | 'markdown' | 'plain';

/**
 * @description What a surface can actually do, so the core can degrade instead
 * of assuming. Every flag has a defined fallback the core must take when it is
 * `false`; a connector never silently no-ops a capability it lacks.
 */
export interface ConnectorCapabilities {
  /** Can an already-sent message be rewritten? False → send a new message instead. */
  editMessages: boolean;
  /** Can a message be kept visible at the top of the conversation? False → skip pinning. */
  pinMessages: boolean;
  /**
   * Can options be offered as tappable controls? False → the enumerated text
   * list stays (it is rendered either way) and the user answers by index.
   */
  tappableOptions: boolean;
  /** Can files be delivered into the conversation? False → say so instead of sending. */
  attachments: boolean;
  /** Does the surface have threads of its own, or is a conversation flat? */
  threadedReplies: boolean;
  /** Is there a "the other side is working" affordance? False → `setActivity` is a no-op. */
  activityIndicator: boolean;
  /** Hard per-message character cap the connector's own splitter honours. */
  maxMessageChars: number;
  /** The dialect {@link OutboundContent.text} should be written in. */
  markupDialect: MarkupDialect;
}

/**
 * @description One choice the core is offering the user.
 *
 * `id` is what comes back on selection; `label` is what is shown. A connector
 * with {@link ConnectorCapabilities.tappableOptions} renders these as controls,
 * one without renders nothing extra — the enumerated list is already part of
 * {@link OutboundContent.text}.
 */
export interface OutboundOption {
  id: string;
  label: string;
  description?: string;
}

/**
 * @description One piece of outbound content: semantic text plus the optional
 * structure that goes with it.
 *
 * `text` is NOT pre-rendered for any surface — it is written in the dialect the
 * connector advertised, and the connector escapes, renders and splits it.
 */
export interface OutboundContent {
  text: string;
  /**
   * Choices the user may pick from. Always ALSO enumerated inside `text`, so a
   * surface without tappable controls loses nothing but the tap.
   */
  options?: OutboundOption[];
  /**
   * Ask the surface to keep this message prominent (Telegram: pin, so a muted
   * topic still notifies). Advisory — ignored where
   * {@link ConnectorCapabilities.pinMessages} is false.
   */
  keepVisible?: boolean;
}

/**
 * @description Advisory delivery hints riding one piece of content.
 *
 * Every flag describes the content's RELATIONSHIP to the turn around it, never
 * a rendering instruction: a connector honours what its surface can express and
 * ignores the rest without the core noticing. They are the agent adapters'
 * `output` event metadata, which is why the vocabulary is streaming-shaped.
 */
export interface OutboundHints {
  /**
   * True when this text directly continues the previous emit of the same
   * in-flight response (a streaming tail cut mid-sentence, possibly mid-word).
   * A surface that can edit appends it to the message it is already rendering —
   * concatenated as-is, no separator — instead of starting a new message.
   * Absent/false = a standalone emit (new logical message).
   */
  isContinuation?: boolean;
  /**
   * True when this is the LAST frame of a turn (emitted as the session goes
   * idle). The connector flushes it promptly instead of waiting out the
   * possibly-429-stretched debounce, so the final message never lingers behind
   * a cooldown. Only affects flush TIMING — append/continuation semantics are
   * unchanged.
   */
  isFinal?: boolean;
  /**
   * True when this is a COMPLETE one-shot block, whole at emit time (e.g. the
   * "↩️ Resumed — last N messages" context block) rather than a live streaming
   * tail. The connector posts it instantly as a single message: Telegram's DM
   * path SKIPS the native draft channel (whose typing animation would otherwise
   * "draw" already-ready text progressively), and flushes the persist
   * immediately (like {@link OutboundHints.isFinal}) instead of waiting out the
   * debounce.
   */
  isComplete?: boolean;
  /**
   * True when this text comes from a SUB-AGENT (OpenCode: child session SSE;
   * Claude: on-disk transcript tail), only emitted in `/subagent full` mode.
   * The connector renders the chunk visibly marked ("🤖 ⤷ …") and OUTSIDE the
   * parent reply's continuation chain — a child transcript must never become
   * the base the parent's next continuation is appended to (it would corrupt
   * the answer's accounting).
   */
  isSubagent?: boolean;
  /**
   * True when this content is an interactive question the user is expected to
   * answer. The connector gives it its own prominent message rather than
   * appending it to the streaming cursor. (Claude scrapes questions out of its
   * TUI and marks them here; OpenCode has a discrete question event with its
   * own path.)
   */
  isQuestion?: boolean;
  /**
   * True when the source had a paragraph break immediately before this chunk's
   * first new line (carried out-of-band because the relay pipeline's `.trim()`s
   * would strip a leading blank). The connector inserts a blank-line (`\n\n`)
   * separator when APPENDING this chunk to a pending buffer / live draft, so
   * multi-paragraph answers keep their structure; IGNORED when the chunk starts
   * a fresh message (a message must never start blank). OpenCode never sets it —
   * it re-renders the full accumulated text, so blanks already survive.
   */
  startsNewParagraph?: boolean;
}

/**
 * @name ActivityState
 * @description What the conversation should look like it is doing.
 * `working` while the agent is producing an answer, `idle` once the turn is
 * drained. A surface without an activity affordance ignores both.
 */
export type ActivityState = 'working' | 'idle';

/**
 * @description A request to deliver files from the thread's bound folder.
 *
 * Reuses the file service's options verbatim: path safety, type classification
 * and the album/size decision are already platform-neutral and live in
 * `utils/fileSendService.ts`; only the transmission is connector work.
 */
export type OutboundFileRequest = SendFilesToThreadOptions;

/** Outcome of {@link ConnectorOutbound.deliverFile}, relayed to the agent verbatim. */
export type OutboundFileResult = SendFilesToThreadResult;

/**
 * @description The outbound side of a connector — the ONLY way the core reaches
 * a user.
 *
 * `deliverFile` and `setActivity` are part of the contract rather than optional
 * extras: the agent-facing MCP surface sends files, images and video, and the
 * "the agent is working" affordance is one of the three jobs this seam exists to
 * own (reply / stream / typing). A connector whose surface lacks either still
 * implements it — declaring the capability `false` and degrading — so the core
 * never needs a per-platform branch.
 */
export interface ConnectorOutbound {
  /** Send one piece of semantic content into the conversation. */
  deliver(key: SessionKey, content: OutboundContent, hints?: OutboundHints): Promise<void>;
  /** Send files from the thread's bound folder into the conversation. */
  deliverFile(key: SessionKey, request: OutboundFileRequest): Promise<OutboundFileResult>;
  /** Show or clear the "working" affordance. Fire-and-forget by design. */
  setActivity(key: SessionKey, activity: ActivityState): void;
  /**
   * Land anything still in flight for the conversation as permanent content, so
   * a teardown can never discard the agent's final answer. Idempotent.
   */
  finalize(key: SessionKey): Promise<void>;
  /** Drop per-conversation delivery state on a full teardown. Called AFTER {@link finalize}. */
  dispose(key: SessionKey): void;
  /**
   * True while in-flight content still "owns" the live message. The core reads
   * it to avoid interleaving a status frame into a half-written answer.
   */
  checkIsDelivering(key: SessionKey): boolean;
  /**
   * Conversations holding content that {@link finalize} would still land. The
   * graceful-shutdown flush drains these before the process exits.
   */
  listUnfinalizedKeys(): SessionKey[];
  /** What this surface can do. Read by the core to pick the rich or degraded path. */
  readonly capabilities: ConnectorCapabilities;
}
