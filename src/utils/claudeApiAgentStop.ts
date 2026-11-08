/**
 * @description What the bot does when an AGENT reports that its worker stopped on an account billed to API credits
 * (`claude_profiles` called with `currentProfile` + `isStoppedByLimit`). The bot cannot see WHY the worker stopped — the
 * report is the agent's own reading — and an API account has limits besides the balance (a per-minute rate limit of a low
 * tier, an overload, a misread error), so the report alone never marks the credit used up: that mark keeps every new
 * worker off the free credit for a day. Instead ONE tiny request on the account's own key (`probeClaudeApiCredit`, the
 * daily recheck's probe) asks the API:
 *
 *   • refused for the balance → the credit IS used up: `creditExhaustedAt` is marked (the daily recheck lifts it when the
 *     credit is back — the probe worked, so the key is one the recheck can read);
 *   • answered, no key the bot can read, the probe's model gone, or no conclusion → the stop was something else (or cannot
 *     be told): the account is only kept off AGENTS for {@link claudeApiAgentStopHoldMs} (`agentHoldUntil`, a field of its own —
 *     `limitedUntil` is the topics' mark and an unproven report must not move a topic), which expires by itself — nothing here
 *     can leave an account out for good. An answer (2xx) on an account whose renewal is still awaited
 *     (`creditUnconfirmedSince`) also records the renewal, as the daily recheck would.
 *
 * The attempt is recorded (`creditRecheckedAt`) BEFORE the request, like the daily recheck, and ONE log line says what the
 * report led to. The probe has a timeout of its own, shorter than the answer's budget, and runs beside the usage refresh.
 *
 * Pure over its ports, so the whole decision is unit-tested without the network or the state file.
 */

import type { ClaudeProfileUsageView } from './claudeUsage';
import { claudeApiCreditProbeModel, type ClaudeApiCreditProbeOutcome } from './claudeApiCreditRecheck';

const hourMs = 3_600_000;

/** How long an account an agent reported stopped stays off AGENTS when the probe did not prove the balance used up. */
export const claudeApiAgentStopHoldMs = hourMs;

/** The probe's own timeout: shorter than the 10 s the `claude_profiles` answer may take, so the answer is never held past it. */
export const claudeApiAgentStopProbeTimeoutMs = 6_000;

/**
 * @description The API account an agent's stop report is about, `null` when there is nothing to check: no stop reported, the
 * account is unknown or not billed to API credits (a subscription has windows and its own limit handling), or it is already out
 * of the agents' reach (marked used up, or held off by an earlier report — a repeated report must not probe again).
 */
export function getApiProfileStoppedByAgent(
  views: readonly ClaudeProfileUsageView[],
  query: { currentProfile: string | null; isStoppedByLimit: boolean },
  nowMs: number,
): string | null {
  if (!query.isStoppedByLimit || query.currentProfile === null) return null;
  const stopped = views.find((view) => view.name === query.currentProfile);
  if (stopped === undefined || stopped.billing !== 'api' || stopped.creditExhaustedAt !== null) return null;
  const heldUntilMs = stopped.agentHoldUntil ? Date.parse(stopped.agentHoldUntil) : Number.NaN;
  return Number.isFinite(heldUntilMs) && heldUntilMs > nowMs ? null : stopped.name;
}

/** What the check needs from the bot. */
export interface ClaudeApiAgentStopPorts {
  nowMs: () => number;
  /** The key the profile's own sessions use; `null` = none the bot can read. */
  readApiKey: (name: string) => string | null;
  probe: (apiKey: string, timeoutMs: number) => Promise<ClaudeApiCreditProbeOutcome>;
  /** Persist that a check of `name` was ATTEMPTED at `atIso` (before the request goes out). */
  markRechecked: (name: string, atIso: string) => void;
  /** The API refused for the balance: mark `name`'s credit used up at `atIso`. */
  markUsedUp: (name: string, atIso: string) => void;
  /** Keep `name` off AGENTS until `untilIso` (its own field — never the topics' limit mark). */
  holdOff: (name: string, untilIso: string) => void;
  /** Whether `name` carries a refusal the operator acted on that nothing has confirmed yet (`creditUnconfirmedSince`): the credit's renewal is still awaited. */
  checkIsRenewalAwaited: (name: string) => boolean;
  /** The API answered an account whose renewal was awaited: record the renewal at `atIso` (the daily recheck's `onRenewed`). */
  onRenewed: (name: string, atIso: string) => void;
  log: (line: string) => void;
  /** A line that must not be missed: the probe cannot work until someone updates its model. */
  warn: (line: string) => void;
}

/** What the report led to. */
export type ClaudeApiAgentStopResult = 'markedUsedUp' | 'heldOff';

/**
 * @description Check an agent's stop report on the API account `name` (see the module): probe once, mark the credit used up only
 * on a refusal for the balance, hold the account off for an hour on any other answer. Never throws on a failed probe.
 */
export async function verifyClaudeApiAgentStop(name: string, ports: ClaudeApiAgentStopPorts): Promise<ClaudeApiAgentStopResult> {
  const startedIso = new Date(ports.nowMs()).toISOString();
  ports.markRechecked(name, startedIso);
  const apiKey = ports.readApiKey(name);
  const outcome: ClaudeApiCreditProbeOutcome | { kind: 'noKey' } = apiKey === null
    ? { kind: 'noKey' }
    : await ports.probe(apiKey, claudeApiAgentStopProbeTimeoutMs);
  const nowMs = ports.nowMs();
  if (outcome.kind === 'stillUsedUp') {
    ports.markUsedUp(name, new Date(nowMs).toISOString());
    ports.log(`[credit] ${name}: an agent reported a stop and the API refuses the account for its balance — marked used up`);
    return 'markedUsedUp';
  }
  ports.holdOff(name, new Date(nowMs + claudeApiAgentStopHoldMs).toISOString());
  const held = `kept off agents for ${claudeApiAgentStopHoldMs / hourMs} h`;
  if (outcome.kind === 'noKey') {
    ports.log(`[credit] ${name}: an agent reported a stop; the bot can read no API key for the account to check its balance — ${held}`);
  } else if (outcome.kind === 'renewed') {
    // The probe proved the credit is back: an account still waiting for its renewal records it now, or the attempt above
    // would push the daily recheck (which would have recorded it) a day further. A never-refused account has no renewal to record.
    const isRenewalRecorded = ports.checkIsRenewalAwaited(name);
    if (isRenewalRecorded) ports.onRenewed(name, new Date(nowMs).toISOString());
    ports.log(`[credit] ${name}: an agent reported a stop but the API answers the account — the balance is not the cause${isRenewalRecorded ? ' (the credit is back: renewal recorded)' : ''}; ${held}`);
  } else if (outcome.kind === 'modelNotFound') {
    ports.warn(`[credit] ${name}: an agent reported a stop; the check's model "${claudeApiCreditProbeModel}" was not found by the API (404) — update claudeApiCreditProbeModel; ${held}`);
  } else {
    ports.log(`[credit] ${name}: an agent reported a stop; the check gave no answer about the balance (${outcome.reason}) — ${held}`);
  }
  return 'heldOff';
}
