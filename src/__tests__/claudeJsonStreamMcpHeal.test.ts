/**
 * @description The json-stream adapter's MCP heal round-trip
 * (`healMcpServer`): a session that survived a bot restart keeps its injected
 * `telegramBot` server latched `failed` (the CLI never retries one), so the bot
 * asks `mcp_status` over the stdio control channel and reconnects only what is
 * really broken.
 *
 * Load-bearing intent (per `.claude/rules/tests.md`):
 *   - a `failed` server must produce a SECOND frame — the `mcp_reconnect` — and
 *     the method must report `healed` only once that reconnect was acked;
 *   - a `connected` (or `needs-auth`) server must produce NO reconnect frame at
 *     all: writing into a healthy live session is the risk this path must avoid;
 *   - replies are matched by `request_id`, so a response for someone else's id
 *     must NOT settle our awaiter (that would report an outcome nobody measured);
 *   - a reply must still settle while a bot-issued `/compact` turn is suppressing
 *     that turn's output — the suppression is about the TURN, not our channel;
 *   - the spawn-time `initialize` handshake settles through this same path, so
 *     neither it nor a heal reply may settle the other's awaiter;
 *   - a teardown while a request is parked must settle it, so a caller can never
 *     be left hanging on a dead session.
 *
 * The adapter's private session map is reached via runtime bracket access (tests
 * are type-stripped by tsx), same pattern as `claudeJsonStreamTransport`. Stdin
 * is a plain file here instead of a FIFO, so the exact frames written can be
 * read back; no `claude` process is involved.
 *
 * Test case: N/A — TelegramCode has no Jira tracker.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ClaudeJsonStreamAdapter } from '../adapters/claudeJsonStreamAdapter';
import { ClaudeStreamLineReader } from '../utils/claudeStreamJson';
import { createStdoutTailState, getJsonStreamSessionPaths } from '../utils/jsonStreamHost';
import { schedulerMcpServerName } from '../scheduler/injection';
import { keyToString, type SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';

// A key no live thread uses — every path derived from it is a no-op.
const key: SessionKey = makeTelegramKey(-100999777, 77);

/**
 * A fake LIVE session whose stdin is an ordinary append-mode file, so the frames
 * the adapter writes are readable. `pid` is this process (alive) and no exitcode
 * file exists, so the tail poll `writeStdin` arms stays a harmless no-op.
 */
function createSession(adapter: ClaudeJsonStreamAdapter, dir: string) {
  const paths = getJsonStreamSessionPaths(dir);
  fs.writeFileSync(paths.stdinFifo, '');
  const session = {
    key,
    workDir: dir,
    sessionId: 'sess-mcp-heal',
    pid: process.pid,
    paths,
    fifoFd: fs.openSync(paths.stdinFifo, 'a'),
    stdinWriteChain: Promise.resolve(),
    tail: createStdoutTailState(0),
    pollTimer: null,
    pollDelayMs: 300,
    unchangedStreak: 0,
    isOversizeWarned: false,
    lastPersistedTailOffset: 0,
    reader: new ClaudeStreamLineReader(),
    isActive: true,
    isStopping: false,
    isRespawning: false,
    isBusy: false,
    lastStdoutActivityAt: Date.now(),
    outstandingToolUseIds: new Set<string>(),
    model: null,
    reportedModel: null,
    effort: null,
    currentResponseText: '',
    emittedLength: 0,
    outputTimer: null,
    reasoningText: '',
    reasoningStartedAt: null,
    reasoningTimer: null,
    reasoningActive: false,
    toolNamesById: new Map(),
    questionToolUseIds: new Set(),
    subagentActive: false,
    childResponseText: '',
    childEmittedLength: 0,
    childOutputTimer: null,
    // Nullable in `StreamSession`; annotated so a test may arm the handshake.
    pendingInitResolve: null as (() => void) | null,
    initRequestId: null as string | null,
    pendingControlRequests: new Map(),
    compactionInProgress: false,
    pendingCompaction: null,
    pendingQuestion: null,
    apiErrorFired: false,
    swallowNextAbortError: false,
    lastWatermarkOffset: -1,
  };
  adapter['sessions'].set(keyToString(key), session);
  return session;
}

/** Every stream-json frame the adapter has written to stdin so far. */
function readStdinFrames(stdinPath: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(stdinPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Wait for the adapter's serialised stdin chain to have written `count` frames. */
async function waitForStdinFrames(stdinPath: string, count: number): Promise<Array<Record<string, unknown>>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const frames = readStdinFrames(stdinPath);
    if (frames.length >= count) return frames;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`the adapter never wrote ${count} stdin frame(s)`);
}

