import { redeemReplySchema, type RedeemReply } from '../runners/gateProtocol';
import { connectToHub, HubConnectionError, requestGateJson, type HubEndpoint } from './hubClient';
import type { RunnerKeys } from './runnerKeys';

/**
 * @description Getting a pairing back whose answer was lost. The hub commits a redemption — the runner is registered, the code's
 * temporary key is deleted — BEFORE the runner has the answer and writes `config.json`. If the answer never arrives (the connection
 * drops, the process dies), the temporary key cannot be used again and a fresh code is refused (the runner's own key is already
 * registered). What can still ask is the runner's PERMANENT key, so the runner writes `pairing.json` before it redeems and, whenever it
 * finds that file without a `config.json`, asks the gate for its `identity`: the very answer `redeem` gave. A key the hub does not
 * know is the other answer — nothing was committed, the half-done pairing is dropped.
 */

export type RecoveryOutcome =
  /** The hub has this runner: here is what `redeem` answered. */
  | { kind: 'recovered'; reply: Extract<RedeemReply, { ok: true }> }
  /** The hub does not know this key (or no longer): nothing was committed there. */
  | { kind: 'not-registered' }
  /** The hub could not be asked right now; try again later. */
  | { kind: 'unreachable'; message: string };

/** @description Ask the hub, with the runner's own key, what it knows of this runner. */
export async function recoverPairing(endpoint: HubEndpoint, keys: RunnerKeys): Promise<RecoveryOutcome> {
  try {
    const client = await connectToHub(endpoint, keys.client.privateKey);
    try {
      const reply = await requestGateJson(client, 'identity', null, redeemReplySchema);
      return reply.ok ? { kind: 'recovered', reply } : { kind: 'not-registered' };
    } finally {
      client.end();
    }
  } catch (error) {
    if (error instanceof HubConnectionError && error.failure === 'auth') return { kind: 'not-registered' };
    return { kind: 'unreachable', message: error instanceof Error ? error.message : 'could not reach the hub' };
  }
}
