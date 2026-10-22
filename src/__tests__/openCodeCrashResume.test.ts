/**
 * @description OpenCode server-crash recovery: after the bot auto-restarts a
 * crashed `opencode serve`, every active session must be RESTORED by
 * re-resuming its persisted id (opencode keeps sessions on disk), not torn
 * down. Only when the id is genuinely gone on the restarted server do we fall
 * back to the old teardown + `closed` + "previous session lost" notice.
 *
 * These tests drive the REAL `restartServer()` → `resumeSessionInner()` path (the retry
 * tests script only the server start, through the adapter's `serverRestartOps` seam):
 *
 *  - global `fetch` is stubbed so the server health check (`/global/health`,
 *    hit by `ensureOpenCodeServer` / `checkIsOpenCodeServerRunning`) reports
 *    the server as alive — so neither spawns a real process.
 *  - `OPENCODE_BIN` is set so `checkIsInstalled('opencode')` short-circuits to
 *    true without shelling out to `which`.
 *  - the adapter's private `apiRequest` is stubbed to control the load-bearing
 *    `GET /session/:id` call (success vs 404); `connectSse` / `fetchModelInfo`
 *    are stubbed to no-ops so the resume path doesn't open a real SSE stream
 *    or query `/config`.
 *
 * Load-bearing assertions (per plan VERIFICATION): the session id and the
 * active flag, plus the emitted notice and the presence/absence of `closed` —
 * not merely "no crash".
 *
 * Harness mirrors `openCodeResumeModel.test.ts` / `openCodeOutputDedup.test.ts`:
 * a session is injected into the private `sessions` map and private methods are
 * driven via bracket access.
 */

