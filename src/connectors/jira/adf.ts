import { z } from 'zod';
import { markdownToAdf } from 'marklassian';

/**
 * @description Atlassian Document Format for the Jira connector (plan J4, D3):
 * the agent's Markdown answer becomes an ADF comment body (`marklassian`), an
 * issue's ADF description / comments become plain text for the agent's prompt
 * (D15), and an answer longer than a comment holds is split on block
 * boundaries first.
 */

/** An attribute value: any JSON value (ADF keeps e.g. a table's column widths as an array). */
export type AdfAttributeValue = string | number | boolean | null | AdfAttributeValue[] | { [name: string]: AdfAttributeValue };

export interface AdfMark {
  type: string;
  attrs?: Record<string, AdfAttributeValue>;
}

export interface AdfNode {
  type: string;
  attrs?: Record<string, AdfAttributeValue>;
  content?: AdfNode[];
  marks?: AdfMark[];
  text?: string;
}

export interface AdfDocument {
  version: 1;
  type: 'doc';
  content: AdfNode[];
}

const attributeValueSchema: z.ZodType<AdfAttributeValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(attributeValueSchema),
    z.record(z.string(), attributeValueSchema),
  ]),
);

const markSchema = z.object({
  type: z.string(),
  attrs: z.record(z.string(), attributeValueSchema).optional(),
});

/** Validates an ADF node from a Jira response (unknown keys are dropped). */
export const adfNodeSchema: z.ZodType<AdfNode> = z.lazy(() =>
  z.object({
    type: z.string(),
    attrs: z.record(z.string(), attributeValueSchema).optional(),
    content: z.array(adfNodeSchema).optional(),
    marks: z.array(markSchema).optional(),
    text: z.string().optional(),
  }),
);

/** ADF refuses an empty text node (`minLength: 1`); marklassian emits one for an empty code block. */
function getNodesWithoutEmptyText(nodes: AdfNode[]): AdfNode[] {
  return nodes
    .filter((node) => node.type !== 'text' || (node.text ?? '') !== '')
    .map((node) => (node.content ? { ...node, content: getNodesWithoutEmptyText(node.content) } : node));
}

/** Markdown the agent wrote → an ADF document for a comment body (D3). */
export function convertMarkdownToAdf(markdown: string): AdfDocument {
  const document = markdownToAdf(markdown);
  return { ...document, content: getNodesWithoutEmptyText(document.content) };
}

/** Nodes that start a line of their own in the text form. */
const blockNodeTypes = new Set([
  'paragraph', 'heading', 'blockquote', 'codeBlock', 'rule', 'panel', 'listItem', 'taskItem', 'decisionItem',
  'tableRow', 'mediaSingle', 'mediaGroup', 'expand', 'nestedExpand', 'blockCard', 'embedCard',
]);
/** Prefix of a list or task item's line. */
const itemPrefix = '- ';
const maxConsecutiveNewlines = 2;

function getStringAttribute(node: AdfNode | AdfMark, name: string): string | null {
  const value = node.attrs?.[name];
  return typeof value === 'string' ? value : null;
}

/** A text node; a linked one keeps its address, which the agent may need to follow. */
function getTextNodeText(node: AdfNode): string {
  const text = node.text ?? '';
  const linkMark = node.marks?.find((mark) => mark.type === 'link');
  const href = linkMark ? getStringAttribute(linkMark, 'href') : null;
  return href && href !== text ? `${text} (${href})` : text;
}

/** The inline text a leaf node stands for. */
function getLeafText(node: AdfNode): string {
  switch (node.type) {
    case 'text':
      return getTextNodeText(node);
    case 'hardBreak':
      return '\n';
    case 'mention':
      return getStringAttribute(node, 'text') ?? '@user';
    case 'emoji':
      return getStringAttribute(node, 'text') ?? getStringAttribute(node, 'shortName') ?? '';
    case 'inlineCard':
    case 'blockCard':
    case 'embedCard':
      return getStringAttribute(node, 'url') ?? '';
    case 'status':
      return getStringAttribute(node, 'text') ?? '';
    default:
      return '';
  }
}

function getNodeText(node: AdfNode): string {
  // A row's cells hold paragraphs, each ending its own line: trimmed, the row stays one line.
  const inner = node.type === 'tableRow'
    ? (node.content ?? []).map((cell) => getNodeText(cell).trim()).join(' | ')
    : (node.content ?? []).map(getNodeText).join('');
  const text = node.content ? inner : getLeafText(node);
  if (node.type === 'listItem' || node.type === 'taskItem') return `${itemPrefix}${text.trim()}\n`;
  return blockNodeTypes.has(node.type) ? `${text}\n` : text;
}

/**
 * @description An ADF document (or node) as plain text for the agent's prompt:
 * one line per block, list items as `- …`, mentions by their display text,
 * cards by their URL, a link as `text (address)`. Other formatting is dropped.
 */
export function getAdfText(node: AdfNode | AdfDocument | null | undefined): string {
  if (!node) return '';
  return getNodeText(node)
    .replace(new RegExp(`\\n{${maxConsecutiveNewlines + 1},}`, 'g'), '\n'.repeat(maxConsecutiveNewlines))
    .trim();
}

