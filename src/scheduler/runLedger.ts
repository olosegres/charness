import path from 'node:path';
import { resolveDataDir } from '../state';
import { RotatingJsonlFile } from '../utils/rotatingJsonlFile';

/**
 * @description Append-only run ledger for the scheduler — one JSONL line per
 * fire under `DATA_DIR/scheduler-runs.jsonl`. It is the durable audit trail of
 * what fired, when, how (on-time / catch-up / skipped / paused) and whether it
 * was delivered, so a no-overlap skip or a missed run is never silent.
 *
 * Sync `appendFileSync`, mirroring `diagLog.ts`: writes are per-fire and low
 * cadence (capped per job by `minFireIntervalMs`), so synchronous I/O is fine
 * and keeps the "always wrote the record" guarantee simple. Like diagLog it
 * never throws — a ledger failure must not take a fire down.
 *
 * Size bound: once the file passes {@link maxLedgerBytes} it rolls to a single
 * `.1` backup (overwriting the previous backup), so total on-disk size never
 * exceeds roughly `2 × maxLedgerBytes` (the shared {@link RotatingJsonlFile}).
 */
export const maxLedgerBytes = 10 * 1024 * 1024;

/**
 * @name ScheduleRunKind
 * @description Why/how a fire happened, recorded per ledger entry.
 *  - `on-time`        — fired at (or within tolerance of) its scheduled instant.
 *  - `catch-up`       — a run missed while the bot was down, replayed once at boot.
 *  - `skipped-overlap`— the previous fire was still delivering; this one skipped.
 *  - `paused-skip`    — the job was paused (e.g. unbound) when its timer fired.
 */
export type ScheduleRunKind = 'on-time' | 'catch-up' | 'skipped-overlap' | 'paused-skip';

/**
 * @name ScheduleRunRecord
 * @description One ledger line. `deliveredAt`/`error` are absent until the
 * delivery pipeline resolves (skipped/paused entries never get them).
 */
export interface ScheduleRunRecord {
  runId: string;
  jobId: string;
  threadKey: string;
  /** Epoch ms the fire was recorded. */
  firedAt: number;
  kind: ScheduleRunKind;
  /** Epoch ms the prompt reached the agent, when delivery happened. */
  deliveredAt?: number;
  /** Failure message when delivery threw. */
  error?: string;
}

/** Default ledger path under the live `DATA_DIR`. Resolved lazily by the writer. */
function getDefaultLedgerPath(): string {
  return path.join(resolveDataDir(), 'scheduler-runs.jsonl');
}

/**
 * @description Append-only writer for the run ledger. The path is injectable so
 * tests can target a tmp dir under `./agent/tmp/`; production uses the lazy
 * `DATA_DIR` default.
 */
export class RunLedger {
  private readonly file: RotatingJsonlFile<ScheduleRunRecord>;

  constructor(ledgerPath?: string) {
    this.file = new RotatingJsonlFile(ledgerPath ?? getDefaultLedgerPath(), maxLedgerBytes);
  }

  /** Path of the live ledger file (for logging / tests). */
  get filePath(): string {
    return this.file.filePath;
  }

  /**
   * @description Append one run record as a JSONL line. Never throws — a
   * ledger failure must not break a fire (same discipline as `appendDiagLog`).
   */
  append(record: ScheduleRunRecord): void {
    // Ledger is best-effort; a write failure must never break a fire.
    this.file.append(record);
  }
}
