import { createHash } from 'node:crypto';
import { z } from 'zod';
import { RotatingJsonlFile } from '../../utils/rotatingJsonlFile';

/**
 * @description The comments of a request the answer sink posted without Jira
 * confirming them (plan R29): `DATA_DIR/jira-unconfirmed-posts.jsonl`, one line
 * per post that ended unconfirmed and one per entry settled later. When the
 * agent sends the same text again for the same request, the sink reads the
 * issue first and skips a comment that did land — after a restart too — so an
 * answer is posted at most once. An entry older than a day is forgotten: the
 * agent resends within minutes, not days.
 */

export const jiraUnconfirmedPostsFileName = 'jira-unconfirmed-posts.jsonl';
/** Unconfirmed posts are rare; ample for a long time, the one `.1` backup is read too. */
const unconfirmedPostsMaxBytes = 1024 * 1024;
export const unconfirmedPostMaxAgeMs = 24 * 60 * 60 * 1000;

const unconfirmedPostLineSchema = z.object({
  requestId: z.string().min(1),
  bodyHash: z.string().min(1),
  /** `unconfirmed` — the post's outcome is unknown; `settled` — it no longer needs a check. */
  state: z.enum(['unconfirmed', 'settled']),
  /** Epoch ms: when the post started (`unconfirmed`) or when it settled. */
  at: z.number(),
});

type UnconfirmedPostLine = z.infer<typeof unconfirmedPostLineSchema>;

/** @description The hash a comment's comparable text is remembered by — the text itself stays out of the file. */
export function getCommentBodyHash(comparableText: string): string {
  return createHash('sha256').update(comparableText).digest('hex');
}

function getPostIdentity(requestId: string, bodyHash: string): string {
  return `${requestId}\u0000${bodyHash}`;
}

export class JiraUnconfirmedPosts {
  /** Post start time of every open entry, by request and body hash. */
  private readonly postedAtByIdentity = new Map<string, number>();

  constructor(private readonly file: RotatingJsonlFile<UnconfirmedPostLine>, private readonly now: () => number) {}

  static createForDataDir(filePath: string, now: () => number): JiraUnconfirmedPosts {
    return new JiraUnconfirmedPosts(new RotatingJsonlFile<UnconfirmedPostLine>(filePath, unconfirmedPostsMaxBytes), now);
  }

  /** @description Replay the file. A line that does not parse is skipped with a warning (never fatal). */
  async load(): Promise<void> {
    let skipped = 0;
    for (const line of await this.file.readLines()) {
      let json: object;
      try {
        json = JSON.parse(line);
      } catch {
        skipped += 1;
        continue;
      }
      const parsed = unconfirmedPostLineSchema.safeParse(json);
      if (parsed.success) this.apply(parsed.data);
      else skipped += 1;
    }
    if (skipped > 0) console.warn(`[jira] unconfirmed posts: ${skipped} unreadable line(s) skipped`);
  }

  private apply(line: UnconfirmedPostLine): void {
    const identity = getPostIdentity(line.requestId, line.bodyHash);
    if (line.state === 'unconfirmed') this.postedAtByIdentity.set(identity, line.at);
    else this.postedAtByIdentity.delete(identity);
  }

  /** @description When the unconfirmed post of this body started, or `null` when there is none (or it is too old to matter). */
  getPostedAt(requestId: string, bodyHash: string): number | null {
    const postedAt = this.postedAtByIdentity.get(getPostIdentity(requestId, bodyHash));
    return postedAt !== undefined && this.now() - postedAt < unconfirmedPostMaxAgeMs ? postedAt : null;
  }

  /**
   * @description Remember a post Jira did not confirm. A line that cannot be
   * written is still remembered for this process (a warning): the resend right
   * after it is the one that matters most.
   */
  recordUnconfirmed(requestId: string, bodyHash: string, postedAt: number): void {
    this.write({ requestId, bodyHash, state: 'unconfirmed', at: postedAt });
  }

  /** @description The post landed, or a check found it did not: nothing to check on a resend any more. */
  settle(requestId: string, bodyHash: string): void {
    if (!this.postedAtByIdentity.has(getPostIdentity(requestId, bodyHash))) return;
    this.write({ requestId, bodyHash, state: 'settled', at: this.now() });
  }

  private write(line: UnconfirmedPostLine): void {
    if (!this.file.append(line)) console.warn(`[jira] unconfirmed posts: request ${line.requestId}: the ${line.state} line could not be written`);
    this.apply(line);
  }
}
