/**
 * @description Pure layer behind the "Recently used" shortcut of the `/model`
 * picker: the most-recently-used list itself, its catalog filter, and the
 * callback codec of the flat list it opens.
 *
 * Why it exists: the two-level picker (provider → that provider's models) is
 * what keeps `/model` inside Telegram's message cap, but an operator who hops
 * between a few favourite models of DIFFERENT providers pays the two taps
 * every time. The shortcut sits first on the provider level and opens one
 * flat list of `provider/model` ids that were actually picked before —
 * instance-wide, most recent first, deduplicated, capped.
 *
 * Everything here is pure so `modelProviders.ts` stays wiring and the three
 * rules — update/dedupe/cap, the stale-entry filter, the stale-tap safety of
 * the callbacks — are unit-tested without a Telegram surface.
 */
import { createHash } from 'node:crypto';
import type { ModelCatalog } from './modelPickerPlan';

/**
 * @description How many entries the list keeps. Ten is one keyboard that needs
 * no paging and matches the model level's page size, so the flat list is never
 * taller than a provider page.
 */
export const recentModelsLimit = 10;

/** Opens the flat list (provider level → recent level). */
export const recentModelsOpenCallback = 'mdlrecent';

const recentModelPickCallbackPrefix = 'mdlr_';

/** Anchored matcher for `bot.action(...)`, kept beside the builder so the wire
 *  format has one definition. */
export const recentModelPickCallbackRe = /^mdlr_(\d+)_([0-9a-f]{8})$/;

/**
 * @description Put `modelId` at the head of the list: a repeat pick moves its
 * entry to the front rather than duplicating it, and the oldest entry falls
 * off once `limit` is reached. Never mutates `current`.
 */
export function pushRecentModel(
  current: readonly string[],
  modelId: string,
  limit: number = recentModelsLimit,
): string[] {
  const trimmed = modelId.trim();
  const rest = current.filter((entry) => entry !== trimmed);
  const next = trimmed ? [trimmed, ...rest] : rest;
  return next.slice(0, Math.max(limit, 0));
}

/**
 * @description The entries the picker may offer: those whose `provider/model`
 * still exists in the live catalog AND whose provider is not hidden.
 *
 * A provider that was disconnected (or a model the server stopped serving)
 * leaves a stale id behind in `state.json`; rendering a button for it would
 * resolve to nothing. The entry stays on disk — the provider may come back —
 * it is just not shown. Hidden providers are excluded for the same reason
 * they are excluded one level up: hiding must make a provider unreachable
 * through the picker, not just invisible on its own level.
 */
export function getRecentModelsInCatalog(
  recentModels: readonly string[],
  catalog: ModelCatalog,
): string[] {
  const hiddenSet = new Set(catalog.hiddenProviders);
  return recentModels.filter((modelId) => {
    const slashIndex = modelId.indexOf('/');
    if (slashIndex <= 0) return false;
    const provider = modelId.slice(0, slashIndex);
    if (hiddenSet.has(provider)) return false;
    return catalog.byProvider.get(provider)?.includes(modelId) ?? false;
  });
}

/**
 * @description Short identity of a model id that fits the callback budget:
 * the first 8 hex chars of its SHA-256. The full id (`openrouter/anthropic/
 * claude-sonnet-4.5`) cannot ride in `callback_data` (64 bytes), and an index
 * alone would re-point an old keyboard at a DIFFERENT model once the list is
 * reordered by a newer pick — so the button carries both.
 */
export function getRecentModelIdentity(modelId: string): string {
  return createHash('sha256').update(modelId, 'utf8').digest('hex').slice(0, 8);
}

export function buildRecentModelPickCallback(index: number, modelId: string): string {
  return `${recentModelPickCallbackPrefix}${index}_${getRecentModelIdentity(modelId)}`;
}

/** A position in the list paired with the identity of the entry shown there. */
export interface RecentModelPickRef {
  index: number;
  identity: string;
}

export function parseRecentModelPickCallback(callbackData: string): RecentModelPickRef | null {
  const match = recentModelPickCallbackRe.exec(callbackData);
  if (!match) return null;
  return { index: Number(match[1]), identity: match[2] };
}

/**
 * @description Resolve a tapped recent-list button against the list AS IT IS
 * NOW. The index is only a hint: it is trusted when the entry there still has
 * the identity the button carries; otherwise the list is searched for that
 * identity (a newer pick just moved the entry). `null` — never another
 * model — when the entry left the list (evicted past the cap, or filtered
 * out because its provider is gone or hidden); the caller turns that into
 * the "expired" toast.
 */
export function getRecentModelPick(
  recentModels: readonly string[],
  ref: RecentModelPickRef,
): string | null {
  const atIndex = recentModels[ref.index];
  if (atIndex !== undefined && getRecentModelIdentity(atIndex) === ref.identity) return atIndex;
  return recentModels.find((modelId) => getRecentModelIdentity(modelId) === ref.identity) ?? null;
}
