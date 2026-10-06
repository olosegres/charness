import type { JiraSentBlocks } from './contextLedger';
import type { IssueBlock, IssueBlockKind } from './issueBlocks';

/**
 * @description What a prompt to a conversation that already knows the issue
 * carries (prompt context C3, C7): only the blocks it has not seen.
 *
 *   key not sent before             → `new`
 *   sent, hash differs              → comment: `edited <date> by <name>`, other: `changed since your last prompt`
 *   sent, same hash                 → left out, counted in the "unchanged" line
 *   the AI account's own comment    → left out (it wrote it), unless a person edited it
 *   a sent comment that is gone     → one "was deleted" line, then forgotten
 *
 * Every current block goes into the sent-set the prompt makes once taken in,
 * the ones left out included; a deleted comment does not.
 */

export const newBlockNote = 'new';
export const changedBlockNote = 'changed since your last prompt';
const commentKeyPrefix = 'comment:';

export interface IssueDeltaEntry {
  block: IssueBlock;
  stateNote: string;
}

export interface IssueDelta {
  /** The blocks to print, in prompt order, each with its note. */
  entries: IssueDeltaEntry[];
  /** The kinds of the non-comment blocks left out, in prompt order. */
  unchangedKinds: IssueBlockKind[];
  unchangedCommentCount: number;
  /** `comment <id> by <name> from <date>` of each comment sent before and gone now. */
  deletedCommentLabels: string[];
  /** The sent-set once this prompt is taken in. */
  sent: JiraSentBlocks;
}

function getStateNote(block: IssueBlock, sentHash: string | undefined): string | null {
  if (block.comment?.isOwn) return null;
  if (sentHash === undefined) return newBlockNote;
  if (sentHash === block.hash) return null;
  return block.comment ? block.comment.editNote : changedBlockNote;
}

/** @description The delta of `blocks` against `sent`; an empty `sent` makes every block new. */
export function getIssueDelta(blocks: readonly IssueBlock[], sent: Readonly<JiraSentBlocks>): IssueDelta {
  const delta: IssueDelta = { entries: [], unchangedKinds: [], unchangedCommentCount: 0, deletedCommentLabels: [], sent: {} };
  for (const block of blocks) {
    delta.sent[block.key] = block.comment ? { hash: block.hash, label: block.comment.label } : { hash: block.hash };
    const stateNote = getStateNote(block, sent[block.key]?.hash);
    if (stateNote !== null) delta.entries.push({ block, stateNote });
    else if (block.kind === 'comment') delta.unchangedCommentCount += 1;
    else delta.unchangedKinds.push(block.kind);
  }
  const currentKeys = new Set(blocks.map((block) => block.key));
  for (const [key, sentBlock] of Object.entries(sent)) {
    if (key.startsWith(commentKeyPrefix) && !currentKeys.has(key)) delta.deletedCommentLabels.push(sentBlock.label ?? key);
  }
  return delta;
}
