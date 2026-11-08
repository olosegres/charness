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

  it('the agents\' hold is a field of its own: set and cleared apart from the topics\' limit mark, ignored for an unregistered name, and it survives a reload', async () => {
    store.setClaudeProfileAgentHoldUntil('work', '2026-10-12T14:00:00.000Z');
    store.setClaudeProfileAgentHoldUntil('ghost', '2026-10-12T14:00:00.000Z');
    await store.flush();
    const work = store.getClaudeProfileRecord('work');
    assert.equal(work?.agentHoldUntil, '2026-10-12T14:00:00.000Z');
    assert.equal(work?.limitedUntil, undefined, 'the topics\' limit mark is not touched');
    assert.equal(store.getClaudeProfileInfo('ghost'), undefined);
    const reloaded = new StateStore(dataDir);
    await reloaded.init();
    assert.equal(reloaded.getClaudeProfileRecord('work')?.agentHoldUntil, '2026-10-12T14:00:00.000Z');
    store.setClaudeProfileLimitedUntil('work', '2026-10-12T13:00:00.000Z');
    store.setClaudeProfileLimitedUntil('work', null);
    assert.equal(store.getClaudeProfileRecord('work')?.agentHoldUntil, '2026-10-12T14:00:00.000Z', 'clearing the limit mark leaves the hold');
    store.setClaudeProfileAgentHoldUntil('work', null);
    assert.equal(store.getClaudeProfileRecord('work')?.agentHoldUntil, undefined);
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

describe('StateStore: the used-up credit evidence of an account', () => {
  let creditDir = '';
  let credits: StateStore;
  const refusedAt = '2026-11-07T09:00:00.000Z';

  before(async () => {
    creditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-profiles-credit-state-'));
    credits = new StateStore(creditDir, { saveDebounceMs: 5 });
    await credits.init();
    await credits.upsertClaudeProfileRecord('api', { createdAt: '2026-10-01T00:00:00.000Z', billing: 'api' });
    await credits.upsertClaudeProfileRecord('sub', { createdAt: '2026-10-01T00:00:00.000Z', billing: 'subscription' });
  });

  after(async () => {
    await credits.flush();
    fs.rmSync(creditDir, { recursive: true, force: true });
  });

  const record = (name: string) => credits.getClaudeProfileRecord(name);

  it('the operator acting on an API account lifts the mark but KEEPS the refusal, so the next billed turn still renews; on any other account the mark just ends', () => {
    credits.setClaudeProfileCreditExhausted('api', refusedAt);
    credits.setClaudeProfileCreditExhausted('sub', refusedAt);
    credits.liftClaudeProfileCreditExhaustion('api');
    credits.liftClaudeProfileCreditExhaustion('sub');
    assert.deepEqual([record('api')?.creditExhaustedAt, record('api')?.creditUnconfirmedSince], [undefined, refusedAt]);
    assert.deepEqual([record('sub')?.creditExhaustedAt, record('sub')?.creditUnconfirmedSince], [undefined, undefined]);
  });

  it('a second pick changes nothing; a new refusal replaces the kept one with the mark again', () => {
    credits.liftClaudeProfileCreditExhaustion('api');
    assert.equal(record('api')?.creditUnconfirmedSince, refusedAt, 'a pick with no mark leaves the kept refusal alone');
    credits.setClaudeProfileCreditExhausted('api', '2026-11-07T10:00:00.000Z');
    assert.deepEqual([record('api')?.creditExhaustedAt, record('api')?.creditUnconfirmedSince], ['2026-11-07T10:00:00.000Z', undefined]);
  });

  it('a kept refusal never outlives the account being an API account: once it is a subscription a lift clears it, so it cannot come back as stale news if the account turns API again', async () => {
    credits.setClaudeProfileCreditExhausted('api', refusedAt);
    credits.liftClaudeProfileCreditExhaustion('api');
    assert.equal(record('api')?.creditUnconfirmedSince, refusedAt);
    await credits.upsertClaudeProfileRecord('api', { billing: 'subscription' });
    // The first subscription turn that goes through (it reports a cost) ends the evidence — the mark is already gone, the kept refusal must go too.
    credits.liftClaudeProfileCreditExhaustion('api');
    assert.deepEqual([record('api')?.creditExhaustedAt, record('api')?.creditUnconfirmedSince], [undefined, undefined]);
    await credits.upsertClaudeProfileRecord('api', { billing: 'api' });
    assert.equal(record('api')?.creditUnconfirmedSince, undefined, 'turning API again finds nothing left over');
  });

  it('a newer figure clears both the mark and the kept refusal', () => {
    credits.liftClaudeProfileCreditExhaustion('api');
    credits.clearClaudeProfileCreditEvidence('api');
    assert.deepEqual([record('api')?.creditExhaustedAt, record('api')?.creditUnconfirmedSince], [undefined, undefined]);
    credits.clearClaudeProfileCreditEvidence('api');
    credits.clearClaudeProfileCreditEvidence('ghost');
  });

  it('a renewal ends the mark and the kept refusal, starts the spend counter at 0 from its instant, and says it did', () => {
    credits.setClaudeProfileCreditExhausted('api', refusedAt);
    credits.liftClaudeProfileCreditExhaustion('api');
    assert.equal(credits.setClaudeProfileCreditRenewed('api', '2026-11-08T09:00:00.000Z'), true);
    assert.deepEqual(
      [record('api')?.creditExhaustedAt, record('api')?.creditUnconfirmedSince, record('api')?.creditRenewedAt, record('api')?.creditSpend],
      [undefined, undefined, '2026-11-08T09:00:00.000Z', { since: '2026-11-08T09:00:00.000Z', usd: 0 }],
    );
  });

  it('a renewal is REFUSED when a refusal newer than it is recorded — a turn failed while the answer was on its way — and nothing changes', () => {
    credits.setClaudeProfileCreditExhausted('api', '2026-11-09T09:00:05.000Z');
    assert.equal(credits.setClaudeProfileCreditRenewed('api', '2026-11-09T09:00:00.000Z'), false);
    assert.deepEqual([record('api')?.creditExhaustedAt, record('api')?.creditRenewedAt], ['2026-11-09T09:00:05.000Z', '2026-11-08T09:00:00.000Z']);
    assert.equal(credits.setClaudeProfileCreditRenewed('api', '2026-11-09T09:00:05.000Z'), true, 'a refusal at the very instant is not newer');
    assert.equal(credits.setClaudeProfileCreditRenewed('ghost', '2026-11-09T09:00:05.000Z'), false, 'an unregistered name is ignored');
  });

  it('and it is refused when the newer refusal is one the operator ALREADY acted on (picked the account right after it): an acted-on refusal is still a refusal', () => {
    credits.setClaudeProfileCreditExhausted('api', '2026-11-10T09:00:05.000Z');
    credits.liftClaudeProfileCreditExhaustion('api');
    assert.deepEqual([record('api')?.creditExhaustedAt, record('api')?.creditUnconfirmedSince], [undefined, '2026-11-10T09:00:05.000Z']);
    const renewedBefore = record('api')?.creditRenewedAt;
    assert.equal(credits.setClaudeProfileCreditRenewed('api', '2026-11-10T09:00:00.000Z'), false);
    assert.deepEqual([record('api')?.creditUnconfirmedSince, record('api')?.creditRenewedAt], ['2026-11-10T09:00:05.000Z', renewedBefore], 'nothing wiped, nothing reset');
    assert.equal(credits.setClaudeProfileCreditRenewed('api', '2026-11-10T09:00:06.000Z'), true, 'an answer AFTER the refusal renews');
    assert.equal(record('api')?.creditUnconfirmedSince, undefined);
  });
});

describe('StateStore: OpenCode provider usage', () => {
  it('a provider\'s auth kind and usage are stored per provider id and survive a reload; an unseen provider reads as nothing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-usage-state-'));
    try {
      const opened = new StateStore(dir, { saveDebounceMs: 5 });
      await opened.init();
      assert.deepEqual(opened.getOpenCodeProviderUsages(), {});
      assert.equal(opened.getOpenCodeProviderUsage('openai'), undefined);
      opened.setOpenCodeProviderUsage('openai', { authKind: 'subscription', usage: snapshot });
      opened.setOpenCodeProviderUsage('openrouter', { authKind: 'apiKey' });
      await opened.flush();
      const reloaded = new StateStore(dir);
      await reloaded.init();
      assert.deepEqual(reloaded.getOpenCodeProviderUsage('openai'), { authKind: 'subscription', usage: snapshot });
      assert.deepEqual(Object.keys(reloaded.getOpenCodeProviderUsages()).sort(), ['openai', 'openrouter']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
