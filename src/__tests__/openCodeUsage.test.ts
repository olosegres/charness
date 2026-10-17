/**
 * `utils/openCodeUsage.ts` — the usage of OpenCode providers signed in through a subscription: the `auth.json` reader
 * (a record's kind only, never a token in a log), the tolerant parse of the ChatGPT usage response, the request (token,
 * account id off the record or the token), and the poller: an API key or an unknown record is stored as its kind alone,
 * an expired token is never sent and marks the snapshot stale, a failure keeps the last figures and is logged once per
 * reason, a provider `auth.json` does not list is left alone, the on-demand max-age gate.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  chatGptUsageEndpoint,
  createOpenCodeUsagePoller,
  fetchChatGptUsage,
  parseChatGptUsageResponse,
  parseOpenCodeCredentials,
  readOpenCodeCredentials,
  type OpenCodeProviderCredential,
  type OpenCodeProviderUsageRecord,
} from '../utils/openCodeUsage';
import type { ClaudeUsageBucket, ClaudeUsageFetchResult, UsageFetchLike } from '../utils/claudeUsage';

const nowMs = Date.parse('2026-10-17T10:00:00Z');
const resetAtSeconds = Date.parse('2026-10-17T13:00:00Z') / 1000;
const weeklyResetAtSeconds = Date.parse('2026-10-22T10:00:00Z') / 1000;
const secretToken = 'tok-secret-access-value';

const bothWindows = {
  plan_type: 'plus',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 12, limit_window_seconds: 18_000, reset_after_seconds: 10_800, reset_at: resetAtSeconds },
    secondary_window: { used_percent: 40, limit_window_seconds: 604_800, reset_after_seconds: 432_000, reset_at: weeklyResetAtSeconds },
  },
};

describe('parseOpenCodeCredentials', () => {
  it('reads the kind of every record: oauth = subscription, api = API key, anything else unknown; a malformed entry is skipped', () => {
    const parsed = parseOpenCodeCredentials({
      openai: { type: 'oauth', access: secretToken, refresh: 'r', expires: 1_800_000_000_000, accountId: 'acc-1' },
      openrouter: { type: 'api', key: 'sk-xxx' },
      custom: { type: 'wellknown', key: 'k', token: 't' },
      broken: 'not a record',
    });
    assert.deepEqual(parsed, {
      openai: { kind: 'subscription', accessToken: secretToken, expiresAtMs: 1_800_000_000_000, accountId: 'acc-1' },
      openrouter: { kind: 'apiKey', accessToken: null, expiresAtMs: null, accountId: null },
      custom: { kind: 'unknown', accessToken: null, expiresAtMs: null, accountId: null },
    });
  });

  it('a document that is not an object reads as nothing', () => {
    assert.equal(parseOpenCodeCredentials(null), null);
    assert.equal(parseOpenCodeCredentials([]), null);
    assert.equal(parseOpenCodeCredentials('x'), null);
  });
});

describe('readOpenCodeCredentials', () => {
  it('reads the file, and a missing or unreadable one is null (the poller then touches nothing)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-auth-'));
    try {
      const file = path.join(dir, 'auth.json');
      assert.equal(readOpenCodeCredentials(file), null, 'missing');
      fs.writeFileSync(file, '{ not json');
      assert.equal(readOpenCodeCredentials(file), null, 'unreadable');
      fs.writeFileSync(file, JSON.stringify({ openrouter: { type: 'api', key: 'k' } }));
      assert.deepEqual(readOpenCodeCredentials(file), { openrouter: { kind: 'apiKey', accessToken: null, expiresAtMs: null, accountId: null } });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('parseChatGptUsageResponse', () => {
  it('both windows: the primary is the 5-hour session, the secondary the weekly one, with their reset instants', () => {
    assert.deepEqual(parseChatGptUsageResponse(bothWindows, nowMs), [
      { kind: 'session', percent: 12, resetsAt: '2026-10-17T13:00:00.000Z', scopeModel: null },
      { kind: 'weekly_all', percent: 40, resetsAt: '2026-10-22T10:00:00.000Z', scopeModel: null },
    ]);
  });

  it('a window\'s reset falls back to "after N seconds" from now, and to none', () => {
    const body = { rate_limit: { primary_window: { used_percent: 5, reset_after_seconds: 600 }, secondary_window: { used_percent: 6 } } };
    assert.deepEqual(parseChatGptUsageResponse(body, nowMs), [
      { kind: 'session', percent: 5, resetsAt: '2026-10-17T10:10:00.000Z', scopeModel: null },
      { kind: 'weekly_all', percent: 6, resetsAt: null, scopeModel: null },
    ]);
  });

  it('a weekly-only account (no primary window) yields the weekly bucket alone', () => {
    const body = { rate_limit: { primary_window: null, secondary_window: { used_percent: 70.4, limit_window_seconds: 604_800, reset_at: weeklyResetAtSeconds } } };
    assert.deepEqual(parseChatGptUsageResponse(body, nowMs).map((bucket) => [bucket.kind, bucket.percent]), [['weekly_all', 70]]);
  });

  it('a single window as long as a week is read as the weekly one, whatever place it comes in', () => {
    const body = { rate_limit: { primary_window: { used_percent: 33, limit_window_seconds: 604_800, reset_at: weeklyResetAtSeconds } } };
    assert.deepEqual(parseChatGptUsageResponse(body, nowMs).map((bucket) => [bucket.kind, bucket.percent]), [['weekly_all', 33]]);
  });

  it('a percent past the ends is clamped; an unknown shape yields no windows', () => {
    const clamped = parseChatGptUsageResponse({ rate_limit: { primary_window: { used_percent: 140 } } }, nowMs);
    assert.equal(clamped[0].percent, 100);
    assert.deepEqual(parseChatGptUsageResponse({ rate_limit: 'x' }, nowMs), []);
    assert.deepEqual(parseChatGptUsageResponse({ usage: { five_hour: 3 } }, nowMs), []);
    assert.deepEqual(parseChatGptUsageResponse(null, nowMs), []);
    assert.deepEqual(parseChatGptUsageResponse({ rate_limit: { primary_window: { used_percent: 'many' } } }, nowMs), []);
  });
});

describe('fetchChatGptUsage', () => {
  const credential: OpenCodeProviderCredential = { kind: 'subscription', accessToken: secretToken, expiresAtMs: nowMs + 3_600_000, accountId: 'acc-1' };

  function recordingFetch(answer: { status: number; body?: unknown }): { fetchImpl: UsageFetchLike; requests: Array<{ url: string; headers: Record<string, string> }> } {
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl: UsageFetchLike = async (url, init) => {
      requests.push({ url, headers: init.headers });
      return { status: answer.status, json: async () => answer.body };
    };
    return { fetchImpl, requests };
  }

  it('asks the ChatGPT endpoint with the bearer token and the account id from the record', async () => {
    const { fetchImpl, requests } = recordingFetch({ status: 200, body: bothWindows });
    const result = await fetchChatGptUsage(credential, { fetchImpl, nowMs });
    assert.equal(result.ok, true);
    assert.deepEqual(requests.map((request) => request.url), [chatGptUsageEndpoint]);
    assert.equal(requests[0].headers.Authorization, `Bearer ${secretToken}`);
    assert.equal(requests[0].headers['ChatGPT-Account-Id'], 'acc-1');
  });

  it('a record without an account id takes it from the token\'s claim; a token without one sends none', async () => {
    const claims = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-from-jwt' } })).toString('base64url');
    const withClaim = recordingFetch({ status: 200, body: bothWindows });
    await fetchChatGptUsage({ ...credential, accessToken: `h.${claims}.s`, accountId: null }, { fetchImpl: withClaim.fetchImpl, nowMs });
    assert.equal(withClaim.requests[0].headers['ChatGPT-Account-Id'], 'acc-from-jwt');
    const without = recordingFetch({ status: 200, body: bothWindows });
    await fetchChatGptUsage({ ...credential, accountId: null }, { fetchImpl: without.fetchImpl, nowMs });
    assert.equal('ChatGPT-Account-Id' in without.requests[0].headers, false);
  });

  it('a refused token is an auth error, another status a failure, a changed shape a failure — none carries the token', async () => {
    for (const [answer, expected] of [
      [{ status: 401 }, { error: 'http 401', isAuthError: true }],
      [{ status: 500 }, { error: 'http 500', isAuthError: false }],
      [{ status: 200, body: { something: 'else' } }, { error: 'no limits in the response', isAuthError: false }],
    ] as const) {
      const { fetchImpl } = recordingFetch(answer);
      const result = await fetchChatGptUsage(credential, { fetchImpl, nowMs });
      assert.deepEqual(result, { ok: false, ...expected });
      assert.ok(!JSON.stringify(result).includes(secretToken));
    }
  });

  it('a fetch that throws is a failure, never an exception', async () => {
    const result = await fetchChatGptUsage(credential, { fetchImpl: async () => { throw new Error('socket hang up'); }, nowMs });
    assert.deepEqual(result, { ok: false, error: 'socket hang up', isAuthError: false });
  });
});

describe('createOpenCodeUsagePoller', () => {
  const buckets: ClaudeUsageBucket[] = [{ kind: 'session', percent: 12, resetsAt: '2026-10-17T13:00:00.000Z', scopeModel: null }];

  function createHarness(options: {
    credentials: Record<string, OpenCodeProviderCredential> | null;
    records?: Record<string, OpenCodeProviderUsageRecord>;
    read?: (credential: OpenCodeProviderCredential) => Promise<ClaudeUsageFetchResult>;
  }) {
    const records = new Map<string, OpenCodeProviderUsageRecord>(Object.entries(options.records ?? {}));
    const saves: Array<[string, OpenCodeProviderUsageRecord]> = [];
    const logs: string[] = [];
    const reads: OpenCodeProviderCredential[] = [];
    const poller = createOpenCodeUsagePoller({
      readCredentials: () => options.credentials,
      getRecord: (providerId) => records.get(providerId),
      saveRecord: (providerId, record) => { records.set(providerId, record); saves.push([providerId, record]); },
      readers: {
        openai: async (credential) => {
          reads.push(credential);
          return options.read ? options.read(credential) : { ok: true, buckets };
        },
      },
      now: () => nowMs,
      log: (line) => logs.push(line),
    });
    return { poller, records, saves, logs, reads };
  }

  const subscription = (overrides: Partial<OpenCodeProviderCredential> = {}): OpenCodeProviderCredential => ({
    kind: 'subscription', accessToken: secretToken, expiresAtMs: nowMs + 3_600_000, accountId: 'acc-1', ...overrides,
  });
  const apiKey: OpenCodeProviderCredential = { kind: 'apiKey', accessToken: null, expiresAtMs: null, accountId: null };

  it('polls a subscription that has a reader and stores a fresh snapshot with its kind', async () => {
    const h = createHarness({ credentials: { openai: subscription() } });
    await h.poller.refreshAll();
    assert.equal(h.reads.length, 1);
    const record = h.records.get('openai');
    assert.equal(record?.authKind, 'subscription');
    assert.deepEqual(record?.usage?.buckets, buckets);
    assert.equal(record?.usage?.isStale, undefined);
  });

  it('an API key is stored as its kind alone and never polled', async () => {
    const h = createHarness({ credentials: { openrouter: apiKey } });
    await h.poller.refreshAll();
    assert.equal(h.reads.length, 0);
    assert.deepEqual(h.records.get('openrouter'), { authKind: 'apiKey' });
    await h.poller.refreshAll();
    assert.equal(h.saves.length, 1, 'an unchanged record is not rewritten');
  });

  it('a subscription of a provider with no reader is stored as a subscription with no usage', async () => {
    const h = createHarness({ credentials: { anthropic: subscription() } });
    await h.poller.refreshAll();
    assert.equal(h.reads.length, 0);
    assert.deepEqual(h.records.get('anthropic'), { authKind: 'subscription' });
  });

  it('an expired token is never sent: the last figures stay, marked stale, and the log says it once', async () => {
    const previous: OpenCodeProviderUsageRecord = { authKind: 'subscription', usage: { fetchedAt: '2026-10-17T09:00:00.000Z', source: 'api', buckets } };
    const h = createHarness({ credentials: { openai: subscription({ expiresAtMs: nowMs - 1 }) }, records: { openai: previous } });
    await h.poller.refreshAll();
    await h.poller.refreshAll();
    assert.equal(h.reads.length, 0);
    const usage = h.records.get('openai')?.usage;
    assert.equal(usage?.isStale, true);
    assert.equal(usage?.error, 'token expired');
    assert.deepEqual(usage?.buckets, buckets);
    assert.equal(h.logs.length, 1, 'the second poll finds the same reason and stays quiet');
    assert.equal(h.saves.length, 1);
  });

  it('a record without an access token is "not signed in" (stale), a failed poll keeps the figures stale with its reason', async () => {
    const noToken = createHarness({ credentials: { openai: subscription({ accessToken: null }) } });
    await noToken.poller.refreshAll();
    assert.equal(noToken.records.get('openai')?.usage?.error, 'not signed in');

    const previous: OpenCodeProviderUsageRecord = { authKind: 'subscription', usage: { fetchedAt: '2026-10-17T09:00:00.000Z', source: 'api', buckets } };
    const failing = createHarness({ credentials: { openai: subscription() }, records: { openai: previous }, read: async () => ({ ok: false, error: 'http 500', isAuthError: false }) });
    await failing.poller.refreshAll();
    assert.equal(failing.records.get('openai')?.usage?.error, 'http 500');
    assert.deepEqual(failing.records.get('openai')?.usage?.buckets, buckets);
    assert.deepEqual(failing.logs, ['[usage] OpenCode openai: usage unavailable (http 500)']);
  });

  it('a reader that throws is logged and does not stop the other providers', async () => {
    const h = createHarness({ credentials: { openai: subscription(), openrouter: apiKey }, read: async () => { throw new Error('boom'); } });
    await h.poller.refreshAll();
    assert.match(h.logs[0], /OpenCode openai: usage poll threw: boom/);
    assert.deepEqual(h.records.get('openrouter'), { authKind: 'apiKey' });
  });

  it('the token never reaches a log line', async () => {
    const h = createHarness({ credentials: { openai: subscription({ expiresAtMs: nowMs - 1 }) }, read: async () => ({ ok: false, error: 'http 401', isAuthError: true }) });
    await h.poller.refreshAll();
    for (const line of h.logs) assert.ok(!line.includes(secretToken), line);
  });

  it('an unreadable or missing auth.json touches nothing, and a provider it does not list keeps its record', async () => {
    const kept: OpenCodeProviderUsageRecord = { authKind: 'subscription', usage: { fetchedAt: '2026-10-17T09:59:30.000Z', source: 'api', buckets } };
    const gone = createHarness({ credentials: null, records: { openai: kept } });
    await gone.poller.refreshAll();
    assert.deepEqual(gone.saves, []);
    const other = createHarness({ credentials: { openrouter: apiKey }, records: { openai: kept } });
    await other.poller.refreshAll();
    assert.deepEqual(other.records.get('openai'), kept, 'a provider enabled by an environment variable (or seeded) is not erased');
  });

  it('the on-demand max-age gate skips a fresh snapshot and re-polls a stale or older one', async () => {
    const fresh: OpenCodeProviderUsageRecord = { authKind: 'subscription', usage: { fetchedAt: new Date(nowMs - 30_000).toISOString(), source: 'api', buckets } };
    const h = createHarness({ credentials: { openai: subscription() }, records: { openai: fresh } });
    await h.poller.refreshAll({ maxAgeMs: 60_000 });
    assert.equal(h.reads.length, 0, 'younger than a minute');
    await h.poller.refreshAll({ maxAgeMs: 10_000 });
    assert.equal(h.reads.length, 1, 'older than the asked age');
    await h.poller.refreshAll();
    assert.equal(h.reads.length, 2, 'the timer poll has no age gate');
  });
});
