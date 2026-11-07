/**
 * @description The daily recheck of a used-up API credit (`utils/claudeApiCreditRecheck.ts`): the request is ONE tiny POST on
 * the account's own key with a bounded timeout and no retry, read as renewed / still used up / model gone / no conclusion; an account is
 * due only while marked used up and a full interval after the later of the mark and its last attempt; a pass touches API
 * accounts only, records the attempt BEFORE the request, and logs one line for an answer it cannot read. Also the account's
 * own key (a pasted key file, else the key a Console login stored) and the API root (`ANTHROPIC_BASE_URL`).
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  checkIsClaudeApiCreditRecheckDue,
  claudeApiCreditProbeModel,
  getClaudeApiCreditProbeUrl,
  listClaudeApiCreditProfilesWithoutKey,
  probeClaudeApiCredit,
  runDueClaudeApiCreditRechecks,
  startClaudeApiCreditRechecks,
  type ClaudeApiCreditProbeFetch,
  type ClaudeApiCreditProbeOutcome,
  type ClaudeApiCreditRecheckPorts,
  type ClaudeApiCreditRecheckProfile,
} from '../utils/claudeApiCreditRecheck';
import { claudeProfileApiKeyFileName, readClaudeProfileApiKey, readDefaultClaudeProfileApiKey } from '../utils/claudeProfiles';

const apiKey = `sk-ant-api03-${'k'.repeat(40)}`;
const otherKey = `sk-ant-api03-${'o'.repeat(40)}`;
const dayMs = 24 * 3_600_000;
const nowMs = Date.parse('2026-11-08T10:00:00Z');

/** What the stand-in API answered, and the request it was asked. */
interface ProbeCall { url: string; method: string; headers: Record<string, string>; body: string; }

function createFetch(answer: { status: number; body: string } | Error): { fetchImpl: ClaudeApiCreditProbeFetch; calls: ProbeCall[] } {
  const calls: ProbeCall[] = [];
  const fetchImpl: ClaudeApiCreditProbeFetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    if (answer instanceof Error) throw answer;
    return { status: answer.status, text: async () => answer.body };
  };
  return { fetchImpl, calls };
}

const balanceBody = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } });

describe('probeClaudeApiCredit', () => {
  it('sends ONE tiny request on the key: POST /v1/messages, max_tokens 1, the cheapest model, the key in the header only', async () => {
    const { fetchImpl, calls } = createFetch({ status: 200, body: '{}' });
    const outcome = await probeClaudeApiCredit(apiKey, { url: 'https://api.example.test/v1/messages', fetchImpl });
    assert.deepEqual(outcome, { kind: 'renewed' });
    assert.equal(calls.length, 1, 'no retry');
    const [call] = calls;
    assert.equal(call.method, 'POST');
    assert.equal(call.url, 'https://api.example.test/v1/messages');
    assert.equal(call.headers['x-api-key'], apiKey);
    assert.equal(call.headers['anthropic-version'], '2023-06-01');
    const body: { model: string; max_tokens: number; messages: object[] } = JSON.parse(call.body);
    assert.deepEqual([body.model, body.max_tokens, body.messages.length], [claudeApiCreditProbeModel, 1, 1]);
    assert.ok(!call.body.includes(apiKey) && !call.url.includes(apiKey), 'the key is nowhere but the header');
  });

  it('reads a refusal for the balance as still used up — whatever the status code', async () => {
    for (const status of [400, 402, 403]) {
      assert.deepEqual(await probeClaudeApiCredit(apiKey, { url: 'http://x.test/v1/messages', fetchImpl: createFetch({ status, body: balanceBody }).fetchImpl }), { kind: 'stillUsedUp' }, String(status));
    }
  });

  it('reads a model the API no longer knows (404, or a not_found_error body) as its own outcome — not as a quiet no-conclusion', async () => {
    const gone = JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'model: claude-haiku-5-5' } });
    assert.deepEqual(await probeClaudeApiCredit(apiKey, { url: 'http://x.test/v1/messages', fetchImpl: createFetch({ status: 404, body: gone }).fetchImpl }), { kind: 'modelNotFound' });
    assert.deepEqual(await probeClaudeApiCredit(apiKey, { url: 'http://x.test/v1/messages', fetchImpl: createFetch({ status: 400, body: gone }).fetchImpl }), { kind: 'modelNotFound' }, 'by the error type, whatever the status');
    assert.deepEqual(await probeClaudeApiCredit(apiKey, { url: 'http://x.test/v1/messages', fetchImpl: createFetch({ status: 404, body: 'not found' }).fetchImpl }), { kind: 'modelNotFound' });
    // The balance wording still wins: a refused balance is an answer about the account, whatever else the body says.
    assert.deepEqual(await probeClaudeApiCredit(apiKey, { url: 'http://x.test/v1/messages', fetchImpl: createFetch({ status: 404, body: balanceBody }).fetchImpl }), { kind: 'stillUsedUp' });
  });

  it('reads any other answer as no conclusion, naming the status and nothing else — no body, no key', async () => {
    for (const [status, body] of [[401, '{"error":{"message":"invalid x-api-key"}}'], [429, 'rate limited'], [500, 'oops'], [400, '{"error":{"message":"some other problem"}}']] as const) {
      const outcome = await probeClaudeApiCredit(apiKey, { url: 'http://x.test/v1/messages', fetchImpl: createFetch({ status, body }).fetchImpl });
      assert.deepEqual(outcome, { kind: 'inconclusive', reason: `http ${status}` });
    }
  });

  it('never throws: a network failure and a timeout are no conclusion', async () => {
    assert.deepEqual(await probeClaudeApiCredit(apiKey, { fetchImpl: createFetch(new Error('ECONNREFUSED')).fetchImpl }), { kind: 'inconclusive', reason: 'network error' });
    const hanging: ClaudeApiCreditProbeFetch = (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    assert.deepEqual(await probeClaudeApiCredit(apiKey, { fetchImpl: hanging, timeoutMs: 20 }), { kind: 'inconclusive', reason: 'timeout' });
  });
});

