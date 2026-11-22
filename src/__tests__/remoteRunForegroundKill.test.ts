/**
 * @description A foreground run that is interrupted kills its job over a `kill` call (`foreground.ts`). A call that does not kill - the runner refuses it («Pueue did not answer…» for a queued job it could not look up)
 * or the connection is gone - is SAID, with what the runner answered, and that the runner's own lease watcher stops the job now that the lease is gone: the run used to swallow the result and leave the user
 * thinking the job was stopped. The heartbeat that keeps the runner's lease watcher from ending the job first goes on while the `kill` call is in flight, so a
 * limit that ran out is recorded as the limit (124) and not as a kill (137) when that call is slow on a loaded runner. The run is driven with a fake ssh child and a fake runner client; the runner's side of the retry is `remoteRunRunnerScriptStashWaiting.test.ts`,
 * the whole thing against a real runner `remoteRunLifecycleLimitsE2e.test.ts`.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { createFetchTarget } from '../remoteRun/jobFiles';
import { describeFailedKill, followForeground } from '../remoteRun/foreground';
import type { RunnerClient } from '../remoteRun/runnerClient';
import type { SshRunResult } from '../remoteRun/ssh';

const jobId = 'box1-aaaaaa';
const refusal = 'remote-run-runner: Pueue did not answer, so the task of job box1-aaaaaa could not be told from another job\'s: nothing was killed';

/** A client whose lease session is a real process (a `sleep`: it takes the heartbeat on stdin like the ssh child) that the runner's answer to the `kill` call ends. */
function createFakeClient(killResult: SshRunResult, killCalls: string[][]): RunnerClient {
  const child = spawn('sleep', ['60'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const refuse = async (): Promise<never> => { throw new Error('not used by a foreground run'); };
  return {
    runner: { name: 'mac', ssh: 'user@mac', workDir: '/work' },
    cacheDir: '/nonexistent-cache',
    rsyncSshCommand: 'ssh',
    ensureScript: async () => undefined,
    getAbsoluteWorkDir: async () => '/work',
    call: async (subcommand, args) => {
      killCalls.push([subcommand, ...args]);
      // The lease session ends once the runner has dealt with the kill.
      child.kill('SIGKILL');
      return killResult;
    },
    callOrThrow: refuse,
    stream: () => child,
  };
}

const listeners = { SIGINT: process.listeners('SIGINT') };
afterEach(() => {
  for (const listener of process.listeners('SIGINT')) {
    if (!listeners.SIGINT.includes(listener)) process.off('SIGINT', listener);
  }
});

async function interruptRun(killResult: SshRunResult): Promise<{ exitCode: number; said: string; killCalls: string[][] }> {
  const killCalls: string[][] = [];
  const said: string[] = [];
  const client = createFakeClient(killResult, killCalls);
  const running = followForeground({
    client,
    staged: { jobId, slug: 'app-aaaaaaaaaa', group: 'default', timeoutSeconds: 3600, workDir: '/work' },
    target: createFetchTarget('/nonexistent-project', 'app-aaaaaaaaaa', []),
    io: { stdout: () => undefined, stderr: (text) => { said.push(text); }, cwd: '/', env: {}, homeDir: '/' },
    leaseMs: 45_000,
  });
  setImmediate(() => process.emit('SIGINT', 'SIGINT'));
  const exitCode = await running;
  return { exitCode, said: said.join(''), killCalls };
}

/** The lease and the call of the heartbeat tests: a beat every 100 ms, a `kill` call that takes six beats' worth, far longer than one lease would allow without them. */
const slowKillLeaseMs = 900;
const slowKillCallMs = 600;
const minBeatsDuringSlowKill = 4;
/** How long after a refused call the test looks for beats that should have stopped: several beat intervals. */
const afterRefusedKillMs = 400;

/** What a slow `kill` call answers at its end: the job was killed, or the runner refused (the lease session is then left running for the test to look at). */
type SlowKillAnswer = 'killed' | 'refused';

interface SlowKillRun {
  /** Heartbeat bytes that reached the lease session while the `kill` call was in flight. */
  beatsDuringKill: number;
  /** Heartbeat bytes that came after a refused call, within {@link afterRefusedKillMs}. */
  beatsAfterRefusedKill: number;
  exitCode: number;
}

async function runWithSlowKill(answer: SlowKillAnswer): Promise<SlowKillRun> {
  // `cat` hands every heartbeat byte back on its stdout, where the test counts it; the runner's answer ends it, like the real lease session.
  const child = spawn('cat', [], { stdio: ['pipe', 'pipe', 'pipe'] });
  let beats = 0;
  // `followForeground` sets the encoding, so a chunk is a string of one byte per beat.
  child.stdout.on('data', (chunk: string) => { beats += Buffer.byteLength(chunk); });
  let beatsDuringKill = -1;
  let beatsAfterRefusedKill = -1;
  const client: RunnerClient = {
    runner: { name: 'mac', ssh: 'user@mac', workDir: '/work' },
    cacheDir: '/nonexistent-cache',
    rsyncSshCommand: 'ssh',
    ensureScript: async () => undefined,
    getAbsoluteWorkDir: async () => '/work',
    call: async () => {
      const beatsAtStart = beats;
      await new Promise((resolve) => setTimeout(resolve, slowKillCallMs));
      beatsDuringKill = beats - beatsAtStart;
      if (answer === 'refused') {
        // The runner refuses with the lease session still alive: once the call is over, only the kill itself can have stopped the beat.
        setTimeout(() => {
          beatsAfterRefusedKill = beats - beatsAtStart - beatsDuringKill;
          child.kill('SIGKILL');
        }, afterRefusedKillMs);
        return { exitCode: 125, stdout: '', stderr: `${refusal}\n`, isTimedOut: false };
      }
      child.kill('SIGKILL');
      return { exitCode: 0, stdout: 'killed\n', stderr: '', isTimedOut: false };
    },
    callOrThrow: async (): Promise<never> => { throw new Error('not used by a foreground run'); },
    stream: () => child,
  };
  const running = followForeground({
    client,
    staged: { jobId, slug: 'app-aaaaaaaaaa', group: 'default', timeoutSeconds: 3600, workDir: '/work' },
    target: createFetchTarget('/nonexistent-project', 'app-aaaaaaaaaa', []),
    io: { stdout: () => undefined, stderr: () => undefined, cwd: '/', env: {}, homeDir: '/' },
    leaseMs: slowKillLeaseMs,
  });
  setImmediate(() => process.emit('SIGINT', 'SIGINT'));
  const exitCode = await running;
  return { beatsDuringKill, beatsAfterRefusedKill, exitCode };
}

describe('a foreground run that is interrupted', () => {
  it('keeps beating while the kill call is in flight: a slow call must not let the runner\'s lease watcher end the job first', async () => {
    const run = await runWithSlowKill('killed');
    assert.ok(run.beatsDuringKill >= minBeatsDuringSlowKill, `beats during the call: ${run.beatsDuringKill}`);
    assert.equal(run.exitCode, 130);
  });

  it('stops beating once the kill call is answered, a refusal too — the runner\'s lease watcher takes the job from there', async () => {
    const run = await runWithSlowKill('refused');
    assert.ok(run.beatsDuringKill >= minBeatsDuringSlowKill, `beats during the call: ${run.beatsDuringKill}`);
    assert.equal(run.beatsAfterRefusedKill, 0, 'no beat after the call was answered');
  });

  it('says the kill that did not kill - the runner\'s own words, and that its watcher stops the job now that the lease is gone', async () => {
    const outcome = await interruptRun({ exitCode: 125, stdout: '', stderr: `${refusal}\n`, isTimedOut: false });
    assert.deepEqual(outcome.killCalls[0].slice(0, 3), ['kill', 'app-aaaaaaaaaa', jobId]);
    assert.match(outcome.said, /remote-run: killing job box1-aaaaaa on mac failed \(Pueue did not answer, so the task of job box1-aaaaaa could not be told from another job's: nothing was killed\) — the runner stops it itself now that this lease is gone, and keeps trying until it can\n/);
    assert.equal(outcome.exitCode, 130, 'the interrupt still ends the run with its own code');
  });

  it('a connection that was gone says what ssh said instead', async () => {
    const outcome = await interruptRun({ exitCode: 255, stdout: '', stderr: 'ssh: connect to host mac port 22: Connection refused\n', isTimedOut: false });
    assert.match(outcome.said, /killing job box1-aaaaaa on mac failed \(ssh: connect to host mac port 22: Connection refused\)/);
  });

  it('a kill that worked says nothing of the kind', async () => {
    const outcome = await interruptRun({ exitCode: 0, stdout: 'killed\n', stderr: '', isTimedOut: false });
    assert.doesNotMatch(outcome.said, /failed/);
    assert.match(outcome.said, /interrupted — job box1-aaaaaa was stopped on mac/);
  });

  it('the line for a failed kill is built from the runner\'s refusal, or the ssh failure when it said nothing', () => {
    assert.match(describeFailedKill(jobId, 'mac', { exitCode: 125, stdout: '', stderr: `${refusal}\n`, isTimedOut: false }), /\(Pueue did not answer/);
    assert.match(describeFailedKill(jobId, 'mac', { exitCode: null, stdout: '', stderr: '', isTimedOut: true }), /\(ssh: the command ran past its deadline\)/);
  });
});
