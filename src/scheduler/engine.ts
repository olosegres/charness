import { randomBytes } from 'node:crypto';
import type { StateStore } from '../state';
import { getCatchUpDecision, getNextRunAt } from './recurrence';
import type { RunLedger } from './runLedger';
import type { DeliveryOutcome, FireContext, ScheduleRecord } from './types';

/**
 * @description The scheduler timer engine (plan S3). Owns one `setTimeout` per
 * armed job, the boot replay (`rearmAll`), and the no-overlap guard. It is
 * deliberately decoupled from `bot.ts`: every external concern is injected via
 * {@link SchedulerEngineDeps} (the store, the run ledger, a `deliver` callback,
 * a clock, and optional timer functions), so the engine is constructible in a
 * test with a fake clock and a fake `deliver`.
 *
 * Lifecycle of one job:
 *
 *   armJob(record)  → setTimeout(nextRunAt − now), clamped to {@link maxTimeoutMs}
 *       │              (a longer delay arms an INTERMEDIATE timer that re-arms).
 *       ▼
 *   timer fires → re-read the FRESH record from the store (it may have been
 *       │          removed/paused since arming); then:
 *       │            gone        → disarm, no-op
 *       │            paused      → ledger 'paused-skip', disarm (do NOT re-arm)
 *       │            in-flight   → ledger 'skipped-overlap', recompute + re-arm
 *       │            otherwise   → fire()
 *       ▼
 *   fire() → ledger begin record → await deliver(job, fireContext) (wrapped:
 *       │     a thrown deliver is classified 'failed', never kills the engine)
 *       │   → bookkeeping (lastRunAt/lastRunStatus; recurring recompute+re-arm;
 *       │     N-times decrement, remove at 0; one-shot remove) → store.flush()
 *       ▼     → ledger end record (always written).
 *
 * The boot replay (`rearmAll`) feeds a job whose run was missed into the same
 * chain as a timer that is due at once (a catch-up), and never awaits it.
 */

/**
 * Node's `setTimeout` clamps any delay above 2^31−1 ms (~24.8 days) to 1, which
 * would fire the timer immediately. For a job further out than this we arm an
 * INTERMEDIATE timer at the cap that simply re-arms when it fires, walking the
 * delay down in cap-sized hops until it fits.
 */
export const maxTimeoutMs = 2_147_483_647;

/** Length of the hex run-id minted per fire for the ledger correlation. */
const runIdByteLength = 8;

/**
 * @name SchedulerEngineDeps
 * @description Everything the engine needs from the outside world. `store` and
 * `ledger` are the persistence seams; `deliver` is the actual fire action
 * (announce + pin + forward, implemented in S4); `now` is the injectable clock;
 * `setTimeoutFn`/`clearTimeoutFn` let tests drive a fake timer queue.
 */
export interface SchedulerEngineDeps {
  store: Pick<StateStore, 'getSchedules' | 'upsertSchedule' | 'removeSchedule' | 'flush'>;
  ledger: Pick<RunLedger, 'append'>;
  /** Fire the job: announce, pin, deliver to the agent. Resolves with the outcome. */
  deliver: (job: ScheduleRecord, fireContext: FireContext) => Promise<DeliveryOutcome>;
  /** Current epoch ms. Injected so tests run on a fake clock. */
  now: () => number;
  setTimeoutFn?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  clearTimeoutFn?: (handle: NodeJS.Timeout) => void;
}

/**
 * @name SchedulerEngine
 * @description Public engine surface. `armJob`/`disarmJob` manage a single
 * job's timer; `rearmAll` is the boot step (walks the store, fires catch-ups,
 * arms the rest); `shutdown` clears every timer.
 */
export interface SchedulerEngine {
  /** Arm (or re-arm) a single job's timer to its `nextRunAt`. */
  armJob(record: ScheduleRecord): void;
  /** Cancel a job's timer if one is armed. Idempotent. */
  disarmJob(jobId: string): void;
  /**
   * Boot replay: arm every persisted job and start one catch-up per missed run
   * (those of one topic one after another, those of different topics side by
   * side). Returns at once: the boot must never wait for a catch-up's delivery,
   * which waits for its agent, and an agent waiting for the operator's answer is
   * answered only once the bot polls (`whenIdle` is the way to wait for the
   * catch-ups). `void` states that the boot has no promise to wait for; it does
   * not forbid one (a function returning a promise still fits it) — the boot
   * phase's own test, with a replay that never settles, pins the contract.
   */
  rearmAll(): void;
  /**
   * Resolve once every fire chain currently in flight (delivery + bookkeeping +
   * flush + ledger end record) has settled. A timer-driven fire and a boot
   * catch-up are dispatched fire-and-forget, so this is the seam a caller (or a
   * test) uses to await them.
   */
  whenIdle(): Promise<void>;
  /** Clear every armed timer (process shutdown). */
  shutdown(): void;
}

