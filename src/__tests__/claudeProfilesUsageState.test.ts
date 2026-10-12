/**
 * @description The usage side of the profile registry in `state.json`: `default` has a HIDDEN record (its
 * probe result, usage snapshot, limit mark) that the registry getters never list, the usage/limit setters
 * create it on first write and ignore an unregistered added name, and the writes are debounced but land on
 * disk. Reloaded to prove persistence.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StateStore } from '../state';
import type { ClaudeUsageSnapshot } from '../utils/claudeUsage';

let dataDir: string;
let store: StateStore;

const snapshot: ClaudeUsageSnapshot = {
  fetchedAt: '2026-10-12T10:00:00.000Z',
  source: 'api',
  buckets: [{ kind: 'session', percent: 81, resetsAt: '2026-10-12T13:00:00.000Z', scopeModel: null }],
};

describe('StateStore: Claude profile usage and the hidden default record', () => {
  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-profiles-usage-'));
    store = new StateStore(dataDir, { saveDebounceMs: 5 });
    await store.init();
  });

  after(async () => {
    await store.flush();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('the usage of default lands on a hidden record the registry views never list', async () => {
    store.setClaudeProfileUsage('default', snapshot);
    await store.flush();
    assert.deepEqual(store.getClaudeProfileInfo('default')?.usage, snapshot);
    assert.equal(store.getClaudeProfileRecord('default'), undefined, 'not an added profile');
    assert.deepEqual(Object.keys(store.getClaudeProfileRecords()), []);
    assert.deepEqual([...store.getClaudeProfileNames()], []);
    assert.equal(store.resolveClaudeProfileName({ platform: 'telegram', space: '-1001111111111', thread: '11' } as never), 'default');
    assert.deepEqual(Object.keys(store.getAllClaudeProfileInfos()), ['default'], 'the ranking input sees it');
  });

  it('an added profile keeps its usage and limit mark beside the probe fields; an unregistered name is ignored', async () => {
    await store.upsertClaudeProfileRecord('work', { createdAt: '2026-10-01T00:00:00.000Z', loggedIn: true, email: 'w@example.com' });
    store.setClaudeProfileUsage('work', snapshot);
    store.setClaudeProfileLimitedUntil('work', '2026-10-12T13:00:00.000Z');
    store.setClaudeProfileUsage('ghost', snapshot);
    store.setClaudeProfileLimitedUntil('ghost', '2026-10-12T13:00:00.000Z');
    await store.flush();
    const work = store.getClaudeProfileRecord('work');
    assert.deepEqual(work?.usage, snapshot);
    assert.equal(work?.limitedUntil, '2026-10-12T13:00:00.000Z');
    assert.equal(work?.email, 'w@example.com', 'the probe fields are untouched');
    assert.equal(store.getClaudeProfileInfo('ghost'), undefined);
    assert.deepEqual([...store.getClaudeProfileNames()], ['work']);
    store.setClaudeProfileLimitedUntil('work', null);
    assert.equal(store.getClaudeProfileRecord('work')?.limitedUntil, undefined);
  });

  it('a status upsert for default lands on the same hidden record, and everything survives a reload', async () => {
    await store.upsertClaudeProfileRecord('default', { loggedIn: true, email: 'me@example.com', subscriptionType: 'max' });
    await store.flush();
    const reloaded = new StateStore(dataDir);
    await reloaded.init();
    const info = reloaded.getClaudeProfileInfo('default');
    assert.equal(info?.email, 'me@example.com');
    assert.deepEqual(info?.usage, snapshot);
    assert.deepEqual(Object.keys(reloaded.getClaudeProfileRecords()), ['work']);
    assert.deepEqual(reloaded.getClaudeProfileRecord('work')?.usage, snapshot);
  });

  it('removing an added profile never touches the hidden default record', async () => {
    await store.removeClaudeProfileRecord('work');
    assert.equal(store.getClaudeProfileInfo('work'), undefined);
    assert.deepEqual(store.getClaudeProfileInfo('default')?.usage, snapshot);
  });
});
