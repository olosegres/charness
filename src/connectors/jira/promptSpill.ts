import { createHash, randomBytes } from 'crypto';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { requestPromptMaxLength } from '../../requests/requestLedger';
import { getIssueBlockText, type IssueBlock } from './issueBlocks';

/**
 * @description Nothing in a Jira prompt is ever cut off, and nothing is lost
 * (prompt context C8): text that is too long for the prompt is written WHOLE to
 * a file in the conversation's files dir, and the prompt says where.
 *
 *  - A comment over {@link jiraCommentSpillMinChars} characters always goes to a file.
 *  - A prompt that would not fit the request ledger's stored-prompt cap (a re-post
 *    needs the stored prompt; the ledger keeps none above it) moves its biggest
 *    blocks to files, largest first, until it fits {@link jiraPromptMaxChars}.
 *  - If every block is a stub and the stubs alone still do not fit (hundreds of
 *    comments), the comment stubs collapse into ONE file holding every comment whole.
 *
 * A spilled block keeps its hash: it counts as sent like any other. The paths
 * hold the block's hash, so one request's files are the next one's when nothing
 * changed; every request rewrites them, which also restores a file the 30-day
 * sweep removed and keeps a live issue's files young.
 */

export const jiraCommentSpillMinChars = 10_000;
/** What the request header may take beyond the stand-in the size is measured with (a long list of replaced requests). */
const promptHeaderMarginChars = 2_000;
/** The most a full prompt may hold, measured with a stand-in header. */
export const jiraPromptMaxChars = requestPromptMaxLength - promptHeaderMarginChars;
/** A request id of the ledger's shape, to measure a prompt before its real id exists. */
export const standInRequestId = 'req_00000000';
const hashChars = 8;
const textFileExtension = '.txt';
const textFileMode = 0o600;
const textDirMode = 0o700;

/** The comments of an issue, all of them whole in one file, for an issue whose comment stubs alone do not fit. */
export interface CommentsFile {
  path: string;
  chars: number;
  text: string;
}

/** The blocks to put in a prompt, and the one file that replaces all its comments (when even the stubs did not fit). */
export interface FittedBlocks {
  blocks: IssueBlock[];
  commentsFile: CommentsFile | null;
}

/** What the prompt says in place of text that sits in a file. */
export function getSpillNoticeText(filePath: string, chars: number): string {
  return `written whole to ${filePath} (${chars} chars) — read it`;
}

function getSpillFilePath(textDir: string, name: string, hash: string): string {
  const safeName = name.replace(/[^A-Za-z0-9_-]/g, '-');
  return path.join(textDir, `${safeName}-${hash.slice(0, hashChars)}${textFileExtension}`);
}

function getSpilledBlock(block: IssueBlock, textDir: string): IssueBlock {
  const spilledTo = getSpillFilePath(textDir, block.key, block.hash);
  return { ...block, body: getSpillNoticeText(spilledTo, block.fullText.length), spilledTo };
}

function checkIsLongComment(block: IssueBlock): boolean {
  return block.kind === 'comment' && block.fullText.length > jiraCommentSpillMinChars;
}

/** The biggest block still in the prompt whose stub is smaller than itself, or `null` when none would shrink. */
function getLargestSpillableIndex(blocks: readonly IssueBlock[], textDir: string): number | null {
  let largestIndex: number | null = null;
  let largestChars = 0;
  blocks.forEach((block, index) => {
    if (block.spilledTo !== undefined) return;
    const chars = getIssueBlockText(block).length;
    const stubChars = getIssueBlockText(getSpilledBlock(block, textDir)).length;
    if (chars > stubChars && chars > largestChars) {
      largestIndex = index;
      largestChars = chars;
    }
  });
  return largestIndex;
}

function getCommentsFile(commentBlocks: readonly IssueBlock[], textDir: string): CommentsFile {
  const text = commentBlocks.map((block) => `${block.heading}:\n${block.fullText}`).join('\n\n');
  const hash = createHash('sha256').update(commentBlocks.map((block) => block.hash).join('\n')).digest('hex');
  return { path: getSpillFilePath(textDir, 'comments', hash), chars: text.length, text };
}

/** Atomic: written beside its final name and renamed, so a reader never sees half a file. */
async function writeTextFile(filePath: string, text: string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: textDirMode });
  const tmpPath = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(tmpPath, text, { mode: textFileMode, flag: 'wx' });
    await fsp.rename(tmpPath, filePath);
  } catch (error) {
    await fsp.rm(tmpPath, { force: true });
    throw error;
  }
}

export interface FitBlocksInput {
  blocks: readonly IssueBlock[];
  /** Where the files go: the conversation's files dir, `jira/text`. */
  textDir: string;
  /** The length of the whole prompt these blocks would make (with a stand-in header). */
  measure: (candidate: FittedBlocks) => number;
}

/**
 * @description The blocks as the prompt will carry them, and their files
 * written. Resolves only once every file is on disk; a write that fails rejects,
 * so a request is never opened with a prompt that points at a missing file.
 */
export async function fitBlocksToPrompt(input: FitBlocksInput): Promise<FittedBlocks> {
  const { textDir, measure } = input;
  const longCommentsSpilled = input.blocks.map((block) => (checkIsLongComment(block) ? getSpilledBlock(block, textDir) : block));
  let working = longCommentsSpilled;
  while (measure({ blocks: working, commentsFile: null }) > jiraPromptMaxChars) {
    const largestIndex = getLargestSpillableIndex(working, textDir);
    if (largestIndex === null) break;
    working = working.map((block, index) => (index === largestIndex ? getSpilledBlock(block, textDir) : block));
  }
  let fitted: FittedBlocks = { blocks: working, commentsFile: null };
  if (measure(fitted) > jiraPromptMaxChars) {
    // Every block is a stub and they still do not fit: the comments go to one file. Their own stubs would
    // point at files nobody wrote, so they stay as they were, except the long ones, which have their files.
    const blocks = working.map((block, index) => (block.kind === 'comment' ? longCommentsSpilled[index] : block));
    fitted = { blocks, commentsFile: getCommentsFile(input.blocks.filter((block) => block.kind === 'comment'), textDir) };
  }
  const files = [
    ...fitted.blocks.flatMap((block) => (block.spilledTo === undefined ? [] : [{ path: block.spilledTo, text: block.fullText }])),
    ...(fitted.commentsFile ? [{ path: fitted.commentsFile.path, text: fitted.commentsFile.text }] : []),
  ];
  await Promise.all(files.map((file) => writeTextFile(file.path, file.text)));
  return fitted;
}
