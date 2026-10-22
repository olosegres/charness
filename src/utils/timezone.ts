/**
 * @description The operator's timezone — validation, the zone catalog behind the
 * `/timezone` picker, wall-clock formatting, and the one impure apply path that
 * makes the setting take effect process-wide.
 *
 * Why a process-global mechanism: the bot runs on a host whose clock may be
 * anything (this deploy is `Etc/UTC`). Every clock the bot touches — cron fire
 * times, "missed at HH:MM" renders, the `/timestamps` injection, schedule
 * descriptions — reads HOST-LOCAL time. Assigning `process.env.TZ` re-bases
 * `Date` and `Intl` immediately on Node (verified on Node 22, no restart
 * needed), so setting it once at startup fixes all of those call sites at their
 * existing code with no per-site timezone threading.
 *
 * That is also why the setting is ONE zone per bot instance rather than
 * per-chat: `process.env.TZ` is global by nature, and two chat-scoped zones
 * could not both be true in a single process.
 *
 * Everything except {@link applyProcessTimezone} is pure, so the catalog, the
 * validation rule and the formatting are unit-testable without booting the bot.
 */

/** Separator between the region and the rest of an IANA zone name. */
const zoneRegionSeparator = '/';

/**
 * @description A fixed UTC offset written as a zone (`+04:00`, `-0330`, `+05`).
 * `Intl` accepts these as real zones, so they are allowed — but they do NOT
 * follow daylight saving, which is why picking one earns a warning line.
 */
const fixedOffsetZoneRe = /^([+-])(\d{2})(?::?(\d{2}))?$/;

const minutesPerHour = 60;

/**
 * The widest `Etc/GMT±H` zones tzdata defines (UTC+14 .. UTC−12). An offset
 * outside that has no IANA equivalent to apply.
 */
const maxEtcGmtOffsetHours = 14;
const minEtcGmtOffsetHours = -12;

/**
 * The zone the process would use if the bot stored nothing — captured at module
 * load, BEFORE {@link applyProcessTimezone} can overwrite `process.env.TZ`.
 * Without this snapshot `/timezone auto` could not find its way back: once a
 * stored zone is applied, `resolvedOptions()` reports the STORED zone and the
 * original is gone.
 */
const hostTimezone = new Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * The `TZ` environment value as the process was launched with it (possibly
 * absent). Restored verbatim on a reset so an operator who deliberately exports
 * `TZ` keeps that behaviour when no bot setting is stored.
 */
const initialTimezoneEnv = process.env.TZ;

/** The full IANA zone list, computed once (418 entries on Node 22). */
let cachedTimezones: string[] | null = null;

function getAllTimezones(): string[] {
  if (cachedTimezones === null) {
    cachedTimezones = [...Intl.supportedValuesOf('timeZone')].sort();
  }
  return cachedTimezones;
}

/**
 * @description Canonicalize a zone the operator typed, or `null` when `Intl`
 * does not know it.
 *
 * `new Intl.DateTimeFormat(undefined, { timeZone })` throws `RangeError` for an
 * unknown zone and accepts both IANA names and `±HH:MM` offsets — which is
 * exactly the acceptance set the setting wants, so the probe IS the validation
 * rule rather than a hand-maintained list that would rot against the ICU data.
 * `resolvedOptions()` then hands back the canonical spelling (`europe/moscow` →
 * `Europe/Moscow`, `+0400` → `+04:00`), so what gets persisted and echoed is one
 * stable form rather than whatever casing was typed.
 */
export function getCanonicalTimezone(timezone: string): string | null {
  if (typeof timezone !== 'string' || timezone.trim() === '') return null;
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: timezone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** Whether `Intl` recognises `timezone` — the validation gate for `/timezone`. */
export function checkIsValidTimezone(timezone: string): boolean {
  return getCanonicalTimezone(timezone) !== null;
}

/**
 * @description The zone the process resolved at startup — the default whenever
 * nothing is stored, and the target `/timezone auto` resets to.
 */
export function getHostTimezone(): string {
  return hostTimezone;
}

/**
 * @description Whether the zone is a fixed UTC offset rather than a real region.
 * Drives the daylight-saving warning line on the confirmation: a fixed offset
 * silently goes an hour wrong when the operator's region changes to summer time.
 */
export function checkIsFixedOffsetZone(timezone: string): boolean {
  return fixedOffsetZoneRe.test(timezone);
}

/** Signed minutes of a `±HH:MM` zone, or `null` when it is not an offset. */
function getFixedOffsetMinutes(timezone: string): number | null {
  const match = fixedOffsetZoneRe.exec(timezone);
  if (match === null) return null;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * minutesPerHour + Number(match[3] ?? 0));
}

