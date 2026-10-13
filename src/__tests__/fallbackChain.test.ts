/**
 * @description Unit tests for {@link ../utils/fallbackChain} — the priority chain a topic continues on when its
 * agent hits a usage limit: the shape and its validation, the edits with the stale-keyboard revision, the draft
 * from what is detected, the availability of a rung (signed in, in the catalog, not limited), the ranking in
 * chain order that skips the exhausted account and respects a manual pick, the auto / offer / none decision,
 * the OpenCode limited-until mark, and the limit-notice button codec with its stale-tap guard.
 *
 * A real usage limit is not inducible on demand, so this table is the proof that the auto-switch can never
 * loop onto an exhausted rung and that an old notice's button can never move a topic later.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  addFallbackEntry,
  buildFallbackAddClaudeModelCallback,
  buildFallbackMoveUpCallback,
  buildFallbackSwitchCallbackData,
  checkIsSameFallbackAccount,
  checkIsSameFallbackEntry,
  decideFallbackSwitch,
  fallbackAddClaudeModelCallbackRe,
  fallbackChainMaxLength,
  fallbackMoveUpCallbackRe,
  fallbackSwitchCallbackRe,
  fallbackSwitchMaxOffers,
  formatFallbackEntryKey,
  formatFallbackEntryLabel,
  getFallbackChainRevision,
  getFallbackEntryAvailability,
  getFallbackSwitchTapDecision,
  listOpenCodeModelsOfProvider,
  listOpenCodeProviders,
  moveFallbackEntry,
  normaliseFallbackChain,
  parseFallbackEditCallback,
  parseFallbackSwitchCallbackData,
  parseOpenCodeModelLabel,
  pickFallbackCandidates,
  pickPreferredOpenCodeModel,
  proposeFallbackChain,
  removeFallbackEntry,
  resolveOpenCodeLimitedUntil,
  type FallbackChainEntry,
  type FallbackDetection,
} from '../utils/fallbackChain';
import type { ClaudeProfileUsageView, ClaudeUsageSnapshot } from '../utils/claudeUsage';
import { checkIsCallbackDataWithinLimit } from '../utils/modelPickerPlan';

const nowMs = Date.parse('2026-10-12T10:00:00.000Z');
const words = { claude: 'Claude', openCode: 'OpenCode', topicModel: "topic's model" };

function buildUsage(input: { session: number; weekly: number; fable?: number; isStale?: boolean }): ClaudeUsageSnapshot {
  return {
    fetchedAt: '2026-10-12T09:59:00.000Z',
    source: 'api',
    isStale: input.isStale,
    buckets: [
      { kind: 'session', percent: input.session, resetsAt: '2026-10-12T13:00:00.000Z', scopeModel: null },
      { kind: 'weekly_all', percent: input.weekly, resetsAt: '2026-10-15T00:00:00.000Z', scopeModel: null },
      ...(input.fable === undefined ? [] : [{ kind: 'weekly_scoped' as const, percent: input.fable, resetsAt: '2026-10-15T00:00:00.000Z', scopeModel: 'Fable' }]),
    ],
  };
}

function buildProfile(name: string, patch: Partial<ClaudeProfileUsageView> = {}): ClaudeProfileUsageView {
  return {
    name,
    configDir: name === 'default' ? null : `/home/user/.telegramCode/claude-profiles/${name}`,
    loggedIn: true,
    email: `${name}@example.com`,
    subscriptionType: 'max',
    usage: buildUsage({ session: 20, weekly: 30, fable: 40 }),
    limitedUntil: null,
    ...patch,
  };
}

const claude = (profile: string, model: string | null = null): FallbackChainEntry => ({ backend: 'claude', profile, model });
const openCode = (providerId: string, modelId: string): FallbackChainEntry => ({ backend: 'opencode', providerId, modelId });

const catalog = ['openai/gpt-5', 'openai/gpt-5-mini', 'openai/o3-mini', 'google/gemini-2.5-flash', 'google/gemini-2.5-pro', 'openrouter/qwen/qwen3-coder'];

function buildDetection(patch: Partial<FallbackDetection> = {}): FallbackDetection {
  return {
    claudeProfiles: [buildProfile('default'), buildProfile('work')],
    openCodeModels: catalog,
    recentOpenCodeModels: [],
    openCodeLimits: {},
    ...patch,
  };
}

// ── shape ──

test('labels: `provider/model` parses into its halves; a label without a provider segment is null', () => {
  assert.deepEqual(parseOpenCodeModelLabel('openrouter/qwen/qwen3-coder'), { providerId: 'openrouter', modelId: 'qwen/qwen3-coder' });
  assert.equal(parseOpenCodeModelLabel('gpt-5'), null);
  assert.equal(parseOpenCodeModelLabel('/gpt-5'), null);
  assert.equal(parseOpenCodeModelLabel('openai/'), null);
  assert.equal(parseOpenCodeModelLabel('Open AI/gpt-5'), null, 'a provider id is a slug');
});

test('labels: the human label names the backend, the account or provider, and the model (or the topic-model stand-in)', () => {
  assert.equal(formatFallbackEntryLabel(claude('work', 'fable'), words), 'Claude · work · fable');
  assert.equal(formatFallbackEntryLabel(claude('default'), words), "Claude · default · topic's model");
  assert.equal(formatFallbackEntryLabel(openCode('openai', 'gpt-5'), words), 'OpenCode · openai/gpt-5');
  assert.equal(formatFallbackEntryKey(claude('work')), 'claude:work:-');
  assert.equal(formatFallbackEntryKey(openCode('openai', 'gpt-5')), 'opencode:openai/gpt-5');
});

test('identity: same entry needs the model too; same ACCOUNT ignores a Claude model (its windows are per account)', () => {
  assert.ok(checkIsSameFallbackEntry(claude('work', 'fable'), claude('work', 'fable')));
  assert.ok(!checkIsSameFallbackEntry(claude('work', 'fable'), claude('work', 'opus')));
  assert.ok(checkIsSameFallbackAccount(claude('work', 'fable'), claude('work', 'opus')));
  assert.ok(!checkIsSameFallbackAccount(claude('work'), claude('default')));
  assert.ok(checkIsSameFallbackAccount(openCode('openai', 'gpt-5'), openCode('openai', 'gpt-5')));
  assert.ok(!checkIsSameFallbackAccount(openCode('openai', 'gpt-5'), openCode('openai', 'o3')), 'an OpenCode limit is per model');
  assert.ok(!checkIsSameFallbackAccount(claude('work'), openCode('openai', 'gpt-5')));
});

test('normalise: malformed rungs are dropped, duplicates folded, the cap applied — never thrown on', () => {
  const chain = normaliseFallbackChain([
    { backend: 'claude', profile: 'work', model: 'fable' },
    { backend: 'claude', profile: 'work', model: 'fable' },
    { backend: 'claude', profile: 'Bad Name', model: null },
    { backend: 'claude', profile: 'default' },
    { backend: 'opencode', providerId: 'openai', modelId: 'gpt-5' },
    { backend: 'opencode', providerId: 'openai' },
    { backend: 'terminal' },
    'junk',
    null,
  ]);
  assert.deepEqual(chain, [claude('work', 'fable'), claude('default'), openCode('openai', 'gpt-5')]);
  assert.deepEqual(normaliseFallbackChain(undefined), []);
  assert.deepEqual(normaliseFallbackChain('nope'), []);
  const tooMany = Array.from({ length: fallbackChainMaxLength + 3 }, (_, i) => openCode('p', `m${i}`));
  assert.equal(normaliseFallbackChain(tooMany).length, fallbackChainMaxLength);
});

// ── edits ──

test('edits: add refuses a duplicate and a full chain; remove and move are index-checked; move clamps at the ends', () => {
  const chain = [claude('default'), claude('work'), openCode('openai', 'gpt-5')];
  assert.deepEqual(addFallbackEntry(chain, claude('work')), { ok: false, reason: 'duplicate' });
  const added = addFallbackEntry(chain, claude('work', 'opus'));
  assert.ok(added.ok && added.chain.length === 4);
  const full = Array.from({ length: fallbackChainMaxLength }, (_, i) => openCode('p', `m${i}`));
  assert.deepEqual(addFallbackEntry(full, claude('x')), { ok: false, reason: 'full' });

  assert.deepEqual(removeFallbackEntry(chain, 1), { ok: true, chain: [claude('default'), openCode('openai', 'gpt-5')] });
  assert.deepEqual(removeFallbackEntry(chain, 3), { ok: false, reason: 'outOfRange' });
  assert.deepEqual(removeFallbackEntry(chain, -1), { ok: false, reason: 'outOfRange' });

  assert.deepEqual(moveFallbackEntry(chain, 2, -1), { ok: true, chain: [claude('default'), openCode('openai', 'gpt-5'), claude('work')] });
  assert.deepEqual(moveFallbackEntry(chain, 0, -1), { ok: true, chain }, 'the top rung stays');
  assert.deepEqual(moveFallbackEntry(chain, 2, 1), { ok: true, chain }, 'the bottom rung stays');
  assert.deepEqual(moveFallbackEntry(chain, 5, 1), { ok: false, reason: 'outOfRange' });
  assert.deepEqual(chain, [claude('default'), claude('work'), openCode('openai', 'gpt-5')], 'the input is never mutated');
});

test('revision: stable for the same content, different after any edit, and it gates an edit button', () => {
  const chain = [claude('default'), openCode('openai', 'gpt-5')];
  const revision = getFallbackChainRevision(chain);
  assert.match(revision, /^[0-9a-f]{8}$/);
  assert.equal(getFallbackChainRevision([...chain]), revision);
  assert.notEqual(getFallbackChainRevision([chain[1], chain[0]]), revision, 'order is content');
  assert.notEqual(getFallbackChainRevision([claude('default')]), revision);
  const data = buildFallbackMoveUpCallback(1, revision);
  assert.ok(checkIsCallbackDataWithinLimit(data));
  assert.deepEqual(parseFallbackEditCallback(data, fallbackMoveUpCallbackRe, revision), { index: 1, isCurrent: true });
  assert.deepEqual(parseFallbackEditCallback(data, fallbackMoveUpCallbackRe, 'ffffffff'), { index: 1, isCurrent: false });
  assert.equal(parseFallbackEditCallback('fbk_rm_1_' + revision, fallbackMoveUpCallbackRe, revision), null, 'another button\'s data');
});

test('add buttons: a Claude account + model bakes both, with `-` for the topic\'s model, and fits the 64-byte cap', () => {
  const longest = 'a'.repeat(32);
  const data = buildFallbackAddClaudeModelCallback(longest, 'sonnet');
  assert.ok(checkIsCallbackDataWithinLimit(data), `${data.length} bytes`);
  const match = data.match(fallbackAddClaudeModelCallbackRe);
  assert.deepEqual([match?.[1], match?.[2]], [longest, 'sonnet']);
  const keep = buildFallbackAddClaudeModelCallback('work', null).match(fallbackAddClaudeModelCallbackRe);
  assert.deepEqual([keep?.[1], keep?.[2]], ['work', '-']);
  assert.equal('fbk_addcm_Work_fable'.match(fallbackAddClaudeModelCallbackRe), null);
});

// ── the draft ──

test('catalog: providers in first-seen order, a provider\'s models in catalog order, and the preferred model by family', () => {
  assert.deepEqual(listOpenCodeProviders(catalog), ['openai', 'google', 'openrouter']);
  assert.deepEqual(listOpenCodeModelsOfProvider(catalog, 'openai'), ['gpt-5', 'gpt-5-mini', 'o3-mini']);
  assert.equal(pickPreferredOpenCodeModel(catalog, 'openai'), 'gpt-5', 'the flagship, not the mini');
  assert.equal(pickPreferredOpenCodeModel(catalog, 'google'), 'gemini-2.5-pro');
  assert.equal(pickPreferredOpenCodeModel(catalog, 'openrouter'), 'qwen/qwen3-coder');
  assert.equal(pickPreferredOpenCodeModel(['x/alpha', 'x/beta'], 'x'), 'alpha', 'no family match → the first');
  assert.equal(pickPreferredOpenCodeModel(catalog, 'nope'), null);
});

test('draft: signed-in Claude profiles first (topic model kept), then recent OpenCode picks still in the catalog, then each provider\'s preferred model', () => {
  const chain = proposeFallbackChain(buildDetection({
    claudeProfiles: [buildProfile('default'), buildProfile('out', { loggedIn: false }), buildProfile('work', { loggedIn: undefined })],
    recentOpenCodeModels: ['google/gemini-2.5-flash', 'openai/gpt-4o', 'google/gemini-2.5-flash'],
  }));
  assert.deepEqual(chain, [
    claude('default'),
    claude('work'),
    openCode('google', 'gemini-2.5-flash'),
    openCode('openai', 'gpt-5'),
    openCode('google', 'gemini-2.5-pro'),
    openCode('openrouter', 'qwen/qwen3-coder'),
  ]);
  assert.deepEqual(proposeFallbackChain(buildDetection({ claudeProfiles: [buildProfile('out', { loggedIn: false })], openCodeModels: [] })), []);
});

// ── availability and the ranking ──

test('availability: a Claude rung needs a known, signed-in, unlimited profile with room on its model\'s windows (stale usage allowed)', () => {
  const detection = buildDetection({
    claudeProfiles: [
      buildProfile('default'),
      buildProfile('out', { loggedIn: false }),
      buildProfile('marked', { limitedUntil: '2026-10-12T12:00:00.000Z' }),
      buildProfile('expired', { limitedUntil: '2026-10-12T09:00:00.000Z' }),
      buildProfile('full', { usage: buildUsage({ session: 100, weekly: 5 }) }),
      buildProfile('fableFull', { usage: buildUsage({ session: 5, weekly: 5, fable: 100 }) }),
      buildProfile('stale', { usage: buildUsage({ session: 5, weekly: 5, isStale: true }) }),
      buildProfile('unknown', { usage: undefined, loggedIn: undefined }),
    ],
  });
  const status = (entry: FallbackChainEntry) => getFallbackEntryAvailability(entry, detection, nowMs).status;
  assert.equal(status(claude('default')), 'available');
  assert.equal(status(claude('removed')), 'missing');
  assert.equal(status(claude('out')), 'signedOut');
  assert.deepEqual(getFallbackEntryAvailability(claude('marked'), detection, nowMs), { status: 'limited', until: '2026-10-12T12:00:00.000Z' });
  assert.equal(status(claude('expired')), 'available', 'a mark in the past no longer excludes');
  assert.equal(status(claude('full')), 'limited');
  assert.equal(status(claude('fableFull', 'fable')), 'limited', 'Fable drains its own window');
  assert.equal(status(claude('fableFull', 'sonnet')), 'available', 'sonnet does not');
  assert.equal(status(claude('stale')), 'available');
  assert.equal(status(claude('unknown')), 'available');
});

test('availability: an OpenCode rung needs the live catalog and no limit mark ahead', () => {
  const detection = buildDetection({ openCodeLimits: { 'openai/gpt-5': '2026-10-12T11:00:00.000Z', 'google/gemini-2.5-pro': '2026-10-12T09:00:00.000Z' } });
  assert.deepEqual(getFallbackEntryAvailability(openCode('openai', 'gpt-5'), detection, nowMs), { status: 'limited', until: '2026-10-12T11:00:00.000Z' });
  assert.equal(getFallbackEntryAvailability(openCode('google', 'gemini-2.5-pro'), detection, nowMs).status, 'available');
  assert.equal(getFallbackEntryAvailability(openCode('openai', 'gpt-4o'), detection, nowMs).status, 'missing');
  assert.equal(getFallbackEntryAvailability(openCode('anthropic', 'claude-opus'), detection, nowMs).status, 'missing', 'a disconnected provider');
});

test('ranking: chain order wins (not headroom), the exhausted ACCOUNT is skipped whatever its model, unavailable rungs too', () => {
  const chain = [claude('work', 'opus'), claude('default', 'sonnet'), claude('work', 'fable'), openCode('openai', 'gpt-5'), openCode('google', 'gemini-2.5-pro')];
  const detection = buildDetection({
    claudeProfiles: [buildProfile('default', { usage: buildUsage({ session: 90, weekly: 90 }) }), buildProfile('work', { usage: buildUsage({ session: 1, weekly: 1 }) })],
    openCodeLimits: { 'openai/gpt-5': '2026-10-12T11:00:00.000Z' },
  });
  const candidates = pickFallbackCandidates({ chain, current: claude('work', 'claude-sonnet-4-5'), detection, nowMs });
  assert.deepEqual(candidates, [claude('default', 'sonnet'), openCode('google', 'gemini-2.5-pro')]);
});

test('ranking: a manual pick outside the chain starts from the top; an OpenCode limit skips that model only', () => {
  const chain = [openCode('openai', 'gpt-5'), openCode('openai', 'o3-mini'), claude('default')];
  const detection = buildDetection();
  assert.deepEqual(
    pickFallbackCandidates({ chain, current: claude('spare'), detection, nowMs }),
    chain,
    'the manual account is not in the chain: every rung is a candidate',
  );
  assert.deepEqual(
    pickFallbackCandidates({ chain, current: openCode('openai', 'gpt-5'), detection, nowMs }),
    [openCode('openai', 'o3-mini'), claude('default')],
  );
  assert.deepEqual(pickFallbackCandidates({ chain, current: null, detection, nowMs }), chain);
  assert.deepEqual(pickFallbackCandidates({ chain: [], current: claude('default'), detection, nowMs }), []);
});

test('decision: no candidate → none, whatever the toggle says (the auto-switch never loops)', () => {
  assert.deepEqual(decideFallbackSwitch({ candidates: [], isAutoSwitchEnabled: true }), { action: 'none' });
  assert.deepEqual(decideFallbackSwitch({ candidates: [], isAutoSwitchEnabled: false }), { action: 'none' });
});

test('decision: toggle ON → auto to the first rung; OFF → an offer capped at the first few', () => {
  const candidates = [claude('a'), claude('b'), openCode('p', 'c'), openCode('p', 'd')];
  assert.deepEqual(decideFallbackSwitch({ candidates, isAutoSwitchEnabled: true }), { action: 'auto', to: claude('a') });
  assert.deepEqual(decideFallbackSwitch({ candidates, isAutoSwitchEnabled: false }), {
    action: 'offer',
    candidates: candidates.slice(0, fallbackSwitchMaxOffers),
  });
});

test('OpenCode limited-until: the error\'s reset ahead wins, else the fallback delay; a later existing mark is kept', () => {
  assert.equal(resolveOpenCodeLimitedUntil({ resetAtMs: nowMs + 1_800_000, existingLimitedUntil: undefined, nowMs, fallbackMs: 3_600_000 }), '2026-10-12T10:30:00.000Z');
  assert.equal(resolveOpenCodeLimitedUntil({ resetAtMs: nowMs - 1, existingLimitedUntil: undefined, nowMs, fallbackMs: 3_600_000 }), '2026-10-12T11:00:00.000Z');
  assert.equal(resolveOpenCodeLimitedUntil({ resetAtMs: undefined, existingLimitedUntil: '2026-10-12T15:00:00.000Z', nowMs, fallbackMs: 3_600_000 }), '2026-10-12T15:00:00.000Z');
  assert.equal(resolveOpenCodeLimitedUntil({ resetAtMs: undefined, existingLimitedUntil: 'garbage', nowMs, fallbackMs: 3_600_000 }), '2026-10-12T11:00:00.000Z');
});

// ── the limit-notice buttons ──

test('switch button: bakes the episode and the candidate index, round-trips, fits the 64-byte cap', () => {
  const data = buildFallbackSwitchCallbackData(nowMs, 2);
  assert.ok(checkIsCallbackDataWithinLimit(data), `${data.length} bytes`);
  assert.ok(fallbackSwitchCallbackRe.test(data));
  assert.deepEqual(parseFallbackSwitchCallbackData(data), { episodeId: nowMs, index: 2 });
  assert.equal(parseFallbackSwitchCallbackData('acct_use_work'), null);
  assert.equal(parseFallbackSwitchCallbackData('fbsw_x_1'), null);
  assert.equal(parseFallbackSwitchCallbackData('fbsw_1_'), null);
});

test('tap: only the open episode\'s button switches, to the rung its index named; no offer, another episode or an index past the list is stale', () => {
  const openOffer = { episodeId: nowMs, candidates: [claude('work'), openCode('openai', 'gpt-5')] };
  assert.deepEqual(getFallbackSwitchTapDecision({ openOffer, requestedEpisodeId: nowMs, index: 1 }), { kind: 'switch', to: openCode('openai', 'gpt-5') });
  assert.deepEqual(getFallbackSwitchTapDecision({ openOffer, requestedEpisodeId: nowMs, index: 2 }), { kind: 'expired' });
  assert.deepEqual(getFallbackSwitchTapDecision({ openOffer, requestedEpisodeId: nowMs + 1, index: 0 }), { kind: 'expired' });
  assert.deepEqual(getFallbackSwitchTapDecision({ openOffer: null, requestedEpisodeId: nowMs, index: 0 }), { kind: 'expired' });
});
