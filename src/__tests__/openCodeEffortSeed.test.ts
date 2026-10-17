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
  modelPrefsFile,
  seededThreadKeyString,
  seededEffortLevel,
  noPrefThreadKeyString,
} from './openCodeEffortSeed.testSetup';
import { buildPromptBody, OpenCodeAdapter, resetOpenCodeProviderCaches } from '../adapters/openCodeAdapter';
import { defaultEffortLevel, setInstanceDefaultEffortReader } from '../effortLevels';
import { keyToString, keyFromString, type SessionKey } from '../sessionKey';

const openCodeServer = useStubbedOpenCodeServer();

const newSessionId = 'ses_effort_seed';

/**
 * `GET /config/providers` reply for the stub: opus-4-8 ships the full
 * low…max variant set, so every default the bot can have lands verbatim.
 */
function createProvidersConfigStub(variantNames: readonly string[]) {
  return {
    providers: [
      {
        id: 'anthropic',
        models: {
          'claude-opus-4-8': {
            variants: Object.fromEntries(variantNames.map((variantName) => [variantName, {}])),
          },
        },
      },
    ],
  };
}

const fullVariantNames = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * @description Adapter whose lifecycle deps are stubbed: POST /session resolves
 * to a fixed id; GET /config returns a default model (so fetchModelInfo runs
 * cleanly); connectSse is a no-op (no real socket).
 */
function createStubbedAdapter(variantNames: readonly string[] = fullVariantNames): OpenCodeAdapter {
  resetOpenCodeProviderCaches();
  const adapter = new OpenCodeAdapter();
  openCodeServer.answerApiWith(({ method, urlPath }) => {
    if (method === 'POST' && (urlPath === '/session' || urlPath.startsWith('/session?'))) {
      return { id: newSessionId };
    }
    if (method === 'GET' && (urlPath === '/config/providers' || urlPath.startsWith('/config/providers?'))) {
      return createProvidersConfigStub(variantNames);
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

    it('General `ultracode` is the model\'s HIGHEST variant — never its lowest', async () => {
      setInstanceDefaultEffortReader(() => 'ultracode');
      const key: SessionKey = keyFromString(noPrefThreadKeyString);
      const adapter = createStubbedAdapter();

      void adapter.startSession(key, '/tmp/work');
      const session = await waitForSession(adapter, keyToString(key));

      // The stubbed model ships low…max: `ultracode` resolves to the exact top variant.
      assert.equal((session as { effortLevel: string | null }).effortLevel, 'max');
    });

    it('General `auto` sends no variant at all: the session carries no effort', async () => {
      setInstanceDefaultEffortReader(() => 'auto');
      const key: SessionKey = keyFromString(noPrefThreadKeyString);
      const adapter = createStubbedAdapter();

      void adapter.startSession(key, '/tmp/work');
      const session = await waitForSession(adapter, keyToString(key));

      assert.equal((session as { effortLevel: string | null }).effortLevel, null);
      assert.equal('variant' in buildPromptBody('hi', null, (session as { effortLevel: string | null }).effortLevel), false, 'no body.variant');
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

    it('getEffortState: a live session keeps the level it started with while the default moves on; the next start resolves afresh', async () => {
      setInstanceDefaultEffortReader(() => 'xhigh');
      const key: SessionKey = keyFromString(noPrefThreadKeyString);
      const adapter = createStubbedAdapter();
      void adapter.startSession(key, '/tmp/work');
      await waitForSession(adapter, keyToString(key));

      assert.deepEqual(adapter.getEffortState(key), { running: 'xhigh', nextStart: 'xhigh' });
      setInstanceDefaultEffortReader(() => 'low');
      assert.deepEqual(adapter.getEffortState(key), { running: 'xhigh', nextStart: 'low' }, 'a General change never reaches the running session');
    });

    it('getEffortState: the next start\'s level is already rounded to the model\'s variants, so a model that cannot tell the two apart shows no difference', async () => {
      setInstanceDefaultEffortReader(() => 'xhigh');
      const key: SessionKey = keyFromString(noPrefThreadKeyString);
      const adapter = createStubbedAdapter(['low', 'medium', 'high']);
      void adapter.startSession(key, '/tmp/work');
      const session = (await waitForSession(adapter, keyToString(key))) as { effortLevel: string | null };

      assert.equal(session.effortLevel, 'high', 'the session runs the nearest variant of xhigh');
      assert.deepEqual(adapter.getEffortState(key), { running: 'high', nextStart: 'high' });
    });

    it('getEffortState: a thread with no live session runs nothing; its pick (or the default) is the next start', () => {
      setInstanceDefaultEffortReader(() => 'low');
      const adapter = createStubbedAdapter();
      assert.deepEqual(adapter.getEffortState(keyFromString(noPrefThreadKeyString)), { running: null, nextStart: 'low' });
      assert.deepEqual(adapter.getEffortState(keyFromString(seededThreadKeyString)), { running: null, nextStart: seededEffortLevel });
    });

    it('getEffortState with no live session rounds the default to the variants of the topic\'s saved model — ultracode is not shown as is', async () => {
      setInstanceDefaultEffortReader(() => 'ultracode');
      const key: SessionKey = keyFromString(noPrefThreadKeyString);
      const adapter = createStubbedAdapter(['low', 'medium', 'high']);
      try {
        fs.writeFileSync(modelPrefsFile, JSON.stringify({ [noPrefThreadKeyString]: 'anthropic/claude-opus-4-8' }));
        assert.deepEqual(adapter.getEffortState(key), { running: null, nextStart: 'ultracode' }, 'no providers snapshot yet: nothing to round with');
        await adapter.getAvailableEffortLevels(key); // the /effort screen's read takes the snapshot
        assert.deepEqual(adapter.getEffortState(key), { running: null, nextStart: 'high' }, 'the saved model stops at high');
      } finally {
        fs.rmSync(modelPrefsFile, { force: true });
      }
    });
  });
});