/**
 * @description The value to assign to `process.env.TZ` for `timezone`, or `null`
 * when the zone cannot be applied process-wide.
 *
 * An IANA name passes through unchanged. A fixed `±HH:MM` offset must NOT:
 * `Intl.DateTimeFormat({ timeZone })` supports offset zones, but the `TZ`
 * environment variable goes through ICU's own parser, which silently resolves
 * `TZ="+04:00"` to **UTC** instead of rejecting it (measured on Node 22).
 * Assigning it verbatim would therefore leave every clock on UTC while the
 * confirmation — formatted through `Intl` — cheerfully printed `+04:00`: the
 * exact plausible-but-wrong outcome the confirmation exists to prevent.
 *
 * A whole-hour offset has an exact IANA equivalent in `Etc/GMT±H`, which ICU
 * does understand (POSIX sign inversion: UTC+4 is `Etc/GMT-4`). An offset
 * carrying MINUTES has no such equivalent — no `TZ` spelling of it takes effect
 * — so `null` is the honest answer and the caller rejects the input.
 */
export function getProcessTimezoneValue(timezone: string): string | null {
  const offsetMinutes = getFixedOffsetMinutes(timezone);
  if (offsetMinutes === null) return timezone;
  if (offsetMinutes % minutesPerHour !== 0) return null;
  const offsetHours = offsetMinutes / minutesPerHour;
  if (offsetHours > maxEtcGmtOffsetHours || offsetHours < minEtcGmtOffsetHours) return null;
  return `Etc/GMT${offsetHours <= 0 ? '+' : '-'}${Math.abs(offsetHours)}`;
}

/**
 * @description Whether the zone can actually take effect process-wide — the
 * gate `/timezone` applies before storing, so a setting is never accepted that
 * would leave the process running on a different clock than it reports.
 */
export function checkIsApplicableTimezone(timezone: string): boolean {
  return getProcessTimezoneValue(timezone) !== null;
}

/** The region a zone belongs to (`Europe/Moscow` → `Europe`), or `null`. */
export function getTimezoneRegion(timezone: string): string | null {
  const separatorIndex = timezone.indexOf(zoneRegionSeparator);
  return separatorIndex > 0 ? timezone.slice(0, separatorIndex) : null;
}

/**
 * @description The 10 IANA regions, sorted — level 1 of the `/timezone` picker.
 */
export function listTimezoneRegions(): string[] {
  const regions = new Set<string>();
  for (const timezone of getAllTimezones()) {
    const region = getTimezoneRegion(timezone);
    if (region !== null) regions.add(region);
  }
  return [...regions].sort();
}

/**
 * @description Every zone in `region`, sorted — level 2 of the picker. An
 * unknown region yields an empty list rather than throwing, so a stale callback
 * carrying a region index that no longer resolves renders an empty page instead
 * of killing the handler.
 */
export function getTimezonesForRegion(region: string): string[] {
  const prefix = `${region}${zoneRegionSeparator}`;
  return getAllTimezones().filter((timezone) => timezone.startsWith(prefix));
}

interface ZoneClockParts {
  /** `YYYY-MM-DD` in the zone. */
  date: string;
  /** `HH:mm`, 24-hour, in the zone. */
  time: string;
  /** The zone's UTC offset at that instant, `±HH:MM`. */
  offset: string;
}

/** Prefix `Intl`'s `longOffset` renders before the numeric offset. */
const longOffsetPrefix = 'GMT';
/** What a `longOffset` of exactly `GMT` means numerically. */
const zeroOffset = '+00:00';

/**
 * Read the zone's wall clock at `nowMs` via `formatToParts`, so the date, the
 * time and the offset come from ONE formatter pass (and therefore one instant)
 * instead of three separately-parsed strings.
 *
 * Throws `RangeError` for an invalid zone — callers validate with
 * {@link checkIsValidTimezone} first.
 */
function getZoneClockParts(timezone: string, nowMs: number): ZoneClockParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  }).formatToParts(new Date(nowMs));

  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  const rawOffset = read('timeZoneName');
  const numericOffset = rawOffset.startsWith(longOffsetPrefix)
    ? rawOffset.slice(longOffsetPrefix.length)
    : rawOffset;

  return {
    date: `${read('year')}-${read('month')}-${read('day')}`,
    time: `${read('hour')}:${read('minute')}`,
    offset: numericOffset === '' ? zeroOffset : numericOffset,
  };
}