describe('getClaudeApiCreditProbeUrl', () => {
  it('goes to the API, or to ANTHROPIC_BASE_URL — the root the account\'s sessions use — when it is a plain http(s) URL', () => {
    assert.equal(getClaudeApiCreditProbeUrl({}), 'https://api.anthropic.com/v1/messages');
    assert.equal(getClaudeApiCreditProbeUrl({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:4010/' }), 'http://127.0.0.1:4010/v1/messages');
    assert.equal(getClaudeApiCreditProbeUrl({ ANTHROPIC_BASE_URL: ' https://gateway.example.test/anthropic ' }), 'https://gateway.example.test/anthropic/v1/messages');
    for (const bad of ['', 'not a url', 'file:///etc/passwd', 'ftp://x.test']) {
      assert.equal(getClaudeApiCreditProbeUrl({ ANTHROPIC_BASE_URL: bad }), 'https://api.anthropic.com/v1/messages', JSON.stringify(bad));
    }
  });
});

describe('checkIsClaudeApiCreditRecheckDue', () => {
  const due = (creditExhaustedAt: string | null, creditRecheckedAt: string | null, at = nowMs) => checkIsClaudeApiCreditRecheckDue({ creditExhaustedAt, creditRecheckedAt, nowMs: at, intervalMs: dayMs });
  const ago = (ms: number): string => new Date(nowMs - ms).toISOString();

  it('is never due unless the account is marked used up', () => {
    assert.equal(due(null, null), false);
    assert.equal(due(null, ago(5 * dayMs)), false);
  });

  it('is due a full interval after the refusal that set the mark — the refusal is fresh news itself', () => {
    assert.equal(due(ago(dayMs - 1), null), false);
    assert.equal(due(ago(dayMs), null), true);
  });

  it('is due a full interval after the last attempt, whatever the old mark says', () => {
    assert.equal(due(ago(10 * dayMs), ago(dayMs - 1)), false, 'tried an hour short of a day ago');
    assert.equal(due(ago(10 * dayMs), ago(dayMs)), true);
  });

  it('counts a newer refusal as news that moves the day: it starts from the later of the two', () => {
    assert.equal(due(ago(3_600_000), ago(5 * dayMs)), false);
  });

  it('treats an unreadable instant as the oldest possible', () => {
    assert.equal(due('not a date', null), true);
    assert.equal(due(ago(dayMs), 'garbage'), true);
  });
});

describe('runDueClaudeApiCreditRechecks', () => {
  const markedAgo = new Date(nowMs - 2 * dayMs).toISOString();
  const profile = (overrides: Partial<ClaudeApiCreditRecheckProfile> = {}): ClaudeApiCreditRecheckProfile =>
    ({ name: 'console', billing: 'api', creditExhaustedAt: markedAgo, creditRecheckedAt: null, ...overrides });

  function createPorts(profiles: ClaudeApiCreditRecheckProfile[], probeOutcome: ClaudeApiCreditProbeOutcome = { kind: 'stillUsedUp' }) {
    const events: string[] = [];
    const keys: Record<string, string | null> = { console: apiKey, spare: otherKey, default: otherKey, nokey: null };
    const ports: ClaudeApiCreditRecheckPorts = {
      nowMs: () => nowMs,
      intervalMs: dayMs,
      listProfiles: () => profiles,
      readApiKey: (name) => keys[name] ?? null,
      probe: async (key) => {
        events.push(`probe ${key === apiKey ? 'console-key' : key === otherKey ? 'spare-key' : 'other-key'}`);
        return probeOutcome;
      },
      markRechecked: (name, atIso) => events.push(`mark ${name} ${atIso}`),
      onRenewed: (name, atIso) => events.push(`renewed ${name} ${atIso}`),
      log: (line) => events.push(`log ${line}`),
      warn: (line) => events.push(`warn ${line}`),
    };
    return { ports, events };
  }

  it('records the attempt BEFORE the request, so a hang or a crash never brings the recheck round sooner', async () => {
    const { ports, events } = createPorts([profile()]);
    await runDueClaudeApiCreditRechecks(ports);
    assert.deepEqual(events, [`mark console ${new Date(nowMs).toISOString()}`, 'probe console-key']);
  });

  it('an answer means renewed: the renewal is recorded at the attempt\'s instant', async () => {
    const { ports, events } = createPorts([profile()], { kind: 'renewed' });
    const results = await runDueClaudeApiCreditRechecks(ports);
    assert.deepEqual(results, [{ name: 'console', outcome: { kind: 'renewed' } }]);
    assert.ok(events.includes(`renewed console ${new Date(nowMs).toISOString()}`));
  });

  it('a refusal for the balance changes nothing: still used up, nothing logged', async () => {
    const { ports, events } = createPorts([profile()], { kind: 'stillUsedUp' });
    await runDueClaudeApiCreditRechecks(ports);
    assert.ok(!events.some((event) => event.startsWith('renewed') || event.startsWith('log')));
  });

  it('no conclusion is logged ONCE, with the reason and without a key', async () => {
    const { ports, events } = createPorts([profile()], { kind: 'inconclusive', reason: 'http 500' });
    await runDueClaudeApiCreditRechecks(ports);
    const logs = events.filter((event) => event.startsWith('log'));
    assert.equal(logs.length, 1);
    assert.match(logs[0], /\[credit\] console: the daily recheck gave no answer about the balance \(http 500\)/);
    assert.ok(!events.some((event) => event.startsWith('renewed')));
    assert.ok(!logs[0].includes(apiKey));
  });

  it('a model the API no longer knows is a WARNING naming the model — not an ordinary log line — and the credit is not marked renewed', async () => {
    const { ports, events } = createPorts([profile()], { kind: 'modelNotFound' });
    await runDueClaudeApiCreditRechecks(ports);
    const warnings = events.filter((event) => event.startsWith('warn'));
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes(`"${claudeApiCreditProbeModel}"`), warnings[0]);
    assert.ok(!events.some((event) => event.startsWith('renewed') || event.startsWith('log')));
  });

  it('NEVER touches a subscription account — marked used up or not, with a key or not', async () => {
    const { ports, events } = createPorts([profile({ name: 'spare', billing: 'subscription' }), profile({ name: 'unrecorded', billing: null })], { kind: 'renewed' });
    assert.deepEqual(await runDueClaudeApiCreditRechecks(ports), []);
    assert.deepEqual(events, []);
  });

  it('leaves alone an API account that is not marked and one whose day is not up', async () => {
    const { ports, events } = createPorts([
      profile({ creditExhaustedAt: null }),
      profile({ name: 'spare', creditRecheckedAt: new Date(nowMs - 3_600_000).toISOString() }),
    ]);
    assert.deepEqual(await runDueClaudeApiCreditRechecks(ports), []);
    assert.deepEqual(events, []);
  });

  it('rechecks the DEFAULT profile too when it is billed to API credits — on the key the bot reads for it', async () => {
    const { ports, events } = createPorts([profile({ name: 'default' })], { kind: 'renewed' });
    const results = await runDueClaudeApiCreditRechecks(ports);
    assert.deepEqual(results, [{ name: 'default', outcome: { kind: 'renewed' } }]);
    assert.deepEqual(events.filter((event) => event.startsWith('probe')), ['probe spare-key']);
    assert.ok(events.includes(`renewed default ${new Date(nowMs).toISOString()}`));
  });

  it('an account whose key the bot cannot read spends its day with ONE line and no request', async () => {
    const { ports, events } = createPorts([profile({ name: 'nokey' })]);
    const results = await runDueClaudeApiCreditRechecks(ports);
    assert.deepEqual(results, [{ name: 'nokey', outcome: { kind: 'noKey' } }]);
    assert.ok(events.some((event) => event.startsWith('mark nokey')), 'the day is spent');
    assert.ok(!events.some((event) => event.startsWith('probe')));
    assert.equal(events.filter((event) => event.startsWith('log')).length, 1);
  });

  it('rechecks each due API account on its OWN key, one after another', async () => {
    const { ports, events } = createPorts([profile(), profile({ name: 'spare' })]);
    await runDueClaudeApiCreditRechecks(ports);
    assert.deepEqual(events.filter((event) => event.startsWith('probe')), ['probe console-key', 'probe spare-key']);
  });
});

describe('startClaudeApiCreditRechecks', () => {
  it('runs a pass at once and then on the timer, never two at the same time, and stops', async () => {
    let passes = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    const ports: ClaudeApiCreditRecheckPorts = {
      nowMs: () => nowMs,
      intervalMs: dayMs,
      listProfiles: () => {
        passes += 1;
        return [];
      },
      readApiKey: () => null,
      probe: async () => ({ kind: 'stillUsedUp' }),
      markRechecked: () => undefined,
      onRenewed: () => undefined,
      log: () => undefined,
      warn: () => undefined,
    };
    const originalList = ports.listProfiles;
    ports.listProfiles = () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      const listed = originalList();
      concurrent -= 1;
      return listed;
    };
    const stop = startClaudeApiCreditRechecks(ports, 10);
    assert.equal(passes, 2, 'the boot look for accounts without a key, and a pass at once');
    await new Promise((resolve) => setTimeout(resolve, 60));
    stop();
    const stoppedAt = passes;
    assert.ok(stoppedAt >= 4, `the timer ran passes (${stoppedAt})`);
    assert.equal(maxConcurrent, 1);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(passes, stoppedAt, 'stopped');
  });
});

describe('the boot line for API accounts the bot can read no key for', () => {
  const profiles: ClaudeApiCreditRecheckProfile[] = [
    { name: 'default', billing: 'api', creditExhaustedAt: null, creditRecheckedAt: null },
    { name: 'console', billing: 'api', creditExhaustedAt: null, creditRecheckedAt: null },
    { name: 'work', billing: 'subscription', creditExhaustedAt: null, creditRecheckedAt: null },
  ];
  const keys: Record<string, string | null> = { default: null, console: apiKey, work: null };
  const makePorts = (lines: string[]): ClaudeApiCreditRecheckPorts => ({
    nowMs: () => nowMs,
    intervalMs: dayMs,
    listProfiles: () => profiles,
    readApiKey: (name) => keys[name] ?? null,
    probe: async () => ({ kind: 'stillUsedUp' }),
    markRechecked: () => undefined,
    onRenewed: () => undefined,
    log: (line) => lines.push(line),
    warn: (line) => lines.push(line),
  });

  it('lists the API accounts without a readable key — never a subscription account, never one with a key', () => {
    assert.deepEqual(listClaudeApiCreditProfilesWithoutKey(makePorts([])), ['default']);
  });

  it('says it ONCE at boot, naming them, and not again on the passes after', async () => {
    const lines: string[] = [];
    const stop = startClaudeApiCreditRechecks(makePorts(lines), 10);
    await new Promise((resolve) => setTimeout(resolve, 60));
    stop();
    assert.equal(lines.length, 1, lines.join(' | '));
    assert.match(lines[0], /^\[credit\] default: billed to API credits, but the bot can read no API key for it .* never rechecked$/);
  });

  it('says nothing when every API account has a key', () => {
    const lines: string[] = [];
    keys.default = apiKey;
    try {
      const stop = startClaudeApiCreditRechecks(makePorts(lines), 1_000_000);
      stop();
    } finally {
      keys.default = null;
    }
    assert.deepEqual(lines, []);
  });
});

describe('readClaudeProfileApiKey', () => {
  let dir = '';
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-profile-key-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads the pasted key file, trimmed', () => {
    fs.writeFileSync(path.join(dir, claudeProfileApiKeyFileName), `${apiKey}\n`);
    assert.equal(readClaudeProfileApiKey(dir), apiKey);
  });

  it('reads the key a Console login stored in the profile\'s own .claude.json when there is no pasted file', () => {
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'ops@example.com' }, primaryApiKey: apiKey }));
    assert.equal(readClaudeProfileApiKey(dir), apiKey);
  });

  it('prefers the pasted file over the stored one', () => {
    fs.writeFileSync(path.join(dir, claudeProfileApiKeyFileName), otherKey);
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ primaryApiKey: apiKey }));
    assert.equal(readClaudeProfileApiKey(dir), otherKey);
  });

  it('is null for a directory with no key, or with something that is not an API key (an OAuth token, an admin key, garbage, a broken file)', () => {
    assert.equal(readClaudeProfileApiKey(dir), null);
    fs.writeFileSync(path.join(dir, claudeProfileApiKeyFileName), 'sk-ant-oat01-notakey');
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ primaryApiKey: 'sk-ant-admin01-abcdefghijklmnopqrstuvwxyz' }));
    assert.equal(readClaudeProfileApiKey(dir), null);
    fs.writeFileSync(path.join(dir, '.claude.json'), '{ not json');
    assert.equal(readClaudeProfileApiKey(dir), null);
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ primaryApiKey: 42 }));
    assert.equal(readClaudeProfileApiKey(dir), null);
    assert.equal(readClaudeProfileApiKey(path.join(dir, 'missing')), null);
  });
});

