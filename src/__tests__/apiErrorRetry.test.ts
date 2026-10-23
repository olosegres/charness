/**
 * @description Unit tests for the pure auto-retry decision module
 * {@link ../apiErrorRetry} (plan S1). Covers the classifier (including the
 * "(not your usage limit)" disambiguation trap and the greedy-regex guard),
 * the best-effort reset-time parser, and the backoff plan / give-up boundaries.
 *
 * A FIXED `now` is used everywhere (no `Date.now()`), so the relative/absolute
 * time math is deterministic.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  classifyAgentApiError,
  parseResetAt,
  getRetryPlan,
  decideRetryAction,
  retryRecurrenceGraceMs,
  usageLimitDefaultMs,
  resetBufferMs,
  checkIsUsageLimitWindowOver,
  getUnconfirmedLimitAction,
  conversationTailRetryDelayMs,
} from '../apiErrorRetry';
import { maxTimeoutMs } from '../scheduler/engine';

/** Fixed clock: 2026-06-09T10:00:00.000Z. Used as `now` in every test. */
const fixedNow = Date.parse('2026-06-09T10:00:00.000Z');

const minuteMs = 60_000;
const hourMs = 60 * minuteMs;

/** The verbatim live transient string from claude.exe (the disambiguation trap). */
const liveTransientString =
  'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited';

test('classify: verbatim live transient string → transient, NOT usageLimit (the "not your usage limit" trap)', () => {
  const result = classifyAgentApiError(liveTransientString, fixedNow);
  assert.deepEqual(result, { kind: 'transient' });
  assert.notEqual(result?.kind, 'usageLimit');
});

test('classify: rate-limit / overloaded / status-code phrasings → transient', () => {
  for (const text of [
    'Error: rate limited, please retry',
    'Rate limit exceeded. Please try again later.',
    'rate_limit_error: request rate limit reached',
    'The model is overloaded',
    'Too Many Requests',
    'HTTP 429 returned by provider',
    'upstream responded with 503',
    'got a 529 from the API',
  ]) {
    assert.deepEqual(classifyAgentApiError(text, fixedNow), { kind: 'transient' }, text);
  }
});

test('classify: the Anthropic subscription window relayed by OpenCode → usageLimit, not a "rate limit" hiccup', () => {
  // Verbatim live wording (2026-10-14); OpenCode's retry deadline was days away.
  // This observed wording is an exception, not evidence that all bare rate limits are quota errors.
  const live = "This request would exceed your account's rate limit. Please try again later.";
  // UNCONFIRMED: the same 429 comes at 0–84 % shown usage too (claude-code#19673), so the bot probes before waiting.
  assert.deepEqual(classifyAgentApiError(live, fixedNow), { kind: 'usageLimit', resetAt: undefined, isUnconfirmed: true });
  assert.deepEqual(classifyAgentApiError(`429 rate_limit_error: ${live}`, fixedNow), { kind: 'usageLimit', resetAt: undefined, isUnconfirmed: true });
  // A relay that drops the tail or types a typographic apostrophe is the same window.
  for (const variant of ["This request would exceed your account's rate limit", 'This request would exceed your account\u2019s rate limit. Please try again later.']) {
    assert.equal(classifyAgentApiError(variant, fixedNow)?.kind, 'usageLimit', variant);
  }
});

test('classify: a bare "rate limit" next to an explicit usage-window wording → usageLimit', () => {
  const text = "Rate limit reached: You've hit your weekly limit · resets in 2h";
  assert.deepEqual(classifyAgentApiError(text, fixedNow), { kind: 'usageLimit', resetAt: fixedNow + 2 * hourMs });
});

test('classify: OpenCode-relayed provider quota codes → usageLimit even with the 429 the transient branch reads', () => {
  // OpenAI: a used-up monthly quota comes as HTTP 429 with the `insufficient_quota` code.
  const openAi = 'AI_APICallError: 429 {"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","code":"insufficient_quota"}}';
  assert.equal(classifyAgentApiError(openAi, fixedNow)?.kind, 'usageLimit');
  // Google: a RESOURCE_EXHAUSTED that names a DAILY quota (its quota id) rides a 429 too and is a usage limit.
  assert.equal(classifyAgentApiError(googleDailyQuotaBody, fixedNow)?.kind, 'usageLimit');
  // The OpenAI Codex subscription limit names a reset.
  const codex = classifyAgentApiError("usage_limit_reached: You've hit your usage limit. Try again in 3h", fixedNow);
  assert.equal(codex?.kind, 'usageLimit');
  assert.equal(codex?.resetAt, fixedNow + 3 * hourMs);
  // A bare 429 without a quota code stays a transient hiccup.
  assert.equal(classifyAgentApiError('429 Too Many Requests', fixedNow)?.kind, 'transient');
  // Underscored window names and the billing hard limit are usage limits as well.
  assert.equal(classifyAgentApiError('usage_limit exceeded for this key', fixedNow)?.kind, 'usageLimit');
  assert.equal(classifyAgentApiError('Billing hard limit has been reached', fixedNow)?.kind, 'usageLimit');
});

