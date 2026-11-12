/**
 * @description OpenCode adapter — single `/global/event` SSE stream lifecycle,
 * envelope-directory routing, and per-directory scheduler-MCP registration
 * (plan 2026-06-17).
 *
 * The adapter now owns ONE `/global/event` stream for the whole server instead
 * of one `/event?directory=<workDir>` stream per bound folder. The single
 * stream opens for the FIRST active session ANYWHERE and closes when the LAST
 * one (any folder) leaves; every event arrives wrapped in `payload` and tagged
 * with a top-level `directory`, is parsed once, and is routed by that envelope
 * directory + sessionID to the owning session. Scheduler-MCP is registered per
 * directory on session start (decoupled from the stream).
 *
 * These tests drive the REAL adapter:
 *   - `pollSseStream` is stubbed to a no-op so `ensureGlobalStream` records the
 *     stream in the private `globalStream` field without opening a real socket;
 *   - sessions are injected into the private `sessions` map and lifecycle is
 *     driven via `connectSse` / `disconnectSse` (bracket access);
 *   - routing is verified by feeding ONE payload-wrapped envelope through
 *     `routeSseData` and asserting it reaches exactly the owning session.
 */

import { describe, it, afterEach, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  OpenCodeAdapter,
  checkNeedsLegacySchedulerMcpDisconnect,
  checkNeedsSchedulerMcpReregister,
  getOpenCodeConfigMcpLookup,
  getSchedulerMcpRetryDelayMs,
  schedulerMcpRetryDelaysMs,
  type OpenCodeSession,
} from '../adapters/openCodeAdapter';
import { openCodeCompactPluginFileName } from '../utils/openCodeCompactPlugin';
import { keyToString, type SessionKey } from '../sessionKey';
import {
  configureSchedulerMcpInjection,
  resetSchedulerMcpInjection,
  schedulerMcpServerName,
} from '../scheduler/injection';
import { verifySchedulerMcpToken } from '../scheduler/mcpSurface';
import { legacySchedulerMcpServerName } from '../legacyNames';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { createOpenCodeSessionFixture } from './openCodeSessionFixture';

const sharedDir = '/work/shared';
const otherDir = '/work/other';

function makeSession(key: SessionKey, sessionId: string, workDir: string): OpenCodeSession {
  return createOpenCodeSessionFixture({
    key,
    sessionId,
    workDir,
    isModelInfoShown: true,
    currentModelLabel: 'anthropic/claude',
  });
}

/** Adapter with the real socket reader stubbed out. */
function createAdapter(): OpenCodeAdapter {
  const adapter = new OpenCodeAdapter();
  // No real fetch/socket: ensureGlobalStream still records the stream state.
  adapter['pollSseStream'] = (async () => {}) as OpenCodeAdapter['pollSseStream'];
  return adapter;
}

/**
 * Build the `/global/event` envelope shape `routeSseData` consumes: the real
 * event wrapped in `payload` and tagged with a top-level `directory` (and a
 * `project` field the server sends but the bot ignores).
 */
function globalEnvelope(directory: string, type: string, properties: Record<string, unknown>): string {
  return JSON.stringify({ directory, project: 'proj', payload: { type, properties } });
}

describe('single global SSE stream lifecycle', () => {
  it('the FIRST active session ANYWHERE opens THE one stream; further calls are idempotent', () => {
    const adapter = createAdapter();
    const keyOne: SessionKey = makeTelegramKey(-100, 1);
    adapter['sessions'].set(keyToString(keyOne), makeSession(keyOne, 'ses_1', sharedDir));

    assert.equal(adapter['globalStream'], null, 'no stream before connect');
    adapter['connectSse'](keyOne);
    assert.notEqual(adapter['globalStream'], null, 'the first session opens the global stream');

    const streamRef = adapter['globalStream'];
    adapter['connectSse'](keyOne); // idempotent
    assert.equal(adapter['globalStream'], streamRef, 'a second connect reuses the same stream');
  });

  it('two threads in DIFFERENT folders SHARE the one stream; it closes only when the LAST leaves', () => {
    const adapter = createAdapter();
    const keyOne: SessionKey = makeTelegramKey(-100, 1);
    const keyTwo: SessionKey = makeTelegramKey(-100, 2);
    adapter['sessions'].set(keyToString(keyOne), makeSession(keyOne, 'ses_1', sharedDir));
    adapter['sessions'].set(keyToString(keyTwo), makeSession(keyTwo, 'ses_2', otherDir));

    adapter['connectSse'](keyOne);
    adapter['connectSse'](keyTwo);
    const streamRef = adapter['globalStream'];
    assert.notEqual(streamRef, null, 'sessions across folders share a single global stream');

    // First thread leaves — a session in the OTHER folder still keeps it open.
    adapter['disconnectSse'](keyOne);
    assert.equal(adapter['globalStream'], streamRef, 'stream stays while any session anywhere is active');

    // Last thread leaves — the stream tears down.
    adapter['disconnectSse'](keyTwo);
    assert.equal(adapter['globalStream'], null, 'stream closes when the last session anywhere leaves');
    assert.equal(streamRef?.isClosed, true, 'the closed stream is latched');
  });

  it('two threads sharing a folder also keep ONE stream; it closes on the last', () => {
    const adapter = createAdapter();
    const keyOne: SessionKey = makeTelegramKey(-100, 1);
    const keyTwo: SessionKey = makeTelegramKey(-100, 2);
    adapter['sessions'].set(keyToString(keyOne), makeSession(keyOne, 'ses_1', sharedDir));
    adapter['sessions'].set(keyToString(keyTwo), makeSession(keyTwo, 'ses_2', sharedDir));

    adapter['connectSse'](keyOne);
    adapter['connectSse'](keyTwo);
    const streamRef = adapter['globalStream'];
    assert.notEqual(streamRef, null);

    adapter['disconnectSse'](keyOne);
    assert.equal(adapter['globalStream'], streamRef, 'a sibling in the same folder keeps it open');

    adapter['disconnectSse'](keyTwo);
    assert.equal(adapter['globalStream'], null, 'closes when the last sibling leaves');
  });
});

