import { createHash } from 'crypto';
import { adfNodeSchema, getAdfText, type AdfAttributeValue } from './adf';
import type { JiraAttachment, JiraComment, JiraIssueLink, JiraIssueReference } from './client';
import type { JiraIssueContext } from './issueContext';
import { jiraParentHierarchyLevel } from './issueContext';
import { createMediaResolver, getAttachmentIdsByMediaId } from './mediaPlaceholders';
import { getAccountName, getQuotedText, getSingleLineText } from './promptText';

/**
 * @description An issue as the ordered list of blocks its prompt is made of
 * (plan C3): `fields`, `description`, `hierarchy`, `links`, `attachments`, then
 * one `comment:<id>` per comment, oldest first. Each block is rendered to text
 * once and hashed, so a later request can tell a block that changed from one the
 * agent already has. Every name and title is kept to one line and every body
 * quoted line by line (`promptText.ts`): all of it is written by people who can
 * edit the issue, or a linked one.
 */

export type IssueBlockKind = 'fields' | 'description' | 'hierarchy' | 'links' | 'attachments' | 'comment';

export interface IssueBlock {
  /** Stable across requests: the kind, or `comment:<id>`. */
  key: string;
  kind: IssueBlockKind;
  /** The block's first line, without its colon and without any state note. */
  heading: string;
  /** The lines under the heading, already single-line or quoted. A spilled block's is a pointer to its file. */
  body: string;
  /** What the block says, whole and unquoted: a comment's or the description's own text, else the body. A spill file holds exactly this. */
  fullText: string;
  /** sha256 of what the block says. A comment's covers its text and visibility marker only, so a no-op save never changes it. Spilling does not change it. */
  hash: string;
  /** Set once the block was moved to a file (`promptSpill.ts`): where. */
  spilledTo?: string;
}

/** A project's extra field as the site names it (resolved from `jira.json` `extraFields` at boot). */
export interface JiraExtraField {
  id: string;
  name: string;
}

const emptyBodyText = '(empty)';
const noneBodyText = '(none)';
const notReferencedText = 'not referenced in the text';
const descriptionLocation = 'description';
/** Properties of a field value that name it, in the order they are tried: a user, an option, a version or component. */
const namedValueProperties = ['displayName', 'value', 'name'] as const;

/** @description The block as the prompt prints it; `stateNote` (`new`, `changed since your last prompt`, …) follows the heading. */
export function getIssueBlockText(block: IssueBlock, stateNote?: string): string {
  return `${block.heading}${stateNote ? ` (${stateNote})` : ''}:\n${block.body}`;
}

function getHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function createBlock(key: string, kind: IssueBlockKind, heading: string, body: string, fullText = body): IssueBlock {
  return { key, kind, heading, body, fullText, hash: getHash(`${heading}\n${body}`) };
}

/** `PROJ-5 "summary" (Status)`: what another issue is called. */
function getIssueReferenceText(reference: JiraIssueReference): string {
  const summary = getSingleLineText(reference.fields?.summary ?? '');
  const statusName = getSingleLineText(reference.fields?.status?.name ?? '');
  return [getSingleLineText(reference.key), summary ? `"${summary}"` : '', statusName ? `(${statusName})` : ''].filter((part) => part !== '').join(' ');
}

function getExtraFieldValueText(value: AdfAttributeValue | undefined): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return getSingleLineText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value.toString();
  if (Array.isArray(value)) return value.map(getExtraFieldValueText).filter((text) => text !== '').join(', ');
  const document = adfNodeSchema.safeParse(value);
  if (document.success && document.data.type === 'doc') return getSingleLineText(getAdfText(document.data));
  for (const propertyName of namedValueProperties) {
    const named = value[propertyName];
    if (typeof named === 'string') return getSingleLineText(named);
  }
  return getSingleLineText(JSON.stringify(value));
}

/** A `Label: value` line, or nothing for a field that has no value. */
function getFieldLine(label: string, value: string): string[] {
  return value === '' ? [] : [`${label}: ${value}`];
}

function getNamesText(items: ReadonlyArray<{ name: string }> | undefined): string {
  return (items ?? []).map((item) => getSingleLineText(item.name)).filter((name) => name !== '').join(', ');
}

function getFieldsBlock(context: JiraIssueContext, extraFields: readonly JiraExtraField[]): IssueBlock {
  const { fields, customFields } = context.issue;
  const lines = [
    ...getFieldLine('Summary', getSingleLineText(fields.summary ?? '') || '(no summary)'),
    ...getFieldLine('Type', getSingleLineText(fields.issuetype?.name ?? '')),
    ...getFieldLine('Priority', getSingleLineText(fields.priority?.name ?? '')),
    ...getFieldLine('Status', getSingleLineText(fields.status?.name ?? '') || 'unknown'),
    ...getFieldLine('Reporter', fields.reporter ? getAccountName(fields.reporter) : ''),
    ...getFieldLine('Parent', fields.parent ? getIssueReferenceText(fields.parent) : ''),
    ...getFieldLine('Fix versions', getNamesText(fields.fixVersions)),
    ...getFieldLine('Labels', (fields.labels ?? []).map(getSingleLineText).filter((label) => label !== '').join(', ')),
    ...getFieldLine('Components', getNamesText(fields.components)),
    ...extraFields.flatMap((extraField) => getFieldLine(getSingleLineText(extraField.name), getExtraFieldValueText(customFields?.[extraField.id]))),
  ];
  return createBlock('fields', 'fields', 'Fields', lines.join('\n'));
}

