import { checkIsDiskLow, formatGigabytes, type RunnerProbe } from './probe';

/**
 * @description What `runner.sh prepare` says about the project copies its prune removed: one `removed=<slug> freed_kb=<n> why=<idle|space>` line per copy
 * (`stuck=<slug>` for one that would not go), shown to the user as one short line each; `stopped=<slug> freed_kb=<n> size_kb=<n>` when a removal gave next to nothing back and the prune
 * stopped. The refusal of a submit on a disk that is still too full is the runner's own words under {@link diskTooLowRunnerExitCode}.
 */

/** The exit code `runner.sh prepare` ends with when the work disk is still short of free space after the prune (`low_disk_exit_code` there: the two are one number; 28 is ENOSPC). */
export const diskTooLowRunnerExitCode = 28;

const kilobytesPerMegabyte = 1024;

/** Why a copy was removed: unused for days, the disk was short of free space, or its owner asked (`remote-run clean`). */
const prunedCopyReasons = ['idle', 'space', 'clean'] as const;
export type PrunedCopyReason = (typeof prunedCopyReasons)[number];

/** @name PrunedCopy @description One project copy the runner removed, or failed to remove (`isStuck`). */
export type PrunedCopy =
  | { slug: string; isStuck: false; freedMb: number | null; reason: PrunedCopyReason }
  | { slug: string; isStuck: true };

const removedLinePattern = /^removed=(\S+) freed_kb=(\d*) why=(idle|space|clean)$/;
const stuckLinePattern = /^stuck=(\S+)$/;

/** @description The copies a `prepare` answer says were removed, in the order the runner removed them. Other lines (`work=…`) are not this report's. */
export function parsePrunedCopies(prepareOutput: string): PrunedCopy[] {
  const copies: PrunedCopy[] = [];
  for (const line of prepareOutput.split('\n')) {
    const removed = removedLinePattern.exec(line.trim());
    const reason = removed === null ? undefined : prunedCopyReasons.find((candidate) => candidate === removed[3]);
    if (removed !== null && reason !== undefined) {
      const freedKb = removed[2] === '' ? null : Number(removed[2]);
      copies.push({ slug: removed[1], isStuck: false, freedMb: freedKb === null ? null : freedKb / kilobytesPerMegabyte, reason });
      continue;
    }
    const stuck = stuckLinePattern.exec(line.trim());
    if (stuck !== null) copies.push({ slug: stuck[1], isStuck: true });
  }
  return copies;
}

/** @description `runner mac: removed the project copy app-1a2b3c (freed 41 GB, unused for days)` — one line for the submit's output. */
export function formatPrunedCopyLine(runnerName: string, copy: PrunedCopy): string {
  if (copy.isStuck) return `runner ${runnerName}: could not remove the project copy ${copy.slug} completely (read-only or in use) — the next prune tries again`;
  const reasonTexts: Record<PrunedCopyReason, string> = { idle: 'unused for days', space: 'the disk was short of free space', clean: 'cleaned on request' };
  const why = reasonTexts[copy.reason];
  const freed = copy.freedMb === null ? '' : `freed ${formatGigabytes(copy.freedMb)}, `;
  return `runner ${runnerName}: removed the project copy ${copy.slug} (${freed}${why})`;
}

const stoppedLinePattern = /^stopped=(\S+) freed_kb=(\d+) size_kb=(\d+)$/;

/** @name RemovalStop @description The prune stopped after removing `slug` because the disk's free space did not grow by what the copy took: `freedMb` of `sizeMb`. */
export interface RemovalStop {
  slug: string;
  freedMb: number;
  sizeMb: number;
}

/** @description The `stopped=` line of a `prepare` answer, `null` when the prune did not stop that way. */
export function parseRemovalStop(prepareOutput: string): RemovalStop | null {
  for (const line of prepareOutput.split('\n')) {
    const stopped = stoppedLinePattern.exec(line.trim());
    if (stopped !== null) return { slug: stopped[1], freedMb: Number(stopped[2]) / kilobytesPerMegabyte, sizeMb: Number(stopped[3]) / kilobytesPerMegabyte };
  }
  return null;
}

/**
 * @description `runner mac: removing project copies gave back almost nothing twice in a row (the last, app-1: 0 GB of its 30 GB) …` — why the runner did not remove more, and the causes it points at.
 * «Twice» is `no_progress_stop_after` in `runner.sh`: one removal that frees little can be a job writing to the same disk meanwhile.
 */
export function formatRemovalStopLine(runnerName: string, stop: RemovalStop): string {
  return `runner ${runnerName}: removing project copies gave back almost nothing twice in a row (the last, ${stop.slug}: ${formatGigabytes(stop.freedMb)} of its ${formatGigabytes(stop.sizeMb)}) — the disk's free space is not following (a Mac keeps it while Time Machine local snapshots or purgeable space hold it; jobs writing meanwhile eat it too, see docs/remote-run.md), so it stopped removing more copies`;
}

export const millisecondsPerMinute = 60 * 1000;

/**
 * @description The line before a `prepare` that is going to be slow: the runner's disk (as its probe a moment ago found it) is under what it keeps free, so it will remove old project copies first —
 * minutes of silence on a big disk. `null` when the disk is fine or nothing is known (a submit says nothing extra then).
 */
export function formatPruneHeadsUp(runnerName: string, probe: RunnerProbe | null): string | null {
  if (probe === null || !checkIsDiskLow(probe) || probe.diskMinFreeMb === null) return null;
  return `runner ${runnerName}: ${formatGigabytes(probe.diskFreeMb)} free, it keeps ${formatGigabytes(probe.diskMinFreeMb)} — removing the least recently used project copies first (this can take minutes)`;
}

/** @description What a `prepare` that ran out of its time says: the runner carries on with the removal as far as it can (it ignores the closed pipe, `cmd_prepare`) and the next submit continues where it stopped, so trying again soon is the way (not a failure of the runner). */
export function describePrepareTimeout(runnerName: string, timeoutMs: number): string {
  return `runner "${runnerName}": preparing the job took longer than ${Math.round(timeoutMs / millisecondsPerMinute)} minutes (it removes old project copies first, which is slow on a big disk) — the runner carries on with that as far as it can: submit again in a few minutes, the next submit continues where it stopped`;
}