import { describe, it } from 'node:test';
import { useStubbedOpenCodeServer } from './openCodeServerStub';
import assert from 'node:assert/strict';
import {
  OpenCodeAdapter,
  getOpenCodeServerRestartRetryDelayMs,
  openCodeServerRestartRetryBudgetMs,
  openCodeServerRestartRetryDelaysMs,
  type OpenCodeServerRestartOps,
  type OpenCodeSession,
} from '../adapters/openCodeAdapter';
import { AgentBackendUnavailableError } from '../adapters/backendUnavailableError';
import { defaultLocale, runWithLocale, t } from '../i18n';
import { keyToString, type SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { createOpenCodeSessionFixture } from './openCodeSessionFixture';

const key: SessionKey = makeTelegramKey(-100777, 7);
const sessionId = 'ses_persisted_7';
const workDir = '/tmp/work-crash';
const restoredNotice = runWithLocale(defaultLocale, () => t('openCodeServer.restartedSessionRestoredNotice'));
const lostNotice = runWithLocale(defaultLocale, () => t('openCodeServer.restartedSessionLostNotice'));
const serverUnavailableNotice = runWithLocale(defaultLocale, () => t('agent.serverUnavailableNotice', { label: 'OpenCode' }));
const startingNotice = runWithLocale(defaultLocale, () => t('openCodeServer.startingNotice'));
const installingNotice = runWithLocale(defaultLocale, () => t('openCodeServer.installingNotice'));
/** What `spawn` rejects with while the binary is gone. */
const spawnEnoentMessage = 'spawn opencode ENOENT';
/** Pauses short enough for a test; the budget is out of reach so only the pause count bounds the retries. */
const testRetryDelaysMs: readonly number[] = [1, 1];
const unreachableBudgetMs = 60_000;

useStubbedOpenCodeServer();

function createActiveSession(isTurnInFlight = false): OpenCodeSession {
  return createOpenCodeSessionFixture({
    key,
    sessionId,
    workDir,
    isModelInfoShown: true,
    currentModelLabel: 'anthropic/claude',
    isBusy: isTurnInFlight,
  });
}

/**
 * Build an adapter with one active session injected and the network-touching
 * private methods stubbed. `sessionExists` controls the `GET /session/:id`
 * outcome: `true` → the restarted server still has the id (resume succeeds);
 * `false` → 404, so resume throws and the teardown fallback runs. `isTurnInFlight`:
 * the session was mid-turn when the server went down (its reply is lost).
 */
function createAdapter(sessionExists: boolean, isTurnInFlight = false): {
  adapter: OpenCodeAdapter;
  outputs: string[];
  closedKeys: SessionKey[];
  getSessionRequests: string[];
  promptPosts: string[];
} {
  const adapter = new OpenCodeAdapter();
  adapter['sessions'].set(keyToString(key), createActiveSession(isTurnInFlight));

  const getSessionRequests: string[] = [];
  const promptPosts: string[] = [];
  adapter['apiRequest'] = (async (method: string, urlPath: string) => {
    // The session-verify call is `GET /session/:id` (the basis of the resume
    // decision). `stopSessionInner` also fires a fire-and-forget
    // `POST /session/:id/abort`; resolve that quietly so it can't be mistaken
    // for the verify call.
    if (method === 'GET' && urlPath === `/session/${sessionId}`) {
      getSessionRequests.push(urlPath);
      if (!sessionExists) {
        throw new Error('OpenCode API error: 404 Not Found');
      }
      return { id: sessionId };
    }
    if (urlPath.endsWith('/abort')) {
      return undefined;
    }
    if (method === 'POST' && urlPath.endsWith('/prompt_async')) {
      promptPosts.push(urlPath);
      return undefined;
    }
    throw new Error(`unexpected apiRequest in test: ${method} ${urlPath}`);
  }) as OpenCodeAdapter['apiRequest'];

  // Keep resume off the real network: no SSE stream, no /config model lookup.
  adapter['connectSse'] = (() => {}) as OpenCodeAdapter['connectSse'];
  adapter['fetchModelInfo'] = (async () => {}) as OpenCodeAdapter['fetchModelInfo'];

  const outputs: string[] = [];
  adapter.on('output', (_key: SessionKey, text: string) => {
    outputs.push(text);
  });
  const closedKeys: SessionKey[] = [];
  adapter.on('closed', (closedKey: SessionKey) => {
    closedKeys.push(closedKey);
  });

  return { adapter, outputs, closedKeys, getSessionRequests, promptPosts };
}

/** @description The calls the scripted restart ops saw, in order. */
interface RestartOpsCalls {
  installChecks: number;
  installs: number;
  ensures: number;
  forcedRestarts: number;
}

/**
 * @description Replace the adapter's installManager calls with a script: attempt `n` (0-based) sees the binary
 * installed when `isInstalledByAttempt[n]` is true, and its server start throws when `startErrorByAttempt[n]` is set.
 * Missing entries mean "installed" and "starts". The retry pauses shrink to {@link testRetryDelaysMs}.
 */
function scriptServerRestart(
  adapter: OpenCodeAdapter,
  script: {
    isInstalledByAttempt?: readonly boolean[];
    startErrorByAttempt?: readonly (Error | null)[];
    /** The server is down until a start succeeded (a session start / resume finds it down). */
    isServerDownAtFirst?: boolean;
    /** Each server start waits for this before it settles (a restart that is still in progress). */
    startGate?: Promise<void>;
  },
): RestartOpsCalls {
  const calls: RestartOpsCalls = { installChecks: 0, installs: 0, ensures: 0, forcedRestarts: 0 };
  let isServerUp = script.isServerDownAtFirst !== true;
  const getStartError = (): Error | null => script.startErrorByAttempt?.[calls.ensures + calls.forcedRestarts - 1] ?? null;
  const ops: OpenCodeServerRestartOps = {
    checkIsInstalled: () => script.isInstalledByAttempt?.[calls.installChecks++] ?? true,
    installTool: async () => {
      calls.installs += 1;
    },
    checkIsServerRunning: async () => isServerUp,
    ensureServer: async () => {
      calls.ensures += 1;
      await script.startGate;
      const error = getStartError();
      if (error) throw error;
      isServerUp = true;
    },
    restartServer: async () => {
      calls.forcedRestarts += 1;
      const error = getStartError();
      if (error) throw error;
    },
  };
  adapter['serverRestartOps'] = ops;
  adapter['serverRestartRetryDelaysMs'] = testRetryDelaysMs;
  adapter['serverRestartRetryBudgetMs'] = unreachableBudgetMs;
  return calls;
}

describe('OpenCode crash-resume in restartServer', () => {
  it('reloadProviderAuth forces a controlled restart so a live server reloads its credential', async () => {
    const adapter = new OpenCodeAdapter();
    let isForcedRestart = false;
    adapter['restartServer'] = async (force = false) => {
      isForcedRestart = force;
      return true;
    };

    const result = await adapter.reloadProviderAuth();

    assert.equal(result, true);
    assert.equal(isForcedRestart, true, 'OAuth credential reload must stop a healthy server generation');
  });

  it('crash → restart OK → GET /session/:id issued, an idle session stays active with the SAME id, NOTHING posted, NO closed', async () => {
    const { adapter, outputs, closedKeys, getSessionRequests } = createAdapter(true);

    const result = await adapter['restartServer']();
    assert.equal(result, true, 'restartServer must report success');

    // Load-bearing: the persisted id was verified on the restarted server.
    assert.deepEqual(getSessionRequests, [`/session/${sessionId}`], 'must GET the persisted session id exactly once');

    // Load-bearing: the SAME session id survives and stays active.
    const session = adapter['sessions'].get(keyToString(key));
    assert.ok(session, 'session must still be present after restore');
    assert.equal(session.sessionId, sessionId, 'restored session must keep the SAME id');
    assert.equal(session.isActive, true, 'restored session must be active');

    // A silent restore: an idle topic lost nothing, so it hears nothing; no teardown.
    assert.deepEqual(outputs, [], 'an idle session is restored silently');
    assert.deepEqual(closedKeys, [], 'a restored session must NOT emit closed');
  });

  it('a session whose turn was in flight is told its reply was lost — once, after the restore', async () => {
    const { adapter, outputs, closedKeys } = createAdapter(true, true);

    assert.equal(await adapter['restartServer'](), true);

    assert.deepEqual(outputs, [restoredNotice], 'the in-flight reply is gone: the topic is told to resend');
    assert.deepEqual(closedKeys, []);
  });

  it('the binary is gone at the first attempt (spawn ENOENT), back at the retry → installed, session restored, no failure posted', async () => {
    const { adapter, outputs, closedKeys, getSessionRequests } = createAdapter(true);
    const calls = scriptServerRestart(adapter, {
      // The first look still finds a stale shim, the spawn fails; the retry finds nothing and installs.
      isInstalledByAttempt: [true, false],
      startErrorByAttempt: [new Error(spawnEnoentMessage), null],
    });

    const result = await adapter['restartServer']();

    assert.equal(result, true, 'a restart that succeeds on a retry must report success');
    assert.equal(calls.ensures, 2, 'the failed start must be retried exactly once before it succeeds');
    assert.equal(calls.installs, 1, 'a binary missing at the retry must be installed before the start, like a session start does');
    assert.deepEqual(getSessionRequests, [`/session/${sessionId}`], 'the session is restored only after the server is back');
    const session = adapter['sessions'].get(keyToString(key));
    assert.equal(session?.sessionId, sessionId, 'the SAME session id must survive the retried restart');
    assert.equal(session?.isActive, true, 'the restored session must be active');
    assert.deepEqual(outputs, [], 'an idle topic hears nothing — not while retrying, not after');
    assert.deepEqual(closedKeys, [], 'a restored session must NOT emit closed');
  });

  it('every attempt fails → ONE localized failure notice per topic (no raw exception), session stopped', async () => {
    const { adapter, outputs, closedKeys, getSessionRequests } = createAdapter(true);
    const calls = scriptServerRestart(adapter, {
      startErrorByAttempt: Array.from({ length: testRetryDelaysMs.length + 1 }, () => new Error(spawnEnoentMessage)),
    });
    const stoppedKeys: SessionKey[] = [];
    adapter.on('stopped', (stoppedKey: SessionKey) => {
      stoppedKeys.push(stoppedKey);
    });

    const result = await adapter['restartServer']();

    assert.equal(result, false, 'a restart whose every attempt failed must report failure');
    assert.equal(calls.ensures, testRetryDelaysMs.length + 1, 'one first attempt plus one retry per pause');
    assert.deepEqual(outputs, [serverUnavailableNotice], 'exactly one short localized line reaches the topic');
    assert.equal(outputs.some((text) => text.includes('ENOENT')), false, 'the technical detail stays in the log');
    assert.deepEqual(getSessionRequests, [], 'no session is resumed on a server that never came back');
    assert.equal(adapter['sessions'].get(keyToString(key)), undefined, 'the session is dropped');
    assert.deepEqual(stoppedKeys, [key], 'the session is reported stopped, so its next message starts it again');
    assert.deepEqual(closedKeys, [], 'the persisted id is kept (stopped, not closed)');
    assert.equal(adapter['serverRestart'], null, 'the restart gate is released after giving up');
  });

  it('a forced restart (credential reload) retries through the controlled restart, never by adopting the old server', async () => {
    const { adapter, outputs } = createAdapter(true);
    const calls = scriptServerRestart(adapter, { startErrorByAttempt: [new Error(spawnEnoentMessage), null] });

    const result = await adapter['restartServer'](true);

    assert.equal(result, true);
    assert.equal(calls.forcedRestarts, 2, 'the retry must stop and start again, not adopt the server holding the old credential');
    assert.equal(calls.ensures, 0);
    assert.deepEqual(outputs, []);
  });

  it('a crash restarts the server without posting anything first', () => {
    const adapter = new OpenCodeAdapter();
    adapter['sessions'].set(keyToString(key), createActiveSession());
    let restartCount = 0;
    adapter['restartServer'] = async () => {
      restartCount += 1;
      return true;
    };
    const outputs: string[] = [];
    adapter.on('output', (_key: SessionKey, text: string) => {
      outputs.push(text);
    });

    adapter['handleServerCrash'](137, null);

    assert.deepEqual(outputs, [], 'the restart speaks only if it matters to the topic');
    assert.equal(restartCount, 1, 'the crash starts a restart');
  });

  it('a prompt sent while the restart runs is held and posted to the restored session — not lost to the dead server', async () => {
    const { adapter, outputs, promptPosts } = createAdapter(true);
    let releaseStart: () => void = () => {};
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    scriptServerRestart(adapter, { startGate });

    const restart = adapter['restartServer']();
    adapter.sendInput(key, 'the question typed during the restart');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(promptPosts, [], 'nothing is posted while the server is down');

    releaseStart();
    assert.equal(await restart, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(promptPosts, [`/session/${sessionId}/prompt_async`], 'the held prompt goes to the restored session');
    assert.deepEqual(outputs, [], 'no error, no notice');
  });

  it('a session start or resume brings a down server up through the same retries, telling the topic in its language', async () => {
    const { adapter, outputs } = createAdapter(true);
    adapter['sessions'].clear();
    const calls = scriptServerRestart(adapter, {
      isServerDownAtFirst: true,
      isInstalledByAttempt: [false, true],
      startErrorByAttempt: [new Error(spawnEnoentMessage), null],
    });

    await adapter.resumeSession(key, workDir, sessionId);

    assert.equal(calls.installs, 1, 'the missing binary is installed first');
    assert.equal(calls.ensures, 2, 'the failed start is retried');
    assert.deepEqual(outputs, [installingNotice, startingNotice], 'what is happening, once each — not once per retry');
    assert.equal(adapter['sessions'].get(keyToString(key))?.isActive, true);
  });

  it('a session start or resume whose server never comes up fails with the typed "unavailable" error, no raw text posted', async () => {
    const { adapter, outputs } = createAdapter(true);
    adapter['sessions'].clear();
    scriptServerRestart(adapter, {
      isServerDownAtFirst: true,
      startErrorByAttempt: Array.from({ length: testRetryDelaysMs.length + 1 }, () => new Error(spawnEnoentMessage)),
    });

    await assert.rejects(adapter.resumeSession(key, workDir, sessionId), AgentBackendUnavailableError);
    assert.equal(outputs.some((text) => text.includes('ENOENT')), false, 'the raw error never reaches the topic');
  });

  it('crash → GET /session/:id 404 → teardown + closed + lost notice', async () => {
    const { adapter, outputs, closedKeys, getSessionRequests } = createAdapter(false);

    const result = await adapter['restartServer']();
    assert.equal(result, true, 'restartServer still succeeds at the server level even when a session id is gone');

    // The resume path tried (and failed) to verify the id.
    assert.deepEqual(getSessionRequests, [`/session/${sessionId}`], 'must attempt to verify the persisted id before falling back');

    // Load-bearing: the session is torn down (gone from the map / inactive).
    const session = adapter['sessions'].get(keyToString(key));
    assert.equal(session, undefined, 'a session whose id is gone must be removed');

    // Fallback teardown: lost notice + closed, no false "restored".
    assert.ok(outputs.includes(lostNotice), `expected lost notice, got: ${JSON.stringify(outputs)}`);
    assert.equal(outputs.includes(restoredNotice), false, 'must not claim "restored" when the id is gone');
    assert.deepEqual(closedKeys, [key], 'a lost session must emit closed so the bot wipes the persisted id');
  });
});

describe('getOpenCodeServerRestartRetryDelayMs', () => {
  it('walks the pauses in order and stops after the last one', () => {
    assert.equal(getOpenCodeServerRestartRetryDelayMs(0, 0, [10, 20], 1_000), 10);
    assert.equal(getOpenCodeServerRestartRetryDelayMs(1, 0, [10, 20], 1_000), 20);
    assert.equal(getOpenCodeServerRestartRetryDelayMs(2, 0, [10, 20], 1_000), null);
  });

  it('gives up once the retry would start past the budget', () => {
    assert.equal(getOpenCodeServerRestartRetryDelayMs(0, 990, [10], 1_000), 10, 'a retry landing exactly on the budget still runs');
    assert.equal(getOpenCodeServerRestartRetryDelayMs(0, 991, [10], 1_000), null);
  });

  it('the default schedule retries a fast-failing start (spawn ENOENT) for about a minute, never beyond the budget', () => {
    const totalPauseMs = openCodeServerRestartRetryDelaysMs.reduce((sum, delayMs) => sum + delayMs, 0);
    assert.ok(totalPauseMs <= openCodeServerRestartRetryBudgetMs, 'every pause fits the budget when attempts fail at once');
    assert.ok(totalPauseMs >= openCodeServerRestartRetryBudgetMs / 2, 'the pauses span a reinstall, not a few seconds');
  });
});