// Short-window throttles — per minute / per second / concurrency, or "retry in <seconds>" — are cleared by the next
// retry, whatever quota vocabulary they carry. Google answers a used-up PER-MINUTE quota with the same 429
// RESOURCE_EXHAUSTED ("You exceeded your current quota … Please retry in 40s") as a per-DAY one; only the quota id
// tells them apart. Read as a usage limit, a free-tier Gemini topic got «Usage limit reached» and an hour's wait for a
// limit that cleared in seconds.
const googlePerMinuteQuotaMessage = 'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10, model: gemini-2.5-flash\nPlease retry in 40.15s.';
function buildGoogleQuotaBody(quotaId: string): string {
  return JSON.stringify({ error: { code: 429, message: googlePerMinuteQuotaMessage, status: 'RESOURCE_EXHAUSTED', details: [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId }] },
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '40s' },
  ] } });
}
const googleDailyQuotaBody = buildGoogleQuotaBody('GenerateRequestsPerDayPerProjectPerModel-FreeTier');

test('classify: short-window throttles (per minute / second, concurrency, "retry in Ns", RPM / TPM) → transient, whatever quota words they carry', () => {
  for (const text of [
    googlePerMinuteQuotaMessage,
    buildGoogleQuotaBody('GenerateRequestsPerMinutePerProjectPerModel-FreeTier'),
    'Resource has been exhausted (e.g. check quota).',
    '429 RESOURCE_EXHAUSTED: Resource has been exhausted (e.g. check quota).',
    'Resource exhausted. Please try again later.',
    'Number of concurrent connections has exceeded your rate limit. Please try again later.',
    'Tokens per minute limit exceeded - too many tokens processed.',
    'Concurrency limit reached, try again shortly',
    'Request limit reached (RPM). Please try again in 12 seconds.',
    "You've hit your rate limit, retry after 20s",
    'You have exceeded your rate limit. Please try again later.',
  ]) {
    assert.deepEqual(classifyAgentApiError(text, fixedNow), { kind: 'transient' }, text);
  }
});

test('classify: a quota or window that names a LONG window stays a usage limit, a short retry hint beside it notwithstanding', () => {
  for (const text of [
    googleDailyQuotaBody,
    'You exceeded your current quota (requests per day). Please retry in 30s.',
    'daily limit exceeded for this project, try again tomorrow',
    "You've hit your weekly limit · resets Oct 25, 3pm",
    'usage_limit_reached: monthly token quota used up',
  ]) {
    assert.equal(classifyAgentApiError(text, fixedNow)?.kind, 'usageLimit', text);
  }
});

test('classify: inside a usage limit a short retry hint ("retry in Ns") is not the reset — a stated reset or a clock a few minutes ahead is', () => {
  // Google sends a used-up DAILY quota with the same "Please retry in 40.15s" as a per-minute one. Read as the reset,
  // it put the usage-limit wait at ~100 s and spent the attempts in minutes; the wait is the usual usage-limit delay.
  for (const text of [googleDailyQuotaBody, 'You exceeded your current quota (requests per day). Please retry in 30s.']) {
    assert.deepEqual(classifyAgentApiError(text, fixedNow), { kind: 'usageLimit', resetAt: undefined }, text);
  }
  // A reset the text states as one — "reset(s) in / after" — is the window's own end, however close it is.
  assert.deepEqual(classifyAgentApiError('Daily usage limit reached. Your quota will reset after 4m30s.', fixedNow), { kind: 'usageLimit', resetAt: fixedNow + 4.5 * minuteMs });
  assert.deepEqual(classifyAgentApiError('Session limit reached, resets in 2 minutes', fixedNow), { kind: 'usageLimit', resetAt: fixedNow + 2 * minuteMs });
  // "try again in" is a retry verb as well.
  assert.deepEqual(classifyAgentApiError('Daily quota exceeded. Please try again in 30s.', fixedNow), { kind: 'usageLimit', resetAt: undefined });
  // A few words between the verb and the delay are still the hint.
  for (const text of ['Daily quota exceeded. Please retry your request in 30s.', 'Daily quota exceeded. Please try again later, in 30s.']) {
    assert.deepEqual(classifyAgentApiError(text, fixedNow), { kind: 'usageLimit', resetAt: undefined }, text);
  }
  // A retry verb in an earlier sentence does not turn a stated reset into a hint.
  assert.deepEqual(classifyAgentApiError('Daily usage limit reached, retry later. Your quota will reset after 4m30s.', fixedNow), { kind: 'usageLimit', resetAt: fixedNow + 4.5 * minuteMs });
  // A window's own end, written as a clock time, stays the reset however close it is.
  const closeClockReset = new Date(fixedNow + 3 * minuteMs);
  const clockText = `You've hit your session limit · resets ${closeClockReset.getHours()}:${closeClockReset.getMinutes().toString().padStart(2, '0')}`;
  assert.equal(classifyAgentApiError(clockText, fixedNow)?.resetAt, fixedNow + 3 * minuteMs);
});

test('classify: usage / credit / quota phrasings → usageLimit', () => {
  assert.equal(classifyAgentApiError('Claude usage limit reached', fixedNow)?.kind, 'usageLimit');
  assert.equal(classifyAgentApiError('Credit balance is too low', fixedNow)?.kind, 'usageLimit');
  assert.equal(classifyAgentApiError('You are out of credits', fixedNow)?.kind, 'usageLimit');
  assert.equal(classifyAgentApiError('monthly quota exhausted', fixedNow)?.kind, 'usageLimit');
});

test('classify: auth / logged-out strings → auth (surfaced, never retried)', () => {
  assert.deepEqual(classifyAgentApiError('Please run /login to continue', fixedNow), { kind: 'auth' });
  assert.deepEqual(classifyAgentApiError('Invalid authentication credentials', fixedNow), { kind: 'auth' });
  assert.deepEqual(classifyAgentApiError('You are not logged in', fixedNow), { kind: 'auth' });
});

