/**
 * @description Platform-agnostic conversation addressing for the core.
 *
 * The core routes every agent session, every output frame and every piece of
 * persisted state by a {@link SessionKey}. It deliberately knows NOTHING about
 * how that key is spelled on the wire: serialization belongs to the connector
 * that owns the surface (see {@link SessionKeyCodec}).
 *
 * That split is load-bearing rather than cosmetic. The serialized key leaks onto
 * disk in four places — `state.json` field names, tmux session names, the
 * per-thread JSON maps under `DATA_DIR`, and the file-intake directories — so a
 * unified cross-platform format would rename all of them and orphan every live
 * agent session. Keeping the format inside the connector lets Telegram keep its
 * historical `"<chatId>:<threadId>"` spelling byte-for-byte while a future
 * tracker or Teams connector picks a prefixed form of its own.
 */

/**
 * @name PlatformId
 * @description The surfaces the core can address. `test` is the in-repo test
 * double used to exercise degraded capability paths; real surfaces are added
 * here when their connector lands.
 */
export type PlatformId = 'telegram' | 'test';

/**
 * @description The core's routing key: a conversation on one platform.
 *
 * - `space`  — the container: Telegram chat id, tracker project, Teams channel.
 * - `thread` — the conversation inside it: Telegram `message_thread_id`,
 *   tracker issue key, Teams thread id.
 *
 * Both are strings because only Telegram's ids happen to be numeric; the core
 * never does arithmetic on them, it only compares and serializes. A connector
 * that needs the native type converts at its own boundary.
 */
export interface SessionKey {
  platform: PlatformId;
  space: string;
  thread: string;
}

/**
 * @description The connector's ownership of its own key spelling.
 *
 * `matches` is what makes {@link keyFromString} work without a platform
 * argument: the 20-odd decode call sites read strings back out of `state.json`,
 * `DATA_DIR` maps and the scheduler's MCP surface, where no platform is in hand.
 * The registry asks each codec whether a string is its own and the first owner
 * decodes, so recognition stays with the connector that defined the format.
 *
 * Formats MUST be mutually unambiguous. Telegram's is all-numeric
 * (`-100123:42`); every later platform uses a `<platform>:` prefix, which the
 * numeric shape can never match.
 */
export interface SessionKeyCodec {
  readonly platform: PlatformId;
  encode(key: SessionKey): string;
  decode(serialized: string): SessionKey;
  matches(serialized: string): boolean;
}

/** Registration order matters: {@link keyFromString} asks `matches` in it. */
const codecs: SessionKeyCodec[] = [];

/**
 * @description Register (or replace) a platform's codec. Idempotent per
 * platform so a module that self-registers on import is safe to import twice,
 * and so a test can swap a codec without leaving a duplicate behind.
 */
export function registerSessionKeyCodec(codec: SessionKeyCodec): void {
  const existing = codecs.findIndex((registered) => registered.platform === codec.platform);
  if (existing >= 0) {
    codecs[existing] = codec;
    return;
  }
  codecs.push(codec);
}

/** Drop a platform's codec — only the S5 test double needs this. */
export function unregisterSessionKeyCodec(platform: PlatformId): void {
  const existing = codecs.findIndex((registered) => registered.platform === platform);
  if (existing >= 0) codecs.splice(existing, 1);
}

/** The codec owning `platform`, or `null` when none is registered. */
export function getSessionKeyCodec(platform: PlatformId): SessionKeyCodec | null {
  return codecs.find((registered) => registered.platform === platform) ?? null;
}

/**
 * @description Canonical serialization of a {@link SessionKey} — the `Map` key
 * and `state.json` field name form. Dispatches to the owning connector's codec.
 *
 * Round-trips losslessly with {@link keyFromString}.
 */
export function keyToString(key: SessionKey): string {
  const codec = getSessionKeyCodec(key.platform);
  if (!codec) throw new Error(`No SessionKeyCodec registered for platform "${key.platform}"`);
  return codec.encode(key);
}

/**
 * @description Guard against the one failure mode the registry could otherwise
 * hide: an entry point that reaches a decode site without ever importing a
 * connector. Every codec-less decode would then look like ordinary malformed
 * data, so `state.json` would load as zero bindings and every live agent
 * session would appear orphaned — silently. An empty registry is a wiring bug,
 * never bad data, so it throws from BOTH the strict and the lenient decoder.
 */
function assertRegistryArmed(): void {
  if (codecs.length === 0) {
    throw new Error(
      'No SessionKeyCodec registered — the platform connector module was never imported',
    );
  }
}

/**
 * @description Inverse of {@link keyToString}. Throws on input no registered
 * codec claims — callers should only feed strings that came from
 * {@link keyToString} or from a trusted state file. Use
 * {@link tryKeyFromString} where a hand-edited state file must be survivable.
 */
export function keyFromString(serialized: string): SessionKey {
  assertRegistryArmed();
  const codec = codecs.find((registered) => registered.matches(serialized));
  if (!codec) throw new Error(`Invalid SessionKey string: "${serialized}"`);
  return codec.decode(serialized);
}

/**
 * @description Non-throwing {@link keyFromString} — returns `null` so callers
 * iterating a persisted map can skip a rogue field instead of aborting the
 * whole load. Deliberately still throws when NO codec is registered at all
 * (see {@link assertRegistryArmed}): skipping every field silently is the one
 * outcome worse than crashing.
 */
export function tryKeyFromString(serialized: string): SessionKey | null {
  assertRegistryArmed();
  const codec = codecs.find((registered) => registered.matches(serialized));
  if (!codec) return null;
  try {
    return codec.decode(serialized);
  } catch {
    return null;
  }
}

/**
 * @description The serialized key rewritten for a context that cannot carry
 * `:` — a tmux session name (`-`) or a directory name (`_`).
 *
 * Single source of truth for the three on-disk name shapes that embed a key:
 * tmux sessions, the `DATA_DIR/files/` intake dirs and the
 * `DATA_DIR/jsonstream/` session dirs. All three previously open-coded the
 * same substitution.
 *
 * The inverse parsers split on the LAST separator, so a format carrying more
 * than one `:` cannot round-trip through them. Telegram's has exactly one; a
 * future multi-colon platform must supply its own name shape rather than reuse
 * this slug.
 */
export function keyToSlug(key: SessionKey, separator: string): string {
  return keyToString(key).replaceAll(':', separator);
}

/**
 * @description Structural equality for two keys.
 *
 * `platform` is part of the comparison on purpose: without it a Telegram
 * conversation `{space:'123', thread:'5'}` would equal a tracker one with the
 * same ids, and two unrelated conversations would silently collide in any Map
 * or lookup built on this predicate.
 */
export function keysEqual(a: SessionKey, b: SessionKey): boolean {
  return a.platform === b.platform && a.space === b.space && a.thread === b.thread;
}
