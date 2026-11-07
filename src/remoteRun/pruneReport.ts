import { formatGigabytes } from './probe';

/**
 * @description What `runner.sh prepare` says about the project copies its prune removed: one `removed=<slug> freed_kb=<n> why=<idle|space>` line per copy
 * (`stuck=<slug>` for one that would not go), shown to the user as one short line each. The refusal of a submit on a disk that is still too full is the
 * runner's own words under {@link diskTooLowRunnerExitCode}.
 */

/** The exit code `runner.sh prepare` ends with when the work disk is still short of free space after the prune (`low_disk_exit_code` there: the two are one number; 28 is ENOSPC). */
export const diskTooLowRunnerExitCode = 28;

const kilobytesPerMegabyte = 1024;

export type PrunedCopyReason = 'idle' | 'space';

/** @name PrunedCopy @description One project copy the runner removed, or failed to remove (`isStuck`). */
export type PrunedCopy =
  | { slug: string; isStuck: false; freedMb: number | null; reason: PrunedCopyReason }
  | { slug: string; isStuck: true };

const removedLinePattern = /^removed=(\S+) freed_kb=(\d*) why=(idle|space)$/;
const stuckLinePattern = /^stuck=(\S+)$/;

/** @description The copies a `prepare` answer says were removed, in the order the runner removed them. Other lines (`work=…`) are not this report's. */
export function parsePrunedCopies(prepareOutput: string): PrunedCopy[] {
  const copies: PrunedCopy[] = [];
  for (const line of prepareOutput.split('\n')) {
    const removed = removedLinePattern.exec(line.trim());
    if (removed !== null) {
      const freedKb = removed[2] === '' ? null : Number(removed[2]);
      const reason: PrunedCopyReason = removed[3] === 'idle' ? 'idle' : 'space';
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
  const why = copy.reason === 'idle' ? 'unused for days' : 'the disk was short of free space';
  const freed = copy.freedMb === null ? '' : `freed ${formatGigabytes(copy.freedMb)}, `;
  return `runner ${runnerName}: removed the project copy ${copy.slug} (${freed}${why})`;
}