test('classify: REAL scraped Claude logged-out lines → auth', () => {
  // The exact TUI renders reported live 2026-07-01: the bare
  // "Not logged in" line, and the mixed "…/login · API Error: 401 …" render.
  assert.deepEqual(
    classifyAgentApiError('⎿  Not logged in · Please run /login', fixedNow),
    { kind: 'auth' },
  );
  assert.deepEqual(
    classifyAgentApiError('⎿  Please run /login · API Error: 401 Invalid authentication credentials', fixedNow),
    { kind: 'auth' },
  );
});

test('classify: REAL scraped transient line (⎿ … · API Error: 429) → transient', () => {
  assert.deepEqual(
    classifyAgentApiError('⎿  overloaded · API Error: 429', fixedNow),
    { kind: 'transient' },
  );
});

test('classify: ordinary sentence containing "limit" → null (load-bearing: regex must not be greedy)', () => {
  assert.equal(
    classifyAgentApiError('There is no limit to what we can build', fixedNow),
    null,
  );
  assert.equal(classifyAgentApiError('Let us discuss the rate of progress', fixedNow), null);
});

test('parseResetAt: "resets in 2h" → now + 2h', () => {
  assert.equal(parseResetAt('Your limit resets in 2h', fixedNow), fixedNow + 2 * hourMs);
});

test('parseResetAt: "in 45m" → now + 45m', () => {
  assert.equal(parseResetAt('try again in 45m', fixedNow), fixedNow + 45 * minuteMs);
});

test('parseResetAt: "resets at 3pm" → a sensible future epoch ms (after now, same day)', () => {
  const parsed = parseResetAt('quota resets at 3pm today', fixedNow);
  assert.ok(typeof parsed === 'number');
  assert.ok(parsed > fixedNow, 'reset must be in the future relative to now');
  // 3pm local on the same calendar day as `now` (10:00Z) — within 24h ahead.
  assert.ok(parsed - fixedNow < 24 * hourMs);
  const resetDate = new Date(parsed);
  assert.equal(resetDate.getHours(), 15);
  assert.equal(resetDate.getMinutes(), 0);
});

test('parseResetAt: message with no time → undefined', () => {
  assert.equal(parseResetAt('Claude usage limit reached', fixedNow), undefined);
});

// Gemini refuses a request whose history ends on the model's turn (OpenCode v1's agent loop sends one): a user turn is
// all it asks for, so the bot sends its "continue" at once, once.
const modelTurnRefusal = 'Requests ending with a model turn are not supported.';

test('classify: Gemini\'s "Requests ending with a model turn are not supported" → conversationTail, whatever rides along', () => {
  for (const text of [
    modelTurnRefusal,
    `${modelTurnRefusal}\n\n[Debug Info]\nRequested Model: gemini-3-pro\nProject: example-project-123`,
    JSON.stringify({ error: { code: 400, message: modelTurnRefusal, status: 'INVALID_ARGUMENT' } }),
    `400 ${modelTurnRefusal}\nHTTP 400`,
  ]) {
    assert.deepEqual(classifyAgentApiError(text, fixedNow), { kind: 'conversationTail' }, text);
  }
});

test('classify: other 400s stay unclassified — the class is for that one refusal', () => {
  for (const text of [
    "Unsupported parameter: 'reasoning.summary'",
    JSON.stringify({ error: { code: 400, message: 'Invalid JSON payload received. Unknown name "foo"', status: 'INVALID_ARGUMENT' } }),
    'Please ensure that multiturn requests alternate between user and model.',
    'Requests ending with a user turn are fine.',
  ]) {
    assert.equal(classifyAgentApiError(text, fixedNow), null, text);
  }
});

test('getRetryPlan / decideRetryAction: a conversation-tail refusal is retried once, at once; again within the grace window → give up', () => {
  assert.deepEqual(getRetryPlan({ kind: 'conversationTail', attempt: 1, now: fixedNow }), { delayMs: conversationTailRetryDelayMs });
  assert.ok(conversationTailRetryDelayMs <= 5_000, 'a moment, not the transient minutes');
  assert.deepEqual(getRetryPlan({ kind: 'conversationTail', attempt: 2, now: fixedNow }), { giveUp: true });
  assert.deepEqual(
    decideRetryAction({ kind: 'conversationTail', now: fixedNow, prev: null }),
    { action: 'arm', attempt: 1, delayMs: conversationTailRetryDelayMs, fireAt: fixedNow + conversationTailRetryDelayMs },
  );
  assert.deepEqual(
    decideRetryAction({ kind: 'conversationTail', now: fixedNow, prev: { kind: 'conversationTail', attempt: 1, firedAt: fixedNow - minuteMs, pending: false } }),
    { action: 'giveUp', attempts: 1 },
  );
  // Another class is another episode: a refusal on the "continue" of a short throttle retry still gets its one retry.
  assert.deepEqual(
    decideRetryAction({ kind: 'conversationTail', now: fixedNow, prev: { kind: 'transient', attempt: 1, firedAt: fixedNow - minuteMs, pending: false } }),
    { action: 'arm', attempt: 1, delayMs: conversationTailRetryDelayMs, fireAt: fixedNow + conversationTailRetryDelayMs },
  );
  // A refusal long after the last retry is a fresh episode.
  assert.equal(decideRetryAction({ kind: 'conversationTail', now: fixedNow, prev: { kind: 'conversationTail', attempt: 1, firedAt: fixedNow - retryRecurrenceGraceMs - 1, pending: false } }).action, 'arm');
});

