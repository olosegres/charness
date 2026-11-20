import { z } from 'zod';
import { RotatingJsonlFile } from '../../utils/rotatingJsonlFile';

/**
 * @description Where the NEXT answer to a request goes after an issue update (`inbound.ts`): an update is no request of its
 * own — its comments belong to a request already open, whose origin (and so its thread) was fixed when it opened — so when
 * the newest comment an update brought is a reply in a thread, that request's next answer goes into that thread
 * (`answerSink.ts`), and when it is a top-level comment, the next answer goes where the request's answers go by default.
 * A comment the agent names in `replyToCommentIds` still decides first; an answer delivered consumes the entry.
 * `DATA_DIR/jira-answer-threads.jsonl`: one line per update and one per answer that used it, so a restart (a hot reload
 * among them) between the update and its answer keeps the thread; an entry older than {@link jiraAnswerThreadMaxAgeMs} is
 * forgotten.
 */

export const jiraAnswerThreadsFileName = 'jira-answer-threads.jsonl';
const answerThreadsMaxBytes = 1024 * 1024;
export const jiraAnswerThreadMaxAgeMs = 7 * 24 * 60 * 60 * 1000;

const answerThreadLineSchema = z.object({
  requestId: z.string().min(1),
  /** The thread's top-level comment id; `null` — the next answer goes where the request's answers go by default. */
  threadRootId: z.string().nullable(),
  /** Epoch ms of the update, or of the answer that consumed it. */
  at: z.number(),
});

type AnswerThreadLine = z.infer<typeof answerThreadLineSchema>;

export class JiraAnswerThreads {
  /** Each request's pending thread and when it was noted. */
  private readonly entries = new Map<string, { threadRootId: string; at: number }>();

  constructor(private readonly file: RotatingJsonlFile<AnswerThreadLine>, private readonly now: () => number) {}

  static createForDataDir(filePath: string, now: () => number): JiraAnswerThreads {
    return new JiraAnswerThreads(new RotatingJsonlFile<AnswerThreadLine>(filePath, answerThreadsMaxBytes), now);
  }

  /** @description Replay the file; a line that does not parse is skipped with a warning (never fatal). */
  async load(): Promise<void> {
    const { records, skippedCount } = await this.file.readRecords(answerThreadLineSchema);
    for (const line of records) this.apply(line);
    if (skippedCount > 0) console.warn(`[jira] answer threads: ${skippedCount} unreadable line(s) skipped`);
  }

  private apply(line: AnswerThreadLine): void {
    if (line.threadRootId === null) this.entries.delete(line.requestId);
    else this.entries.set(line.requestId, { threadRootId: line.threadRootId, at: line.at });
  }

  /** @description The thread request `requestId`'s next answer goes into, or `null` when no update put it in one. */
  get(requestId: string): string | null {
    const entry = this.entries.get(requestId);
    if (!entry) return null;
    if (this.now() - entry.at < jiraAnswerThreadMaxAgeMs) return entry.threadRootId;
    this.entries.delete(requestId);
    return null;
  }

  /**
   * @description An update reached request `requestId`'s session: its next answer goes into the thread of `threadRootId`, or
   * — `null`, its newest comment is top-level — where the request's answers go by default. A line that cannot be written is
   * still kept for this process (a warning).
   */
  note(requestId: string, threadRootId: string | null): void {
    if (threadRootId === null && !this.entries.has(requestId)) return;
    this.write({ requestId, threadRootId, at: this.now() });
  }

  /** @description An answer to request `requestId` was delivered: the update's thread is used up. */
  consume(requestId: string): void {
    if (!this.entries.has(requestId)) return;
    this.write({ requestId, threadRootId: null, at: this.now() });
  }

  private write(line: AnswerThreadLine): void {
    if (!this.file.append(line)) console.warn(`[jira] answer threads: request ${line.requestId}: the line could not be written`);
    this.apply(line);
  }
}