/** Let queued microtasks/timers run so a settled promise records its result. */
async function settleTicks(): Promise<void> {
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

/** The measured `mcp_status` reply: an inner record listing the servers. */
function buildStatusResponseLine(requestId: string, status: string): string {
  return JSON.stringify({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: { mcpServers: [{ name: schedulerMcpServerName, status }] },
    },
  }) + '\n';
}

/** The measured `mcp_reconnect` reply: a bare success ack, no inner record. */
function buildAckLine(requestId: string): string {
  return JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId } }) + '\n';
}

function readRequestSubtype(frame: Record<string, unknown>): unknown {
  return (frame.request as Record<string, unknown>).subtype;
}

describe('json-stream adapter — healMcpServer round-trip', () => {
  let dir = '';
  let openFd: number | null = null;
  let adapter: ClaudeJsonStreamAdapter | null = null;
  let session: ReturnType<typeof createSession> | null = null;

  afterEach(() => {
    if (adapter && session) adapter['clearTimers'](session);
    if (openFd !== null) { try { fs.closeSync(openFd); } catch { /* already closed */ } }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    openFd = null;
    adapter = null;
    session = null;
  });

  function start(prefix: string) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    adapter = new ClaudeJsonStreamAdapter();
    session = createSession(adapter, dir);
    openFd = session.fifoFd;
    return { adapter, session };
  }

  it('a failed server is reconnected, and only then reported healed', async () => {
    const started = start('jsonstream-heal-failed-');
    const healPromise = started.adapter.healMcpServer(key, schedulerMcpServerName);

    const [statusFrame] = await waitForStdinFrames(started.session.paths.stdinFifo, 1);
    assert.equal(statusFrame.type, 'control_request');
    assert.equal(readRequestSubtype(statusFrame), 'mcp_status');
    const statusRequestId = statusFrame.request_id as string;

    // A response for an id we are NOT waiting on must not settle the heal.
    let isSettled = false;
    void healPromise.then(() => { isSettled = true; });
    started.adapter['onStdout'](started.session, buildAckLine('mcp_status_someone_else'));
    await settleTicks();
    assert.equal(isSettled, false, 'a foreign request_id must not settle our awaiter');
    assert.equal(readStdinFrames(started.session.paths.stdinFifo).length, 1, 'and must not trigger a reconnect');

    started.adapter['onStdout'](started.session, buildStatusResponseLine(statusRequestId, 'failed'));
    const frames = await waitForStdinFrames(started.session.paths.stdinFifo, 2);
    const reconnectFrame = frames[1];
    assert.equal(readRequestSubtype(reconnectFrame), 'mcp_reconnect');
    assert.equal((reconnectFrame.request as Record<string, unknown>).serverName, schedulerMcpServerName);
    assert.notEqual(reconnectFrame.request_id, statusRequestId, 'each round-trip gets its own id');

    started.adapter['onStdout'](started.session, buildAckLine(reconnectFrame.request_id as string));
    assert.equal(await healPromise, 'healed');
  });

  it('a failed server whose reconnect answers `error` is NOT reported healed', async () => {
    const started = start('jsonstream-heal-reconnect-error-');
    const healPromise = started.adapter.healMcpServer(key, schedulerMcpServerName);

    const [statusFrame] = await waitForStdinFrames(started.session.paths.stdinFifo, 1);
    started.adapter['onStdout'](started.session, buildStatusResponseLine(statusFrame.request_id as string, 'failed'));
    const frames = await waitForStdinFrames(started.session.paths.stdinFifo, 2);
    started.adapter['onStdout'](started.session, JSON.stringify({
      type: 'control_response',
      response: { subtype: 'error', request_id: frames[1].request_id, error: 'No such server' },
    }) + '\n');

    assert.equal(await healPromise, 'unavailable');
  });

  it('settles while a bot-issued /compact turn is suppressing that turn output', async () => {
    const started = start('jsonstream-heal-compacting-');
    // `compactionInProgress` swallows the compaction turn's OWN frames. A reply to
    // one of our control requests is not that turn's output, so it must still
    // reach its awaiter — otherwise a heal that lands during a compaction can
    // only end on the round-trip timeout, reported as `unavailable`.
    started.session.compactionInProgress = true;
    const healPromise = started.adapter.healMcpServer(key, schedulerMcpServerName);

    const [statusFrame] = await waitForStdinFrames(started.session.paths.stdinFifo, 1);
    started.adapter['onStdout'](started.session, buildStatusResponseLine(statusFrame.request_id as string, 'failed'));
    const frames = await waitForStdinFrames(started.session.paths.stdinFifo, 2);
    started.adapter['onStdout'](started.session, buildAckLine(frames[1].request_id as string));

    assert.equal(await healPromise, 'healed');
    assert.equal(started.session.isBusy, false, 'a control round-trip is not a turn — it must never mark the session busy');
  });

  it('a connected server is left strictly alone (no reconnect frame)', async () => {
    const started = start('jsonstream-heal-connected-');
    const healPromise = started.adapter.healMcpServer(key, schedulerMcpServerName);

    const [statusFrame] = await waitForStdinFrames(started.session.paths.stdinFifo, 1);
    started.adapter['onStdout'](started.session, buildStatusResponseLine(statusFrame.request_id as string, 'connected'));

    assert.equal(await healPromise, 'healthy');
    assert.equal(readStdinFrames(started.session.paths.stdinFifo).length, 1, 'nothing more may be written to a healthy session');
  });

  it('a needs-auth server is skipped, not reconnected in a loop', async () => {
    const started = start('jsonstream-heal-needsauth-');
    const healPromise = started.adapter.healMcpServer(key, schedulerMcpServerName);

    const [statusFrame] = await waitForStdinFrames(started.session.paths.stdinFifo, 1);
    started.adapter['onStdout'](started.session, buildStatusResponseLine(statusFrame.request_id as string, 'needs-auth'));

    assert.equal(await healPromise, 'skipped');
    assert.equal(readStdinFrames(started.session.paths.stdinFifo).length, 1);
  });

  it('a server missing from the status list is skipped (nothing known to act on)', async () => {
    const started = start('jsonstream-heal-absent-');
    const healPromise = started.adapter.healMcpServer(key, schedulerMcpServerName);

    const [statusFrame] = await waitForStdinFrames(started.session.paths.stdinFifo, 1);
    started.adapter['onStdout'](started.session, JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: statusFrame.request_id,
        response: { mcpServers: [{ name: 'someOtherServer', status: 'connected' }] },
      },
    }) + '\n');

    assert.equal(await healPromise, 'skipped');
    assert.equal(readStdinFrames(started.session.paths.stdinFifo).length, 1);
  });

  it('a teardown while the status request is parked settles the caller as unavailable', async () => {
    const started = start('jsonstream-heal-teardown-');
    const healPromise = started.adapter.healMcpServer(key, schedulerMcpServerName);
    await waitForStdinFrames(started.session.paths.stdinFifo, 1);

    // The session is going away (stop / exit / respawn) — the reply can never
    // arrive, so the awaiter must settle now instead of on the 15s timeout.
    started.adapter['clearTimers'](started.session);
    assert.equal(await healPromise, 'unavailable');
    assert.equal(started.session.pendingControlRequests.size, 0, 'no awaiter is left keyed by a dead session');
  });

  // The spawn-time `initialize` handshake settles through the SAME
  // control_response path the heal added, so these pin that it still does — and
  // that neither awaiter can settle the other's reply.
  it('still settles the spawn-time initialize handshake, and only for its own id', () => {
    const started = start('jsonstream-heal-init-');
    let initResolveCount = 0;
    started.session.initRequestId = 'init_abc';
    started.session.pendingInitResolve = () => { initResolveCount += 1; };

    started.adapter['onStdout'](started.session, buildAckLine('init_someone_else'));
    assert.equal(initResolveCount, 0, 'a foreign id must not resolve the handshake');

    started.adapter['onStdout'](started.session, buildAckLine('init_abc'));
    assert.equal(initResolveCount, 1);
  });

  it('a pending initialize handshake does not swallow a heal reply', async () => {
    const started = start('jsonstream-heal-init-pending-');
    let isInitResolved = false;
    started.session.initRequestId = 'init_still_pending';
    started.session.pendingInitResolve = () => { isInitResolved = true; };

    const healPromise = started.adapter.healMcpServer(key, schedulerMcpServerName);
    const [statusFrame] = await waitForStdinFrames(started.session.paths.stdinFifo, 1);
    started.adapter['onStdout'](started.session, buildStatusResponseLine(statusFrame.request_id as string, 'connected'));

    assert.equal(await healPromise, 'healthy');
    assert.equal(isInitResolved, false, 'the heal reply is not the handshake reply');
  });

  it('reports unavailable with no live session, without writing anything', async () => {
    const adapterWithoutSession = new ClaudeJsonStreamAdapter();
    assert.equal(await adapterWithoutSession.healMcpServer(key, schedulerMcpServerName), 'unavailable');
  });
});
