import { z } from 'zod';
import { RotatingJsonlFile } from '../../utils/rotatingJsonlFile';

/**
 * @description The Jira connector's trigger log (plan J5, D12):
 * `DATA_DIR/jira-triggers.jsonl`, one line per trigger the poller decided on,
 * indexed in memory at boot. It is what keeps a trigger from becoming a second
 * request — after a restart too — and what the run budget counts. Connector-
 * owned, so the core request ledger stays platform-agnostic.
 */

export const jiraTriggerLogFileName = 'jira-triggers.jsonl';
/** Ample for years of triggers; the one `.1` backup is read too. */
const jiraTriggerLogMaxBytes = 10 * 1024 * 1024;
const msPerDay = 24 * 60 * 60 * 1000;

/**
 * @name JiraTriggerOutcome
 * @description `request` — a request was opened; `selfAuthored` — the AI account
 * made the change itself; `parked` — the issue was over its run budget.
 */
export type JiraTriggerOutcome = 'request' | 'selfAuthored' | 'parked';

const triggerRecordSchema = z.object({
  issueKey: z.string().min(1),
  triggerId: z.string().min(1),
  outcome: z.enum(['request', 'selfAuthored', 'parked']),
  /** Epoch ms. */
  at: z.number(),
  requestId: z.string().optional(),
});

export type JiraTriggerRecord = z.infer<typeof triggerRecordSchema>;

function getTriggerIdentity(issueKey: string, triggerId: string): string {
  return `${issueKey}\u0000${triggerId}`;
}

export class JiraTriggerLog {
  private readonly seen = new Set<string>();
  private readonly requestTimesByIssue = new Map<string, number[]>();

  constructor(private readonly file: RotatingJsonlFile<JiraTriggerRecord>) {}

  static createForDataDir(filePath: string): JiraTriggerLog {
    return new JiraTriggerLog(new RotatingJsonlFile<JiraTriggerRecord>(filePath, jiraTriggerLogMaxBytes));
  }

  /** @description Index the file. A line that does not parse is skipped with a warning (never fatal). */
  async load(): Promise<void> {
    const { records, skippedCount } = await this.file.readRecords(triggerRecordSchema);
    for (const record of records) this.index(record);
    if (skippedCount > 0) console.warn(`[jira] trigger log: ${skippedCount} unreadable line(s) skipped`);
  }

  private index(record: JiraTriggerRecord): void {
    this.seen.add(getTriggerIdentity(record.issueKey, record.triggerId));
    if (record.outcome !== 'request') return;
    const times = this.requestTimesByIssue.get(record.issueKey) ?? [];
    times.push(record.at);
    this.requestTimesByIssue.set(record.issueKey, times);
  }

  checkIsSeen(issueKey: string, triggerId: string): boolean {
    return this.seen.has(getTriggerIdentity(issueKey, triggerId));
  }

  /** @description Requests opened for the issue in the rolling 24 h before `nowMs`. */
  getRequestCountLastDay(issueKey: string, nowMs: number): number {
    return (this.requestTimesByIssue.get(issueKey) ?? []).filter((at) => at > nowMs - msPerDay).length;
  }

  /** @description Persist a decision; `false` when the line could not be written (then nothing is indexed). */
  record(record: JiraTriggerRecord): boolean {
    if (!this.file.append(record)) return false;
    this.index(record);
    return true;
  }

  /**
   * @description Index a decision whose line could not be written, for this
   * process only: a request already posted is never posted again before a
   * restart (after one, its trigger reads as new).
   */
  remember(record: JiraTriggerRecord): void {
    this.index(record);
  }
}
