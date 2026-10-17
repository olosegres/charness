/**
 * @description The pure decision behind the ONE switch path the operator's own picks share — a row of `/limits` or
 * `/accounts`, a model page, `/accounts use`: given where the topic runs and where it was told to go, WHICH kind of
 * move it is. `bot.ts` (`switchTopicByOperator`) makes the move; the screens only ask for it and word their toast
 * from the outcome.
 */

import type { FallbackChainEntry } from './fallbackChain';
import { checkIsSameFallbackAccount } from './fallbackChain';
import type { BackendFamily } from './backendSwitchPlan';

/**
 * How the topic gets to the picked rung:
 *   - `limitMove`  — a usage-limit wait is armed: the pick is the limit move (the wait is dropped, the work continues,
 *                    a conversation is handed over without the question);
 *   - `sameFamily` — the topic stays on the backend it runs (or has none, and a Claude account is only recorded for
 *                    its next start): a Claude pick changes the account, an OpenCode pick the model — the conversation is kept;
 *   - `askFirst`   — the other backend, with a conversation to hand over: the operator is asked first;
 *   - `switchNow`  — the other backend with nothing to carry (or no agent yet): the target is started at once.
 */
export type OperatorSwitchRoute = 'limitMove' | 'sameFamily' | 'askFirst' | 'switchNow';

/**
 * What a screen is told about a pick. `switched` carries the line to show (a toast, whole-text safe); `asked` means
 * the hand-over question is already in the topic and nothing more is to be said; `refused` carries why nothing moved.
 */
export type OperatorSwitchOutcome =
  | { kind: 'switched'; text: string }
  | { kind: 'asked' }
  | { kind: 'refused'; text: string };

export interface OperatorSwitchInput {
  /** A usage-limit wait is armed for the topic. */
  isUsageLimitWaitArmed: boolean;
  /** The rung the topic runs on now; `null` for no agent, a shell, or an OpenCode on the server's default model. */
  from: FallbackChainEntry | null;
  to: FallbackChainEntry;
  /** The backend family the topic's agent runs on; `null` for no agent or a shell. */
  currentFamily: BackendFamily | null;
  /** Whether the agent being left holds a conversation to hand over (only read when the families differ). */
  hasConversation: boolean;
}

/**
 * @description The route of a pick, in this order:
 *   1. a wait is armed and the pick leaves the account (Claude) / model (OpenCode) that hit the limit → `limitMove`;
 *   2. the topic runs no agent of a family (nothing, a shell): a Claude pick is recorded for the next start
 *      (`sameFamily`), an OpenCode pick starts OpenCode on it (`switchNow`);
 *   3. the topic runs the picked family → `sameFamily`;
 *   4. otherwise the other backend: `askFirst` with a conversation, `switchNow` without.
 */
export function decideOperatorSwitch(input: OperatorSwitchInput): OperatorSwitchRoute {
  const { from, to, currentFamily } = input;
  const isLeavingLimitedRung = from === null || !checkIsSameFallbackAccount(from, to);
  if (input.isUsageLimitWaitArmed && currentFamily !== null && isLeavingLimitedRung) return 'limitMove';
  if (currentFamily === null) return to.backend === 'claude' ? 'sameFamily' : 'switchNow';
  if (currentFamily === to.backend) return 'sameFamily';
  return input.hasConversation ? 'askFirst' : 'switchNow';
}
