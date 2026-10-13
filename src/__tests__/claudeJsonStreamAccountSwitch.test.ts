/**
 * @description The account switch after a usage limit must not wait for a "working" flag the limit left stuck.
 *
 * Live incident: a fresh process got a batch of messages, the first turn failed with a usage limit, and the
 * CLI never echoed the queued messages — `unconsumedInputCount` stayed above zero, the session looked working
 * for good, and the deferred switch never fired. Load-bearing intent:
 * - an error `result` reconciles the unconsumed-input count so a pending switch applies at that turn end;
 * - a switch answering a limit (`isAfterLimit`) re-spawns now even over a busy / input-holding session, while a
 *   plain apply still defers.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ClaudeJsonStreamAdapter } from '../adapters/claudeJsonStreamAdapter';
import { keyToString, type SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { createStreamSessionFixture } from './claudeJsonStreamSessionFixture';

const key: SessionKey = makeTelegramKey(-100999222, 78);
const limitResult = JSON.stringify({ type: 'result', is_error: true, result: "You've hit your weekly limit" }) + '\n';
const okResult = JSON.stringify({ type: 'result', is_error: false, result: 'done' }) + '\n';

function setup(): { adapter: ClaudeJsonStreamAdapter; respawns: Array<string | null | undefined> } {
  const adapter = new ClaudeJsonStreamAdapter();
  adapter.setClaudeConfigDirReader(() => '/profiles/perf');
  const session = createStreamSessionFixture({ key, workDir: '/tmp/jsonstream-account-work', sessionId: 'sess-acct' });
  adapter['sessions'].set(keyToString(key), session);
  const respawns: Array<string | null | undefined> = [];
  adapter['respawnWithChange'] = async (_s, change) => { respawns.push(change.configDir); };
  return { adapter, respawns };
}

describe('claude-json-stream account switch after a limit', () => {
  it('a plain apply over a session holding unconsumed input defers', async () => {
    const { adapter, respawns } = setup();
    adapter['sessions'].get(keyToString(key))!.unconsumedInputCount = 4;
    assert.equal(await adapter.applyClaudeConfigDir(key), 'deferred');
    assert.deepEqual(respawns, []);
  });

  it('isAfterLimit re-spawns now even when busy with unconsumed input', async () => {
    const { adapter, respawns } = setup();
    const session = adapter['sessions'].get(keyToString(key))!;
    session.isBusy = true;
    session.unconsumedInputCount = 3;
    assert.equal(await adapter.applyClaudeConfigDir(key, { isAfterLimit: true }), 'respawned');
    assert.deepEqual(respawns, ['/profiles/perf']);
  });

  it('an error result zeroes a stuck unconsumed-input count (regression: the switch never fired)', () => {
    const { adapter } = setup();
    const session = adapter['sessions'].get(keyToString(key))!;
    session.isBusy = true;
    session.unconsumedInputCount = 4; // four queued messages, the CLI echoed none of them
    adapter['onStdout'](session, limitResult);
    assert.equal(session.unconsumedInputCount, 0);
    assert.equal(adapter.checkIsWorking(key), false);
  });

  it('a normal result keeps the count of messages still queued', () => {
    const { adapter } = setup();
    const session = adapter['sessions'].get(keyToString(key))!;
    session.unconsumedInputCount = 2;
    adapter['onStdout'](session, okResult);
    assert.equal(session.unconsumedInputCount, 2);
  });

  it('a pending switch fires at the limit-error turn end', async () => {
    const { adapter, respawns } = setup();
    const session = adapter['sessions'].get(keyToString(key))!;
    session.isBusy = true;
    session.unconsumedInputCount = 4;
    assert.equal(await adapter.applyClaudeConfigDir(key), 'deferred');
    adapter['onStdout'](session, limitResult);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(respawns, ['/profiles/perf']);
  });
});