describe('global-stream routing parses once and delivers to the owner', () => {
  it('an event for session B (envelope tagged with B\'s folder) reaches ONLY B', () => {
    const adapter = createAdapter();
    const keyA: SessionKey = makeTelegramKey(-100, 1);
    const keyB: SessionKey = makeTelegramKey(-100, 2);
    adapter['sessions'].set(keyToString(keyA), makeSession(keyA, 'ses_A', sharedDir));
    adapter['sessions'].set(keyToString(keyB), makeSession(keyB, 'ses_B', otherDir));

    const outputsByThread = new Map<string, string[]>();
    adapter.on('output', (key: SessionKey, text: string) => {
      const k = keyToString(key);
      const list = outputsByThread.get(k) ?? [];
      list.push(text);
      outputsByThread.set(k, list);
    });

    // One payload-wrapped envelope, fed once — it targets B by sessionID.
    adapter['routeSseData'](
      globalEnvelope(otherDir, 'message.part.delta', {
        sessionID: 'ses_B', messageID: 'msg', partID: 'prt', field: 'text', delta: 'hi B',
      }),
    );
    // Text deltas debounce 500ms before emitting; flush via a session.idle.
    adapter['routeSseData'](
      globalEnvelope(otherDir, 'session.idle', { sessionID: 'ses_B' }),
    );

    assert.deepEqual(outputsByThread.get(keyToString(keyB)), ['hi B'], 'owner B got the output exactly once');
    assert.equal(outputsByThread.has(keyToString(keyA)), false, 'sibling A got nothing');
  });

  it('two topics share a folder: the envelope directory + sessionID still picks ONE owner', () => {
    const adapter = createAdapter();
    const keyA: SessionKey = makeTelegramKey(-100, 1);
    const keyB: SessionKey = makeTelegramKey(-100, 2);
    adapter['sessions'].set(keyToString(keyA), makeSession(keyA, 'ses_A', sharedDir));
    adapter['sessions'].set(keyToString(keyB), makeSession(keyB, 'ses_B', sharedDir));

    const outputsByThread = new Map<string, string[]>();
    adapter.on('output', (key: SessionKey, text: string) => {
      const k = keyToString(key);
      const list = outputsByThread.get(k) ?? [];
      list.push(text);
      outputsByThread.set(k, list);
    });

    adapter['routeSseData'](
      globalEnvelope(sharedDir, 'message.part.delta', {
        sessionID: 'ses_A', messageID: 'msg', partID: 'prt', field: 'text', delta: 'hi A',
      }),
    );
    adapter['routeSseData'](globalEnvelope(sharedDir, 'session.idle', { sessionID: 'ses_A' }));

    assert.deepEqual(outputsByThread.get(keyToString(keyA)), ['hi A'], 'direct id match routes to A only');
    assert.equal(outputsByThread.has(keyToString(keyB)), false, 'sibling B got nothing');
  });

  it('an event for a directory the bot does NOT own (by-hand opencode elsewhere) is dropped', () => {
    const adapter = createAdapter();
    const keyA: SessionKey = makeTelegramKey(-100, 1);
    adapter['sessions'].set(keyToString(keyA), makeSession(keyA, 'ses_A', sharedDir));

    let emitted = false;
    adapter.on('output', () => { emitted = true; });

    // Unknown session in an unbound folder — no active bound session there.
    adapter['routeSseData'](
      globalEnvelope('/work/byhand', 'session.idle', { sessionID: 'ses_foreign' }),
    );
    assert.equal(emitted, false, 'a foreign-directory event emits nothing');
  });

  it('an event whose session no thread owns is dropped (no emit)', () => {
    const adapter = createAdapter();
    const keyA: SessionKey = makeTelegramKey(-100, 1);
    adapter['sessions'].set(keyToString(keyA), makeSession(keyA, 'ses_A', sharedDir));

    let emitted = false;
    adapter.on('output', () => { emitted = true; });

    // An unknown session id, tagged with a folder that has no active bound
    // session — neither id/lineage nor the directory fallback resolves an owner.
    adapter['routeSseData'](
      globalEnvelope(otherDir, 'session.idle', { sessionID: 'ses_orphan' }),
    );
    assert.equal(emitted, false, 'an unowned event emits nothing');
  });
});

