/**
 * @description A json-stream session ADOPTED at a bot restart is read only once the boot has restored its state
 * (`releaseAdoptedTails`, the boot's `releaseAdoptedSessions` step). What its process wrote while the bot was down replays
 * through the live handlers, which read it against that state: read during the reattach, a usage-limit error that ended a
 * turn before the boot was handled as a live one ahead of the boot recovery (a «usage limit» notice for a window already
 * over, the retry armed twice). Proven here, on the adapter:
 *
 *   • the real adopt of a live process leaves its tail held — no read armed — and the replay comes only after the release;
 *   • nothing reads a held tail: `refreshWorkingState` (the automatic stop's last look) waits for the release like the poll;
 *   • `whenAdoptReplayed` — what the forward, the per-turn stop of an adopted process and the idle fire wait for — waits for
 *     the release also when nothing was behind the tail, and lets go when the session ends while held.
 *
 * `tmux` is a stub first on PATH that names the one session, so no server is touched; the process is a real `sleep`, its
 * stdin FIFO is held open for reading by the test (as the CLI holds it). The adapter's private parts are reached via bracket
 * access, as in the other json-stream adapter tests.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ClaudeJsonStreamAdapter, type StreamSession } from '../adapters/claudeJsonStreamAdapter';
import { keyToString, type SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { buildJsonStreamTmuxSessionName, getJsonStreamSessionPaths, resolveJsonStreamSessionDir } from '../utils/jsonStreamHost';
import { createStreamSessionFixture } from './claudeJsonStreamSessionFixture';

const key: SessionKey = makeTelegramKey(-100999781, 81);
const sessionName = buildJsonStreamTmuxSessionName(key);
const claudeSessionId = 'sess-adopt-hold';
const textDeltaLine =
  JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'replayed text' } } }) + '\n';
/** The turn that ran into a usage limit while the bot was down, the way the CLI ends it. */
const usageLimitResultLine =
  JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your session limit · resets 10:20am (UTC)" }) + '\n';
/** A release whose first read never comes within a test: what the release itself does is looked at, not the poll. */
const distantFirstReadMs = 60_000;
/** The bound of a wait that must settle at once; a hang fails the test instead of the file's timeout. */
const settleBoundMs = 5_000;

/** Whether `promise` settles within {@link settleBoundMs}. */
async function checkSettlesSoon(promise: Promise<void>): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), settleBoundMs); }),
  ]);
  clearTimeout(timer);
  return outcome;
}

