/**
 * Test case: N/A — TelegramCode has no Jira tracker
 *
 * @description OpenCode provider disconnect through `/disconnect`.
 *
 * The interesting half is what happens AFTER the delete: `DELETE /auth/:id`
 * only clears OpenCode's own credential store, so the adapter re-reads
 * `GET /config/providers` and must report the honest outcome — a provider
 * OpenCode enables from an environment variable (`openrouter` ←
 * `OPENROUTER_API_KEY`) is still fully active and must NOT be announced as
 * disconnected.
 *
 * Mirrors `openCodeConnectProvider.test.ts`'s stubbed-`apiRequest` harness.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeAdapter, resetOpenCodeProviderCaches } from '../adapters/openCodeAdapter';
import type { SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';

interface ApiCall {
  method: string;
  urlPath: string;
}

/**
 * @param activeProvidersAfterDelete provider ids `GET /config/providers`
 *   reports once the credentials are gone — the env-var providers.
 */
function createDisconnectAdapter(activeProvidersAfterDelete: string[]): {
  adapter: OpenCodeAdapter;
  calls: ApiCall[];
} {
  // The providers cache is module-level: a neighbouring case's response would
  // otherwise be served instead of this one's.
  resetOpenCodeProviderCaches();
  const adapter = new OpenCodeAdapter();
  const calls: ApiCall[] = [];

  adapter['ensureProviderAuthServerReady'] = async () => {};
  adapter['apiRequest'] = async (method: string, urlPath: string) => {
    calls.push({ method, urlPath });
    if (method === 'DELETE') return undefined;
    if (method === 'GET' && urlPath === '/config/providers') {
      return {
        providers: activeProvidersAfterDelete.map((id) => ({ id, models: { 'some-model': {} } })),
      };
    }
    throw new Error(`unexpected call ${method} ${urlPath}`);
  };

  return { adapter, calls };
}

describe('OpenCodeAdapter.disconnectProvider', () => {
  const key: SessionKey = makeTelegramKey(-100, 9085);

  it('DELETEs the provider auth route and reports a clean disconnect', async () => {
    const { adapter, calls } = createDisconnectAdapter(['anthropic']);

    const result = await adapter.disconnectProvider(key, 'openai');

    assert.equal(result, null, 'null is the clean-disconnect signal');
    assert.deepEqual(calls, [
      { method: 'DELETE', urlPath: '/auth/openai' },
      { method: 'GET', urlPath: '/config/providers' },
    ]);
  });

  it('reports the env-var caveat when the provider survives the delete', async () => {
    // THE openrouter case — credentials removed, provider still serving models.
    const { adapter } = createDisconnectAdapter(['anthropic', 'openrouter']);

    const result = await adapter.disconnectProvider(key, 'openrouter');

    assert.ok(typeof result === 'string' && result.length > 0, 'a notice, not silent success');
    assert.ok(result.includes('openrouter'), 'the notice names the provider');
    assert.ok(
      /environment variable/i.test(result),
      `the notice must explain WHY it is still active, got: ${result}`,
    );
  });

  it('normalizes the provider id before deleting', async () => {
    const { adapter, calls } = createDisconnectAdapter([]);

    const result = await adapter.disconnectProvider(key, '  OpenRouter  ');

    assert.equal(result, null);
    assert.deepEqual(calls[0], { method: 'DELETE', urlPath: '/auth/openrouter' });
  });

  it('rejects an unsafe provider id before any OpenCode request', async () => {
    // Same path-segment guard `/connect` uses — the id lands in a URL.
    const { adapter, calls } = createDisconnectAdapter([]);

    const result = await adapter.disconnectProvider(key, '../openai');

    assert.ok(typeof result === 'string' && result.length > 0);
    assert.equal(calls.length, 0);
  });

  it('surfaces a server failure instead of claiming success', async () => {
    resetOpenCodeProviderCaches();
    const adapter = new OpenCodeAdapter();
    adapter['ensureProviderAuthServerReady'] = async () => {};
    adapter['apiRequest'] = async () => {
      throw new Error('OpenCode server not available');
    };

    const result = await adapter.disconnectProvider(key, 'openai');

    assert.ok(typeof result === 'string' && result.includes('openai'));
    assert.ok(result.includes('OpenCode server not available'));
  });
});
