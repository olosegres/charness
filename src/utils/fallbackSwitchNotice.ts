/**
 * @description The two notices the bot posts when a usage limit moves a topic onto another rung of the fallback
 * chain (`utils/fallbackChain.ts`): «switched» (the topic already runs on the new rung) and «deferred» (the agent is
 * still answering, so the move waits for the end of the answer). Both read as one short sentence: WHAT hit its
 * limit, WHERE the topic continues, and — in «switched» — when the limit resets and the ONE command that moves
 * the topic again (`/limits`, the board of every account and provider, whatever the backend: the owner's decision,
 * spelled in the `fallback.switchedReset` / `fallback.switchedBack` texts).
 *
 * A Claude rung is named by its account alone (`«work»`), with the model added only when the switch changes it
 * (`«work» (sonnet)`); an OpenCode rung by its backend and model (`OpenCode openai/gpt-5`) and, as the side that
 * hit the limit, by its model (`Model openai/gpt-5`) — a model name is never quoted. A Claude rung reached from
 * another backend says `Claude «work»`, since there is no account on the left to compare against.
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
 * @description The rung the topic continues on, for the sentence. A Claude account is «name» (`Claude «name»` when the
 * rung the topic left is not a Claude account, so there is no account to compare against) and names its model only
 * when the switch pins one the session is not already running (`getFallbackModelToPin`); an OpenCode rung says its
 * backend and `provider/model` — the model is part of the rung.
 */
function formatSwitchTarget(from: FallbackChainEntry | null, to: FallbackChainEntry, runningModel: string | null): string {
  if (to.backend === 'opencode') return `${t('fallback.backendOpenCode')} ${buildOpenCodeModelLabel(to)}`;
  const account = from?.backend === 'claude' ? quoteName(to.profile) : `${t('fallback.backendClaude')} ${quoteName(to.profile)}`;
  const pinnedModel = getFallbackModelToPin(to, runningModel);
  return pinnedModel === null ? account : `${account} (${pinnedModel})`;
}

/** The tail of the «switched» notice: when the exhausted rung resets (when known) and where to switch. */
function buildSwitchTail(resetTime: string | null): string {
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
  const tail = buildSwitchTail(resetTime);
  if (from === null) return t('fallback.switchedUnknownSource', { to: target, tail });
  if (from.backend === 'claude') return t('fallback.switched', { from: quoteName(from.profile), to: target, tail });
  return t('fallback.switchedModel', { from: buildOpenCodeModelLabel(from), to: target, tail });
}

/**
 * @description The «deferred» notice: a Claude session that cannot be moved yet is moved to another account when
 * its answer ends, so both sides are Claude accounts. The rung's model is not named — a deferred move does not pin it.
 */
export function buildFallbackDeferredNotice(from: Extract<FallbackChainEntry, { backend: 'claude' }>, to: Extract<FallbackChainEntry, { backend: 'claude' }>): string {
  return t('fallback.switchedDeferred', { from: quoteName(from.profile), to: quoteName(to.profile) });
}
