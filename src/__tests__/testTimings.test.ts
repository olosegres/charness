/**
 * `CHARNESS_TEST_TIMINGS` (`testTimings.ts`): the one test-only timing seam.
 *
 * Load-bearing facts proven here:
 *   • unset or blank = no overrides, so a production instance keeps every built-in window;
 *   • a valid object is read as is;
 *   • anything else — not JSON, an unknown key, a value that is not a positive whole number of ms — is an error that
 *     names the variable and the key (the boot then stops with it);
 *   • the boot line names every override in force, and there is none without one.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatTestTimingsBootLine, parseTestTimings, testTimingsEnvName } from '../testTimings';

describe('parseTestTimings', () => {
  it('unset or blank: no overrides', () => {
    assert.deepEqual(parseTestTimings(undefined), { ok: true, timings: {} });
    assert.deepEqual(parseTestTimings('  '), { ok: true, timings: {} });
  });

  it('a valid object is read as is', () => {
    const timings = { telegramSendIntervalMs: 200, jiraPollIntervalMs: 2000, requestSweepIntervalMs: 10_000, requestFirstPostRetryDelayMs: 10_000, limitProbeDelayMs: 30_000 };
    assert.deepEqual(parseTestTimings(JSON.stringify(timings)), { ok: true, timings });
  });

  it('not JSON: one error naming the variable', () => {
    const parsed = parseTestTimings('{sendInterval: 1}');
    assert.equal(parsed.ok, false);
    assert.ok(!parsed.ok && parsed.errors.length === 1 && parsed.errors[0].startsWith(`${testTimingsEnvName} is not JSON:`), JSON.stringify(parsed));
  });

  it('an unknown key is an error naming it — a typo never silently keeps the production window', () => {
    const parsed = parseTestTimings(JSON.stringify({ telegramSendIntervalMS: 200 }));
    assert.equal(parsed.ok, false);
    assert.ok(!parsed.ok && parsed.errors.some((error) => error.startsWith(testTimingsEnvName) && error.includes('telegramSendIntervalMS')), JSON.stringify(parsed));
  });

  it('a value that is not a positive whole number of ms is an error naming its key', () => {
    for (const badValue of [0, -5, 1.5, '200']) {
      const parsed = parseTestTimings(JSON.stringify({ limitProbeDelayMs: badValue }));
      assert.equal(parsed.ok, false, `${JSON.stringify(badValue)} is refused`);
      assert.ok(!parsed.ok && parsed.errors.every((error) => error.startsWith(`${testTimingsEnvName} limitProbeDelayMs:`)), JSON.stringify(parsed));
    }
  });
});

describe('formatTestTimingsBootLine', () => {
  it('no overrides, no line', () => {
    assert.equal(formatTestTimingsBootLine({}), null);
  });

  it('names every override in force with its value', () => {
    assert.equal(
      formatTestTimingsBootLine({ telegramSendIntervalMs: 200, limitProbeDelayMs: 30_000 }),
      `[test-timings] ${testTimingsEnvName} overrides active: telegramSendIntervalMs=200, limitProbeDelayMs=30000`,
    );
  });
});
