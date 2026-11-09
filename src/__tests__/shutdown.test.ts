/**
 * @description Coverage for `src/shutdown.ts` — ordered shutdown
 * orchestrator.
 *
 * Ordering is the whole point of this module: the *old* bot had two
 * SIGTERM handlers (one in `instanceLock.ts`, one in `bot.ts:4116`) where the
 * lock handler — registered first — called `releaseLock(); process.exit(0)`
 * synchronously, preempting the bot's async `state.flush()`. These tests
 * pin down the new contract:
 *
 *   - bot.stop fires before state.flush is awaited (so Telegraf stops
 *     pulling fresh updates while we drain pending state)
 *   - state.flush() FULLY resolves before releaseLock() runs (the bug fix
 *     — losing the last debounce window of state was the real-world
 *     symptom)
 *   - releaseLock() runs before exit() so the next nodemon respawn can
 *     reclaim
 *   - watchdog fires on a hung flush so a wedged FS can't block forever
 *   - cleanupTimers() runs on the happy path (otherwise GC interval
 *     wakes up mid-shutdown and re-dirties state)
 *
 * Dependencies are injected so we don't need real Telegraf / state /
 * lock — every callback records its order into a shared `events` array.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { gracefulShutdown, type ShutdownDeps } from '../shutdown';

/**
 * A step that never finishes until the test lets it. `gracefulShutdown` returning while one is held can only be its watchdog: the tests read that off the ORDER of events, not off how long it took — a bound on
 * elapsed milliseconds fails on a loaded host (a process that is not scheduled for 180 ms «took» 230), whatever the code does.
 */
function createHeldStep(): { wait: () => Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  return { wait: () => held, release };
}

/** The shutdown must return by itself; if it does not (the watchdog did not cut the held step) the test says so instead of waiting for the file's time limit. */
const returnBoundMs = 5000;
async function returns<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`gracefulShutdown did not return within ${returnBoundMs} ms`)), returnBoundMs); });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

interface TestHandle {
  deps: ShutdownDeps;
  events: string[];
  exitCode: () => number | null;
  /**
   * Resolves once the (potentially long) mock `state.flush()` promise
   * actually completes. Callers MUST await it before returning from the
   * test, otherwise node's test runner reports "Promise resolution is
   * still pending" for the orphan flush. Default mocks resolve nearly
   * synchronously, so this is essentially free; the watchdog-test path
   * deliberately makes flush slow and uses this to clean up.
   */
  drained: () => Promise<void>;
}

function makeDeps(overrides: Partial<ShutdownDeps> & {
  flushDelayMs?: number;
  /** Force flush to take *longer* than the watchdog: it waits for `heldFlush.release()`. */
  heldFlush?: { wait: () => Promise<void> };
} = {}): TestHandle {
  const events: string[] = [];
  let recordedExit: number | null = null;
  let flushDone: () => void = () => {};
  const flushDrain = new Promise<void>((resolve) => { flushDone = resolve; });

  const effectiveDelay = overrides.flushDelayMs ?? 0;
  const { heldFlush, ...shutdownOverrides } = overrides;

  const deps: ShutdownDeps = {
    signal: 'SIGTERM',
    bot: {
      stop: (signal?: string) => {
        events.push(`bot.stop(${signal ?? ''})`);
      },
    },
    state: {
      flush: async () => {
        events.push('state.flush:start');
        if (heldFlush !== undefined) await heldFlush.wait();
        if (effectiveDelay > 0) {
          await new Promise((r) => setTimeout(r, effectiveDelay));
        }
        events.push('state.flush:resolved');
        flushDone();
      },
    },
    releaseLock: () => events.push('releaseLock'),
    exit: (code: number) => {
      if (recordedExit !== null) return; // first exit wins
      recordedExit = code;
      events.push(`exit(${code})`);
    },
    cleanupTimers: () => events.push('cleanupTimers'),
    log: () => { /* silence */ },
    // Far longer than any step of a test that is not about the watchdog: it is cleared when the sequence wins, and a host that does not schedule the test for a moment must not fire it mid-sequence.
    watchdogMs: 60_000,
    ...shutdownOverrides,
  };

  return {
    deps,
    events,
    exitCode: () => recordedExit,
    drained: () => flushDrain,
  };
}