export function createSchedulerEngine(deps: SchedulerEngineDeps): SchedulerEngine {
  const { store, ledger, deliver, now } = deps;
  const armTimer = deps.setTimeoutFn ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = deps.clearTimeoutFn ?? ((handle) => clearTimeout(handle));

  /** jobId → its armed timer handle. The single source of truth for "is armed". */
  const timers = new Map<string, NodeJS.Timeout>();
  /** jobIds whose delivery is currently in flight — the no-overlap guard. */
  const inFlight = new Set<string>();
  /**
   * Every still-running timer-callback chain (`onTimer`). `whenIdle` awaits
   * these; entries remove themselves on settle. A Set (not a count) so the
   * same job firing twice tracks both chains.
   */
  const activeChains = new Set<Promise<void>>();

  /**
   * Run an `onTimer` chain, tracking it so {@link whenIdle} can await it.
   * `startAfter` queues it behind an earlier chain (a catch-up waiting for the
   * topic's earlier one, see {@link onQueuedCatchUp}); both chains never reject,
   * so a queued one always starts. Resolves when the chain has settled.
   */
  function trackChain(jobId: string, startAfter?: Promise<void>): Promise<void> {
    const chain = (startAfter === undefined ? onTimer(jobId) : startAfter.then(() => onQueuedCatchUp(jobId))).finally(() => {
      activeChains.delete(chain);
    });
    activeChains.add(chain);
    return chain;
  }

  async function whenIdle(): Promise<void> {
    // Re-snapshot until stable: a settling chain may have re-armed nothing, but
    // an overlap/bookkeeping path can spawn follow-up awaits within the same
    // chain; awaiting the snapshot then re-checking covers chains added late.
    while (activeChains.size > 0) {
      await Promise.allSettled([...activeChains]);
    }
  }

  function disarmJob(jobId: string): void {
    const handle = timers.get(jobId);
    if (handle) {
      clearTimer(handle);
      timers.delete(jobId);
    }
  }

  /**
   * Arm a timer for `jobId` due at `dueAtMs`. Delays beyond {@link maxTimeoutMs}
   * arm an intermediate hop that re-arms toward the real due time. Any existing
   * timer for the job is cleared first so re-arming never leaks a timer.
   */
  function armAt(jobId: string, dueAtMs: number): void {
    disarmJob(jobId);
    const delayMs = Math.max(0, dueAtMs - now());
    if (delayMs > maxTimeoutMs) {
      const intermediate = armTimer(() => armAt(jobId, dueAtMs), maxTimeoutMs);
      intermediate.unref?.();
      timers.set(jobId, intermediate);
      return;
    }
    const handle = armTimer(() => {
      trackChain(jobId);
    }, delayMs);
    handle.unref?.();
    timers.set(jobId, handle);
  }

  function armJob(record: ScheduleRecord): void {
    if (record.isPaused) {
      // Paused jobs stay disarmed silently — no ledger entry (a 'paused-skip'
      // is only for a fire attempt that races a pause, see onTimer).
      disarmJob(record.id);
      return;
    }
    if (record.nextRunAt === null) {
      disarmJob(record.id);
      return;
    }
    armAt(record.id, record.nextRunAt);
  }

  /**
   * Timer callback for `jobId`. Re-reads the fresh record (it may have changed
   * between arm and fire), applies the re-validate / overlap / paused gates,
   * and dispatches to {@link fire}. Never throws — a thrown body would escape
   * the timer callback and could take the process down.
   */
  async function onTimer(jobId: string): Promise<void> {
    try {
      // The armed timer has now fired; drop its handle so disarm is a no-op and
      // re-arms below install a clean one.
      timers.delete(jobId);

      const record = store.getSchedules()[jobId];
      if (!record) {
        // Removed between arm and fire — nothing to do, nothing armed.
        return;
      }
      if (record.isPaused) {
        ledger.append({
          runId: mintRunId(),
          jobId,
          threadKey: record.threadKey,
          firedAt: now(),
          kind: 'paused-skip',
        });
        // Do NOT re-arm — a paused job stays disarmed until resumed (S8).
        return;
      }
      if (inFlight.has(jobId)) {
        // Previous fire still delivering — skip this occurrence, advance, re-arm.
        ledger.append({
          runId: mintRunId(),
          jobId,
          threadKey: record.threadKey,
          firedAt: now(),
          kind: 'skipped-overlap',
        });
        await advanceOverlap(record);
        return;
      }
      await fire(record);
    } catch (error) {
      console.error(`[scheduler] timer callback failed for job ${jobId}:`, error);
    }
  }

  /**
   * The turn of a catch-up that waited behind another one of its topic. While it
   * waited, something may have re-armed the job — a `/timezone` change recomputes
   * every `nextRunAt` from now, a rebind of the topic resumes its jobs: the record
   * then carries a next run in the future and a timer of its own. Firing it now
   * would deliver a run nobody scheduled, and a second one when that timer comes
   * due, so such a job is left to its timer. The same holds once that timer has
   * fired: its delivery is in flight and its own bookkeeping owns the next run,
   * while the record still holds the old `nextRunAt` — which reads as missed by
   * now, and would book an overlap for a run that was never due. Only a job that
   * is still missed, has no timer and is not in flight takes its turn, through
   * the same chain as any fire.
   */
  async function onQueuedCatchUp(jobId: string): Promise<void> {
    const record = store.getSchedules()[jobId];
    const isOwnedElsewhere = timers.has(jobId) || inFlight.has(jobId);
    if (record && (isOwnedElsewhere || getCatchUpDecision({ nextRunAt: record.nextRunAt, nowMs: now() }) !== 'fire-missed')) return;
    await onTimer(jobId);
  }

  /**
   * After a skipped-overlap: persist the advanced `nextRunAt` (recurring) or
   * leave a one-shot/N-times-final alone, and re-arm if there is a next run.
   * Bookkeeping here is light — the skip is not a "run", so lastRunStatus is
   * recorded as 'skipped-overlap' for visibility but remainingRuns is untouched.
   */
  async function advanceOverlap(record: ScheduleRecord): Promise<void> {
    const nextRunAt = getNextRunAt(record.spec, now());
    const updated: ScheduleRecord = {
      ...record,
      lastRunAt: now(),
      lastRunStatus: 'skipped-overlap',
      nextRunAt,
      updatedAt: new Date(now()).toISOString(),
    };
    if (nextRunAt === null) {
      // A one-shot that overlapped its own (already-elapsed) instant: nothing
      // more to run, drop the record like a completed one-shot.
      await store.removeSchedule(record.id);
    } else {
      await store.upsertSchedule(updated);
      armAt(record.id, nextRunAt);
    }
    await store.flush();
  }

  /**
   * Execute one fire: ledger begin, await the (wrapped) deliver, bookkeeping,
   * flush, ledger end. Classifies a thrown deliver as 'failed' so an exception
   * never skips bookkeeping or kills the engine.
   */
  async function fire(record: ScheduleRecord): Promise<void> {
    const runId = mintRunId();
    const firedAt = now();
    const decision = getCatchUpDecision({ nextRunAt: record.nextRunAt, nowMs: firedAt });
    const isCatchUp = decision === 'fire-missed';
    const fireContext: FireContext = isCatchUp
      ? { kind: 'catch-up', missedAtMs: record.nextRunAt ?? undefined }
      : { kind: 'on-time' };

    ledger.append({
      runId,
      jobId: record.id,
      threadKey: record.threadKey,
      firedAt,
      kind: isCatchUp ? 'catch-up' : 'on-time',
    });

    inFlight.add(record.id);
    let outcome: DeliveryOutcome;
    try {
      outcome = await deliver(record, fireContext);
    } catch (error) {
      outcome = { status: 'failed', error: error instanceof Error ? error.message : String(error) };
    } finally {
      inFlight.delete(record.id);
    }

    const deliveredAt = now();
    try {
      await applyBookkeeping(record, outcome, deliveredAt);
    } catch (error) {
      console.error(`[scheduler] bookkeeping failed for job ${record.id}:`, error);
    }

    ledger.append({
      runId,
      jobId: record.id,
      threadKey: record.threadKey,
      firedAt,
      kind: isCatchUp ? 'catch-up' : 'on-time',
      deliveredAt,
      ...(outcome.status === 'failed' && outcome.error ? { error: outcome.error } : {}),
    });
  }

  /**
   * Update the record after a completed fire and re-arm (or remove). Reads the
   * fresh record again so a pause/removal during delivery is respected. flush()
   * is awaited because `nextRunAt`/`remainingRuns` are crash-critical.
   */
  async function applyBookkeeping(
    original: ScheduleRecord,
    outcome: DeliveryOutcome,
    deliveredAt: number,
  ): Promise<void> {
    const fresh = store.getSchedules()[original.id];
    if (!fresh) {
      // Removed mid-delivery — leave it gone, just make sure nothing is armed.
      disarmJob(original.id);
      await store.flush();
      return;
    }

    if (fresh.isPaused) {
      // Paused DURING delivery (e.g. the deliver callback hit an unbound topic
      // and parked the job, S8): the engine never arms a paused job, so do NOT
      // re-arm a recurring one or delete a one-shot — just stay disarmed and let
      // the rebind-resume path own its lifecycle. (A pause BEFORE the timer fires
      // is caught earlier in onTimer as a paused-skip.)
      disarmJob(fresh.id);
      await store.flush();
      return;
    }

    const lastRunStatus = outcome.status === 'delivered' ? 'delivered' : 'failed';

    if (fresh.spec.kind === 'once') {
      await store.removeSchedule(fresh.id);
      disarmJob(fresh.id);
      await store.flush();
      return;
    }

    // cron (possibly N-times)
    if (typeof fresh.spec.remainingRuns === 'number') {
      const remaining = fresh.spec.remainingRuns - 1;
      if (remaining <= 0) {
        await store.removeSchedule(fresh.id);
        disarmJob(fresh.id);
        await store.flush();
        return;
      }
      const nextRunAt = getNextRunAt(fresh.spec, deliveredAt);
      const updated: ScheduleRecord = {
        ...fresh,
        spec: { ...fresh.spec, remainingRuns: remaining },
        lastRunAt: deliveredAt,
        lastRunStatus,
        nextRunAt,
        updatedAt: new Date(deliveredAt).toISOString(),
      };
      await store.upsertSchedule(updated);
      if (nextRunAt !== null) armAt(fresh.id, nextRunAt);
      else disarmJob(fresh.id);
      await store.flush();
      return;
    }

    // plain recurring cron
    const nextRunAt = getNextRunAt(fresh.spec, deliveredAt);
    const updated: ScheduleRecord = {
      ...fresh,
      lastRunAt: deliveredAt,
      lastRunStatus,
      nextRunAt,
      updatedAt: new Date(deliveredAt).toISOString(),
    };
    await store.upsertSchedule(updated);
    if (nextRunAt !== null) armAt(fresh.id, nextRunAt);
    else disarmJob(fresh.id);
    await store.flush();
  }

  /**
   * Boot replay. Walks every persisted job:
   *   - paused → skip silently (stays disarmed; no ledger entry).
   *   - nextRunAt missed (getCatchUpDecision → 'fire-missed') → fire ONCE as a
   *     catch-up (the deliver callback gets `missedAtMs`), then bookkeeping
   *     recomputes nextRunAt from now and re-arms.
   *   - on-time / future → just arm.
   * A catch-up is a due timer that fires at once: it goes through the same
   * tracked chain (`trackChain`, so the no-overlap guard, the fresh-record
   * re-read and the error containment apply) and is NEVER awaited here; the
   * return type is `void` because there is nothing to wait for. The
   * boot waits for no delivery: a delivery waits for its agent to go idle, and
   * an agent mid-turn can be waiting for the operator's answer — which cannot
   * arrive before the bot polls, and the polling starts after the boot.
   * Awaiting it deadlocked the boot, and a stuck catch-up also held every job
   * stored after it unarmed. {@link whenIdle} awaits the catch-ups.
   * The catch-ups of ONE topic (one `threadKey`) run one after another, as the
   * replay always did: every missed run of a boot is due at the same instant, and
   * two prompts must not reach one agent together — the second one waits for the
   * first one's delivery, then sees the agent busy with its turn and waits for
   * that ({@link onQueuedCatchUp} drops it if the job was re-armed meanwhile).
   * Different topics run side by side, so a stuck one holds up only its
   * own topic; their announcements still go out one by one through the
   * process-wide send gate.
   */
  function rearmAll(): void {
    /** threadKey → the catch-up chain queued last for it: the next catch-up of that topic starts after it. */
    const lastCatchUpByThread = new Map<string, Promise<void>>();
    for (const record of Object.values(store.getSchedules())) {
      if (record.isPaused) continue;
      const decision = getCatchUpDecision({ nextRunAt: record.nextRunAt, nowMs: now() });
      if (decision === 'fire-missed') {
        // fire() reads the same catch-up decision and handles re-arming via
        // bookkeeping; nothing else to arm here.
        lastCatchUpByThread.set(record.threadKey, trackChain(record.id, lastCatchUpByThread.get(record.threadKey)));
        continue;
      }
      armJob(record);
    }
  }

  function shutdown(): void {
    for (const handle of timers.values()) clearTimer(handle);
    timers.clear();
  }

  function mintRunId(): string {
    return randomBytes(runIdByteLength).toString('hex');
  }

  return { armJob, disarmJob, rearmAll, whenIdle, shutdown };
}
