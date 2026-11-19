import * as path from 'path';
import { openFilesWithinWorkDir, type FileSendOpenStrategy, type OpenedSendFile } from '../../utils/fileSendService';
import type { FileSendKind } from '../../utils/fileSendPlan';
import { createDescriptorByteReader, type ImageDimensions } from '../../utils/imageDimensions';
import { jiraCommentAdfMaxChars, type AdfDocument, type AdfNode } from './adf';
import type { JiraAttachment, JiraClient } from './client';
import { checkJiraOutgoingFile, type JiraOutgoingFileKind } from './outgoingFileCheck';

/**
 * @description The files an agent shows on a Jira issue (`answer_request`'s `files`, `send_file_to_user`): each is
 * attached to the issue and the comment carries it — an image shown and an H.264 `.mp4` playing in the comment (an ADF
 * `mediaSingle` holding a `media` node that names the attachment's media file), any other file listed as a link to its
 * attachment. On Jira Cloud a plain attachment, or a link to one, shows only in the attachments list; only the media node
 * shows it in the comment.
 *
 * Every file is read and checked BEFORE anything is uploaded (`outgoingFileCheck.ts`, the site's upload limit, attachments
 * switched on), so a refusal attaches nothing. A path is taken the way the file send takes it (`openFilesWithinWorkDir`:
 * inside the issue's project folder, no component swapped after validation). A file of the same name and size that the
 * AI account attached before — an earlier try whose comment did not land — is reused, so sending again attaches nothing
 * twice. The media id is read from where the attachment's content redirects to, a redirect never followed (the
 * credentials stay with the site); without one the file is linked instead, and the agent is told.
 *
 * Reuse is bounded: only an attachment the AI account made within {@link jiraAttachmentReuseMaxAgeMs} counts — a resend
 * comes within minutes, and an older file of the same name and size may well hold something else.
 */

/** The most files one comment shows — Telegram's album cap, so the tool reads the same on both. */
export const jiraFilesMaxCount = 10;
/** How old an attachment of the AI account's may be and still stand for a file of its name and size (a resend's). */
export const jiraAttachmentReuseMaxAgeMs = 60 * 60 * 1000;

/** One file the comment carries: its attachment, and how it shows. */
export interface JiraAttachedFile {
  /** The attachment's file name. */
  name: string;
  attachmentId: string;
  kind: JiraOutgoingFileKind;
  /** The media file that shows it in the comment; `null` — the comment links it. */
  mediaId: string | null;
  size: ImageDimensions | null;
  /** Attached by an earlier try, not uploaded again. */
  isReused: boolean;
}

export type JiraFilesAttachResult =
  | {
    ok: true;
    files: JiraAttachedFile[];
    /** What the comment carries for them, in order: the shown files, then one list of the linked ones. */
    nodes: AdfNode[];
    /** One line for the agent: each file, how it shows, its attachment. */
    summary: string;
    /** What the agent should know although nothing failed: a video that is only linked, a media id Jira did not give. */
    notes: string[];
    /** Each file as the file send's summary counts kinds. */
    sentKinds: FileSendKind[];
  }
  | { ok: false; error: string };

export interface JiraFileAttachDeps {
  client: Pick<JiraClient, 'getAttachmentSettings' | 'getIssue' | 'uploadAttachment' | 'getAttachmentMediaId'>;
  aiAccountId: string;
  /** `https://<site>`: the attachment links point there. */
  siteUrl: string;
  now: () => number;
  /** Tests only: how files are opened (the platform's own by default). */
  openStrategy?: FileSendOpenStrategy;
}

/** A file read and checked, ready to be attached. */
interface CheckedFile {
  opened: OpenedSendFile;
  name: string;
  kind: JiraOutgoingFileKind;
  mimeType: string;
  size: ImageDimensions | null;
  /** What the agent should know about it although it passed. */
  note?: string;
}

function getMegabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/** The link a linked file's line points at: its content on the site, which a signed-in browser opens. */
function getAttachmentUrl(siteUrl: string, attachmentId: string): string {
  return `${siteUrl.replace(/\/+$/, '')}/rest/api/3/attachment/content/${encodeURIComponent(attachmentId)}`;
}

