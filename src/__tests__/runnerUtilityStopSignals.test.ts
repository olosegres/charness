/**
 * @description `runnerUtility/stopSignals.ts`: a runner is stopped by more than one signal (the launcher forwards the TERM it got while a terminal's Ctrl-C or a group
 * kill hands the app its own, milliseconds later). The handler stops gracefully at the first and ignores the rest — a handler that was `once` let the second take the
 * default action and kill the process under its own clean-up. Tested in a REAL process whose clean-up is still going when the second TERM arrives: the clean-up runs
 * and the exit code is 0 (with `once` the same script dies of the signal, nothing cleaned: the flake of the link flow's «a stopped link leaves no state behind»).
 *
 * Nothing here depends on how fast the machine is: the process says `stopping` once it has handled the first TERM, the second TERM is sent only after that line
 * arrived, and the clean-up ends on a `go` line the test writes AFTER the second TERM — a signal is pending in the kernel before that write, so a process that the
 * second TERM kills cannot have read `go` first.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { onStopSignals } from '../runnerUtility/stopSignals';

const repoRoot = path.resolve(__dirname, '..', '..');
/** How long the test waits for something to HAPPEN (a start-up, a line): a wait for an event, never an assertion about speed. */
const boundMs = 30_000;

/** The process under test: `stop` says `stopping` and waits for `go` on its standard input before it cleans up and exits 0. */
function createScript(handlerInstall: string): string {
  return `
    const fs = require('fs');
    const marker = process.argv[1];
    const stop = () => {
      process.stdout.write('stopping\\n');
      process.stdin.once('data', () => { fs.writeFileSync(marker, 'cleaned'); process.exit(0); });
    };
    ${handlerInstall}
    setInterval(() => undefined, 1000);
    process.stdout.write('ready\\n');
  `;
}

async function runWithTwoSignals(script: string): Promise<{ code: number | null; signal: NodeJS.Signals | null; isCleaned: boolean }> {
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stop-signals-')), 'marker');
  const child = spawn(process.execPath, ['--import', 'tsx', '--eval', script, marker], { cwd: repoRoot, stdio: ['pipe', 'pipe', 'inherit'] });
  // The second signal may end the process before `go` is written: a write to a pipe nobody reads is no error of the test.
  child.stdin?.on('error', () => undefined);
  let output = '';
  const lineWaiters: Array<{ text: string; resolve: () => void }> = [];
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
    for (const waiter of lineWaiters) if (output.includes(waiter.text)) waiter.resolve();
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => { child.once('exit', (code, signal) => resolve({ code, signal })); });
  const waitForLine = (text: string): Promise<void> => new Promise((resolve, reject) => {
    if (output.includes(text)) {
      resolve();
      return;
    }
    const bound = setTimeout(() => reject(new Error(`timed out waiting for «${text}»; output so far: ${JSON.stringify(output)}`)), boundMs);
    lineWaiters.push({ text, resolve: () => { clearTimeout(bound); resolve(); } });
  });
  let exitBound: NodeJS.Timeout | undefined;
  try {
    await waitForLine('ready');
    child.kill('SIGTERM');
    await waitForLine('stopping');
    child.kill('SIGTERM');
    child.stdin?.write('go\n');
    const outcome = await Promise.race([exited, new Promise<never>((_, reject) => { exitBound = setTimeout(() => reject(new Error('the process did not end')), boundMs); })]);
    return { ...outcome, isCleaned: fs.existsSync(marker) };
  } finally {
    clearTimeout(exitBound);
    child.kill('SIGKILL');
    fs.rmSync(path.dirname(marker), { recursive: true, force: true });
  }
}

describe('onStopSignals', () => {
  it('calls stop at the first SIGINT or SIGTERM only, and keeps its handlers so that no later signal finds the default action', () => {
    let stops = 0;
    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    const remove = onStopSignals(() => { stops += 1; });
    process.emit('SIGTERM', 'SIGTERM');
    process.emit('SIGTERM', 'SIGTERM');
    process.emit('SIGINT', 'SIGINT');
    assert.equal(stops, 1);
    assert.deepEqual([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')], [before[0] + 1, before[1] + 1], 'still installed after the first signal');
    remove();
    assert.deepEqual([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')], before);
  });

  it('a real process finishes its clean-up although a second TERM arrives in the middle of it: exit code 0, cleaned', async () => {
    const outcome = await runWithTwoSignals(createScript('require("./src/runnerUtility/stopSignals").onStopSignals(stop);'));
    assert.deepEqual([outcome.code, outcome.signal, outcome.isCleaned], [0, null, true]);
  });

  it('...and with a handler that is `once` the same script is killed by the second TERM with nothing cleaned (the failure this exists for)', async () => {
    const outcome = await runWithTwoSignals(createScript('process.once("SIGTERM", stop);'));
    assert.deepEqual([outcome.code, outcome.signal, outcome.isCleaned], [null, 'SIGTERM', false]);
  });
});
