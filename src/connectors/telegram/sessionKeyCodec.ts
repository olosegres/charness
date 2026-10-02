import {
  registerSessionKeyCodec,
  type PlatformId,
  type SessionKey,
  type SessionKeyCodec,
} from '../../sessionKey';

/** The platform id this connector answers to. */
const telegramPlatform: PlatformId = 'telegram';

/**
 * @description The historical on-the-wire spelling: `"<chatId>:<threadId>"`.
 *
 * Deliberately UNCHANGED from the pre-seam `keyToString`. The same string is a
 * `state.json` field name, the tail of a tmux session name
 * (`claude-<chatId>-<threadId>`), a per-thread JSON map key and (with `:` swapped
 * for `_`) a file-intake directory name. Changing it would rename all four and
 * orphan every live agent session, so this format is frozen: new platforms
 * differentiate by prefixing their own id, never by touching this one.
 *
 * Chat ids are negative for forum supergroups; thread ids are never negative
 * (`0` = the owner-DM main thread, `1` = the supergroup General topic). The
 * per-half strictness matters — a plain `Number()` would accept `1e5`, `0x10`,
 * `1.5` and `" 42 "`, letting a foreign string masquerade as one of ours.
 */
const telegramKeyRe = /^(-?\d+):(\d+)$/;

function decodeTelegramKey(serialized: string): SessionKey | null {
  const match = telegramKeyRe.exec(serialized);
  return match ? { platform: telegramPlatform, space: match[1], thread: match[2] } : null;
}

/**
 * @description Telegram's {@link SessionKeyCodec}. `matches` is what lets the
 * core decode a string with no platform in hand: the all-numeric shape is
 * unambiguous against every prefixed format a later connector will use.
 */
export const telegramSessionKeyCodec: SessionKeyCodec = {
  platform: telegramPlatform,

  encode(key: SessionKey): string {
    return `${key.space}:${key.thread}`;
  },

  decode(serialized: string): SessionKey {
    const key = decodeTelegramKey(serialized);
    if (!key) throw new Error(`Invalid Telegram SessionKey string: "${serialized}"`);
    return key;
  },

  matches(serialized: string): boolean {
    return telegramKeyRe.test(serialized);
  },

  // The key has exactly one `:`, so the slug splits on its LAST separator: a
  // negative chat id keeps its own leading minus (`-100123-42` with `-`).
  decodeSlug(slug: string, separator: string): SessionKey | null {
    const lastSeparator = slug.lastIndexOf(separator);
    if (lastSeparator <= 0) return null;
    const serialized = `${slug.slice(0, lastSeparator)}:${slug.slice(lastSeparator + separator.length)}`;
    return decodeTelegramKey(serialized);
  },
};

/**
 * Self-registering on import so every module that constructs or reads a
 * Telegram key transitively arms the decoder. The composition roots
 * (`bot.ts`, the test bootstrap) import this module explicitly for the paths —
 * `state.ts`, the `DATA_DIR` janitors — that decode without ever building a key.
 * {@link registerSessionKeyCodec} is idempotent per platform, so a repeated
 * import is harmless.
 */
registerSessionKeyCodec(telegramSessionKeyCodec);

/**
 * @description Build a Telegram {@link SessionKey} from the native numeric ids.
 *
 * The single construction point for Telegram keys — production and tests alike.
 * Funnelling every literal through it is what keeps the string/number boundary
 * in one place instead of 200 scattered object literals.
 */
export function makeTelegramKey(chatId: number, threadId: number): SessionKey {
  return { platform: telegramPlatform, space: `${chatId}`, thread: `${threadId}` };
}

/**
 * @description Does this key address the Telegram surface? Core predicates use
 * it to answer `false` for a foreign key instead of throwing out of the native
 * accessors below.
 */
export function checkIsTelegramKey(key: SessionKey): boolean {
  return key.platform === telegramPlatform;
}

function getTelegramNumber(key: SessionKey, field: 'space' | 'thread'): number {
  if (!checkIsTelegramKey(key)) {
    throw new Error(`Expected a Telegram SessionKey, got platform "${key.platform}"`);
  }
  const value = Number(key[field]);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid Telegram ${field} in SessionKey: "${key[field]}"`);
  }
  return value;
}

/** The native Telegram chat id — what the Bot API expects on every send. */
export function getTelegramChatId(key: SessionKey): number {
  return getTelegramNumber(key, 'space');
}

/** The native Telegram `message_thread_id` (`0` = owner-DM main thread). */
export function getTelegramThreadId(key: SessionKey): number {
  return getTelegramNumber(key, 'thread');
}
