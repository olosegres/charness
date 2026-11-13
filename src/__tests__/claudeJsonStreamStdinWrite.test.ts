/**
 * @description The json-stream adapter's user-turn write into the CLI's stdin FIFO: a write that fails is the
 * forward's failure, not a prompt believed delivered. Seen live: a resumed session whose CLI was still starting met
 * `EAGAIN` for the old 5 s budget, the error was only logged, and the request core counted the hand-over prompt as
 * delivered — the agent never read it.
 *
 * Load-bearing intent:
 *   - `sendInputAndWait` REJECTS when its frame was not written whole, and resolves once it was; `sendInput`, the
 *     fire-and-forget form every other caller uses, never throws and leaves no unhandled rejection;
 *   - a failed write takes back what the turn start set — the unconsumed-input count, and the busy flag while the CLI
 *     showed no life — so the turn probes read the session as it is (a retry is not held off by a phantom busy turn);
 *   - a frame the stall left with NOTHING written keeps the stream intact: the next write goes through;
 *   - a frame left HALF-written breaks the stream: nothing more is written into it (every later write rejects at once,
 *     the FIFO untouched) and the process is suspended, so the conversation's next trigger resumes it in a fresh one.
 *
 * The FIFO write is the adapter's test seam (`writeFifo`): a reader that stalls or stops mid-frame cannot be made
 * portably with a real pipe. The session is the shared fixture; no `claude` process is involved.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ClaudeJsonStreamAdapter, type StreamSession } from '../adapters/claudeJsonStreamAdapter';
import { FifoWriteError, openFifoWriterNonBlocking, type FifoWriteOptions } from '../utils/jsonStreamHost';
import { keyToString, type SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { createStreamSessionFixture } from './claudeJsonStreamSessionFixture';

const key: SessionKey = makeTelegramKey(-100999777, 78);

/** What the stand-in FIFO does with each frame, in order: write it, or fail with the given error. */
type FrameOutcome = 'written' | FifoWriteError | Error;

function createAdapter(outcomes: FrameOutcome[]): { adapter: ClaudeJsonStreamAdapter; written: string[]; calls: () => number; suspended: SessionKey[] } {
  const written: string[] = [];
  let callCount = 0;
  const adapter = new ClaudeJsonStreamAdapter({
    lifecycle: 'idle',
    writeFifo: async (_fd: number, text: string, _options?: FifoWriteOptions) => {
      const outcome = outcomes[callCount] ?? 'written';
      callCount += 1;
      if (outcome !== 'written') throw outcome;
      written.push(text);
    },
  });
  const suspended: SessionKey[] = [];
  adapter.suspendSession = async (suspendedKey) => {
    suspended.push(suspendedKey);
  };
  return { adapter, written, calls: () => callCount, suspended };
}

/** Every adapter and session a test made: their tail-poll timers (a write snaps the poll back) are cleared after it. */
const created: Array<{ adapter: ClaudeJsonStreamAdapter; session: StreamSession }> = [];

/** A live session: `pid` is this process, so the tail poll a write arms never reads it as exited. */
function addSession(adapter: ClaudeJsonStreamAdapter, overrides: Partial<StreamSession> = {}): StreamSession {
  const session = createStreamSessionFixture({ key, pid: process.pid, ...overrides });
  adapter['sessions'].set(keyToString(key), session);
  created.push({ adapter, session });
  return session;
}

afterEach(() => {
  for (const { adapter, session } of created.splice(0)) adapter['clearTimers'](session);
});

/** Let the write chain's own handler run. */
const settleTicks = async (): Promise<void> => {
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setImmediate(resolve));
};

