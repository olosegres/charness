import { parsePrunedCopies } from './pruneReport';
import { formatGigabytes } from './probe';

/**
 * @description `charness remote-run clean`: what one runner answered (`runner.sh clean`, one line on stdout) and the line the CLI prints for every runner.
 * The runner script answers with facts — `removed=<slug> freed_kb=<n> why=clean` · `absent=<slug>` · `busy=<slug> kind=<kind> job=<id|->` · `stuck=<slug>` —
 * and the words are chosen here. A runner that could not be asked, or that did not finish in time, has its own outcomes.
 */

/** Why a copy is in use (`copy_busy_kind` in `runner.sh`). `results` is the prune's own protection of a job that just ended: `clean` never meets it. */
const copyBusyKinds = ['lock', 'exec', 'running', 'queued', 'submitting', 'results', 'name'] as const;
export type CopyBusyKind = (typeof copyBusyKinds)[number];

const busyLinePattern = /^busy=(\S+) kind=(\S+) job=(\S+)$/;
const absentLinePattern = /^absent=(\S+)$/;
const noJobId = '-';

/** @name CleanOutcome @description What happened on one runner. Only `removed` and `absent` need nothing more from the caller; `unreachable` leaves the copy (if any) where it is. */
export type CleanOutcome =
  | { kind: 'removed'; freedMb: number | null }
  | { kind: 'absent' }
  | { kind: 'busy'; reason: CopyBusyKind; jobId: string | null }
  | { kind: 'stuck' }
  | { kind: 'unreachable'; reason: string }
  | { kind: 'timedOut'; timeoutMinutes: number }
  | { kind: 'failed'; message: string };

/** @description The outcome a `clean` answer says for `slug`; a text with none of the four lines is a failure (a script that did not know the word). */
export function parseCleanAnswer(stdout: string, slug: string): CleanOutcome {
  const removedOrStuck = parsePrunedCopies(stdout).find((copy) => copy.slug === slug);
  if (removedOrStuck !== undefined) return removedOrStuck.isStuck ? { kind: 'stuck' } : { kind: 'removed', freedMb: removedOrStuck.freedMb };
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    const absent = absentLinePattern.exec(trimmed);
    if (absent !== null && absent[1] === slug) return { kind: 'absent' };
    const busy = busyLinePattern.exec(trimmed);
    const reason = busy === null ? undefined : copyBusyKinds.find((candidate) => candidate === busy[2]);
    if (busy !== null && busy[1] === slug && reason !== undefined) return { kind: 'busy', reason, jobId: busy[3] === noJobId ? null : busy[3] };
  }
  return { kind: 'failed', message: 'the runner did not say what it did with the copy' };
}

/** @description Is the outcome one the caller must act on (the copy is still there although it was asked to go, or the runner could not say)? `unreachable` is not: the line says what to do, and exit 0 keeps a sleeping Mac from failing a task's closing. */
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
    case 'results': return `${job} ended a moment ago and its result files may not be fetched yet — clean again in a few minutes`;
    case 'name': return 'that is not the name of a copy';
  }
}

/** @description The line `clean` prints for one runner. */
export function formatCleanLine(runnerName: string, slug: string, outcome: CleanOutcome): string {
  switch (outcome.kind) {
    case 'removed': return `${runnerName}: removed the project copy ${slug}${outcome.freedMb === null ? '' : ` (freed ${formatGigabytes(outcome.freedMb)})`}`;
    case 'absent': return `${runnerName}: no copy of ${slug} (nothing to clean)`;
    case 'busy': return `${runnerName}: NOT cleaned — ${describeBusy(outcome.reason, outcome.jobId)}`;
    case 'stuck': return `${runnerName}: NOT cleaned completely — the copy ${slug} would not go (read-only or in use); clean again later`;
    case 'unreachable': return `${runnerName}: not reached (${outcome.reason}) — its copy of ${slug}, if any, stays; clean again when it is back`;
    case 'timedOut': return `${runnerName}: still cleaning after ${outcome.timeoutMinutes} minutes (a big copy) — the runner carries on as far as it can; clean again to finish`;
    case 'failed': return `${runnerName}: NOT cleaned — ${outcome.message}`;
  }
}
