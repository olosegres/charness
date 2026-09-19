/**
 * @description The test double's {@link SessionKeyCodec}.
 *
 * It exists so the seam can be exercised with a NON-Telegram platform id —
 * without one, `keysEqual`'s platform comparison, the registry's
 * `matches()`-based dispatch and every degraded capability path are unreachable
 * and would be shipped untested.
 *
 * The spelling deliberately contains no `:`. Telegram's frozen format is
 * `"<chatId>:<threadId>"` and `keyToSlug`'s inverse parsers split on the LAST
 * separator, so a second colon-bearing format could not round-trip through the
 * tmux / directory name shapes. `|` also guarantees the all-numeric Telegram
 * pattern can never claim one of these strings, and vice versa.
 */

import {
  registerSessionKeyCodec,
  type PlatformId,
  type SessionKey,
  type SessionKeyCodec,
} from '../../sessionKey';

const testPlatform: PlatformId = 'test';

const testKeyRe = /^test\|([^|]*)\|([^|]*)$/;

export const testSessionKeyCodec: SessionKeyCodec = {
  platform: testPlatform,

  encode(key: SessionKey): string {
    return `test|${key.space}|${key.thread}`;
  },

  decode(serialized: string): SessionKey {
    const match = testKeyRe.exec(serialized);
    if (!match) throw new Error(`Invalid test SessionKey string: "${serialized}"`);
    return { platform: testPlatform, space: match[1], thread: match[2] };
  },

  matches(serialized: string): boolean {
    return testKeyRe.test(serialized);
  },
};

/**
 * NOT self-registering, unlike the Telegram codec: a test double that armed
 * itself on import would silently join the production registry through any
 * transitive import. Tests register it explicitly and
 * `unregisterSessionKeyCodec('test')` when done.
 */
export function registerTestSessionKeyCodec(): void {
  registerSessionKeyCodec(testSessionKeyCodec);
}

/** Build a test {@link SessionKey}. Mirrors `makeTelegramKey`'s role. */
export function makeTestKey(space: string, thread: string): SessionKey {
  return { platform: testPlatform, space, thread };
}
