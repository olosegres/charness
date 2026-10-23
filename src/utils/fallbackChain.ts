/**
 * @description The FALLBACK CHAIN (`/limits`, formerly `/fallback`): one instance-wide, ordered list of «where a topic's main agent
 * continues when its own account / provider hits a usage limit». An entry names a backend and what it runs on —
 * a Claude account profile (`utils/claudeProfiles.ts`) with an optional model, or an OpenCode provider with a
 * model — and the list is the operator's PRIORITY (top = preferred). The bot drafts it from what is actually
 * signed in (`proposeFallbackChain`), the operator reorders / removes / adds with buttons, and a limit on a
 * topic picks the first AVAILABLE entry (`pickFallbackCandidates`): not disabled, signed in, present in the live catalog,
 * not marked limited, and not the account the topic is already on.
 *
 * This module is the pure layer: the chain shape, its edit operations, the draft, the ranking, the
 * auto / offer / none decision and the `callback_data` codecs. The chain lives in `state.json`
 * (`StateStore.getFallbackChain`), the detection and the switch itself in `bot.ts`, the `/limits` screen in
 * `connectors/telegram/commands/fallbackChain.ts`. The within-Claude ranking by headroom
 * (`claudeLimitSwitch.ts`) is what an EMPTY chain falls back to, so a bot without a configured chain behaves
 * exactly as before.
 *
 * No I/O, no `Date.now()`: the caller passes the clock and the detection views, so every rule is unit-tested.
 */

import { checkIsValidClaudeProfileName, defaultClaudeProfileName } from './claudeProfiles';
import { buildClaudeProfilesReport, formatClaudeUsageResetAt, getClaudeUsageBucket, getRelevantClaudeUsageKinds, type ClaudeProfileUsageView } from './claudeUsage';

/**
 * One rung of the chain. A Claude entry with `model: null` keeps the topic's own model. `disabled: true`
 * EXCLUDES the rung from automatic switching and from the limit notice's switch offers (the account / provider
 * stays usable by hand through `/model` and `/accounts`); absent means enabled, so older `state.json` files
 * read back unchanged.
 */
export type FallbackChainEntry =
  | { backend: 'claude'; profile: string; model: string | null; disabled?: boolean }
  | { backend: 'opencode'; providerId: string; modelId: string; disabled?: boolean };

/** The chain is a short priority list; a longer one is never consulted past the first available entry anyway. */
export const fallbackChainMaxLength = 12;

/** The most «switch to …» buttons a limit notice offers (best first); the rest of the chain is in `/fallback`. */
export const fallbackSwitchMaxOffers = 3;

/** Claude's CLI model aliases (`claudeJsonStreamAdapter.getAvailableModels`), the choices a Claude entry offers. */
export const fallbackClaudeModelAliases: readonly string[] = ['fable', 'opus', 'sonnet', 'haiku'];

const claudeModelAliasRe = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const openCodeProviderIdRe = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * @description What the bot DETECTED as connected, the input of the draft, the picker rows and the ranking:
 * the Claude profiles with their usage views, the OpenCode models the server is authenticated for
 * (`provider/model` labels, the live catalog), the OpenCode models topics recently picked (a hint for the
 * draft) and the per-model limit marks (`provider/model` → ISO instant).
 */
export interface FallbackDetection {
  claudeProfiles: readonly ClaudeProfileUsageView[];
  openCodeModels: readonly string[];
  recentOpenCodeModels: readonly string[];
  openCodeLimits: Readonly<Record<string, string>>;
}

// ── shape ──

/** `provider/model` → its two halves; `null` for a label without a provider segment. */
export function parseOpenCodeModelLabel(label: string): { providerId: string; modelId: string } | null {
  const index = label.indexOf('/');
  if (index <= 0 || index === label.length - 1) return null;
  const providerId = label.slice(0, index);
  if (!openCodeProviderIdRe.test(providerId)) return null;
  return { providerId, modelId: label.slice(index + 1) };
}

export function buildOpenCodeModelLabel(entry: { providerId: string; modelId: string }): string {
  return `${entry.providerId}/${entry.modelId}`;
}

/** Whether two entries name the same rung (backend, account / provider and model alike). */
export function checkIsSameFallbackEntry(a: FallbackChainEntry, b: FallbackChainEntry): boolean {
  if (a.backend === 'claude' && b.backend === 'claude') return a.profile === b.profile && a.model === b.model;
  if (a.backend === 'opencode' && b.backend === 'opencode') return a.providerId === b.providerId && a.modelId === b.modelId;
  return false;
}