describe('json-stream adapter — a user turn that does not reach the CLI fails its forward', () => {
  it('a frame written whole resolves sendInputAndWait; the turn start is set and stays', async () => {
    const { adapter, written } = createAdapter(['written']);
    const session = addSession(adapter);
    await adapter.sendInputAndWait(key, 'please handle PROJ-1');
    assert.deepEqual(written.map((line) => JSON.parse(line)), [{ type: 'user', message: { role: 'user', content: 'please handle PROJ-1' } }]);
    assert.equal(session.isBusy, true);
    assert.equal(session.unconsumedInputCount, 1, 'counted until the CLI echoes it');
  });

  it('EAGAIN past the stall budget with NOTHING written rejects the forward, takes back the turn start, and leaves the stream usable', async () => {
    const stalled = new FifoWriteError('EAGAIN: the reader took nothing for 120 s (0 of 70 bytes written)', 0, 70);
    const { adapter, written, suspended } = createAdapter([stalled, 'written']);
    const session = addSession(adapter);
    await assert.rejects(adapter.sendInputAndWait(key, 'please handle PROJ-1'), stalled);
    assert.equal(session.isBusy, false, 'not busy: nothing reached the CLI');
    assert.equal(session.unconsumedInputCount, 0, 'no echo is owed for a turn that was never written');
    assert.equal(session.isStdinBroken, false, 'nothing of the frame was written: the stream is intact');
    assert.deepEqual(suspended, []);
    // The retry goes through the same stream.
    await adapter.sendInputAndWait(key, 'please handle PROJ-1');
    assert.equal(written.length, 1);
    assert.equal(session.isBusy, true);
  });

  it('a session that was busy stays busy after a failed write: the turn it is in still runs', async () => {
    const { adapter } = createAdapter([new FifoWriteError('EPIPE: write (0 of 10 bytes written)', 0, 10)]);
    const session = addSession(adapter, { isBusy: true, unconsumedInputCount: 0 });
    await assert.rejects(adapter.sendInputAndWait(key, 'a message written mid-turn'));
    assert.equal(session.isBusy, true);
  });

  it('sendInput (fire and forget) never throws and leaves no unhandled rejection when its write fails', async () => {
    const { adapter } = createAdapter([new Error('EBADF: bad file descriptor, write')]);
    addSession(adapter);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      adapter.sendInput(key, 'y');
      await settleTicks();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    assert.deepEqual(unhandled, []);
  });

  it('a frame left HALF-written breaks the stream: the forward rejects, nothing more is written into it, and the process is suspended', async () => {
    const torn = new FifoWriteError('EAGAIN: the reader took nothing for 120 s (64 of 100 bytes written)', 64, 100);
    const { adapter, calls, suspended } = createAdapter([torn]);
    const session = addSession(adapter);
    await assert.rejects(adapter.sendInputAndWait(key, 'a long hand-over prompt'), torn);
    await settleTicks();
    assert.equal(session.isStdinBroken, true);
    assert.deepEqual(suspended.map(keyToString), [keyToString(key)], 'suspended: its next trigger resumes it in a fresh process');
    // The next turn never reaches the stream: it would be read as the rest of the torn line.
    await assert.rejects(adapter.sendInputAndWait(key, 'the retry'), /the stdin stream is broken/);
    assert.equal(calls(), 1, 'the FIFO was not written again');
  });

  it('a torn frame of a session being stopped (the write was abandoned) is not a broken stream: the stop is under way anyway', async () => {
    const torn = new FifoWriteError('the write was abandoned: the process is being stopped (10 of 100 bytes written)', 10, 100);
    const { adapter, suspended } = createAdapter([torn]);
    const session = addSession(adapter, { isStopping: true });
    await assert.rejects(adapter.sendInputAndWait(key, 'too late'));
    await settleTicks();
    assert.equal(session.isStdinBroken, false);
    assert.deepEqual(suspended, []);
  });
});