describe('scheduler MCP registration per directory on session start (plan 2026-06-17 S3)', () => {
  const secret = 'a'.repeat(64);
  const port = 4097;

  afterEach(() => {
    resetSchedulerMcpInjection();
  });

  it('inert (injection unconfigured): connecting a session POSTs nothing', async () => {
    const adapter = createAdapter();
    const keyA: SessionKey = makeTelegramKey(-100, 1);
    adapter['sessions'].set(keyToString(keyA), makeSession(keyA, 'ses_A', sharedDir));
    const calls: { method: string; url: string }[] = [];
    adapter['apiRequest'] = (async (method: string, url: string) => {
      calls.push({ method, url });
    }) as OpenCodeAdapter['apiRequest'];

    adapter['connectSse'](keyA);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 0, 'no registration POST when injection is inert');
    assert.equal(adapter['registeredSchedulerMcpDirs'].has(sharedDir), false);
  });

  it('configured: connecting a session POSTs the dir-scoped registration once per dir', async () => {
    configureSchedulerMcpInjection({ getSecret: async () => secret, port });
    const adapter = createAdapter();
    const keyA: SessionKey = makeTelegramKey(-100, 1);
    adapter['sessions'].set(keyToString(keyA), makeSession(keyA, 'ses_A', sharedDir));
    const calls: { method: string; url: string; body: unknown }[] = [];
    adapter['apiRequest'] = (async (method: string, url: string, body: unknown) => {
      calls.push({ method, url, body });
      return url.startsWith('/config') ? {} : undefined;
    }) as OpenCodeAdapter['apiRequest'];

    adapter['connectSse'](keyA);
    // Registration is fire-and-forget (async); let the microtask settle.
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), [
      `POST /mcp?directory=${encodeURIComponent(sharedDir)}`,
      `GET /config?directory=${encodeURIComponent(sharedDir)}`,
    ], 'exactly one registration POST, then the one read of the folder\'s config');
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url, `/mcp?directory=${encodeURIComponent(sharedDir)}`);

    const body = calls[0].body as {
      name: string;
      config: { type: string; url: string; enabled: boolean; headers: { Authorization: string } };
    };
    assert.equal(body.name, schedulerMcpServerName);
    assert.equal(body.config.type, 'remote');
    assert.equal(body.config.enabled, true);
    assert.equal(body.config.url, `http://127.0.0.1:${port}/mcp`);
    // The token verifies to the EXACT directory scope.
    const token = body.config.headers.Authorization.slice('Bearer '.length);
    assert.deepEqual(verifySchedulerMcpToken(secret, token), { kind: 'dir', directory: sharedDir });

    // Latched: a second connect for a session in the SAME dir does not re-POST.
    adapter['connectSse'](keyA);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 2, 'idempotent — the dir Set prevents a re-POST, and the config is not read again');
  });

  it('registers reattached sessions after scheduler injection becomes available', async () => {
    const adapter = createAdapter();
    const keyA: SessionKey = makeTelegramKey(-100, 1);
    adapter['sessions'].set(keyToString(keyA), makeSession(keyA, 'ses_A', sharedDir));
    const calls: string[] = [];
    adapter['apiRequest'] = (async (_method: string, url: string) => {
      calls.push(url);
      return url.startsWith('/config') ? {} : undefined;
    }) as OpenCodeAdapter['apiRequest'];

    // A session that connected while injection was still inert.
    adapter['connectSse'](keyA);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 0, 'inert injection cannot register during reattach');

    configureSchedulerMcpInjection({ getSecret: async () => secret, port });
    adapter.registerSchedulerMcpForActiveSessions();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(calls, [`/mcp?directory=${encodeURIComponent(sharedDir)}`, `/config?directory=${encodeURIComponent(sharedDir)}`]);
  });

  it('a server brought up again (a restart replacing it) drops what was learned about the old one, so the next connect re-registers (S4)', async () => {
    configureSchedulerMcpInjection({ getSecret: async () => secret, port });
    const adapter = createAdapter();
    const keyA: SessionKey = makeTelegramKey(-100, 1);
    adapter['sessions'].set(keyToString(keyA), makeSession(keyA, 'ses_A', sharedDir));
    const calls: string[] = [];
    adapter['apiRequest'] = (async (_method: string, url: string) => {
      calls.push(url);
      return url.startsWith('/config') ? {} : undefined;
    }) as OpenCodeAdapter['apiRequest'];

    adapter['connectSse'](keyA);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.filter((url) => url.startsWith('/mcp')).length, 1, 'registered once on first connect');

    // A restart wipes the server's MCP table, so bringing the new server up drops the gate (and the answers about the folder's config,
    // which the new server reads afresh); the resume path then re-runs connectSse for each still-active session. The server's start is
    // scripted: the default one would start a REAL OpenCode server from the test.
    const server = scriptServerStart(adapter, true);
    await adapter['ensureServerWithRetries']('replace');
    assert.equal(server.starts(), 1, 'the replacement server was started');
    assert.equal(adapter['registeredSchedulerMcpDirs'].size, 0);
    adapter['connectSse'](keyA);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.filter((url) => url.startsWith('/mcp')).length, 2, 're-registered after the Set was cleared on restart');
    assert.equal(calls.filter((url) => url.startsWith('/config')).length, 2, 'and the config read again for the new server');
    assert.equal(adapter['registeredSchedulerMcpDirs'].has(sharedDir), true, 'dir re-latched');
  });

  /** The server's start, scripted: `isServerUp` is what its health probe answers, `starts` counts the servers brought up. */
  function scriptServerStart(adapter: OpenCodeAdapter, isServerUp: boolean): { starts: () => number; setServerUp: (isUp: boolean) => void } {
    let isUp = isServerUp;
    let starts = 0;
    adapter['serverRestartOps'] = {
      checkIsInstalled: () => true,
      installTool: async () => {},
      checkIsServerRunning: async () => isUp,
      ensureServer: async () => { starts += 1; isUp = true; },
      restartServer: async () => { starts += 1; isUp = true; },
      readServerLaunch: async () => ({ kind: 'unknown' }),
      readServerExposure: async () => 'protected',
    };
    return { starts: () => starts, setServerUp: (isUpNow) => { isUp = isUpNow; } };
  }

  it('a session start that finds the server DOWN and starts a new one re-registers the folders the old one held (not only a restart does)', async () => {
    configureSchedulerMcpInjection({ getSecret: async () => secret, port });
    const adapter = createAdapter();
    const keyA: SessionKey = makeTelegramKey(-100, 1);
    adapter['sessions'].set(keyToString(keyA), makeSession(keyA, 'ses_A', sharedDir));
    const calls: string[] = [];
    adapter['apiRequest'] = (async (_method: string, url: string) => {
      calls.push(url);
      return url.startsWith('/config') ? {} : undefined;
    }) as OpenCodeAdapter['apiRequest'];
    const server = scriptServerStart(adapter, true);

    adapter['connectSse'](keyA);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.filter((url) => url.startsWith('/mcp')).length, 1, 'registered while the first server ran');
    assert.equal(adapter['registeredSchedulerMcpDirs'].has(sharedDir), true);

    // The adopted server dies with no stream left to notice (the folder's last session ended), and a new session starts the next one.
    server.setServerUp(false);
    await adapter['ensureServerForSession'](keyA);
    assert.equal(server.starts(), 1, 'a new server was started');
    assert.equal(adapter['registeredSchedulerMcpDirs'].size, 0, 'the gate describes the old server and is dropped with it');
    assert.equal(adapter['configDefinedMcpNames'].size, 0, 'and so are the answers about its folders\' configs');

    adapter['connectSse'](keyA);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.filter((url) => url.startsWith('/mcp')).length, 2, 'the new server\'s empty table got the registration: the folder\'s agents have the bot\'s tools');
  });

  it('a session start that finds the server UP uses it as it is: what was learned about it stays', async () => {
    const adapter = createAdapter();
    const keyA: SessionKey = makeTelegramKey(-100, 1);
    adapter['sessions'].set(keyToString(keyA), makeSession(keyA, 'ses_A', sharedDir));
    adapter['registeredSchedulerMcpDirs'].add(sharedDir);
    adapter['configDefinedMcpNames'].set(sharedDir, { isBotNameDefined: false, isLegacyNameDefined: false });
    const server = scriptServerStart(adapter, true);

    await adapter['ensureServerForSession'](keyA);

    assert.equal(server.starts(), 0);
    assert.equal(adapter['registeredSchedulerMcpDirs'].has(sharedDir), true);
    assert.equal(adapter['configDefinedMcpNames'].has(sharedDir), true);
  });

  it('the provider sign-in\'s server start drops it too, and a server that failed to start drops nothing', async () => {
    const adapter = createAdapter();
    adapter['registeredSchedulerMcpDirs'].add(sharedDir);
    adapter['serverRestartRetryDelaysMs'] = [];
    adapter['serverRestartRetryBudgetMs'] = 0;
    const server = scriptServerStart(adapter, false);
    adapter['serverRestartOps'] = { ...adapter['serverRestartOps'], ensureServer: async () => { throw new Error('spawn failed'); } };
    const originalError = console.error;
    console.error = () => {};
    try {
      await assert.rejects(adapter['ensureServerWithRetries']('ifDown'));
    } finally {
      console.error = originalError;
    }
    assert.equal(adapter['registeredSchedulerMcpDirs'].has(sharedDir), true, 'no new server came up: the old one\'s registrations are all there is');

    adapter['serverRestartOps'] = { ...adapter['serverRestartOps'], ensureServer: async () => { server.setServerUp(true); } };
    await adapter['ensureServerWithRetries']('ifDown');
    assert.equal(adapter['registeredSchedulerMcpDirs'].size, 0);
  });

  it('registration failure is swallowed (the dir is not latched, so a later connect retries)', async () => {
    configureSchedulerMcpInjection({ getSecret: async () => secret, port });
    const adapter = createAdapter();
    const keyA: SessionKey = makeTelegramKey(-100, 1);
    adapter['sessions'].set(keyToString(keyA), makeSession(keyA, 'ses_A', sharedDir));
    adapter['apiRequest'] = (async () => {
      throw new Error('opencode 404 / server sick');
    }) as OpenCodeAdapter['apiRequest'];

    // Must not throw out of the sync connect path, and the stream stays open.
    assert.doesNotThrow(() => adapter['connectSse'](keyA));
    await new Promise((resolve) => setImmediate(resolve));
    assert.notEqual(adapter['globalStream'], null, 'stream survives a failed registration');
    assert.equal(
      adapter['registeredSchedulerMcpDirs'].has(sharedDir),
      false,
      'a failed registration leaves the dir unlatched so a later connect retries',
    );
  });

  it('reconcile: force re-registers a directory whose charness is not connected (adopt path)', async () => {
    configureSchedulerMcpInjection({ getSecret: async () => secret, port });
    const adapter = createAdapter();
    const keyA: SessionKey = makeTelegramKey(-100, 1);
    adapter['sessions'].set(keyToString(keyA), makeSession(keyA, 'ses_A', sharedDir));
    // A stale Set entry from a prior generation makes the dir LOOK registered;
    // the live server says otherwise, so reconcile must override the gate.
    adapter['registeredSchedulerMcpDirs'].add(sharedDir);
    const posts: string[] = [];
    adapter['apiRequest'] = (async (method: string, url: string) => {
      if (method === 'GET') return { charness: { status: 'failed', error: 'Unable to connect' } };
      if (method === 'POST') posts.push(url);
      return undefined;
    }) as OpenCodeAdapter['apiRequest'];

    await adapter.reconcileSchedulerMcpForActiveSessions();

    assert.deepEqual(
      posts,
      [`/mcp?directory=${encodeURIComponent(sharedDir)}`],
      're-POSTed the registration despite the stale Set entry',
    );
    assert.equal(adapter['registeredSchedulerMcpDirs'].has(sharedDir), true, 're-latched after re-register');
  });

  it('reconcile: leaves a connected directory untouched (no POST) and de-dupes shared folders', async () => {
    configureSchedulerMcpInjection({ getSecret: async () => secret, port });
    const adapter = createAdapter();
    // Two threads bound to the SAME folder — the reconcile must GET/POST it once.
    const keyA: SessionKey = makeTelegramKey(-100, 1);
    const keyB: SessionKey = makeTelegramKey(-100, 2);
    adapter['sessions'].set(keyToString(keyA), makeSession(keyA, 'ses_A', sharedDir));
    adapter['sessions'].set(keyToString(keyB), makeSession(keyB, 'ses_B', sharedDir));
    const gets: string[] = [];
    const posts: string[] = [];
    adapter['apiRequest'] = (async (method: string, url: string) => {
      if (method === 'GET') { gets.push(url); return { charness: { status: 'connected' } }; }
      if (method === 'POST') posts.push(url);
      return undefined;
    }) as OpenCodeAdapter['apiRequest'];

    await adapter.reconcileSchedulerMcpForActiveSessions();

    assert.deepEqual(gets, [`/mcp?directory=${encodeURIComponent(sharedDir)}`, `/config?directory=${encodeURIComponent(sharedDir)}`], 'a shared folder is reconciled once, not once per thread: its status and its config read once');
    assert.equal(posts.length, 0, 'a connected dir is not re-registered');
  });
});

