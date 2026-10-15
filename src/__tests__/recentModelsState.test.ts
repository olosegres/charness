/**
 * Test case: N/A — Charness has no Jira tracker
 *
 * @description The GLOBAL recently-used model list behind the `/model`
 * picker's "Recently used" shortcut. It is instance-wide (a favourite is a
 * favourite in every topic) and has to survive a restart — hence `state.json`
 * rather than memory.
 *
 * Covers the persistence SHAPE (most recent first, deduped, field dropped
 * when empty so a default install leaves no trace) and the reload round-trip.
 * Mirrors `hiddenModelProviders.test.ts`'s isolated-`dataDir` + fake-`HOME`
 * harness so nothing touches the developer's real home.
 */

import { test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StateStore } from '../state';
import { recentModelsLimit } from '../utils/modelRecentPlan';

let dataDir: string;
let fakeHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-recent-models-'));
  dataDir = path.join(fakeHome, '.charness');
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

test('recentModels: a fresh state file remembers nothing', async () => {
  const store = await createStore();
  assert.deepEqual(store.getRecentModels(), []);
  await store.flush();
  assert.equal('recentModels' in readRawState(), false, 'no trace on a default install');
});

test('recentModels: picks persist most recent first, a repeat moves to the head', async () => {
  const store = await createStore();
  await store.addRecentModel('anthropic/claude-sonnet-4-5');
  await store.addRecentModel('openai/gpt-5');
  await store.addRecentModel('anthropic/claude-sonnet-4-5');
  await store.flush();
  assert.deepEqual(readRawState().recentModels, ['anthropic/claude-sonnet-4-5', 'openai/gpt-5']);
  assert.deepEqual(store.getRecentModels(), ['anthropic/claude-sonnet-4-5', 'openai/gpt-5']);
});

test('recentModels: the list is capped on disk', async () => {
  const store = await createStore();
  for (let i = 0; i < recentModelsLimit + 5; i++) await store.addRecentModel(`p/m-${i}`);
  await store.flush();
  const onDisk = readRawState().recentModels as string[];
  assert.equal(onDisk.length, recentModelsLimit);
  assert.equal(onDisk[0], `p/m-${recentModelsLimit + 4}`);
});

test('recentModels: the getter hands out a copy', async () => {
  const store = await createStore();
  await store.addRecentModel('a/1');
  store.getRecentModels().push('mutated/entry');
  assert.deepEqual(store.getRecentModels(), ['a/1']);
});

test('recentModels: survives a reload', async () => {
  const first = await createStore();
  await first.addRecentModel('openrouter/vendor/model');
  await first.addRecentModel('anthropic/claude-opus-4-8');
  await first.flush();

  const second = await createStore();
  assert.deepEqual(second.getRecentModels(), ['anthropic/claude-opus-4-8', 'openrouter/vendor/model']);
});
