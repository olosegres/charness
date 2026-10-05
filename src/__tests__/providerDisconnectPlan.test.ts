/**
 * Test case: N/A — Charness has no Jira tracker
 *
 * @description The pure decision behind `/disconnect`.
 *
 * The load-bearing branch is `stillActiveViaEnv`: `DELETE /auth/:id` only
 * clears OpenCode's own credential store, so a provider OpenCode enables from
 * an environment variable (`openrouter` ← `OPENROUTER_API_KEY`) is STILL fully
 * active afterwards. Reporting a clean disconnect there would be a lie — and
 * it is precisely why `/model` also carries a bot-side hide toggle.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  buildDisconnectPickerKey,
  buildDisconnectProviderCallback,
  disconnectPickerSnapshotLimit,
  disconnectProviderCallbackRe,
  getDisconnectPickerKeysForThread,
  getDisconnectPickerProviderAt,
  getEvictedDisconnectPickerKeys,
  getProviderDisconnectOutcome,
  parseDisconnectProviderCallback,
} from '../utils/providerDisconnectPlan';
import { checkIsCallbackDataWithinLimit } from '../utils/modelPickerPlan';

test('getProviderDisconnectOutcome: gone from the live catalog → a clean removal', () => {
  assert.equal(
    getProviderDisconnectOutcome('openai', ['anthropic', 'google']),
    'removed',
  );
});

test('getProviderDisconnectOutcome: still listed → the env-var caveat', () => {
  // THE openrouter case: credentials deleted, provider still serving models.
  assert.equal(
    getProviderDisconnectOutcome('openrouter', ['anthropic', 'openrouter']),
    'stillActiveViaEnv',
  );
});

test('getProviderDisconnectOutcome: an empty catalog means everything went away', () => {
  assert.equal(getProviderDisconnectOutcome('openrouter', []), 'removed');
});

test('getProviderDisconnectOutcome: comparison ignores case and surrounding space', () => {
  // A differently-cased catalog entry must not read as "removed" — that would
  // claim a clean disconnect for a provider that is still live.
  assert.equal(
    getProviderDisconnectOutcome('  OpenRouter ', ['OPENROUTER']),
    'stillActiveViaEnv',
  );
});

test('getProviderDisconnectOutcome: a similarly-named provider is not a match', () => {
  assert.equal(
    getProviderDisconnectOutcome('openai', ['openai-compatible', 'openrouter']),
    'removed',
  );
});

test('disconnect callback codec: round-trips and fits the 64-byte budget', () => {
  assert.equal(parseDisconnectProviderCallback(buildDisconnectProviderCallback(7)), 7);
  assert.equal(parseDisconnectProviderCallback('dscp_'), null);
  assert.equal(parseDisconnectProviderCallback('dscp_x'), null);
  assert.ok(checkIsCallbackDataWithinLimit(buildDisconnectProviderCallback(999999)));
});

test('disconnect callback codec: does not collide with the /model picker ids', () => {
  assert.equal(disconnectProviderCallbackRe.test('mdlp_1_0'), false);
  assert.equal(disconnectProviderCallbackRe.test('mdl_1_0'), false);
  assert.equal(disconnectProviderCallbackRe.test('connm_1'), false);
});

// ─── message-scoped picker snapshots ─────────────────────────────────────────

const threadKeyString = '-1001111111111:111';

test('picker snapshot: an OLD picker resolves against its OWN list, not the newest', () => {
  // THE destructive regression. Thread-keyed snapshots meant the second
  // `/disconnect` overwrote the first, so tapping "openai" (index 1) on the
  // still-visible OLD keyboard resolved index 1 against the NEW list and
  // deleted `openrouter`'s credentials instead.
  const snapshots = new Map<string, string[]>();
  const firstPickerMessageId = 101;
  const secondPickerMessageId = 202;
  snapshots.set(buildDisconnectPickerKey(threadKeyString, firstPickerMessageId), [
    'anthropic',
    'openai',
    'openrouter',
  ]);
  snapshots.set(buildDisconnectPickerKey(threadKeyString, secondPickerMessageId), [
    'openai',
    'openrouter',
  ]);

  assert.equal(
    getDisconnectPickerProviderAt(snapshots, threadKeyString, firstPickerMessageId, 1),
    'openai',
    'the old keyboard still means what it shows',
  );
  assert.equal(
    getDisconnectPickerProviderAt(snapshots, threadKeyString, secondPickerMessageId, 1),
    'openrouter',
    'the new keyboard resolves against its own list',
  );
});

test('picker snapshot: a tap whose message has no snapshot resolves to null', () => {
  // A picker that survived a bot restart or an eviction — must produce the
  // "expired" toast, never another message's provider.
  const snapshots = new Map<string, string[]>([
    [buildDisconnectPickerKey(threadKeyString, 202), ['openai', 'openrouter']],
  ]);
  assert.equal(getDisconnectPickerProviderAt(snapshots, threadKeyString, 101, 1), null);
});

test('picker snapshot: a missing message id or an out-of-range index resolves to null', () => {
  const snapshots = new Map<string, string[]>([
    [buildDisconnectPickerKey(threadKeyString, 202), ['openai']],
  ]);
  assert.equal(getDisconnectPickerProviderAt(snapshots, threadKeyString, null, 0), null);
  assert.equal(getDisconnectPickerProviderAt(snapshots, threadKeyString, 202, 5), null);
  assert.equal(getDisconnectPickerProviderAt(snapshots, threadKeyString, 202, -1), null);
});

test('picker snapshot: another THREAD\'s snapshot is never resolved', () => {
  const snapshots = new Map<string, string[]>([
    [buildDisconnectPickerKey('-1001111111111:42', 202), ['openrouter']],
  ]);
  assert.equal(getDisconnectPickerProviderAt(snapshots, threadKeyString, 202, 0), null);
});

test('thread sweep: collects every picker key of that thread and nothing else', () => {
  const keys = [
    buildDisconnectPickerKey(threadKeyString, 101),
    buildDisconnectPickerKey(threadKeyString, 202),
    buildDisconnectPickerKey('-1001111111111:42', 303),
  ];
  assert.deepEqual(getDisconnectPickerKeysForThread(keys, threadKeyString), [
    keys[0],
    keys[1],
  ]);
});

test('thread sweep: a thread id that PREFIXES another does not claim its keys', () => {
  // `"-100:12:5".startsWith("-100:1")` is true — a bare prefix test would let
  // topic 1's teardown wipe topic 12's live picker.
  const keys = [
    buildDisconnectPickerKey('-100:1', 5),
    buildDisconnectPickerKey('-100:12', 5),
    buildDisconnectPickerKey('-100:120', 7),
  ];
  assert.deepEqual(getDisconnectPickerKeysForThread(keys, '-100:1'), [keys[0]]);
  assert.deepEqual(getDisconnectPickerKeysForThread(keys, '-100:12'), [keys[1]]);
});

test('eviction: keeps the newest snapshots and reports the oldest for removal', () => {
  const keys = Array.from({ length: disconnectPickerSnapshotLimit + 3 }, (_, i) =>
    buildDisconnectPickerKey(threadKeyString, i),
  );
  const evicted = getEvictedDisconnectPickerKeys(keys);
  assert.deepEqual(evicted, [keys[0], keys[1], keys[2]], 'oldest first (insertion order)');
  assert.deepEqual(getEvictedDisconnectPickerKeys(keys.slice(0, 3)), [], 'under the cap: nothing');
});