describe('a registration left under the pre-rename server name is disconnected, so the tools are not doubled', () => {
  const secret = 'a'.repeat(64);
  const port = 4097;
  const originalLog = console.log;
  const originalWarn = console.warn;
  const registerUrl = `/mcp?directory=${encodeURIComponent(sharedDir)}`;
  const configUrl = `/config?directory=${encodeURIComponent(sharedDir)}`;
  const disconnectUrl = `/mcp/${encodeURIComponent(legacySchedulerMcpServerName)}/disconnect?directory=${encodeURIComponent(sharedDir)}`;
  const connected = { status: 'connected' };
  let warnings: string[];
  let logLines: string[];

  beforeEach(() => {
    configureSchedulerMcpInjection({ getSecret: async () => secret, port });
    mock.timers.enable({ apis: ['setTimeout'] });
    warnings = [];
    logLines = [];
    console.log = (...args: Parameters<typeof console.log>) => { logLines.push(args.map((arg) => String(arg)).join(' ')); };
    console.warn = (...args: Parameters<typeof console.warn>) => { warnings.push(args.map((arg) => String(arg)).join(' ')); };
  });
  afterEach(() => {
    mock.timers.reset();
    resetSchedulerMcpInjection();
    console.log = originalLog;
    console.warn = originalWarn;
  });

  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  }

  function createAdapterWithSession() {
    const adapter = createAdapter();
    const keyA: SessionKey = makeTelegramKey(-100, 1);
    adapter['sessions'].set(keyToString(keyA), makeSession(keyA, 'ses_A', sharedDir));
    return { adapter, keyA };
  }

  /** What the stubbed OpenCode server answers: `GET /mcp` the live status, `GET /config` the folder's config, a registration its status map. */
  interface StubbedServer {
    liveStatus: unknown;
    /** What `GET /config` answers: a config with no `mcp` unless a case says otherwise. */
    config?: unknown;
    statusAfterRegister?: unknown;
    /** A URL whose request fails. */
    failOn?: string;
  }

  /** Stub the server; every call is recorded, in order, as `<method> <url>`. */
  function stubServer(adapter: OpenCodeAdapter, server: StubbedServer): string[] {
    const calls: string[] = [];
    const hasConfig = 'config' in server;
    adapter['apiRequest'] = (async (method: string, url: string) => {
      calls.push(`${method} ${url}`);
      if (server.failOn === url) throw new Error('server sick');
      if (method === 'GET') return url === configUrl ? (hasConfig ? server.config : {}) : server.liveStatus;
      return url === registerUrl ? server.statusAfterRegister : undefined;
    }) as OpenCodeAdapter['apiRequest'];
    return calls;
  }

  it('the decision: a legacy entry that is not already disabled needs disconnecting; nothing else does', () => {
    assert.equal(checkNeedsLegacySchedulerMcpDisconnect({ [legacySchedulerMcpServerName]: connected }), true);
    assert.equal(checkNeedsLegacySchedulerMcpDisconnect({ [legacySchedulerMcpServerName]: { status: 'failed', error: 'x' } }), true);
    assert.equal(checkNeedsLegacySchedulerMcpDisconnect({ [legacySchedulerMcpServerName]: { status: 'disabled' } }), false, 'already disconnected: do it once');
    assert.equal(checkNeedsLegacySchedulerMcpDisconnect({ [schedulerMcpServerName]: connected }), false);
    assert.equal(checkNeedsLegacySchedulerMcpDisconnect({}), false);
    assert.equal(checkNeedsLegacySchedulerMcpDisconnect(undefined), false, 'a malformed answer must not send a disconnect: a name the server never had is a 404');
    assert.equal(checkNeedsLegacySchedulerMcpDisconnect('nope'), false);
  });

  it('the config lookup: only a config that lists the name defines it; an answer that is not a config decides nothing', () => {
    assert.equal(getOpenCodeConfigMcpLookup({ mcp: { [legacySchedulerMcpServerName]: { type: 'remote' } } }, legacySchedulerMcpServerName), 'defined');
    assert.equal(getOpenCodeConfigMcpLookup({ mcp: { other: { type: 'remote' } } }, legacySchedulerMcpServerName), 'absent');
    assert.equal(getOpenCodeConfigMcpLookup({ plugin: [] }, legacySchedulerMcpServerName), 'absent', 'a config with no mcp section');
    assert.equal(getOpenCodeConfigMcpLookup({ mcp: [legacySchedulerMcpServerName] }, legacySchedulerMcpServerName), 'absent', 'an array is not a table of servers');
    for (const notAConfig of [undefined, null, 'nope', 3, []]) {
      assert.equal(getOpenCodeConfigMcpLookup(notAConfig, legacySchedulerMcpServerName), 'unreadable', JSON.stringify(notAConfig) ?? 'undefined');
    }
  });

  it('reconcile with charness connected: the leftover legacy registration is disconnected, once', async () => {
    const { adapter } = createAdapterWithSession();
    const calls = stubServer(adapter, { liveStatus: { [schedulerMcpServerName]: connected, [legacySchedulerMcpServerName]: connected } });

    await adapter.reconcileSchedulerMcpForActiveSessions();
    assert.deepEqual(calls, [`GET /mcp?directory=${encodeURIComponent(sharedDir)}`, `GET ${configUrl}`, `POST ${disconnectUrl}`]);

    // The next boot finds it disabled and leaves it.
    const nextBootCalls = stubServer(adapter, { liveStatus: { [schedulerMcpServerName]: connected, [legacySchedulerMcpServerName]: { status: 'disabled' } } });
    await adapter.reconcileSchedulerMcpForActiveSessions();
    assert.deepEqual(nextBootCalls, [`GET /mcp?directory=${encodeURIComponent(sharedDir)}`], 'no second disconnect');
  });

  it('an old-name server the operator defined in their own OpenCode config is left alone', async () => {
    const { adapter } = createAdapterWithSession();
    const calls = stubServer(adapter, {
      liveStatus: { [schedulerMcpServerName]: connected, [legacySchedulerMcpServerName]: connected },
      config: { mcp: { [legacySchedulerMcpServerName]: { type: 'remote', url: 'http://operator.invalid/mcp' } } },
    });

    await adapter.reconcileSchedulerMcpForActiveSessions();

    assert.deepEqual(calls, [`GET /mcp?directory=${encodeURIComponent(sharedDir)}`, `GET ${configUrl}`], 'asked whose it is, and sent no disconnect');
    assert.equal(adapter['schedulerMcpRetries'].size, 0, 'nothing is pending: leaving it alone is the finished answer');
  });

  it('an old-name server the operator defined in their config is left alone on a session start too', async () => {
    const { adapter, keyA } = createAdapterWithSession();
    const calls = stubServer(adapter, {
      liveStatus: {},
      statusAfterRegister: { [legacySchedulerMcpServerName]: connected, [schedulerMcpServerName]: connected },
      config: { mcp: { [legacySchedulerMcpServerName]: { type: 'remote' } } },
    });

    adapter['connectSse'](keyA);
    await settle();

    assert.deepEqual(calls, [`POST ${registerUrl}`, `GET ${configUrl}`]);
  });

  it('when the config cannot be read, nothing is disconnected and the step is retried, a bounded number of times', async () => {
    const { adapter } = createAdapterWithSession();
    const calls = stubServer(adapter, {
      liveStatus: { [schedulerMcpServerName]: connected, [legacySchedulerMcpServerName]: connected },
      failOn: configUrl,
    });

    await assert.doesNotReject(adapter.reconcileSchedulerMcpForActiveSessions());
    assert.equal(adapter['schedulerMcpRetries'].size, 1, 'a retry is pending');
    for (const pause of schedulerMcpRetryDelaysMs) {
      mock.timers.tick(pause);
      await settle();
    }

    assert.ok(!calls.includes(`POST ${disconnectUrl}`), 'a failed lookup never turns into a disconnect');
    assert.equal(calls.filter((call) => call === `GET ${configUrl}`).length, 1 + schedulerMcpRetryDelaysMs.length);
    assert.equal(adapter['schedulerMcpRetries'].size, 0, 'it stops after the last pause');
  });

  it('a config answer that is not a config is treated as a failed lookup, not as "not defined"', async () => {
    const { adapter } = createAdapterWithSession();
    const calls = stubServer(adapter, {
      liveStatus: { [schedulerMcpServerName]: connected, [legacySchedulerMcpServerName]: connected },
      config: undefined,
    });

    await adapter.reconcileSchedulerMcpForActiveSessions();

    assert.ok(!calls.includes(`POST ${disconnectUrl}`), calls.join(' | '));
    assert.equal(adapter['schedulerMcpRetries'].size, 1);
  });

  it('reconcile with charness missing: it registers charness FIRST, then disconnects the legacy one named in the registration answer', async () => {
    const { adapter } = createAdapterWithSession();
    const calls = stubServer(adapter, {
      liveStatus: { [legacySchedulerMcpServerName]: connected },
      statusAfterRegister: { [legacySchedulerMcpServerName]: connected, [schedulerMcpServerName]: connected },
    });

    await adapter.reconcileSchedulerMcpForActiveSessions();

    assert.deepEqual(calls, [`GET /mcp?directory=${encodeURIComponent(sharedDir)}`, `POST ${registerUrl}`, `GET ${configUrl}`, `POST ${disconnectUrl}`]);
  });

  it('a session start registers charness and disconnects the legacy registration the server lists in its answer', async () => {
    const { adapter, keyA } = createAdapterWithSession();
    const calls = stubServer(adapter, { liveStatus: {}, statusAfterRegister: { [legacySchedulerMcpServerName]: connected, [schedulerMcpServerName]: connected } });

    adapter['connectSse'](keyA);
    await settle();

    assert.deepEqual(calls, [`POST ${registerUrl}`, `GET ${configUrl}`, `POST ${disconnectUrl}`]);
  });

  it('a registration that fails leaves the legacy one connected: the agent keeps SOME bot tools', async () => {
    const { adapter } = createAdapterWithSession();
    const calls = stubServer(adapter, { liveStatus: { [legacySchedulerMcpServerName]: connected }, failOn: registerUrl });

    await adapter.reconcileSchedulerMcpForActiveSessions();

    assert.ok(!calls.includes(`POST ${disconnectUrl}`), calls.join(' | '));
    assert.equal(adapter['schedulerMcpRetries'].size, 1, 'the registration retry is armed as before');
  });

  it('a disconnect that fails is retried like a failed registration, a bounded number of times, and the last log line says WHICH is standing', async () => {
    const { adapter } = createAdapterWithSession();
    const calls = stubServer(adapter, { liveStatus: { [schedulerMcpServerName]: connected, [legacySchedulerMcpServerName]: connected }, failOn: disconnectUrl });

    await assert.doesNotReject(adapter.reconcileSchedulerMcpForActiveSessions());
    assert.equal(adapter['schedulerMcpRetries'].size, 1, 'a retry is pending');

    for (const pause of schedulerMcpRetryDelaysMs) {
      mock.timers.tick(pause);
      await settle();
    }
    const disconnects = calls.filter((call) => call === `POST ${disconnectUrl}`).length;
    assert.equal(disconnects, 1 + schedulerMcpRetryDelaysMs.length, 'the boot try and one per pause, then it stops');
    assert.equal(adapter['schedulerMcpRetries'].size, 0, 'nothing left pending');

    const giveUp = warnings.at(-1) ?? '';
    assert.ok(giveUp.includes(legacySchedulerMcpServerName) && giveUp.includes('still connected'), giveUp);
    assert.ok(!giveUp.includes('not registered'), 'charness IS registered here — the line must not say it is not');
  });

  it('when the registration is what keeps failing, the last log line still says the scheduler MCP is not registered', async () => {
    const { adapter, keyA } = createAdapterWithSession();
    adapter['apiRequest'] = (async () => { throw new Error('server sick'); }) as OpenCodeAdapter['apiRequest'];

    adapter['connectSse'](keyA);
    await settle();
    for (const pause of schedulerMcpRetryDelaysMs) {
      mock.timers.tick(pause);
      await settle();
    }

    const giveUp = warnings.at(-1) ?? '';
    assert.ok(giveUp.includes('is still not registered'), giveUp);
    assert.ok(!giveUp.includes(legacySchedulerMcpServerName), 'and says nothing about the old name');
  });

  it('an operator\'s own server named charness is not taken for the bot\'s: the bot registers its own over it, and warns once', async () => {
    const { adapter } = createAdapterWithSession();
    // A recreated instance dropped the bot's runtime registration and brought the operator's back — a healthy server, `connected`.
    const calls = stubServer(adapter, {
      liveStatus: { [schedulerMcpServerName]: connected },
      config: { mcp: { [schedulerMcpServerName]: { type: 'remote', url: 'http://operator.invalid/mcp' } } },
    });

    await adapter.reconcileSchedulerMcpForActiveSessions();

    assert.deepEqual(calls, [`GET /mcp?directory=${encodeURIComponent(sharedDir)}`, `GET ${configUrl}`, `POST ${registerUrl}`], 'registered although the status says connected');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], new RegExp(`defines an MCP server named ${schedulerMcpServerName} — that name belongs to the bot`));
    assert.ok(!warnings[0].includes('operator.invalid'), 'the entry\'s url is not logged');
    assert.equal(adapter['registeredSchedulerMcpDirs'].has(sharedDir), true);
  });

  it('what the config says about a folder is read once however often it reconciles; the bot\'s own server is registered once per server generation', async () => {
    const { adapter } = createAdapterWithSession();
    const calls = stubServer(adapter, {
      liveStatus: { [schedulerMcpServerName]: connected },
      config: { mcp: { [schedulerMcpServerName]: { type: 'remote' }, [legacySchedulerMcpServerName]: { type: 'remote' } } },
    });

    await adapter.reconcileSchedulerMcpForActiveSessions();
    await adapter.reconcileSchedulerMcpForActiveSessions();
    await adapter.reconcileSchedulerMcpForActiveSessions();

    assert.equal(calls.filter((call) => call === `GET ${configUrl}`).length, 1, 'one GET /config for the folder');
    assert.equal(warnings.length, 1, 'one warning for the folder');
    assert.equal(
      calls.filter((call) => call === `POST ${registerUrl}`).length,
      1,
      'registered once: the gate shows this server generation already has the bot\'s own, and a second registration would cut the live connection',
    );

    // An instance recreate (or a server restart) drops the gate with the registration: the operator's server is back, so register again.
    adapter['registeredSchedulerMcpDirs'].delete(sharedDir);
    await adapter.reconcileSchedulerMcpForActiveSessions();
    assert.equal(calls.filter((call) => call === `POST ${registerUrl}`).length, 2, 'registered again once the gate was dropped');
  });

  it('a fresh bot process registers over the operator\'s charness at boot: its gate is empty, whatever the last process did', async () => {
    const { adapter } = createAdapterWithSession();
    const calls = stubServer(adapter, {
      liveStatus: { [schedulerMcpServerName]: connected },
      config: { mcp: { [schedulerMcpServerName]: { type: 'remote' } } },
    });
    assert.equal(adapter['registeredSchedulerMcpDirs'].has(sharedDir), false);

    await adapter.reconcileSchedulerMcpForActiveSessions();

    assert.ok(calls.includes(`POST ${registerUrl}`));
  });

  it('a session start in a folder whose config defines the bot\'s name warns too', async () => {
    const { adapter, keyA } = createAdapterWithSession();
    stubServer(adapter, { liveStatus: {}, config: { mcp: { [schedulerMcpServerName]: { type: 'remote' } } } });

    adapter['connectSse'](keyA);
    await settle();

    assert.equal(adapter['registeredSchedulerMcpDirs'].has(sharedDir), true, 'registered');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /belongs to the bot/);
  });

  it('when the config cannot be read, a connected charness is not taken for the bot\'s: the read is retried, a bounded number of times, then the last line says so', async () => {
    const { adapter } = createAdapterWithSession();
    const calls = stubServer(adapter, { liveStatus: { [schedulerMcpServerName]: connected }, failOn: configUrl });

    await assert.doesNotReject(adapter.reconcileSchedulerMcpForActiveSessions());
    assert.equal(adapter['schedulerMcpRetries'].size, 1, 'a retry is armed: whose the connected server is stays unknown until the config is read');
    assert.match(warnings[0], /reading the OpenCode config of .* failed/);

    for (const pause of schedulerMcpRetryDelaysMs) {
      mock.timers.tick(pause);
      await settle();
    }

    assert.equal(calls.filter((call) => call === `GET ${configUrl}`).length, 1 + schedulerMcpRetryDelaysMs.length, 'the boot read and one per pause');
    assert.ok(!calls.includes(`POST ${registerUrl}`), 'nothing is registered on a guess');
    assert.equal(adapter['schedulerMcpRetries'].size, 0, 'it stops after the last pause');
    // The bot's own charness is most likely in place and working: the line must not claim it is missing, only that it is not known.
    const giveUp = warnings.at(-1) ?? '';
    assert.match(giveUp, /could not be read, so it is not known whether the connected charness is the bot's/);
    assert.ok(!giveUp.includes('not registered') && !giveUp.includes('still connected'), giveUp);
    assert.ok(logLines.some((line) => line.includes('retrying the read of the OpenCode config')), `the retry lines say what is retried: ${logLines.join(' | ')}`);
    assert.ok(!logLines.some((line) => line.includes('retrying the scheduler MCP registration')), 'and never call it a registration');
  });

  it('when the config is read at a later try, the retry registers the bot\'s own over the operator\'s charness', async () => {
    const { adapter } = createAdapterWithSession();
    let configReads = 0;
    const calls: string[] = [];
    adapter['apiRequest'] = (async (method: string, url: string) => {
      calls.push(`${method} ${url}`);
      if (method === 'GET' && url === configUrl) {
        configReads += 1;
        if (configReads === 1) throw new Error('server sick');
        return { mcp: { [schedulerMcpServerName]: { type: 'remote' } } };
      }
      if (method === 'GET') return { [schedulerMcpServerName]: connected };
      return url === registerUrl ? { [schedulerMcpServerName]: connected } : undefined;
    }) as OpenCodeAdapter['apiRequest'];

    await adapter.reconcileSchedulerMcpForActiveSessions();
    assert.ok(!calls.includes(`POST ${registerUrl}`));
    mock.timers.tick(schedulerMcpRetryDelaysMs[0]);
    await settle();

    assert.ok(calls.includes(`POST ${registerUrl}`), 'registered once the config said the name is the operator\'s');
    assert.equal(adapter['schedulerMcpRetries'].size, 0, 'nothing left pending');
  });

  it('an operator-defined charness with an old-name disconnect that keeps failing is retried a bounded number of times, not forever', async () => {
    const { adapter } = createAdapterWithSession();
    const calls: string[] = [];
    adapter['apiRequest'] = (async (method: string, url: string) => {
      calls.push(`${method} ${url}`);
      if (method === 'POST' && url === disconnectUrl) throw new Error('server sick');
      if (method === 'GET' && url === configUrl) return { mcp: { [schedulerMcpServerName]: { type: 'remote' } } };
      if (method === 'GET') return { [schedulerMcpServerName]: connected, [legacySchedulerMcpServerName]: connected };
      return url === registerUrl ? { [schedulerMcpServerName]: connected, [legacySchedulerMcpServerName]: connected } : undefined;
    }) as OpenCodeAdapter['apiRequest'];

    await adapter.reconcileSchedulerMcpForActiveSessions();
    assert.equal(adapter['schedulerMcpRetries'].size, 1, 'a retry is pending');
    // Run well past the last pause: with the count reset by every registration the loop would never end.
    for (let round = 0; round < schedulerMcpRetryDelaysMs.length + 3; round += 1) {
      mock.timers.tick(schedulerMcpRetryDelaysMs[schedulerMcpRetryDelaysMs.length - 1]);
      await settle();
    }

    assert.equal(calls.filter((call) => call === `POST ${disconnectUrl}`).length, 1 + schedulerMcpRetryDelaysMs.length, 'the boot try and one per pause, then it stops');
    assert.equal(calls.filter((call) => call === `POST ${registerUrl}`).length, 1, 'while the registration is sent once: the retries do not cut a live connection each time');
    assert.equal(adapter['schedulerMcpRetries'].size, 0, 'nothing left pending');
    const giveUp = warnings.at(-1) ?? '';
    assert.ok(giveUp.includes(legacySchedulerMcpServerName) && giveUp.includes('still connected'), giveUp);
  });

  it('a registration that fails while a disconnect retry is pending turns the pending kind into "not registered"', async () => {
    const { adapter } = createAdapterWithSession();
    let statusReads = 0;
    adapter['apiRequest'] = (async (method: string, url: string) => {
      if (method === 'POST' && url === disconnectUrl) throw new Error('server sick');
      if (method === 'POST' && url === registerUrl) throw new Error('server sick');
      if (method === 'GET' && url === configUrl) return {};
      if (method === 'GET') {
        statusReads += 1;
        // The first read: charness is in place and the old name is not disconnectable. Later reads: charness is gone.
        return statusReads === 1 ? { [schedulerMcpServerName]: connected, [legacySchedulerMcpServerName]: connected } : { [legacySchedulerMcpServerName]: connected };
      }
      return undefined;
    }) as OpenCodeAdapter['apiRequest'];

    await adapter.reconcileSchedulerMcpForActiveSessions();
    for (const pause of schedulerMcpRetryDelaysMs) {
      mock.timers.tick(pause);
      await settle();
    }

    assert.equal(adapter['schedulerMcpRetries'].size, 0, 'it gave up');
    const giveUp = warnings.at(-1) ?? '';
    assert.ok(giveUp.includes('is still not registered'), giveUp);
    assert.ok(!giveUp.includes('still connected'), 'charness is what is missing here, not the old name that is in the way');
  });

  it('a folder whose config defines only the OLD name asks for the config once however often it reconciles', async () => {
    const { adapter } = createAdapterWithSession();
    const calls = stubServer(adapter, {
      liveStatus: { [schedulerMcpServerName]: connected, [legacySchedulerMcpServerName]: connected },
      config: { mcp: { [legacySchedulerMcpServerName]: { type: 'remote' } } },
    });

    await adapter.reconcileSchedulerMcpForActiveSessions();
    await adapter.reconcileSchedulerMcpForActiveSessions();

    assert.equal(calls.filter((call) => call === `GET ${configUrl}`).length, 1);
    assert.ok(!calls.includes(`POST ${disconnectUrl}`));
    assert.deepEqual(warnings, [], 'the old name in the operator\'s config is not a warning: it is theirs and it is left alone');
  });

  it('the retry keeps saying what is pending: a disconnect that failed stays "the old name is still connected" while the status reads fail', async () => {
    const { adapter } = createAdapterWithSession();
    let statusReads = 0;
    adapter['apiRequest'] = (async (method: string, url: string) => {
      if (method === 'POST' && url === disconnectUrl) throw new Error('server sick');
      if (method === 'GET' && url === configUrl) return {};
      if (method === 'GET') {
        statusReads += 1;
        if (statusReads > 1) throw new Error('server sick');
        return { [schedulerMcpServerName]: connected, [legacySchedulerMcpServerName]: connected };
      }
      return undefined;
    }) as OpenCodeAdapter['apiRequest'];

    await adapter.reconcileSchedulerMcpForActiveSessions();
    for (const pause of schedulerMcpRetryDelaysMs) {
      mock.timers.tick(pause);
      await settle();
    }

    assert.equal(adapter['schedulerMcpRetries'].size, 0, 'it gave up');
    const giveUp = warnings.at(-1) ?? '';
    assert.ok(giveUp.includes(legacySchedulerMcpServerName) && giveUp.includes('still connected'), giveUp);
    assert.ok(!giveUp.includes('not registered'), 'the reconcile\'s own failed status reads did not turn it into a registration problem');
  });

  it('a folder with no legacy registration gets its config read once and no disconnect', async () => {
    const { adapter } = createAdapterWithSession();
    const calls = stubServer(adapter, { liveStatus: { [schedulerMcpServerName]: connected, 'telegram-mcp': connected } });

    await adapter.reconcileSchedulerMcpForActiveSessions();

    assert.deepEqual(calls, [`GET /mcp?directory=${encodeURIComponent(sharedDir)}`, `GET ${configUrl}`]);
  });
});

