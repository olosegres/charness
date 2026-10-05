/**
 * Test case: N/A — Charness has no Jira tracker
 *
 * @description The schedule re-base that runs when the operator changes the
 * instance timezone (`scheduler/timezoneRecompute.ts`).
 *
 * Load-bearing intent (per `.claude/rules/tests.md`):
 * - THE trap: the engine's boot replay (`rearmAll`) arms from the STORED
 *   `nextRunAt` and treats a past one as a MISSED run — it announces, pins and
 *   delivers a catch-up. A zone change routinely leaves stored `nextRunAt`
 *   values in the past, so reusing `rearmAll` would spam bogus "missed at
 *   HH:MM" runs into every topic. The first two tests are a deliberate
 *   CONTRAST: the same state fires a catch-up under `rearmAll` and fires
 *   NOTHING under the recompute. Without the contrast, "no delivery" could
 *   pass vacuously on a state that was never catch-up-eligible.
 * - wall clock is PRESERVED across the change: a 09:00 cron stays 09:00 in the
 *   new zone rather than drifting by the offset delta.
 * - an expired one-shot is DROPPED (it has no future instant, so it cannot be
 *   armed and must not linger as a husk) — the same rule the rebind path uses.
 * - PAUSED jobs are recomputed too but stay disarmed: skipping them would leave
 *   a stale pre-change instant that a later resume would arm.
 *
 * The clock and timer queue are injected fakes, so nothing waits on wall time.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StateStore } from '../state';
import type { SessionKey } from '../sessionKey';
import { createSchedulerEngine } from '../scheduler/engine';
import { createScheduleForThread } from '../scheduler/store';
import { recomputeSchedulesForTimezoneChange } from '../scheduler/timezoneRecompute';
import type { DeliveryOutcome, FireContext, ScheduleRecord, ScheduleSpec } from '../scheduler/types';
import type { ScheduleRunRecord } from '../scheduler/runLedger';
import { applyProcessTimezone } from '../utils/timezone';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';

const thread: SessionKey = makeTelegramKey(-1001111111111, 11);
const everyMorningAtNine: ScheduleSpec = { kind: 'cron', cronExpr: '0 9 * * *' };

/** How far in the past a stored `nextRunAt` is put to make it catch-up eligible. */
const staleRunOffsetMs = 30 * 60 * 1000;

function createFakeClock(startMs: number) {
  let nowMs = startMs;
  let nextId = 1;
  const pending = new Map<number, { callback: () => void; dueAt: number }>();

  return {
    now: () => nowMs,
    setTimeoutFn(callback: () => void, delayMs: number): NodeJS.Timeout {
      const id = nextId;
      nextId += 1;
      pending.set(id, { callback, dueAt: nowMs + delayMs });
      return { unref() {}, [Symbol.toPrimitive]: () => id } as unknown as NodeJS.Timeout;
    },
    clearTimeoutFn(handle: NodeJS.Timeout): void {
      pending.delete(Number(handle as unknown as number));
    },
    get pendingCount() {
      return pending.size;
    },
  };
}

function createCaptures() {
  const deliverCalls: Array<{ job: ScheduleRecord; fireContext: FireContext }> = [];
  const ledgerRecords: ScheduleRunRecord[] = [];
  return {
    deliverCalls,
    ledgerRecords,
    ledger: { append: (record: ScheduleRunRecord) => ledgerRecords.push(record) },
    deliver: (job: ScheduleRecord, fireContext: FireContext): Promise<DeliveryOutcome> => {
      deliverCalls.push({ job: { ...job }, fireContext: { ...fireContext } });
      return Promise.resolve({ status: 'delivered' });
    },
  };
}