test('getRetryPlan: transient attempts 1/2/3 → 5/10/20 min', () => {
  assert.deepEqual(getRetryPlan({ kind: 'transient', attempt: 1, now: fixedNow }), {
    delayMs: 5 * minuteMs,
  });
  assert.deepEqual(getRetryPlan({ kind: 'transient', attempt: 2, now: fixedNow }), {
    delayMs: 10 * minuteMs,
  });
  assert.deepEqual(getRetryPlan({ kind: 'transient', attempt: 3, now: fixedNow }), {
    delayMs: 20 * minuteMs,
  });
});

test('getRetryPlan: transient attempt 4 → giveUp', () => {
  assert.deepEqual(getRetryPlan({ kind: 'transient', attempt: 4, now: fixedNow }), {
    giveUp: true,
  });
});

test('getRetryPlan: usageLimit with resetAt → delay to reset + buffer', () => {
  const resetAt = fixedNow + 3 * hourMs;
  assert.deepEqual(getRetryPlan({ kind: 'usageLimit', attempt: 1, resetAt, now: fixedNow }), {
    delayMs: 3 * hourMs + resetBufferMs,
  });
});

test('getRetryPlan: usageLimit without resetAt → 60m default', () => {
  assert.deepEqual(getRetryPlan({ kind: 'usageLimit', attempt: 1, now: fixedNow }), {
    delayMs: usageLimitDefaultMs,
  });
  assert.equal(usageLimitDefaultMs, 60 * minuteMs);
});

test('getRetryPlan: usageLimit attempt 7 → giveUp (max 6)', () => {
  assert.deepEqual(getRetryPlan({ kind: 'usageLimit', attempt: 7, now: fixedNow }), {
    giveUp: true,
  });
});

test('getRetryPlan: a far-future resetAt delay is clamped to maxTimeoutMs', () => {
  const resetAt = fixedNow + 1000 * 24 * hourMs; // ~1000 days out, well over the 24.8-day cap
  const plan = getRetryPlan({ kind: 'usageLimit', attempt: 1, resetAt, now: fixedNow });
  assert.ok('delayMs' in plan);
  assert.equal(plan.delayMs, maxTimeoutMs);
});

test('getRetryPlan: a resetAt already in the past clamps to 0 (never negative)', () => {
  const resetAt = fixedNow - 10 * minuteMs;
  const plan = getRetryPlan({ kind: 'usageLimit', attempt: 1, resetAt, now: fixedNow });
  assert.ok('delayMs' in plan);
  assert.equal(plan.delayMs, 0);
});

test('decideRetryAction: no prior record → arm attempt 1 at the first transient delay', () => {
  const result = decideRetryAction({ kind: 'transient', now: fixedNow, prev: null });
  assert.deepEqual(result, {
    action: 'arm',
    attempt: 1,
    delayMs: 5 * minuteMs,
    fireAt: fixedNow + 5 * minuteMs,
  });
});

test('decideRetryAction: a retry already pending → ignore (dedup the same error episode)', () => {
  const result = decideRetryAction({
    kind: 'transient',
    now: fixedNow,
    prev: { kind: 'transient', attempt: 1, firedAt: null, pending: true },
  });
  assert.deepEqual(result, { action: 'ignore' });
});

test('decideRetryAction: a prior fire WITHIN the grace window → escalate to attempt 2 (longer delay)', () => {
  const result = decideRetryAction({
    kind: 'transient',
    now: fixedNow,
    prev: { kind: 'transient', attempt: 1, firedAt: fixedNow - retryRecurrenceGraceMs, pending: false },
  });
  assert.deepEqual(result, {
    action: 'arm',
    attempt: 2,
    delayMs: 10 * minuteMs,
    fireAt: fixedNow + 10 * minuteMs,
  });
});

test('decideRetryAction: a prior fire BEYOND the grace window → fresh episode, back to attempt 1', () => {
  const result = decideRetryAction({
    kind: 'transient',
    now: fixedNow,
    prev: { kind: 'transient', attempt: 3, firedAt: fixedNow - retryRecurrenceGraceMs - 1, pending: false },
  });
  assert.deepEqual(result, {
    action: 'arm',
    attempt: 1,
    delayMs: 5 * minuteMs,
    fireAt: fixedNow + 5 * minuteMs,
  });
});

test('decideRetryAction: transient escalation past the cap → giveUp with attempts=3', () => {
  const result = decideRetryAction({
    kind: 'transient',
    now: fixedNow,
    // attempt 3 fired inside grace → next attempt is 4 → over the cap of 3.
    prev: { kind: 'transient', attempt: 3, firedAt: fixedNow - 1, pending: false },
  });
  assert.deepEqual(result, { action: 'giveUp', attempts: 3 });
});

test('decideRetryAction: usageLimit escalation past the cap → giveUp with attempts=6', () => {
  const result = decideRetryAction({
    kind: 'usageLimit',
    now: fixedNow,
    // attempt 6 fired inside grace → next attempt is 7 → over the cap of 6.
    prev: { kind: 'usageLimit', attempt: 6, firedAt: fixedNow - 1, pending: false },
  });
  assert.deepEqual(result, { action: 'giveUp', attempts: 6 });
});

test('decideRetryAction: auth → surface (never arms a timer, ignores prior record)', () => {
  // No prior record.
  assert.deepEqual(decideRetryAction({ kind: 'auth', now: fixedNow, prev: null }), {
    action: 'surface',
  });
  // Even with a pending prior retry, auth still surfaces (it is decided FIRST,
  // before the pending-dedup branch).
  assert.deepEqual(
    decideRetryAction({
      kind: 'auth',
      now: fixedNow,
      prev: { kind: 'auth', attempt: 2, firedAt: fixedNow - 1, pending: true },
    }),
    { action: 'surface' },
  );
});

