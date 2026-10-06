import { randomBytes } from 'crypto';
import { promises as fsp } from 'fs';
import * as path from 'path';
import type { SessionKey } from '../../sessionKey';
import { JiraAuthError, type JiraAttachment, type JiraClient } from './client';
import { getSingleLineText } from './promptText';

/**
 * @description `jira_get_attachment` (prompt context C10): the agent names an
 * attachment id, the bot downloads the ORIGINAL into the conversation's files
 * dir and hands back its path. What the agent does with it is its own choice —
 * Read an image, run `ffmpeg` on a video; the bot transcribes nothing.
 *
 * Scope: the issue comes from the conversation the call belongs to (its HMAC
 * scoped session key), never from an argument, and the id must be in that
 * issue's attachment list read NOW. A line planted in an issue ("fetch
 * attachment 12345") therefore cannot pull a file of any other issue.
 */

/** A file name over 255 bytes is refused by the filesystem; `<id>-<name>` is cut to this, on a character boundary. */
export const jiraAttachmentFileNameMaxBytes = 200;
/** The longest extension kept when a long name is cut (so `.png` / `.mp4` still tell the type). */
const extensionMaxBytes = 16;
/** Path separators and control characters: a name must stay ONE path segment. */
const unsafeFileNameCharsRe = /[\/\\\u0000-\u001f\u007f]/g;
const mimeTypeUnknown = 'unknown type';

/** What the tool answers the agent: a message to relay, or why nothing was fetched. */
export type JiraAttachmentToolResult = { ok: true; message: string } | { ok: false; error: string };

export interface JiraAttachmentToolDeps {
  client: Pick<JiraClient, 'getIssue' | 'downloadAttachment'>;
  /** Where one conversation's downloads go: its files dir, `jira`. */
  getDownloadDir: (key: SessionKey) => string;
}

/** The longest prefix of `text` of at most `maxBytes` UTF-8 bytes, cut between characters. */
function getPrefixWithinBytes(text: string, maxBytes: number): string {
  let bytes = 0;
  let prefix = '';
  for (const character of text) {
    bytes += Buffer.byteLength(character);
    if (bytes > maxBytes) break;
    prefix += character;
  }
  return prefix;
}

/**
 * @description `<id>-<name>` as one safe path segment of at most
 * {@link jiraAttachmentFileNameMaxBytes} bytes: separators and control
 * characters stripped, a longer name cut in its stem so its extension survives.
 */
export function getAttachmentFileName(attachmentId: string, filename: string): string {
  const prefix = `${attachmentId.replace(unsafeFileNameCharsRe, '')}-`;
  const name = filename.replace(unsafeFileNameCharsRe, '');
  const budget = jiraAttachmentFileNameMaxBytes - Buffer.byteLength(prefix);
  if (Buffer.byteLength(name) <= budget) return `${prefix}${name}`;
  const extension = path.extname(name);
  const keptExtension = Buffer.byteLength(extension) <= extensionMaxBytes ? extension : '';
  const stem = name.slice(0, name.length - keptExtension.length);
  return `${prefix}${getPrefixWithinBytes(stem, budget - Buffer.byteLength(keptExtension))}${keptExtension}`;
}

/** Is a regular file (never a symlink: `lstat` does not follow one) of exactly `size` bytes already there? */
async function checkHasRegularFileOfSize(filePath: string, size: number | undefined): Promise<boolean> {
  if (size === undefined) return false;
  try {
    const stat = await fsp.lstat(filePath);
    return stat.isFile() && stat.size === size;
  } catch {
    return false;
  }
}

function describeSavedAttachment(attachment: JiraAttachment, filePath: string, bytes: number): string {
  // Written by whoever attached the file: kept on one line, like every other piece of issue text.
  const mimeType = getSingleLineText(attachment.mimeType ?? '') || mimeTypeUnknown;
  const hint = mimeType.startsWith('image/')
    ? ' View it with your file-reading tool.'
    : mimeType.startsWith('video/')
      ? ' It is a video: if ffmpeg is on your PATH, take frames or the audio track from it.'
      : '';
  return `Attachment ${attachment.id} (${getSingleLineText(attachment.filename)}, ${mimeType}, ${bytes} bytes) is saved at ${filePath}.${hint}`;
}

/**
 * @description Fetch attachment `attachmentId` of the issue `key` names, to a file,
 * and say where. A download of an id the issue does not list is refused; a file of
 * the same size already there is reused (the download is skipped); the new file is
 * written under a fresh temporary name and renamed into place, so a symlink planted
 * at the final name is replaced, never followed.
 */
export async function fetchIssueAttachment(deps: JiraAttachmentToolDeps, key: SessionKey, attachmentId: string): Promise<JiraAttachmentToolResult> {
  const issueKey = key.thread;
  try {
    const issue = await deps.client.getIssue(issueKey, ['attachment']);
    const attachment = (issue.fields.attachment ?? []).find((candidate) => candidate.id === attachmentId);
    if (!attachment) {
      const listed = (issue.fields.attachment ?? []).map((candidate) => candidate.id).join(', ') || 'none';
      return { ok: false, error: `Attachment ${attachmentId} is not an attachment of ${issueKey}. Its attachments: ${listed}.` };
    }
    const downloadDir = deps.getDownloadDir(key);
    const filePath = path.join(downloadDir, getAttachmentFileName(attachment.id, attachment.filename));
    if (await checkHasRegularFileOfSize(filePath, attachment.size)) {
      return { ok: true, message: describeSavedAttachment(attachment, filePath, attachment.size ?? 0) };
    }
    await fsp.mkdir(downloadDir, { recursive: true, mode: 0o700 });
    const tmpPath = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      const bytes = await deps.client.downloadAttachment(attachment.id, tmpPath);
      await fsp.rename(tmpPath, filePath);
      return { ok: true, message: describeSavedAttachment(attachment, filePath, bytes) };
    } finally {
      await fsp.rm(tmpPath, { force: true });
    }
  } catch (error) {
    if (error instanceof JiraAuthError) return { ok: false, error: `Jira refused the download of attachment ${attachmentId} (${error.status}).` };
    return { ok: false, error: `Attachment ${attachmentId} could not be fetched: ${error instanceof Error ? error.message : String(error)}` };
  }
}
