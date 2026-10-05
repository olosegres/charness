/**
 * Test case: N/A — Charness has no Jira tracker
 *
 * @description The instance timezone core: validation, canonicalization, the
 * picker's zone catalog, wall-clock formatting, and the process apply.
 *
 * Load-bearing intent (per `.claude/rules/tests.md`):
 * - `applyProcessTimezone` really RE-BASES `Date`/`Intl` at runtime. The whole
 *   feature rests on that Node behaviour, and the risk register says to assert
 *   it rather than trust it: if assigning `process.env.TZ` stopped taking
 *   effect mid-process, `/timezone` would silently do nothing and only the
 *   next restart would apply a change.
 * - a reset restores the process to EXACTLY its launch environment, which is
 *   what makes `/timezone auto` return to the host zone.
 * - an invalid zone is REJECTED (never persisted), while a fixed `±HH:MM`
 *   offset is ACCEPTED — that asymmetry is a locked decision, not an accident.
 * - formatting reports the zone's OWN clock, not the host's: a formatter that
 *   quietly ignored `timeZone` would render a plausible-looking but wrong
 *   confirmation, which is the one thing the confirmation exists to prevent.
 */

import { test, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  applyProcessTimezone,
  checkIsApplicableTimezone,
  checkIsFixedOffsetZone,
  getProcessTimezoneValue,
  checkIsValidTimezone,
  formatZoneNow,
  formatZoneNowWithDate,
  getCanonicalTimezone,
  getEffectiveTimezone,
  getHostTimezone,
  getTimezoneRegion,
  getTimezonesForRegion,
  listTimezoneRegions,
} from '../utils/timezone';

/** A fixed instant so every formatting assertion is deterministic. */
const referenceInstantMs = Date.UTC(2026, 8, 14, 15, 42, 7);

afterEach(() => {
  // Never leak a timezone into a sibling test in the same process.
  applyProcessTimezone(null);
});

test('checkIsValidTimezone accepts IANA names and fixed offsets, rejects nonsense', () => {
  assert.equal(checkIsValidTimezone('Europe/Moscow'), true);
  assert.equal(checkIsValidTimezone('America/Argentina/Buenos_Aires'), true);
  assert.equal(checkIsValidTimezone('UTC'), true);
  // Accepted deliberately: Intl treats an offset as a real zone. The DST
  // downside is surfaced as a warning rather than a rejection.
  assert.equal(checkIsValidTimezone('+04:00'), true);

  assert.equal(checkIsValidTimezone('Bogus/Zone'), false);
  assert.equal(checkIsValidTimezone('Europe/Moscowww'), false);
  assert.equal(checkIsValidTimezone(''), false);
  assert.equal(checkIsValidTimezone('   '), false);
});

test('getCanonicalTimezone normalizes spelling so one stable form is stored', () => {
  // What the operator types must not become what is persisted: `europe/moscow`
  // and `Europe/Moscow` are the same zone and have to compare equal later (the
  // picker's ✓ placement is a string comparison against the stored value).
  assert.equal(getCanonicalTimezone('europe/moscow'), 'Europe/Moscow');
  assert.equal(getCanonicalTimezone('Europe/Moscow'), 'Europe/Moscow');
  assert.equal(getCanonicalTimezone('+0400'), '+04:00');
  assert.equal(getCanonicalTimezone('Bogus/Zone'), null);
});

test('checkIsFixedOffsetZone separates offsets from real regions', () => {
  assert.equal(checkIsFixedOffsetZone('+04:00'), true);
  assert.equal(checkIsFixedOffsetZone('-03:30'), true);
  assert.equal(checkIsFixedOffsetZone('+05'), true);
  assert.equal(checkIsFixedOffsetZone('Europe/Moscow'), false);
  assert.equal(checkIsFixedOffsetZone('UTC'), false);
});

test('the zone catalog exposes exactly the IANA regions, sorted', () => {
  const regions = listTimezoneRegions();
  assert.deepEqual(regions, [...regions].sort(), 'regions must be sorted');
  assert.deepEqual(regions, [
    'Africa', 'America', 'Antarctica', 'Arctic', 'Asia',
    'Atlantic', 'Australia', 'Europe', 'Indian', 'Pacific',
  ]);
});

test('getTimezonesForRegion returns that region only, sorted, and never throws', () => {
  const europe = getTimezonesForRegion('Europe');
  assert.ok(europe.includes('Europe/Moscow'));
  assert.ok(europe.includes('Europe/London'));
  assert.ok(europe.every((zone) => zone.startsWith('Europe/')), 'no foreign region leaked in');
  assert.deepEqual(europe, [...europe].sort(), 'zones must be sorted');

  // A stale callback can name a region that no longer resolves — that must be
  // an empty page, not an exception inside a Telegram handler.
  assert.deepEqual(getTimezonesForRegion('Nowhere'), []);
});

