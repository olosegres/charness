/**
 * @description The pure decision behind «a conversation hit its usage limit — may it move on, and where to»
 * (`bot.ts` `planFallbackSwitch` wires it): the candidates (the operator's fallback chain, or, with none, the ranking of the
 * signed-in Claude accounts — `utils/claudeLimitSwitch.ts`), then auto / offer / none (`decideFallbackSwitch`), and the rung a
 * wait with nothing to switch to is aimed at.
 *
 * WHO it applies to. A Telegram topic takes all of it. A conversation of another platform (a Jira issue; no `checkIsTelegramKey`)
 * takes the AUTOMATIC moves between Claude accounts only: the chain's Claude rungs (an OpenCode rung is a cross-backend hand-over
 * that has no surface outside Telegram; a list with no Claude rung restricts no account, as for agents —
 * `getClaudeLaunchChainScope`), never the offer (its «🔁 Switch to …» buttons are a topic's). With no account free it waits for
 * the Claude account whose limit resets EARLIEST and the retry kick moves it there — the same automatic move, made later. With
 * auto-switch OFF it waits for its own account's reset, and on OpenCode it has nothing to decide.
 *
 * No I/O, no `Date.now()`: the caller passes the clock and the detection, so every rule is unit-tested.
 */

import { pickClaudeLimitSwitchCandidates } from './claudeLimitSwitch';
import {
  decideFallbackSwitch,
  pickEarliestResetRung,
  pickFallbackCandidates,
  type FallbackChainEntry,
  type FallbackDetection,
  type FallbackSwitchPlan,
} from './fallbackChain';

/**
 * @description Whether the rung `rung` can take part in a usage-limit move at all — as the one a conversation runs on when the limit
 * hits (does it lead to a switch decision), or as the one it moves onto, now or when a wait aimed at it ends: in a Telegram topic any
 * rung, elsewhere only a Claude account — a hand-over to OpenCode has no surface outside Telegram. (The caller has already dropped a
 * conversation with no rung to leave — a terminal, no agent, an OpenCode server on its default model.)
 */
export function checkIsLimitSwitchPossible(isTelegram: boolean, rung: FallbackChainEntry): boolean {
  return isTelegram || rung.backend === 'claude';
}

/** The rung a usage-limit wait is re-aimed at — the one whose limit resets first — and when that limit ends. */
export interface LimitWaitTarget {
  entry: FallbackChainEntry;
  untilMs: number;
}

export interface LimitSwitchDecision {
  plan: FallbackSwitchPlan;
  /**
   * When `plan` is `none`: ANOTHER rung whose limit resets EARLIEST (`pickEarliestResetRung`), so the armed wait ends there and the
   * retry kick moves the conversation onto it; `null` when the conversation's own rung resets first (or within a minute of the first)
   * or no other one names a reset. Picked from the operator's chain (outside Telegram its Claude rungs), else the signed-in
   * SUBSCRIPTIONS (an account billed to API credits never ends a wait by itself). Always `null` when the plan is not `none`, and
   * outside Telegram with auto-switch OFF: there the wait's end moves the conversation by itself, which that switch forbids.
   */
  waitTarget: LimitWaitTarget | null;
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
  const explicit = input.chain.filter((entry) => checkIsLimitSwitchPossible(isTelegram, entry));
  // Without a configured chain a Claude conversation falls back to the within-Claude ranking (the soonest weekly reset first).
  const ranked = explicit.length === 0 && from.backend === 'claude'
    ? pickClaudeLimitSwitchCandidates({ profiles: detection.claudeProfiles, currentName: from.profile, model: from.model, nowMs })
      .map((profile): FallbackChainEntry => ({ backend: 'claude', profile, model: null }))
    : explicit;
  const candidates = pickFallbackCandidates({ chain: ranked, current: from, detection, nowMs });
  const decided = decideFallbackSwitch({ candidates, isAutoSwitchEnabled: input.isAutoSwitchEnabled });
  const plan: FallbackSwitchPlan = !isTelegram && decided.action === 'offer' ? { action: 'none' } : decided;
  if (plan.action !== 'none' || (!isTelegram && !input.isAutoSwitchEnabled)) return { plan, waitTarget: null };
  const implicit = from.backend === 'claude'
    ? detection.claudeProfiles
      .filter((profile) => profile.loggedIn !== false && profile.billing !== 'api')
      .map((profile): FallbackChainEntry => ({ backend: 'claude', profile: profile.name, model: null }))
    : [];
  const waitRungs = explicit.length > 0 ? explicit : implicit;
  const found = waitRungs.length > 0 ? pickEarliestResetRung({ chain: waitRungs, current: from, detection, nowMs }) : null;
  return { plan, waitTarget: found && !found.isCurrent ? { entry: found.entry, untilMs: found.untilMs } : null };
}
