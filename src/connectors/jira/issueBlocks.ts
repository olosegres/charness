import { createHash } from 'crypto';
import { adfNodeSchema, getAdfText, type AdfAttributeValue } from './adf';
import type { JiraAccount, JiraAttachment, JiraComment, JiraIssueLink, JiraIssueReference } from './client';
import type { JiraIssueContext } from './issueContext';
import { jiraParentHierarchyLevel } from './issueContext';
import { createMediaResolver, getAttachmentIdsByMediaId } from './mediaPlaceholders';
import { getAccountName, getQuotedText, getSingleLineText } from './promptText';
import { getJiraIssueProjectKey } from './sessionKeyCodec';
import { getItemField } from './trigger';

/**
 * @description An issue as the ordered list of blocks its prompt is made of
 * (plan C3): `fields`, `description`, `hierarchy`, `links`, `attachments`, then
 * one `comment:<id>` per comment, oldest first. Each block is rendered to text
 * once and hashed, so a later request can tell a block that changed from one the
 * agent already has. Every name and title is kept to one line and every body
 * quoted line by line (`promptText.ts`): all of it is written by people who can
 * edit the issue, or a linked one.
 *
 * With a trusted group (`trust` set) a piece of the issue's own text reaches the
 * agent only when EVERYONE who wrote it is trusted — a member, the AI account or
 * an app; an author Jira does not name counts as untrusted. Text that does not
 * is replaced IN PLACE by a marker (`[withheld: …]`) before the blocks are
 * hashed, fitted or spilled, so it never reaches a prompt, a delta or a file.
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
  /** A comment block's own facts; absent for the other kinds. */
  comment?: IssueBlockComment;
  /** The whole text was written or edited by someone outside the trusted group: the block is a marker, on the heading's own line. */
  isWithheld?: boolean;
}

/** What a delta says about a comment beyond its text (prompt context C4–C7). */
export interface IssueBlockComment {
  /** `comment <id> by <name> from <date>`: what the line of a deleted comment names. */
  label: string;
  /** `edited <date> by <name>`: the note of a comment that changed since it was sent. */
  editNote: string;
  /** Written by the AI account and edited by nobody else: the agent's own answer, never sent back in a delta (C7). */
  isOwn: boolean;
}

/** A project's extra field as the site names it (resolved from `jira.json` `extraFields` at boot). */
export interface JiraExtraField {
  id: string;
  name: string;
}

/**
 * @name JiraBlockTrust
 * @description The trusted group as the blocks need it: who is trusted, and which projects the operator listed —
 * another issue's summary is shown only from those (the agent may read them through its own tools anyway).
 */
export interface JiraBlockTrust {
  checkIsTrusted: (account: JiraAccount | null | undefined) => boolean;
  allowlistedProjectKeys: ReadonlySet<string>;
}

const withheldWrittenMarker = '[withheld: written or edited by someone outside the trusted group]';
const withheldUploadedMarker = '[withheld: uploaded by someone outside the trusted group]';
/** The ids Jira's changelog names the free-text system fields by. */
const summaryFieldId = 'summary';
const descriptionFieldId = 'description';
const labelsFieldId = 'labels';
const emptyBodyText = '(empty)';
const noneBodyText = '(none)';
const notReferencedText = 'not referenced in the text';
const descriptionLocation = 'description';
/** Properties of a field value that name it, in the order they are tried: a user, an option, a version or component. */
const namedValueProperties = ['displayName', 'value', 'name'] as const;

/**
 * @description The block as the prompt prints it; `stateNote` (`new`, `changed since your last prompt`, …) follows
 * the heading. A withheld block is one line: its marker follows the heading's colon.
 */
export function getIssueBlockText(block: IssueBlock, stateNote?: string): string {
  return `${block.heading}${stateNote ? ` (${stateNote})` : ''}:${block.isWithheld ? ' ' : '\n'}${block.body}`;
}

function getHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function createBlock(key: string, kind: IssueBlockKind, heading: string, body: string, fullText = body): IssueBlock {
  return { key, kind, heading, body, fullText, hash: getHash(`${heading}\n${body}`) };
}

/** A marker standing for text nobody trusted wrote: the block's whole text. Its key and hash follow the marker. */
function createWithheldBlock(key: string, kind: IssueBlockKind, heading: string, marker: string): IssueBlock {
  return { ...createBlock(key, kind, heading, marker), isWithheld: true };
}

/**
 * Did only trusted accounts write what `field` says now? The issue's creator wrote its first value and every
 * changelog entry that touched the field wrote a later one; an entry Jira names no author for is untrusted.
 * `name` also matches an old entry that carries only the field's display name.
 */
function checkIsFieldTrusted(context: JiraIssueContext, trust: JiraBlockTrust, field: { id: string; name?: string }): boolean {
  if (!trust.checkIsTrusted(context.issue.fields.creator)) return false;
  return context.changelog
    .filter((history) => history.items.some((item) => getItemField(item) === field.id || (field.name !== undefined && item.field === field.name)))
    .every((history) => trust.checkIsTrusted(history.author));
}

