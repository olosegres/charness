import { z } from 'zod';
import { remoteRunExitCodes } from './exitCodes';
import { pueueLabelPrefix } from './jobId';

/**
 * @description What a job is doing or how it ended, from the two witnesses: the job's own files (`runner.sh result`) and Pueue's task
 * list. The job's own exit file is authoritative; a job that was SIGKILLed (a timeout whose command ignored SIGTERM, a kill after
 * the grace time) wrote none, and then the markers it left and Pueue's verdict decide. Pueue alone is never trusted for the code:
 * `pueue wait` exits 0 for a failed task, and a task Pueue calls `Killed` may have been a timeout.
 */

export type PueueResult = { kind: 'success' } | { kind: 'failed'; code: number } | { kind: 'killed' } | { kind: 'other'; text: string };

export interface PueueTask {
  id: number;
  label: string | null;
  state: 'queued' | 'running' | 'done' | 'other';
  result: PueueResult | null;
}

const doneSchema = z.looseObject({ result: z.union([z.string(), z.record(z.string(), z.union([z.number(), z.string()]))]) });
const statusSchema = z.union([
  z.string(),
  z.looseObject({ Running: z.looseObject({}).optional(), Done: doneSchema.optional(), Paused: z.looseObject({}).optional(), Queued: z.looseObject({}).optional(), Stashed: z.looseObject({}).optional() }),
]);
const pueueStatusSchema = z.looseObject({
  tasks: z.record(z.string(), z.looseObject({ id: z.number(), label: z.string().nullable().optional(), status: statusSchema })),
});

function readPueueResult(raw: string | Record<string, number | string>): PueueResult {
  if (raw === 'Success') return { kind: 'success' };
  if (raw === 'Killed') return { kind: 'killed' };
  if (typeof raw === 'object' && typeof raw.Failed === 'number') return { kind: 'failed', code: raw.Failed };
  return { kind: 'other', text: typeof raw === 'string' ? raw : JSON.stringify(raw) };
}

/** @description The tasks of `pueue status --json` that are ours (label `rr-…`). A reply that is not Pueue's status is an error. */
export function parsePueueStatus(jsonText: string): PueueTask[] {
  let parsed: ReturnType<typeof pueueStatusSchema.safeParse>;
  try {
    parsed = pueueStatusSchema.safeParse(JSON.parse(jsonText));
  } catch {
    throw new Error('pueue status did not return JSON');
  }
  if (!parsed.success) throw new Error('pueue status returned something that is not its task list');
  const tasks: PueueTask[] = [];
  for (const task of Object.values(parsed.data.tasks)) {
    const label = task.label ?? null;
    if (label === null || !label.startsWith(pueueLabelPrefix)) continue;
    const status = task.status;
    if (typeof status === 'string') {
      tasks.push({ id: task.id, label, state: status === 'Queued' ? 'queued' : 'other', result: null });
    } else if (status.Running !== undefined) {
      tasks.push({ id: task.id, label, state: 'running', result: null });
    } else if (status.Done !== undefined) {
      tasks.push({ id: task.id, label, state: 'done', result: readPueueResult(status.Done.result) });
    } else {
      // A stashed task waits for its project's earlier job (`runner.sh`, «adding the job to Pueue»): to the caller it is queued like any other.
      tasks.push({ id: task.id, label, state: status.Queued !== undefined || status.Stashed !== undefined ? 'queued' : 'other', result: null });
    }
  }
  return tasks;
}

/** @name JobFacts @description What `runner.sh result` prints. */
export interface JobFacts {
  /** The project's folder name on the runner. */
  slug: string;
  /** The exit file's content; `null` while there is none. */
  exit: number | null;
  phase: string;
  taskId: number | null;
  startedAtSeconds: number | null;
  finishedAtSeconds: number | null;
  isTimedOut: boolean;
  isKilled: boolean;
  isStarted: boolean;
  isWithArtifacts: boolean;
  /** `deps` when the dependencies step failed. */
  failedStep: string;
}

function readInteger(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

/** @description Parse the `key=value` lines of `runner.sh result`. */
export function parseJobFacts(text: string): JobFacts {
  const fields = new Map<string, string>();
  for (const line of text.split('\n')) {
    const separator = line.indexOf('=');
    if (separator > 0) fields.set(line.slice(0, separator), line.slice(separator + 1).trim());
  }
  return {
    slug: fields.get('slug') ?? '',
    exit: readInteger(fields.get('exit')),
    phase: fields.get('phase') ?? '',
    taskId: readInteger(fields.get('task')),
    startedAtSeconds: readInteger(fields.get('started')),
    finishedAtSeconds: readInteger(fields.get('finished')),
    isTimedOut: fields.get('timeout') === '1',
    isKilled: fields.get('killed') === '1',
    isStarted: fields.get('has_pid') === '1',
    isWithArtifacts: fields.get('artifacts') === '1',
    failedStep: fields.get('failed_step') ?? '',
  };
}

export type JobEndReason = 'exit' | 'timeout' | 'killed' | 'deps-failed' | 'lost';

export type JobOutcome =
  | { state: 'queued' }
  | { state: 'running'; phase: string }
  | { state: 'done'; code: number; reason: JobEndReason }
  | { state: 'unknown' };

/** @description The job's state and, once it ended, remote-run's exit code for it and why. */
export function describeJobOutcome(facts: JobFacts, task: PueueTask | null): JobOutcome {
  if (facts.exit !== null) {
    let reason: JobEndReason = 'exit';
    if (facts.exit === remoteRunExitCodes.timedOut && facts.isTimedOut) reason = 'timeout';
    else if (facts.exit === remoteRunExitCodes.killed && facts.isKilled) reason = 'killed';
    else if (facts.exit === remoteRunExitCodes.failed && facts.failedStep === 'deps') reason = 'deps-failed';
    return { state: 'done', code: facts.exit, reason };
  }
  if (task === null) return facts.isStarted ? { state: 'done', code: remoteRunExitCodes.failed, reason: 'lost' } : { state: 'unknown' };
  if (task.state === 'queued') return { state: 'queued' };
  if (task.state === 'running') return facts.isStarted ? { state: 'running', phase: facts.phase } : { state: 'queued' };
  if (task.state === 'done') {
    // The job process was killed hard: no exit file, so the markers and Pueue's verdict say what it was.
    if (facts.isTimedOut) return { state: 'done', code: remoteRunExitCodes.timedOut, reason: 'timeout' };
    if (task.result?.kind === 'killed' || facts.isKilled) return { state: 'done', code: remoteRunExitCodes.killed, reason: 'killed' };
    return { state: 'done', code: remoteRunExitCodes.failed, reason: 'lost' };
  }
  return { state: 'unknown' };
}

/** @description One short word for a job's state in `ls` and `status`. */
export function describeJobState(outcome: JobOutcome): string {
  if (outcome.state === 'done') {
    if (outcome.reason === 'timeout') return 'timed out';
    if (outcome.reason === 'killed') return 'killed';
    if (outcome.reason === 'deps-failed') return 'deps failed';
    if (outcome.reason === 'lost') return 'lost';
    return outcome.code === 0 ? 'passed' : 'failed';
  }
  if (outcome.state === 'running') return outcome.phase === '' || outcome.phase === 'running' ? 'running' : `running (${outcome.phase})`;
  return outcome.state;
}
