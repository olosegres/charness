/**
 * @description Bot-side fallback rename for untitled OpenCode sessions (R1
 * safety net). Primary naming is opencode's own LLM auto-title (verified live);
 * this fallback only steps in when auto-title never landed (title still the
 * bare placeholder after a grace period).
 *
 * Asserts the plan's R2-style contract, adapted to the R1-gated design:
 *   - first MEANINGFUL prompt of an untitled session → exactly ONE
 *     GET /session/:id then ONE PATCH /session/:id with the raw-text snippet
 *     (when the title is still the placeholder);
 *   - a trivial prompt before it issues NO GET/PATCH and keeps the session
 *     eligible for the next meaningful one;
 *   - an auto-titled session (real name returned by the GET) is left alone
 *     (no PATCH);
 *   - an explicit `/opencode args` session is never eligible (no GET/PATCH).
 *
 * Harness mirrors openCodeStartReady.test.ts: real adapter, the server's API
 * answered at the stubbed HTTP boundary, sessions injected via bracket access.
 * The grace delay is forced to 0 so the fallback runs on the next macrotask.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeAdapter } from '../adapters/openCodeAdapter';
import { keyToString, type SessionKey } from '../sessionKey';
import {
  buildThreadContextPreamble,
  prependThreadContextPreamble,
} from '../threadContextPreamble';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { useStubbedOpenCodeServer, type OpenCodeApiRequest } from './openCodeServerStub';
import { createOpenCodeSessionFixture, getOpenCodeSession } from './openCodeSessionFixture';

const openCodeServer = useStubbedOpenCodeServer();

const sessionId = 'ses_autoname_test';

/**
 * @description Build an adapter whose API requests are recorded + the GET title
 * caller-controlled, sessions injectable, grace forced to 0. Returns the
 * recorded call log so a test can assert exactly which requests fired.
 */
function createNamingAdapter(getTitle: string | undefined): {
  adapter: OpenCodeAdapter;
  calls: OpenCodeApiRequest[];
} {
  const adapter = new OpenCodeAdapter();
  const calls: OpenCodeApiRequest[] = [];

  openCodeServer.answerApiWith((request) => {
    calls.push(request);
    if (request.method === 'GET' && request.urlPath === `/session/${sessionId}`) {
      return { id: sessionId, title: getTitle };
    }
    // prompt_async (204) / PATCH (ok) — nothing meaningful to return.
    return undefined;
  });
  adapter['connectSse'] = () => {};
  adapter['fallbackRenameGraceMs'] = 0;

  return { adapter, calls };
}

function injectSession(adapter: OpenCodeAdapter, key: SessionKey, isAutoNamePending: boolean): void {
  adapter['sessions'].set(keyToString(key), createOpenCodeSessionFixture({
    key,
    sessionId,
    workDir: '/tmp/work',
    isModelInfoShown: true,
    isAutoNamePending,
  }));
}

/** Drain enough macrotask turns for the grace-0 fallback (GET then PATCH) to run. */
async function drain(): Promise<void> {
  for (let turn = 0; turn < 50; turn++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const getCalls = (calls: OpenCodeApiRequest[], method: string, prefix: string): OpenCodeApiRequest[] =>
  calls.filter((c) => c.method === method && c.urlPath.startsWith(prefix));

describe('OpenCode fallback session naming', () => {
  it('first meaningful prompt PATCHes the raw snippet when the title is still the placeholder', async () => {
    const { adapter, calls } = createNamingAdapter('New session - 2026-06-04T19:07:28.705Z');
    const key: SessionKey = makeTelegramKey(-100, 1);
    injectSession(adapter, key, true);

    adapter.sendInput(key, 'Investigate the broken OAuth redirect on staging');
    await drain();

    const gets = getCalls(calls, 'GET', `/session/${sessionId}`);
    const patches = getCalls(calls, 'PATCH', `/session/${sessionId}`);
    assert.equal(gets.length, 1, 'reads the live title once');
    assert.equal(patches.length, 1, 'renames exactly once');
    assert.deepEqual(patches[0].body, { title: 'Investigate the broken OAuth redirect on staging' });
    // Eligibility consumed — no second attempt on later prompts.
    assert.equal(getOpenCodeSession(adapter, keyToString(key)).isAutoNamePending, false);
  });

  it('renames from the RAW user text — the glued thread-context preamble never leaks into the title', async () => {
    const { adapter, calls } = createNamingAdapter('New session - 2026-06-04T19:07:28.705Z');
    const key: SessionKey = makeTelegramKey(-100, 2);
    injectSession(adapter, key, true);

    const preamble = buildThreadContextPreamble({ key, subdir: 'telegramCode' });
    const userText = 'Add pagination to the users list endpoint';
    adapter.sendInput(key, prependThreadContextPreamble(preamble, userText));
    await drain();

    const patches = getCalls(calls, 'PATCH', `/session/${sessionId}`);
    assert.equal(patches.length, 1);
    assert.deepEqual(patches[0].body, { title: userText }, 'title is the raw prompt, no preamble');
  });

  it('a trivial prompt does NOT rename and leaves the session eligible for a later meaningful one', async () => {
    const { adapter, calls } = createNamingAdapter('New session - 2026-06-04T19:07:28.705Z');
    const key: SessionKey = makeTelegramKey(-100, 3);
    injectSession(adapter, key, true);

    adapter.sendInput(key, 'да');
    await drain();

    assert.equal(getCalls(calls, 'GET', `/session/${sessionId}`).length, 0, 'no title read for a trivial prompt');
    assert.equal(getCalls(calls, 'PATCH', `/session/${sessionId}`).length, 0, 'no rename for a trivial prompt');
    assert.equal(
      getOpenCodeSession(adapter, keyToString(key)).isAutoNamePending,
      true,
      'still eligible — a later meaningful prompt should name it',
    );

    // Now a meaningful follow-up DOES rename.
    adapter.sendInput(key, 'Fix the failing checkout when the cart is empty');
    await drain();
    assert.equal(getCalls(calls, 'PATCH', `/session/${sessionId}`).length, 1, 'the meaningful follow-up renames');
  });

  it('leaves a session that opencode already auto-titled alone (no PATCH)', async () => {
    // GET returns a real LLM name — the fallback must NOT overwrite it.
    const { adapter, calls } = createNamingAdapter('Debug broken Node login flow');
    const key: SessionKey = makeTelegramKey(-100, 4);
    injectSession(adapter, key, true);

    adapter.sendInput(key, 'Investigate the broken OAuth redirect on staging');
    await drain();

    assert.equal(getCalls(calls, 'GET', `/session/${sessionId}`).length, 1, 'reads the title to decide');
    assert.equal(getCalls(calls, 'PATCH', `/session/${sessionId}`).length, 0, 'real auto-title is preserved');
  });

  it('never renames an explicit `/opencode args` session (not eligible)', async () => {
    const { adapter, calls } = createNamingAdapter('New session - 2026-06-04T19:07:28.705Z');
    const key: SessionKey = makeTelegramKey(-100, 5);
    injectSession(adapter, key, false); // args session: isAutoNamePending = false

    adapter.sendInput(key, 'Investigate the broken OAuth redirect on staging');
    await drain();

    assert.equal(getCalls(calls, 'GET', `/session/${sessionId}`).length, 0, 'no title read for an args session');
    assert.equal(getCalls(calls, 'PATCH', `/session/${sessionId}`).length, 0, 'an explicit-title session is never auto-renamed');
  });
});
