/**
 * @description The effort a json-stream session LAUNCHES with, and «as in General» on a live one. The launch
 * chain is, first that exists: the topic's own `/effort` pick, the platform's default (Jira's `jira.json`), the
 * instance default (`settings.json`, via the registered reader), the code fallback (medium). Clearing a pick drops
 * it from disk and brings a live process to the default only when it runs a different level (a re-spawn is a
 * restart of the child, so none is made for nothing).
 *
 * Private members are reached via bracket access, like the neighbouring json-stream adapter tests.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ClaudeJsonStreamAdapter, type StreamSession } from '../adapters/claudeJsonStreamAdapter';
import { clearEffortPref } from '../adapters/claudeCliAdapter';
import { defaultEffortLevel, setInstanceDefaultEffortReader } from '../effortLevels';
import { keyToString, type SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { createStreamSessionFixture } from './claudeJsonStreamSessionFixture';

const key: SessionKey = makeTelegramKey(-100999333, 5);

interface RespawnCall {
  model: string | null;
  effort: string | null;
}

function createAdapterWithSession(sessionEffort: string | null, isActive = true): { adapter: ClaudeJsonStreamAdapter; session: StreamSession; respawns: RespawnCall[] } {
  const adapter = new ClaudeJsonStreamAdapter();
  const session = createStreamSessionFixture({ key, workDir: '/tmp/jsonstream-effort-work', sessionId: 'sess-json-effort', effort: sessionEffort, model: 'sonnet', isActive });
  adapter['sessions'].set(keyToString(key), session);
  const respawns: RespawnCall[] = [];
  adapter['respawnWithChange'] = async (_session, change) => {
    respawns.push({ model: change.model, effort: change.effort });
  };
  return { adapter, session, respawns };
}

describe('claude-json-stream effort: the launch chain and «as in General»', () => {
  afterEach(() => {
    setInstanceDefaultEffortReader(() => null);
    clearEffortPref(key);
  });

  it('launches with the code fallback when nothing else says otherwise', () => {
    const { adapter } = createAdapterWithSession(null);
    assert.equal(adapter['getLaunchOptions'](key).effort, defaultEffortLevel);
    assert.equal(defaultEffortLevel, 'medium');
  });

  it('the instance default (settings.json) replaces the code fallback', () => {
    setInstanceDefaultEffortReader(() => 'low');
    const { adapter } = createAdapterWithSession(null);
    assert.equal(adapter['getLaunchOptions'](key).effort, 'low');
  });

  it('the platform default outranks the instance default, and the topic\'s own pick outranks both', async () => {
    setInstanceDefaultEffortReader(() => 'low');
    const { adapter } = createAdapterWithSession(null);
    adapter.setSessionLaunchDefaultsReader(() => ({ model: null, effort: 'high' }));
    assert.equal(adapter['getLaunchOptions'](key).effort, 'high');

    await adapter.setEffort(key, 'max');
    assert.equal(adapter['getLaunchOptions'](key).effort, 'max');
  });

  it('a pick is "own"; a default is not — getOwnEffort stays null until the topic picks', async () => {
    setInstanceDefaultEffortReader(() => 'low');
    const { adapter } = createAdapterWithSession(null, false);
    assert.equal(adapter.getOwnEffort(key), null);
    await adapter.setEffort(key, 'high');
    assert.equal(adapter.getOwnEffort(key), 'high');
  });

  it('clearing a pick on a live process that runs another level re-spawns it at the default', async () => {
    setInstanceDefaultEffortReader(() => 'low');
    const { adapter, respawns } = createAdapterWithSession('max');
    await adapter.setEffort(key, 'max'); // the pick the process runs (the respawn is stubbed)
    respawns.length = 0;

    await adapter.clearEffort(key);

    assert.equal(adapter.getOwnEffort(key), null, 'the pick is gone from disk');
    assert.deepEqual(respawns, [{ model: 'sonnet', effort: 'low' }], 'same conversation and model, the default level');
  });

  it('clearing a pick on a process that already runs the default does not restart it', async () => {
    setInstanceDefaultEffortReader(() => 'low');
    const { adapter, respawns } = createAdapterWithSession('low');
    await adapter.setEffort(key, 'low');
    respawns.length = 0;

    await adapter.clearEffort(key);
    assert.deepEqual(respawns, []);
    assert.equal(adapter.getOwnEffort(key), null);
  });

  it('clearing a pick of a stopped conversation only drops it: the next start reads the default', async () => {
    setInstanceDefaultEffortReader(() => 'low');
    const { adapter, respawns } = createAdapterWithSession('max', false);
    await adapter.setEffort(key, 'max');

    await adapter.clearEffort(key);
    assert.deepEqual(respawns, []);
    assert.equal(adapter['getLaunchOptions'](key).effort, 'low');
  });

  it('getEffortState: the live process runs the level it was spawned with while the default moves on; the next start resolves the chain afresh', () => {
    setInstanceDefaultEffortReader(() => 'medium');
    const { adapter } = createAdapterWithSession('xhigh');
    assert.deepEqual(adapter.getEffortState(key), { running: 'xhigh', nextStart: 'medium' }, 'the General change never reaches the running process');

    setInstanceDefaultEffortReader(() => 'xhigh');
    assert.deepEqual(adapter.getEffortState(key), { running: 'xhigh', nextStart: 'xhigh' });
  });

  it('getEffortState: the next start follows the platform default and the topic\'s own pick before the instance default', async () => {
    setInstanceDefaultEffortReader(() => 'low');
    const { adapter } = createAdapterWithSession('low');
    adapter.setSessionLaunchDefaultsReader(() => ({ model: null, effort: 'high' }));
    assert.equal(adapter.getEffortState(key).nextStart, 'high');
    await adapter.setEffort(key, 'max');
    assert.equal(adapter.getEffortState(key).nextStart, 'max');
  });

  it('getEffortState: no live process, or one whose level is unknown (adopted without the flag), has no running level', () => {
    setInstanceDefaultEffortReader(() => 'low');
    assert.deepEqual(createAdapterWithSession('high', false).adapter.getEffortState(key), { running: null, nextStart: 'low' });
    assert.deepEqual(createAdapterWithSession(null).adapter.getEffortState(key), { running: null, nextStart: 'low' });
  });
  it('setEffort says what it did: applied on a live process, stored with a notice when none runs, refused for a level it does not know — and a refusal stores nothing', async () => {
    const live = createAdapterWithSession('low');
    assert.deepEqual(await live.adapter.setEffort(key, 'max'), { status: 'applied' });
    assert.deepEqual(live.respawns, [{ model: 'sonnet', effort: 'max' }]);

    clearEffortPref(key);
    const stopped = createAdapterWithSession('low', false);
    const stoppedOutcome = await stopped.adapter.setEffort(key, 'high');
    assert.equal(stoppedOutcome.status, 'stored');
    assert.ok(stoppedOutcome.status === 'stored' && stoppedOutcome.notice.length > 0);
    assert.equal(stopped.adapter.getOwnEffort(key), 'high', 'stored means saved');

    clearEffortPref(key);
    const refused = await live.adapter.setEffort(key, 'turbo');
    assert.equal(refused.status, 'refused');
    assert.ok(refused.status === 'refused' && refused.reason.includes('turbo'));
    assert.equal(live.adapter.getOwnEffort(key), null, 'a refusal stores nothing');
  });
});
