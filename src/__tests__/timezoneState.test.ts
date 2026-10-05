/**
 * Test case: N/A — Charness has no Jira tracker
 *
 * @description Persistence of the instance-wide `/timezone` setting.
 *
 * Load-bearing intent (per `.claude/rules/tests.md`):
 * - a default install leaves NO trace in `state.json`, and a reset removes the
 *   field rather than writing an empty/`null` value — the locked decision is
 *   "absent by default", so existing installs keep behaving exactly as before.
 * - the value survives a reload, because the whole point is that the operator
 *   declares their zone ONCE.
 *
 * Mirrors the isolated-`dataDir` + fake-`HOME` harness of
 * `hiddenModelProviders.test.ts` so nothing touches a real home directory.
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
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-timezone-state-'));
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

test('timezone: a fresh state file stores nothing', async () => {
  const store = await createStore();
  assert.equal(store.getTimezone(), null);
  await store.flush();
  assert.equal('timezone' in readRawState(), false, 'no trace on a default install');
});

test('timezone: a set zone persists and survives a reload', async () => {
  const store = await createStore();
  await store.setTimezone('Europe/Moscow');
  assert.equal(store.getTimezone(), 'Europe/Moscow');
  assert.equal(readRawState().timezone, 'Europe/Moscow', 'flushed eagerly, not only on debounce');

  const reloaded = await createStore();
  assert.equal(reloaded.getTimezone(), 'Europe/Moscow');
});

test('timezone: a fixed offset is stored verbatim', async () => {
  const store = await createStore();
  await store.setTimezone('+04:00');
  assert.equal((await createStore()).getTimezone(), '+04:00');
});

test('timezone: reset DROPS the field rather than writing an empty value', async () => {
  const store = await createStore();
  await store.setTimezone('Asia/Kolkata');
  await store.setTimezone(null);

  assert.equal(store.getTimezone(), null);
  assert.equal('timezone' in readRawState(), false, 'reset must leave the file as a default install');
  assert.equal((await createStore()).getTimezone(), null);
});