describe('scheduler MCP registration retry after a failure', () => {
  const secret = 'a'.repeat(64);
  const port = 4097;
  const originalLog = console.log;
  const originalWarn = console.warn;

  beforeEach(() => {
    configureSchedulerMcpInjection({ getSecret: async () => secret, port });
    mock.timers.enable({ apis: ['setTimeout'] });
    console.log = () => {};
    console.warn = () => {};
  });
  afterEach(() => {
    mock.timers.reset();
    resetSchedulerMcpInjection();
    console.log = originalLog;
    console.warn = originalWarn;
  });

  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  }

  function createAdapterWithSession() {
    const adapter = createAdapter();
    const keyA: SessionKey = makeTelegramKey(-100, 1);
    adapter['sessions'].set(keyToString(keyA), makeSession(keyA, 'ses_A', sharedDir));
    return { adapter, keyA };
  }

  it('a registration that timed out after a server restart is retried and lands', async () => {
    const { adapter, keyA } = createAdapterWithSession();
    const calls: string[] = [];
    adapter['apiRequest'] = (async (method: string) => {
      calls.push(method);
      if (method === 'POST' && calls.filter((call) => call === 'POST').length === 1) {
        throw new Error('OpenCode request timed out after 30000ms');
      }
      if (method === 'GET') return {};
      return undefined;
    }) as OpenCodeAdapter['apiRequest'];

    adapter['connectSse'](keyA);
    await settle();
    assert.deepEqual(calls, ['POST'], 'the first registration failed');
    assert.equal(adapter['registeredSchedulerMcpDirs'].has(sharedDir), false);

    mock.timers.tick(schedulerMcpRetryDelaysMs[0]);
    await settle();
    assert.deepEqual(calls, ['POST', 'GET', 'POST', 'GET'], 'the retry read the live status, registered, then read the folder\'s config');
    assert.equal(adapter['registeredSchedulerMcpDirs'].has(sharedDir), true);
    assert.equal(adapter['schedulerMcpRetries'].size, 0, 'nothing left pending');
  });

  it('a timed-out registration that landed after all is not sent again', async () => {
    const { adapter, keyA } = createAdapterWithSession();
    const calls: string[] = [];
    adapter['apiRequest'] = (async (method: string) => {
      calls.push(method);
      if (method === 'POST') throw new Error('OpenCode request timed out after 30000ms');
      return { [schedulerMcpServerName]: { status: 'connected' } };
    }) as OpenCodeAdapter['apiRequest'];

    adapter['connectSse'](keyA);
    await settle();
    mock.timers.tick(schedulerMcpRetryDelaysMs[0]);
    await settle();

    assert.deepEqual(calls, ['POST', 'GET', 'GET'], 'the server already lists it as connected: only the folder\'s config is read besides');
    assert.equal(adapter['schedulerMcpRetries'].size, 0);
  });

  it('stops after the last pause while the server keeps failing', async () => {
    const { adapter, keyA } = createAdapterWithSession();
    const calls: string[] = [];
    adapter['apiRequest'] = (async (method: string) => {
      calls.push(method);
      throw new Error('server sick');
    }) as OpenCodeAdapter['apiRequest'];

    adapter['connectSse'](keyA);
    await settle();
    for (const delayMs of schedulerMcpRetryDelaysMs) {
      mock.timers.tick(delayMs);
      await settle();
    }
    mock.timers.tick(schedulerMcpRetryDelaysMs[schedulerMcpRetryDelaysMs.length - 1] * 10);
    await settle();

    assert.deepEqual(calls, ['POST', ...schedulerMcpRetryDelaysMs.map(() => 'GET')]);
    assert.equal(adapter['schedulerMcpRetries'].size, 0, 'gave up, nothing armed');
  });

  it('a retry due after the folder lost its last session does nothing', async () => {
    const { adapter, keyA } = createAdapterWithSession();
    const calls: string[] = [];
    adapter['apiRequest'] = (async (method: string) => {
      calls.push(method);
      throw new Error('server sick');
    }) as OpenCodeAdapter['apiRequest'];

    adapter['connectSse'](keyA);
    await settle();
    adapter['sessions'].get(keyToString(keyA))!.isActive = false;
    mock.timers.tick(schedulerMcpRetryDelaysMs[0]);
    await settle();

    assert.deepEqual(calls, ['POST']);
    assert.equal(adapter['schedulerMcpRetries'].size, 0);
  });

  it('getSchedulerMcpRetryDelayMs walks the pauses, then gives up', () => {
    assert.deepEqual(
      schedulerMcpRetryDelaysMs.map((_delay, attempt) => getSchedulerMcpRetryDelayMs(attempt)),
      [...schedulerMcpRetryDelaysMs],
    );
    assert.equal(getSchedulerMcpRetryDelayMs(schedulerMcpRetryDelaysMs.length), null);
  });
});

