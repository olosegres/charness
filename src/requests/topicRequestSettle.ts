import type { SessionKey } from '../sessionKey';
import type { LatePromptOutcome } from '../utils/promptDelivery';

/**
 * @description What a topic request is settled by once its prompt has come back from the prompt path (S7): a prompt that reached a
 * session — or waits behind its start — has its turn tracked by the wake-up engine; one that found NO session (it waited for a bot
 * restart's replay and the person was told) closes the request it opened, so the engine never prods the agent for a turn that
 * never started. A module of its own, over ports, so both outcomes are tested for real; `bot.ts` wires the engine and the ledger.
 */

/** The part of a request's opening the settle needs: its id, `null` when no request was opened (a slash command, requests off). */
export interface TopicRequestRef {
  requestId: string | null;
}

export interface TopicRequestSettlePorts {
  /** The wake-up engine starts watching the turn the request's prompt began (`trackForwardedTurn`, as a request prompt). */
  trackTurn: (key: SessionKey, requestId: string) => Promise<void>;
  /** The ledger closes the request as cancelled (`closeRequest(id, 'cancelled')`). */
  cancelRequest: (requestId: string) => Promise<void>;
  warn: (message: string) => void;
}

export interface TopicRequestSettler {
  /**
   * The request's prompt was handed to the prompt path (forwarded, or buffered behind a session start — the turn probe holds a
   * starting session, so tracking now is right either way). Fire and forget: a failed track is logged, never thrown.
   */
  trackTurn: (key: SessionKey, opening: TopicRequestRef) => void;
  /** The prompt came back from the prompt path with `delivery`: track its turn, or close the request when no session took it. */
  settleAfterDelivery: (key: SessionKey, opening: TopicRequestRef, delivery: LatePromptOutcome) => Promise<void>;
}

export function createTopicRequestSettler(ports: TopicRequestSettlePorts): TopicRequestSettler {
  const trackTurn = (key: SessionKey, opening: TopicRequestRef): void => {
    const { requestId } = opening;
    if (requestId === null) return;
    ports.trackTurn(key, requestId).catch((error) =>
      ports.warn(`[requests] tracking the turn of ${requestId} failed: ${error instanceof Error ? error.message : error}`),
    );
  };

  const settleAfterDelivery = async (key: SessionKey, opening: TopicRequestRef, delivery: LatePromptOutcome): Promise<void> => {
    if (delivery !== 'noSession') {
      trackTurn(key, opening);
      return;
    }
    const { requestId } = opening;
    if (requestId === null) return;
    await ports.cancelRequest(requestId).catch((error) =>
      ports.warn(`[requests] closing the request ${requestId} of a prompt that found no session failed: ${error instanceof Error ? error.message : error}`),
    );
  };

  return { trackTurn, settleAfterDelivery };
}
