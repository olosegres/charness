/**
 * @description Manual session rename for the OpenCode backend
 * (`OpenCodeAdapter.renameSession`).
 *
 * Asserts the locked contract:
 *   - a live session → exactly ONE `PATCH /session/:id` carrying `{ title }`,
 *     scoped to the session's owning instance (`?directory=<workDir>`), and
 *     resolves to `null` (success);
 *   - NO live session → no PATCH, resolves to the `rename_session.*` notice;
 *   - a manual rename retires the auto-name fallback (`isAutoNamePending`
 *     flipped to `false`) so opencode's auto-title can never overwrite the
 *     user's title afterwards;
 *   - a PATCH failure resolves to the failure notice (not a throw) and STILL
 *     suppresses the fallback (the user clearly wanted a manual name).
 *
 * Harness mirrors openCodeSessionAutoname.test.ts: real adapter, the server's API
 * answered at the stubbed HTTP boundary, sessions injected via bracket access.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeAdapter } from '../adapters/openCodeAdapter';
import { keyToString, type SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { OpenCodeApiFailure, useStubbedOpenCodeServer, type OpenCodeApiRequest } from './openCodeServerStub';
import { createOpenCodeSessionFixture, getOpenCodeSession } from './openCodeSessionFixture';

const openCodeServer = useStubbedOpenCodeServer();

const sessionId = 'ses_rename_test';
const workDir = '/tmp/work/telegramCode';

/**
 * @description Build an adapter whose API requests are recorded. `shouldPatchFail`
 * makes the PATCH throw so the failure-path test can assert the notice + the
 * fallback-suppression invariant.
 */
function createRenameAdapter(shouldPatchFail = false): {
  adapter: OpenCodeAdapter;
  calls: OpenCodeApiRequest[];
} {
  const adapter = new OpenCodeAdapter();
  const calls: OpenCodeApiRequest[] = [];

  openCodeServer.answerApiWith((request) => {
    calls.push(request);
    if (request.method === 'PATCH' && shouldPatchFail) {
      throw new OpenCodeApiFailure(500, 'boom');
    }
    return undefined;
  });
  adapter['connectSse'] = () => {};

  return { adapter, calls };
}

function injectSession(adapter: OpenCodeAdapter, key: SessionKey, isAutoNamePending: boolean): void {
  adapter['sessions'].set(keyToString(key), createOpenCodeSessionFixture({
    key,
    sessionId,
    workDir,
    isModelInfoShown: true,
    isAutoNamePending,
  }));
}

const getPatches = (calls: OpenCodeApiRequest[]): OpenCodeApiRequest[] =>
  calls.filter((c) => c.method === 'PATCH' && c.urlPath.startsWith(`/session/${sessionId}`));

describe('OpenCode manual session rename', () => {
  it('PATCHes the new title scoped to the session instance and resolves null', async () => {
    const { adapter, calls } = createRenameAdapter();
    const key: SessionKey = makeTelegramKey(-100, 1);
    injectSession(adapter, key, true);

    const result = await adapter.renameSession(key, 'Refactor the auth layer');

    assert.equal(result, null, 'success resolves to null');
    const patches = getPatches(calls);
    assert.equal(patches.length, 1, 'renames exactly once');
    assert.deepEqual(patches[0].body, { title: 'Refactor the auth layer' });
    assert.ok(
      patches[0].urlPath.includes(`?directory=${encodeURIComponent(workDir)}`),
      `PATCH must be instance-scoped: "${patches[0].urlPath}"`,
    );
  });

  it('a manual rename retires the auto-name fallback (isAutoNamePending → false)', async () => {
    const { adapter } = createRenameAdapter();
    const key: SessionKey = makeTelegramKey(-100, 2);
    injectSession(adapter, key, true);

    await adapter.renameSession(key, 'Investigate the flaky CI run');

    assert.equal(
      getOpenCodeSession(adapter, keyToString(key)).isAutoNamePending,
      false,
      'auto-title fallback must never overwrite a manual rename',
    );
  });

  it('with NO active session resolves to a notice and issues no PATCH', async () => {
    const { adapter, calls } = createRenameAdapter();
    const key: SessionKey = makeTelegramKey(-100, 3); // no session injected

    const result = await adapter.renameSession(key, 'Anything');

    assert.ok(typeof result === 'string' && result.length > 0, 'returns a user-facing notice');
    assert.ok(!result.includes('{'), `notice must be fully substituted: "${result}"`);
    assert.equal(getPatches(calls).length, 0, 'no PATCH without a live session');
  });

  it('a PATCH failure resolves to a notice (no throw) and still suppresses the fallback', async () => {
    const { adapter, calls } = createRenameAdapter(true);
    const key: SessionKey = makeTelegramKey(-100, 4);
    injectSession(adapter, key, true);

    const result = await adapter.renameSession(key, 'Title that fails to save');

    assert.ok(typeof result === 'string' && result.length > 0, 'a failed PATCH returns a notice, not a throw');
    assert.equal(getPatches(calls).length, 1, 'the PATCH was attempted');
    assert.equal(
      getOpenCodeSession(adapter, keyToString(key)).isAutoNamePending,
      false,
      'a deliberate manual rename retires the fallback even when the PATCH fails',
    );
  });
});
