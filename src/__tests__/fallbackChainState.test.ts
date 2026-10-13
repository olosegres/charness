/**
 * @description The fallback chain and the OpenCode limit marks in `state.json` (`StateStore`): the chain is
 * validated on read and flushed at once, a limit mark is kept per `provider/model` label. Reloaded from disk
 * to prove persistence, not just the in-memory view.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StateStore } from '../state';

let dataDir: string;
let store: StateStore;

describe('StateStore: fallback chain, OpenCode limit marks', () => {
  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fallback-chain-state-'));
    store = new StateStore(dataDir);
    await store.init();
  });

  after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  it('starts empty and persists a chain, validated on the way in and out', async () => {
    assert.deepEqual(store.getFallbackChain(), []);
    await store.setFallbackChain([
      { backend: 'claude', profile: 'work', model: 'fable' },
      { backend: 'opencode', providerId: 'openai', modelId: 'gpt-5' },
      { backend: 'claude', profile: 'work', model: 'fable' }, // a duplicate is folded
    ]);
    const reloaded = new StateStore(dataDir);
    await reloaded.init();
    assert.deepEqual(reloaded.getFallbackChain(), [
      { backend: 'claude', profile: 'work', model: 'fable' },
      { backend: 'opencode', providerId: 'openai', modelId: 'gpt-5' },
    ]);
    await store.setFallbackChain([]);
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8')) as Record<string, unknown>;
    assert.equal('fallbackChain' in raw, false, 'an empty chain leaves no field behind');
  });

  it('keeps one limit mark per OpenCode model label and drops it on clear', async () => {
    assert.equal(store.getOpenCodeModelLimitedUntil('openai/gpt-5'), undefined);
    store.setOpenCodeModelLimitedUntil('openai/gpt-5', '2026-10-12T12:00:00.000Z');
    store.setOpenCodeModelLimitedUntil('google/gemini-2.5-pro', '2026-10-12T13:00:00.000Z');
    assert.deepEqual(store.getOpenCodeModelLimits(), { 'openai/gpt-5': '2026-10-12T12:00:00.000Z', 'google/gemini-2.5-pro': '2026-10-12T13:00:00.000Z' });
    store.setOpenCodeModelLimitedUntil('openai/gpt-5', null);
    assert.deepEqual(store.getOpenCodeModelLimits(), { 'google/gemini-2.5-pro': '2026-10-12T13:00:00.000Z' });
    store.setOpenCodeModelLimitedUntil('google/gemini-2.5-pro', null);
    assert.deepEqual(store.getOpenCodeModelLimits(), {});
  });
});