/**
 * @description Whether two entries share the thing a usage limit exhausts: the Claude ACCOUNT (its windows
 * are per account, whatever the model) or the OpenCode provider+model. A limit on `a` makes every entry
 * `checkIsSameFallbackAccount(a, b)` just as limited.
 */
export function checkIsSameFallbackAccount(a: FallbackChainEntry, b: FallbackChainEntry): boolean {
  if (a.backend === 'claude' && b.backend === 'claude') return a.profile === b.profile;
  if (a.backend === 'opencode' && b.backend === 'opencode') return a.providerId === b.providerId && a.modelId === b.modelId;
  return false;
}

/**
 * @description The model the topic runs on `providerId`: the rung's model id when the rung is that OpenCode provider,
 * `null` otherwise. The one rule behind «is this provider the active row, and with which model» on every screen that lists
 * OpenCode providers (the `/limits` board, `/accounts`, a provider's model page).
 */
export function getRunningModelOfProvider(rung: FallbackChainEntry | null, providerId: string): string | null {
  return rung?.backend === 'opencode' && rung.providerId === providerId ? rung.modelId : null;
}

/** `claude:work:fable` / `opencode:openai/gpt-5` — the entry as one token (logs, tests, the revision hash). */
export function formatFallbackEntryKey(entry: FallbackChainEntry): string {
  return entry.backend === 'claude'
    ? `claude:${entry.profile}:${entry.model ?? '-'}`
    : `opencode:${buildOpenCodeModelLabel(entry)}`;
}

/**
 * @description The entry for a human: `Claude · work · fable`, `Claude · default · <topic's model>`,
 * `OpenCode · openai/gpt-5`. The backend words and the topic-model stand-in come localised from the caller.
 */
export function formatFallbackEntryLabel(
  entry: FallbackChainEntry,
  words: { claude: string; openCode: string; topicModel: string },
): string {
  if (entry.backend === 'claude') return `${words.claude} · ${entry.profile} · ${entry.model ?? words.topicModel}`;
  return `${words.openCode} · ${buildOpenCodeModelLabel(entry)}`;
}

/**
 * @description The model a switch onto `to` pins on the topic's Claude session: the rung's alias, unless the
 * session already runs it (`fable` against a reported `claude-fable-5-1`). `null` for a rung that names no model
 * (the topic keeps its own) and for an OpenCode rung (its model is part of the rung, not a pin).
 */
export function getFallbackModelToPin(to: FallbackChainEntry, runningModel: string | null): string | null {
  if (to.backend !== 'claude' || to.model === null) return null;
  const isRunning = runningModel !== null && runningModel.toLowerCase().includes(to.model.toLowerCase());
  return isRunning ? null : to.model;
}

/**
 * @description The chain as `state.json` may hold it, validated entry by entry: a malformed rung (a hand edit,
 * an older shape) is dropped, never thrown on — the chain is advisory and the bot must boot. Duplicates are
 * folded (first wins) and the cap applied.
 */
export function normaliseFallbackChain(raw: unknown): FallbackChainEntry[] {
  if (!Array.isArray(raw)) return [];
  const chain: FallbackChainEntry[] = [];
  for (const item of raw) {
    const entry = readFallbackEntry(item);
    if (entry && !chain.some((known) => checkIsSameFallbackEntry(known, entry))) chain.push(entry);
    if (chain.length >= fallbackChainMaxLength) break;
  }
  return chain;
}

function readFallbackEntry(item: unknown): FallbackChainEntry | null {
  if (!item || typeof item !== 'object') return null;
  const record = item as Record<string, unknown>;
  if (record.backend === 'claude') {
    const profile = record.profile;
    if (typeof profile !== 'string' || (profile !== defaultClaudeProfileName && !checkIsValidClaudeProfileName(profile))) return null;
    const model = record.model;
    if (model !== null && model !== undefined && (typeof model !== 'string' || !claudeModelAliasRe.test(model))) return null;
    return withDisabledFlag({ backend: 'claude', profile, model: typeof model === 'string' ? model : null }, record.disabled);
  }
  if (record.backend === 'opencode') {
    if (typeof record.providerId !== 'string' || typeof record.modelId !== 'string' || record.modelId === '') return null;
    if (!openCodeProviderIdRe.test(record.providerId)) return null;
    return withDisabledFlag({ backend: 'opencode', providerId: record.providerId, modelId: record.modelId }, record.disabled);
  }
  return null;
}

