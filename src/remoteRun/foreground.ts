import { killGraceSeconds, planInterrupt, remoteRunExitCodes, type InterruptSignal } from './exitCodes';
import { addInterruptHandler, killCallTimeoutMs, waitForChildEnd } from './interrupts';
import { fetchJobFiles, markJobFetched, type FetchTarget } from './jobFiles';
import { readJobOutcome } from './jobQuery';
import { getHeartbeatIntervalMs } from './leaseTiming';
import { createExitMarkerFilter, createJobOutputRouter, sayOwn, type CliIo } from './output';
import { RemoteRunError } from './remoteRunError';
import { describeRunnerRefusal, type RunnerClient } from './runnerClient';
import { checkIsConnectionLost } from './ssh';
import type { StagedJob } from './submit';
import type { JobOutcome } from './jobState';

/**
 * @description A foreground run and `exec`: the live ssh session that owns a job. The session runs the runner script's `lease`, which
 * itself adds the job to Pueue (so no job ever exists without its lease), streams the job's log, and kills the job when the heartbeat
 * byte this side writes stops (a SIGKILLed remote-run, a dead connection — a stock sshd never notices a half-open one). SIGINT, SIGTERM
 * and SIGHUP kill the whole remote job over the shared connection first (TERM, SIGKILL after 10 s on the runner), then exit with the
 * shell's code for the signal; the local `--timeout` does the same and exits 124.
 */

/**
 * @description Why a run that owns a job stopped it, for the interrupt that ended it: the user's own signal needs no cause, a closed stdout
 * does — the job is killed with nobody at the terminal to see it. It also says how to look at a part of a long output without that.
 */
export function describeInterruptCause(signal: InterruptSignal, stoppedThing: string, runnerName: string, logsHint: string): string {
  if (signal !== 'SIGPIPE') return `interrupted — ${stoppedThing} was stopped on ${runnerName}`;
  return `stdout was closed (what reads it, a pipe into \`head\` for one, is gone) — ${stoppedThing} was stopped on ${runnerName}; to read only a part of a long output, start it with --bg and use ${logsHint}`;
}

/** The reason `runner.sh kill` takes for a kill that is the caller's time limit running out. */
const killReasonTimeout = 'timeout';

/** After a kill or an interrupt the lease session ends by itself (the runner's grace time, and as long again); this long before the ssh process is cut. */
const streamEndGraceMs = 2 * killGraceSeconds * 1000;

/**
 * @description Say why a job ended the way it did (when it is not simply its command's own code) and return remote-run's exit code for it.
 * `runnerStderr` is what the runner script wrote on the session that ran the job: a job it refused at once (`pueue add` failed) has no
 * state to show, and that last line is the only thing that says why.
 */
export function describeEnd(outcome: JobOutcome, jobId: string, io: Pick<CliIo, 'stderr'>, runnerStderr = ''): number {
  if (outcome.state !== 'done') {
    const runnerSaid = describeRunnerRefusal(runnerStderr, '');
    if (runnerSaid !== '') sayOwn(io, `the runner said: ${runnerSaid}`);
    sayOwn(io, `the state of job ${jobId} is unknown (${outcome.state}) — see \`charness remote-run status ${jobId}\``);
    return remoteRunExitCodes.failed;
  }
  if (outcome.reason === 'deps-failed') sayOwn(io, 'the dependencies step failed — its output is above');
  else if (outcome.reason === 'timeout') sayOwn(io, 'the job timed out and was killed');
  else if (outcome.reason === 'killed') sayOwn(io, `job ${jobId} was killed`);
  else if (outcome.reason === 'lost') sayOwn(io, `job ${jobId} ended without a result (its process was lost)`);
  return outcome.code;
}

