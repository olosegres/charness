/**
 * @description A flow's time budget is the per-file limit its runner imposes (`--test-timeout`) less the teardown's
 * reserve — one number, taken from the process's own arguments — and a wait still running when it ends fails with the
 * flow's own diagnostic (the wait it was, charness's output tail) instead of leaving the runner's bare "timed out
 * after Nms" to report it (`e2e/isolatedCharness.ts`).
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  createIsolatedInstanceLayout,
  flowTeardownReserveMs,
  getFlowDeadlineMs,
  getTestFileTimeoutMs,
  IsolatedCharness,
  removeIsolatedInstanceSync,
  writeInstanceEnvFile,
} from './e2e/isolatedCharness';
import { checkIsPidAlive } from '../utils/jsonStreamHost';

const fileTimeoutMs = 20 * 60 * 1000;
const processStartMs = 1_700_000_000_000;
/** A budget that ends while a wait of a minute is still running. */
const shortBudgetMs = 300;
const longWaitMs = 60 * 1000;
const shortWaitMs = 300;
/** Far below the long wait: the failure came from the budget, not from the wait running out. */
const promptFailureMs = 5 * 1000;
const outputTail = 'boot line\nthe last line charness printed';
/** Far longer than the test: only the harness's kill can end it in time. */
const neverReadySleepSeconds = 600;
/** Ample for the shell to write its pid first, even on a loaded box. */
const neverReadyStartTimeoutMs = 3 * 1000;

describe('getTestFileTimeoutMs', () => {
  it('reads the flag in its `=` spelling, among the other arguments of the process', () => {
    assert.equal(getTestFileTimeoutMs(['--import', 'tsx', `--test-timeout=${fileTimeoutMs}`]), fileTimeoutMs);
  });

  it('reads the flag in its two-argument spelling', () => {
    assert.equal(getTestFileTimeoutMs(['--test-timeout', `${fileTimeoutMs}`]), fileTimeoutMs);
  });

  it('takes the last of a repeated flag, the one Node enforces', () => {
    assert.equal(getTestFileTimeoutMs([`--test-timeout=${fileTimeoutMs}`, '--test-timeout', `${shortBudgetMs}`]), shortBudgetMs);
    assert.equal(getTestFileTimeoutMs([`--test-timeout=${shortBudgetMs}`, `--test-timeout=${fileTimeoutMs}`]), fileTimeoutMs);
  });

  it('is null when the arguments carry no limit, or one that is no limit', () => {
    assert.equal(getTestFileTimeoutMs([]), null);
    assert.equal(getTestFileTimeoutMs(['--import', 'tsx']), null);
    assert.equal(getTestFileTimeoutMs(['--test-timeout']), null);
    assert.equal(getTestFileTimeoutMs(['--test-timeout=abc']), null);
    assert.equal(getTestFileTimeoutMs(['--test-timeout=0']), null);
    assert.equal(getTestFileTimeoutMs(['--test-timeout=Infinity']), null);
  });
});

describe('getFlowDeadlineMs', () => {
  it('ends the budget a teardown reserve before the file limit, counted from the start of the process', () => {
    assert.equal(getFlowDeadlineMs([`--test-timeout=${fileTimeoutMs}`], processStartMs), processStartMs + fileTimeoutMs - flowTeardownReserveMs);
  });

  it('never ends before the process started, whatever the limit', () => {
    assert.equal(getFlowDeadlineMs([`--test-timeout=${flowTeardownReserveMs / 2}`], processStartMs), processStartMs);
  });

  it('refuses a process with no file limit, and says how to give it one', () => {
    assert.throws(() => getFlowDeadlineMs(['--import', 'tsx'], processStartMs), /yarn test:flows.*--test-timeout=<ms>/);
  });
});

describe('IsolatedCharness.waitFor under a flow budget', () => {
  const layout = createIsolatedInstanceLayout('charness-budgettest-', []);
  after(() => removeIsolatedInstanceSync(layout, null));

  function createCharnessWithOutput(): IsolatedCharness {
    const charness = new IsolatedCharness(layout);
    charness.output = outputTail;
    return charness;
  }

  it('a wait still running when the budget ends fails at once, naming the wait and quoting charness\'s output tail', async () => {
    layout.flowDeadlineMs = Date.now() + shortBudgetMs;
    const startedAt = Date.now();
    await assert.rejects(
      createCharnessWithOutput().waitFor('the agent\'s answer', longWaitMs, () => false),
      (error: Error) => {
        assert.match(error.message, /^the flow's time budget is spent while waiting for the agent's answer; charness output tail:\n/);
        assert.ok(error.message.endsWith(outputTail), 'the tail is quoted');
        return true;
      },
    );
    assert.ok(Date.now() - startedAt < promptFailureMs, 'it did not wait out its own minute');
  });

  it('a wait that runs out before the budget keeps its own message', async () => {
    layout.flowDeadlineMs = Date.now() + longWaitMs;
    await assert.rejects(
      createCharnessWithOutput().waitFor('the agent\'s answer', shortWaitMs, () => false),
      (error: Error) => {
        assert.match(error.message, /^timed out waiting for the agent's answer; charness output tail:\n/);
        assert.ok(error.message.endsWith(outputTail), 'the tail is quoted');
        return true;
      },
    );
  });

  it('a layout outside a flow has no budget: only the wait\'s own limit applies', async () => {
    layout.flowDeadlineMs = null;
    await assert.rejects(
      createCharnessWithOutput().waitFor('the agent\'s answer', shortWaitMs, () => false),
      /^Error: timed out waiting for the agent's answer; charness output tail:\n/,
    );
  });

  it('a condition that already holds passes even after the budget has ended', async () => {
    layout.flowDeadlineMs = Date.now() - 1;
    await createCharnessWithOutput().waitFor('the agent\'s answer', longWaitMs, () => true);
  });
});

describe('IsolatedCharness.start that never becomes ready', () => {
  const layout = createIsolatedInstanceLayout('charness-starttest-', []);
  after(() => removeIsolatedInstanceSync(layout, null));

  it('ends the process it started before failing, so the flow\'s next start does not find the instance still running', async () => {
    writeInstanceEnvFile(layout, {});
    const pidFile = path.join(layout.testRoot, 'started.pid');
    // Stands in for a bot that boots too slowly: it writes its pid and never prints a ready line.
    const charness = new IsolatedCharness(layout, { launch: { file: '/bin/sh', args: ['-c', `echo $$ > '${pidFile}'; exec sleep ${neverReadySleepSeconds}`] } });
    layout.flowDeadlineMs = null;
    await assert.rejects(charness.start(neverReadyStartTimeoutMs, () => false), /^Error: timed out waiting for charness to be ready/);
    const startedPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    assert.ok(startedPid > 0, 'precondition: the process wrote its pid');
    assert.equal(checkIsPidAlive(startedPid), false, 'the process that never became ready is gone, and its exit is reaped');
  });
});