/**
 * `PROJ-5 "summary" (Status)`: what another issue is called. With a trusted group the summary is kept only for an
 * issue of a listed project — who wrote any other's is unknown, so its key and status say all.
 */
function getIssueReferenceText(reference: JiraIssueReference, trust: JiraBlockTrust | null): string {
  const projectKey = getJiraIssueProjectKey(reference.key);
  const isSummaryShown = trust === null || (projectKey !== null && trust.allowlistedProjectKeys.has(projectKey));
  const summary = isSummaryShown ? getSingleLineText(reference.fields?.summary ?? '') : '';
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

function getFieldsBlock(context: JiraIssueContext, extraFields: readonly JiraExtraField[], trust: JiraBlockTrust | null): IssueBlock {
  const { fields, rawFields } = context.issue;
  /** A free-text field's value, or its marker when someone outside the trusted group wrote any of it; an empty value stays empty. */
  const getWrittenValue = (value: string, field: { id: string; name?: string }): string =>
    value !== '' && trust !== null && !checkIsFieldTrusted(context, trust, field) ? withheldWrittenMarker : value;
  const lines = [
    ...getFieldLine('Summary', getWrittenValue(getSingleLineText(fields.summary ?? '') || '(no summary)', { id: summaryFieldId })),
    ...getFieldLine('Type', getSingleLineText(fields.issuetype?.name ?? '')),
    ...getFieldLine('Priority', getSingleLineText(fields.priority?.name ?? '')),
    ...getFieldLine('Status', getSingleLineText(fields.status?.name ?? '') || 'unknown'),
    ...getFieldLine('Reporter', fields.reporter ? getAccountName(fields.reporter) : ''),
    ...getFieldLine('Parent', fields.parent ? getIssueReferenceText(fields.parent, trust) : ''),
    ...getFieldLine('Fix versions', getNamesText(fields.fixVersions)),
    ...getFieldLine('Labels', getWrittenValue((fields.labels ?? []).map(getSingleLineText).filter((label) => label !== '').join(', '), { id: labelsFieldId })),
    ...getFieldLine('Components', getNamesText(fields.components)),
    ...extraFields.flatMap((extraField) => getFieldLine(
      getSingleLineText(extraField.name),
      getWrittenValue(getExtraFieldValueText(rawFields?.[extraField.id]), extraField),
    )),
  ];
  return createBlock('fields', 'fields', 'Fields', lines.join('\n'));
}

function getHierarchyBlock(context: JiraIssueContext, trust: JiraBlockTrust | null): IssueBlock {
  const isParent = (context.issue.fields.issuetype?.hierarchyLevel ?? 0) >= jiraParentHierarchyLevel;
  const items: readonly JiraIssueReference[] = isParent ? context.children : (context.issue.fields.subtasks ?? []);
  const heading = `${isParent ? 'Child issues' : 'Sub-tasks'} (${items.length})`;
  return createBlock('hierarchy', 'hierarchy', heading, items.length === 0 ? noneBodyText : items.map((item) => `- ${getIssueReferenceText(item, trust)}`).join('\n'));
}

function getIssueLinkText(link: JiraIssueLink, trust: JiraBlockTrust | null): string[] {
  const farIssue = link.outwardIssue ?? link.inwardIssue;
  if (!farIssue) return [];
  const phrase = getSingleLineText(link.outwardIssue ? link.type.outward : link.type.inward);
  return [`- ${phrase} ${getIssueReferenceText(farIssue, trust)}`];
}

/**
 * With a trusted group a remote link shows its URL only: the title is written by whoever added the link, and the
 * issue's changelog does not say who that was.
 */
function getLinksBlock(context: JiraIssueContext, trust: JiraBlockTrust | null): IssueBlock {
  const lines = [
    ...(context.issue.fields.issuelinks ?? []).flatMap((link) => getIssueLinkText(link, trust)),
    ...context.remoteLinks.map((link) => {
      const title = trust === null ? getSingleLineText(link.object.title ?? '') : '';
      return `- web link: ${title ? `"${title}" ` : ''}${getSingleLineText(link.object.url)}`;
    }),
  ];
  return createBlock('links', 'links', 'Links', lines.length === 0 ? noneBodyText : lines.join('\n'));
}

function getAttachmentLine(attachment: JiraAttachment, locations: readonly string[], isWithheld: boolean): string {
  // The file name is the uploader's text too: a withheld file is its id and the marker, nothing more.
  if (isWithheld) return `- ${attachment.id} ${withheldUploadedMarker}`;
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

function getAttachmentsBlock(
  attachments: readonly JiraAttachment[],
  locationsByAttachmentId: ReadonlyMap<string, readonly string[]>,
  withheldAttachmentIds: ReadonlySet<string>,
): IssueBlock {
  const lines = attachments.map((attachment) =>
    getAttachmentLine(attachment, locationsByAttachmentId.get(attachment.id) ?? [], withheldAttachmentIds.has(attachment.id)));
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

/** Written AND last edited by trusted accounts; an author Jira does not name is not one. */
function checkIsCommentTrusted(comment: JiraComment, trust: JiraBlockTrust): boolean {
  return trust.checkIsTrusted(comment.author) && (comment.updateAuthor === undefined || trust.checkIsTrusted(comment.updateAuthor));
}

/** A comment the agent may not read: no name, no text — its id and date say there is one to ask the requester about. */
function getWithheldCommentBlock(comment: JiraComment): IssueBlock {
  const id = getSingleLineText(comment.id);
  const created = getSingleLineText(comment.created);
  return {
    ...createWithheldBlock(`comment:${comment.id}`, 'comment', `Comment ${id}, ${created}`, withheldWrittenMarker),
    comment: {
      label: `comment ${id} from ${created}`,
      editNote: `edited ${getSingleLineText(comment.updated ?? '') || 'at an unknown time'}`,
      isOwn: false,
    },
  };
}

function getCommentBlock(comment: JiraComment, text: string, aiAccountId: string): IssueBlock {
  const marker = getCommentVisibilityMarker(comment);
  const id = getSingleLineText(comment.id);
  const authorName = getAccountName(comment.author);
  const created = getSingleLineText(comment.created);
  const heading = `Comment ${id} by ${authorName}, ${created}${marker ? ` ${marker}` : ''}`;
  const updateAuthorId = comment.updateAuthor?.accountId;
  return {
    key: `comment:${comment.id}`,
    kind: 'comment',
    heading,
    body: getQuotedText(text || emptyBodyText),
    fullText: text,
    // Author and date never change; a save that changed nothing must not resend the comment.
    hash: getHash(`${marker}\n${text}`),
    comment: {
      label: `comment ${id} by ${authorName} from ${created}`,
      editNote: `edited ${getSingleLineText(comment.updated ?? '') || 'at an unknown time'} by ${getAccountName(comment.updateAuthor ?? comment.author)}`,
      isOwn: comment.author?.accountId === aiAccountId && (updateAuthorId === undefined || updateAuthorId === aiAccountId),
    },
  };
}

/** Oldest first; Jira sorts them already, a tie keeps Jira's order. */
function getCommentsOldestFirst(comments: readonly JiraComment[]): JiraComment[] {
  return [...comments].sort((left, right) => Date.parse(left.created) - Date.parse(right.created));
}

/**
 * @description The issue as blocks, in prompt order. Media in the description
 * and the comments become placeholders naming their attachment (C9); the
 * attachments block then says where each file is referenced. With `trust` set,
 * text outside the trusted group is replaced by markers (see the file header);
 * `null` is the unfiltered issue, as it always was.
 */
export function buildIssueBlocks(
  context: JiraIssueContext,
  extraFields: readonly JiraExtraField[],
  aiAccountId: string,
  trust: JiraBlockTrust | null = null,
): IssueBlock[] {
  const attachments = [...(context.issue.fields.attachment ?? [])].sort((left, right) => Number(left.id) - Number(right.id));
  const withheldAttachmentIds = new Set(
    trust === null ? [] : attachments.filter((attachment) => !trust.checkIsTrusted(attachment.author)).map((attachment) => attachment.id),
  );
  const comments = getCommentsOldestFirst(context.comments);
  const attachmentIdByMediaId = new Map([
    ...getAttachmentIdsByMediaId(context.issue.renderedFields?.description),
    ...comments.flatMap((comment) => [...getAttachmentIdsByMediaId(comment.renderedBody)]),
  ]);
  const locationsByAttachmentId = new Map<string, string[]>();
  const getResolver = (location: string) => createMediaResolver({
    attachments,
    attachmentIdByMediaId,
    withheldAttachmentIds,
    onResolved: (attachmentIds) => {
      for (const attachmentId of attachmentIds) {
        const locations = locationsByAttachmentId.get(attachmentId) ?? [];
        if (!locations.includes(location)) locationsByAttachmentId.set(attachmentId, [...locations, location]);
      }
    },
  });

  // A withheld description or comment never meets the media resolver: its media are not locations of anything.
  const isDescriptionWithheld = trust !== null && !checkIsFieldTrusted(context, trust, { id: descriptionFieldId });
  let descriptionBlock: IssueBlock;
  if (isDescriptionWithheld) {
    descriptionBlock = createWithheldBlock('description', 'description', 'Description', withheldWrittenMarker);
  } else {
    const descriptionText = getAdfText(context.issue.fields.description, getResolver(descriptionLocation));
    descriptionBlock = createBlock('description', 'description', 'Description', getQuotedText(descriptionText || emptyBodyText), descriptionText);
  }
  const commentBlocks = comments.map((comment) => (
    trust !== null && !checkIsCommentTrusted(comment, trust)
      ? getWithheldCommentBlock(comment)
      : getCommentBlock(comment, getAdfText(comment.body, getResolver(`comment ${comment.id}`)), aiAccountId)
  ));
  return [
    getFieldsBlock(context, extraFields, trust),
    descriptionBlock,
    getHierarchyBlock(context, trust),
    getLinksBlock(context, trust),
    getAttachmentsBlock(attachments, locationsByAttachmentId, withheldAttachmentIds),
    ...commentBlocks,
  ];
}
