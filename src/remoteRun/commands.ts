import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import type { RemoteRunCommand } from './cliArgs';
import { planInterrupt, remoteRunExitCodes, type InterruptSignal } from './exitCodes';
import { addInterruptHandler, killCallTimeoutMs, waitForChildEnd } from './interrupts';
import { describeEnd, followForeground, runExec } from './foreground';
import { fetchJobFiles, resolveFetchTarget } from './jobFiles';
import { formatJobList, formatJobStatus, type JobEntry } from './jobFormat';
import { getJobLabel, parseJobId } from './jobId';
import { parseJobMeta } from './jobMeta';
import { readLocalJobRecord } from './jobRecords';
import { readJobOutcome } from './jobQuery';
import { describeJobOutcome, parseJobFacts, parsePueueStatus } from './jobState';
import { createJobOutputRouter, sayOwn, type CliIo } from './output';
import { formatRunnerBlock, type RunnerCapability } from './probe';
import { getProjectContext } from './project';
import { RemoteRunError, RunnerUnreachableError } from './remoteRunError';
import { createRunnerClient, describeRunnerRefusal, type RunnerClient, type RunnerScript } from './runnerClient';
import { findRunnerOfJob, pickRunner, probeRunners } from './runners';
import type { RunnersConfig } from './runnersConfig';
import { checkIsConnectionLost } from './ssh';
import { getJobOwner, stageJob } from './submit';

/**
 * @description The commands of `charness remote-run`, each as a function from its parsed arguments to an exit code. They share one
 * context: the runners file, the local cache, the script to upload and the lease in force. Failures that are remote-run's own are
 * {@link RemoteRunError}s; the entry point turns them into a `remote-run:` line on stderr and their exit code.
 */

export interface CommandContext {
  io: CliIo;
  config: RunnersConfig;
  cacheDir: string;
  script: RunnerScript;
  leaseMs: number;
  now: () => number;
}

/** The last lines of a finished job's log that `wait` prints. */
const waitTailLines = 50;
/** `wait` holds one ssh session for as long as the job runs; a dropped one is opened again this many times before it gives up. */
const waitReconnectAttempts = 5;
const waitReconnectDelayMs = 3000;
const jobsListTimeoutMs = 30 * 1000;

function createClient(context: CommandContext, runnerName: string): RunnerClient {
  const runner = context.config.runners.find((candidate) => candidate.name === runnerName);
  if (runner === undefined) throw new RemoteRunError(`no runner named "${runnerName}" in runners.json (configured: ${context.config.runners.map((candidate) => candidate.name).join(', ')})`, remoteRunExitCodes.usage);
  return createRunnerClient(runner, context.cacheDir, context.script);
}

/** Probe the runners a command may use and pick one (the named one, or the first that answers and has `needs`). */
async function chooseClient(context: CommandContext, wanted: { runner: string | null; needs: RunnerCapability | null }): Promise<RunnerClient> {
  const clients = wanted.runner === null
    ? context.config.runners.map((runner) => createClient(context, runner.name))
    : [createClient(context, wanted.runner)];
  const reports = await probeRunners(clients, context.now());
  const pick = pickRunner(context.config, reports, wanted);
  if (!pick.ok) throw new RemoteRunError(pick.message, pick.exitCode);
  const client = clients.find((candidate) => candidate.runner.name === pick.runnerName);
  if (client === undefined) throw new RemoteRunError('the picked runner is not among the candidates');
  return client;
}

/** The client of the runner a job id belongs to, with its script in place. */
async function openJobClient(context: CommandContext, jobId: string): Promise<RunnerClient> {
  const parsed = parseJobId(jobId);
  if (parsed === null) throw new RemoteRunError(`"${jobId}" is not a job id`, remoteRunExitCodes.usage);
  const client = createRunnerClient(findRunnerOfJob(context.config, parsed.runnerName), context.cacheDir, context.script);
  await client.ensureScript();
  return client;
}

// ─────────────────────────── run ───────────────────────────

export async function runRunCommand(command: Extract<RemoteRunCommand, { kind: 'run' }>, context: CommandContext): Promise<number> {
  const { io } = context;
  const project = getProjectContext(io.cwd);
  const client = await chooseClient(context, { runner: command.options.runner, needs: command.options.needs });
  const metaDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-run-'));
  // Before the job exists an interrupt only has the temp files to clean up.
  const removeStagingGuard = addInterruptHandler((signal) => {
    fs.rmSync(metaDirectory, { recursive: true, force: true });
    process.exit(planInterrupt(signal).exitCode);
  });
  let staged: Awaited<ReturnType<typeof stageJob>>;
  try {
    staged = await stageJob({ client, project, command: command.command, options: command.options, metaDirectory, say: (line) => sayOwn(io, line) });
  } finally {
    removeStagingGuard();
    fs.rmSync(metaDirectory, { recursive: true, force: true });
  }
  if (command.options.isBackground) {
    await client.callOrThrow('submit', [staged.slug, staged.jobId, staged.group]);
    io.stdout(`${staged.jobId}\n`);
    sayOwn(io, `job ${staged.jobId} runs on ${client.runner.name} — \`charness remote-run wait ${staged.jobId}\` blocks until it ends and brings its files back`);
    return 0;
  }
  return followForeground({ client, staged, target: { root: project.root, slug: project.slug, patterns: project.config.pull }, io, leaseMs: context.leaseMs });
}

