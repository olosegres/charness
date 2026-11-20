/**
 * @description What the files of the `charness remote-run` lifecycle flow (`remoteRunLifecycle*E2e.test.ts`) share besides the harness: the
 * wrapper that gives each file a runner of its own (a throwaway loopback `sshd` and a private Pueue, set up before and torn down after
 * its steps; skipped with the reason where the tools are missing) and the limit of the decoy jobs. Matches neither runner glob.
 */

import { after, before, describe } from 'node:test';
import { setUpFlow, skipReason, tearDownFlow } from './remoteRunFlowHarness';

/**
 * The `--timeout` of the decoy jobs that must write their pids before it runs out. The limit counts from the moment the job is
 * queued (staging included), so a limit of 3 s was enough for an idle machine and not for a loaded one, where the decoy was cut
 * before it ever wrote its pid file and the test timed out waiting for it.
 */
export const decoyLimitSeconds = 20;

/** One file of the lifecycle flow: `defineSteps` declares its sub-suites inside a describe whose runner is set up and torn down around them. */
export function describeLifecycleFlowPart(partTitle: string, defineSteps: () => void): void {
  describe(`charness remote-run against a loopback runner — what ends a job: ${partTitle}`, { skip: skipReason }, () => {
    before(setUpFlow);
    after(tearDownFlow);
    defineSteps();
  });
}
