import { parsePrunedCopies, type PrunedCopy } from './pruneReport';
import { formatGigabytes } from './probe';

/**
 * @description `charness remote-run clean`: what one runner answered (`runner.sh clean`, some lines on stdout) and the line the CLI prints for every runner.
 * The runner script answers with facts — `removed=<slug> freed_kb=<n> why=clean` (one per folder it removed: the copy, a leftover of an earlier removal, or both) · `absent=<slug>` ·
 * `removing=<slug>` (a leftover whose remover still lives) · `busy=<slug> kind=<kind> job=<id|->` · `stuck=<slug>` — and the words are chosen here. A runner that could not be asked,
 * or that did not finish in time, has its own outcomes.
 */

/** Why a copy is in use (`copy_busy_kind` in `runner.sh`). `results`: a job ended under an hour ago and nobody has fetched its results (the prune keeps such a copy whatever; `clean` stops there only while the `fetched` mark is missing). */
const copyBusyKinds = ['lock', 'exec', 'running', 'queued', 'submitting', 'results', 'name'] as const;
export type CopyBusyKind = (typeof copyBusyKinds)[number];

const busyLinePattern = /^busy=(\S+) kind=(\S+) job=(\S+)$/;
const absentLinePattern = /^absent=(\S+)$/;
const removingLinePattern = /^removing=(\S+)$/;
const noJobId = '-';

/** @name CleanOutcome @description What happened on one runner. Only `removed` and `absent` need nothing more from the caller; `unreachable` leaves the copy (if any) where it is. */
export type CleanOutcome =
  | { kind: 'removed'; freedMb: number | null }
  | { kind: 'absent' }
  | { kind: 'removing' }
  | { kind: 'busy'; reason: CopyBusyKind; jobId: string | null }
  | { kind: 'stuck' }
  | { kind: 'unreachable'; reason: string }
  | { kind: 'timedOut'; timeoutMinutes: number }
  | { kind: 'failed'; message: string };

/**
 * @description The outcome a `clean` answer says for `slug`. The script may say several things (the copy and a leftover of an earlier removal are two folders); what the caller most needs to hear wins: a copy that is
 * in use, then one that would not go, then one that is still being removed by someone else, then what was removed (the freed space of every folder added up), then «nothing there». A text with none of them is a
 * failure (a script that did not know the word).
 */
export function parseCleanAnswer(stdout: string, slug: string): CleanOutcome {
  const copies = parsePrunedCopies(stdout).filter((copy) => copy.slug === slug);
  let busy: CleanOutcome | null = null;
  let isRemoving = false;
  let isAbsent = false;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    const busyLine = busyLinePattern.exec(trimmed);
    const reason = busyLine === null ? undefined : copyBusyKinds.find((candidate) => candidate === busyLine[2]);
    if (busyLine !== null && busyLine[1] === slug && reason !== undefined && busy === null) busy = { kind: 'busy', reason, jobId: busyLine[3] === noJobId ? null : busyLine[3] };
    if (removingLinePattern.exec(trimmed)?.[1] === slug) isRemoving = true;
    if (absentLinePattern.exec(trimmed)?.[1] === slug) isAbsent = true;
  }
  if (busy !== null) return busy;
  if (copies.some((copy) => copy.isStuck)) return { kind: 'stuck' };
  if (isRemoving) return { kind: 'removing' };
  const removed = copies.filter((copy): copy is Extract<PrunedCopy, { isStuck: false }> => !copy.isStuck);
  if (removed.length > 0) {
    const freedMegabytes = removed.map((copy) => copy.freedMb);
    const isFreedKnown = freedMegabytes.every((megabytes) => megabytes !== null);
    return { kind: 'removed', freedMb: isFreedKnown ? freedMegabytes.reduce<number>((total, megabytes) => total + (megabytes ?? 0), 0) : null };
  }
  return isAbsent ? { kind: 'absent' } : { kind: 'failed', message: 'the runner did not say what it did with the copy' };
}

/** @description Is the outcome one the caller must act on (the copy is still there although it was asked to go, or the runner could not say)? `unreachable` is not: the line says what to do, and exit 0 keeps a sleeping Mac from failing a task's closing; nor is `removing`: someone is taking it away. */
export function checkIsCleanFailure(outcome: CleanOutcome): boolean {
  return outcome.kind === 'busy' || outcome.kind === 'stuck' || outcome.kind === 'timedOut' || outcome.kind === 'failed';
}

function describeBusy(reason: CopyBusyKind, jobId: string | null): string {
  const job = jobId ?? 'a job';
  switch (reason) {
    case 'running': return `${job} is running in it — \`charness remote-run wait ${job}\` (or \`kill ${job}\`), then clean again`;
    case 'queued': return `${job} waits in the queue for it — \`charness remote-run kill ${job}\` (or wait for it), then clean again`;
    case 'submitting': return `${job} is still being submitted — clean again in a minute`;
    case 'exec': return 'an `exec` is running in it — clean again when it ends';
    case 'lock': return `its project lock is held${jobId === null ? '' : ` by ${jobId}`} — clean again when that job ends`;
    case 'results': return `${job} ended less than an hour ago and its results were not fetched — whoever submitted it fetches them (\`charness remote-run wait ${job}\` or \`fetch ${job}\`); clean again after that`;
    case 'name': return 'that is not the name of a copy';
  }
}

/** @description The line `clean` prints for one runner. */
export function formatCleanLine(runnerName: string, slug: string, outcome: CleanOutcome): string {
  switch (outcome.kind) {
    case 'removed': return `${runnerName}: removed the project copy ${slug}${outcome.freedMb === null ? '' : ` (freed ${formatGigabytes(outcome.freedMb)})`}`;
    case 'absent': return `${runnerName}: no copy of ${slug} (nothing to clean)`;
    case 'removing': return `${runnerName}: the copy ${slug} is already being removed (by an earlier clean or a prune) — clean again in a few minutes to see it gone`;
    case 'busy': return `${runnerName}: NOT cleaned — ${describeBusy(outcome.reason, outcome.jobId)}`;
    case 'stuck': return `${runnerName}: NOT cleaned completely — the copy ${slug} would not go (read-only or in use); clean again later`;
    case 'unreachable': return `${runnerName}: not reached (${outcome.reason}) — its copy of ${slug}, if any, stays; clean again when it is back`;
    case 'timedOut': return `${runnerName}: still cleaning after ${outcome.timeoutMinutes} minutes (a big copy) — the runner carries on as far as it can; clean again to finish`;
    case 'failed': return `${runnerName}: NOT cleaned — ${outcome.message}`;
  }
}
