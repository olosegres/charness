/**
 * @description Unit coverage for the runtime access-control policy.
 *
 * The policy is platform-neutral after the seam: it speaks `PlatformMember`,
 * never Telegram's `ChatMember`. Telegram's status vocabulary and its
 * `chat_member` invalidation rule are covered by the connector's own test
 * (`telegramInbound.test.ts`).
 *
 * `getElevatedMemberIds` and `AdminCache` are pure / DI-driven (clock + fetch
 * are injected), so these tests run with no platform, no timers, and no
 * state.json. They are the load-bearing proof for the parts that can't be
 * exercised live under a single account: a demoted/left user losing access on
 * the next refresh, and a promoted user gaining it.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type { PlatformMember } from '../platform/inbound';
import { getElevatedMemberIds, AdminCache } from '../accessControl';

function elevated(id: number, isBot = false): PlatformMember {
  return { id: id.toString(), displayName: `u${id}`, isBot, hasElevatedRights: true };
}

function member(id: number): PlatformMember {
  return { id: id.toString(), displayName: `u${id}`, isBot: false, hasElevatedRights: false };
}

// ─── getElevatedMemberIds ───────────────────────────────────────────────

test('getElevatedMemberIds: keeps elevated humans, drops plain members and bots', () => {
  const members: PlatformMember[] = [elevated(1), elevated(2), elevated(3, true), member(4), member(5)];
  assert.deepEqual(getElevatedMemberIds(members).sort(), ['1', '2']);
});

test('getElevatedMemberIds: empty input → empty', () => {
  assert.deepEqual(getElevatedMemberIds([]), []);
});

// ─── AdminCache ─────────────────────────────────────────────────────────

test('AdminCache: no re-fetch within the TTL', async () => {
  let calls = 0;
  let clock = 1000;
  const cache = new AdminCache({
    fetchElevatedMemberIds: async () => { calls += 1; return ['1', '2']; },
    ttlMs: 1000,
    now: () => clock,
  });

  const first = await cache.getAdminIds();
  assert.deepEqual([...first].sort(), ['1', '2']);

  clock += 500; // still inside the TTL window
  await cache.getAdminIds();
  await cache.getAdminIds();
  assert.equal(calls, 1);
});

test('AdminCache: re-fetch after TTL reflects promotion/demotion (load-bearing)', async () => {
  let calls = 0;
  let clock = 0;
  let roster = ['1', '2'];
  const cache = new AdminCache({
    fetchElevatedMemberIds: async () => { calls += 1; return roster; },
    ttlMs: 1000,
    now: () => clock,
  });

  const before = await cache.getAdminIds();
  assert.equal(before.has('2'), true);  // 2 is an admin initially
  assert.equal(before.has('3'), false); // 3 isn't

  roster = ['1', '3']; // demote 2, promote 3
  clock += 1001;                 // expire the cache

  const after = await cache.getAdminIds();
  assert.equal(after.has('2'), false); // demoted → access dropped
  assert.equal(after.has('3'), true);  // promoted → access granted
  assert.equal(calls, 2);
});

test('AdminCache: concurrent stale reads share one in-flight fetch', async () => {
  let calls = 0;
  let resolveFetch!: (ids: string[]) => void;
  const cache = new AdminCache({
    fetchElevatedMemberIds: () => {
      calls += 1;
      return new Promise<string[]>((resolve) => { resolveFetch = resolve; });
    },
    ttlMs: 1000,
    now: () => 0,
  });

  const p1 = cache.getAdminIds();
  const p2 = cache.getAdminIds();
  resolveFetch(['1']);
  const [s1, s2] = await Promise.all([p1, p2]);

  assert.equal(calls, 1);
  assert.equal(s1.has('1'), true);
  assert.equal(s2.has('1'), true);
});

test('AdminCache: a failed fetch keeps the last-known set and backs off', async () => {
  let calls = 0;
  let clock = 0;
  let shouldFail = false;
  const cache = new AdminCache({
    fetchElevatedMemberIds: async () => {
      calls += 1;
      if (shouldFail) throw new Error('boom');
      return ['1'];
    },
    ttlMs: 1000,
    failureRetryMs: 500,
    now: () => clock,
  });

  const ok = await cache.getAdminIds();
  assert.equal(ok.has('1'), true);
  assert.equal(calls, 1);

  clock += 1001;     // expire
  shouldFail = true;
  const kept = await cache.getAdminIds(); // fetch throws
  assert.equal(kept.has('1'), true);      // last-known retained, no lockout
  assert.equal(calls, 2);

  clock += 100;      // inside the failure backoff window
  await cache.getAdminIds();
  assert.equal(calls, 2); // suppressed — no API hammer

  clock += 500;      // past the backoff window
  await cache.getAdminIds();
  assert.equal(calls, 3); // retried
});

test('AdminCache: invalidate() forces the next read to re-fetch', async () => {
  let calls = 0;
  const cache = new AdminCache({
    fetchElevatedMemberIds: async () => { calls += 1; return ['1']; },
    ttlMs: 1_000_000,
    now: () => 0,
  });

  await cache.getAdminIds();
  await cache.getAdminIds();
  assert.equal(calls, 1); // fresh — cached

  cache.invalidate();
  await cache.getAdminIds();
  assert.equal(calls, 2); // forced refresh
});