test('happy path: cleanupTimers → bot.stop → state.flush → releaseLock → exit(0)', async () => {
  const { deps, events, exitCode, drained } = makeDeps({ flushDelayMs: 20 });

  await gracefulShutdown(deps);
  await drained();

  assert.deepEqual(events, [
    'cleanupTimers',
    'bot.stop(SIGTERM)',
    'state.flush:start',
    'state.flush:resolved',
    'releaseLock',
    'exit(0)',
  ]);
  assert.equal(exitCode(), 0);
});

test('state.flush is FULLY awaited before releaseLock — the historical bug', async () => {
  // If the orchestrator regressed to firing releaseLock during the flush
  // (the old lock.ts behaviour), the `state.flush:resolved` event would
  // appear AFTER `releaseLock`. Pin it.
  const { deps, events, drained } = makeDeps({ flushDelayMs: 50 });

  await gracefulShutdown(deps);
  await drained();

  const flushResolvedIdx = events.indexOf('state.flush:resolved');
  const releaseIdx = events.indexOf('releaseLock');
  assert.notEqual(flushResolvedIdx, -1, 'state.flush:resolved must be recorded');
  assert.notEqual(releaseIdx, -1, 'releaseLock must be recorded');
  assert.ok(
    flushResolvedIdx < releaseIdx,
    `state.flush() must resolve before releaseLock; got events=${JSON.stringify(events)}`,
  );
});

test('watchdog forces exit when state.flush is slower than the watchdog', async () => {
  // The flush is held, so gracefulShutdown can only return through the watchdog (50 ms).
  const held = createHeldStep();
  const { deps, events, exitCode, drained } = makeDeps({ heldFlush: held, watchdogMs: 50 });

  await returns(gracefulShutdown(deps));

  assert.equal(exitCode(), 0, 'watchdog must still exit(0) so nodemon respawns');
  // releaseLock fires from the watchdog path so the next respawn finds a
  // free lockfile — that's the whole point of having the watchdog.
  assert.ok(events.includes('releaseLock'), `releaseLock missing; events=${JSON.stringify(events)}`);
  assert.ok(!events.includes('state.flush:resolved'), 'the flush was still held when the watchdog cut the shutdown');
  // Let the orphan flush finish so node:test doesn't flag a pending promise.
  held.release();
  await drained();
});

test('watchdog does NOT fire on a fast flush', async () => {
  // The watchdog is a minute away: the shutdown returning at all (inside the bound) means it did not wait the watchdog out.
  const { deps, events, exitCode, drained } = makeDeps({ flushDelayMs: 5, watchdogMs: 60_000 });

  await returns(gracefulShutdown(deps));
  await drained();

  // exit only recorded once (the watchdog path is suppressed), after the flush resolved.
  assert.equal(events.filter((e) => e.startsWith('exit')).length, 1);
  assert.ok(events.indexOf('state.flush:resolved') < events.indexOf('exit(0)'), `exit came after the flush; events=${JSON.stringify(events)}`);
  assert.equal(exitCode(), 0);
});

test('cleanupTimers is optional — orchestrator copes when it is absent', async () => {
  const { deps, events, exitCode, drained } = makeDeps({ cleanupTimers: undefined });

  await gracefulShutdown(deps);
  await drained();

  assert.ok(!events.includes('cleanupTimers'));
  assert.ok(events.includes('bot.stop(SIGTERM)'));
  assert.equal(exitCode(), 0);
});

