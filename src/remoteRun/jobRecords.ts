import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { maxTimeoutSeconds } from './cliArgs';
import { parseJobId } from './jobId';

/**
 * @description The main box's own record of a job: which local project it was submitted from. `wait` and `fetch` bring result files back
 * into THAT project — the runner is not trusted to say where its files go (its `meta.json` is only shown by `ls` and `status`; a
 * hostile runner could name any folder of this user, and the slug of a root is a hash of public inputs it can compute). A job submitted
 * from another user or machine has no record here, and its files are not fetched.
 *
 * Kept in the local cache (`<cache>/jobs/<id>.json`, mode 0600) for as long as the runner can still have the job: until its own deadline
 * (`submittedAtMs` + its `--timeout`, up to 7 days) and then the days the runner keeps a finished one. Not by the age of the file: a job
 * that runs or queues for days, or one fetched on the last day of the runner's retention, would find its record gone and its files
 * silently left on the runner.
 */

/** The runner removes a job this long after it ended (`runner.sh`: `job_keep_days`); the record has no use past it. */
const recordKeepDays = 3;
const millisecondsPerDay = 24 * 60 * 60 * 1000;
const recordsDirectoryName = 'jobs';
const recordFileMode = 0o600;
const recordsDirectoryMode = 0o700;
const recordSuffix = '.json';

/** `timeoutSeconds` is absent in a record an earlier build wrote: the longest `--timeout` allowed stands in for it. */
const recordSchema = z.looseObject({ projectRoot: z.string().min(1), slug: z.string().min(1), submittedAtMs: z.number(), timeoutSeconds: z.number().positive().optional() });

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

/** @description When a record has no use any more: the job's deadline, then the days the runner keeps a job that ended. */
export function getRecordExpiryMs(record: LocalJobRecord): number {
  return record.submittedAtMs + (record.timeoutSeconds ?? maxTimeoutSeconds) * 1000 + recordKeepDays * millisecondsPerDay;
}

/** When the file at `recordPath` expires: by its record, or — for a file that is not one — by its own age after the longest life a record can have. */
function readFileExpiryMs(recordPath: string): number {
  try {
    const parsed = recordSchema.safeParse(JSON.parse(fs.readFileSync(recordPath, 'utf8')));
    if (parsed.success) return getRecordExpiryMs(parsed.data);
  } catch {
    /* not JSON: judged by its age below */
  }
  return fs.statSync(recordPath).mtimeMs + maxTimeoutSeconds * 1000 + recordKeepDays * millisecondsPerDay;
}

function pruneLocalJobRecords(cacheDir: string, nowMs: number): void {
  const directory = path.join(cacheDir, recordsDirectoryName);
  for (const name of fs.readdirSync(directory)) {
    if (!name.endsWith(recordSuffix)) continue;
    const recordPath = path.join(directory, name);
    try {
      if (nowMs > readFileExpiryMs(recordPath)) fs.rmSync(recordPath, { force: true });
    } catch {
      /* gone already: nothing to prune */
    }
  }
}
