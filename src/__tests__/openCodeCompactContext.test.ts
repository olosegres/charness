/**
 * @description Server-side context compaction for the OpenCode backend
 * (`OpenCodeAdapter.compactContext`).
 *
 * This is the fix for the `/compact` no-op: the command used to be forwarded as
 * ordinary prompt text to `POST /session/:id/prompt_async`, which does NO
 * slash-command parsing server-side — so the model answered the literal
 * "/compact" and nothing was compacted. Real compaction is the separate
 * `summarize` endpoint, which REQUIRES an explicit model.
 *
 * Asserts the locked contract:
 *   - a live session → exactly ONE `POST /session/:id/summarize`, scoped to the
 *     session's owning instance (`?directory=<workDir>`), carrying a complete
 *     `{ providerID, modelID }` and NO `auto` flag (manual compaction), and
 *     resolves `{ ok: true }` with `null` token counts — `/summarize` reports
 *     none, and inventing `0` would make the bot print a bogus `0 → 0 tokens`;
 *   - NO live session → no POST at all, resolves the failing `compact.*` notice;
 *   - a model resolvable ONLY through the server default (`GET /config`) still
 *     produces complete ids — never a partial/empty ref;
 *   - no resolvable model at all → a notice and NO POST;
 *   - a POST rejection resolves to the failure notice (not a throw).
 *
 * Harness mirrors openCodeRenameSession.test.ts: real adapter, the server's API
 * answered at the stubbed HTTP boundary, sessions injected via bracket access.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeAdapter } from '../adapters/openCodeAdapter';
import type { CompactionResult } from '../types';
import { keyToString, type SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { OpenCodeApiFailure, useStubbedOpenCodeServer, type OpenCodeApiRequest } from './openCodeServerStub';
import { createOpenCodeSessionFixture } from './openCodeSessionFixture';

const openCodeServer = useStubbedOpenCodeServer();

const sessionId = 'ses_compact_test';
const workDir = '/tmp/work/telegramCode';

/** The model the stubbed `GET /config` reports as the server default. */
const serverDefaultModel = { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' };

/** The per-session override, distinct from the server default so they can't be confused. */
const sessionOverrideModel = { providerID: 'openrouter', modelID: 'z-ai/glm-4.8' };

/**
 * @description Build an adapter whose API requests are recorded. `shouldPostFail`
 * makes the summarize POST throw so the failure path can be asserted;
 * `configDefaultModel` is what a `GET /config` lookup reports (`null` = a server
 * that declares no default model at all).
 */
function createCompactAdapter(options: {
  shouldPostFail?: boolean;
  configDefaultModel?: { providerID: string; modelID: string } | null;
} = {}): { adapter: OpenCodeAdapter; calls: OpenCodeApiRequest[] } {
  const adapter = new OpenCodeAdapter();
  const calls: OpenCodeApiRequest[] = [];
  const configDefaultModel = options.configDefaultModel === undefined
    ? serverDefaultModel
    : options.configDefaultModel;

  openCodeServer.answerApiWith((request) => {
    calls.push(request);
    if (request.method === 'POST' && options.shouldPostFail) {
      throw new OpenCodeApiFailure(500, 'boom');
    }
    if (request.method === 'GET' && request.urlPath.startsWith('/config')) {
      return configDefaultModel ? { defaultModel: configDefaultModel } : {};
    }
    return undefined;
  });
  adapter['connectSse'] = () => {};

  return { adapter, calls };
}

function injectSession(
  adapter: OpenCodeAdapter,
  key: SessionKey,
  modelOverride: { providerID: string; modelID: string } | null,
): void {
  adapter['sessions'].set(keyToString(key), createOpenCodeSessionFixture({
    key,
    sessionId,
    workDir,
    isModelInfoShown: true,
    modelOverride,
  }));
}

const getSummarizePosts = (calls: OpenCodeApiRequest[]): OpenCodeApiRequest[] =>
  calls.filter((c) => c.method === 'POST' && c.urlPath.startsWith(`/session/${sessionId}/summarize`));

/** The user-facing text of a failure result; fails the case when it is a success. */
function getError(result: CompactionResult): string {
  if (result.ok) {
    assert.fail(`expected a failure result, got success (pre=${result.preTokens} post=${result.postTokens})`);
  }
  return result.error;
}

describe('OpenCode context compaction', () => {
  it('POSTs summarize scoped to the session instance with the session model and reports success with no counts', async () => {
    const { adapter, calls } = createCompactAdapter();
    const key: SessionKey = makeTelegramKey(-100, 1);
    injectSession(adapter, key, sessionOverrideModel);

    const result = await adapter.compactContext(key);

    // OpenCode's `/summarize` reports no token counts, so a success must degrade
    // them to `null` — the bot then posts its completion sentence WITHOUT numbers
    // rather than printing a fabricated `0 → 0`.
    assert.deepEqual(result, { ok: true, preTokens: null, postTokens: null }, 'success, counts unknown');
    const posts = getSummarizePosts(calls);
    assert.equal(posts.length, 1, 'compacts exactly once');
    assert.deepEqual(posts[0].body, {
      providerID: sessionOverrideModel.providerID,
      modelID: sessionOverrideModel.modelID,
    });
    assert.ok(
      posts[0].urlPath.includes(`?directory=${encodeURIComponent(workDir)}`),
      `POST must be instance-scoped: "${posts[0].urlPath}"`,
    );
    // A manual compaction must not claim to be the automatic (overflow) one.
    assert.ok(
      !Object.prototype.hasOwnProperty.call(posts[0].body as object, 'auto'),
      'a manual compaction must not send `auto`',
    );
    // The prompt transport is exactly what this fix stops using for /compact.
    assert.equal(
      calls.filter((c) => c.urlPath.includes('prompt_async')).length,
      0,
      '/compact must never be sent as a prompt',
    );
  });

  it('falls back to the server default model when the session carries no override', async () => {
    const { adapter, calls } = createCompactAdapter();
    const key: SessionKey = makeTelegramKey(-100, 2);
    injectSession(adapter, key, null);

    const result = await adapter.compactContext(key);

    assert.deepEqual(result, { ok: true, preTokens: null, postTokens: null }, 'success, counts unknown');
    const posts = getSummarizePosts(calls);
    assert.equal(posts.length, 1, 'compacts exactly once');
    assert.deepEqual(posts[0].body, serverDefaultModel, 'ids come from the server default');
    const { providerID, modelID } = posts[0].body as { providerID: string; modelID: string };
    assert.ok(providerID.length > 0 && modelID.length > 0, 'never a partial model ref');
  });

  it('with NO resolvable model resolves to a notice and issues no POST', async () => {
    const { adapter, calls } = createCompactAdapter({ configDefaultModel: null });
    const key: SessionKey = makeTelegramKey(-100, 3);
    injectSession(adapter, key, null);

    const result = await adapter.compactContext(key);

    assert.equal(result.ok, false, 'an unresolvable model is a FAILURE result');
    const error = getError(result);
    assert.ok(error.length > 0, 'returns a user-facing notice');
    assert.ok(!error.includes('{'), `notice must be fully substituted: "${error}"`);
    assert.equal(getSummarizePosts(calls).length, 0, 'no POST without a complete model ref');
  });

  it('with NO active session resolves to a notice and issues no request at all', async () => {
    const { adapter, calls } = createCompactAdapter();
    const key: SessionKey = makeTelegramKey(-100, 4); // no session injected

    const result = await adapter.compactContext(key);

    assert.equal(result.ok, false, 'no live session is a FAILURE result');
    const error = getError(result);
    assert.ok(error.length > 0, 'returns a user-facing notice');
    assert.ok(!error.includes('{'), `notice must be fully substituted: "${error}"`);
    assert.equal(calls.length, 0, 'no HTTP call without a live session');
  });

  it('a POST failure resolves to a notice (no throw) and names the reason', async () => {
    const { adapter, calls } = createCompactAdapter({ shouldPostFail: true });
    const key: SessionKey = makeTelegramKey(-100, 5);
    injectSession(adapter, key, sessionOverrideModel);

    const result = await adapter.compactContext(key);

    assert.equal(result.ok, false, 'a failed POST is a FAILURE result, not a throw');
    const error = getError(result);
    assert.ok(!error.includes('{'), `notice must be fully substituted: "${error}"`);
    assert.ok(error.includes('500 boom'), `the failure reason must reach the user: "${error}"`);
    assert.equal(getSummarizePosts(calls).length, 1, 'the POST was attempted');
  });
});