// ─────────────────────────── runners ───────────────────────────

export async function runRunnersCommand(context: CommandContext): Promise<number> {
  const clients = context.config.runners.map((runner) => createRunnerClient(runner, context.cacheDir, context.script));
  const reports = await probeRunners(clients, context.now());
  context.io.stdout(`${reports.map(formatRunnerBlock).join('\n\n')}\n`);
  return 0;
}

// ─────────────────────────── ls / status ───────────────────────────

const jobListSchema = z.array(z.looseObject({ id: z.string(), facts: z.string(), meta: z.looseObject({}) }));

async function listRunnerJobs(client: RunnerClient, slugFilter: string | null): Promise<JobEntry[]> {
  await client.ensureScript();
  const listed = await client.call('jobs', slugFilter === null ? [] : [slugFilter], { timeoutMs: jobsListTimeoutMs });
  if (listed.exitCode !== 0) throw new RemoteRunError(`runner "${client.runner.name}": listing jobs failed — ${listed.stderr.trim().split('\n')[0] || 'no output'}`);
  const rows = jobListSchema.parse(JSON.parse(listed.stdout));
  const pueue = await client.call('pueue', ['status', '--json'], { timeoutMs: jobsListTimeoutMs });
  const tasks = pueue.exitCode === 0 ? parsePueueStatus(pueue.stdout) : [];
  const owner = getJobOwner();
  const entries: JobEntry[] = [];
  for (const row of rows) {
    const meta = parseJobMeta(JSON.stringify(row.meta));
    if (meta === null || meta.owner !== owner) continue;
    const facts = parseJobFacts(row.facts.replace(/;/g, '\n'));
    const task = tasks.find((candidate) => candidate.label === getJobLabel(row.id)) ?? null;
    entries.push({ meta, facts, outcome: describeJobOutcome(facts, task) });
  }
  return entries;
}

export async function runLsCommand(command: Extract<RemoteRunCommand, { kind: 'ls' }>, context: CommandContext): Promise<number> {
  const { io } = context;
  const slugFilter = command.isAll ? null : getProjectContext(io.cwd).slug;
  const clients = context.config.runners.map((runner) => createRunnerClient(runner, context.cacheDir, context.script));
  const results = await Promise.all(clients.map(async (client) => {
    try {
      return { client, entries: await listRunnerJobs(client, slugFilter), problem: null };
    } catch (error) {
      const problem = error instanceof RunnerUnreachableError ? `unreachable (${error.reason})` : error instanceof Error ? error.message : 'failed';
      return { client, entries: [] as JobEntry[], problem };
    }
  }));
  for (const result of results) {
    if (result.problem !== null) sayOwn(io, `runner ${result.client.runner.name}: ${result.problem}`);
  }
  const lines = formatJobList(results.flatMap((result) => result.entries), context.now());
  if (lines.length === 0) sayOwn(io, command.isAll ? 'no jobs' : 'no jobs of this project');
  else io.stdout(`${lines.join('\n')}\n`);
  return 0;
}

export async function runStatusCommand(command: Extract<RemoteRunCommand, { kind: 'status' }>, context: CommandContext): Promise<number> {
  const client = await openJobClient(context, command.jobId);
  const meta = parseJobMeta(await client.callOrThrow('meta', ['-', command.jobId]));
  if (meta === null) throw new RemoteRunError(`job ${command.jobId} has no readable description on ${client.runner.name} (pruned?)`);
  const { facts, outcome } = await readJobOutcome(client, '-', command.jobId);
  context.io.stdout(`${formatJobStatus({ meta, facts, outcome }, context.now())}\n`);
  return 0;
}

// ─────────────────────────── logs ───────────────────────────

export async function runLogsCommand(command: Extract<RemoteRunCommand, { kind: 'logs' }>, context: CommandContext): Promise<number> {
  const { io } = context;
  const client = await openJobClient(context, command.jobId);
  if (!command.isFollow) {
    const log = await client.callOrThrow('tail', ['-', command.jobId, command.tail === null ? 'all' : `${command.tail}`]);
    const router = createJobOutputRouter(io);
    router.write(log);
    router.flush();
    return 0;
  }
  const child = client.stream('follow', ['-', command.jobId, command.tail === null ? 'start' : `tail:${command.tail}`]);
  const router = createJobOutputRouter(io);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => router.write(chunk));
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  child.stdin.end();
  let interrupt: InterruptSignal | null = null;
  const removeHandler = addInterruptHandler((signal) => {
    interrupt ??= signal;
    child.kill('SIGTERM');
  });
  const exitCode = await waitForChildEnd(child, () => interrupt !== null);
  removeHandler();
  router.flush();
  // Following is not owning: the job is left as it is.
  if (interrupt !== null) return planInterrupt(interrupt).exitCode;
  if (exitCode !== 0) throw new RemoteRunError(`following the log of ${command.jobId} failed — ${stderr.trim().split('\n').pop() || `exit ${exitCode}`}`);
  return 0;
}

