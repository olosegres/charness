import * as path from 'path';
import { openFilesWithinWorkDir, type FileSendOpenStrategy, type OpenedSendFile } from '../../utils/fileSendService';
import type { FileSendKind } from '../../utils/fileSendPlan';
import { createDescriptorByteReader, type ImageDimensions } from '../../utils/imageDimensions';
import { jiraCommentAdfMaxChars, type AdfDocument, type AdfNode } from './adf';
import { getJiraUploadFileName, type JiraAttachment, type JiraClient } from './client';
import { checkJiraOutgoingFile, type JiraOutgoingFileKind } from './outgoingFileCheck';
import { getFileSha256, type JiraUploadedFiles } from './uploadedFiles';

/**
 * @description The files an agent shows on a Jira issue (`answer_request`'s `files`, `send_file_to_user`): each is
 * attached to the issue and the comment carries it — an image shown and an H.264 `.mp4` playing in the comment (an ADF
 * `mediaSingle` holding a `media` node that names the attachment's media file), any other file listed as a link to its
 * attachment. On Jira Cloud a plain attachment, or a link to one, shows only in the attachments list; only the media node
 * shows it in the comment.
 *
 * Every file is read and checked BEFORE anything is uploaded (`outgoingFileCheck.ts`, the site's upload limit, attachments
 * switched on), so a refusal attaches nothing. A path is taken the way the file send takes it (`openFilesWithinWorkDir`:
 * inside the issue's project folder, no component swapped after validation), and one file named twice — the same path, or
 * two paths of one file — is attached and shown once. Its name is made safe for the upload once
 * (`getJiraUploadFileName`) and that name is the one compared with the issue's attachments. The media id is read from where
 * the attachment's content redirects to, a redirect never followed (the credentials stay with the site); without one the
 * file is linked instead, and the agent is told.
 *
 * Reuse is by CONTENT: an attachment of the issue is reused for a file only when the AI account attached it and the upload
 * store (`uploadedFiles.ts`) holds it with the file's name, size and sha256 — a resend whose comment did not land attaches
 * nothing twice, and a file regenerated under the same name and length is uploaded anew, never shown as the old one.
 */

/** The most files one comment shows — Telegram's album cap, so the tool reads the same on both. */
export const jiraFilesMaxCount = 10;

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
  /** What the AI account uploaded, by content: the only attachments a file may reuse. */
  uploads: Pick<JiraUploadedFiles, 'findAttachmentIds' | 'record'>;
  /** Tests only: how files are opened (the platform's own by default). */
  openStrategy?: FileSendOpenStrategy;
}

/** A file read and checked, ready to be attached. */
interface CheckedFile {
  opened: OpenedSendFile;
  /** The name it is attached under ({@link getJiraUploadFileName}): the upload's and every comparison's. */
  name: string;
  kind: JiraOutgoingFileKind;
  mimeType: string;
  size: ImageDimensions | null;
  /** What the agent should know about it although it passed. */
  note?: string;
}

/** A checked file with its content hash: what reuse and the upload store compare. */
type HashedFile = CheckedFile & { sha256: string };

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

/** `files` with each file once, in the order first named: the same path twice, or two paths of one file, are one file. */
function getDistinctFiles(files: readonly OpenedSendFile[]): OpenedSendFile[] {
  const seen = new Set<string>();
  return files.filter((file) => {
    const identity = `${file.identity.dev}:${file.identity.ino}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

/** Read and check every opened file; the first refusal, or all of them checked. */
function checkFiles(files: readonly OpenedSendFile[]): { ok: true; files: CheckedFile[] } | { ok: false; error: string } {
  const checked: CheckedFile[] = [];
  for (const opened of files) {
    const name = getJiraUploadFileName(path.basename(opened.absPath));
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
    const checked = checkFiles(getDistinctFiles(opened.files));
    if (!checked.ok) return { ok: false, error: `${checked.error} Nothing was attached or posted.` };
    const notes = checked.files.flatMap((file) => (file.note ? [file.note] : []));
    // Hashed before anything is uploaded: a file that cannot be read whole attaches nothing.
    const hashed: HashedFile[] = [];
    for (const file of checked.files) hashed.push({ ...file, sha256: await getFileSha256(file.opened.fd, file.opened.sizeBytes) });
    const issue = await deps.client.getIssue(issueKey, ['attachment']);
    const onIssue = issue.fields.attachment ?? [];
    const taken = new Set<string>();
    const done: string[] = [];
    const attached: JiraAttachedFile[] = [];
    for (const file of hashed) {
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

/** Is `attachment` the AI account's, of the file's name and size, and not taken by an earlier file of the comment? */
function checkIsSameNamedOwnAttachment(deps: JiraFileAttachDeps, attachment: JiraAttachment, file: HashedFile, taken: ReadonlySet<string>): boolean {
  return attachment.author?.accountId === deps.aiAccountId
    && attachment.filename === file.name
    && attachment.size === file.opened.sizeBytes
    && !taken.has(attachment.id);
}

/** An attachment of the issue that holds exactly this file — recorded with its name, size and hash — that no earlier file of the comment took. */
function findReusable(deps: JiraFileAttachDeps, issueKey: string, attachments: readonly JiraAttachment[], file: HashedFile, taken: ReadonlySet<string>): JiraAttachment | null {
  const sameContentIds = new Set(deps.uploads.findAttachmentIds(issueKey, { filename: file.name, size: file.opened.sizeBytes, sha256: file.sha256 }));
  return attachments.find((attachment) => sameContentIds.has(attachment.id) && checkIsSameNamedOwnAttachment(deps, attachment, file, taken)) ?? null;
}

/**
 * One file's attachment: one of the issue's that holds exactly this file, else a new upload, recorded by its content. An
 * upload Jira did not confirm is looked for among the attachments that appeared during it, once; still not there, it is an
 * error — never a second upload, which could attach it twice.
 */
async function attachOne(
  deps: JiraFileAttachDeps,
  issueKey: string,
  file: HashedFile,
  onIssue: readonly JiraAttachment[],
  taken: ReadonlySet<string>,
): Promise<{ attachmentId: string; isReused: boolean } | { error: string }> {
  const reusable = findReusable(deps, issueKey, onIssue, file, taken);
  if (reusable) return { attachmentId: reusable.id, isReused: true };
  const identity = { filename: file.name, size: file.opened.sizeBytes, sha256: file.sha256 };
  const uploaded = await deps.client.uploadAttachment(issueKey, { fd: file.opened.fd, filename: file.name, mimeType: file.mimeType, sizeBytes: file.opened.sizeBytes });
  let attachment: JiraAttachment | undefined;
  if (uploaded.outcome === 'uploaded') {
    attachment = uploaded.attachments.find((candidate) => candidate.filename === file.name) ?? (uploaded.attachments.length === 1 ? uploaded.attachments[0] : undefined);
    if (!attachment) return { error: `Jira took the upload of ${file.name} but names no such attachment in its answer` };
  } else {
    // Only an attachment that appeared during this upload can be it.
    const nowOnIssue = (await deps.client.getIssue(issueKey, ['attachment'])).fields.attachment ?? [];
    attachment = nowOnIssue.find((candidate) => !onIssue.some((before) => before.id === candidate.id) && checkIsSameNamedOwnAttachment(deps, candidate, file, taken));
    if (!attachment) return { error: `the upload of ${file.name} was not confirmed (${uploaded.reason}) and it is not on the issue` };
  }
  deps.uploads.record(issueKey, attachment.id, identity);
  return { attachmentId: attachment.id, isReused: false };
}