test('getRetryPlan: auth → giveUp (defensive guard — never falls into the usage branch)', () => {
  assert.deepEqual(getRetryPlan({ kind: 'auth', attempt: 1, now: fixedNow }), { giveUp: true });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Session / window limit wordings + zone-aware reset parsing
// ─────────────────────────────────────────────────────────────────────────────
//
// The verbatim live string below went UNRECOGNISED (`classifyAgentApiError` →
// `null`), so nothing was armed and the topic just relayed the raw error and sat
// there. A real provider limit cannot be induced on demand, so these REAL strings
// are the load-bearing proof for the whole path.

/** The verbatim live Claude session-limit string (2026-09). */
const liveSessionLimitString = "You've hit your session limit · resets 10:50pm (UTC)";

test('classify: verbatim live session-limit string → usageLimit with the UTC-resolved resetAt', () => {
  const result = classifyAgentApiError(liveSessionLimitString, fixedNow);
  assert.equal(result?.kind, 'usageLimit');
  // fixedNow is 2026-06-09T10:00:00Z, so 22:50 UTC is still ahead the same day.
  assert.equal(result?.resetAt, Date.parse('2026-06-09T22:50:00.000Z'));
});

test('parseResetAt: an explicit zone is load-bearing — (UTC) is NOT read as local time', () => {
  // The process zone MUST be non-UTC here or the assertion proves nothing: a
  // local reading of "10:50pm" on a UTC box lands on the same instant, so the
  // old zone-blind code would pass. Pin the operator's actual box (+04:00, no
  // DST), where the local reading would be 18:50Z — four hours early, so the
  // retry re-errors and burns an attempt. Node re-reads `process.env.TZ` for
  // each new `Date` on POSIX (same technique as `isoTimestamp.test.ts`).
  const originalTz = process.env.TZ;
  process.env.TZ = 'Asia/Dubai';
  try {
    assert.equal(parseResetAt(liveSessionLimitString, fixedNow), Date.parse('2026-06-09T22:50:00.000Z'));
    // Already past today in that zone → the NEXT occurrence rolls to tomorrow.
    const lateNow = Date.parse('2026-06-09T23:30:00.000Z');
    assert.equal(parseResetAt(liveSessionLimitString, lateNow), Date.parse('2026-06-10T22:50:00.000Z'));
  } finally {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  }
});

test('parseResetAt: the other accepted zone spellings resolve on the same timeline', () => {
  assert.equal(parseResetAt('resets 6am UTC', fixedNow), Date.parse('2026-06-10T06:00:00.000Z'));
  assert.equal(parseResetAt('resets at 14:00 GMT', fixedNow), Date.parse('2026-06-09T14:00:00.000Z'));
  assert.equal(parseResetAt('resets 14:00Z', fixedNow), Date.parse('2026-06-09T14:00:00.000Z'));
  // +04:00 → 14:00 there is 10:00Z, which is exactly `now`, so it still counts.
  assert.equal(parseResetAt('resets 14:00 +04:00', fixedNow), Date.parse('2026-06-09T10:00:00.000Z'));
  assert.equal(parseResetAt('resets 14:00 -0400', fixedNow), Date.parse('2026-06-09T18:00:00.000Z'));
});

test('parseResetAt: "resets <clock>" without the word "at" parses (the old pattern needed "at")', () => {
  // No zone → host-local resolution; assert the wall clock rather than an instant.
  const parsed = parseResetAt('5-hour limit reached ∙ resets 3am', fixedNow);
  assert.ok(parsed !== undefined, 'a bare "resets 3am" must parse');
  const at = new Date(parsed);
  assert.equal(at.getHours(), 3);
  assert.equal(at.getMinutes(), 0);
  assert.ok(parsed >= fixedNow, 'the reset must be the NEXT occurrence, never in the past');
});

test('classify: qualified limit wordings → usageLimit', () => {
  for (const text of [
    '5-hour limit reached ∙ resets 3am',
    'You have reached your weekly limit for Claude Opus',
    'Daily limit reached for this model',
    'Monthly limit reached',
    'Hourly limit reached — try again later',
    'limit reached',
  ]) {
    assert.equal(classifyAgentApiError(text, fixedNow)?.kind, 'usageLimit', text);
  }
});

test('classify: an UNKNOWN future wording still matches via the generic fallback', () => {
  // The fallback exists precisely so a reworded limit message does not silently
  // fall back to "relay the raw text and look hung".
  assert.equal(
    classifyAgentApiError('Your Sonnet capacity limit is spent for now; it resets at 9pm', fixedNow)?.kind,
    'usageLimit',
  );
  assert.equal(
    classifyAgentApiError('Your Opus limit is spent for now — try again in 30m', fixedNow)?.kind,
    'usageLimit',
  );
});

test('classify NEGATIVE: prose mentioning a limit with NO reset hint stays null', () => {
  // Both signals are required; "limit" alone is ordinary prose.
  assert.equal(classifyAgentApiError('the API limit is 5 requests per minute', fixedNow), null);
  assert.equal(classifyAgentApiError('I set a limit on the number of retries in the config', fixedNow), null);
});

test('classify NEGATIVE: a CONTEXT/token overflow is never a usage limit — waiting cannot clear it', () => {
  // Real provider wordings. Each carries a limit mention AND a retry hint, so the
  // generic fallback would arm a 6-hour futile wait (the agent's context is full,
  // every "continue" nudge re-errors) instead of surfacing the error to the operator.
  for (const text of [
    'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"input length and `max_tokens` exceed context limit: 205000 + 32000 > 200000, decrease input length or `max_tokens` and try again"}}',
    'API Error: Context limit exceeded — reduce the prompt and try again',
    "This model's maximum context limit is 128000 tokens. However, you requested 140000. Please reduce and try again.",
    'Maximum prompt length limit reached — send less text and try again',
  ]) {
    assert.equal(classifyAgentApiError(text, fixedNow), null, text);
  }
});

test('classify: a usage WINDOW named alongside a token limit is still a usage limit', () => {
  // The context guard must not swallow a real window limit that happens to be
  // spelled with "token" ("hit your weekly token limit").
  assert.equal(
    classifyAgentApiError("You've hit your weekly token limit · resets Monday", fixedNow)?.kind,
    'usageLimit',
  );
});

test('classify: the "(not your usage limit)" transient trap still wins over the new wordings', () => {
  // The transient branch is evaluated BEFORE usage — the broader limit vocabulary
  // must not steal this string.
  assert.deepEqual(classifyAgentApiError(liveTransientString, fixedNow), { kind: 'transient' });
});

test('window over: only a usage limit whose reset is already behind now', () => {
  assert.equal(checkIsUsageLimitWindowOver({ kind: 'usageLimit', resetAt: fixedNow - 1 }, fixedNow), true);
  assert.equal(checkIsUsageLimitWindowOver({ kind: 'usageLimit', resetAt: fixedNow }, fixedNow), true, 'the reset moment itself is over');
  assert.equal(checkIsUsageLimitWindowOver({ kind: 'usageLimit', resetAt: fixedNow + 1 }, fixedNow), false);
  assert.equal(checkIsUsageLimitWindowOver({ kind: 'usageLimit' }, fixedNow), false, 'an unknown reset is still a limit');
  assert.equal(checkIsUsageLimitWindowOver({ kind: 'transient', resetAt: fixedNow - 1 }, fixedNow), false);
});

// Claude Code 2.1.304 appends the zone it formatted the reset in, by its IANA name: "resets 2:10pm (Europe/Moscow)".
// Ignored, the clock was read in the bot's own zone — off by the difference between the two (an hour early, and the
// retry re-errors; or hours late, and the topic waits for nothing).
function withProcessTimezone(timezone: string, run: () => void): void {
  const originalTz = process.env.TZ;
  process.env.TZ = timezone;
  try {
    run();
  } finally {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  }
}

test('parseResetAt: a named IANA zone after the clock is the zone the clock is in, not the bot\'s', () => {
  withProcessTimezone('Asia/Dubai', () => {
    // 2:10pm in Moscow (+03:00, no DST) is 11:10Z — ahead of fixedNow (10:00Z) the same day.
    assert.equal(parseResetAt("You've hit your session limit · resets 2:10pm (Europe/Moscow)", fixedNow), Date.parse('2026-06-09T11:10:00.000Z'));
    // 8am in Moscow is 05:00Z, already past → tomorrow's.
    assert.equal(parseResetAt('resets 8am (Europe/Moscow)', fixedNow), Date.parse('2026-06-10T05:00:00.000Z'));
  });
});

test('parseResetAt: a named zone follows its daylight saving', () => {
  withProcessTimezone('Asia/Dubai', () => {
    // New York is -04:00 in June and -05:00 in January.
    assert.equal(parseResetAt('resets 4pm (America/New_York)', fixedNow), Date.parse('2026-06-09T20:00:00.000Z'));
    const winterNow = Date.parse('2026-01-15T10:00:00.000Z');
    assert.equal(parseResetAt('resets 4pm (America/New_York)', winterNow), Date.parse('2026-01-15T21:00:00.000Z'));
  });
});

test('parseResetAt: an unknown zone name falls back to the bot\'s own zone, as before', () => {
  withProcessTimezone('UTC', () => {
    assert.equal(parseResetAt('resets 2:10pm (Mars/Olympus_Mons)', fixedNow), Date.parse('2026-06-09T14:10:00.000Z'));
  });
});

// A reset more than a day ahead — a weekly window — is written with its date: Claude Code 2.1.304 formats it
// `toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric' })` → "resets Oct 25, 3pm (Europe/Moscow)",
// with the year when it is not this year ("Jan 2, 2027, 3pm"). Unparsed, a real weekly limit was retried every hour
// for six hours — six pointless resumes into the limit — and then given up.
const weeklyNow = Date.parse('2026-10-22T10:00:00.000Z');

test('parseResetAt: a weekly reset with its date and named zone', () => {
  withProcessTimezone('Asia/Dubai', () => {
    // 3pm in Moscow on Oct 25 is 12:00Z.
    assert.equal(parseResetAt("You've hit your weekly limit · resets Oct 25, 3pm (Europe/Moscow)", weeklyNow), Date.parse('2026-10-25T12:00:00.000Z'));
    assert.equal(parseResetAt('resets Oct 25, 3:30pm (Europe/Moscow)', weeklyNow), Date.parse('2026-10-25T12:30:00.000Z'));
  });
});

test('parseResetAt: a dated reset without a zone is the bot\'s own wall clock; with an offset, that offset', () => {
  withProcessTimezone('Asia/Dubai', () => {
    assert.equal(parseResetAt("You've hit your Opus limit · resets Oct 25, 3pm", weeklyNow), Date.parse('2026-10-25T11:00:00.000Z'));
    assert.equal(parseResetAt('resets Oct 25, 3pm (UTC)', weeklyNow), Date.parse('2026-10-25T15:00:00.000Z'));
  });
});

test('parseResetAt: the year when it is written; the next year when the date has passed this year; the "at" form', () => {
  withProcessTimezone('UTC', () => {
    assert.equal(parseResetAt('resets Jan 2, 2027, 3pm (UTC)', weeklyNow), Date.parse('2027-01-02T15:00:00.000Z'));
    const lateDecember = Date.parse('2026-12-30T10:00:00.000Z');
    assert.equal(parseResetAt('resets Jan 2, 3pm', lateDecember), Date.parse('2027-01-02T15:00:00.000Z'));
    // claude.ai's wording: "It resets Oct 25 at 3pm" — the date must win over the bare "at 3pm" clock.
    assert.equal(parseResetAt("You've reached your weekly limit. It resets Oct 25 at 3pm.", weeklyNow), Date.parse('2026-10-25T15:00:00.000Z'));
  });
});

test('classify: a weekly limit with a dated reset arms the wait for that date', () => {
  withProcessTimezone('UTC', () => {
    assert.deepEqual(classifyAgentApiError("You've hit your weekly limit · resets Oct 25, 3pm (Europe/Moscow)", weeklyNow), {
      kind: 'usageLimit',
      resetAt: Date.parse('2026-10-25T12:00:00.000Z'),
    });
  });
});

test('unconfirmed limit: the first one is probed with a short retry; a repeat right after the probe, or a usage reading at 100 %, waits for the reset', () => {
  assert.equal(getUnconfirmedLimitAction({ isRepeatAfterProbe: false, isUsageExhausted: false }), 'probe');
  assert.equal(getUnconfirmedLimitAction({ isRepeatAfterProbe: true, isUsageExhausted: false }), 'waitForReset');
  assert.equal(getUnconfirmedLimitAction({ isRepeatAfterProbe: false, isUsageExhausted: true }), 'waitForReset');
});

test('classify: only the Anthropic "would exceed your account\'s rate limit" wording is unconfirmed — an explicit window is not', () => {
  assert.equal(classifyAgentApiError("You've hit your session limit · resets 10:50pm (UTC)", fixedNow)?.isUnconfirmed, undefined);
  assert.equal(classifyAgentApiError('insufficient_quota: You exceeded your current quota', fixedNow)?.isUnconfirmed, undefined);
});

// OpenCode Go words its usage-limit reset as every unit there is: "It will reset in 2 hours 30 minutes",
// "in 1 day 3 hours" (opencode `session/retry.ts`). Only the first part was read — the resume came 30 minutes early,
// hit the limit again and burned an attempt.
test('parseResetAt: a relative reset in several parts is their sum', () => {
  const minuteMs = 60 * 1000;
  assert.equal(parseResetAt('Usage limit reached. It will reset in 2 hours 30 minutes. To continue …', fixedNow), fixedNow + 2 * hourMs + 30 * minuteMs);
  assert.equal(parseResetAt('Usage limit reached. It will reset in 1 day 3 hours.', fixedNow), fixedNow + 27 * hourMs);
  assert.equal(parseResetAt('resets in 2h 15m', fixedNow), fixedNow + 2 * hourMs + 15 * minuteMs);
  assert.equal(parseResetAt('resets in 1h30m', fixedNow), fixedNow + 90 * minuteMs);
  assert.equal(parseResetAt('Usage limit reached. It will reset in 45 minutes.', fixedNow), fixedNow + 45 * minuteMs);
});

// An ISO stamp with no zone says nothing about which zone it is in (RFC 3339 requires an offset; no provider documents
// a zone-less reset). Read in the bot's zone it could be hours off either way — a resume into the limit, or a wait long
// past it. It counts only with a zone after it; otherwise the reset is unknown (the fixed delay, or OpenCode's own
// Retry-After) rather than guessed.
test('parseResetAt: a zone-less ISO stamp is not a reset unless a zone follows it', () => {
  withProcessTimezone('Asia/Dubai', () => {
    assert.equal(parseResetAt('Your quota resets at 2026-06-09 23:29:00.', fixedNow), undefined);
    assert.equal(parseResetAt('Your quota resets at 2026-06-09T23:29:00, try later.', fixedNow), undefined);
    assert.equal(parseResetAt('Your quota resets at 2026-06-09 23:29 UTC.', fixedNow), Date.parse('2026-06-09T23:29:00.000Z'));
    assert.equal(parseResetAt('Your quota resets at 2026-06-09 23:29 (Europe/Moscow).', fixedNow), Date.parse('2026-06-09T20:29:00.000Z'));
    assert.equal(parseResetAt('Your quota resets at 2026-06-09T23:29:00Z.', fixedNow), Date.parse('2026-06-09T23:29:00.000Z'));
    assert.equal(parseResetAt('Your quota resets at 2026-06-09T23:29:00+04:00.', fixedNow), Date.parse('2026-06-09T19:29:00.000Z'));
  });
});

// Google's subscription / Antigravity quotas: "You have exhausted your capacity on this model. Your quota will reset
// after 2s." — and after "8h27m3s", "146h52m11s. Your plan's baseline quota will refresh on …" (forum reports). The
// stated duration decides: seconds are a throttle the next retry clears; hours are a usage window to wait out. Neither
// "after" nor seconds were read, so the 2 s one became «Usage limit reached» and an hour's wait, and the hours-long one
// wrapped in RESOURCE_EXHAUSTED became short retries that gave up long before the reset.
const googleCapacityMessage = (duration: string): string => `You have exhausted your capacity on this model. Your quota will reset after ${duration}.`;
const wrapInGoogleBody = (message: string): string => JSON.stringify({ error: { code: 429, message, status: 'RESOURCE_EXHAUSTED' } });

test('classify: Google\'s "exhausted your capacity … reset after Ns" is a short throttle, bare or in its JSON body', () => {
  for (const text of [googleCapacityMessage('2s'), `RESOURCE_EXHAUSTED (code 429): ${googleCapacityMessage('1s')}`, wrapInGoogleBody(googleCapacityMessage('2s'))]) {
    assert.deepEqual(classifyAgentApiError(text, fixedNow), { kind: 'transient' }, text);
  }
});

test('classify: the same wording with an hours-long reset is a usage limit until then, bare or in RESOURCE_EXHAUSTED', () => {
  const sec = 1000;
  const minute = 60 * sec;
  for (const [text, resetInMs] of [
    [googleCapacityMessage('8h27m3s'), 8 * hourMs + 27 * minute + 3 * sec],
    [wrapInGoogleBody(googleCapacityMessage('8h27m3s')), 8 * hourMs + 27 * minute + 3 * sec],
    [`${googleCapacityMessage('146h52m11s')} Your plan's baseline quota will refresh on 3/24/2026 5:50 PM.`, 146 * hourMs + 52 * minute + 11 * sec],
  ] as const) {
    assert.deepEqual(classifyAgentApiError(text, fixedNow), { kind: 'usageLimit', resetAt: fixedNow + resetInMs }, text);
  }
});

test('parseResetAt: "after <duration>" and seconds are read', () => {
  assert.equal(parseResetAt('Your quota will reset after 8h27m3s.', fixedNow), fixedNow + 8 * hourMs + 27 * 60_000 + 3_000);
  assert.equal(parseResetAt('quota resets in 90s', fixedNow), fixedNow + 90_000);
  assert.equal(parseResetAt('Please retry in 40.15s.', fixedNow), fixedNow + 40_150);
});

/** The ChatGPT subscription's 429 body that OpenCode relays as the response body (codex-rs `UsageErrorBody` fields). */
function chatGptUsageLimitBody(resetField: string): string {
  return `{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"plus",${resetField}}}`;
}

test('classify: the ChatGPT usage_limit_reached body → a usage limit until its resets_at epoch (or its resets_in_seconds)', () => {
  const resetsAtSeconds = Math.floor(fixedNow / 1000) + 4 * 24 * 3600;
  assert.deepEqual(
    classifyAgentApiError(chatGptUsageLimitBody(`"resets_at":${resetsAtSeconds},"limit_window_minutes":10080`), fixedNow),
    { kind: 'usageLimit', resetAt: resetsAtSeconds * 1000 },
  );
  assert.deepEqual(
    classifyAgentApiError(chatGptUsageLimitBody('"resets_in_seconds":9000'), fixedNow),
    { kind: 'usageLimit', resetAt: fixedNow + 9000 * 1000 },
  );
  // A zero wait is no reset (it would arm an instant retry).
  assert.equal(parseResetAt(chatGptUsageLimitBody('"resets_in_seconds":0'), fixedNow), undefined);
});

test('classify: a machine-form epoch already behind now is no reset — the limit waits the default, not a zero-delay retry', () => {
  const pastSeconds = Math.floor(fixedNow / 1000) - 3600;
  for (const text of [chatGptUsageLimitBody(`"resets_at":${pastSeconds}`), `Claude AI usage limit reached|${pastSeconds}`]) {
    const cls = classifyAgentApiError(text, fixedNow);
    assert.deepEqual(cls, { kind: 'usageLimit', resetAt: undefined }, text);
    assert.deepEqual(decideRetryAction({ kind: 'usageLimit', resetAt: cls?.kind === 'usageLimit' ? cls.resetAt : undefined, now: fixedNow, prev: null }),
      { action: 'arm', attempt: 1, delayMs: usageLimitDefaultMs, fireAt: fixedNow + usageLimitDefaultMs }, text);
  }
  // The boot recovery reads a parked error against the time it was written: that reset is kept, and over by now.
  const writtenAtMs = fixedNow - 2 * 3600_000;
  const recovered = classifyAgentApiError(chatGptUsageLimitBody(`"resets_at":${pastSeconds}`), writtenAtMs);
  assert.deepEqual(recovered, { kind: 'usageLimit', resetAt: pastSeconds * 1000 });
  assert.equal(recovered !== null && checkIsUsageLimitWindowOver(recovered, fixedNow), true);
});

test('classify: the body\'s machine-form reset is the window\'s end, never a retry hint — even a short one beside "try again in"', () => {
  const text = chatGptUsageLimitBody('"resets_in_seconds":120').replace('has been reached', 'has been reached. Please try again in 2 minutes');
  assert.deepEqual(classifyAgentApiError(text, fixedNow), { kind: 'usageLimit', resetAt: fixedNow + 120_000 });
});

test('classify: an older Claude Code\'s "usage limit reached|<epoch>" → a usage limit until that epoch', () => {
  const resetsAtSeconds = Math.floor(fixedNow / 1000) + 3 * 3600;
  assert.deepEqual(classifyAgentApiError(`Claude AI usage limit reached|${resetsAtSeconds}`, fixedNow), { kind: 'usageLimit', resetAt: resetsAtSeconds * 1000 });
});