// ─────────────────────────── wait / fetch / kill ───────────────────────────

export interface WaitRetryPolicy {
  attempts: number;
  delayMs: number;
}

/**
 * @description Block until the runner says the job is done. A connection that drops is opened again a few times (the job is Pueue's, it
 * keeps running); a refusal of the runner itself — no such job (never submitted, pruned, a submit that failed half-way) — is final and
 * says so at once instead of passing for a bad network. Resolves with the signal that interrupted the wait, if one did.
 */
export async function waitForJob(client: RunnerClient, jobId: string, retry: WaitRetryPolicy = { attempts: waitReconnectAttempts, delayMs: waitReconnectDelayMs }): Promise<InterruptSignal | null> {
  let interrupt: InterruptSignal | null = null;
  for (let attempt = 1; attempt <= retry.attempts && interrupt === null; attempt += 1) {
    const child = client.stream('wait', ['-', jobId]);
    child.stdin.end();
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    const removeHandler = addInterruptHandler((signal) => {
      interrupt ??= signal;
      child.kill('SIGTERM');
    });
    const exitCode = await waitForChildEnd(child, () => interrupt !== null);
    removeHandler();
    if (exitCode === 0 || interrupt !== null) return interrupt;
    if (!checkIsConnectionLost(exitCode)) throw new RemoteRunError(`runner "${client.runner.name}": ${describeRunnerRefusal(stderr, `wait ended with exit ${exitCode}`)}`);
    if (attempt === retry.attempts) throw new RemoteRunError(`lost the connection to ${client.runner.name} while waiting for ${jobId}`);
    await new Promise((resolve) => setTimeout(resolve, retry.delayMs));
  }
  return interrupt;
}

export async function runWaitCommand(command: Extract<RemoteRunCommand, { kind: 'wait' }>, context: CommandContext): Promise<number> {
  const { io } = context;
  const client = await openJobClient(context, command.jobId);
  const interrupt = await waitForJob(client, command.jobId);
  if (interrupt !== null) return planInterrupt(interrupt).exitCode;
  const { facts, outcome } = await readJobOutcome(client, '-', command.jobId);
  const log = await client.callOrThrow('tail', ['-', command.jobId, `${waitTailLines}`]);
  const router = createJobOutputRouter(io);
  router.write(log);
  router.flush();
  try {
    await fetchJobFiles({ client, facts, jobId: command.jobId, target: resolveFetchTarget(readLocalJobRecord(context.cacheDir, command.jobId)), io });
  } catch (error) {
    sayOwn(io, error instanceof RemoteRunError ? error.message : 'the result files could not be fetched');
  }
  return describeEnd(outcome, command.jobId, io);
}

export async function runFetchCommand(command: Extract<RemoteRunCommand, { kind: 'fetch' }>, context: CommandContext): Promise<number> {
  const client = await openJobClient(context, command.jobId);
  const { facts, outcome } = await readJobOutcome(client, '-', command.jobId);
  if (outcome.state !== 'done') throw new RemoteRunError(`job ${command.jobId} has not finished yet (${outcome.state}) — \`charness remote-run wait ${command.jobId}\` waits for it`);
  if (!facts.isWithArtifacts) sayOwn(context.io, 'the job left no result files');
  await fetchJobFiles({ client, facts, jobId: command.jobId, target: resolveFetchTarget(readLocalJobRecord(context.cacheDir, command.jobId)), io: context.io });
  return 0;
}

export async function runKillCommand(command: Extract<RemoteRunCommand, { kind: 'kill' }>, context: CommandContext): Promise<number> {
  const client = await openJobClient(context, command.jobId);
  const result = await client.call('kill', ['-', command.jobId], { timeoutMs: killCallTimeoutMs });
  if (result.exitCode !== 0) throw new RemoteRunError(`killing ${command.jobId} failed — ${result.stderr.trim().split('\n').pop() || `exit ${result.exitCode}`}`);
  sayOwn(context.io, `job ${command.jobId} killed`);
  return 0;
}

// ─────────────────────────── exec ───────────────────────────

export async function runExecCommand(command: Extract<RemoteRunCommand, { kind: 'exec' }>, context: CommandContext): Promise<number> {
  const project = getProjectContext(context.io.cwd);
  const client = await chooseClient(context, { runner: command.runner, needs: null });
  return runExec({ client, slug: project.slug, subfolder: project.subfolder, command: command.command, io: context.io, leaseMs: context.leaseMs });
}
