/**
 * @description A Claude account billed to a Claude Console organization's API balance — the pure pieces of its
 * identity and sign-in:
 *
 *   • `claude auth status --json` → `billing`: a console login (`api_key` / `/login managed key`), a pasted key
 *     (`api_key_helper`) and the variable (`api_key`) are `api`, a claude.ai login is `subscription`, anything else
 *     (signed out, a cloud provider) says nothing;
 *   • the pasted key: its shape gate (only `sk-ant-api…` runs Claude Code; anything `sk-ant-…` is a secret), the
 *     `0600` file in the profile's own directory, the `apiKeyHelper` that prints it — run through `sh` as the CLI
 *     does — and the probe's inline `--settings` (only for a directory that holds a key);
 *   • the launch settings: a key profile gets ONE file of its own (the PreCompact hook AND the helper — only the last
 *     `--settings` counts), every other launch the shared hook file;
 *   • the key check against `GET /v1/models` (200 / 401 / 403 / anything else), the key in the header only;
 *   • the trace preview never records an Anthropic key, wherever it was typed;
 *   • the `/accounts` rows carry the billing.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  checkHasClaudeProfileApiKey,
  checkIsAnthropicSecretLike,
  checkIsPlausibleAnthropicApiKey,
  claudeProfileApiKeyFileName,
  claudeProfileLaunchSettingsFileName,
  extractAnthropicApiKey,
  getClaudeAuthBilling,
  parseClaudeAuthStatus,
  removeClaudeProfileApiKey,
  writeClaudeProfileApiKey,
} from '../utils/claudeProfiles';
import { buildClaudeApiKeyHelperCommand, buildClaudeAuthProbeSettingsArgs } from '../utils/claudeApiKeyHelper';
import { claudeCompactHookSettingsFileName, getHookCompactionInstruction, prepareClaudeCompactHookFlags } from '../utils/claudeCompactHook';
import { anthropicModelsEndpoint, verifyAnthropicApiKey } from '../utils/anthropicApiKeyCheck';
import { getRecvTracePreview, redactedAnthropicSecretPreview } from '../utils/recvPreviewRedaction';
import { buildAccountPickerRows } from '../utils/claudeAccountPickerPlan';
import { buildClaudeAuthLoginArgs } from '../agentLogin/agentLogin';

const apiKey = `sk-ant-api03-${'a1B2_c3-'.repeat(12)}AA`;
const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-api-account-'));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('claude auth status → billing', () => {
  it('a console login, a pasted key and the variable bill the API; a claude.ai login is the subscription', () => {
    const console = parseClaudeAuthStatus(JSON.stringify({
      loggedIn: true, authMethod: 'api_key', apiKeySource: '/login managed key', email: 'ops@example.com', orgId: 'o1', orgName: 'Example Org',
    }));
    assert.deepEqual(console, {
      loggedIn: true, email: 'ops@example.com', subscriptionType: null, orgName: 'Example Org',
      authMethod: 'api_key', apiKeySource: '/login managed key', billing: 'api',
    });
    assert.equal(parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"api_key_helper","apiKeySource":"apiKeyHelper"}')?.billing, 'api');
    assert.equal(parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"api_key","apiKeySource":"ANTHROPIC_API_KEY"}')?.billing, 'api');
    assert.equal(parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}')?.billing, 'subscription');
  });

  it('a signed-out directory or a method that names no billing says nothing', () => {
    assert.equal(parseClaudeAuthStatus('{"loggedIn":false,"authMethod":"none"}')?.billing, null);
    // A key that is configured but whose login failed is still no sign-in: nothing to record about billing.
    assert.equal(parseClaudeAuthStatus('{"loggedIn":false,"authMethod":"api_key"}')?.billing, null);
    assert.equal(getClaudeAuthBilling('third_party'), null);
    assert.equal(getClaudeAuthBilling('oauth_token'), null);
    assert.equal(getClaudeAuthBilling(null), null);
  });

  it('the sign-in of an API account is the Console login, every other one the subscription', () => {
    assert.deepEqual(buildClaudeAuthLoginArgs({ name: 'console', configDir: '/data/claude-profiles/console', billing: 'api' }), ['auth', 'login', '--console']);
    assert.deepEqual(buildClaudeAuthLoginArgs({ name: 'work', configDir: '/data/claude-profiles/work' }), ['auth', 'login', '--claudeai']);
    assert.deepEqual(buildClaudeAuthLoginArgs(null), ['auth', 'login', '--claudeai']);
  });
});

describe('a pasted API key', () => {
  it('only an API key runs Claude Code; anything that starts like an Anthropic credential is a secret', () => {
    assert.equal(checkIsPlausibleAnthropicApiKey(apiKey), true);
    assert.equal(checkIsPlausibleAnthropicApiKey(`  ${apiKey}\n`), true, 'trimmed');
    assert.equal(checkIsPlausibleAnthropicApiKey('sk-ant-admin01-AAAAAAAAAAAAAAAAAAAAAAAAAAAA'), false, 'an admin key cannot run Claude Code');
    assert.equal(checkIsPlausibleAnthropicApiKey('sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAAAAAA'), false, 'nor an OAuth token');
    assert.equal(checkIsPlausibleAnthropicApiKey(`${apiKey} please`), false, 'one token, no prose');
    assert.equal(checkIsPlausibleAnthropicApiKey('fake-oauth-code-4711'), false);
    assert.equal(checkIsAnthropicSecretLike('sk-ant-admin01-x'), true);
    assert.equal(checkIsAnthropicSecretLike(' sk-ant-whatever'), true);
    assert.equal(checkIsAnthropicSecretLike('the key starts with sk-ant-'), false);
    assert.equal(checkIsAnthropicSecretLike(`ANTHROPIC_API_KEY=${apiKey}`), true, 'copied from an env file');
    assert.equal(checkIsAnthropicSecretLike(`my key: ${apiKey}`), true, 'inside a sentence');
  });

  it('the one API key a pasted text carries is taken out of it; no key or several give nothing', () => {
    assert.equal(extractAnthropicApiKey(` ${apiKey}\n`), apiKey);
    assert.equal(extractAnthropicApiKey(`ANTHROPIC_API_KEY=${apiKey}`), apiKey);
    assert.equal(extractAnthropicApiKey(`export ANTHROPIC_API_KEY="${apiKey}"`), apiKey);
    assert.equal(extractAnthropicApiKey('sk-ant-admin01-AAAAAAAAAAAAAAAAAAAAAAAAAAAA'), null, 'an admin key cannot run Claude Code');
    assert.equal(extractAnthropicApiKey(`${apiKey} ${apiKey.replace('a1B2', 'z9Y8')}`), null, 'two keys: which one?');
    assert.equal(extractAnthropicApiKey('fake-oauth-code-4711'), null);
  });

  it('is kept 0600 in the profile\'s own directory, read back by the helper exactly as the CLI runs it, and removed with its settings', () => {
    const dir = createTempDir();
    assert.equal(checkHasClaudeProfileApiKey(dir), false);
    assert.equal(checkHasClaudeProfileApiKey(null), false, '~/.claude never holds a key of the bot');
    writeClaudeProfileApiKey(dir, ` ${apiKey} `);
    const file = path.join(dir, claudeProfileApiKeyFileName);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(checkHasClaudeProfileApiKey(dir), true);
    assert.deepEqual(fs.readdirSync(dir), [claudeProfileApiKeyFileName], 'no temp file is left behind');
    const helper = buildClaudeApiKeyHelperCommand(dir);
    assert.ok(!helper.includes(apiKey), 'the helper names the file, never the key');
    assert.equal(execFileSync('/bin/sh', ['-c', helper], { encoding: 'utf8' }).trim(), apiKey);

    fs.writeFileSync(path.join(dir, claudeProfileLaunchSettingsFileName), '{}');
    removeClaudeProfileApiKey(dir);
    assert.deepEqual(fs.readdirSync(dir), []);
    removeClaudeProfileApiKey(dir); // nothing left: no throw
  });

  it('a directory with a key quotes its path in the helper (a quote in a path cannot break out)', () => {
    const dir = path.join(createTempDir(), "it's");
    fs.mkdirSync(dir);
    writeClaudeProfileApiKey(dir, apiKey);
    assert.equal(execFileSync('/bin/sh', ['-c', buildClaudeApiKeyHelperCommand(dir)], { encoding: 'utf8' }).trim(), apiKey);
  });

  it('the status probe carries the helper only for a directory that holds a key', () => {
    const plain = createTempDir();
    assert.deepEqual(buildClaudeAuthProbeSettingsArgs(null), []);
    assert.deepEqual(buildClaudeAuthProbeSettingsArgs(plain), []);
    const keyed = createTempDir();
    writeClaudeProfileApiKey(keyed, apiKey);
    const [flag, value] = buildClaudeAuthProbeSettingsArgs(keyed);
    assert.equal(flag, '--settings');
    assert.deepEqual(JSON.parse(value), { apiKeyHelper: buildClaudeApiKeyHelperCommand(keyed) });
    assert.ok(!value.includes(apiKey));
  });
});

describe('launch settings', () => {
  it('a profile that holds a key gets ONE settings file of its own: the PreCompact hook and the helper', () => {
    const dataDir = createTempDir();
    const profileDir = createTempDir();
    writeClaudeProfileApiKey(profileDir, apiKey);
    const flags = prepareClaudeCompactHookFlags(dataDir, profileDir);
    const settingsPath = path.join(profileDir, claudeProfileLaunchSettingsFileName);
    assert.deepEqual(flags, ['--settings', settingsPath]);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(settings.apiKeyHelper, buildClaudeApiKeyHelperCommand(profileDir));
    const hook = settings.hooks.PreCompact[0].hooks[0].command;
    assert.equal(execFileSync('sh', ['-c', hook], { input: '{"trigger":"auto"}', encoding: 'utf8' }), `${getHookCompactionInstruction()}\n`);
    assert.equal(fs.statSync(settingsPath).mode & 0o777, 0o600);
    assert.ok(!fs.readFileSync(settingsPath, 'utf8').includes(apiKey), 'the settings name the key file, never the key');
    assert.equal(fs.existsSync(path.join(dataDir, claudeCompactHookSettingsFileName)), false, 'the shared file is not that launch\'s');
  });

  it('any other launch — the default account, a subscription profile — keeps the shared hook file', () => {
    const dataDir = createTempDir();
    const profileDir = createTempDir();
    const shared = path.join(dataDir, claudeCompactHookSettingsFileName);
    assert.deepEqual(prepareClaudeCompactHookFlags(dataDir, profileDir), ['--settings', shared]);
    assert.deepEqual(prepareClaudeCompactHookFlags(dataDir, null), ['--settings', shared]);
    assert.equal(JSON.parse(fs.readFileSync(shared, 'utf8')).apiKeyHelper, undefined);
  });

  it('a key profile whose directory cannot take the file still gets its key: the same settings go inline', () => {
    const dataDir = createTempDir();
    const profileDir = createTempDir();
    writeClaudeProfileApiKey(profileDir, apiKey);
    // A directory where the settings file should be blocks the rename.
    fs.mkdirSync(path.join(profileDir, claudeProfileLaunchSettingsFileName, 'x'), { recursive: true });
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const [flag, value] = prepareClaudeCompactHookFlags(dataDir, profileDir);
      assert.equal(flag, '--settings');
      assert.equal(JSON.parse(value).apiKeyHelper, buildClaudeApiKeyHelperCommand(profileDir));
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe('the key check against the API', () => {
  type FetchCall = { url: string; headers: Record<string, string> };
  function createFetch(status: number | 'throw', calls: FetchCall[]) {
    return async (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => {
      calls.push({ url, headers: init.headers });
      if (status === 'throw') throw new Error('getaddrinfo ENOTFOUND');
      return { status, json: async () => ({}) };
    };
  }

  it('200 is a working key, 401 / 403 a refused one, anything else unknown; the key rides the header only', async () => {
    const calls: FetchCall[] = [];
    assert.equal(await verifyAnthropicApiKey(apiKey, { fetchImpl: createFetch(200, calls) }), 'valid');
    assert.equal(await verifyAnthropicApiKey(apiKey, { fetchImpl: createFetch(401, calls) }), 'invalid');
    assert.equal(await verifyAnthropicApiKey(apiKey, { fetchImpl: createFetch(403, calls) }), 'invalid');
    assert.equal(await verifyAnthropicApiKey(apiKey, { fetchImpl: createFetch(529, calls) }), 'unknown');
    assert.equal(await verifyAnthropicApiKey(apiKey, { fetchImpl: createFetch('throw', calls) }), 'unknown');
    assert.equal(calls[0].url, anthropicModelsEndpoint);
    assert.ok(!calls[0].url.includes(apiKey));
    assert.equal(calls[0].headers['x-api-key'], apiKey);
    assert.equal(calls[0].headers['anthropic-version'], '2023-06-01');
  });
});

describe('the trace preview', () => {
  it('never records an Anthropic key, wherever it was typed', () => {
    assert.equal(getRecvTracePreview(apiKey, false), redactedAnthropicSecretPreview);
    assert.equal(getRecvTracePreview(`here: ${apiKey} — use it`, false), `here: ${redactedAnthropicSecretPreview} — use it`);
    assert.equal(getRecvTracePreview('sk-ant-admin01-AAAAAAAAAAAA', false), redactedAnthropicSecretPreview);
    assert.equal(getRecvTracePreview('fake-oauth-code-4711', false), 'fake-oauth-code-4711', 'an ordinary text records unchanged');
    // The regex is global: a second call must not start where the first one stopped.
    assert.equal(getRecvTracePreview(apiKey, false), redactedAnthropicSecretPreview);
  });
});

describe('/accounts rows', () => {
  it('carry the billing the record (or the default\'s status) holds', () => {
    const rows = buildAccountPickerRows({
      records: {
        work: { createdAt: '2026-10-01T00:00:00Z', loggedIn: true, email: 'work@example.com', subscriptionType: 'team' },
        console: { createdAt: '2026-10-02T00:00:00Z', loggedIn: true, email: 'ops@example.com', billing: 'api' },
      },
      defaultStatus: { loggedIn: true, email: 'me@example.com', subscriptionType: 'max', billing: 'subscription' },
      activeName: 'console',
      topicCounts: new Map(),
    });
    assert.deepEqual(rows.map((row) => [row.name, row.billing, row.isActive]), [
      ['default', 'subscription', false],
      ['work', null, false],
      ['console', 'api', true],
    ]);
  });
});
