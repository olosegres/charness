/**
 * @description S7 lock — a NEW OpenCode session must seed its `effortLevel`
 * from the persistent per-thread pref (`loadSavedEffort(key)` at session
 * creation, openCodeAdapter.ts), so the thread's chosen reasoning effort
 * survives the session lifecycle (start / `/new`).
 *
 * This is the OpenCode counterpart of the Claude S7 fix: OpenCode is ALREADY
 * correct (it seeds at creation and applies the level per-prompt as
 * `body.variant`), so there is no code change — this test LOCKS that behavior
 * against regression.
 *
 * Harness mirrors `openCodeStartReady.test.ts`: real adapter, the server's API
 * answered at the stubbed HTTP boundary (POST /session → id; GET /config → a
 * default model so fetchModelInfo doesn't throw), `connectSse` stubbed to a no-op. The testSetup module is
 * imported FIRST so the adapter reads the seeded pref from a temp `DATA_DIR`.
 * Private members reached via bracket access.
 */
import { afterEach, describe, it } from 'node:test';
import { useStubbedOpenCodeServer } from './openCodeServerStub';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {
  effortPrefsFile,
  seededThreadKeyString,
  seededEffortLevel,
  noPrefThreadKeyString,
} from './openCodeEffortSeed.testSetup';
import { OpenCodeAdapter } from '../adapters/openCodeAdapter';
import { defaultEffortLevel, setInstanceDefaultEffortReader } from '../effortLevels';
import { keyToString, keyFromString, type SessionKey } from '../sessionKey';

const openCodeServer = useStubbedOpenCodeServer();

const newSessionId = 'ses_effort_seed';

/**
 * `GET /config/providers` reply for the stub: opus-4-8 ships the full
 * low…max variant set, so every default the bot can have lands verbatim.
 */
const providersConfigStub = {
  providers: [
    {
      id: 'anthropic',
      models: {
        'claude-opus-4-8': {
          variants: { low: {}, medium: {}, high: {}, xhigh: {}, max: {} },
        },
      },
    },
  ],
};

/**
 * @description Adapter whose lifecycle deps are stubbed: POST /session resolves
 * to a fixed id; GET /config returns a default model (so fetchModelInfo runs
 * cleanly); connectSse is a no-op (no real socket).
 */
function createStubbedAdapter(): OpenCodeAdapter {
  const adapter = new OpenCodeAdapter();
  openCodeServer.answerApiWith(({ method, urlPath }) => {
    if (method === 'POST' && (urlPath === '/session' || urlPath.startsWith('/session?'))) {
      return { id: newSessionId };
    }
    if (method === 'GET' && (urlPath === '/config/providers' || urlPath.startsWith('/config/providers?'))) {
      return providersConfigStub;
    }
    if (method === 'GET' && (urlPath === '/config' || urlPath.startsWith('/config?'))) {
      return { defaultModel: { providerID: 'anthropic', modelID: 'claude-opus-4-8' } };
    }
    return undefined;
  });
  adapter['connectSse'] = () => {};
  return adapter;
}

/** Bounded wait for the started session to appear in the private map. */
async function waitForSession(adapter: OpenCodeAdapter, keyStr: string): Promise<unknown> {
  for (let turn = 0; turn < 200; turn++) {
    const session = adapter['sessions'].get(keyStr);
    if (session) return session;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return undefined;
}

describe('OpenCode new session seeds effort from the saved pref (S7 lock)', () => {
  it('a fresh startSession carries effortLevel from the on-disk per-thread pref', async () => {
    const key: SessionKey = keyFromString(seededThreadKeyString);
    const adapter = createStubbedAdapter();

    void adapter.startSession(key, '/tmp/work');
    const session = await waitForSession(adapter, keyToString(key));

    assert.ok(session, 'session must be created');
    // Load-bearing: proves `effortLevel: loadSavedEffort(key)` at creation —
    // not just that a session exists. A regression (seeding null) fails here.
    assert.equal(
      (session as { effortLevel: string | null }).effortLevel,
      seededEffortLevel,
      'a new session must inherit the thread\'s stored effort so it survives /new',
    );
  });

  it('a fresh startSession with NO pref seeds the clamped default (medium, as no settings.json says otherwise)', async () => {
    const key: SessionKey = keyFromString(noPrefThreadKeyString);
    const adapter = createStubbedAdapter();

    void adapter.startSession(key, '/tmp/work');
    const session = await waitForSession(adapter, keyToString(key));

    assert.ok(session, 'session must be created');
    // Load-bearing: with no on-disk pref the session must seed the bot's
    // default effort, clamped to the resolved model's variants. opus-4-8 ships
    // medium (providersConfigStub), so the default lands verbatim. A regression
    // (no default applied → null) fails here.
    assert.equal(
      (session as { effortLevel: string | null }).effortLevel,
      defaultEffortLevel,
      'a new session with no explicit pref must seed the clamped default',
    );
  });
  describe('the instance default (settings.json) and «as in General»', () => {
    afterEach(() => {
      setInstanceDefaultEffortReader(() => null);
      // The «clear» test removes the seeded thread's pick; put the fixture back for whatever runs after.
      fs.writeFileSync(effortPrefsFile, JSON.stringify({ [seededThreadKeyString]: seededEffortLevel }));
    });

    it('a no-pref session seeds the INSTANCE default, clamped to the model\'s variants', async () => {
      setInstanceDefaultEffortReader(() => 'max');
      const key: SessionKey = keyFromString(noPrefThreadKeyString);
      const adapter = createStubbedAdapter();

      void adapter.startSession(key, '/tmp/work');
      const session = await waitForSession(adapter, keyToString(key));

      assert.equal((session as { effortLevel: string | null }).effortLevel, 'max');
    });

    it('a session whose model lacks the instance default runs the nearest variant it has', async () => {
      setInstanceDefaultEffortReader(() => 'ultracode');
      const key: SessionKey = keyFromString(noPrefThreadKeyString);
      const adapter = createStubbedAdapter();

      void adapter.startSession(key, '/tmp/work');
      const session = await waitForSession(adapter, keyToString(key));

      // `ultracode` is Claude-only and has no rank: the model gets what it can take, never an unknown variant.
      assert.notEqual((session as { effortLevel: string | null }).effortLevel, 'ultracode');
    });

    it('clearing a pick on a live session drops it and takes the clamped instance default for the next prompt', async () => {
      setInstanceDefaultEffortReader(() => 'low');
      const key: SessionKey = keyFromString(seededThreadKeyString);
      const adapter = createStubbedAdapter();
      void adapter.startSession(key, '/tmp/work');
      const session = (await waitForSession(adapter, keyToString(key))) as { effortLevel: string | null };
      assert.equal(session.effortLevel, seededEffortLevel, 'precondition: the live session runs the thread\'s own pick');
      assert.equal(adapter.getOwnEffort(key), seededEffortLevel);

      assert.equal(await adapter.clearEffort(key), null);

      assert.equal(adapter.getOwnEffort(key), null, 'the pick is gone from disk');
      assert.equal(session.effortLevel, 'low', 'the live session follows the instance default');
      assert.equal(adapter.getEffort(key), 'low', 'getEffort answers with the level in force; getOwnEffort says it is no pick');
    });
  });
});
