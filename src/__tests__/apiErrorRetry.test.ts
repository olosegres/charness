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
    'The model is overloaded',
    'Too Many Requests',
    'HTTP 429 returned by provider',
    'upstream responded with 503',
    'got a 529 from the API',
  ]) {
    assert.deepEqual(classifyAgentApiError(text, fixedNow), { kind: 'transient' }, text);
  }
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
    prev: { attempt: 1, firedAt: null, pending: true },
  });
  assert.deepEqual(result, { action: 'ignore' });
});

test('decideRetryAction: a prior fire WITHIN the grace window → escalate to attempt 2 (longer delay)', () => {
  const result = decideRetryAction({
    kind: 'transient',
    now: fixedNow,
    prev: { attempt: 1, firedAt: fixedNow - retryRecurrenceGraceMs, pending: false },
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
    prev: { attempt: 3, firedAt: fixedNow - retryRecurrenceGraceMs - 1, pending: false },
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
    prev: { attempt: 3, firedAt: fixedNow - 1, pending: false },
  });
  assert.deepEqual(result, { action: 'giveUp', attempts: 3 });
});

test('decideRetryAction: usageLimit escalation past the cap → giveUp with attempts=6', () => {
  const result = decideRetryAction({
    kind: 'usageLimit',
    now: fixedNow,
    // attempt 6 fired inside grace → next attempt is 7 → over the cap of 6.
    prev: { attempt: 6, firedAt: fixedNow - 1, pending: false },
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
      prev: { attempt: 2, firedAt: fixedNow - 1, pending: true },
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
