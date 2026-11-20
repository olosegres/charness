import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { promisify } from 'node:util';
import { z } from 'zod';
import { RotatingJsonlFile } from '../../utils/rotatingJsonlFile';

/**
 * @description The files the AI account attached to issues, by CONTENT: `DATA_DIR/jira-uploaded-files.jsonl`, one line per
 * upload — the issue, the attachment, the file's name, size and sha256 (`outgoingFiles.ts`). A file the agent sends again
 * is reused only when one of the issue's attachments is recorded here with the same name, size AND hash: a resend after a
 * comment that did not land attaches nothing twice, while a file regenerated under the same name and length is a new
 * upload — never the old picture shown as the new one. Survives a restart; a line older than
 * {@link jiraUploadedFileMaxAgeMs} is forgotten, which keeps the file and the map small.
 */

export const jiraUploadedFilesFileName = 'jira-uploaded-files.jsonl';
/** Uploads are a few per answer; ample for months, the one `.1` backup is read too. */
const uploadedFilesMaxBytes = 1024 * 1024;
export const jiraUploadedFileMaxAgeMs = 30 * 24 * 60 * 60 * 1000;
/** One read of a file being hashed. */
const hashChunkBytes = 1024 * 1024;
const readFileAt = promisify(fs.read);

const uploadedFileLineSchema = z.object({
  issueKey: z.string().min(1),
  attachmentId: z.string().min(1),
  filename: z.string(),
  size: z.number(),
  sha256: z.string().min(1),
  /** Epoch ms of the upload. */
  at: z.number(),
});

type UploadedFileLine = z.infer<typeof uploadedFileLineSchema>;

/** A file as the store knows it: the name it was attached under, its size and its content hash. */
export interface JiraUploadedFileIdentity {
  filename: string;
  size: number;
  sha256: string;
}

/** @description The sha256 of the open file `fd` of `sizeBytes` bytes, read by position from byte 0 (its own offset never moves). */
export async function getFileSha256(fd: number, sizeBytes: number): Promise<string> {
  const hash = createHash('sha256');
  const chunk = Buffer.alloc(Math.min(hashChunkBytes, Math.max(sizeBytes, 1)));
  for (let position = 0; position < sizeBytes;) {
    const { bytesRead } = await readFileAt(fd, chunk, 0, Math.min(chunk.length, sizeBytes - position), position);
    if (bytesRead === 0) throw new Error(`the file ended at byte ${position} of ${sizeBytes}: it changed while it was read`);
    hash.update(chunk.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest('hex');
}

export class JiraUploadedFiles {
  private lines: UploadedFileLine[] = [];

  constructor(private readonly file: RotatingJsonlFile<UploadedFileLine>, private readonly now: () => number) {}

  static createForDataDir(filePath: string, now: () => number): JiraUploadedFiles {
    return new JiraUploadedFiles(new RotatingJsonlFile<UploadedFileLine>(filePath, uploadedFilesMaxBytes), now);
  }

  /** @description Replay the file, keeping what is young enough; a line that does not parse is skipped with a warning (never fatal). */
  async load(): Promise<void> {
    const { records, skippedCount } = await this.file.readRecords(uploadedFileLineSchema);
    this.lines = records;
    this.forgetExpired();
    if (skippedCount > 0) console.warn(`[jira] uploaded files: ${skippedCount} unreadable line(s) skipped`);
  }

  private forgetExpired(): void {
    const oldestMs = this.now() - jiraUploadedFileMaxAgeMs;
    this.lines = this.lines.filter((line) => line.at >= oldestMs);
  }

  /** @description The attachments of issue `issueKey` that hold exactly `file` — its name, size and content — newest first. */
  findAttachmentIds(issueKey: string, file: JiraUploadedFileIdentity): string[] {
    this.forgetExpired();
    return this.lines
      .filter((line) => line.issueKey === issueKey && line.filename === file.filename && line.size === file.size && line.sha256 === file.sha256)
      .map((line) => line.attachmentId)
      .reverse();
  }

  /**
   * @description Remember that attachment `attachmentId` of `issueKey` holds `file`. A line that cannot be written is still
   * remembered for this process (a warning): the resend right after an upload is the one that matters most.
   */
  record(issueKey: string, attachmentId: string, file: JiraUploadedFileIdentity): void {
    const line: UploadedFileLine = { issueKey, attachmentId, filename: file.filename, size: file.size, sha256: file.sha256, at: this.now() };
    if (!this.file.append(line)) console.warn(`[jira] uploaded files: ${issueKey}: attachment ${attachmentId} could not be written down`);
    this.lines.push(line);
  }
}
