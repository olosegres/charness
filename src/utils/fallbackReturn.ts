/**
 * @description The «back» half of a usage-limit switch (`utils/fallbackChain.ts`): the topic remembers the rung the
 * bot moved it FROM, so `/accounts` can offer one button that moves it back there (`bot.ts`
 * `returnTopicToFallbackOrigin`, through the same move the limit switch uses). This module is the pure part: what
 * is persisted and how it reads back, the button's `callback_data`, and which manual changes of a topic make the
 * remembered rung stale.
 *
 * The rung is stored as the topic's position was read at the switch, so a Claude rung keeps the model id the
 * session REPORTED (`claude-opus-5-5[1m]`) — a chain alias pattern would reject it. No I/O, no clock.
 */

import type { ClaudeConfigDirApplyResult } from '../adapters/claudeConfigDir';
import { checkIsValidClaudeProfileName, defaultClaudeProfileName } from './claudeProfiles';
import { getFallbackChainRevision, normaliseFallbackChain, type FallbackChainEntry } from './fallbackChain';

/** A reported Claude model id is short; anything longer is not one and is dropped (the topic keeps its model). */
const returnModelMaxLength = 100;

const returnCallbackPrefix = 'acct_ret_';

/** The «back» button of `/accounts`: `acct_ret_<revision>` (8 hex digits), well under Telegram's 64-byte cap. */
export const fallbackReturnCallbackRe = new RegExp(`^${returnCallbackPrefix}([0-9a-f]{8})$`);

/**
 * @description The rung as `state.json` may hold it, or `null` when it is malformed (a hand edit, an older shape).
 * A Claude rung keeps the reported model id as it is (a non-string or over-long one becomes "keep the topic's
 * model"); an OpenCode rung is the chain's own shape.
 */
export function normaliseFallbackReturn(raw: unknown): FallbackChainEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  if ('backend' in raw && raw.backend === 'claude') {
    const profile = 'profile' in raw ? raw.profile : undefined;
    if (typeof profile !== 'string' || (profile !== defaultClaudeProfileName && !checkIsValidClaudeProfileName(profile))) return null;
    const model = 'model' in raw ? raw.model : undefined;
    return { backend: 'claude', profile, model: typeof model === 'string' && model.length > 0 && model.length <= returnModelMaxLength ? model : null };
  }
  return normaliseFallbackChain([raw])[0] ?? null;
}

/** The button's `callback_data` for the remembered rung: it bakes the rung's revision, so an old keyboard cannot act on a newer one. */
export function buildFallbackReturnCallback(origin: FallbackChainEntry): string {
  return `${returnCallbackPrefix}${getFallbackChainRevision([origin])}`;
}

/** Whether a tap's revision still names the remembered rung (`false`: nothing remembered, or another rung now). */
export function checkIsFallbackReturnCurrent(origin: FallbackChainEntry | null, revision: string): boolean {
  return origin !== null && getFallbackChainRevision([origin]) === revision;
}

/** A change of the topic made by hand — the ones that make the remembered rung stale. */
export type ManualRungChange =
  | { kind: 'accountPick'; outcome: ClaudeConfigDirApplyResult | 'restartRequired'; isClaudeBackend: boolean }
  | { kind: 'modelPick' }
  | { kind: 'backendSwitch'; isSameConversation: boolean };

/**
 * @description Whether a manual change makes the remembered rung stale, so it is forgotten and the button goes:
 *   • an account pick that moved the session (re-spawned now or when the answer ends), or that a sleeping Claude
 *     topic will take at its next resume — a pick that changed nothing (`unchanged`) or only recorded itself because
 *     the topic runs another backend leaves it;
 *   • any model pick;
 *   • a switch to another agent (a flip between the two Claude backends keeps the conversation and the rung).
 */
export function checkIsFallbackReturnForgotten(change: ManualRungChange): boolean {
  switch (change.kind) {
    case 'accountPick': return change.outcome === 'respawned' || change.outcome === 'deferred' || change.outcome === 'restartRequired' || (change.outcome === 'inactive' && change.isClaudeBackend);
    case 'modelPick': return true;
    case 'backendSwitch': return !change.isSameConversation;
  }
}
