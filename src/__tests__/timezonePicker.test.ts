/**
 * Test case: N/A — Charness has no Jira tracker
 *
 * @description The two-level `/timezone` picker: the region keyboard, a
 * region's paginated zone pages, the `✓` placement, and the INDEX-based
 * callback codec.
 *
 * Load-bearing intent (per `.claude/rules/tests.md`):
 * - EVERY callback id the picker can emit fits Telegram's 64-BYTE
 *   `callback_data` cap. This is the reason the codec carries indexes at all:
 *   `America/Argentina/Buenos_Aires` plus a region index and a page number does
 *   not fit, and an over-long id is rejected by Telegram (or worse, truncated
 *   into a DIFFERENT zone). Asserted against the longest zone name that exists.
 * - a zone button's index is absolute within its region, not relative to the
 *   page slice — an off-by-page index would apply the wrong zone from page 2
 *   onwards, silently and plausibly.
 * - a stale page index is CLAMPED to the last real page rather than rendering
 *   an empty body, and a stale region/zone index resolves to `null` so the
 *   handler can answer "expired" instead of picking a neighbouring zone.
 * - the `✓` tracks the CURRENT selection at both levels, including the
 *   `🌐 Auto` row when nothing is stored — the picker is the only place the
 *   operator can see what is set without leaving it.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { checkIsCallbackDataWithinLimit } from '../utils/modelPickerPlan';
import { getTimezonesForRegion, listTimezoneRegions } from '../utils/timezone';
import {
  buildRegionPageCallback,
  buildTimezoneRegionPicker,
  buildTimezoneZonePicker,
  buildZonePickCallback,
  getTimezoneAt,
  getTimezoneRegionAt,
  parseRegionPageCallback,
  parseZonePickCallback,
  regionPageCallbackRe,
  timezoneAutoCallback,
  timezonePageSize,
  timezonePickerBackCallback,
  zonePickCallbackRe,
} from '../connectors/telegram/timezonePicker';

interface RenderedButton {
  text: string;
  callback_data?: string;
}

function getButtons(keyboard: { reply_markup: { inline_keyboard: RenderedButton[][] } }): RenderedButton[] {
  return keyboard.reply_markup.inline_keyboard.flat();
}

test('the codec round-trips and stays inside Telegram\'s 64-byte callback cap', () => {
  assert.deepEqual(parseRegionPageCallback(buildRegionPageCallback(7, 3)), { regionIndex: 7, page: 3 });
  assert.deepEqual(parseZonePickCallback(buildZonePickCallback(1, 144)), { regionIndex: 1, zoneIndex: 144 });

  // Anything that is not our exact wire shape must not be mistaken for it.
  assert.equal(parseRegionPageCallback('tzr_7'), null);
  assert.equal(parseZonePickCallback('tz_a_b'), null);
  assert.equal(parseZonePickCallback(buildRegionPageCallback(7, 3)), null);

  // The real budget check: every id this picker can ever emit, across the whole
  // catalog — plus the literal ids.
  for (const literal of [timezoneAutoCallback, timezonePickerBackCallback]) {
    assert.ok(checkIsCallbackDataWithinLimit(literal), `literal "${literal}" exceeds the cap`);
  }
  const regions = listTimezoneRegions();
  for (let regionIndex = 0; regionIndex < regions.length; regionIndex += 1) {
    const zones = getTimezonesForRegion(regions[regionIndex]);
    const lastPage = Math.max(0, Math.ceil(zones.length / timezonePageSize) - 1);
    const pageCallback = buildRegionPageCallback(regionIndex, lastPage);
    assert.ok(checkIsCallbackDataWithinLimit(pageCallback), `"${pageCallback}" exceeds the cap`);
    for (let zoneIndex = 0; zoneIndex < zones.length; zoneIndex += 1) {
      const zoneCallback = buildZonePickCallback(regionIndex, zoneIndex);
      assert.ok(checkIsCallbackDataWithinLimit(zoneCallback), `"${zoneCallback}" exceeds the cap`);
      assert.ok(zonePickCallbackRe.test(zoneCallback), `"${zoneCallback}" must match the handler regex`);
    }
    assert.ok(regionPageCallbackRe.test(pageCallback), `"${pageCallback}" must match the handler regex`);
  }
});

test('the region picker lists every region plus an Auto row, ✓ on the current region', () => {
  const buttons = getButtons(buildTimezoneRegionPicker('Europe/Moscow'));
  const regions = listTimezoneRegions();
  assert.equal(buttons.length, regions.length + 1, 'one button per region plus the Auto row');

  const europe = buttons.find((button) => button.text.endsWith('Europe'));
  assert.equal(europe?.text, '✓ Europe');
  assert.equal(europe?.callback_data, buildRegionPageCallback(regions.indexOf('Europe'), 0));

  const asia = buttons.find((button) => button.text === 'Asia');
  assert.ok(asia, 'a non-current region carries no ✓');

  const auto = buttons.at(-1);
  assert.equal(auto?.callback_data, timezoneAutoCallback);
  assert.equal(auto?.text, '🌐 Auto (host zone)', 'Auto is unmarked while a zone is stored');
});

test('the region picker marks Auto when nothing is stored, and no region for an offset zone', () => {
  const autoButtons = getButtons(buildTimezoneRegionPicker(null));
  assert.equal(autoButtons.at(-1)?.text, '✓ 🌐 Auto (host zone)');
  assert.ok(autoButtons.every((button) => !button.text.startsWith('✓ ') || button.text.includes('Auto')));

  // A fixed offset belongs to no region: marking one would be a guess.
  const offsetButtons = getButtons(buildTimezoneRegionPicker('+04:00'));
  assert.ok(offsetButtons.every((button) => !button.text.startsWith('✓ ')), 'nothing is marked');
});

test('a zone page lists one page of zones plus navigation, with absolute indexes', () => {
  const regionIndex = listTimezoneRegions().indexOf('Europe');
  const zones = getTimezonesForRegion('Europe');
  const render = buildTimezoneZonePicker(regionIndex, 1, null);
  assert.ok(render);
  assert.equal(render.region, 'Europe');
  assert.equal(render.currentPage, 1);
  assert.equal(render.totalPages, Math.ceil(zones.length / timezonePageSize));

  const rows = render.keyboard.reply_markup.inline_keyboard as RenderedButton[][];
  const zoneRows = rows.slice(0, -1);
  assert.equal(zoneRows.length, timezonePageSize, 'a full middle page shows a full slice');

  // Page 2's first button must carry the index of the (pageSize)th zone in the
  // REGION, not index 0 of the slice — the off-by-page bug this guards.
  const firstOnPage = zoneRows[0][0];
  assert.equal(firstOnPage.text, zones[timezonePageSize]);
  assert.equal(firstOnPage.callback_data, buildZonePickCallback(regionIndex, timezonePageSize));
  assert.equal(getTimezoneAt(regionIndex, timezonePageSize), zones[timezonePageSize]);

  const navigation = rows.at(-1) as RenderedButton[];
  assert.deepEqual(
    navigation.map((button) => button.callback_data),
    [
      buildRegionPageCallback(regionIndex, 0),
      timezonePickerBackCallback,
      buildRegionPageCallback(regionIndex, 2),
    ],
  );
});

test('the current zone carries ✓ on its own page', () => {
  const regionIndex = listTimezoneRegions().indexOf('Europe');
  const zones = getTimezonesForRegion('Europe');
  const moscowIndex = zones.indexOf('Europe/Moscow');
  const page = Math.floor(moscowIndex / timezonePageSize);

  const render = buildTimezoneZonePicker(regionIndex, page, 'Europe/Moscow');
  assert.ok(render);
  const marked = getButtons(render.keyboard).filter((button) => button.text.startsWith('✓ '));
  assert.deepEqual(marked.map((button) => button.text), ['✓ Europe/Moscow']);
});

test('the first and last pages drop the navigation arrow they cannot use', () => {
  const regionIndex = listTimezoneRegions().indexOf('Europe');
  const first = buildTimezoneZonePicker(regionIndex, 0, null);
  assert.ok(first);
  const firstNavigation = (first.keyboard.reply_markup.inline_keyboard as RenderedButton[][]).at(-1);
  assert.deepEqual(firstNavigation?.map((button) => button.text), ['⬅ Regions', 'Next ›']);

  const last = buildTimezoneZonePicker(regionIndex, first.totalPages - 1, null);
  assert.ok(last);
  const lastNavigation = (last.keyboard.reply_markup.inline_keyboard as RenderedButton[][]).at(-1);
  assert.deepEqual(lastNavigation?.map((button) => button.text), ['‹ Prev', '⬅ Regions']);
});

test('a stale page is clamped to the last real page instead of rendering nothing', () => {
  const regionIndex = listTimezoneRegions().indexOf('Arctic');
  const render = buildTimezoneZonePicker(regionIndex, 999, null);
  assert.ok(render);
  assert.equal(render.currentPage, render.totalPages - 1);
  // The clamped page must still offer at least one real zone button.
  const rows = render.keyboard.reply_markup.inline_keyboard as RenderedButton[][];
  assert.ok(rows.length > 1, 'clamped page still renders zone buttons above the nav row');
});

test('stale region / zone indexes resolve to null so the handler can answer "expired"', () => {
  const regionCount = listTimezoneRegions().length;
  assert.equal(buildTimezoneZonePicker(regionCount, 0, null), null);
  assert.equal(getTimezoneRegionAt(regionCount), null);
  assert.equal(getTimezoneAt(regionCount, 0), null);
  // In-range region, out-of-range zone: must NOT silently fall back to a
  // neighbour — that would apply a timezone the operator never tapped.
  assert.equal(getTimezoneAt(0, getTimezonesForRegion(listTimezoneRegions()[0]).length), null);
});
