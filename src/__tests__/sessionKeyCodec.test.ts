/**
 * @description Platform-seam S1 — the `SessionKey` registry and the Telegram
 * codec that owns the historical on-the-wire spelling.
 *
 * Why this file carries more weight than a normal serialization test: the
 * Telegram serialized key is ALSO a `state.json` field name, the tail of a tmux
 * session name (`claude-<chatId>-<threadId>`), a per-thread JSON map key under
 * `DATA_DIR` and (with `:` swapped for `_`) a file-intake directory name. A
 * regression here does not merely fail a lookup — it orphans every live agent
 * session on the host. The format is therefore frozen and asserted literally.
 *
 * Covered:
 *  - Round-trip over the full production domain: negative forum-supergroup
 *    chat ids, positive DM ids, the General topic (`1`) and the owner-DM main
 *    thread (`0`), and long-lived 5-digit topic ids.
 *  - The literal byte-for-byte format.
 *  - Malformed input rejected loudly rather than coerced to `NaN`.
 *  - A foreign, prefixed key (`jira:ABC-123`) NOT claimed by the Telegram
 *    codec — the property that lets `keyFromString` dispatch with no platform
 *    argument in hand.
 *  - `keysEqual` comparing `platform`, so two platforms with coincidentally
 *    equal space/thread pairs cannot collide in a Map built on it.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  getSessionKeyCodec,
  keyFromString,
  keyToSlug,
  keyToString,
  keysEqual,
  registerSessionKeyCodec,
  tryKeyFromString,
  unregisterSessionKeyCodec,
  type SessionKey,
  type SessionKeyCodec,
} from '../sessionKey';
import {
  checkIsTelegramKey,
  makeTelegramKey,
  telegramSessionKeyCodec,
} from '../connectors/telegram/sessionKeyCodec';

test('keyToString → keyFromString round-trips across the production key domain', () => {
  const samples: SessionKey[] = [
    makeTelegramKey(-1001234567890, 1), // forum supergroup, General topic
    makeTelegramKey(-1001234567890, 42), // forum supergroup, normal topic
    makeTelegramKey(-1009999999999, 99999), // long-lived group, 5-digit topic
    makeTelegramKey(12345, 0), // owner DM — positive id, main thread
    makeTelegramKey(-1, 1), // edge: smallest negative chat id
  ];

  for (const key of samples) {
    const serialized = keyToString(key);
    const decoded = keyFromString(serialized);
    assert.equal(decoded.platform, 'telegram', `platform mismatch for ${serialized}`);
    assert.equal(decoded.space, key.space, `space mismatch for ${serialized}`);
    assert.equal(decoded.thread, key.thread, `thread mismatch for ${serialized}`);
    assert.ok(keysEqual(key, decoded), `keysEqual failed for ${serialized}`);
  }
});

test('the Telegram serialized format stays exactly "<chatId>:<threadId>"', () => {
  // Frozen on purpose: this string is a state.json field name, a tmux session
  // suffix and a DATA_DIR directory name. Changing it orphans live sessions.
  assert.equal(keyToString(makeTelegramKey(-1001234567890, 42)), '-1001234567890:42');
  assert.equal(keyToString(makeTelegramKey(1, 1)), '1:1');
  assert.equal(keyToString(makeTelegramKey(7000001, 0)), '7000001:0');
});

test('keyFromString rejects malformed input instead of coercing it', () => {
  // Realistic state.json corruption modes, plus the shapes a loose `Number()`
  // parse would silently accept (`1e5`, `0x10`, `1.5`, padded).
  const malformed = [
    '',
    ':',
    '42',
    ':42',
    '42:',
    'a:b',
    '-1001234567890:abc',
    'abc:42',
    '1e5:1',
    '0x10:1',
    '1.5:1',
    ' 42:1',
    '42:1 ',
    '42:-1',
  ];
  for (const serialized of malformed) {
    assert.throws(
      () => keyFromString(serialized),
      /Invalid SessionKey string/,
      `should reject "${serialized}"`,
    );
    assert.equal(tryKeyFromString(serialized), null, `tryKeyFromString should null "${serialized}"`);
  }
});

test('the Telegram codec does not claim a foreign prefixed key', () => {
  // The whole dispatch story rests on this: an all-numeric shape can never
  // collide with a `<platform>:` prefixed one, so `keyFromString` needs no
  // platform argument at its 20-odd call sites.
  for (const foreign of ['jira:ABC-123', 'teams:19:channel@thread.v2', 'test:space:thread']) {
    assert.equal(telegramSessionKeyCodec.matches(foreign), false, `must not claim "${foreign}"`);
    assert.throws(() => keyFromString(foreign), /Invalid SessionKey string/);
  }
});

test('the registry dispatches decode to the codec that claims the string', () => {
  const fakeCodec: SessionKeyCodec = {
    platform: 'test',
    encode: (key) => `test:${key.space}:${key.thread}`,
    decode: (serialized) => {
      const [, space, thread] = serialized.split(':');
      return { platform: 'test', space: space ?? '', thread: thread ?? '' };
    },
    matches: (serialized) => serialized.startsWith('test:'),
  };

  registerSessionKeyCodec(fakeCodec);
  try {
    assert.equal(getSessionKeyCodec('test'), fakeCodec);
    // Registration is idempotent per platform — a self-registering module that
    // gets imported twice must not leave a duplicate behind.
    registerSessionKeyCodec(fakeCodec);
    assert.equal(getSessionKeyCodec('test'), fakeCodec);

    assert.deepEqual(keyFromString('test:space-1:thread-1'), {
      platform: 'test',
      space: 'space-1',
      thread: 'thread-1',
    });
    // The newcomer must not shadow Telegram's numeric shape.
    assert.equal(keyFromString('-100:7').platform, 'telegram');
    assert.equal(keyToString({ platform: 'test', space: 'a', thread: 'b' }), 'test:a:b');
  } finally {
    unregisterSessionKeyCodec('test');
  }

  assert.equal(getSessionKeyCodec('test'), null);
  assert.throws(() => keyFromString('test:space-1:thread-1'), /Invalid SessionKey string/);
  assert.throws(
    () => keyToString({ platform: 'test', space: 'a', thread: 'b' }),
    /No SessionKeyCodec registered/,
  );
});

test('keyToSlug rewrites the separator for filesystem- and tmux-safe names', () => {
  // The single source of truth behind three on-disk name shapes: the tmux
  // session suffix, the DATA_DIR/files intake dir and the jsonstream dir.
  const key = makeTelegramKey(-1001234567890, 42);
  assert.equal(keyToSlug(key, '_'), '-1001234567890_42');
  assert.equal(keyToSlug(key, '-'), '-1001234567890-42');
});

test('an unarmed registry fails loudly instead of looking like malformed data', () => {
  // The silent-catastrophe guard: with no codec registered, every persisted
  // field would decode to null and state.json would load as zero bindings —
  // every live agent session apparently orphaned, with nothing logged.
  unregisterSessionKeyCodec('telegram');
  try {
    assert.throws(() => keyFromString('-100:7'), /No SessionKeyCodec registered/);
    assert.throws(() => tryKeyFromString('-100:7'), /No SessionKeyCodec registered/);
  } finally {
    registerSessionKeyCodec(telegramSessionKeyCodec);
  }
  assert.equal(keyFromString('-100:7').platform, 'telegram');
});

test('checkIsTelegramKey separates this surface from a foreign one', () => {
  assert.equal(checkIsTelegramKey(makeTelegramKey(-100, 5)), true);
  assert.equal(checkIsTelegramKey({ platform: 'test', space: '-100', thread: '5' }), false);
});

test('keysEqual is reflexive, symmetric, structural — and platform-aware', () => {
  const a = makeTelegramKey(-100, 5);
  const b = makeTelegramKey(-100, 5);
  const otherThread = makeTelegramKey(-100, 6);
  const otherSpace = makeTelegramKey(-101, 5);
  // Same ids, different surface. Without the platform comparison these two
  // unrelated conversations would silently share one Map entry.
  const otherPlatform: SessionKey = { platform: 'test', space: '-100', thread: '5' };

  assert.ok(keysEqual(a, a));
  assert.ok(keysEqual(a, b));
  assert.ok(keysEqual(b, a));
  assert.ok(!keysEqual(a, otherThread), 'a different thread must not be equal');
  assert.ok(!keysEqual(a, otherSpace), 'a different space must not be equal');
  assert.ok(!keysEqual(a, otherPlatform), 'a different platform must not be equal');
});
