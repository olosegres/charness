import { z } from 'zod';
import { RotatingJsonlFile } from '../../utils/rotatingJsonlFile';
import { compareJiraCommentIds, mentionTriggerIdPrefix } from './trigger';

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
 * made the change itself; `parked` — the issue was over its run budget;
 * `untrusted` — the hand-over (or the mention, or the comment) was made by someone the trusted
 * group does not back; `covered` — with `wakeOnComment` off, a mention by the requester of an
 * open hand-over request of the issue, recorded and not delivered (it opens no request and
 * counts for nothing); `update` — a comment that reached the agent inside an open hand-over
 * request (an issue update), or alongside a newer comment's request of the same poll (it opens
 * no request and counts for nothing).
 */
export type JiraTriggerOutcome = 'request' | 'selfAuthored' | 'parked' | 'untrusted' | 'covered' | 'update';

const triggerRecordSchema = z.object({
  issueKey: z.string().min(1),
  triggerId: z.string().min(1),
  outcome: z.enum(['request', 'selfAuthored', 'parked', 'untrusted', 'covered', 'update']),
  /** Epoch ms. */
  at: z.number(),
  requestId: z.string().optional(),
  /**
   * The newest comment of the issue (by id) the prompt that went with this decision was built from: the conversation
   * was shown every comment up to it, so only a later one is new to it — whatever a compaction or a fresh session
   * made it forget. Absent on a decision that sent no prompt, and on every line written before it was recorded.
   */
  newestCommentId: z.string().optional(),
  /**
   * A `parked` mention only: whether its park notice was posted (at most one per issue per rolling 24 h, the others
   * are recorded silently). Absent → posted, as every older line was.
   */
  isNoticePosted: z.boolean().optional(),
});

export type JiraTriggerRecord = z.infer<typeof triggerRecordSchema>;

function getTriggerIdentity(issueKey: string, triggerId: string): string {
  return `${issueKey}\u0000${triggerId}`;
}

export class JiraTriggerLog {
  private readonly seen = new Set<string>();
  private readonly requestTimesByIssue = new Map<string, number[]>();
  private readonly mentionParkNoticeTimesByIssue = new Map<string, number[]>();
  private readonly newestCommentIdByIssue = new Map<string, string>();
  /** Per issue, when each issue update was posted (its comments share the time). */
  private readonly updateTimesByIssue = new Map<string, Set<number>>();
  private readonly lastDecidedAtByIssue = new Map<string, number>();

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
    this.lastDecidedAtByIssue.set(record.issueKey, Math.max(record.at, this.lastDecidedAtByIssue.get(record.issueKey) ?? record.at));
    const shownBefore = this.newestCommentIdByIssue.get(record.issueKey);
    if (record.newestCommentId !== undefined && (shownBefore === undefined || compareJiraCommentIds(record.newestCommentId, shownBefore) > 0)) {
      this.newestCommentIdByIssue.set(record.issueKey, record.newestCommentId);
    }
    if (record.outcome === 'parked' && record.triggerId.startsWith(mentionTriggerIdPrefix) && record.isNoticePosted !== false) {
      const noticeTimes = this.mentionParkNoticeTimesByIssue.get(record.issueKey) ?? [];
      noticeTimes.push(record.at);
      this.mentionParkNoticeTimesByIssue.set(record.issueKey, noticeTimes);
    }
    if (record.outcome === 'update') {
      const updateTimes = this.updateTimesByIssue.get(record.issueKey) ?? new Set<number>();
      updateTimes.add(record.at);
      this.updateTimesByIssue.set(record.issueKey, updateTimes);
    }
    if (record.outcome !== 'request') return;
    const times = this.requestTimesByIssue.get(record.issueKey) ?? [];
    times.push(record.at);
    this.requestTimesByIssue.set(record.issueKey, times);
  }

  checkIsSeen(issueKey: string, triggerId: string): boolean {
    return this.seen.has(getTriggerIdentity(issueKey, triggerId));
  }

  /** @description Requests opened for the issue in the rolling 24 h before `nowMs`: hand-overs and mentions together. */
  getRequestCountLastDay(issueKey: string, nowMs: number): number {
    return (this.requestTimesByIssue.get(issueKey) ?? []).filter((at) => at > nowMs - msPerDay).length;
  }

  /**
   * @description The newest comment id any recorded prompt of the issue was built from (see `newestCommentId`), or
   * `null` when no decision of the issue recorded one.
   */
  getNewestShownCommentId(issueKey: string): string | null {
    return this.newestCommentIdByIssue.get(issueKey) ?? null;
  }

  /** @description When the newest decision on the issue was made (epoch ms), or `null` when none is recorded. */
  getLastDecidedAt(issueKey: string): number | null {
    return this.lastDecidedAtByIssue.get(issueKey) ?? null;
  }

  /**
   * @description Issue updates posted on the issue in the rolling 24 h before `nowMs` — one per post, however many comments
   * it carried (they are recorded with its time) — for the cap on updates.
   */
  getUpdateCountLastDay(issueKey: string, nowMs: number): number {
    return [...(this.updateTimesByIssue.get(issueKey) ?? [])].filter((at) => at > nowMs - msPerDay).length;
  }

  /** @description Was a mention park notice posted on the issue in the rolling 24 h before `nowMs`? */
  checkIsMentionParkNoticePostedLastDay(issueKey: string, nowMs: number): boolean {
    return (this.mentionParkNoticeTimesByIssue.get(issueKey) ?? []).some((at) => at > nowMs - msPerDay);
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