/** @description What the comment carries for `files`: a `mediaSingle` per shown file, in order, then ONE list linking the rest. */
export function createAttachedFilesNodes(files: readonly JiraAttachedFile[], siteUrl: string): AdfNode[] {
  const shown: AdfNode[] = files.filter((file) => file.mediaId !== null).map((file) => ({
    type: 'mediaSingle',
    attrs: { layout: 'center' },
    content: [{
      type: 'media',
      attrs: { type: 'file', id: file.mediaId ?? '', collection: '', ...(file.size ? { width: file.size.width, height: file.size.height } : {}) },
    }],
  }));
  const linked = files.filter((file) => file.mediaId === null);
  if (linked.length === 0) return shown;
  const list: AdfNode = {
    type: 'bulletList',
    content: linked.map((file) => ({
      type: 'listItem',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: file.name, marks: [{ type: 'link', attrs: { href: getAttachmentUrl(siteUrl, file.attachmentId) } }] }] }],
    })),
  };
  return [...shown, list];
}

/**
 * @description `bodies` with `nodes` after their text: in the last body when it still fits Jira's comment limit, else in a
 * body of their own; with no text at all, one body of them.
 */
export function appendNodesToBodies(bodies: readonly AdfDocument[], nodes: readonly AdfNode[]): AdfDocument[] {
  if (nodes.length === 0) return [...bodies];
  const last = bodies.at(-1);
  if (last) {
    const extended: AdfDocument = { ...last, content: [...last.content, ...nodes] };
    if (JSON.stringify(extended).length <= jiraCommentAdfMaxChars) return [...bodies.slice(0, -1), extended];
  }
  return [...bodies, { version: 1, type: 'doc', content: [...nodes] }];
}

/** How a file shows, for the agent's result. */
function describeFile(file: JiraAttachedFile): string {
  let how = 'linked';
  if (file.mediaId !== null) how = file.kind === 'video' ? 'plays in the comment' : 'shown in the comment';
  return `${file.name} (${how}, attachment ${file.attachmentId}${file.isReused ? ', attached before' : ''})`;
}

function getSentKind(file: JiraAttachedFile): FileSendKind {
  if (file.mediaId === null) return 'document';
  if (file.kind === 'video') return 'video';
  return path.extname(file.name).toLowerCase() === '.gif' ? 'animation' : 'photo';
}

/** Read and check every opened file; the first refusal, or all of them checked. */
function checkFiles(files: readonly OpenedSendFile[]): { ok: true; files: CheckedFile[] } | { ok: false; error: string } {
  const checked: CheckedFile[] = [];
  for (const opened of files) {
    const name = path.basename(opened.absPath);
    const check = checkJiraOutgoingFile(name, opened.sizeBytes, createDescriptorByteReader(opened.fd));
    if (!check.ok) return { ok: false, error: check.error };
    checked.push({ opened, name, kind: check.kind, mimeType: check.mimeType, size: check.size, ...(check.note ? { note: check.note } : {}) });
  }
  return { ok: true, files: checked };
}

/**
 * @description Attach the files `rawPaths` (relative to `workDir`, the issue's project folder) to issue `issueKey` and
 * say how a comment shows them. `isShownInline: false` links every file (`send_file_to_user`'s `as_file`). Nothing is
 * uploaded unless every file passed its check; a failure later names what is attached already, which a resend reuses.
 */
