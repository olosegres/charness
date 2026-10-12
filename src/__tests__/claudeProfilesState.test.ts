/**
 * @description The Claude account profile registry and selection in `state.json` (`StateStore`): records are
 * flushed at once, the instance default and the per-thread picks resolve through `utils/claudeProfiles.ts`
 * (an explicit `default` pick beats a non-default instance default), and removing a profile drops the picks
 * that named it — returning those threads — and the instance default when it was that profile. Reloaded from
 * disk to prove persistence, not just the in-memory view.
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

const topicA = makeTelegramKey(-1001111111111, 11);
const topicB = makeTelegramKey(-1001111111111, 12);

let dataDir: string;
let store: StateStore;

describe('StateStore: Claude account profiles', () => {
  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-profiles-state-'));
    store = new StateStore(dataDir);
    await store.init();
  });

  after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  it('starts with no profiles: everything resolves to default', () => {
    assert.deepEqual(store.getClaudeProfileRecords(), {});
    assert.equal(store.getClaudeProfileGlobalDefault(), 'default');
    assert.equal(store.resolveClaudeProfileName(topicA), 'default');
    assert.equal(store.getClaudeProfileOverride(topicA), undefined);
  });

  it('upsert merges and keeps createdAt; the record is on disk right away', async () => {
    await store.upsertClaudeProfileRecord('work', { createdAt: '2026-10-01T00:00:00.000Z', loggedIn: false });
    await store.upsertClaudeProfileRecord('work', { loggedIn: true, email: 'work@example.com', subscriptionType: 'team' });
    const record = store.getClaudeProfileRecord('work');
    assert.equal(record?.createdAt, '2026-10-01T00:00:00.000Z');
    assert.equal(record?.email, 'work@example.com');
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
    assert.equal(onDisk.claudeProfiles.work.subscriptionType, 'team');
  });

  it('a topic pick wins over the instance default; an explicit default pick wins too', async () => {
    await store.upsertClaudeProfileRecord('team', { createdAt: '2026-10-02T00:00:00.000Z' });
    await store.setClaudeProfileGlobalDefault('team');
    assert.equal(store.getClaudeProfileGlobalDefault(), 'team');
    assert.equal(store.resolveClaudeProfileName(topicA), 'team');
    await store.setClaudeProfileOverride(topicA, 'work');
    assert.equal(store.resolveClaudeProfileName(topicA), 'work');
    await store.setClaudeProfileOverride(topicB, 'default');
    assert.equal(store.resolveClaudeProfileName(topicB), 'default');
    assert.deepEqual(store.listClaudeProfileOverrideKeys('work').map(keyToString), [keyToString(topicA)]);
  });

  it('clearing a pick returns the topic to the instance default', async () => {
    await store.setClaudeProfileOverride(topicB, null);
    assert.equal(store.getClaudeProfileOverride(topicB), undefined);
    assert.equal(store.resolveClaudeProfileName(topicB), 'team');
  });

  it('removing a profile drops the picks that named it (returned) and the instance default when it was that one', async () => {
    const dropped = await store.removeClaudeProfileRecord('work');
    assert.deepEqual(dropped.map(keyToString), [keyToString(topicA)]);
    assert.equal(store.getClaudeProfileRecord('work'), undefined);
    assert.equal(store.resolveClaudeProfileName(topicA), 'team', 'the topic follows the instance default again');
    await store.removeClaudeProfileRecord('team');
    assert.equal(store.getClaudeProfileGlobalDefault(), 'default');
    assert.equal(store.resolveClaudeProfileName(topicA), 'default');
  });

  it('a pick that names an unknown profile reads as the fallback, and survives a reload as stored', async () => {
    await store.setClaudeProfileOverride(topicA, 'ghost');
    assert.equal(store.getClaudeProfileOverride(topicA), 'ghost');
    assert.equal(store.resolveClaudeProfileName(topicA), 'default');
    await store.flush();
    const reloaded = new StateStore(dataDir);
    await reloaded.init();
    assert.equal(reloaded.getClaudeProfileOverride(topicA), 'ghost');
    assert.equal(reloaded.resolveClaudeProfileName(topicA), 'default');
  });

  it('auto-switch on limit: OFF everywhere by default; a topic override wins over the instance default; both survive a reload', async () => {
    assert.equal(store.getClaudeAutoSwitchOnLimitGlobalDefault(), false);
    assert.equal(store.checkIsClaudeAutoSwitchOnLimitEnabled(topicA), false);
    await store.setClaudeAutoSwitchOnLimitGlobalDefault(true);
    assert.equal(store.checkIsClaudeAutoSwitchOnLimitEnabled(topicA), true);
    await store.setClaudeAutoSwitchOnLimitOverride(topicA, false);
    assert.equal(store.checkIsClaudeAutoSwitchOnLimitEnabled(topicA), false);
    assert.equal(store.checkIsClaudeAutoSwitchOnLimitEnabled(topicB), true);
    await store.flush();
    const reloaded = new StateStore(dataDir);
    await reloaded.init();
    assert.equal(reloaded.getClaudeAutoSwitchOnLimitGlobalDefault(), true);
    assert.equal(reloaded.getClaudeAutoSwitchOnLimitOverride(topicA), false);
    assert.equal(reloaded.checkIsClaudeAutoSwitchOnLimitEnabled(topicB), true);
  });
});
