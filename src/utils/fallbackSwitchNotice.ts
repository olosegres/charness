/**
 * @description The wording of a usage-limit switch (`utils/fallbackChain.ts`) and of the way back:
 *   • «switched» — the topic already runs on the new rung; «deferred» — the agent is still answering, so the move
 *     waits for the end of the answer. Both read as one short sentence: WHAT hit its limit, WHERE the topic
 *     continues, and — in «switched» — when the limit resets and the ONE command that brings the topic back
 *     (`/accounts`, whatever the backend: the owner's decision, spelled in the `fallback.switchedReset` /
 *     `fallback.switchedBack` texts);
 *   • the «back» button of `/accounts` and the notices of the move it triggers (`utils/fallbackReturn.ts`).
 *
 * A Claude rung is named by its account alone (`«work»`), with the model added only when the switch changes it
 * (`«work» (sonnet)`); an OpenCode rung by its backend and model (`OpenCode openai/gpt-5`), and a Claude rung
 * reached from another backend says `Claude «work»`, since there is no account on the left to compare against.
 *
 * Pure: the clock, the running model and the topic's state are decided by the caller, so every wording rule is
 * unit-tested; the texts come from the active locale (`fallback.*`).
 */

import { t } from '../i18n';
import { buildOpenCodeModelLabel, getFallbackModelToPin, type FallbackChainEntry } from './fallbackChain';

/** A name as the notices show it: between guillemets, so a profile called `default` or `work` reads as a name. */
function quoteName(name: string): string {
  return `«${name}»`;
}

/**
 * @description A rung by name, without its model: a Claude account is «name» (`Claude «name»` when `other` — the
 * rung the topic is on — is not a Claude account, so there is no account to compare against); an OpenCode rung
 * says its backend and `provider/model`.
 */
function formatRungName(other: FallbackChainEntry | null, rung: FallbackChainEntry): string {
  if (rung.backend === 'opencode') return `${t('fallback.backendOpenCode')} ${buildOpenCodeModelLabel(rung)}`;
  return other?.backend === 'claude' ? quoteName(rung.profile) : `${t('fallback.backendClaude')} ${quoteName(rung.profile)}`;
}

/**
 * @description The rung the topic continues on, for the sentence. A Claude rung names its model only when the
 * switch pins one the session is not already running (`getFallbackModelToPin`); an OpenCode rung always names its
 * model, it is part of the rung.
 */
function formatSwitchTarget(from: FallbackChainEntry | null, to: FallbackChainEntry, runningModel: string | null): string {
  const name = formatRungName(from, to);
  const pinnedModel = getFallbackModelToPin(to, runningModel);
  return pinnedModel === null ? name : `${name} (${pinnedModel})`;
}

/** The tail of the «switched» notice: when the exhausted rung resets (when known) and how to switch back. */
function buildSwitchBackTail(resetTime: string | null): string {
  return resetTime === null
    ? t('fallback.switchedBack')
    : t('fallback.switchedReset', { time: resetTime });
}

/**
 * @description The «switched» notice. `from` is the rung that hit the limit (`null` when the topic's position
 * is unknown); `resetTime` is when it comes back, already as a clock in the topic's zone (`null` when unknown or
 * past — the reset clause is dropped, the switch-back command stays); `runningModel` is what the topic's Claude
 * session runs now (`null` when unknown), the reference for whether the switch changes the model.
 */
export function buildFallbackSwitchedNotice(input: {
  from: FallbackChainEntry | null;
  to: FallbackChainEntry;
  resetTime: string | null;
  runningModel: string | null;
}): string {
  const { from, to, resetTime, runningModel } = input;
  const target = formatSwitchTarget(from, to, runningModel);
  const tail = buildSwitchBackTail(resetTime);
  if (from === null) return t('fallback.switchedUnknownSource', { to: target, tail });
  if (from.backend === 'claude') return t('fallback.switched', { from: quoteName(from.profile), to: target, tail });
  return t('fallback.switchedModel', { from: quoteName(buildOpenCodeModelLabel(from)), to: target, tail });
}

/**
 * @description The «deferred» notice: a Claude session that cannot be moved yet is moved to another account when
 * its answer ends, so both sides are Claude accounts. The rung's model is not named — a deferred move does not pin it.
 */
export function buildFallbackDeferredNotice(from: Extract<FallbackChainEntry, { backend: 'claude' }>, to: Extract<FallbackChainEntry, { backend: 'claude' }>): string {
  return t('fallback.switchedDeferred', { from: quoteName(from.profile), to: quoteName(to.profile) });
}

/**
 * @description The label of `/accounts`' «back» button: the rung the bot moved the topic from, named as the notice
 * names it. While that rung is still limited (`resetTime`, as a clock in the topic's zone; `null` once it is over
 * or unknown) the label adds when it comes back — a tap switches either way. `current` is the rung the topic is on
 * now (`null` when unknown).
 */
export function buildFallbackReturnLabel(input: { current: FallbackChainEntry | null; origin: FallbackChainEntry; resetTime: string | null }): string {
  const { current, origin, resetTime } = input;
  const to = formatRungName(current, origin);
  return resetTime === null ? t('fallback.returnButton', { to }) : t('fallback.returnButtonLimited', { to, time: resetTime });
}

/**
 * @description The notice after the topic moved back to `to`. `from` is the rung it was on (`null` when unknown),
 * `runningModel` the model its Claude session runs now — the model is named only when the move pins another one.
 */
export function buildFallbackReturnedNotice(input: { from: FallbackChainEntry | null; to: FallbackChainEntry; runningModel: string | null }): string {
  return t('fallback.returned', { to: formatSwitchTarget(input.from, input.to, input.runningModel) });
}

/** The notice when the way back waits for the end of the current answer (a Claude session that is working). */
export function buildFallbackReturnDeferredNotice(from: FallbackChainEntry | null, to: FallbackChainEntry): string {
  return t('fallback.returnedDeferred', { to: formatRungName(from, to) });
}

/** The notice when the move back failed; the rung stays remembered, so the button is still there. */
export function buildFallbackReturnFailedNotice(from: FallbackChainEntry | null, to: FallbackChainEntry, error: string): string {
  return t('fallback.returnFailed', { to: formatRungName(from, to), error });
}