test('error thrown by bot.stop does NOT skip state.flush or releaseLock', async () => {
  // Defensive: a misbehaving Telegraf shouldn't strand the lock.
  const { deps, events, exitCode, drained } = makeDeps({
    bot: {
      stop: () => {
        events.push('bot.stop:threw');
        throw new Error('telegraf failure');
      },
    },
  });

  await gracefulShutdown(deps);
  await drained();

  assert.ok(events.includes('state.flush:start'), 'flush must still run');
  assert.ok(events.includes('state.flush:resolved'), 'flush must still resolve');
  assert.ok(events.includes('releaseLock'), 'lock must still be released');
  assert.equal(exitCode(), 0);
});

test('clearTransientFrames runs after cleanupTimers and before state.flush / releaseLock', async () => {
  // The frame sweep must run while Telegram is still up (before bot.stop / the
  // flush) but after the timers are stopped (so no tick re-creates a frame).
  const { deps, events, drained } = makeDeps({
    flushDelayMs: 20,
    clearTransientFrames: async () => {
      events.push('clearTransientFrames');
    },
  });

  await gracefulShutdown(deps);
  await drained();

  const sweepIdx = events.indexOf('clearTransientFrames');
  const cleanupIdx = events.indexOf('cleanupTimers');
  const flushStartIdx = events.indexOf('state.flush:start');
  const releaseIdx = events.indexOf('releaseLock');
  assert.notEqual(sweepIdx, -1, 'clearTransientFrames must run');
  assert.ok(cleanupIdx !== -1 && cleanupIdx < sweepIdx, 'must run AFTER cleanupTimers');
  assert.ok(sweepIdx < flushStartIdx, 'must run BEFORE state.flush');
  assert.ok(sweepIdx < releaseIdx, 'must run BEFORE releaseLock');
});

test('a slow clearTransientFrames still hits the watchdog and forces exit', async () => {
  // A frame sweep slower than the watchdog (e.g. wedged Telegram API) must NOT
  // strand the shutdown: the outer watchdog wins and we still exit(0) +
  // releaseLock, even though the flush is blocked behind the sweep at that point.
  const held = createHeldStep();
  const { deps, events, exitCode, drained } = makeDeps({
    watchdogMs: 50,
    clearTransientFrames: () => held.wait(),
  });

  await returns(gracefulShutdown(deps));

  assert.equal(exitCode(), 0, 'watchdog must still exit(0) so nodemon respawns');
  assert.ok(events.includes('releaseLock'), `releaseLock must fire; events=${JSON.stringify(events)}`);
  assert.ok(
    !events.includes('state.flush:start'),
    'flush is blocked behind the slow sweep when the watchdog fires',
  );

  // Let the orphan sweep + its trailing flush settle so node:test doesn't flag a
  // pending promise.
  held.release();
  await drained();
});

test('finalizePendingOutput runs after cleanupTimers, before clearTransientFrames / bot.stop / state.flush', async () => {
  // The output flush must land content while the Telegram client is fully up
  // (before bot.stop) and BEFORE the transient frames are deleted (content
  // first, then frame cleanup), but after the timers are stopped.
  const { deps, events, drained } = makeDeps({
    flushDelayMs: 10,
    finalizePendingOutput: async () => {
      events.push('finalizePendingOutput');
    },
    clearTransientFrames: async () => {
      events.push('clearTransientFrames');
    },
  });

  await gracefulShutdown(deps);
  await drained();

  const cleanupIdx = events.indexOf('cleanupTimers');
  const finalizeIdx = events.indexOf('finalizePendingOutput');
  const sweepIdx = events.indexOf('clearTransientFrames');
  const stopIdx = events.indexOf('bot.stop(SIGTERM)');
  const flushStartIdx = events.indexOf('state.flush:start');
  assert.notEqual(finalizeIdx, -1, 'finalizePendingOutput must run');
  assert.ok(cleanupIdx !== -1 && cleanupIdx < finalizeIdx, 'must run AFTER cleanupTimers');
  assert.ok(sweepIdx !== -1 && finalizeIdx < sweepIdx, 'must run BEFORE clearTransientFrames');
  assert.ok(stopIdx !== -1 && finalizeIdx < stopIdx, 'must run BEFORE bot.stop');
  assert.ok(finalizeIdx < flushStartIdx, 'must run BEFORE state.flush');
});

