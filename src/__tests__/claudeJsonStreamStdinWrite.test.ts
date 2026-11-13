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

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ClaudeJsonStreamAdapter, type StreamSession } from '../adapters/claudeJsonStreamAdapter';
import { FifoWriteError, type FifoWriteOptions } from '../utils/jsonStreamHost';
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