describe('json-stream adapter — frames keep their order, and a big one lands whole', () => {
  it('a second frame queued while the first is still being written starts only after the first resolved', async () => {
    const events: string[] = [];
    let releaseFirst: () => void = () => {};
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const adapter = new ClaudeJsonStreamAdapter({
      lifecycle: 'idle',
      writeFifo: async (_fd: number, text: string) => {
        const content = (JSON.parse(text) as { message: { content: string } }).message.content;
        events.push(`start ${content}`);
        if (content === 'first') await firstHeld;
        events.push(`end ${content}`);
      },
    });
    addSession(adapter);
    const first = adapter.sendInputAndWait(key, 'first');
    const second = adapter.sendInputAndWait(key, 'second');
    await settleTicks();
    assert.deepEqual(events, ['start first'], 'the second waits while the first is unfinished');
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(events, ['start first', 'end first', 'start second', 'end second']);
  });

  describe('a real FIFO whose reader starts late (a CLI still starting)', () => {
    let dir = '';
    let holder: ChildProcess | null = null;
    let fd: number | null = null;

    afterEach(() => {
      if (holder && holder.exitCode === null) holder.kill('SIGKILL');
      holder = null;
      if (fd !== null) fs.closeSync(fd);
      fd = null;
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('a 300 KB prompt and the prompt after it reach the reader as exactly two whole JSON lines, in order', async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstream-big-frame-'));
      const fifoPath = path.join(dir, 'stdin.fifo');
      const outPath = path.join(dir, 'read.jsonl');
      execFileSync('mkfifo', [fifoPath]);
      // Holds the FIFO read-write from the start (as the wrapper's `0<>` does), reads nothing for 1.5 s, then drains it.
      holder = spawn('sh', ['-c', 'exec 3<>"$1"; sleep 1.5; exec cat <&3 > "$2"', 'sh', fifoPath, outPath], { stdio: 'ignore' });
      fd = await openFifoWriterNonBlocking(fifoPath);
      assert.notEqual(fd, null, 'the held FIFO opens');
      const adapter = new ClaudeJsonStreamAdapter({ lifecycle: 'idle' });
      addSession(adapter, { fifoFd: fd ?? -1 });
      const big = 'x'.repeat(300 * 1024);
      const startedAt = Date.now();
      await Promise.all([adapter.sendInputAndWait(key, big), adapter.sendInputAndWait(key, 'the next prompt')]);
      assert.ok(Date.now() - startedAt >= 1000, 'the writes waited for the late reader (a 64 KB pipe holds a fifth of the frame)');
      let lines: string[] = [];
      for (let attempt = 0; attempt < 100 && lines.length < 2; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        lines = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8').split('\n').filter((line, index, all) => line !== '' || index < all.length - 1) : [];
      }
      const text = fs.readFileSync(outPath, 'utf8');
      assert.ok(text.endsWith('\n'), 'the last line is complete');
      const read = text.slice(0, -1).split('\n').map((line) => JSON.parse(line) as { type: string; message: { content: string } });
      assert.equal(read.length, 2, 'two lines: nothing torn, nothing interleaved');
      assert.equal(read[0].message.content, big);
      assert.equal(read[1].message.content, 'the next prompt');
    });
  });
});

describe('json-stream adapter — a user turn waits for a CLI that reads (a resumed CLI may read nothing for a while)', () => {
  it('held until the CLI answers the initialize handshake, then written', async () => {
    const { adapter, written } = createAdapter([]);
    const session = addSession(adapter, { isReadingInput: false, initRequestId: 'init_1', pendingInitResolve: () => {} });
    const sent = adapter.sendInputAndWait(key, 'please handle PROJ-1');
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.deepEqual(written, [], 'nothing is written into a FIFO nobody reads');
    adapter['applyStdoutLines'](session, [JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'init_1' } })]);
    await sent;
    assert.equal(written.length, 1);
    assert.equal(session.isReadingInput, true);
  });

  it('any output of the CLI counts as reading too', async () => {
    const { adapter, written } = createAdapter([]);
    const session = addSession(adapter, { isReadingInput: false });
    const sent = adapter.sendInputAndWait(key, 'hello');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(written, []);
    adapter['applyStdoutLines'](session, [JSON.stringify({ type: 'system', subtype: 'status', status: 'requesting', session_id: 'sess-fixture' })]);
    await sent;
    assert.equal(written.length, 1);
  });

  it('a CLI that never shows it reads still gets the prompt once the stall budget is over (it may not answer the handshake at all) — logged', async () => {
    const written: string[] = [];
    const adapter = new ClaudeJsonStreamAdapter({ lifecycle: 'idle', stdinStallTimeoutMs: 300, writeFifo: async (_fd: number, text: string) => { written.push(text); } });
    addSession(adapter, { isReadingInput: false });
    const warn = mock.method(console, 'warn', () => {});
    try {
      await adapter.sendInputAndWait(key, 'hello');
      assert.equal(written.length, 1);
      assert.ok(warn.mock.calls.some((call) => String(call.arguments[0]).includes('showed no sign of reading its input for 0 s')), 'one line says so');
    } finally {
      warn.mock.restore();
    }
  });

  it('a stop that begins while the turn waits ends the wait: nothing is written', async () => {
    const { adapter, written } = createAdapter([]);
    const session = addSession(adapter, { isReadingInput: false });
    const sent = adapter.sendInputAndWait(key, 'too late');
    session.isStopping = true;
    await assert.rejects(sent, /abandoned/);
    assert.deepEqual(written, []);
  });

  it('the SAME request\'s prompt torn a second time is said loudly — even rebuilt with other text for its re-post — it stays pending (the forward rejects), it does not loop silently', async () => {
    const torn = (): FifoWriteError => new FifoWriteError('EAGAIN: the reader took nothing for 120 s (64 of 100 bytes written)', 64, 100);
    const { adapter, calls } = createAdapter([torn(), torn()]);
    const errors = mock.method(console, 'error', () => {});
    try {
      addSession(adapter);
      await assert.rejects(adapter.sendInputAndWait(key, '[Request req_AbC1 · from: PROJ-1] the whole issue'));
      await settleTicks();
      assert.ok(!errors.mock.calls.some((call) => String(call.arguments[0]).includes('the SAME prompt')), 'one tear is the usual suspend');
      // The re-post reaches the fresh process the suspend leads to — rebuilt as a delta — and tears again.
      adapter['sessions'].delete(keyToString(key));
      addSession(adapter);
      await assert.rejects(adapter.sendInputAndWait(key, '[Request req_AbC1 · from: PROJ-1] what changed'));
      await settleTicks();
      assert.equal(calls(), 2);
      assert.ok(errors.mock.calls.some((call) => String(call.arguments[0]).includes('was left half-written 2 times')), 'said loudly');
    } finally {
      errors.mock.restore();
    }
  });

  it('a write of the request\'s prompt that lands forgets its tears: a later tear is the first again', async () => {
    const torn = (): FifoWriteError => new FifoWriteError('EAGAIN: the reader took nothing for 120 s (64 of 100 bytes written)', 64, 100);
    const { adapter } = createAdapter([torn(), 'written', torn()]);
    const errors = mock.method(console, 'error', () => {});
    try {
      addSession(adapter);
      await assert.rejects(adapter.sendInputAndWait(key, '[Request req_AbC1 · x] prompt'));
      adapter['sessions'].delete(keyToString(key));
      addSession(adapter);
      await adapter.sendInputAndWait(key, '[Request req_AbC1 · x] prompt');
      await settleTicks();
      adapter['sessions'].delete(keyToString(key));
      addSession(adapter);
      await assert.rejects(adapter.sendInputAndWait(key, '[Request req_AbC1 · x] prompt'));
      await settleTicks();
      assert.ok(!errors.mock.calls.some((call) => String(call.arguments[0]).includes('half-written 2 times')), 'pruned by the write that landed');
      assert.equal(adapter['tornPromptCounts'].size, 1);
    } finally {
      errors.mock.restore();
    }
  });

  it('a suspend that fails after a tear kills the process: a live process nobody can write to is never left behind', async () => {
    const torn = new FifoWriteError('EAGAIN: the reader took nothing for 120 s (10 of 100 bytes written)', 10, 100);
    const { adapter } = createAdapter([torn]);
    adapter.suspendSession = async () => {
      throw new Error('tmux is gone');
    };
    const killed: Array<[number, string | number | undefined]> = [];
    const kill = mock.method(process, 'kill', (pid: number, signal?: string | number) => {
      killed.push([pid, signal]);
      return true;
    });
    const warn = mock.method(console, 'warn', () => {});
    const errors = mock.method(console, 'error', () => {});
    try {
      addSession(adapter, { pid: 4_000_000 });
      await assert.rejects(adapter.sendInputAndWait(key, 'prompt'));
      for (let tick = 0; tick < 10; tick += 1) await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(killed, [[4_000_000, 'SIGKILL']]);
    } finally {
      kill.mock.restore();
      warn.mock.restore();
      errors.mock.restore();
    }
  });
});