/** @description A calendar date and wall-clock time, as some zone reads them (`month` 1–12). */
export interface ZonedWallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const msPerSecond = 1000;

/**
 * @description The zone's calendar date and wall clock at `atMs`. Throws `RangeError` for an unknown zone — callers
 * validate with {@link getCanonicalTimezone} first.
 */
export function getZonedWallClock(timezone: string, atMs: number): ZonedWallClock & { second: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(atMs));
  const read = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value);
  return { year: read('year'), month: read('month'), day: read('day'), hour: read('hour'), minute: read('minute'), second: read('second') };
}

/** @description The zone's offset from UTC at `atMs`, in ms (positive east of Greenwich), daylight saving included. */
export function getZoneOffsetMsAt(timezone: string, atMs: number): number {
  const wholeSecondMs = Math.floor(atMs / msPerSecond) * msPerSecond;
  const clock = getZonedWallClock(timezone, wholeSecondMs);
  return Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second) - wholeSecondMs;
}

/**
 * @description The instant at which `timezone` reads the wall clock `clock`. Two passes, because the offset at a first
 * guess can differ from the offset at the answer across a daylight-saving change; a date past the month's end rolls
 * over (`day: 32` is the next month's first), which is how a caller asks for "the next day".
 */
export function getEpochMsOfZonedWallClock(timezone: string, clock: ZonedWallClock): number {
  const wallAsUtcMs = Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute);
  const firstGuessMs = wallAsUtcMs - getZoneOffsetMsAt(timezone, wallAsUtcMs);
  return wallAsUtcMs - getZoneOffsetMsAt(timezone, firstGuessMs);
}

/**
 * @description The zone's current wall clock as `18:42 (+03:00)` — the tail of
 * every `/timezone` confirmation and of the `/status` zone row, so a wrong pick
 * is obvious the moment it is made.
 */
export function formatZoneNow(timezone: string, nowMs: number): string {
  const { time, offset } = getZoneClockParts(timezone, nowMs);
  return `${time} (${offset})`;
}

/**
 * @description The zone's current instant WITH the calendar date —
 * `2026-09-14 18:42 (+03:00)`. Used in the picker header, where the date
 * matters: a zone far enough east or west can sit on a different day than the
 * operator expects, and that is the mistake the header is there to catch.
 */
export function formatZoneNowWithDate(timezone: string, nowMs: number): string {
  const { date, time, offset } = getZoneClockParts(timezone, nowMs);
  return `${date} ${time} (${offset})`;
}

/**
 * @description Apply the stored zone to the process — the ONE impure function
 * here, shared by bot startup and the runtime `/timezone` change so both take
 * effect through identical code.
 *
 * `null` means "nothing stored": the `TZ` environment is restored to exactly
 * what the process was launched with (absent stays absent), which is what makes
 * `/timezone auto` return to the host zone and what keeps a default install
 * behaving precisely as it did before this setting existed.
 *
 * Assigning `process.env.TZ` re-bases `Date` and `Intl` for subsequent calls, so
 * no restart is needed — that behaviour is asserted by a unit test rather than
 * trusted. The assigned value comes from {@link getProcessTimezoneValue}, which
 * rewrites a fixed offset into the `Etc/GMT±H` spelling ICU honours.
 *
 * A zone with no applicable `TZ` value (an offset carrying minutes) is treated
 * as "nothing stored" rather than applied: `/timezone` rejects those at the
 * boundary, so this is only reachable from a hand-edited `state.json`, and
 * falling back to the launch environment beats silently running on UTC.
 */
export function applyProcessTimezone(timezone: string | null): void {
  const envValue = timezone === null ? null : getProcessTimezoneValue(timezone);
  if (envValue === null) {
    if (initialTimezoneEnv === undefined) delete process.env.TZ;
    else process.env.TZ = initialTimezoneEnv;
    return;
  }
  process.env.TZ = envValue;
}

/**
 * @description The zone in effect right now: the stored setting when present,
 * otherwise the host zone. The single resolution rule every render (`/status`,
 * the picker header, the thread-context preamble, the schedule templates) reads,
 * so no call site re-derives the "unset means host" default.
 */
export function getEffectiveTimezone(storedTimezone: string | null): string {
  return storedTimezone ?? hostTimezone;
}
