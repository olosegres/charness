import { keyToString, type SessionKey } from '../sessionKey';
import type { AgentAdapter } from '../types';

/**
 * How long a forward waits for an adopted session's replay before it goes out anyway. The first poll after an adopt
 * comes in 300 ms and reads the whole downtime tail at once; this only bounds a tail that cannot be read, so a prompt is
 * never held for good behind a session that never settles.
 */
export const adoptReplayGateMaxWaitMs = 30_000;

/**
 * @description The wait before a prompt is forwarded to a session: an adopted one first replays what its process wrote
 * while the bot was down. A prompt written meanwhile resets the answer and the error slot the replayed frames still use,
 * so the replayed text would join the new reply's message and a replayed error would take the new turn's slot. Settles at
 * once for a session that was not adopted and for an adapter that never adopts. `maxWaitMs` is a test seam.
 */
export async function waitForAdoptedReplay(
  adapter: Pick<AgentAdapter, 'whenAdoptReplayed'>,
  key: SessionKey,
  maxWaitMs = adoptReplayGateMaxWaitMs,
): Promise<void> {
  if (!adapter.whenAdoptReplayed) return;
  let timer: NodeJS.Timeout | undefined;
  let outcome: 'replayed' | 'timedOut';
  try {
    outcome = await Promise.race([
      adapter.whenAdoptReplayed(key).then(() => 'replayed' as const),
      new Promise<'timedOut'>((resolve) => { timer = setTimeout(() => resolve('timedOut'), maxWaitMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (outcome === 'timedOut') console.warn(`[adopt] ${keyToString(key)}: the replay of the downtime tail did not finish in ${maxWaitMs} ms; the prompt goes out without waiting`);
}
