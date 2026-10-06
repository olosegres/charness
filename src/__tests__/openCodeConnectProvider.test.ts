/**
 * Test case: N/A — Charness has no Jira tracker
 *
 * @description OpenCode provider API-key connection through `/connect`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  OpenCodeAdapter,
  buildProviderApiAuthPayload,
  buildProviderAuthPath,
  checkIsValidProviderId,
} from '../adapters/openCodeAdapter';
import type { SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { useStubbedOpenCodeServer, type JsonValue, type OpenCodeApiRequest } from './openCodeServerStub';

const openCodeServer = useStubbedOpenCodeServer();

function createConnectAdapter(providerAuth: JsonValue, providers: JsonValue = { all: [] }): {
  adapter: OpenCodeAdapter;
  calls: OpenCodeApiRequest[];
} {
  const adapter = new OpenCodeAdapter();
  const calls: OpenCodeApiRequest[] = [];

  adapter['ensureProviderAuthServerReady'] = async () => {};
  openCodeServer.answerApiWith((request) => {
    calls.push(request);
    if (request.method === 'GET' && request.urlPath === '/provider/auth') return providerAuth;
    if (request.method === 'GET' && request.urlPath === '/provider') return providers;
    if (request.method === 'PUT') return undefined;
    throw new Error(`unexpected call ${request.method} ${request.urlPath}`);
  });

  return { adapter, calls };
}

describe('OpenCode provider connect helpers', () => {
  it('builds the API-key auth route and body without leaking the key into the URL', () => {
    assert.equal(buildProviderAuthPath('openai'), '/auth/openai');
    assert.equal(buildProviderAuthPath('github-copilot'), '/auth/github-copilot');
    assert.deepEqual(buildProviderApiAuthPayload('sk-test-secret'), {
      type: 'api',
      key: 'sk-test-secret',
    });
  });

  it('accepts only provider ids that are safe path segments', () => {
    assert.equal(checkIsValidProviderId('openai'), true);
    assert.equal(checkIsValidProviderId('github-copilot'), true);
    assert.equal(checkIsValidProviderId('cloudflare_workers'), true);
    assert.equal(checkIsValidProviderId('wafer.ai'), true);
    assert.equal(checkIsValidProviderId('../openai'), false);
    assert.equal(checkIsValidProviderId('OpenAI'), false);
    assert.equal(checkIsValidProviderId(''), false);
  });

});

describe('OpenCodeAdapter.connectProvider', () => {
  const key: SessionKey = makeTelegramKey(-100, 4242);

  it('checks provider auth support then PUTs the API-key auth payload', async () => {
    const { adapter, calls } = createConnectAdapter({
      openai: [{ type: 'api', label: 'Manually enter API Key' }],
    });

    const result = await adapter.connectProvider(key, 'openai', ' sk-test-secret ');

    assert.equal(result, null);
    assert.deepEqual(calls, [
      { method: 'GET', urlPath: '/provider/auth', body: undefined },
      {
        method: 'PUT',
        urlPath: '/auth/openai',
        body: { type: 'api', key: 'sk-test-secret' },
      },
    ]);
  });

  it('does not PUT when the provider requires extra auth prompts', async () => {
    const { adapter, calls } = createConnectAdapter({ gitlab: [{ type: 'api', prompts: [{ key: 'instanceUrl' }] }] });

    const result = await adapter.connectProvider(key, 'gitlab', 'glpat-test-secret');

    assert.ok(typeof result === 'string' && result.includes('gitlab'));
    assert.deepEqual(calls, [{ method: 'GET', urlPath: '/provider/auth', body: undefined }]);
  });

  it('connects an ordinary API-key provider from the full OpenCode catalog', async () => {
    const { adapter, calls } = createConnectAdapter(
      { openai: [{ type: 'api', label: 'Manually enter API Key' }] },
      { all: [{ id: 'openrouter' }] },
    );

    const result = await adapter.connectProvider(key, 'openrouter', 'sk-or-test-secret');

    assert.equal(result, null);
    assert.deepEqual(calls, [
      { method: 'GET', urlPath: '/provider/auth', body: undefined },
      { method: 'GET', urlPath: '/provider', body: undefined },
      {
        method: 'PUT',
        urlPath: '/auth/openrouter',
        body: { type: 'api', key: 'sk-or-test-secret' },
      },
    ]);
  });

  it('does not store a key for an unknown provider', async () => {
    const { adapter, calls } = createConnectAdapter({}, { all: [{ id: 'openrouter' }] });

    const result = await adapter.connectProvider(key, 'not-a-provider', 'sk-test-secret');

    assert.ok(typeof result === 'string' && result.includes('not-a-provider'));
    assert.deepEqual(calls, [
      { method: 'GET', urlPath: '/provider/auth', body: undefined },
      { method: 'GET', urlPath: '/provider', body: undefined },
    ]);
  });

  it('rejects an unsafe provider id before any OpenCode request', async () => {
    const { adapter, calls } = createConnectAdapter({ openai: [{ type: 'api' }] });

    const result = await adapter.connectProvider(key, '../openai', 'sk-test-secret');

    assert.ok(typeof result === 'string' && result.length > 0);
    assert.equal(calls.length, 0);
  });
});
