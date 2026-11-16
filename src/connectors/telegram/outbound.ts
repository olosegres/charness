/**
 * @description The Telegram connector's outbound half — everything that turns
 * the core's semantic {@link OutboundContent} into Telegram messages.
 *
 * It owns the surface's UI idioms (inline keyboards, pins, the typing action)
 * and delegates the streaming mechanics to the existing `OutputTransport`,
 * which is a TELEGRAM CHAT-MODE seam (group edit-in-place vs DM draft cursor),
 * NOT a platform seam. That distinction is why the transport is composed here
 * as an internal detail instead of being promoted to the platform boundary.
 */

import type { InlineKeyboardMarkup } from 'telegraf/typings/core/types/typegram';
import type { SessionKey } from '../../sessionKey';
import type { OutputTransport } from '../../types';
import type { SendFilesToThread } from '../../utils/fileSendService';
import { MAX_MESSAGE_LEN } from './messageSplit';
import { checkNeedsOwnMessage, getDegradedContent } from '../../platform/capabilityFallback';
import type {
  ActivityState,
  ConnectorCapabilities,
  ConnectorOutbound,
  OutboundContent,
  OutboundFileRequest,
  OutboundFileResult,
  OutboundHints,
  OutboundOption,
} from '../../platform/outbound';

/**
 * @description Telegram's self-declared surface. Every flag is `true` because
 * Telegram is the surface the core was originally written against — which is
 * exactly why the degraded paths need the S5 test double to be exercised at
 * all.
 *
 * `maxMessageChars` is the splitter's working cap (4000), deliberately under
 * Telegram's hard 4096 so an HTML render that inflates the source still fits.
 */
export const telegramCapabilities: ConnectorCapabilities = {
  editMessages: true,
  pinMessages: true,
  tappableOptions: true,
  attachments: true,
  threadedReplies: true,
  activityIndicator: true,
  maxMessageChars: MAX_MESSAGE_LEN,
  markupDialect: 'telegramHtml',
};

/** Telegram's inline-button label cap; a longer label is elided, not rejected. */
const optionLabelMaxChars = 40;

/**
 * @description Render the core's options as a one-button-per-row inline
 * keyboard. Labels are elided to Telegram's practical button width — the full
 * text is still readable in the message body, which always enumerates the
 * options.
 */
export function buildOptionsKeyboard(options: OutboundOption[]): InlineKeyboardMarkup | undefined {
  if (options.length === 0) return undefined;
  return {
    inline_keyboard: options.map((option) => [
      {
        text:
          option.label.length > optionLabelMaxChars
            ? `${option.label.slice(0, optionLabelMaxChars - 3)}...`
            : option.label,
        callback_data: option.id,
      },
    ]),
  };
}

/**
 * @description Bot primitives the Telegram outbound routes through, injected as
 * closures so this module never imports `bot.ts` (a cycle) and stays testable
 * without a live Telegraf instance.
 */
export interface TelegramOutboundDeps {
  /**
   * The boot-selected chat-mode transport. Read lazily (not captured) because
   * it is registered later in the boot sequence than this connector.
   */
  getOutputTransport: () => OutputTransport;
  /**
   * Send `text` as its OWN message — HTML-rendered with a plain-text retry, with
   * an optional inline keyboard. Resolves the message id, or `null` when both
   * attempts failed.
   */
  sendStandaloneMessage: (
    key: SessionKey,
    text: string,
    replyMarkup?: InlineKeyboardMarkup,
  ) => Promise<number | null>;
  /** Pin a message so a muted topic still fires a notification. */
  pinMessage: (key: SessionKey, messageId: number) => Promise<void>;
  /** Start (`true`) or stop (`false`) the repeating `sendChatAction('typing')` loop. */
  setTypingLoader: (key: SessionKey, isActive: boolean) => void;
  /** One `sendChatAction('typing')`, no loop — a booting session that has nothing to stream. */
  sendTypingPing: (key: SessionKey) => void;
  /** The reusable file-send service, already composed with the Telegram gateway. */
  sendFiles: SendFilesToThread;
  /** Serialize a key for the string-keyed file-send service. */
  encodeKey: (key: SessionKey) => string;
}

export function createTelegramConnectorOutbound(deps: TelegramOutboundDeps): ConnectorOutbound {
  /**
   * A message the core wants kept prominent (a question) must NOT ride the
   * coalescing output cursor: it needs its own id to pin and to reply to. Land
   * whatever is in flight ABOVE it first, mirroring what the question paths did
   * inline before the seam existed.
   */
  async function deliverStandalone(key: SessionKey, content: OutboundContent): Promise<void> {
    await deps.getOutputTransport().finalizeInFlight(key);
    const keyboard = content.options ? buildOptionsKeyboard(content.options) : undefined;
    const messageId = await deps.sendStandaloneMessage(key, content.text, keyboard);
    if (messageId === null) return;
    if (content.keepVisible) await deps.pinMessage(key, messageId);
  }

  return {
    capabilities: telegramCapabilities,

    async deliver(key: SessionKey, content: OutboundContent, hints?: OutboundHints): Promise<void> {
      // Degrade FIRST, through the shared rule every connector applies, so the
      // branches below never have to ask what this surface supports. Telegram
      // supports everything, so this is the identity case — which is exactly
      // why the degraded side needs the test double to be reachable at all.
      const deliverable = getDegradedContent(content, telegramCapabilities);
      // Anything still marked prominent (`keepVisible`) or interactive
      // (`options`) needs a message of its own; ordinary turn content streams
      // through the chat-mode transport.
      if (checkNeedsOwnMessage(deliverable)) {
        await deliverStandalone(key, deliverable);
        return;
      }
      deps.getOutputTransport().deliverOutput(key, deliverable.text, hints);
    },

    deliverFile(key: SessionKey, request: OutboundFileRequest): Promise<OutboundFileResult> {
      return deps.sendFiles(deps.encodeKey(key), request);
    },

    setActivity(key: SessionKey, activity: ActivityState): void {
      if (activity === 'starting') {
        deps.sendTypingPing(key);
        return;
      }
      deps.setTypingLoader(key, activity === 'working');
    },

    finalize(key: SessionKey): Promise<void> {
      return deps.getOutputTransport().finalizeInFlight(key);
    },

    dispose(key: SessionKey): void {
      deps.getOutputTransport().disposeThread(key);
    },

    checkIsDelivering(key: SessionKey): boolean {
      return deps.getOutputTransport().checkIsStreaming(key);
    },

    listUnfinalizedKeys(): SessionKey[] {
      return deps.getOutputTransport().getInFlightThreadKeys();
    },
  };
}