test('a hanging finalizePendingOutput still hits the watchdog and forces exit', async () => {
  // The bot-side flush self-bounds; but even a wedged one (e.g. a hung Telegram
  // socket past its own race) must NOT strand the shutdown — the outer watchdog
  // wins and we still releaseLock + exit(0).
  const held = createHeldStep();
  const { deps, events, exitCode, drained } = makeDeps({
    watchdogMs: 50,
    finalizePendingOutput: () => held.wait(),
  });

  await returns(gracefulShutdown(deps));

  assert.equal(exitCode(), 0, 'watchdog must still exit(0) so nodemon respawns');
  assert.ok(events.includes('releaseLock'), `releaseLock must fire; events=${JSON.stringify(events)}`);
  assert.ok(
    !events.includes('state.flush:start'),
    'flush is blocked behind the hung finalize when the watchdog fires',
  );

  // Let the orphan finalize + its trailing flush settle so node:test doesn't
  // flag a pending promise.
  held.release();
  await drained();
});

test('a thrown finalizePendingOutput does NOT skip clearTransientFrames / state.flush / releaseLock', async () => {
  const { deps, events, exitCode, drained } = makeDeps({
    flushDelayMs: 5,
    finalizePendingOutput: async () => {
      events.push('finalizePendingOutput:threw');
      throw new Error('flush failure');
    },
    clearTransientFrames: async () => {
      events.push('clearTransientFrames');
    },
  });

  await gracefulShutdown(deps);
  await drained();

  assert.ok(events.includes('clearTransientFrames'), 'frame sweep must still run');
  assert.ok(events.includes('state.flush:start'), 'flush must still run');
  assert.ok(events.includes('state.flush:resolved'), 'flush must still resolve');
  assert.ok(events.includes('releaseLock'), 'lock must still be released');
  assert.equal(exitCode(), 0);
});

test('finalizePendingOutput is optional — orchestrator copes when it is absent', async () => {
  const { deps, events, exitCode, drained } = makeDeps({ flushDelayMs: 5 });

  await gracefulShutdown(deps);
  await drained();

  assert.ok(!events.includes('finalizePendingOutput'));
  assert.ok(events.includes('bot.stop(SIGTERM)'));
  assert.ok(events.includes('state.flush:resolved'));
  assert.equal(exitCode(), 0);
});

test('drainPendingUpdates runs AFTER bot.stop and BEFORE state.flush', async () => {
  // The off-loop update queues must drain while polling is already halted
  // (after bot.stop → no new enqueue) but before the flush (so the drained
  // handlers' state writes land in it). Pin that exact slot.
  const { deps, events, exitCode, drained } = makeDeps({
    flushDelayMs: 10,
    drainPendingUpdates: async () => {
      events.push('drainPendingUpdates');
    },
  });

  await gracefulShutdown(deps);
  await drained();

  const stopIdx = events.indexOf('bot.stop(SIGTERM)');
  const drainIdx = events.indexOf('drainPendingUpdates');
  const flushStartIdx = events.indexOf('state.flush:start');
  assert.notEqual(drainIdx, -1, 'drainPendingUpdates must run');
  assert.ok(stopIdx !== -1 && stopIdx < drainIdx, 'must run AFTER bot.stop');
  assert.ok(drainIdx < flushStartIdx, 'must run BEFORE state.flush');
  assert.equal(exitCode(), 0);
});

test('drainPendingUpdates is optional — orchestrator copes when it is absent', async () => {
  // Back-compat: a deps object without the new hook still shuts down cleanly.
  const { deps, events, exitCode, drained } = makeDeps({ flushDelayMs: 5 });

  await gracefulShutdown(deps);
  await drained();

  assert.ok(!events.includes('drainPendingUpdates'));
  assert.ok(events.includes('bot.stop(SIGTERM)'));
  assert.ok(events.includes('state.flush:resolved'));
  assert.equal(exitCode(), 0);
});

