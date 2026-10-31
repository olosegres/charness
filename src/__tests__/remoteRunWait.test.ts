/**
 * @description `remoteRun/commands.ts waitForJob`: when a `wait` is worth opening the connection again for. Only a CONNECTION that
 * failed is (ssh's own status 255, or a killed process); a refusal of the runner itself — «no such job» for an id never submitted, pruned,
 * or whose submit failed half-way — is final, and says so at once instead of retrying five times and then blaming the network. The
 * ssh session is a real short-lived process per attempt, so exit codes and stderr are the real thing.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { waitForJob } from '../remoteRun/commands';
import { RemoteRunError } from '../remoteRun/remoteRunError';
import type { RunnerClient } from '../remoteRun/runnerClient';
import { checkIsConnectionLost, sshFailureExitCode } from '../remoteRun/ssh';

const jobId = 'box1-abc234';
const quickRetry = { attempts: 4, delayMs: 5 };

/** A client whose `wait` ssh session is `script` run by bash, once per attempt; `attempts` counts the sessions opened. */
function createClientWhoseWaitRuns(scripts: readonly string[]): { client: RunnerClient; attempts: () => number } {
  let opened = 0;
  const refuse = (): never => {
    throw new Error('not used by wait');
  };
  const client: RunnerClient = {
    runner: { name: 'box1', ssh: 'u@box1.example', workDir: '/w' },
    cacheDir: '/unused',
    rsyncSshCommand: 'ssh',
    ensureScript: async () => {},
    getAbsoluteWorkDir: refuse,
    call: refuse,
    callOrThrow: refuse,
    stream: () => {
      const script = scripts[Math.min(opened, scripts.length - 1)];
      opened += 1;
      return spawn('bash', ['-c', script], { stdio: ['pipe', 'pipe', 'pipe'] });
    },
  };
  return { client, attempts: () => opened };
}

describe('checkIsConnectionLost', () => {
  it('ssh\'s own failure status and a killed process are lost connections; a command\'s status of its own is not', () => {
    assert.equal(checkIsConnectionLost(sshFailureExitCode), true);
    assert.equal(checkIsConnectionLost(null), true);
    for (const exitCode of [0, 1, 2, 124, 125, 137, 143]) assert.equal(checkIsConnectionLost(exitCode), false, `${exitCode}`);
  });
});

describe('waitForJob', () => {
  it('a job that ends: resolves at once, one session', async () => {
    const { client, attempts } = createClientWhoseWaitRuns(['echo done']);
    assert.equal(await waitForJob(client, jobId, quickRetry), null);
    assert.equal(attempts(), 1);
  });

  it('«no such job» from the runner is final: ONE session, the runner\'s own words, nothing about the network', async () => {
    const { client, attempts } = createClientWhoseWaitRuns([`echo 'remote-run-runner: no such job: ${jobId}' >&2; exit 125`]);
    await assert.rejects(waitForJob(client, jobId, quickRetry), (error: Error) => {
      assert.ok(error instanceof RemoteRunError);
      assert.equal(error.message, `runner "box1": no such job: ${jobId}`);
      assert.ok(!error.message.includes('lost the connection'));
      return true;
    });
    assert.equal(attempts(), 1, 'a refusal is not retried');
  });

  it('a refusal without any words still names the exit status', async () => {
    const { client } = createClientWhoseWaitRuns(['exit 7']);
    await assert.rejects(waitForJob(client, jobId, quickRetry), (error: Error) => error.message === 'runner "box1": wait ended with exit 7');
  });

  it('a dropped connection (ssh\'s 255) is opened again, and a wait that then succeeds resolves', async () => {
    const { client, attempts } = createClientWhoseWaitRuns(['exit 255', 'exit 255', 'echo done']);
    assert.equal(await waitForJob(client, jobId, quickRetry), null);
    assert.equal(attempts(), 3);
  });

  it('a connection that keeps dropping gives up after the attempts it was allowed, and says the connection was lost', async () => {
    const { client, attempts } = createClientWhoseWaitRuns(['exit 255']);
    await assert.rejects(waitForJob(client, jobId, quickRetry), (error: Error) => error.message === `lost the connection to box1 while waiting for ${jobId}`);
    assert.equal(attempts(), quickRetry.attempts);
  });

  it('a session killed by a signal counts as a lost connection', async () => {
    const { client, attempts } = createClientWhoseWaitRuns(['kill -9 $$', 'echo done']);
    assert.equal(await waitForJob(client, jobId, quickRetry), null);
    assert.equal(attempts(), 2);
  });
});
