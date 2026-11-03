/**
 * @description `runnerUtility/stopSignals.ts`: a runner is stopped by more than one signal (the launcher forwards the TERM it got while a terminal's Ctrl-C or a group
 * kill hands the app its own, milliseconds later). The handler stops gracefully at the first and ignores the rest — a handler that was `once` let the second take the
 * default action and kill the process under its own clean-up. Tested in a REAL process with a clean-up that takes a moment, two TERMs 100 ms apart: the clean-up
 * runs and the exit code is 0 (with `once` the same script dies with 143, nothing cleaned: the flake of the link flow's «a stopped link leaves no state behind»).
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
const cleanupMs = 400;
const secondSignalAfterMs = 100;
const boundMs = 30_000;

function createScript(handlerInstall: string): string {
  return `
    const fs = require('fs');
    const { onStopSignals } = require('./src/runnerUtility/stopSignals');
    const marker = process.argv[1];
    const stop = () => { setTimeout(() => { fs.writeFileSync(marker, 'cleaned'); process.exit(0); }, ${cleanupMs}); };
    ${handlerInstall}
    setInterval(() => undefined, 1000);
    process.stdout.write('ready\\n');
  `;
}

async function runWithTwoSignals(script: string): Promise<{ code: number | null; signal: NodeJS.Signals | null; isCleaned: boolean }> {
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stop-signals-')), 'marker');
  const child = spawn(process.execPath, ['--import', 'tsx', '--eval', script, marker], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => { child.once('exit', (code, signal) => resolve({ code, signal })); });
  try {
    await new Promise<void>((resolve) => {
      const bound = setTimeout(resolve, boundMs);
      child.stdout?.on('data', (chunk: Buffer) => { if (chunk.toString().includes('ready')) { clearTimeout(bound); resolve(); } });
    });
    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, secondSignalAfterMs));
    child.kill('SIGTERM');
    const outcome = await Promise.race([exited, new Promise<{ code: null; signal: null }>((resolve) => { setTimeout(() => resolve({ code: null, signal: null }), boundMs); })]);
    return { ...outcome, isCleaned: fs.existsSync(marker) };
  } finally {
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

  it('a real process whose clean-up takes a moment finishes it although a second TERM arrives in the middle: exit code 0, cleaned', async () => {
    const outcome = await runWithTwoSignals(createScript('require("./src/runnerUtility/stopSignals").onStopSignals(stop);'));
    assert.deepEqual([outcome.code, outcome.signal, outcome.isCleaned], [0, null, true]);
  });

  it('...and with a handler that is `once` the same script is killed by the second TERM with nothing cleaned (the failure this exists for)', async () => {
    const outcome = await runWithTwoSignals(createScript('process.once("SIGTERM", stop);'));
    assert.deepEqual([outcome.code, outcome.signal, outcome.isCleaned], [null, 'SIGTERM', false]);
  });
});