function getHierarchyBlock(context: JiraIssueContext): IssueBlock {
  const isParent = (context.issue.fields.issuetype?.hierarchyLevel ?? 0) >= jiraParentHierarchyLevel;
  const items: readonly JiraIssueReference[] = isParent ? context.children : (context.issue.fields.subtasks ?? []);
  const heading = `${isParent ? 'Child issues' : 'Sub-tasks'} (${items.length})`;
  return createBlock('hierarchy', 'hierarchy', heading, items.length === 0 ? noneBodyText : items.map((item) => `- ${getIssueReferenceText(item)}`).join('\n'));
}

function getIssueLinkText(link: JiraIssueLink): string[] {
  const farIssue = link.outwardIssue ?? link.inwardIssue;
  if (!farIssue) return [];
  const phrase = getSingleLineText(link.outwardIssue ? link.type.outward : link.type.inward);
  return [`- ${phrase} ${getIssueReferenceText(farIssue)}`];
}

function getLinksBlock(context: JiraIssueContext): IssueBlock {
  const lines = [
    ...(context.issue.fields.issuelinks ?? []).flatMap(getIssueLinkText),
    ...context.remoteLinks.map((link) => {
      const title = getSingleLineText(link.object.title ?? '');
      return `- web link: ${title ? `"${title}" ` : ''}${getSingleLineText(link.object.url)}`;
    }),
  ];
  return createBlock('links', 'links', 'Links', lines.length === 0 ? noneBodyText : lines.join('\n'));
}

function getAttachmentLine(attachment: JiraAttachment, locations: readonly string[]): string {
  const details = [
    getSingleLineText(attachment.mimeType ?? ''),
    attachment.size === undefined ? '' : `${attachment.size} bytes`,
    attachment.author ? `by ${getAccountName(attachment.author)}` : '',
    getSingleLineText(attachment.created ?? ''),
  ].filter((detail) => detail !== '');
  const detailsText = details.length > 0 ? ` (${details.join(', ')})` : '';
  const referencedText = locations.length > 0 ? `referenced in ${locations.join(', ')}` : notReferencedText;
  return `- ${attachment.id} ${getSingleLineText(attachment.filename)}${detailsText} — ${referencedText}`;
}

function getAttachmentsBlock(attachments: readonly JiraAttachment[], locationsByAttachmentId: ReadonlyMap<string, readonly string[]>): IssueBlock {
  const lines = attachments.map((attachment) => getAttachmentLine(attachment, locationsByAttachmentId.get(attachment.id) ?? []));
  return createBlock('attachments', 'attachments', `Attachments (${attachments.length})`, lines.length === 0 ? noneBodyText : lines.join('\n'));
}

/** `[restricted to <role or group>]` and `[internal]` (a Service Management internal note): who may NOT be told what this says. */
function getCommentVisibilityMarker(comment: JiraComment): string {
  const markers = [
    ...(comment.visibility ? [`[restricted to ${getSingleLineText(comment.visibility.value)}]`] : []),
    ...(comment.jsdPublic === false ? ['[internal]'] : []),
  ];
  return markers.join(' ');
}

function getCommentBlock(comment: JiraComment, text: string): IssueBlock {
  const marker = getCommentVisibilityMarker(comment);
  const heading = `Comment ${getSingleLineText(comment.id)} by ${getAccountName(comment.author)}, ${getSingleLineText(comment.created)}${marker ? ` ${marker}` : ''}`;
  return {
    key: `comment:${comment.id}`,
    kind: 'comment',
    heading,
    body: getQuotedText(text || emptyBodyText),
    fullText: text,
    // Author and date never change; a save that changed nothing must not resend the comment.
    hash: getHash(`${marker}\n${text}`),
  };
}

/** Oldest first; Jira sorts them already, a tie keeps Jira's order. */
function getCommentsOldestFirst(comments: readonly JiraComment[]): JiraComment[] {
  return [...comments].sort((left, right) => Date.parse(left.created) - Date.parse(right.created));
}

/**
 * @description The issue as blocks, in prompt order. Media in the description
 * and the comments become placeholders naming their attachment (C9); the
 * attachments block then says where each file is referenced.
 */
export function buildIssueBlocks(context: JiraIssueContext, extraFields: readonly JiraExtraField[]): IssueBlock[] {
  const attachments = [...(context.issue.fields.attachment ?? [])].sort((left, right) => Number(left.id) - Number(right.id));
  const comments = getCommentsOldestFirst(context.comments);
  const attachmentIdByMediaId = new Map([
    ...getAttachmentIdsByMediaId(context.issue.renderedFields?.description),
    ...comments.flatMap((comment) => [...getAttachmentIdsByMediaId(comment.renderedBody)]),
  ]);
  const locationsByAttachmentId = new Map<string, string[]>();
  const getResolver = (location: string) => createMediaResolver({
    attachments,
    attachmentIdByMediaId,
    onResolved: (attachmentIds) => {
      for (const attachmentId of attachmentIds) {
        const locations = locationsByAttachmentId.get(attachmentId) ?? [];
        if (!locations.includes(location)) locationsByAttachmentId.set(attachmentId, [...locations, location]);
      }
    },
  });

  const descriptionText = getAdfText(context.issue.fields.description, getResolver(descriptionLocation));
  const descriptionBlock = createBlock('description', 'description', 'Description', getQuotedText(descriptionText || emptyBodyText), descriptionText);
  const commentBlocks = comments.map((comment) => getCommentBlock(comment, getAdfText(comment.body, getResolver(`comment ${comment.id}`))));
  return [
    getFieldsBlock(context, extraFields),
    descriptionBlock,
    getHierarchyBlock(context),
    getLinksBlock(context),
    getAttachmentsBlock(attachments, locationsByAttachmentId),
    ...commentBlocks,
  ];
}
