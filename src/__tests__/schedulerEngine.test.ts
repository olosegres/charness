/**
 * @description Coverage for `scheduler/engine.ts` (S3) — the timer engine,
 * boot replay, no-overlap guard, and post-fire bookkeeping.
 *
 * Everything the engine touches is injected, so these run on a FAKE clock and a
 * FAKE timer queue (no real `setTimeout`, no wall-clock waits): `now()` returns
 * a mutable cursor, `setTimeoutFn` records {callback, dueAt} and `tick(ms)`
 * advances the cursor and fires every due timer. The store is a real
 * `StateStore` in an isolated dataDir under a fake HOME (scheduleStore.test.ts
 * idiom) so bookkeeping round-trips through actual persistence; the ledger and
 * `deliver` are captured fakes.
 *
 * Load-bearing assertions capture intermediate state (deliver call args, the
 * advanced nextRunAt, ledger kinds, timer presence) rather than "returned to
 * initial", so a no-op engine could never pass.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StateStore } from '../state';
import { type SessionKey } from '../sessionKey';
import { createScheduleForThread } from '../scheduler/store';
import { createSchedulerEngine, maxTimeoutMs } from '../scheduler/engine';
import { catchUpToleranceMs } from '../scheduler/recurrence';
import type { DeliveryOutcome, FireContext, ScheduleRecord, ScheduleSpec } from '../scheduler/types';
import type { ScheduleRunRecord } from '../scheduler/runLedger';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';

const threadA: SessionKey = makeTelegramKey(-1001234567890, 11);
const threadB: SessionKey = makeTelegramKey(-1001234567890, 12);
const everyFiveMinutes: ScheduleSpec = { kind: 'cron', cronExpr: '*/5 * * * *' };
const waitUntilTimeoutMs = 5000;
const waitUntilStepMs = 5;

/** A controllable fake timer queue + clock, mirroring how the engine consumes them. */
function createFakeClock(startMs: number) {
  let nowMs = startMs;
  let nextId = 1;
  interface Pending {
    id: number;
    callback: () => void;
    dueAt: number;
    delayMs: number;
  }
  const pending = new Map<number, Pending>();
  const armedDelays: number[] = [];

  const setTimeoutFn = (callback: () => void, delayMs: number): NodeJS.Timeout => {
    const id = nextId;
    nextId += 1;
    pending.set(id, { id, callback, dueAt: nowMs + delayMs, delayMs });
    armedDelays.push(delayMs);
    // The engine only calls .unref?.() on the handle; a numeric-ish stub is fine.
    return { unref() {}, [Symbol.toPrimitive]: () => id } as unknown as NodeJS.Timeout;
  };
  const clearTimeoutFn = (handle: NodeJS.Timeout): void => {
    const id = Number(handle as unknown as number);
    pending.delete(id);
  };

  /**
   * Advance the clock by `ms` and fire every timer that becomes due, in due
   * order. Each fired callback is awaited-via-microtask-drain by the caller's
   * own `await tick(...)`; the engine's async callbacks settle on the next
   * awaited tick or an explicit `drain()`.
   */
  function tick(ms: number): void {
    nowMs += ms;
    let fired = true;
    while (fired) {
      fired = false;
      const due = [...pending.values()].filter((p) => p.dueAt <= nowMs).sort((a, b) => a.dueAt - b.dueAt);
      for (const p of due) {
        if (!pending.has(p.id)) continue;
        pending.delete(p.id);
        p.callback();
        fired = true;
      }
    }
  }

  return {
    now: () => nowMs,
    setTimeoutFn,
    clearTimeoutFn,
    tick,
    get pendingCount() {
      return pending.size;
    },
    armedDelays,
    setNow(value: number) {
      nowMs = value;
    },
  };
}

/** A capturing fake deliver + ledger, with a programmable outcome / hang. */
function createCaptures() {
  const deliverCalls: Array<{ job: ScheduleRecord; fireContext: FireContext }> = [];
  const ledgerRecords: ScheduleRunRecord[] = [];
  let nextOutcome: DeliveryOutcome = { status: 'delivered' };
  let pendingResolve: ((outcome: DeliveryOutcome) => void) | null = null;
  let shouldThrow = false;
  /** Jobs whose delivery is rigged to hang (beside the one `hangNextDelivery` hangs), and the resolvers of those that do. */
  const hangingJobIds = new Set<string>();
  const pendingJobResolves = new Map<string, (outcome: DeliveryOutcome) => void>();

  const deliver = (job: ScheduleRecord, fireContext: FireContext): Promise<DeliveryOutcome> => {
    deliverCalls.push({ job: { ...job }, fireContext: { ...fireContext } });
    if (shouldThrow) return Promise.reject(new Error('deliver boom'));
    if (hangingJobIds.has(job.id)) {
      return new Promise<DeliveryOutcome>((resolve) => {
        pendingJobResolves.set(job.id, resolve);
      });
    }
    if (pendingResolve === null && hangNext) {
      return new Promise<DeliveryOutcome>((resolve) => {
        pendingResolve = resolve;
      });
    }
    return Promise.resolve(nextOutcome);
  };
  let hangNext = false;

  return {
    deliver,
    ledger: { append: (r: ScheduleRunRecord) => ledgerRecords.push(r) },
    deliverCalls,
    ledgerRecords,
    setOutcome(outcome: DeliveryOutcome) {
      nextOutcome = outcome;
    },
    setShouldThrow(value: boolean) {
      shouldThrow = value;
    },
    hangNextDelivery() {
      hangNext = true;
    },
    resolveHanging(outcome: DeliveryOutcome = { status: 'delivered' }) {
      hangNext = false;
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve?.(outcome);
    },
    /** The delivery of this job hangs when it starts, until {@link resolveJobDelivery}. */
    hangJobDelivery(jobId: string) {
      hangingJobIds.add(jobId);
    },
    resolveJobDelivery(jobId: string, outcome: DeliveryOutcome = { status: 'delivered' }) {
      hangingJobIds.delete(jobId);
      const resolve = pendingJobResolves.get(jobId);
      pendingJobResolves.delete(jobId);
      resolve?.(outcome);
    },
  };
}