describe('compaction plugin activation at boot', () => {
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  let configHome = '';
  beforeEach(() => {
    // The activation installs the plugin into OpenCode's global plugin folder,
    // resolved from XDG_CONFIG_HOME — point it at a throwaway dir.
    configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-plugin-activation-'));
    process.env.XDG_CONFIG_HOME = configHome;
  });
  afterEach(() => {
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    fs.rmSync(configHome, { recursive: true, force: true });
  });

  function stubServer(adapter: OpenCodeAdapter, byDir: Record<string, { plugin: string[]; status: unknown }>) {
    const posts: string[] = [];
    adapter['apiRequest'] = (async (method: string, url: string) => {
      const directory = decodeURIComponent(new URL(url, 'http://x').searchParams.get('directory') ?? '');
      if (method === 'GET' && url.startsWith('/config?')) return { plugin: byDir[directory].plugin };
      if (method === 'GET' && url.startsWith('/session/status?')) return byDir[directory].status;
      if (method === 'POST') posts.push(url);
      return true;
    }) as OpenCodeAdapter['apiRequest'];
    return posts;
  }

  it('installs the plugin and recreates only the idle directory that lacks it', async () => {
    const adapter = createAdapter();
    const idleDir = '/work/idle';
    const busyDir = '/work/busy';
    const loadedDir = '/work/loaded';
    adapter['sessions'].set('-100:1', makeSession(makeTelegramKey(-100, 1), 'ses_1', idleDir));
    adapter['sessions'].set('-100:2', makeSession(makeTelegramKey(-100, 2), 'ses_2', busyDir));
    adapter['sessions'].set('-100:3', makeSession(makeTelegramKey(-100, 3), 'ses_3', loadedDir));
    adapter['registeredSchedulerMcpDirs'].add(idleDir);
    adapter['registeredSchedulerMcpDirs'].add(busyDir);
    // What the bot learned about each folder's own OpenCode config: a recreated instance reads the config afresh.
    adapter['configDefinedMcpNames'].set(idleDir, { isBotNameDefined: false, isLegacyNameDefined: false });
    adapter['configDefinedMcpNames'].set(busyDir, { isBotNameDefined: false, isLegacyNameDefined: false });
    const posts = stubServer(adapter, {
      [idleDir]: { plugin: ['opencode-pty'], status: {} },
      [busyDir]: { plugin: ['opencode-pty'], status: { ses_2: { type: 'busy' } } },
      [loadedDir]: {
        plugin: [`file://${configHome}/opencode/plugins/${openCodeCompactPluginFileName}`],
        status: {},
      },
    });
    const originalLog = console.log;
    console.log = () => {};
    try {
      await adapter.activateCompactionPluginForActiveSessions();
    } finally {
      console.log = originalLog;
    }

    assert.ok(
      fs.existsSync(path.join(configHome, 'opencode', 'plugins', openCodeCompactPluginFileName)),
      'plugin installed into the global plugin folder',
    );
    assert.deepEqual(posts, [`/instance/dispose?directory=${encodeURIComponent(idleDir)}`]);
    assert.equal(
      adapter['registeredSchedulerMcpDirs'].has(idleDir),
      false,
      'the recreated directory lost its MCP registration, so the reconcile must re-POST it',
    );
    assert.equal(adapter['registeredSchedulerMcpDirs'].has(busyDir), true, 'an untouched directory keeps its gate');
    assert.equal(adapter['configDefinedMcpNames'].has(idleDir), false, 'the recreated instance\'s config is read afresh');
    assert.equal(adapter['configDefinedMcpNames'].has(busyDir), true, 'an untouched directory keeps what was learned');
  });

  it('an idle directory whose instance loaded an OLDER plugin text is recreated as well; a busy one is left alone', async () => {
    const adapter = createAdapter();
    const outdatedIdleDir = '/work/outdated-idle';
    const outdatedBusyDir = '/work/outdated-busy';
    const pluginsUrl = `file://${configHome}/opencode/plugins`;
    adapter['sessions'].set('-100:1', makeSession(makeTelegramKey(-100, 1), 'ses_1', outdatedIdleDir));
    adapter['sessions'].set('-100:2', makeSession(makeTelegramKey(-100, 2), 'ses_2', outdatedBusyDir));
    const posts = stubServer(adapter, {
      // The first release's name and another content hash: what an instance reports that loaded a text older than the current one.
      [outdatedIdleDir]: { plugin: [`${pluginsUrl}/charness-compaction.js`], status: {} },
      [outdatedBusyDir]: { plugin: [`${pluginsUrl}/charness-compaction-00000000.js`], status: { ses_2: { type: 'busy' } } },
    });
    const originalLog = console.log;
    console.log = () => {};
    try {
      await adapter.activateCompactionPluginForActiveSessions();
    } finally {
      console.log = originalLog;
    }

    assert.deepEqual(posts, [`/instance/dispose?directory=${encodeURIComponent(outdatedIdleDir)}`]);
  });

  it('the bot sends the resume guidance itself unless the directory\'s instance loaded the CURRENT plugin', async () => {
    const adapter = createAdapter();
    const key = makeTelegramKey(-100, 1);
    const workDir = '/work/hook';
    adapter['sessions'].set('-100:1', makeSession(key, 'ses_1', workDir));
    const pluginsUrl = `file://${configHome}/opencode/plugins`;
    const stubPlugins = (plugin: string[]): void => {
      adapter['apiRequest'] = (async () => ({ plugin })) as OpenCodeAdapter['apiRequest'];
    };

    stubPlugins([`${pluginsUrl}/${openCodeCompactPluginFileName}`]);
    assert.equal(await adapter.checkHasCompactionResumeHook(key), true, 'the current plugin carries the guidance');
    stubPlugins([`${pluginsUrl}/charness-compaction.js`]);
    assert.equal(await adapter.checkHasCompactionResumeHook(key), false, 'a plugin of an older text lacks the checklist');
    stubPlugins([`${pluginsUrl}/charness-compaction-00000000.js`]);
    assert.equal(await adapter.checkHasCompactionResumeHook(key), false, 'a plugin of another content hash is an older text');
  });

  it('does nothing — not even the install — without an active session', async () => {
    const adapter = createAdapter();
    const posts = stubServer(adapter, {});
    await adapter.activateCompactionPluginForActiveSessions();
    assert.deepEqual(posts, []);
    assert.equal(fs.existsSync(path.join(configHome, 'opencode')), false);
  });
});