/** @description Follow a staged job in the foreground; resolves with remote-run's exit code. */
export async function followForeground(params: {
  client: RunnerClient;
  staged: StagedJob;
  target: FetchTarget;
  io: CliIo;
  leaseMs: number;
}): Promise<number> {
  const { client, staged, io } = params;
  const child = client.stream('lease', [staged.slug, staged.jobId, staged.group, `${params.leaseMs}`]);
  const router = createJobOutputRouter(io);
  let sshStderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => router.write(chunk));
  child.stderr.on('data', (chunk: string) => { sshStderr += chunk; });
  child.stdin.on('error', () => { /* the session ended: nothing to beat for */ });
  let interrupt: InterruptSignal | null = null;
  let isTimedOut = false;
  let killing: Promise<void> | null = null;
  const closed = waitForChildEnd(child, () => killing !== null);
  const writeHeartbeat = (): void => {
    child.stdin.write('h');
  };
  writeHeartbeat();
  const heartbeatTimer = setInterval(writeHeartbeat, getHeartbeatIntervalMs(params.leaseMs));

  const killJob = (): Promise<void> => {
    killing ??= (async () => {
      clearInterval(heartbeatTimer);
      // A kill because the limit ran out is recorded as the limit (124), as the runner's own watchdog records it when it gets there first.
      await client.call('kill', [staged.slug, staged.jobId, ...(isTimedOut ? [killReasonTimeout] : [])], { timeoutMs: killCallTimeoutMs });
      setTimeout(() => child.kill('SIGKILL'), streamEndGraceMs).unref();
    })();
    return killing;
  };
  const removeSignalHandlers = addInterruptHandler((signal) => {
    interrupt ??= signal;
    void killJob();
  });
  const timeoutTimer = setTimeout(() => {
    isTimedOut = true;
    void killJob();
  }, staged.timeoutSeconds * 1000);

  await closed;
  clearInterval(heartbeatTimer);
  clearTimeout(timeoutTimer);
  removeSignalHandlers();
  router.flush();
  if (killing !== null) await killing;

  if (interrupt !== null) {
    sayOwn(io, describeInterruptCause(interrupt, `job ${staged.jobId}`, client.runner.name, `\`charness remote-run logs ${staged.jobId} --tail <lines>\``));
    return planInterrupt(interrupt).exitCode;
  }
  let result: Awaited<ReturnType<typeof readJobOutcome>>;
  try {
    result = await readJobOutcome(client, staged.slug, staged.jobId);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'no answer';
    sayOwn(io, `lost the connection to ${client.runner.name} (${sshStderr.trim().split('\n').pop() || detail}); the runner stops job ${staged.jobId} itself when its lease runs out`);
    return remoteRunExitCodes.failed;
  }
  try {
    await fetchJobFiles({ client, facts: result.facts, jobId: staged.jobId, target: params.target, io });
    await markJobFetched(client, staged.jobId);
  } catch (error) {
    sayOwn(io, error instanceof RemoteRunError ? error.message : 'the result files could not be fetched');
  }
  if (isTimedOut) {
    sayOwn(io, `timed out after ${staged.timeoutSeconds}s — job ${staged.jobId} was killed`);
    return remoteRunExitCodes.timedOut;
  }
  return describeEnd(result.outcome, staged.jobId, io, sshStderr);
}

/** @description Run a one-off command in the runner's copy under the same lease; resolves with the command's exit code. */
export async function runExec(params: { client: RunnerClient; slug: string; subfolder: string; command: string; io: CliIo; leaseMs: number }): Promise<number> {
  const { client, io } = params;
  const child = client.stream('exec', [params.slug, params.subfolder, `${params.leaseMs}`, params.command]);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => io.stdout(chunk));
  const stderr = createExitMarkerFilter(io.stderr);
  child.stderr.on('data', (chunk: string) => stderr.write(chunk));
  child.stdin.on('error', () => { /* the session ended */ });
  let interrupt: InterruptSignal | null = null;
  const closed = waitForChildEnd(child, () => interrupt !== null);
  const writeHeartbeat = (): void => {
    child.stdin.write('h');
  };
  writeHeartbeat();
  const heartbeatTimer = setInterval(writeHeartbeat, getHeartbeatIntervalMs(params.leaseMs));
  const removeSignalHandlers = addInterruptHandler((signal) => {
    interrupt ??= signal;
    clearInterval(heartbeatTimer);
    // The end of the stream without a "done" byte is what makes the runner kill the command's group.
    child.stdin.end();
    setTimeout(() => child.kill('SIGKILL'), streamEndGraceMs).unref();
  });
  const exitCode = await closed;
  clearInterval(heartbeatTimer);
  removeSignalHandlers();
  stderr.flush();
  if (interrupt !== null) {
    if (interrupt === 'SIGPIPE') sayOwn(io, describeInterruptCause(interrupt, 'the command', client.runner.name, 'a job (`--bg`, then `logs <id> --tail <lines>`)'));
    return planInterrupt(interrupt).exitCode;
  }
  // The command's own code, as the runner reported it: a command that exits 255 is not a lost connection. Without the report the session
  // died before the command ended, or ssh itself failed.
  const reportedCode = stderr.getExitCode();
  if (reportedCode !== null) return reportedCode;
  if (checkIsConnectionLost(exitCode)) {
    sayOwn(io, `the connection to ${client.runner.name} failed while the command ran`);
    return remoteRunExitCodes.failed;
  }
  return exitCode ?? remoteRunExitCodes.failed;
}