/** Keep `disabled` only when it is `true`: an enabled rung is persisted without the field. */
function withDisabledFlag(entry: FallbackChainEntry, disabled: unknown): FallbackChainEntry {
  return disabled === true ? { ...entry, disabled: true } : entry;
}

/**
 * @description Whether putting `entry` into automatic switching brings in a backend the list does not use yet: the
 * rungs `chain` already has in automatic switching (the ones not left out) are not empty and none is of `entry`'s
 * backend. A limit that moves a topic onto such a rung from the other backend hands its conversation over in
 * compacted form, so the operator is asked once, when the list first becomes mixed. A list with nothing in
 * automatic switching has no backend yet to differ from.
 */
export function checkIsNewBackendForChain(chain: readonly FallbackChainEntry[], entry: FallbackChainEntry): boolean {
  const used = chain.filter((rung) => !checkIsFallbackEntryDisabled(rung));
  return used.length > 0 && !used.some((rung) => rung.backend === entry.backend);
}

/** Whether the rungs in automatic switching span both backends (a switch along the list can hand a conversation over). */
export function checkIsMixedFallbackChain(chain: readonly FallbackChainEntry[]): boolean {
  return new Set(chain.filter((rung) => !checkIsFallbackEntryDisabled(rung)).map((rung) => rung.backend)).size > 1;
}

/** Whether the rung is excluded from automatic switching. */
export function checkIsFallbackEntryDisabled(entry: FallbackChainEntry): boolean {
  return entry.disabled === true;
}

/** Flip the rung at `index` between included and excluded (a NEW chain). */
export function toggleFallbackEntryDisabled(chain: readonly FallbackChainEntry[], index: number): FallbackChainEditResult {
  if (!Number.isInteger(index) || index < 0 || index >= chain.length) return { ok: false, reason: 'outOfRange' };
  return {
    ok: true,
    chain: chain.map((entry, i) => {
      if (i !== index) return entry;
      if (entry.disabled === true) {
        const { disabled: _dropped, ...enabled } = entry;
        return enabled as FallbackChainEntry;
      }
      return { ...entry, disabled: true };
    }),
  };
}

// ── edits (each returns a NEW chain; the caller persists it) ──

export type FallbackChainEditResult =
  | { ok: true; chain: FallbackChainEntry[] }
  | { ok: false; reason: 'duplicate' | 'full' | 'outOfRange' };

export function addFallbackEntry(chain: readonly FallbackChainEntry[], entry: FallbackChainEntry): FallbackChainEditResult {
  if (chain.some((known) => checkIsSameFallbackEntry(known, entry))) return { ok: false, reason: 'duplicate' };
  if (chain.length >= fallbackChainMaxLength) return { ok: false, reason: 'full' };
  return { ok: true, chain: [...chain, entry] };
}

export function removeFallbackEntry(chain: readonly FallbackChainEntry[], index: number): FallbackChainEditResult {
  if (!Number.isInteger(index) || index < 0 || index >= chain.length) return { ok: false, reason: 'outOfRange' };
  return { ok: true, chain: chain.filter((_, i) => i !== index) };
}

/** Move the rung at `index` one step up (`-1`) or down (`+1`); the ends are clamped (a no-op, still `ok`). */
export function moveFallbackEntry(chain: readonly FallbackChainEntry[], index: number, delta: -1 | 1): FallbackChainEditResult {
  if (!Number.isInteger(index) || index < 0 || index >= chain.length) return { ok: false, reason: 'outOfRange' };
  const target = index + delta;
  if (target < 0 || target >= chain.length) return { ok: true, chain: [...chain] };
  const next = [...chain];
  [next[index], next[target]] = [next[target], next[index]];
  return { ok: true, chain: next };
}

/**
 * @description A short, stable fingerprint of the chain's CONTENT (FNV-1a over the entry keys, 8 hex digits).
 * Every edit button of the picker bakes it in: a tap whose revision is not the chain's current one came from a
 * keyboard posted before a later edit, and its index would point at another rung — it is refused as stale.
 */
