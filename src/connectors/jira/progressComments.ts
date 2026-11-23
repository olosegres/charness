import { z } from 'zod';
import { RotatingJsonlFile } from '../../utils/rotatingJsonlFile';

/**
 * @description The comments of a request that the answer sink keeps up to date instead of posting another (`answerSink.ts`): a
 * request's `progress` answers are ONE comment — the first posts it, each next one edits it — and so is a bot notice that says the
 * same thing again for a request (a usage-limit wait). This is where the sink remembers which comment that is, per request and
 * per slot (the agent's progress note, or a repeating bot notice), and in which thread it stands (an edit never moves it).
 * `DATA_DIR/jira-progress-comments.jsonl`: one line when a comment is remembered and one when it is let go (the request's
 * `question` / `final` answer, an issue update the request received, the agent's own answer for a notice: the comment stays as
 * it is, no more edits), so a restart — a hot reload among them — between two
 * progress answers keeps editing the SAME comment. An entry older than {@link jiraProgressCommentMaxAgeMs} is forgotten: a request
 * quiet for that long gets a new comment.
 */

export const jiraProgressCommentsFileName = 'jira-progress-comments.jsonl';
/** The slot of a request's own progress note. */
export const jiraProgressSlot = 'progress';
/** The slot of a bot notice that repeats for a request (`RequestAnswerDelivery.repeatKey`). */
export function getJiraNoticeSlot(repeatKey: string): string {
  return `notice:${repeatKey}`;
}
const progressCommentsMaxBytes = 1024 * 1024;
export const jiraProgressCommentMaxAgeMs = 7 * 24 * 60 * 60 * 1000;

const progressCommentLineSchema = z.object({
  requestId: z.string().min(1),
  /** What the comment is kept as: `progress`, or `notice:<repeat key>` of a bot notice. */
  slot: z.string().min(1),
  /** The comment's id; `null` — it is let go. */
  commentId: z.string().min(1).nullable(),
  /** The thread the comment stands in (its top-level comment's id); `null` — top-level. */
  threadRootId: z.string().nullable(),
  /** Epoch ms: when the comment was posted, or let go. */
  at: z.number(),
});

type ProgressCommentLine = z.infer<typeof progressCommentLineSchema>;

/** A remembered comment: its id and the thread it stands in. */
export interface JiraProgressComment {
  commentId: string;
  threadRootId: string | null;
}

function getIdentity(requestId: string, slot: string): string {
  return `${requestId}\u0000${slot}`;
}

export class JiraProgressComments {
  private readonly entries = new Map<string, JiraProgressComment & { at: number }>();

  constructor(private readonly file: RotatingJsonlFile<ProgressCommentLine>, private readonly now: () => number) {}

  static createForDataDir(filePath: string, now: () => number): JiraProgressComments {
    return new JiraProgressComments(new RotatingJsonlFile<ProgressCommentLine>(filePath, progressCommentsMaxBytes), now);
  }

  /** @description Replay the file; a line that does not parse is skipped with a warning (never fatal). */
  async load(): Promise<void> {
    const { records, skippedCount } = await this.file.readRecords(progressCommentLineSchema);
    for (const line of records) this.apply(line);
    if (skippedCount > 0) console.warn(`[jira] progress comments: ${skippedCount} unreadable line(s) skipped`);
  }

  private apply(line: ProgressCommentLine): void {
    const identity = getIdentity(line.requestId, line.slot);
    if (line.commentId === null) this.entries.delete(identity);
    else this.entries.set(identity, { commentId: line.commentId, threadRootId: line.threadRootId, at: line.at });
  }

  /** @description The comment request `requestId` keeps up to date under `slot`, or `null` when there is none (or it is too old to matter). */
  get(requestId: string, slot: string): JiraProgressComment | null {
    const identity = getIdentity(requestId, slot);
    const entry = this.entries.get(identity);
    if (!entry) return null;
    if (this.now() - entry.at >= jiraProgressCommentMaxAgeMs) {
      this.entries.delete(identity);
      return null;
    }
    return { commentId: entry.commentId, threadRootId: entry.threadRootId };
  }

  /**
   * @description Comment `commentId` is now the one request `requestId` keeps up to date under `slot` (it replaces an earlier one). A
   * line that cannot be written is still kept for this process (a warning): the next answer matters most.
   */
  remember(requestId: string, slot: string, commentId: string, threadRootId: string | null): void {
    this.write({ requestId, slot, commentId, threadRootId, at: this.now() });
  }

  /** @description Edit no more: the comment stays as it is, the next answer under `slot` posts a new one. */
  forget(requestId: string, slot: string): void {
    if (!this.entries.has(getIdentity(requestId, slot))) return;
    this.write({ requestId, slot, commentId: null, threadRootId: null, at: this.now() });
  }

  /** @description Let go of every comment request `requestId` keeps up to date, except the one under `exceptSlot`. */
  forgetAll(requestId: string, exceptSlot?: string): void {
    const prefix = getIdentity(requestId, '');
    for (const identity of [...this.entries.keys()]) {
      if (!identity.startsWith(prefix)) continue;
      const slot = identity.slice(prefix.length);
      if (slot !== exceptSlot) this.forget(requestId, slot);
    }
  }

  private write(line: ProgressCommentLine): void {
    if (!this.file.append(line)) console.warn(`[jira] progress comments: request ${line.requestId}: the line could not be written`);
    this.apply(line);
  }
}
