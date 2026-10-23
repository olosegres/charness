/**
 * @description Whether a pasted Anthropic API key is accepted by the API, before the bot stores it for an API-billed
 * Claude account (`utils/claudeProfiles.ts`). One `GET /v1/models` — it lists models and costs nothing: `200` is a
 * working key, `401` / `403` a key the API refuses (revoked, mistyped, another kind of credential), anything else —
 * a timeout, a 5xx, no network — says nothing about the key (`unknown`: the caller stores it and says it could not
 * check). A key with no credits left still lists models: the balance shows only on the first real request.
 *
 * The key travels only in the request's `x-api-key` header; it is never logged and never part of the result.
 */

import type { UsageFetchLike } from './claudeUsage';

export const anthropicModelsEndpoint = 'https://api.anthropic.com/v1/models?limit=1';

/** The API version header every Anthropic API request carries. */
const anthropicApiVersion = '2023-06-01';

export const anthropicApiKeyCheckTimeoutMs = 15_000;

export type AnthropicApiKeyCheck = 'valid' | 'invalid' | 'unknown';

/** @description Ask the API whether `apiKey` works (see the module). Never throws. */
export async function verifyAnthropicApiKey(
  apiKey: string,
  options: { fetchImpl?: UsageFetchLike; timeoutMs?: number } = {},
): Promise<AnthropicApiKeyCheck> {
  const fetchImpl: UsageFetchLike = options.fetchImpl ?? (globalThis.fetch as unknown as UsageFetchLike);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? anthropicApiKeyCheckTimeoutMs);
  try {
    const response = await fetchImpl(anthropicModelsEndpoint, {
      headers: { 'x-api-key': apiKey, 'anthropic-version': anthropicApiVersion, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (response.status === 200) return 'valid';
    if (response.status === 401 || response.status === 403) return 'invalid';
    return 'unknown';
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timer);
  }
}
