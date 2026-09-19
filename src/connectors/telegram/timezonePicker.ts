/**
 * @description Pure builders + callback codec for the two-level `/timezone`
 * picker: level 1 is the 10 IANA regions, level 2 is that region's zones,
 * paginated.
 *
 * Two levels rather than one flat list because there are 418 zones — the same
 * constraint that forced `/model` into a provider → models picker once a
 * provider with hundreds of models appeared. And every callback carries INDEXES
 * rather than the zone name: `America/Argentina/Buenos_Aires` plus a region
 * index and a page number does not reliably fit Telegram's 64-BYTE
 * `callback_data` cap, and a truncated id resolves to the wrong zone silently.
 *
 * Kept pure (no `t()`, no bot state) so the `✓` placement, the pagination
 * clamping and the codec round-trip are unit-testable without a Telegram
 * surface. Header TEXT is the caller's job — it is localized, the keyboard is
 * not.
 */
import { Markup } from 'telegraf';

import { paginateList } from '../../utils/paginateList';
import { getTimezoneRegion, getTimezonesForRegion, listTimezoneRegions } from '../../utils/timezone';

/** Zones listed per level-2 page — one per row, matching `/model`'s page size. */
export const timezonePageSize = 10;

/** Regions per keyboard row on level 1 (10 regions ⇒ 5 rows). */
const regionsPerRow = 2;

const regionPageCallbackPrefix = 'tzr_';
const zonePickCallbackPrefix = 'tz_';

/** Back to the region level (level 2 → level 1). */
export const timezonePickerBackCallback = 'tzback';
/** Reset the setting to the host zone. */
export const timezoneAutoCallback = 'tzauto';

/** Anchored matchers for `bot.action(...)` — the wire format's single definition. */
export const regionPageCallbackRe = /^tzr_(\d+)_(\d+)$/;
export const zonePickCallbackRe = /^tz_(\d+)_(\d+)$/;

/** A region index paired with a page index (level-2 navigation). */
export interface RegionPageRef {
  regionIndex: number;
  page: number;
}

/** A region index paired with a zone index WITHIN that region's list. */
export interface ZonePickRef {
  regionIndex: number;
  zoneIndex: number;
}

export function buildRegionPageCallback(regionIndex: number, page: number): string {
  return `${regionPageCallbackPrefix}${regionIndex}_${page}`;
}

export function buildZonePickCallback(regionIndex: number, zoneIndex: number): string {
  return `${zonePickCallbackPrefix}${regionIndex}_${zoneIndex}`;
}

export function parseRegionPageCallback(callbackData: string): RegionPageRef | null {
  const match = regionPageCallbackRe.exec(callbackData);
  if (!match) return null;
  return { regionIndex: Number(match[1]), page: Number(match[2]) };
}

export function parseZonePickCallback(callbackData: string): ZonePickRef | null {
  const match = zonePickCallbackRe.exec(callbackData);
  if (!match) return null;
  return { regionIndex: Number(match[1]), zoneIndex: Number(match[2]) };
}

/**
 * @description Resolve a level-2 pick back to its zone name, or `null` when the
 * indexes no longer resolve. Stale keyboards stay tappable forever in Telegram,
 * so an out-of-range index must answer "nothing" rather than pick a neighbour.
 */
export function getTimezoneAt(regionIndex: number, zoneIndex: number): string | null {
  const region = listTimezoneRegions()[regionIndex];
  if (region === undefined) return null;
  return getTimezonesForRegion(region)[zoneIndex] ?? null;
}

/** The region name at `regionIndex`, or `null` for a stale index. */
export function getTimezoneRegionAt(regionIndex: number): string | null {
  return listTimezoneRegions()[regionIndex] ?? null;
}

/** `✓ `-prefix a label when it is the current selection. */
function getSelectionLabel(label: string, isCurrent: boolean): string {
  return isCurrent ? `✓ ${label}` : label;
}

/**
 * @description Build the level-1 region keyboard, two regions per row, plus a
 * full-width `🌐 Auto (host zone)` reset row.
 *
 * The `✓` marks the region CONTAINING the current zone (so the operator can see
 * where they are without opening a page), or the Auto row when nothing is
 * stored. A fixed-offset zone (`+04:00`) belongs to no region, so no region is
 * marked — that is honest rather than arbitrarily highlighting one.
 *
 * `🌐 Auto (host zone)` is a fixed glyph+word rather than a translated string,
 * mirroring the `/language` picker's Auto row: recognisable across locales and
 * one less per-locale key to keep in parity.
 */
export function buildTimezoneRegionPicker(currentZone: string | null) {
  const regions = listTimezoneRegions();
  const currentRegion = currentZone === null ? null : getTimezoneRegion(currentZone);

  const rows = [];
  for (let index = 0; index < regions.length; index += regionsPerRow) {
    const row = [];
    for (let offset = 0; offset < regionsPerRow; offset += 1) {
      const region = regions[index + offset];
      if (region === undefined) break;
      row.push(
        Markup.button.callback(
          getSelectionLabel(region, region === currentRegion),
          buildRegionPageCallback(index + offset, 0),
        ),
      );
    }
    rows.push(row);
  }

  rows.push([
    Markup.button.callback(
      getSelectionLabel('🌐 Auto (host zone)', currentZone === null),
      timezoneAutoCallback,
    ),
  ]);

  return Markup.inlineKeyboard(rows);
}

/**
 * @description One rendered level-2 page: the keyboard plus the numbers the
 * caller needs for the localized header. `currentPage` is already CLAMPED by
 * {@link paginateList}, so a stale page index lands on the last real page rather
 * than rendering an empty body.
 */
export interface TimezonePageRender {
  region: string;
  keyboard: ReturnType<typeof Markup.inlineKeyboard>;
  /** Zero-based, clamped. */
  currentPage: number;
  totalPages: number;
}

/**
 * @description Build a region's zone page: one zone per row (names are long),
 * with a `‹ Prev` / page pill / `⬅ Regions` / `Next ›` navigation row.
 *
 * Returns `null` for a region index that no longer resolves — a stale callback
 * must be answered as expired, not rendered against a different region.
 */
export function buildTimezoneZonePicker(
  regionIndex: number,
  page: number,
  currentZone: string | null,
): TimezonePageRender | null {
  const region = getTimezoneRegionAt(regionIndex);
  if (region === null) return null;

  const zones = getTimezonesForRegion(region);
  const { slice, currentPage, totalPages } = paginateList(zones, page, timezonePageSize);
  const pageOffset = currentPage * timezonePageSize;

  const rows = slice.map((zone, sliceIndex) => [
    Markup.button.callback(
      getSelectionLabel(zone, zone === currentZone),
      buildZonePickCallback(regionIndex, pageOffset + sliceIndex),
    ),
  ]);

  const navigationRow = [];
  if (currentPage > 0) {
    navigationRow.push(
      Markup.button.callback('‹ Prev', buildRegionPageCallback(regionIndex, currentPage - 1)),
    );
  }
  navigationRow.push(Markup.button.callback('⬅ Regions', timezonePickerBackCallback));
  if (currentPage < totalPages - 1) {
    navigationRow.push(
      Markup.button.callback('Next ›', buildRegionPageCallback(regionIndex, currentPage + 1)),
    );
  }
  rows.push(navigationRow);

  return { region, keyboard: Markup.inlineKeyboard(rows), currentPage, totalPages };
}
