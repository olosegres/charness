import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { parseJobId } from './jobId';

/**
 * @description The main box's own record of a job: which local project it was submitted from. `wait` and `fetch` bring result files back
 * into THAT project — the runner is not trusted to say where its files go (its `meta.json` is only shown by `ls` and `status`; a
 * hostile runner could name any folder of this user, and the slug of a root is a hash of public inputs it can compute). A job submitted
 * from another user or machine has no record here, and its files are not fetched.
 *
 * Kept in the local cache (`<cache>/jobs/<id>.json`, mode 0600) for as long as the runner keeps the job.
 */

/** The runner removes a job after this long (`runner.sh`: `job_keep_days`); the record has no use past it. */
const recordKeepDays = 3;
const millisecondsPerDay = 24 * 60 * 60 * 1000;
const recordsDirectoryName = 'jobs';
const recordFileMode = 0o600;
const recordsDirectoryMode = 0o700;
const recordSuffix = '.json';

const recordSchema = z.looseObject({ projectRoot: z.string().min(1), slug: z.string().min(1), submittedAtMs: z.number() });

export type LocalJobRecord = z.infer<typeof recordSchema>;

function getRecordPath(cacheDir: string, jobId: string): string {
  if (parseJobId(jobId) === null) throw new Error(`not a job id: ${jobId}`);
  return path.join(cacheDir, recordsDirectoryName, `${jobId}${recordSuffix}`);
}

/** @description Remember where `jobId` came from; also drops the records the runner has surely pruned. */
export function writeLocalJobRecord(cacheDir: string, jobId: string, record: LocalJobRecord, nowMs: number = Date.now()): void {
  const recordPath = getRecordPath(cacheDir, jobId);
  fs.mkdirSync(path.dirname(recordPath), { recursive: true, mode: recordsDirectoryMode });
  fs.writeFileSync(recordPath, JSON.stringify(record), { mode: recordFileMode });
  pruneLocalJobRecords(cacheDir, nowMs);
}

/** @description The record of `jobId`, or `null` when this machine and user did not submit it (or it was pruned). */
export function readLocalJobRecord(cacheDir: string, jobId: string): LocalJobRecord | null {
  try {
    const parsed = recordSchema.safeParse(JSON.parse(fs.readFileSync(getRecordPath(cacheDir, jobId), 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function pruneLocalJobRecords(cacheDir: string, nowMs: number): void {
  const directory = path.join(cacheDir, recordsDirectoryName);
  for (const name of fs.readdirSync(directory)) {
    if (!name.endsWith(recordSuffix)) continue;
    const recordPath = path.join(directory, name);
    try {
      if (nowMs - fs.statSync(recordPath).mtimeMs > recordKeepDays * millisecondsPerDay) fs.rmSync(recordPath, { force: true });
    } catch {
      /* gone already */
    }
  }
}
