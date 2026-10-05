/**
 * Test case: N/A — Charness has no Jira tracker
 *
 * @description The GLOBAL hidden-provider list behind the `/model` picker's
 * 🙈 / 👁 buttons. It is the only lever that works for a provider OpenCode
 * enables from an environment variable, so it has to survive a restart — hence
 * `state.json` rather than memory.
 *
 * Covers the persistence SHAPE (deduped + sorted, field dropped when empty so a
 * default install leaves no trace) and the reload round-trip. Mirrors
 * `displayPrefs.test.ts`'s isolated-`dataDir` + fake-`HOME` harness so nothing
 * touches the developer's real home.
 */

import { test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StateStore } from '../state';

let dataDir: string;
let fakeHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-hidden-providers-'));
  dataDir = path.join(fakeHome, '.telegramCode');
  fs.mkdirSync(dataDir, { recursive: true });
  originalHome = process.env.HOME;
  process.env.HOME = fakeHome;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

function readRawState(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
}

async function createStore(): Promise<StateStore> {
  const store = new StateStore(dataDir, { saveDebounceMs: 5 });
  await store.init();
  return store;
}

test('hiddenModelProviders: a fresh state file hides nothing', async () => {
  const store = await createStore();
  assert.deepEqual(store.getHiddenModelProviders(), []);
  await store.flush();
  assert.equal('hiddenModelProviders' in readRawState(), false, 'no trace on a default install');
});

test('hiddenModelProviders: hiding persists deduped and sorted', async () => {
  const store = await createStore();
  await store.setModelProviderHidden('openrouter', true);
  await store.setModelProviderHidden('anthropic', true);
  // Re-hiding an already-hidden provider must not duplicate the entry.
  await store.setModelProviderHidden('openrouter', true);
  await store.flush();
  assert.deepEqual(readRawState().hiddenModelProviders, ['anthropic', 'openrouter']);
  assert.deepEqual(store.getHiddenModelProviders(), ['anthropic', 'openrouter']);
});

test('hiddenModelProviders: unhiding the last provider drops the field entirely', async () => {
  const store = await createStore();
  await store.setModelProviderHidden('openrouter', true);
  await store.flush();
  assert.deepEqual(readRawState().hiddenModelProviders, ['openrouter']);

  await store.setModelProviderHidden('openrouter', false);
  await store.flush();
  assert.equal('hiddenModelProviders' in readRawState(), false);
  assert.deepEqual(store.getHiddenModelProviders(), []);
});

test('hiddenModelProviders: unhiding a provider that was never hidden is a no-op', async () => {
  const store = await createStore();
  await store.setModelProviderHidden('openrouter', true);
  await store.setModelProviderHidden('openai', false);
  await store.flush();
  assert.deepEqual(readRawState().hiddenModelProviders, ['openrouter']);
});

test('hiddenModelProviders: the list survives a reload from disk', async () => {
  // THE restart case — the hide is a durable operator preference, not a
  // session-scoped one.
  const first = await createStore();
  await first.setModelProviderHidden('openrouter', true);
  await first.flush();

  const second = await createStore();
  assert.deepEqual(second.getHiddenModelProviders(), ['openrouter']);
});

test('hiddenModelProviders: the getter hands back a copy, not the live array', async () => {
  // A caller mutating the returned list must not silently rewrite state.json.
  const store = await createStore();
  await store.setModelProviderHidden('openrouter', true);
  store.getHiddenModelProviders().push('anthropic');
  assert.deepEqual(store.getHiddenModelProviders(), ['openrouter']);
});