/**
 * Yield the event loop a few macrotask rounds WITHOUT waiting for a fire chain
 * to complete. Used only for the overlap test, whose first delivery is rigged
 * to hang: `engine.whenIdle()` would deadlock there, but the begin-ledger +
 * deliver-call happen synchronously up to the suspended `await deliver`, so a
 * handful of `setImmediate` rounds is enough to observe them.
 */
async function yieldMacrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Poll `check` until it holds; a bounded wait for a concrete state, failing with `description` when it never does. */
async function waitUntil(description: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + waitUntilTimeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise<void>((resolve) => setTimeout(resolve, waitUntilStepMs));
  }
}

describe('schedulerEngine', () => {
  let dataDir: string;
  let fakeHome: string;
  let originalHome: string | undefined;
  let stores: StateStore[] = [];

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-engine-'));
    dataDir = path.join(fakeHome, '.charness');
    fs.mkdirSync(dataDir, { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });

  afterEach(async () => {
    for (const store of stores) await store.flush();
    stores = [];
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  async function newStore(): Promise<StateStore> {
    const store = new StateStore(dataDir, { saveDebounceMs: 5 });
    stores.push(store);
    await store.init();
    return store;
  }

  it('arms a job, fires it on time, records bookkeeping and re-arms', async () => {
    const store = await newStore();
    const startMs = new Date(2026, 5, 6, 10, 0, 0).getTime();
    const created = await createScheduleForThread(store, {
      threadKey: threadA, name: 'tick', spec: everyFiveMinutes, prompt: 'go', createdBy: 'user', nowMs: startMs,
    });
    assert.ok(created.ok);
    const job = created.record;
    const dueAt = job.nextRunAt;
    assert.ok(dueAt !== null);

    const clock = createFakeClock(startMs);
    const caps = createCaptures();
    const engine = createSchedulerEngine({
      store, ledger: caps.ledger, deliver: caps.deliver,
      now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
    });

    engine.armJob(job);
    assert.equal(clock.pendingCount, 1, 'one timer armed');

    clock.tick(dueAt - startMs);
    await engine.whenIdle();

    assert.equal(caps.deliverCalls.length, 1, 'delivered once');
    assert.equal(caps.deliverCalls[0].fireContext.kind, 'on-time');

    const fresh = store.getSchedules()[job.id];
    assert.ok(fresh, 'recurring record persists');
    assert.equal(fresh.lastRunStatus, 'delivered');
    assert.equal(fresh.lastRunAt, dueAt, 'lastRunAt stamped at fire time');
    assert.ok(fresh.nextRunAt !== null && fresh.nextRunAt > dueAt, 'nextRunAt advanced into the future');
    assert.equal(clock.pendingCount, 1, 're-armed for the next occurrence');

    const onTimeEntries = caps.ledgerRecords.filter((r) => r.kind === 'on-time');
    assert.equal(onTimeEntries.length, 2, 'begin + end ledger records');
    assert.ok(onTimeEntries.some((r) => r.deliveredAt !== undefined), 'end record carries deliveredAt');
  });

  it('boot rearmAll fires a catch-up with missedAtMs, then re-arms in the future', async () => {
    const store = await newStore();
    // Created in the past, so by boot its nextRunAt has already elapsed.
    const createdAtMs = new Date(2026, 5, 6, 9, 0, 0).getTime();
    const created = await createScheduleForThread(store, {
      threadKey: threadA, name: 'missed', spec: everyFiveMinutes, prompt: 'go', createdBy: 'user', nowMs: createdAtMs,
    });
    assert.ok(created.ok);
    const missedDueAt = created.record.nextRunAt;
    assert.ok(missedDueAt !== null);

    // Boot "now" is well past the missed due instant.
    const bootNow = missedDueAt + 60 * 60 * 1000;
    const clock = createFakeClock(bootNow);
    const caps = createCaptures();
    const engine = createSchedulerEngine({
      store, ledger: caps.ledger, deliver: caps.deliver,
      now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
    });

    engine.rearmAll();
    await engine.whenIdle();

    assert.equal(caps.deliverCalls.length, 1, 'catch-up fired once');
    assert.equal(caps.deliverCalls[0].fireContext.kind, 'catch-up');
    assert.equal(caps.deliverCalls[0].fireContext.missedAtMs, missedDueAt, 'missedAtMs is the original due instant');

    const fresh = store.getSchedules()[created.record.id];
    assert.ok(fresh.nextRunAt !== null && fresh.nextRunAt > bootNow, 'recomputed from boot now, into the future');
    assert.equal(clock.pendingCount, 1, 're-armed after catch-up');
    assert.ok(caps.ledgerRecords.some((r) => r.kind === 'catch-up'), 'catch-up ledger record written');
  });

  it('boot rearmAll does not wait for a catch-up whose delivery cannot finish: the catch-up is under way and the boot goes on', async () => {
    const store = await newStore();
    const createdAtMs = new Date(2026, 5, 6, 9, 0, 0).getTime();
    const created = await createScheduleForThread(store, {
      threadKey: threadA, name: 'stuck', spec: everyFiveMinutes, prompt: 'go', createdBy: 'user', nowMs: createdAtMs,
    });
    assert.ok(created.ok);
    const missedDueAt = created.record.nextRunAt;
    assert.ok(missedDueAt !== null);

    const bootNow = missedDueAt + 60 * 60 * 1000;
    const clock = createFakeClock(bootNow);
    const caps = createCaptures();
    // The agent of the topic is mid-turn, waiting for its operator: the delivery waits for it and does not finish.
    caps.hangNextDelivery();
    const engine = createSchedulerEngine({
      store, ledger: caps.ledger, deliver: caps.deliver,
      now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
    });

    try {
      // `rearmAll` returns `void`, at once: the boot has no delivery to wait for, and cannot be made to wait for one.
      engine.rearmAll();
      await yieldMacrotasks();

      assert.equal(caps.deliverCalls.length, 1, 'the catch-up did start delivering, and the boot went on');
      assert.equal(caps.deliverCalls[0].fireContext.kind, 'catch-up');
      assert.equal(caps.deliverCalls[0].fireContext.missedAtMs, missedDueAt, 'and it still carries the missed instant');
      assert.equal(
        caps.ledgerRecords.filter((record) => record.kind === 'catch-up' && record.deliveredAt !== undefined).length,
        0,
        'its ledger record has no end yet',
      );
      assert.equal(store.getSchedules()[created.record.id].nextRunAt, missedDueAt, 'nothing is booked before the delivery ends');
    } finally {
      caps.resolveHanging();
    }
    await engine.whenIdle();

    const fresh = store.getSchedules()[created.record.id];
    assert.equal(fresh.lastRunStatus, 'delivered', 'once the delivery ends, the catch-up is booked as any fire');
    assert.ok(fresh.nextRunAt !== null && fresh.nextRunAt > bootNow, 'nextRunAt is recomputed from the boot, into the future');
    assert.equal(clock.pendingCount, 1, 'and the job is armed again');
    assert.equal(caps.deliverCalls.length, 1, 'still ONE catch-up for the missed run');
    assert.equal(
      caps.ledgerRecords.filter((record) => record.kind === 'catch-up' && record.deliveredAt !== undefined).length,
      1,
      'the end record of the ledger is written',
    );
  });

  it('boot rearmAll: a catch-up that cannot finish delays no other TOPIC — its own topic waits behind it, the other missed catch-ups run, the on-time jobs are armed', async () => {
    const store = await newStore();
    const createdAtMs = new Date(2026, 5, 6, 9, 0, 0).getTime();
    // Stored in this order, and the first one is the one that hangs.
    const stuck = await createScheduleForThread(store, {
      threadKey: threadA, name: 'stuck', spec: everyFiveMinutes, prompt: 'go', createdBy: 'user', nowMs: createdAtMs,
    });
    const otherMissed = await createScheduleForThread(store, {
      threadKey: threadB, name: 'other-missed', spec: everyFiveMinutes, prompt: 'go', createdBy: 'user', nowMs: createdAtMs,
    });
    const behindStuck = await createScheduleForThread(store, {
      threadKey: threadA, name: 'behind-stuck', spec: everyFiveMinutes, prompt: 'go', createdBy: 'user', nowMs: createdAtMs,
    });
    assert.ok(stuck.ok && otherMissed.ok && behindStuck.ok);
    const missedDueAt = stuck.record.nextRunAt;
    assert.ok(missedDueAt !== null);
    const bootNow = missedDueAt + 60 * 60 * 1000;
    // Created at the boot instant: its first run is minutes ahead, so the replay only arms it.
    const onTime = await createScheduleForThread(store, {
      threadKey: threadB, name: 'on-time', spec: everyFiveMinutes, prompt: 'go', createdBy: 'user', nowMs: bootNow,
    });
    assert.ok(onTime.ok);

    const clock = createFakeClock(bootNow);
    const caps = createCaptures();
    caps.hangNextDelivery();
    const engine = createSchedulerEngine({
      store, ledger: caps.ledger, deliver: caps.deliver,
      now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
    });

    try {
      engine.rearmAll();
      await yieldMacrotasks();

      assert.deepEqual(
        caps.deliverCalls.map((call) => call.job.id),
        [stuck.record.id, otherMissed.record.id],
        'the other topic\'s catch-up was delivered while the first one is still waiting; the stuck topic\'s second job waits behind it',
      );
      assert.ok(caps.deliverCalls.every((call) => call.fireContext.kind === 'catch-up'));
      const otherAfter = store.getSchedules()[otherMissed.record.id];
      assert.equal(otherAfter.lastRunStatus, 'delivered', 'and it is booked');
      assert.ok(otherAfter.nextRunAt !== null && otherAfter.nextRunAt > bootNow, 'with its next run ahead');
      assert.equal(store.getSchedules()[stuck.record.id].nextRunAt, missedDueAt, 'the waiting one is not booked yet');
      // The finished catch-up re-armed its job and the on-time job was armed: one timer each. The two jobs of the stuck topic have none yet.
      assert.equal(clock.pendingCount, 2, 'every job of the other topic is armed');
    } finally {
      caps.resolveHanging();
    }
    await engine.whenIdle();
    assert.deepEqual(
      caps.deliverCalls.map((call) => call.job.id),
      [stuck.record.id, otherMissed.record.id, behindStuck.record.id],
      'the job behind the stuck one is delivered once the stuck one ended: one catch-up per missed job, no more',
    );
    assert.equal(clock.pendingCount, 4, 'every job is armed again once the deliveries ended');
  });

  it('boot rearmAll: the catch-ups of ONE topic run one after another — the second delivery starts only after the first one ended and was booked', async () => {
    const store = await newStore();
    const createdAtMs = new Date(2026, 5, 6, 9, 0, 0).getTime();
    const first = await createScheduleForThread(store, {
      threadKey: threadA, name: 'first', spec: everyFiveMinutes, prompt: 'go', createdBy: 'user', nowMs: createdAtMs,
    });
    const second = await createScheduleForThread(store, {
      threadKey: threadA, name: 'second', spec: everyFiveMinutes, prompt: 'go', createdBy: 'user', nowMs: createdAtMs,
    });
    assert.ok(first.ok && second.ok);
    const missedDueAt = first.record.nextRunAt;
    assert.ok(missedDueAt !== null);
    const bootNow = missedDueAt + 60 * 60 * 1000;
    const clock = createFakeClock(bootNow);
    const caps = createCaptures();
    // The first delivery waits for its agent: with both started together, the agent would be handed two prompts at once.
    caps.hangNextDelivery();
    const engine = createSchedulerEngine({
      store, ledger: caps.ledger, deliver: caps.deliver,
      now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
    });

    try {
      engine.rearmAll();
      await yieldMacrotasks();
      assert.deepEqual(caps.deliverCalls.map((call) => call.job.id), [first.record.id], 'only the first delivery has started');
    } finally {
      caps.resolveHanging();
    }
    await engine.whenIdle();

    assert.deepEqual(caps.deliverCalls.map((call) => call.job.id), [first.record.id, second.record.id], 'then the second one, once');
    assert.deepEqual(
      caps.ledgerRecords.map((record) => `${record.jobId === first.record.id ? 'first' : 'second'}:${record.deliveredAt === undefined ? 'begin' : 'end'}`),
      ['first:begin', 'first:end', 'second:begin', 'second:end'],
      'the second catch-up began only after the first one\'s end record',
    );
    for (const record of [first.record, second.record]) {
      const fresh = store.getSchedules()[record.id];
      assert.equal(fresh.lastRunStatus, 'delivered');
      assert.ok(fresh.nextRunAt !== null && fresh.nextRunAt > bootNow, `${record.name} is booked, its next run ahead`);
    }
    assert.equal(clock.pendingCount, 2, 'both jobs are armed again');
  });

  it('boot rearmAll: a job removed while its catch-up waits behind another one of its topic is not delivered', async () => {
    const store = await newStore();
    const createdAtMs = new Date(2026, 5, 6, 9, 0, 0).getTime();
    const first = await createScheduleForThread(store, {
      threadKey: threadA, name: 'first', spec: everyFiveMinutes, prompt: 'go', createdBy: 'user', nowMs: createdAtMs,
    });
    const cancelled = await createScheduleForThread(store, {
      threadKey: threadA, name: 'cancelled', spec: everyFiveMinutes, prompt: 'go', createdBy: 'user', nowMs: createdAtMs,
    });
    assert.ok(first.ok && cancelled.ok);
    const missedDueAt = first.record.nextRunAt;
    assert.ok(missedDueAt !== null);
    const clock = createFakeClock(missedDueAt + 60 * 60 * 1000);
    const caps = createCaptures();
    caps.hangNextDelivery();
    const engine = createSchedulerEngine({
      store, ledger: caps.ledger, deliver: caps.deliver,
      now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
    });

    try {
      engine.rearmAll();
      await yieldMacrotasks();
      // The agent cancels the job (`schedule_cancel`) while its catch-up still waits for its turn.
      await store.removeSchedule(cancelled.record.id);
    } finally {
      caps.resolveHanging();
    }
    await engine.whenIdle();

    assert.deepEqual(caps.deliverCalls.map((call) => call.job.id), [first.record.id], 'the cancelled job was never delivered');
    assert.equal(clock.pendingCount, 1, 'and nothing was armed for it');
  });

  it('boot rearmAll: a job re-armed while its catch-up waits behind another one of its topic is not fired as a catch-up — its new timer owns it', async () => {
    const store = await newStore();
    const createdAtMs = new Date(2026, 5, 6, 9, 0, 0).getTime();
    const first = await createScheduleForThread(store, {
      threadKey: threadA, name: 'first', spec: everyFiveMinutes, prompt: 'go', createdBy: 'user', nowMs: createdAtMs,
    });
    const queued = await createScheduleForThread(store, {
      threadKey: threadA, name: 'queued', spec: everyFiveMinutes, prompt: 'go', createdBy: 'user', nowMs: createdAtMs,
    });
    assert.ok(first.ok && queued.ok);
    const missedDueAt = first.record.nextRunAt;
    assert.ok(missedDueAt !== null);
    const bootNow = missedDueAt + 60 * 60 * 1000;
    const clock = createFakeClock(bootNow);
    const caps = createCaptures();
    caps.hangNextDelivery();
    const engine = createSchedulerEngine({
      store, ledger: caps.ledger, deliver: caps.deliver,
      now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
    });

    const rearmedDueAt = bootNow + 30 * 60 * 1000;
    try {
      engine.rearmAll();
      await yieldMacrotasks();
      // What `/timezone` (or a rebind of the topic) does to a job: its next run is recomputed from now, persisted and armed.
      const rearmed: ScheduleRecord = { ...store.getSchedules()[queued.record.id], nextRunAt: rearmedDueAt };
      await store.upsertSchedule(rearmed);
      engine.armJob(rearmed);
    } finally {
      caps.resolveHanging();
    }
    await engine.whenIdle();

    assert.deepEqual(caps.deliverCalls.map((call) => call.job.id), [first.record.id], 'the re-armed job was not delivered: it is not due');
    assert.equal(caps.ledgerRecords.some((record) => record.jobId === queued.record.id), false, 'and it left no ledger record');
    assert.equal(store.getSchedules()[queued.record.id].nextRunAt, rearmedDueAt, 'its next run is the recomputed one');
    assert.equal(clock.pendingCount, 2, 'its own timer stays armed, beside the one of the job that was waiting for its agent');
    // The clock moves on: the timers of both jobs come due (the first job's own next run is a few minutes ahead).
    clock.tick(rearmedDueAt - bootNow);
    await engine.whenIdle();
    const queuedDeliveries = caps.deliverCalls.filter((call) => call.job.id === queued.record.id);
    assert.equal(queuedDeliveries.length, 1, 'it fires once, when it is due');
    assert.equal(queuedDeliveries[0].fireContext.kind, 'on-time');
  });

  it('boot rearmAll: the timer of a job re-armed while its catch-up waits comes due before the wait ends — it fires once, by its timer, and the waiting catch-up neither fires it again nor books an overlap for it', async () => {
    const store = await newStore();
    const createdAtMs = new Date(2026, 5, 6, 9, 0, 0).getTime();
    const first = await createScheduleForThread(store, {
      threadKey: threadA, name: 'first', spec: everyFiveMinutes, prompt: 'go', createdBy: 'user', nowMs: createdAtMs,
    });
    const queued = await createScheduleForThread(store, {
      threadKey: threadA, name: 'queued', spec: everyFiveMinutes, prompt: 'go', createdBy: 'user', nowMs: createdAtMs,
    });
    assert.ok(first.ok && queued.ok);
    const missedDueAt = first.record.nextRunAt;
    assert.ok(missedDueAt !== null);
    const bootNow = missedDueAt + 60 * 60 * 1000;
    const clock = createFakeClock(bootNow);
    const caps = createCaptures();
    caps.hangNextDelivery();
    // The re-armed job waits for the same busy agent: its own delivery does not end before the first one's.
    caps.hangJobDelivery(queued.record.id);
    const engine = createSchedulerEngine({
      store, ledger: caps.ledger, deliver: caps.deliver,
      now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
    });

    const rearmedDelayMs = 10 * 60 * 1000;
    const queuedLedgerKinds = (): string[] => caps.ledgerRecords.filter((record) => record.jobId === queued.record.id).map((record) => record.kind);
    try {
      engine.rearmAll();
      await yieldMacrotasks();
      const rearmed: ScheduleRecord = { ...store.getSchedules()[queued.record.id], nextRunAt: bootNow + rearmedDelayMs };
      await store.upsertSchedule(rearmed);
      engine.armJob(rearmed);
      // The new timer comes due while the first job still waits for its agent, and its delivery waits too.
      clock.tick(rearmedDelayMs);
      await yieldMacrotasks();
      assert.deepEqual(caps.deliverCalls.map((call) => call.job.id), [first.record.id, queued.record.id], 'the re-armed job was fired by its timer');
      assert.equal(caps.deliverCalls[1].fireContext.kind, 'on-time');
      // Its run is by now older than the catch-up tolerance, so a stale queued turn would read it as MISSED.
      clock.tick(2 * catchUpToleranceMs);

      // The first job's delivery ends: its queue turn for the re-armed job comes while that job's own delivery is in flight.
      caps.resolveHanging();
      // Its bookkeeping writes the store, then its chain ends and the next queued turn starts: wait for the end record, then let that turn run.
      await waitUntil('the first job\'s end record', () => caps.ledgerRecords.some((record) => record.jobId === first.record.id && record.deliveredAt !== undefined));
      await yieldMacrotasks();
      assert.equal(queuedLedgerKinds().includes('skipped-overlap'), false, 'no overlap is booked for a run that was never due: the delivery in flight owns the next run');
      assert.deepEqual(caps.deliverCalls.map((call) => call.job.id), [first.record.id, queued.record.id], 'nothing is delivered a second time');
    } finally {
      caps.resolveHanging();
      caps.resolveJobDelivery(queued.record.id);
    }
    await engine.whenIdle();

    assert.deepEqual(caps.deliverCalls.map((call) => call.job.id), [first.record.id, queued.record.id], 'the waiting catch-up did not deliver it a second time');
    assert.deepEqual(queuedLedgerKinds(), ['on-time', 'on-time'], 'the re-armed job has the begin and the end record of its own run, and nothing else');
    assert.equal(store.getSchedules()[queued.record.id].lastRunStatus, 'delivered', 'and its own delivery is what booked it');
    assert.equal(clock.pendingCount, 2, 'both jobs are armed for their next runs');
  });

  it('boot rearmAll: a catch-up whose delivery throws is booked as failed and re-armed — nothing escapes the replay', async () => {
    const store = await newStore();
    const createdAtMs = new Date(2026, 5, 6, 9, 0, 0).getTime();
    const created = await createScheduleForThread(store, {
      threadKey: threadA, name: 'throws', spec: everyFiveMinutes, prompt: 'go', createdBy: 'user', nowMs: createdAtMs,
    });
    assert.ok(created.ok);
    const missedDueAt = created.record.nextRunAt;
    assert.ok(missedDueAt !== null);
    const bootNow = missedDueAt + 60 * 60 * 1000;
    const clock = createFakeClock(bootNow);
    const caps = createCaptures();
    caps.setShouldThrow(true);
    const engine = createSchedulerEngine({
      store, ledger: caps.ledger, deliver: caps.deliver,
      now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
    });

    engine.rearmAll();
    await engine.whenIdle();

    const fresh = store.getSchedules()[created.record.id];
    assert.equal(fresh.lastRunStatus, 'failed');
    assert.ok(fresh.nextRunAt !== null && fresh.nextRunAt > bootNow);
    assert.equal(clock.pendingCount, 1, 're-armed after the failed catch-up');
    const ended = caps.ledgerRecords.find((record) => record.kind === 'catch-up' && record.deliveredAt !== undefined);
    assert.equal(ended?.error, 'deliver boom', 'the end record names the failure');
  });

  it('skips an overlapping fire while delivery is in flight (no second deliver)', async () => {
    const store = await newStore();
    const startMs = new Date(2026, 5, 6, 10, 0, 0).getTime();
    const created = await createScheduleForThread(store, {
      threadKey: threadA, name: 'overlap', spec: everyFiveMinutes, prompt: 'go', createdBy: 'user', nowMs: startMs,
    });
    assert.ok(created.ok);
    const job = created.record;
    const firstDueAt = job.nextRunAt;
    assert.ok(firstDueAt !== null);

    const clock = createFakeClock(startMs);
    const caps = createCaptures();
    caps.hangNextDelivery();
    const engine = createSchedulerEngine({
      store, ledger: caps.ledger, deliver: caps.deliver,
      now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
    });

    engine.armJob(job);
    clock.tick(firstDueAt - startMs);
    await yieldMacrotasks();
    assert.equal(caps.deliverCalls.length, 1, 'first fire began delivering (and is hanging)');
    assert.equal(clock.pendingCount, 0, 'no timer armed while in flight (re-arm happens after delivery)');

    // Manually re-arm a timer at the same instant to simulate the overlap race
    // (a re-arm would normally come from bookkeeping, but here delivery hangs).
    engine.armJob({ ...job, nextRunAt: clock.now() });
    clock.tick(0);
    await yieldMacrotasks();

    assert.equal(caps.deliverCalls.length, 1, 'overlap did NOT trigger a second deliver');
    const skipEntries = caps.ledgerRecords.filter((r) => r.kind === 'skipped-overlap');
    assert.equal(skipEntries.length, 1, 'one skipped-overlap ledger record');
    assert.ok(clock.pendingCount >= 1, 'job re-armed after the skip');

    caps.resolveHanging();
    await engine.whenIdle();
  });

  it('N-times: removes the record and disarms after remainingRuns hits zero', async () => {
    const store = await newStore();
    const startMs = new Date(2026, 5, 6, 10, 0, 0).getTime();
    const spec: ScheduleSpec = { kind: 'cron', cronExpr: '*/5 * * * *', remainingRuns: 2 };
    const created = await createScheduleForThread(store, {
      threadKey: threadA, name: 'twice', spec, prompt: 'go', createdBy: 'user', nowMs: startMs,
    });
    assert.ok(created.ok);
    const job = created.record;

    const clock = createFakeClock(startMs);
    const caps = createCaptures();
    const engine = createSchedulerEngine({
      store, ledger: caps.ledger, deliver: caps.deliver,
      now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
    });

    engine.armJob(job);

    // First fire: decrements to 1, re-armed.
    let due = store.getSchedules()[job.id].nextRunAt;
    assert.ok(due !== null);
    clock.tick(due - clock.now());
    await engine.whenIdle();
    assert.equal(caps.deliverCalls.length, 1);
    const afterFirst = store.getSchedules()[job.id];
    assert.ok(afterFirst, 'record survives first of two runs');
    assert.equal(afterFirst.spec.kind, 'cron', 'N-times spec stays cron-kind');
    if (afterFirst.spec.kind === 'cron') {
      assert.equal(afterFirst.spec.remainingRuns, 1, 'decremented to 1');
    }
    assert.equal(clock.pendingCount, 1, 're-armed for the second run');

    // Second fire: decrements to 0 → record removed, no timer.
    due = store.getSchedules()[job.id].nextRunAt;
    assert.ok(due !== null);
    clock.tick(due - clock.now());
    await engine.whenIdle();
    assert.equal(caps.deliverCalls.length, 2, 'fired both runs');
    assert.equal(store.getSchedules()[job.id], undefined, 'record removed after the 2nd run');
    assert.equal(clock.pendingCount, 0, 'timer gone');
  });

  it('once: removes the record after the single fire', async () => {
    const store = await newStore();
    const startMs = new Date(2026, 5, 6, 10, 0, 0).getTime();
    const onceAt = new Date(startMs + 10 * 60 * 1000).toISOString();
    const spec: ScheduleSpec = { kind: 'once', onceAtIso: onceAt };
    const created = await createScheduleForThread(store, {
      threadKey: threadA, name: 'oneshot', spec, prompt: 'go', createdBy: 'user', nowMs: startMs,
    });
    assert.ok(created.ok);
    const job = created.record;
    assert.ok(job.nextRunAt !== null);

    const clock = createFakeClock(startMs);
    const caps = createCaptures();
    const engine = createSchedulerEngine({
      store, ledger: caps.ledger, deliver: caps.deliver,
      now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
    });

    engine.armJob(job);
    clock.tick(job.nextRunAt - startMs);
    await engine.whenIdle();

    assert.equal(caps.deliverCalls.length, 1, 'one-shot delivered once');
    assert.equal(store.getSchedules()[job.id], undefined, 'one-shot record removed after the fire');
    assert.equal(clock.pendingCount, 0, 'no timer left');
  });

  it('paused job: rearmAll skips arming; a fire racing a pause yields paused-skip with no deliver', async () => {
    const store = await newStore();
    const startMs = new Date(2026, 5, 6, 10, 0, 0).getTime();
    const created = await createScheduleForThread(store, {
      threadKey: threadA, name: 'paused', spec: everyFiveMinutes, prompt: 'go', createdBy: 'user', nowMs: startMs,
    });
    assert.ok(created.ok);
    const job = created.record;
    const dueAt = job.nextRunAt;
    assert.ok(dueAt !== null);

    const clock = createFakeClock(startMs);
    const caps = createCaptures();
    const engine = createSchedulerEngine({
      store, ledger: caps.ledger, deliver: caps.deliver,
      now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
    });

    // rearmAll on an already-paused record arms nothing.
    await store.setSchedulePaused(job.id, true, 'unbound');
    engine.rearmAll();
    assert.equal(clock.pendingCount, 0, 'paused job is not armed at boot');
    assert.equal(caps.deliverCalls.length, 0, 'paused job does not fire at boot');
    assert.equal(caps.ledgerRecords.length, 0, 'paused boot skip writes NO ledger entry');

    // Race: a timer was armed before the pause, then the pause lands; the fire
    // sees the fresh (paused) record → paused-skip, no deliver, stays disarmed.
    await store.setSchedulePaused(job.id, false); // unpause to arm
    engine.armJob(store.getSchedules()[job.id]);
    assert.equal(clock.pendingCount, 1);
    await store.setSchedulePaused(job.id, true, 'unbound'); // pause races the armed timer
    clock.tick(dueAt - startMs);
    await engine.whenIdle();

    assert.equal(caps.deliverCalls.length, 0, 'paused fire did not deliver');
    const pausedSkips = caps.ledgerRecords.filter((r) => r.kind === 'paused-skip');
    assert.equal(pausedSkips.length, 1, 'one paused-skip ledger record');
    assert.equal(clock.pendingCount, 0, 'paused-skip does NOT re-arm');
  });

  it('failed deliver: records lastRunStatus failed, re-arms, no unhandled rejection', async () => {
    const store = await newStore();
    const startMs = new Date(2026, 5, 6, 10, 0, 0).getTime();
    const created = await createScheduleForThread(store, {
      threadKey: threadA, name: 'fails', spec: everyFiveMinutes, prompt: 'go', createdBy: 'user', nowMs: startMs,
    });
    assert.ok(created.ok);
    const job = created.record;
    const dueAt = job.nextRunAt;
    assert.ok(dueAt !== null);

    const clock = createFakeClock(startMs);
    const caps = createCaptures();
    caps.setShouldThrow(true); // deliver rejects
    const engine = createSchedulerEngine({
      store, ledger: caps.ledger, deliver: caps.deliver,
      now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
    });

    engine.armJob(job);
    clock.tick(dueAt - startMs);
    await engine.whenIdle();

    const fresh = store.getSchedules()[job.id];
    assert.ok(fresh, 'recurring record survives a failed delivery');
    assert.equal(fresh.lastRunStatus, 'failed', 'failure classified, not swallowed silently');
    assert.ok(fresh.nextRunAt !== null && fresh.nextRunAt > dueAt, 're-armed despite failure');
    assert.equal(clock.pendingCount, 1, 'timer re-armed after a failed deliver');
    const endWithError = caps.ledgerRecords.find((r) => r.error !== undefined);
    assert.ok(endWithError, 'failure recorded in the ledger end entry');
  });

  it('long-delay clamp: a far-future nextRunAt arms an intermediate cap-sized timer', async () => {
    const store = await newStore();
    const startMs = new Date(2026, 5, 6, 10, 0, 0).getTime();
    const created = await createScheduleForThread(store, {
      threadKey: threadA, name: 'far', spec: everyFiveMinutes, prompt: 'go', createdBy: 'user', nowMs: startMs,
    });
    assert.ok(created.ok);
    const job = created.record;

    const clock = createFakeClock(startMs);
    const caps = createCaptures();
    const engine = createSchedulerEngine({
      store, ledger: caps.ledger, deliver: caps.deliver,
      now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
    });

    // Force a due time well beyond the setTimeout cap (~40 days out).
    const farDueAt = startMs + maxTimeoutMs + 60 * 60 * 1000;
    engine.armJob({ ...job, nextRunAt: farDueAt });

    assert.equal(clock.armedDelays.length, 1);
    assert.equal(clock.armedDelays[0], maxTimeoutMs, 'first hop is clamped to the cap, not the full delay');
    assert.equal(caps.deliverCalls.length, 0, 'does not fire early');

    // Advancing the cap fires the intermediate hop, which re-arms for the rest.
    clock.tick(maxTimeoutMs);
    await engine.whenIdle();
    assert.equal(caps.deliverCalls.length, 0, 'still not fired after one hop');
    const lastDelay = clock.armedDelays[clock.armedDelays.length - 1];
    assert.equal(lastDelay, farDueAt - (startMs + maxTimeoutMs), 'second hop is the remaining delay');
    assert.ok(lastDelay <= maxTimeoutMs, 'remaining delay now fits under the cap');
  });

  it('shutdown clears all armed timers', async () => {
    const store = await newStore();
    const startMs = new Date(2026, 5, 6, 10, 0, 0).getTime();
    const a = await createScheduleForThread(store, {
      threadKey: threadA, name: 'a', spec: everyFiveMinutes, prompt: 'go', createdBy: 'user', nowMs: startMs,
    });
    const b = await createScheduleForThread(store, {
      threadKey: threadA, name: 'b', spec: everyFiveMinutes, prompt: 'go', createdBy: 'user', nowMs: startMs,
    });
    assert.ok(a.ok && b.ok);

    const clock = createFakeClock(startMs);
    const caps = createCaptures();
    const engine = createSchedulerEngine({
      store, ledger: caps.ledger, deliver: caps.deliver,
      now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
    });

    engine.armJob(a.record);
    engine.armJob(b.record);
    assert.equal(clock.pendingCount, 2, 'two timers armed');

    engine.shutdown();
    assert.equal(clock.pendingCount, 0, 'shutdown cleared every timer');
  });
});