export async function attachFilesToIssue(
  deps: JiraFileAttachDeps,
  issueKey: string,
  workDir: string,
  rawPaths: readonly string[],
  options: { isShownInline: boolean },
): Promise<JiraFilesAttachResult> {
  if (rawPaths.length === 0) return { ok: false, error: 'no files to attach' };
  if (rawPaths.length > jiraFilesMaxCount) return { ok: false, error: `too many files: ${rawPaths.length} (max ${jiraFilesMaxCount}); nothing was attached or posted` };
  const settings = await deps.client.getAttachmentSettings();
  if (!settings.isEnabled) return { ok: false, error: 'attachments are switched off on this Jira site, so no file can be shown; nothing was posted' };
  const limitBytes = settings.uploadLimitBytes ?? Number.MAX_SAFE_INTEGER;
  const opened = openFilesWithinWorkDir(workDir, rawPaths, {
    maxBytes: limitBytes,
    getOversizeError: (absPath) => `${path.basename(absPath)} is over the site's upload limit of ${getMegabytes(limitBytes)} MB — shorten the recording or shrink the image`,
  }, deps.openStrategy);
  if (!opened.ok) return { ok: false, error: `${opened.error}; nothing was attached or posted` };
  try {
    const checked = checkFiles(opened.files);
    if (!checked.ok) return { ok: false, error: `${checked.error} Nothing was attached or posted.` };
    const notes = checked.files.flatMap((file) => (file.note ? [file.note] : []));
    const issue = await deps.client.getIssue(issueKey, ['attachment']);
    const onIssue = issue.fields.attachment ?? [];
    const taken = new Set<string>();
    const done: string[] = [];
    const attached: JiraAttachedFile[] = [];
    for (const file of checked.files) {
      let result: { attachmentId: string; isReused: boolean } | { error: string };
      try {
        result = await attachOne(deps, issueKey, file, onIssue, taken);
      } catch (error) {
        result = { error: `${file.name} could not be attached: ${error instanceof Error ? error.message : String(error)}` };
      }
      if ('error' in result) {
        const already = done.length > 0 ? ` Already attached: ${done.join(', ')} — sending again reuses them.` : '';
        return { ok: false, error: `${result.error}; nothing was posted.${already}` };
      }
      taken.add(result.attachmentId);
      done.push(`${file.name} (attachment ${result.attachmentId})`);
      attached.push({ name: file.name, attachmentId: result.attachmentId, kind: file.kind, mediaId: null, size: file.size, isReused: result.isReused });
    }
    for (const file of attached) {
      if (file.kind === 'file' || !options.isShownInline) continue;
      file.mediaId = await getMediaIdSafely(deps, file);
      if (file.mediaId === null) notes.push(`${file.name} is attached and linked, but not shown in the comment: Jira gave no media file for it`);
    }
    return {
      ok: true,
      files: attached,
      nodes: createAttachedFilesNodes(attached, deps.siteUrl),
      summary: attached.map(describeFile).join(', '),
      notes,
      sentKinds: attached.map(getSentKind),
    };
  } finally {
    opened.close();
  }
}

/** The file's media id, or `null` when Jira gives none or cannot be asked: the file is attached either way, and linked. */
async function getMediaIdSafely(deps: JiraFileAttachDeps, file: JiraAttachedFile): Promise<string | null> {
  try {
    return await deps.client.getAttachmentMediaId(file.attachmentId);
  } catch (error) {
    console.warn(`[jira] the media file of attachment ${file.attachmentId} could not be read: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** A recent attachment of the AI account's own of this name and size that no earlier file of the comment took. */
function findReusable(deps: JiraFileAttachDeps, attachments: readonly JiraAttachment[], file: CheckedFile, taken: ReadonlySet<string>): JiraAttachment | null {
  const oldestMs = deps.now() - jiraAttachmentReuseMaxAgeMs;
  return attachments.find((attachment) => attachment.author?.accountId === deps.aiAccountId
    && attachment.filename === file.name
    && attachment.size === file.opened.sizeBytes
    && Date.parse(attachment.created ?? '') >= oldestMs
    && !taken.has(attachment.id)) ?? null;
}

/**
 * One file's attachment: one of its name and size the AI account attached before, else a new upload. An upload Jira
 * did not confirm is looked for among the issue's attachments once; still not there, it is an error — never a second
 * upload, which could attach it twice.
 */
async function attachOne(
  deps: JiraFileAttachDeps,
  issueKey: string,
  file: CheckedFile,
  onIssue: readonly JiraAttachment[],
  taken: ReadonlySet<string>,
): Promise<{ attachmentId: string; isReused: boolean } | { error: string }> {
  const reusable = findReusable(deps, onIssue, file, taken);
  if (reusable) return { attachmentId: reusable.id, isReused: true };
  const uploaded = await deps.client.uploadAttachment(issueKey, { fd: file.opened.fd, filename: file.name, mimeType: file.mimeType, sizeBytes: file.opened.sizeBytes });
  if (uploaded.outcome === 'uploaded') {
    const attachment = uploaded.attachments.find((candidate) => candidate.filename === file.name) ?? (uploaded.attachments.length === 1 ? uploaded.attachments[0] : undefined);
    return attachment ? { attachmentId: attachment.id, isReused: false } : { error: `Jira took the upload of ${file.name} but names no such attachment in its answer` };
  }
  const nowOnIssue = (await deps.client.getIssue(issueKey, ['attachment'])).fields.attachment ?? [];
  const landed = findReusable(deps, nowOnIssue.filter((attachment) => !onIssue.some((before) => before.id === attachment.id)), file, taken);
  return landed
    ? { attachmentId: landed.id, isReused: false }
    : { error: `the upload of ${file.name} was not confirmed (${uploaded.reason}) and it is not on the issue` };
}
