/**
 * @description An in-repo connector used ONLY by tests.
 *
 * Telegram declares every capability `true`, so without a second connector the
 * degraded paths — the entire point of capability negotiation — are unreachable
 * and therefore untested. This double lets a test declare any capability set
 * and then assert what the core actually got: which content was split, which
 * options survived, whether a pin was honoured.
 *
 * It is a TEST DOUBLE, not a surface: nothing is transmitted anywhere, and no
 * production module may import it. The boundary guard does not police this
 * directory because it imports no platform library at all.
 */

import type { SessionKey } from '../../sessionKey';
import { keyToString } from '../../sessionKey';
import { getDegradedContent, checkNeedsOwnMessage } from '../../platform/capabilityFallback';
import type {
  ConnectorInbound,
  InboundEvent,
  InboundEventHandler,
} from '../../platform/inbound';
import type {
  ActivityState,
  ConnectorCapabilities,
  ConnectorOutbound,
  OutboundContent,
  OutboundFileRequest,
  OutboundFileResult,
  OutboundHints,
} from '../../platform/outbound';

/**
 * @description The deliberately POOR surface: no editing, no pins, no tappable
 * controls, no attachments, no threads, no activity affordance, a small message
 * cap and plain text. Roughly the shape of a tracker comment stream, which is
 * the first real connector this degradation has to survive.
 */
export const minimalCapabilities: ConnectorCapabilities = {
  editMessages: false,
  pinMessages: false,
  tappableOptions: false,
  attachments: false,
  threadedReplies: false,
  activityIndicator: false,
  maxMessageChars: 40,
  markupDialect: 'plain',
};

/** The opposite pole: everything supported, matching Telegram's declaration. */
export const richCapabilities: ConnectorCapabilities = {
  editMessages: true,
  pinMessages: true,
  tappableOptions: true,
  attachments: true,
  threadedReplies: true,
  activityIndicator: true,
  maxMessageChars: 4000,
  markupDialect: 'markdown',
};

/** One recorded delivery, as the connector actually resolved it. */
export interface RecordedDelivery {
  key: SessionKey;
  /** The message bodies after the connector's own splitting at `maxMessageChars`. */
  chunks: string[];
  /** Options the surface really offered as controls — empty when degraded away. */
  offeredOptionIds: string[];
  /** Whether the message was actually kept prominent. */
  wasKeptVisible: boolean;
  /** Whether it got a message of its own rather than joining the stream. */
  wasOwnMessage: boolean;
  hints?: OutboundHints;
}

export interface TestConnector extends ConnectorOutbound, ConnectorInbound {
  readonly deliveries: RecordedDelivery[];
  readonly files: OutboundFileRequest[];
  readonly activity: { key: SessionKey; state: ActivityState }[];
  readonly finalized: string[];
  readonly disposed: string[];
  /** Push an event as if it had arrived from the surface. */
  emit(event: InboundEvent): Promise<void>;
}

/**
 * @description Split at the surface's own cap. Crude on purpose — the point is
 * to prove the core's content SURVIVES a small cap, not to re-test Telegram's
 * word-aware splitter.
 */
function splitAtCap(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += maxChars) {
    chunks.push(text.slice(offset, offset + maxChars));
  }
  return chunks;
}

export function createTestConnector(
  capabilities: ConnectorCapabilities = minimalCapabilities,
): TestConnector {
  const deliveries: RecordedDelivery[] = [];
  const files: OutboundFileRequest[] = [];
  const activity: { key: SessionKey; state: ActivityState }[] = [];
  const finalized: string[] = [];
  const disposed: string[] = [];
  const unfinalized = new Set<string>();
  let onEvent: InboundEventHandler | null = null;

  return {
    capabilities,
    deliveries,
    files,
    activity,
    finalized,
    disposed,

    async deliver(key: SessionKey, content: OutboundContent, hints?: OutboundHints): Promise<void> {
      const degraded = getDegradedContent(content, capabilities);
      deliveries.push({
        key,
        chunks: splitAtCap(degraded.text, capabilities.maxMessageChars),
        offeredOptionIds: (degraded.options ?? []).map((option) => option.id),
        wasKeptVisible: degraded.keepVisible === true,
        wasOwnMessage: checkNeedsOwnMessage(degraded),
        hints,
      });
      if (hints?.isFinal !== true) unfinalized.add(keyToString(key));
    },

    async deliverFile(
      key: SessionKey,
      request: OutboundFileRequest,
    ): Promise<OutboundFileResult> {
      // Fail LOUDLY rather than pretending: an agent told "sent" for a file the
      // surface cannot carry would never retry or describe it in text instead.
      if (!capabilities.attachments) {
        return { ok: false, error: 'this surface cannot receive file attachments' };
      }
      files.push(request);
      return { ok: true, summary: `Sent ${request.paths.length} file(s) to ${keyToString(key)}.` };
    },

    setActivity(key: SessionKey, state: ActivityState): void {
      // A surface with no "working" affordance drops it silently — the core
      // must not have to know which surfaces have one.
      if (!capabilities.activityIndicator) return;
      activity.push({ key, state });
    },

    async finalize(key: SessionKey): Promise<void> {
      const serialized = keyToString(key);
      finalized.push(serialized);
      unfinalized.delete(serialized);
    },

    dispose(key: SessionKey): void {
      const serialized = keyToString(key);
      disposed.push(serialized);
      unfinalized.delete(serialized);
    },

    checkIsDelivering(key: SessionKey): boolean {
      return unfinalized.has(keyToString(key));
    },

    listUnfinalizedKeys(): SessionKey[] {
      const seen = new Map<string, SessionKey>();
      for (const delivery of deliveries) {
        const serialized = keyToString(delivery.key);
        if (unfinalized.has(serialized)) seen.set(serialized, delivery.key);
      }
      return [...seen.values()];
    },

    async start(handler: InboundEventHandler): Promise<void> {
      onEvent = handler;
    },

    async stop(): Promise<void> {
      onEvent = null;
    },

    async listMembersWithElevatedRights(): Promise<string[]> {
      return [];
    },

    async emit(event: InboundEvent): Promise<void> {
      if (!onEvent) return;
      await onEvent(event);
    },
  };
}