/** Whether `promise` is still pending once everything already queued has run. */
async function checkIsStillPending(promise: Promise<void>): Promise<boolean> {
  let isSettled = false;
  void promise.then(() => { isSettled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  return !isSettled;
}

/** The apiError events an adapter emits, in order. */
function recordApiErrors(adapter: ClaudeJsonStreamAdapter): Array<{ kind: string; isReplayed?: boolean }> {
  const errors: Array<{ kind: string; isReplayed?: boolean }> = [];
  adapter.on('apiError', (_key: SessionKey, error: { kind: string; isReplayed?: boolean }) => errors.push(error));
  return errors;
}

describe('a json-stream session adopted at a restart is read only from the boot\'s release', () => {
  let stubDir = '';
  let dataDir = '';
  let originalPath: string | undefined;
  let originalDataDir: string | undefined;
  const children: ChildProcess[] = [];
  const openFds: number[] = [];
  const sessions: StreamSession[] = [];
  const fixtureDirs: string[] = [];

  before(() => {
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstream-adopthold-tmux-'));
    // `list-sessions` names the adopted session; every other call (a kill at a stop) does nothing.
    fs.writeFileSync(path.join(stubDir, 'tmux'), `#!/bin/sh\ncase "$*" in *list-sessions*) echo '${sessionName}' ;; esac\n`, { mode: 0o755 });
    originalPath = process.env.PATH;
    process.env.PATH = `${stubDir}${path.delimiter}${originalPath ?? ''}`;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstream-adopthold-data-'));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;
  });

  after(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    fs.rmSync(stubDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  afterEach(() => {
    for (const session of sessions.splice(0)) {
      if (session.pollTimer) clearTimeout(session.pollTimer);
      session.pollTimer = null;
      session.isActive = false;
      if (session.fifoFd >= 0) fs.closeSync(session.fifoFd);
      session.fifoFd = -1;
    }
    for (const fd of openFds.splice(0)) fs.closeSync(fd);
    for (const child of children.splice(0)) child.kill('SIGKILL');
    for (const dir of fixtureDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A held session as the adopt leaves it, on a stdout log holding `log`; `catchUpBytes` behind the tail (`null`: none). */
  function createHeldSession(adapter: ClaudeJsonStreamAdapter, log: string, catchUpBytes: number | null): StreamSession {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstream-adopthold-session-'));
    fixtureDirs.push(dir);
    const session = createStreamSessionFixture({
      key,
      workDir: '/tmp/jsonstream-adopthold-work',
      sessionId: claudeSessionId,
      paths: getJsonStreamSessionPaths(dir),
      isTailHeld: true,
      adoptCatchUpOffset: catchUpBytes,
    });
    fs.writeFileSync(session.paths.stdoutFile, log);
    adapter['sessions'].set(keyToString(key), session);
    sessions.push(session);
    return session;
  }

  it('the adopt of a live process leaves its tail held — no read armed — and the downtime replay comes only after the release', async () => {
    const paths = getJsonStreamSessionPaths(resolveJsonStreamSessionDir(dataDir, key));
    fs.mkdirSync(paths.dir, { recursive: true });
    const agentProcess = spawn('sleep', ['60'], { stdio: 'ignore' });
    children.push(agentProcess);
    assert.ok(agentProcess.pid, 'the stand-in process started');
    fs.writeFileSync(paths.pidFile, `${agentProcess.pid}\n`);
    assert.equal(spawnSync('mkfifo', [paths.stdinFifo]).status, 0, 'the stdin FIFO was made');
    // The CLI holds its stdin FIFO open: without a reader the adopt reads the process as dead.
    openFds.push(fs.openSync(paths.stdinFifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK));
    // The turn that ran to a usage limit while the bot was down, after the offset the last bot saved (the log's start).
    fs.writeFileSync(paths.stdoutFile, textDeltaLine + usageLimitResultLine);

    const adapter = new ClaudeJsonStreamAdapter();
    const errors = recordApiErrors(adapter);
    const outputs: string[] = [];
    adapter.on('output', (_key: SessionKey, text: string) => outputs.push(text));
    const isAdopted = await adapter.adoptExistingTmuxSession(key, sessionName, '/tmp/jsonstream-adopthold-work', claudeSessionId, { sessionId: claudeSessionId, offsetBytes: 0 });
    assert.equal(isAdopted, true, 'the live process is adopted');
    const session: StreamSession | undefined = adapter['sessions'].get(keyToString(key));
    assert.ok(session, 'the adopted session is tracked');
    sessions.push(session);

    assert.equal(session.isTailHeld, true, 'the adopt holds the tail');
    assert.equal(session.pollTimer, null, 'no read is armed until the boot releases it');
    assert.equal(adapter.checkIsAdoptReplayPending(key), true);
    const replayed = adapter.whenAdoptReplayed(key);
    assert.equal(await checkIsStillPending(replayed), true, 'the replay waits for the release');
    assert.equal(errors.length, 0, 'nothing of the downtime is read before the release');

    adapter.releaseAdoptedTails(1);
    assert.equal(await checkSettlesSoon(replayed), true, 'the replay is read once released');
    assert.deepEqual(errors.map((error) => [error.kind, error.isReplayed === true]), [['usageLimit', true]], 'the limit error, read after the release, as a replayed one');
    assert.ok(outputs.some((text) => text.includes('replayed text')), 'the downtime text is delivered too');
  });

  it('refreshWorkingState — the automatic stop\'s last look — reads nothing of a held tail; once released it reads the replay', () => {
    const adapter = new ClaudeJsonStreamAdapter();
    const errors = recordApiErrors(adapter);
    const session = createHeldSession(adapter, usageLimitResultLine, Buffer.byteLength(usageLimitResultLine));
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    try {
      adapter.refreshWorkingState(key);
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(errors.length, 0, 'the downtime error is not read before the release');
    assert.equal(session.tail.consumedBytes, 0, 'nothing of the log is consumed');
    assert.ok(warnings.some((line) => line.includes('before the boot released the adopted session')), 'a look that came too early is logged');

    adapter.releaseAdoptedTails(distantFirstReadMs);
    adapter.refreshWorkingState(key);
    assert.deepEqual(errors.map((error) => error.isReplayed === true), [true], 'after the release the look reads the replay');
  });

  it('with nothing behind the tail, whenAdoptReplayed still waits for the release: an idle fire or a stop then decides on what the process wrote since', async () => {
    const adapter = new ClaudeJsonStreamAdapter();
    createHeldSession(adapter, '', null);
    assert.equal(adapter.checkIsAdoptReplayPending(key), true, 'held: not read yet');
    const replayed = adapter.whenAdoptReplayed(key);
    assert.equal(await checkIsStillPending(replayed), true);

    adapter.releaseAdoptedTails(distantFirstReadMs);
    assert.equal(adapter.checkIsAdoptReplayPending(key), false);
    assert.equal(await checkSettlesSoon(replayed), true, 'released with nothing to replay: settled by the release itself');
  });

  it('a held session that ends lets everyone waiting for its replay go', async () => {
    const adapter = new ClaudeJsonStreamAdapter();
    createHeldSession(adapter, '', null);
    const replayed = adapter.whenAdoptReplayed(key);
    await adapter['stopSessionInternal'](key);
    assert.equal(await checkSettlesSoon(replayed), true);
    assert.equal(adapter.checkIsAdoptReplayPending(key), false, 'no session, nothing pending');
  });
});