test('a thrown drainPendingUpdates does NOT skip state.flush or releaseLock', async () => {
  // A wedged drain must not strand the flush/lock — same defensive contract as
  // the other steps.
  const { deps, events, exitCode, drained } = makeDeps({
    flushDelayMs: 5,
    drainPendingUpdates: async () => {
      events.push('drainPendingUpdates:threw');
      throw new Error('drain failure');
    },
  });

  await gracefulShutdown(deps);
  await drained();

  assert.ok(events.includes('state.flush:start'), 'flush must still run');
  assert.ok(events.includes('state.flush:resolved'), 'flush must still resolve');
  assert.ok(events.includes('releaseLock'), 'lock must still be released');
  assert.equal(exitCode(), 0);
});

test('error thrown by state.flush does NOT skip releaseLock or exit', async () => {
  // Custom state.flush below replaces the default, so its `drained()`
  // contract no longer applies — we hand-await the orchestrator and
  // there's nothing extra to drain.
  const events: string[] = [];
  let exitCode: number | null = null;
  const deps: ShutdownDeps = {
    signal: 'SIGTERM',
    bot: { stop: (s) => events.push(`bot.stop(${s ?? ''})`) },
    state: {
      flush: async () => {
        events.push('state.flush:threw');
        throw new Error('disk full');
      },
    },
    releaseLock: () => events.push('releaseLock'),
    exit: (code) => { if (exitCode === null) { exitCode = code; events.push(`exit(${code})`); } },
    log: () => {},
    watchdogMs: 100,
  };

  await gracefulShutdown(deps);

  assert.ok(events.includes('releaseLock'), `releaseLock missing; events=${JSON.stringify(events)}`);
  assert.equal(exitCode, 0, 'we still exit so nodemon can respawn');
});

test('stopSidecars runs after state.flush and before releaseLock, so a stopped sidecar never costs the state', async () => {
  const { deps, events, drained } = makeDeps({
    flushDelayMs: 10,
    stopSidecars: async () => {
      events.push('stopSidecars:start');
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push('stopSidecars:done');
    },
  });

  await gracefulShutdown(deps);
  await drained();

  assert.deepEqual(events, [
    'cleanupTimers',
    'bot.stop(SIGTERM)',
    'state.flush:start',
    'state.flush:resolved',
    'stopSidecars:start',
    'stopSidecars:done',
    'releaseLock',
    'exit(0)',
  ]);
});

test('a thrown stopSidecars does NOT skip releaseLock or exit', async () => {
  const { deps, events, exitCode, drained } = makeDeps({
    stopSidecars: async () => {
      throw new Error('sidecar would not die');
    },
  });

  await gracefulShutdown(deps);
  await drained();

  assert.ok(events.includes('releaseLock'));
  assert.equal(exitCode(), 0);
});

test('a hung stopSidecars is cut off by the watchdog: the lock is still released and the process exits', async () => {
  let releaseHungStop: () => void = () => {};
  const { deps, events, exitCode, drained } = makeDeps({
    watchdogMs: 50,
    stopSidecars: () => new Promise<void>((resolve) => { releaseHungStop = resolve; }),
  });

  // The watchdog timer is unref'd (in production other handles keep the process up): hold the loop open here.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await gracefulShutdown(deps);
    assert.ok(events.includes('releaseLock'));
    assert.equal(exitCode(), 0);
  } finally {
    // Settle the orphan so the runner does not report a pending promise.
    releaseHungStop();
    await drained();
    clearInterval(keepAlive);
  }
});

test('without the dep (a hot worker, whose supervisor owns the sidecar) nothing is stopped', async () => {
  const { deps, events, drained } = makeDeps();
  await gracefulShutdown(deps);
  await drained();
  assert.ok(!events.some((event) => event.startsWith('stopSidecars')));
});