describe('checkNeedsSchedulerMcpReregister', () => {
  it('needs a register when charness is absent from the status map', () => {
    assert.equal(checkNeedsSchedulerMcpReregister({ 'telegram-mcp': { status: 'connected' } }), true);
  });
  it('needs a register when charness is failed', () => {
    assert.equal(checkNeedsSchedulerMcpReregister({ charness: { status: 'failed', error: 'x' } }), true);
  });
  it('does NOT need a register when charness is connected', () => {
    assert.equal(checkNeedsSchedulerMcpReregister({ charness: { status: 'connected' } }), false);
  });
  it('treats a malformed/empty response as needing a register', () => {
    assert.equal(checkNeedsSchedulerMcpReregister(null), true);
    assert.equal(checkNeedsSchedulerMcpReregister(undefined), true);
    assert.equal(checkNeedsSchedulerMcpReregister('nope'), true);
    assert.equal(checkNeedsSchedulerMcpReregister([]), true);
    assert.equal(checkNeedsSchedulerMcpReregister({}), true);
    assert.equal(checkNeedsSchedulerMcpReregister({ charness: null }), true);
    assert.equal(checkNeedsSchedulerMcpReregister({ charness: ['connected'] }), true, 'an entry that is not a record');
    assert.equal(checkNeedsSchedulerMcpReregister({ charness: { status: 3 } }), true);
  });
});

