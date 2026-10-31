import { getJobLabel } from './jobId';
import { describeJobOutcome, parseJobFacts, parsePueueStatus, type JobFacts, type JobOutcome } from './jobState';
import { RemoteRunError } from './remoteRunError';
import type { RunnerClient } from './runnerClient';

/**
 * @description Ask a runner how a job is doing: its own files (`result`) first, Pueue's task list only when the job left no exit file
 * (a hard kill) or has not started.
 */

/** The job's facts and what they mean. `slug` may be `-` for "the project this job id belongs to"; the answer names it. */
export async function readJobOutcome(client: RunnerClient, slug: string, jobId: string): Promise<{ facts: JobFacts; outcome: JobOutcome }> {
  const facts = parseJobFacts(await client.callOrThrow('result', [slug, jobId]));
  if (facts.exit !== null) return { facts, outcome: describeJobOutcome(facts, null) };
  const pueue = await client.call('pueue', ['status', '--json']);
  if (pueue.exitCode !== 0) throw new RemoteRunError(`runner "${client.runner.name}": Pueue did not answer — ${pueue.stderr.trim().split('\n')[0] || 'no output'}`);
  const task = parsePueueStatus(pueue.stdout).find((candidate) => candidate.label === getJobLabel(jobId)) ?? null;
  return { facts, outcome: describeJobOutcome(facts, task) };
}