describe('recomputeSchedulesForTimezoneChange', () => {
  let dataDir: string;
  let fakeHome: string;
  let originalHome: string | undefined;
  let stores: StateStore[] = [];

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-tz-recompute-'));
    dataDir = path.join(fakeHome, '.telegramCode');
    fs.mkdirSync(dataDir, { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });

  afterEach(async () => {
    for (const store of stores) await store.flush();
    stores = [];
    applyProcessTimezone(null);
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

  /**
   * Persist one job whose stored `nextRunAt` already lies in the past — the
   * exact state a zone change produces, and the state `rearmAll` reads as a
   * missed run.
   */
  async function seedStaleJob(store: StateStore, nowMs: number, overrides: Partial<ScheduleRecord> = {}) {
    const created = await createScheduleForThread(store, {
      threadKey: thread, name: 'morning digest', spec: everyMorningAtNine,
      prompt: 'digest', createdBy: 'user', nowMs,
    });
    assert.ok(created.ok);
    const stale: ScheduleRecord = {
      ...created.record,
      nextRunAt: nowMs - staleRunOffsetMs,
      ...overrides,
    };
    await store.upsertSchedule(stale);
    await store.flush();
    return stale;
  }

  it('CONTRAST: rearmAll fires a bogus catch-up for the same stale state', async () => {
    // This is the behaviour the recompute exists to avoid. If this ever stops
    // firing, the next test's "no delivery" assertion would become vacuous.
    const store = await newStore();
    const nowMs = Date.UTC(2026, 8, 14, 12, 0, 0);
    await seedStaleJob(store, nowMs);

    const clock = createFakeClock(nowMs);
    const caps = createCaptures();
    const engine = createSchedulerEngine({
      store, ledger: caps.ledger, deliver: caps.deliver,
      now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
    });

    await engine.rearmAll();
    await engine.whenIdle();

    assert.equal(caps.deliverCalls.length, 1, 'rearmAll DOES fire on a past nextRunAt');
    assert.equal(caps.deliverCalls[0].fireContext.kind, 'catch-up');
  });

  it('recomputes and re-arms without firing a single catch-up', async () => {
    const store = await newStore();
    const nowMs = Date.UTC(2026, 8, 14, 12, 0, 0);
    const stale = await seedStaleJob(store, nowMs);

    const clock = createFakeClock(nowMs);
    const caps = createCaptures();
    const engine = createSchedulerEngine({
      store, ledger: caps.ledger, deliver: caps.deliver,
      now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
    });

    const result = await recomputeSchedulesForTimezoneChange({ store, engine, now: clock.now });

    assert.equal(caps.deliverCalls.length, 0, 'NO catch-up announcement may reach the topic');
    assert.equal(caps.ledgerRecords.length, 0, 'and nothing is recorded as a run');
    assert.deepEqual(result, { recomputed: 1, removed: 0 });

    const fresh = store.getSchedules()[stale.id];
    assert.ok(fresh.nextRunAt !== null);
    assert.ok(fresh.nextRunAt > nowMs, 'nextRunAt moved strictly into the future');
    assert.notEqual(fresh.nextRunAt, stale.nextRunAt, 'the stale instant was replaced');
    assert.equal(clock.pendingCount, 1, 'the job is armed again');
  });

  it('preserves wall clock: a 09:00 cron stays 09:00 in the new zone', async () => {
    const store = await newStore();
    const nowMs = Date.UTC(2026, 8, 14, 12, 0, 0);

    applyProcessTimezone('UTC');
    const created = await createScheduleForThread(store, {
      threadKey: thread, name: 'morning digest', spec: everyMorningAtNine,
      prompt: 'digest', createdBy: 'user', nowMs,
    });
    assert.ok(created.ok);
    assert.equal(
      new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', hourCycle: 'h23' })
        .format(new Date(created.record.nextRunAt ?? 0)),
      '09',
      'baseline: 09:00 UTC under the old zone',
    );

    // The operator moves the instance to a zone three hours ahead.
    applyProcessTimezone('Europe/Moscow');

    const clock = createFakeClock(nowMs);
    const caps = createCaptures();
    const engine = createSchedulerEngine({
      store, ledger: caps.ledger, deliver: caps.deliver,
      now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
    });
    await recomputeSchedulesForTimezoneChange({ store, engine, now: clock.now });

    const fresh = store.getSchedules()[created.record.id];
    assert.ok(fresh.nextRunAt !== null);
    assert.equal(
      new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Moscow', hour: '2-digit', hourCycle: 'h23' })
        .format(new Date(fresh.nextRunAt)),
      '09',
      'the job still fires at 09:00 — now the operator\'s 09:00, not the host\'s',
    );
    assert.notEqual(fresh.nextRunAt, created.record.nextRunAt, 'the absolute instant moved');
    assert.equal(caps.deliverCalls.length, 0, 'still no catch-up');
  });

  it('drops an expired one-shot instead of leaving an unarmable husk', async () => {
    const store = await newStore();
    const nowMs = Date.UTC(2026, 8, 14, 12, 0, 0);
    const created = await createScheduleForThread(store, {
      threadKey: thread, name: 'one shot',
      spec: { kind: 'once', onceAtIso: new Date(nowMs + 60 * 60 * 1000).toISOString() },
      prompt: 'ping', createdBy: 'user', nowMs,
    });
    assert.ok(created.ok);

    const clock = createFakeClock(nowMs);
    const caps = createCaptures();
    const engine = createSchedulerEngine({
      store, ledger: caps.ledger, deliver: caps.deliver,
      now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
    });
    engine.armJob(created.record);
    assert.equal(clock.pendingCount, 1, 'armed before the change');

    // Recompute from an instant AFTER the one-shot's moment: there is no future
    // occurrence left for it.
    const laterMs = nowMs + 2 * 60 * 60 * 1000;
    const result = await recomputeSchedulesForTimezoneChange({
      store, engine, now: () => laterMs,
    });

    assert.deepEqual(result, { recomputed: 0, removed: 1 });
    assert.equal(store.getSchedules()[created.record.id], undefined, 'the record is gone');
    assert.equal(clock.pendingCount, 0, 'and its timer was disarmed');
    assert.equal(caps.deliverCalls.length, 0, 'an expired one-shot is dropped, never fired');
  });

  it('recomputes a PAUSED job too, but leaves it disarmed', async () => {
    const store = await newStore();
    const nowMs = Date.UTC(2026, 8, 14, 12, 0, 0);
    const stale = await seedStaleJob(store, nowMs, { isPaused: true, pauseReason: 'unbound' });

    const clock = createFakeClock(nowMs);
    const caps = createCaptures();
    const engine = createSchedulerEngine({
      store, ledger: caps.ledger, deliver: caps.deliver,
      now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
    });

    const result = await recomputeSchedulesForTimezoneChange({ store, engine, now: clock.now });
    assert.equal(result.recomputed, 1, 'a paused job is still re-based');

    const fresh = store.getSchedules()[stale.id];
    assert.ok(fresh.nextRunAt !== null && fresh.nextRunAt > nowMs, 'its stale instant was replaced');
    assert.equal(fresh.isPaused, true, 'the pause itself is untouched');
    assert.equal(fresh.pauseReason, 'unbound');
    assert.equal(clock.pendingCount, 0, 'a paused job must NOT be armed');
    assert.equal(caps.deliverCalls.length, 0);
  });

  it('is a no-op with no schedules', async () => {
    const store = await newStore();
    const clock = createFakeClock(Date.UTC(2026, 8, 14, 12, 0, 0));
    const caps = createCaptures();
    const engine = createSchedulerEngine({
      store, ledger: caps.ledger, deliver: caps.deliver,
      now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
    });
    assert.deepEqual(
      await recomputeSchedulesForTimezoneChange({ store, engine, now: clock.now }),
      { recomputed: 0, removed: 0 },
    );
  });
});