describe('the stall watchdog aborts its own stream', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout'] });
  });
  afterEach(() => {
    mock.timers.reset();
  });

  it('arming the watchdog and letting it fire aborts the stream controller', () => {
    const adapter = createAdapter();
    const controller = new AbortController();
    const stream = {
      directory: '<global>',
      controller,
      stallTimer: null,
      reconnectTimer: null,
      isClosed: false,
    };

    adapter['armSseStallWatchdog'](stream, controller);
    assert.equal(controller.signal.aborted, false, 'not aborted before the timeout');

    // sseStallTimeoutMs = 4 × 10s heartbeat = 40s; advance past it.
    mock.timers.tick(40_000 + 1);
    assert.equal(controller.signal.aborted, true, 'the stall watchdog aborts its own controller');
    assert.equal(stream.stallTimer, null, 'the fired timer handle is cleared');
  });

  it('clearStreamStallTimer disarms an armed watchdog so it never fires', () => {
    const adapter = createAdapter();
    const controller = new AbortController();
    const stream = {
      directory: '<global>',
      controller,
      stallTimer: null,
      reconnectTimer: null,
      isClosed: false,
    };

    adapter['armSseStallWatchdog'](stream, controller);
    adapter['clearStreamStallTimer'](stream);
    mock.timers.tick(40_000 + 1);
    assert.equal(controller.signal.aborted, false, 'a cleared watchdog does not abort');
  });
});