/** Comfortably under Jira's 32 767-character comment body. */
export const jiraCommentMarkdownMaxChars = 30_000;

/** A fence line: its run of 3+ backticks or tildes, then the info string. */
const fenceRe = /^\s*(`{3,}|~{3,})(.*)$/;

/** CommonMark: a fence closes with the same character, at least as long, and no info string. */
function checkIsClosingFence(fence: RegExpExecArray, openFence: string): boolean {
  return fence[1][0] === openFence[0] && fence[1].length >= openFence.length && fence[2].trim() === '';
}

/** Blocks separated by blank lines; a fenced code block stays one block, blank lines and all. */
function getMarkdownBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let openFence: string | null = null;
  for (const line of markdown.split('\n')) {
    const fence = fenceRe.exec(line);
    if (fence) {
      if (openFence === null) openFence = fence[1];
      else if (checkIsClosingFence(fence, openFence)) openFence = null;
    }
    if (openFence === null && !fence && line.trim() === '') {
      if (current.length > 0) blocks.push(current.join('\n'));
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) blocks.push(current.join('\n'));
  return blocks;
}

/** Pack lines into pieces of at most `maxChars`, hard-splitting a line longer than that. */
function getLinePieces(lines: readonly string[], maxChars: number): string[] {
  const pieces: string[] = [];
  // Lines, not a string: an empty string cannot tell "nothing yet" from a blank line, which would be dropped.
  let currentLines: string[] = [];
  let currentLength = 0;
  for (const line of lines) {
    for (let offset = 0; offset < Math.max(line.length, 1); offset += maxChars) {
      const part = line.slice(offset, offset + maxChars);
      const candidateLength = currentLines.length === 0 ? part.length : currentLength + 1 + part.length;
      if (candidateLength <= maxChars) {
        currentLines.push(part);
        currentLength = candidateLength;
      } else {
        pieces.push(currentLines.join('\n'));
        currentLines = [part];
        currentLength = part.length;
      }
    }
  }
  if (currentLines.length > 0) pieces.push(currentLines.join('\n'));
  return pieces;
}

/**
 * A block's runs: lines of text, and each fenced code block from its opener to
 * its closer. A fence may follow a text line with no blank line between them,
 * and rejoining the runs with a blank line renders the same: a fence
 * interrupts a paragraph.
 */
function getFenceRuns(lines: readonly string[]): string[][] {
  const runs: string[][] = [];
  let current: string[] = [];
  let openFence: string | null = null;
  for (const line of lines) {
    const fence = fenceRe.exec(line);
    if (openFence === null && fence) {
      if (current.length > 0) runs.push(current);
      current = [line];
      openFence = fence[1];
      continue;
    }
    current.push(line);
    if (openFence !== null && fence && checkIsClosingFence(fence, openFence)) {
      runs.push(current);
      current = [];
      openFence = null;
    }
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

/** A block longer than a comment: split by lines; a code block is re-fenced around every piece. */
function getOversizedBlockPieces(block: string, maxChars: number): string[] {
  return getFenceRuns(block.split('\n')).flatMap((run) => getRunPieces(run, maxChars));
}

function getRunPieces(lines: readonly string[], maxChars: number): string[] {
  const run = lines.join('\n');
  if (run.length <= maxChars) return [run];
  const opener = lines[0] ?? '';
  const fence = fenceRe.exec(opener);
  const closer = fence?.[1] ?? '';
  const wrappingLength = opener.length + closer.length + 2;
  // Not a code block, or an opener so long no line would fit beside it: plain line pieces.
  if (!fence || wrappingLength >= maxChars) return getLinePieces(lines, maxChars);
  const lastFence = lines.length > 1 ? fenceRe.exec(lines[lines.length - 1] ?? '') : null;
  const hasCloser = lastFence !== null && checkIsClosingFence(lastFence, closer);
  const bodyLines = lines.slice(1, hasCloser ? -1 : undefined);
  return getLinePieces(bodyLines, maxChars - wrappingLength).map((piece) => `${opener}\n${piece}\n${closer}`);
}

/**
 * @description Split an answer into comment-sized Markdown chunks: whole blocks
 * (paragraphs, lists, fenced code) packed in order; only a block that alone is
 * too long is split inside, a code block keeping its fences on every piece.
 * Blank input yields no chunk.
 */
export function splitMarkdownForComments(markdown: string, maxChars = jiraCommentMarkdownMaxChars): string[] {
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new RangeError(`maxChars must be a positive integer, got ${maxChars}`);
  const chunks: string[] = [];
  let current = '';
  for (const block of getMarkdownBlocks(markdown)) {
    const pieces = block.length > maxChars ? getOversizedBlockPieces(block, maxChars) : [block];
    for (const piece of pieces) {
      const candidate = current === '' ? piece : `${current}\n\n${piece}`;
      if (candidate.length <= maxChars) {
        current = candidate;
      } else {
        if (current !== '') chunks.push(current);
        current = piece;
      }
    }
  }
  if (current.trim() !== '') chunks.push(current);
  return chunks;
}