test('getTimezoneRegion reads the region off a zone name', () => {
  assert.equal(getTimezoneRegion('Europe/Moscow'), 'Europe');
  assert.equal(getTimezoneRegion('America/Argentina/Buenos_Aires'), 'America');
  // A fixed offset belongs to no region — so no region button gets a ✓.
  assert.equal(getTimezoneRegion('+04:00'), null);
  assert.equal(getTimezoneRegion('UTC'), null);
});

test('formatZoneNow renders the ZONE\'s own wall clock and offset', () => {
  // 15:42 UTC is 18:42 in Moscow (+03:00) and 21:12 in Kolkata (+05:30).
  assert.equal(formatZoneNow('UTC', referenceInstantMs), '15:42 (+00:00)');
  assert.equal(formatZoneNow('Europe/Moscow', referenceInstantMs), '18:42 (+03:00)');
  assert.equal(formatZoneNow('Asia/Kolkata', referenceInstantMs), '21:12 (+05:30)');
  assert.equal(formatZoneNow('+04:00', referenceInstantMs), '19:42 (+04:00)');
});

test('formatZoneNowWithDate carries the calendar day the zone is actually on', () => {
  assert.equal(formatZoneNowWithDate('Europe/Moscow', referenceInstantMs), '2026-09-14 18:42 (+03:00)');
  // Far enough east that the same instant is already the NEXT day — exactly the
  // mistake the picker header's date is there to make visible.
  assert.equal(formatZoneNowWithDate('Pacific/Auckland', referenceInstantMs), '2026-09-15 03:42 (+12:00)');
});

test('getEffectiveTimezone falls back to the host zone when nothing is stored', () => {
  assert.equal(getEffectiveTimezone('Europe/Moscow'), 'Europe/Moscow');
  assert.equal(getEffectiveTimezone(null), getHostTimezone());
});

test('applyProcessTimezone re-bases Date and Intl immediately, with no restart', () => {
  // THE load-bearing assumption of the whole feature. If this ever regresses,
  // `/timezone` becomes a setting that only takes effect on the next boot.
  applyProcessTimezone('Europe/Moscow');
  const moscow = new Date(referenceInstantMs);
  assert.equal(moscow.getHours(), 18, 'Date must read the newly applied zone');
  assert.equal(new Intl.DateTimeFormat().resolvedOptions().timeZone, 'Europe/Moscow');
  // -180 minutes == UTC+3, the value `formatIsoLocalOffset` derives its offset from.
  assert.equal(moscow.getTimezoneOffset(), -180);

  applyProcessTimezone('Asia/Kolkata');
  assert.equal(new Date(referenceInstantMs).getHours(), 21, 'a second change applies too');
});

test('a fixed offset is applied as its Etc/GMT equivalent, not verbatim', () => {
  // THE reason this mapping exists: ICU parses the `TZ` env itself and resolves
  // `TZ="+04:00"` to UTC instead of rejecting it, so assigning the offset
  // verbatim leaves every clock on UTC while the confirmation — formatted
  // through Intl, which DOES support offset zones — prints `+04:00`.
  assert.equal(getProcessTimezoneValue('+04:00'), 'Etc/GMT-4', 'POSIX sign inversion');
  assert.equal(getProcessTimezoneValue('-03:00'), 'Etc/GMT+3');
  assert.equal(getProcessTimezoneValue('Europe/Moscow'), 'Europe/Moscow', 'IANA names pass through');

  applyProcessTimezone('+04:00');
  assert.equal(new Date(referenceInstantMs).getHours(), 19, '15:42 UTC is 19:42 at +04:00');
  assert.equal(new Date(referenceInstantMs).getTimezoneOffset(), -240);
});

test('an offset that no TZ value can express is refused rather than silently ignored', () => {
  // Half-hour offsets have no `Etc/GMT` equivalent and no other `TZ` spelling
  // that ICU honours, so `/timezone` must reject them at the boundary.
  assert.equal(getProcessTimezoneValue('+05:30'), null);
  assert.equal(checkIsApplicableTimezone('+05:30'), false);
  assert.equal(checkIsApplicableTimezone('-03:30'), false);
  // Beyond the widest Etc/GMT zones tzdata defines (UTC+14 .. UTC−12).
  assert.equal(checkIsApplicableTimezone('+15:00'), false);

  assert.equal(checkIsApplicableTimezone('+04:00'), true);
  assert.equal(checkIsApplicableTimezone('Asia/Kolkata'), true, 'the IANA name for +05:30 works');

  // A stored-but-unapplicable value must not leave the process on UTC while
  // reporting the offset: it falls back to the launch environment.
  applyProcessTimezone('+05:30');
  assert.equal(new Intl.DateTimeFormat().resolvedOptions().timeZone, getHostTimezone());
});

test('applyProcessTimezone(null) restores the launch environment', () => {
  const launchEnv = process.env.TZ;
  applyProcessTimezone('Pacific/Auckland');
  applyProcessTimezone(null);
  assert.equal(process.env.TZ, launchEnv, 'reset must restore TZ exactly as launched');
  assert.equal(
    new Intl.DateTimeFormat().resolvedOptions().timeZone,
    getHostTimezone(),
    '/timezone auto must return to the host zone',
  );
});
