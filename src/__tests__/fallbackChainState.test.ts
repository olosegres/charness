/**
 * @description The fallback chain, the OpenCode limit marks, the parked session ids and the rung a limit switch
 * moved a topic from in `state.json` (`StateStore`): the chain is validated on read and flushed at once, a limit
 * mark is kept per `provider/model` label, a parked id survives a reload and is dropped with the live ids when the
 * conversation is released, the remembered rung survives a reload and goes with the topic's binding.
 * Reloaded from disk to prove persistence, not just the in-memory view.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StateStore } from '../state';
import { keyToString } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';

const topic = makeTelegramKey(-1001111111111, 11);

let dataDir: string;
let store: StateStore;

describe('StateStore: fallback chain, OpenCode limit marks, parked sessions', () => {
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

  it('round-trips the disabled flag through state.json; an enabled rung stays field-less (older files read back as enabled)', async () => {
    await store.setFallbackChain([
      { backend: 'claude', profile: 'work', model: null, disabled: true },
      { backend: 'opencode', providerId: 'openai', modelId: 'gpt-5' },
    ]);
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8')) as { fallbackChain: Array<Record<string, unknown>> };
    assert.equal(raw.fallbackChain[0].disabled, true);
    assert.equal('disabled' in raw.fallbackChain[1], false);
    const reloaded = new StateStore(dataDir);
    await reloaded.init();
    assert.deepEqual(reloaded.getFallbackChain(), [
      { backend: 'claude', profile: 'work', model: null, disabled: true },
      { backend: 'opencode', providerId: 'openai', modelId: 'gpt-5' },
    ]);
    await store.setFallbackChain([]);
  });

  it('a per-topic limit override can be set, read and dropped again (null = follow the instance default); an emptied map leaves no field', async () => {
    await store.setClaudeAutoSwitchOnLimitOverride(topic, true);
    await store.setAutoContinueOnLimitOverride(topic, false);
    assert.equal(store.getClaudeAutoSwitchOnLimitOverride(topic), true);
    assert.equal(store.getAutoContinueOnLimitOverride(topic), false);
    await store.setClaudeAutoSwitchOnLimitOverride(topic, null);
    await store.setAutoContinueOnLimitOverride(topic, null);
    assert.equal(store.getClaudeAutoSwitchOnLimitOverride(topic), undefined);
    assert.equal(store.getAutoContinueOnLimitOverride(topic), undefined);
    await store.flush();
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8')) as Record<string, unknown>;
    assert.equal('claudeAutoSwitchOnLimitOverrides' in raw, false);
    assert.equal('autoContinueOnLimitOverrides' in raw, false);
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

  it('parks a session id per thread, survives a reload, and is released with the live ids', async () => {
    assert.equal(store.getParkedSession(topic), null);
    await store.setAgent(topic, { name: 'opencode', opencodeSessionId: 'ses_live' });
    await store.setParkedSession(topic, { adapterName: 'claude-json-stream', claudeSessionId: '11111111-1111-4111-8111-111111111111', parkedAt: '2026-10-12T10:00:00.000Z' });
    await store.flush();
    const reloaded = new StateStore(dataDir);
    await reloaded.init();
    assert.equal(reloaded.getParkedSession(topic)?.claudeSessionId, '11111111-1111-4111-8111-111111111111');
    await store.clearAgentSessionIds(topic);
    assert.equal(store.getParkedSession(topic), null, 'a released conversation drops its parked id too');
    assert.equal(store.getAgent(topic)?.opencodeSessionId, undefined);
  });

  it('remembers the rung a topic was moved from per topic, survives a reload, forgets on null and with the binding; a malformed one reads as none', async () => {
    const other = makeTelegramKey(-1001111111111, 12);
    assert.equal(store.getFallbackReturn(topic), null);
    await store.setBinding(topic, 'return-test');
    await store.setFallbackReturn(topic, { backend: 'claude', profile: 'default', model: 'claude-opus-5-5[1m]' });
    await store.setFallbackReturn(other, { backend: 'opencode', providerId: 'openai', modelId: 'gpt-5' });
    await store.flush();
    const reloaded = new StateStore(dataDir);
    await reloaded.init();
    assert.deepEqual(reloaded.getFallbackReturn(topic), { backend: 'claude', profile: 'default', model: 'claude-opus-5-5[1m]' }, 'the model id the session reported survives');
    assert.deepEqual(reloaded.getFallbackReturn(other), { backend: 'opencode', providerId: 'openai', modelId: 'gpt-5' });

    await store.setFallbackReturn(other, null);
    assert.equal(store.getFallbackReturn(other), null);
    await store.removeBinding(topic);
    assert.equal(store.getFallbackReturn(topic), null, 'an unbound topic keeps nothing to go back to');
    await store.flush();
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8')) as Record<string, unknown>;
    assert.equal('fallbackReturns' in raw, false, 'an emptied map leaves no field behind');

    await store.setFallbackReturn(topic, { backend: 'claude', profile: 'work', model: null });
    await store.flush();
    const statePath = path.join(dataDir, 'state.json');
    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { fallbackReturns: Record<string, { profile: string }> };
    persisted.fallbackReturns[keyToString(topic)].profile = 'Not A Slug';
    fs.writeFileSync(statePath, JSON.stringify(persisted));
    const damaged = new StateStore(dataDir);
    await damaged.init();
    assert.equal(damaged.getFallbackReturn(topic), null, 'a hand edit that breaks the shape never reaches a button');
  });
});