describe('readDefaultClaudeProfileApiKey', () => {
  let home = '';
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-home-key-'));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('reads the primaryApiKey of the HOME .claude.json — where the CLI keeps the default profile\'s state — when its sessions run on the Console login\'s key', () => {
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ primaryApiKey: apiKey }));
    assert.equal(readDefaultClaudeProfileApiKey(true, home), apiKey);
  });

  it('is null when the sessions run on something else (an apiKeyHelper, a variable — the CLI prefers them): a stale primaryApiKey from an earlier login is a key they do not use', () => {
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ primaryApiKey: apiKey }));
    assert.equal(readDefaultClaudeProfileApiKey(false, home), null);
  });

  it('is null with no home state file, no key in it, or something that is no API key — and never reads the .claude directory\'s own files', () => {
    assert.equal(readDefaultClaudeProfileApiKey(true, home), null);
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(path.join(home, '.claude', 'charness-api-key'), apiKey);
    fs.writeFileSync(path.join(home, '.claude', '.claude.json'), JSON.stringify({ primaryApiKey: apiKey }));
    assert.equal(readDefaultClaudeProfileApiKey(true, home), null, 'the bot writes no key for the default profile; only a Console login\'s home key counts');
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: {} }));
    assert.equal(readDefaultClaudeProfileApiKey(true, home), null);
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ primaryApiKey: 'sk-ant-oat01-notakey' }));
    assert.equal(readDefaultClaudeProfileApiKey(true, home), null);
  });
});