export function getFallbackChainRevision(chain: readonly FallbackChainEntry[]): string {
  const text = chain.map((entry) => `${formatFallbackEntryKey(entry)}${entry.disabled === true ? '!' : ''}`).join('\n');
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// ── the draft ──

/**
 * The models a provider's draft rung prefers, in order: the strongest general-purpose model each family
 * ships. The first model of the provider that matches a pattern wins; a provider with no match gets its first
 * model. A deliberately short, conservative list — the operator reorders anyway.
 */
const preferredOpenCodeModelPatterns: readonly RegExp[] = [
  /opus/i,
  /^gpt-5(?!.*(mini|nano|codex))/i,
  /^o3(?!-mini)/i,
  /gemini-[\d.]+-pro/i,
  /sonnet/i,
  /grok-4/i,
  /deepseek-(?:r1|reasoner)/i,
  /qwen3/i,
];

/** The provider ids of a catalog, in first-seen order. */
export function listOpenCodeProviders(models: readonly string[]): string[] {
  const providers: string[] = [];
  for (const label of models) {
    const parsed = parseOpenCodeModelLabel(label);
    if (parsed && !providers.includes(parsed.providerId)) providers.push(parsed.providerId);
  }
  return providers;
}

/** The model ids of one provider, in catalog order. */
export function listOpenCodeModelsOfProvider(models: readonly string[], providerId: string): string[] {
  const ids: string[] = [];
  for (const label of models) {
    const parsed = parseOpenCodeModelLabel(label);
    if (parsed && parsed.providerId === providerId && !ids.includes(parsed.modelId)) ids.push(parsed.modelId);
  }
  return ids;
}

/** The provider's best model by {@link preferredOpenCodeModelPatterns}, else its first; `null` for an unknown provider. */
export function pickPreferredOpenCodeModel(models: readonly string[], providerId: string): string | null {
  const ids = listOpenCodeModelsOfProvider(models, providerId);
  if (ids.length === 0) return null;
  for (const pattern of preferredOpenCodeModelPatterns) {
    const match = ids.find((id) => pattern.test(id));
    if (match) return match;
  }
  return ids[0];
}

/**
 * @description The draft the bot PROPOSES from what it detected: the signed-in subscription Claude profiles in their
 * registry order (each keeping the topic's model), then OpenCode — the recently picked models that are still
 * in the catalog, then every other provider's preferred model — and LAST the Claude accounts billed to API credits,
 * left out of automatic switching (🚫): with no windows they never look exhausted, so an automatic switch onto one
 * would spend money unasked; the operator moves a topic there by hand, or includes the rung. Only what is actually
 * available is proposed; a profile never probed counts as signed in (the CLI reports a signed-out one as `false`).
 */
export function proposeFallbackChain(detection: FallbackDetection, previous: readonly FallbackChainEntry[] = []): FallbackChainEntry[] {
  let chain: FallbackChainEntry[] = [];
  const push = (entry: FallbackChainEntry): void => {
    const added = addFallbackEntry(chain, entry);
    if (added.ok) chain = added.chain;
  };
  const signedIn = detection.claudeProfiles.filter((profile) => profile.loggedIn !== false);
  for (const profile of signedIn) {
    if (profile.billing !== 'api') push({ backend: 'claude', profile: profile.name, model: null });
  }
  const catalog = new Set(detection.openCodeModels);
  for (const label of detection.recentOpenCodeModels) {
    const parsed = parseOpenCodeModelLabel(label);
    if (parsed && catalog.has(label)) push({ backend: 'opencode', ...parsed });
  }
  for (const providerId of listOpenCodeProviders(detection.openCodeModels)) {
    const modelId = pickPreferredOpenCodeModel(detection.openCodeModels, providerId);
    if (modelId !== null) push({ backend: 'opencode', providerId, modelId });
  }
  const apiProfiles = new Set(signedIn.filter((profile) => profile.billing === 'api').map((profile) => profile.name));
  for (const name of apiProfiles) push({ backend: 'claude', profile: name, model: null });
  return chain.map((entry) => {
    const isApiRung = entry.backend === 'claude' && apiProfiles.has(entry.profile);
    // An API rung is left out unless the chain being replaced had it IN automatic switching (the operator's choice).
    const isExcluded = isApiRung ? !checkIsIncludedByPrevious(entry, previous) : checkIsExcludedByPrevious(entry, previous);
    return isExcluded ? { ...entry, disabled: true } : entry;
  });
}

/** Whether the chain being replaced had a rung of this Claude account in automatic switching (any model). */
function checkIsIncludedByPrevious(entry: FallbackChainEntry, previous: readonly FallbackChainEntry[]): boolean {
  return previous.some((other) => entry.backend === 'claude' && other.backend === 'claude' && other.profile === entry.profile && !checkIsFallbackEntryDisabled(other));
}

/**
 * Whether the operator had EXCLUDED this draft rung from switching in the chain being replaced: the Claude
 * account (any model) or the OpenCode provider (the draft may prefer another model of it) has a disabled rung
 * there and no enabled one. A rebuild never silently re-enables what was switched off.
 */
function checkIsExcludedByPrevious(entry: FallbackChainEntry, previous: readonly FallbackChainEntry[]): boolean {
  const sameOwner = (other: FallbackChainEntry): boolean => (entry.backend === 'claude'
    ? other.backend === 'claude' && other.profile === entry.profile
    : other.backend === 'opencode' && other.providerId === entry.providerId);
  const related = previous.filter(sameOwner);
  return related.length > 0 && related.every(checkIsFallbackEntryDisabled);
}

// ── availability and the ranking ──

export type FallbackEntryAvailability =
  | { status: 'available' }
  /** Marked limited until the instant (ISO). */
  | { status: 'limited'; until: string }
  /** A Claude profile that is not signed in (or removed), or an OpenCode model the server no longer offers. */
  | { status: 'signedOut' }
  | { status: 'missing' }
  /** A Claude account billed to API credits whose balance is used up: no reset — it holds until the operator acts. */
  | { status: 'exhausted' };

/**
 * @description Whether a rung can take work over NOW. A Claude profile is available when it is known, signed in,
 * not out of API credits, and eligible by the usage report (not marked limited, not at 100 % on the windows its model
 * drains — stale usage is allowed: the chain is the operator's explicit order, not a headroom race). An OpenCode
 * model is available when the live catalog lists it and its limit mark, if any, lies in the past.
 */
export function getFallbackEntryAvailability(entry: FallbackChainEntry, detection: FallbackDetection, nowMs: number): FallbackEntryAvailability {
  if (entry.backend === 'claude') {
    const profile = detection.claudeProfiles.find((candidate) => candidate.name === entry.profile);
    if (!profile) return { status: 'missing' };
    if (profile.loggedIn === false) return { status: 'signedOut' };
    if (profile.creditExhaustedAt !== null) return { status: 'exhausted' };
    if (profile.limitedUntil !== null && Date.parse(profile.limitedUntil) > nowMs) return { status: 'limited', until: profile.limitedUntil };
    const report = buildClaudeProfilesReport([profile], entry.model, nowMs);
    if (!report.profiles[0]?.isEligible) return { status: 'limited', until: getExhaustedWindowReset(profile, entry.model, nowMs) ?? new Date(nowMs).toISOString() };
    return { status: 'available' };
  }
  const label = buildOpenCodeModelLabel(entry);
  if (!detection.openCodeModels.includes(label)) return { status: 'missing' };
  const limitedUntil = detection.openCodeLimits[label];
  if (limitedUntil !== undefined && Date.parse(limitedUntil) > nowMs) return { status: 'limited', until: limitedUntil };
  return { status: 'available' };
}

/**
 * @description ` ⛔ 14:00` for an OpenCode model whose limit mark still lies ahead (the reset in `timezone`, the date
 * added when it is not today), `''` for one that is free. Appended to a model's caption wherever models are listed.
 */
export function formatOpenCodeModelLimitSuffix(label: string, limits: Readonly<Record<string, string>>, timezone: string, nowMs: number): string {
  const limitedUntil = limits[label];
  if (limitedUntil === undefined || !(Date.parse(limitedUntil) > nowMs)) return '';
  return ` ⛔ ${formatClaudeUsageResetAt(limitedUntil, timezone, nowMs)}`;
}

/** The latest reset among the windows a model drains that are at 100 % and still ahead; `null` when none names one. */
function getExhaustedWindowReset(profile: ClaudeProfileUsageView, model: string | null, nowMs: number): string | null {
  let latest: number | null = null;
  for (const kind of getRelevantClaudeUsageKinds(model)) {
    const bucket = getClaudeUsageBucket(profile.usage, kind);
    if (!bucket || bucket.percent < 100 || bucket.resetsAt === null) continue;
    const at = Date.parse(bucket.resetsAt);
    if (Number.isFinite(at) && at > nowMs && (latest === null || at > latest)) latest = at;
  }
  return latest === null ? null : new Date(latest).toISOString();
}

/** Two resets closer than this count as the same moment (the current rung then wins: no needless switch). */
export const fallbackEarliestResetToleranceMs = 60_000;

/**
 * @description The rung a usage-limit WAIT should end on when nothing has room now: of the enabled rungs of
 * `chain` and the rung the topic is on (`current`), the one whose limit resets EARLIEST. `null` when some rung
 * is still available (the normal switch plan applies) or none names a future reset. `isCurrent` says the topic's
 * own rung resets first (or within {@link fallbackEarliestResetToleranceMs} of the first): the wait stays as it
 * is. Signed-out, missing and out-of-credit rungs are skipped (none of them comes back at a known time); rungs of the
 * current account count as the current rung.
 */
export function pickEarliestResetRung(input: {
  chain: readonly FallbackChainEntry[];
  current: FallbackChainEntry | null;
  detection: FallbackDetection;
  nowMs: number;
}): { entry: FallbackChainEntry; untilMs: number; isCurrent: boolean } | null {
  const rungs = input.chain.filter((entry) => !checkIsFallbackEntryDisabled(entry));
  const found: Array<{ entry: FallbackChainEntry; untilMs: number; isCurrent: boolean }> = [];
  const consider = (entry: FallbackChainEntry, isCurrent: boolean): boolean => {
    const availability = getFallbackEntryAvailability(entry, input.detection, input.nowMs);
    if (availability.status === 'available') return !isCurrent;
    if (availability.status !== 'limited') return false;
    const untilMs = Date.parse(availability.until);
    if (Number.isFinite(untilMs) && untilMs > input.nowMs) found.push({ entry, untilMs, isCurrent });
    return false;
  };
  if (input.current) consider(input.current, true);
  for (const entry of rungs) {
    const isCurrent = input.current !== null && checkIsSameFallbackAccount(entry, input.current);
    if (isCurrent) continue;
    if (consider(entry, false)) return null;
  }
  if (found.length === 0) return null;
  const earliest = found.reduce((best, item) => (item.untilMs < best.untilMs ? item : best));
  const current = found.find((item) => item.isCurrent);
  if (current && current.untilMs - earliest.untilMs <= fallbackEarliestResetToleranceMs) return current;
  return earliest;
}

/**
 * @description The rungs that may take a topic's work over, in CHAIN ORDER (the operator's priority): every
 * available entry that is not the account the topic is on now (`current` — the one that just hit the limit;
 * its other models are just as limited). A topic whose current position is not in the chain at all (a manual
 * `/account` or `/model` pick) simply starts from the top: a manual choice is respected until it hits its own
 * limit, then the chain decides.
 */
export function pickFallbackCandidates(input: {
  chain: readonly FallbackChainEntry[];
  current: FallbackChainEntry | null;
  detection: FallbackDetection;
  nowMs: number;
}): FallbackChainEntry[] {
  return input.chain.filter((entry) => {
    if (checkIsFallbackEntryDisabled(entry)) return false;
    if (input.current && checkIsSameFallbackAccount(entry, input.current)) return false;
    return getFallbackEntryAvailability(entry, input.detection, input.nowMs).status === 'available';
  });
}

export type FallbackSwitchPlan =
  /** Auto-switch is on and a rung is available: move the topic to `to` now. */
  | { action: 'auto'; to: FallbackChainEntry }
  /** Offer the switch on the limit notice, best first. */
  | { action: 'offer'; candidates: FallbackChainEntry[] }
  /** Nothing can take over: the existing wait-for-reset behaviour stands. */
  | { action: 'none' };

/**
 * @description What a usage limit leads to, given the ranked candidates and the auto-switch toggle. No
 * candidate is `none` whatever the toggle says — the auto-switch never loops onto an exhausted rung; the bot
 * then waits for the reset as before.
 */
export function decideFallbackSwitch(input: { candidates: readonly FallbackChainEntry[]; isAutoSwitchEnabled: boolean }): FallbackSwitchPlan {
  if (input.candidates.length === 0) return { action: 'none' };
  if (input.isAutoSwitchEnabled) return { action: 'auto', to: input.candidates[0] };
  return { action: 'offer', candidates: input.candidates.slice(0, fallbackSwitchMaxOffers) };
}

/**
 * @description Until when an OpenCode provider/model that just hit a limit is marked limited: the instant the
 * error named when it lies ahead, else `fallbackMs` from now (the retry's blind delay). A mark already further
 * in the future is kept (the Claude twin is `resolveClaudeLimitedUntil`).
 */
export function resolveOpenCodeLimitedUntil(input: { resetAtMs: number | undefined; existingLimitedUntil: string | undefined; nowMs: number; fallbackMs: number }): string {
  let untilMs = input.resetAtMs !== undefined && input.resetAtMs > input.nowMs ? input.resetAtMs : input.nowMs + input.fallbackMs;
  const existingMs = input.existingLimitedUntil === undefined ? Number.NaN : Date.parse(input.existingLimitedUntil);
  if (Number.isFinite(existingMs) && existingMs > untilMs) untilMs = existingMs;
  return new Date(untilMs).toISOString();
}

// ── the «switch to …» buttons of a limit notice ──

/** `callback_data` prefix of a «switch to <entry>» button on a limit notice. */
export const fallbackSwitchCallbackPrefix = 'fbsw_';

/**
 * Prefix + a 13-digit episode + `_` + a one- or two-digit index: under 25 bytes. The INDEX points into the
 * candidate list the bot remembered for that EPISODE (an epoch ms that identifies the limit error), so an old
 * notice can never pick a rung of a newer list — its episode is no longer the topic's open one.
 */
export const fallbackSwitchCallbackRe = new RegExp(`^${fallbackSwitchCallbackPrefix}(\\d+)_(\\d{1,2})$`);

export function buildFallbackSwitchCallbackData(episodeId: number, index: number): string {
  return `${fallbackSwitchCallbackPrefix}${episodeId}_${index}`;
}

export function parseFallbackSwitchCallbackData(data: string): { episodeId: number; index: number } | null {
  const match = data.match(fallbackSwitchCallbackRe);
  if (!match) return null;
  return { episodeId: Number(match[1]), index: Number(match[2]) };
}

/**
 * @description What a tap on a switch button does: `switch` to the candidate at `index` only while the topic's
 * OPEN limit episode is the one the button was posted for and the index is inside that episode's list;
 * `expired` otherwise (the operator wrote, the work resumed, the topic was switched already, a newer limit
 * replaced the episode). `expired` changes nothing.
 */
export function getFallbackSwitchTapDecision(input: {
  openOffer: { episodeId: number; candidates: readonly FallbackChainEntry[] } | null;
  requestedEpisodeId: number;
  index: number;
}): { kind: 'switch'; to: FallbackChainEntry } | { kind: 'expired' } {
  if (!input.openOffer || input.openOffer.episodeId !== input.requestedEpisodeId) return { kind: 'expired' };
  const to = input.openOffer.candidates[input.index];
  return to ? { kind: 'switch', to } : { kind: 'expired' };
}

// ── the picker's buttons (`/fallback`) ──

const revisionGroup = '([0-9a-f]{8})';
const indexGroup = '(\\d{1,2})';

/** Reorder / remove a rung — the chain revision is baked in, so a stale keyboard is refused. */
export const fallbackMoveUpCallbackRe = new RegExp(`^fbk_up_${indexGroup}_${revisionGroup}$`);
export const fallbackMoveDownCallbackRe = new RegExp(`^fbk_dn_${indexGroup}_${revisionGroup}$`);
export const fallbackRemoveCallbackRe = new RegExp(`^fbk_rm_${indexGroup}_${revisionGroup}$`);
/** Include / exclude a rung from automatic switching (revision baked like the other edits). */
export const fallbackToggleCallbackRe = new RegExp(`^fbk_tg_${indexGroup}_${revisionGroup}$`);
/** Open a rung's detail view from the list (same baked revision + index). */
export const fallbackOpenCallbackRe = new RegExp(`^fbk_op_${indexGroup}_${revisionGroup}$`);
/**
 * «✅ Continue» of the question before a rung of a NEW backend is included: `fbk_tgok_` for a rung left out (the
 * toggle's own index + revision), `fbk_addok_` for an added one (the rung rides in the question message's snapshot,
 * only the revision of the list it was asked about is baked in).
 */
export const fallbackToggleConfirmCallbackRe = new RegExp(`^fbk_tgok_${indexGroup}_${revisionGroup}$`);
export const fallbackAddConfirmCallbackRe = new RegExp(`^fbk_addok_${revisionGroup}$`);
/** Open the «add» sub-picker (accounts and providers), then a Claude account's model list. */
export const fallbackAddCallback = 'fbk_add';

export const fallbackAddClaudeCallbackRe = new RegExp(`^fbk_addc_([a-z0-9][a-z0-9_-]{0,31})$`);
/** A Claude account + model: `-` = keep the topic's model. */
export const fallbackAddClaudeModelCallbackRe = new RegExp(`^fbk_addcm_([a-z0-9][a-z0-9_-]{0,31})_(-|[a-z0-9][a-z0-9._-]{0,31})$`);
/** An OpenCode provider by its index in the sub-picker's own snapshot; then a model by index on a page. */
export const fallbackAddProviderCallbackRe = new RegExp(`^fbk_addp_${indexGroup}$`);
export const fallbackAddModelPageCallbackRe = new RegExp(`^fbk_addpg_(\\d{1,3})$`);
export const fallbackAddModelCallbackRe = new RegExp(`^fbk_addm_(\\d{1,3})$`);
/** Draft the chain from what is detected (confirmed when a chain exists), empty it, back to the main picker. */
export const fallbackProposeCallback = 'fbk_prop';
export const fallbackProposeConfirmCallback = 'fbk_propok';
export const fallbackClearCallback = 'fbk_clear';
export const fallbackBackCallback = 'fbk_back';
/** Flip the auto-switch-on-limit setting (shared with `/account`): the topic's override, in General the instance default. */
export const fallbackAutoSwitchOnCallback = 'fbk_asw_on';
export const fallbackAutoSwitchOffCallback = 'fbk_asw_off';
/** A topic returns to the General value of the switch setting (drops its override). */
export const fallbackAutoSwitchSameCallback = 'fbk_asw_same';
/** The «wait for the reset and continue» setting (`/auto_continue_limits`, shown in `/limits`): on / off / same as General. */
export const fallbackWaitOnCallback = 'fbk_wait_on';
export const fallbackWaitOffCallback = 'fbk_wait_off';
export const fallbackWaitSameCallback = 'fbk_wait_same';
/**
 * A topic's button of a setting on the main screen: opens that setting's sub-menu (on / off / as in General,
 * whose buttons are the callbacks above) in the same message. General has no sub-menu — its button flips the value.
 */
export const fallbackAutoSwitchOpenCallback = 'fbk_set_asw';
export const fallbackWaitOpenCallback = 'fbk_set_wait';

export function buildFallbackMoveUpCallback(index: number, revision: string): string {
  return `fbk_up_${index}_${revision}`;
}

export function buildFallbackMoveDownCallback(index: number, revision: string): string {
  return `fbk_dn_${index}_${revision}`;
}

export function buildFallbackRemoveCallback(index: number, revision: string): string {
  return `fbk_rm_${index}_${revision}`;
}

export function buildFallbackOpenCallback(index: number, revision: string): string {
  return `fbk_op_${index}_${revision}`;
}

export function buildFallbackToggleCallback(index: number, revision: string): string {
  return `fbk_tg_${index}_${revision}`;
}

export function buildFallbackToggleConfirmCallback(index: number, revision: string): string {
  return `fbk_tgok_${index}_${revision}`;
}

export function buildFallbackAddConfirmCallback(revision: string): string {
  return `fbk_addok_${revision}`;
}

export function buildFallbackAddClaudeCallback(profile: string): string {
  return `fbk_addc_${profile}`;
}

export function buildFallbackAddClaudeModelCallback(profile: string, model: string | null): string {
  return `fbk_addcm_${profile}_${model ?? '-'}`;
}

export function buildFallbackAddProviderCallback(index: number): string {
  return `fbk_addp_${index}`;
}

export function buildFallbackAddModelPageCallback(page: number): string {
  return `fbk_addpg_${page}`;
}

export function buildFallbackAddModelCallback(index: number): string {
  return `fbk_addm_${index}`;
}

/**
 * @description The index and revision an edit button carries, or `null` for foreign data. `isCurrent` says
 * whether the revision is the chain's one NOW — `false` means the keyboard predates an edit and the tap must
 * only re-render, never act.
 */
export function parseFallbackEditCallback(data: string, re: RegExp, currentRevision: string): { index: number; isCurrent: boolean } | null {
  const match = data.match(re);
  if (!match) return null;
  return { index: Number(match[1]), isCurrent: match[2] === currentRevision };
}
