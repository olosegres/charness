/**
 * @description A foreground run that is interrupted kills its job over a `kill` call (`foreground.ts`). A call that does not kill - the runner refuses it («Pueue did not answer…» for a queued job it could not look up)
 * or the connection is gone - is SAID, with what the runner answered, and that the runner's own lease watcher stops the job now that the lease is gone: the run used to swallow the result and leave the user
 * thinking the job was stopped. The run is driven with a fake ssh child and a fake runner client; the runner's side of the retry is `remoteRunRunnerScriptStashWaiting.test.ts`.
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

describe('a foreground run that is interrupted', () => {
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
