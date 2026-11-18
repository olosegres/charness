/**
 * @description The pure decision behind «a conversation hit its usage limit — may it move on, and where to»
 * (`bot.ts` `planFallbackSwitch` wires it): the candidates (the operator's fallback chain, or, with none, the ranking of the
 * signed-in Claude accounts — `utils/claudeLimitSwitch.ts`), then auto / offer / none (`decideFallbackSwitch`), and the rungs a
 * wait with nothing to switch to may be aimed at.
 *
 * WHO it applies to. A Telegram topic takes all of it. A conversation of another platform (a Jira issue; no `checkIsTelegramKey`)
 * takes the AUTOMATIC move between Claude accounts only: the chain's Claude rungs (an OpenCode rung is a cross-backend hand-over
 * that has no surface outside Telegram; a list with no Claude rung restricts no account, as for agents —
 * `getClaudeLaunchChainScope`), never the offer (its «🔁 Switch to …» buttons are a topic's) and never the wait aimed at the rung
 * that resets first (the retry kick moves only a Telegram topic there). With auto-switch OFF, with no account free, or on OpenCode
 * such a conversation waits for the reset as it always did.
 *
 * No I/O, no `Date.now()`: the caller passes the clock and the detection, so every rule is unit-tested.
 */

import { pickClaudeLimitSwitchCandidates } from './claudeLimitSwitch';
import {
  decideFallbackSwitch,
  pickFallbackCandidates,
  type FallbackChainEntry,
  type FallbackDetection,
  type FallbackSwitchPlan,
} from './fallbackChain';

/**
 * @description Whether a usage limit on a conversation that runs on the rung `from` leads to a switch decision at all: in a Telegram
 * topic any rung does, elsewhere only a Claude account (the caller has already dropped a conversation with no rung to leave — a
 * terminal, no agent, an OpenCode server on its default model).
 */
export function checkIsLimitSwitchPossible(isTelegram: boolean, from: FallbackChainEntry): boolean {
  return isTelegram || from.backend === 'claude';
}

export interface LimitSwitchDecision {
  plan: FallbackSwitchPlan;
  /**
   * When `plan` is `none`: the rungs the armed wait may be re-aimed at — the one whose limit resets EARLIEST (`pickEarliestResetRung`).
   * The operator's whole chain, else the signed-in SUBSCRIPTIONS (an account billed to API credits never ends a wait by itself).
   * Empty outside Telegram and whenever the plan is not `none`.
   */
  waitRungs: FallbackChainEntry[];
}

/**
 * @description What the usage limit of the rung `from` leads to. `chain` is the operator's fallback chain as stored (empty = none);
 * `detection` has the profile views and the catalog, `nowMs` the clock. The limited rung is already marked by the caller.
 */
export function decideLimitSwitch(input: {
  isTelegram: boolean;
  from: FallbackChainEntry;
  chain: readonly FallbackChainEntry[];
  detection: FallbackDetection;
  isAutoSwitchEnabled: boolean;
  nowMs: number;
}): LimitSwitchDecision {
  const { isTelegram, from, detection, nowMs } = input;
  const explicit = isTelegram ? input.chain : input.chain.filter((entry) => entry.backend === 'claude');
  // Without a configured chain a Claude conversation falls back to the within-Claude ranking (the soonest weekly reset first).
  const ranked = explicit.length === 0 && from.backend === 'claude'
    ? pickClaudeLimitSwitchCandidates({ profiles: detection.claudeProfiles, currentName: from.profile, model: from.model, nowMs })
      .map((profile): FallbackChainEntry => ({ backend: 'claude', profile, model: null }))
    : explicit;
  const candidates = pickFallbackCandidates({ chain: ranked, current: from, detection, nowMs });
  const decided = decideFallbackSwitch({ candidates, isAutoSwitchEnabled: input.isAutoSwitchEnabled });
  const plan: FallbackSwitchPlan = !isTelegram && decided.action === 'offer' ? { action: 'none' } : decided;
  if (plan.action !== 'none' || !isTelegram) return { plan, waitRungs: [] };
  const implicit = from.backend === 'claude'
    ? detection.claudeProfiles
      .filter((profile) => profile.loggedIn !== false && profile.billing !== 'api')
      .map((profile): FallbackChainEntry => ({ backend: 'claude', profile: profile.name, model: null }))
    : [];
  return { plan, waitRungs: explicit.length > 0 ? [...explicit] : implicit };
}
