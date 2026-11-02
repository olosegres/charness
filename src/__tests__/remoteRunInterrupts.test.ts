/**
 * @description The interrupt handling of `remote-run` that gets time to clean up (`remoteRun/interrupts.ts`): the first interrupt goes to the
 * command, a SECOND one ends the process at once with the code of the first — so a call that does not stop can never swallow Ctrl-C. The
 * policy is tested with a fake `exit`; the production wiring (`addInterruptHandlerWithHardStop`: real signals, `process.exit`) in a real process.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { InterruptSignal } from '../remoteRun/exitCodes';
import { createHardStopHandler } from '../remoteRun/interrupts';

const repoRoot = path.resolve(__dirname, '..', '..');
const processBoundMs = 30_000;

describe('the hard stop of a second interrupt (policy)', () => {
  it('the first interrupt is the command\'s to handle; the second ends the process with the code of the FIRST, and so does every later one', () => {
    const interrupts: InterruptSignal[] = [];
    const exits: number[] = [];
    const handler = createHardStopHandler((signal) => interrupts.push(signal), (exitCode) => exits.push(exitCode));
    handler('SIGTERM');
    assert.deepEqual([interrupts, exits], [['SIGTERM'], []], 'the first one only reaches the command');
    handler('SIGINT');
    handler('SIGHUP');
    assert.deepEqual(interrupts, ['SIGTERM'], 'the command hears the first one only');
    assert.deepEqual(exits, [143, 143], 'SIGTERM was the first: its code, whatever came after');
  });

  it('each signal\'s own code when it is the first: 130 / 143 / 129', () => {
    for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const) {
      const exits: number[] = [];
      const handler = createHardStopHandler(() => undefined, (code) => exits.push(code));
      handler(signal);
      handler(signal);
      assert.deepEqual(exits, [exitCode], signal);
    }
  });
});

describe('the hard stop of a second interrupt (production wiring, real signals)', () => {
  /** A process that listens the way the wait does and whose «clean-up» never ends: it answers the first interrupt with a line and carries on. */
  const stuckCleanupScript = `
    const { addInterruptHandlerWithHardStop } = require('./src/remoteRun/interrupts');
    addInterruptHandlerWithHardStop((signal) => { process.stdout.write('first interrupt: ' + signal + ', not stopping\\n'); });
    process.stdout.write('ready\\n');
    setInterval(() => undefined, 1000);
  `;

  function startStuckProcess(): { child: ReturnType<typeof spawn>; output: () => string; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> } {
    const child = spawn(process.execPath, ['--import', 'tsx', '--eval', stuckCleanupScript], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { output += chunk; });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => { child.once('exit', (code, signal) => resolve({ code, signal })); });
    return { child, output: () => output, exited };
  }

  async function waitForOutput(getOutput: () => string, fragment: string): Promise<void> {
    const deadline = Date.now() + processBoundMs;
    while (!getOutput().includes(fragment) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(getOutput().includes(fragment), `«${fragment}» never came; the output: ${getOutput()}`);
  }

  for (const [first, second, exitCode] of [['SIGINT', 'SIGINT', 130], ['SIGTERM', 'SIGTERM', 143], ['SIGINT', 'SIGTERM', 130], ['SIGHUP', 'SIGINT', 129]] as const) {
    it(`${first}, then ${second}: the first leaves the stuck process running, the second ends it at once with ${exitCode} — a call that never ends cannot swallow Ctrl-C`, async () => {
      const stuck = startStuckProcess();
      try {
        await waitForOutput(stuck.output, 'ready');
        stuck.child.kill(first);
        await waitForOutput(stuck.output, `first interrupt: ${first}`);
        assert.equal(stuck.child.exitCode, null, 'one interrupt does not end a process whose clean-up has not finished');
        stuck.child.kill(second);
        const outcome = await Promise.race([stuck.exited, new Promise<'still running'>((resolve) => { setTimeout(() => resolve('still running'), processBoundMs); })]);
        assert.deepEqual(outcome, { code: exitCode, signal: null });
      } finally {
        stuck.child.kill('SIGKILL');
      }
    });
  }
});
