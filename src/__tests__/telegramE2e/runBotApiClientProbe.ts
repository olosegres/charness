/**
 * @description Run `botApiClientProbe.ts` as a child process against `apiRoot` and collect what it printed. A watchdog
 * kills a probe that outlives its deadline, so a hung client fails the test instead of hanging the run. Matches neither
 * runner glob.
 */

import { spawn } from 'node:child_process';
import * as path from 'path';

const probeScriptPath = path.join(__dirname, 'botApiClientProbe.ts');
/** A probe stalls for seconds at most; this is far above any honest run. */
const probeDeadlineMs = 30 * 1000;

export interface BotApiClientProbeResult {
  output: string;
  errorOutput: string;
  exitCode: number | null;
}

export function runBotApiClientProbe(apiRoot: string, stallMs: number, retryMode: 'retry' | 'noRetry'): Promise<BotApiClientProbeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', probeScriptPath, apiRoot, stallMs.toString(), retryMode], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errorOutput = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { errorOutput += chunk.toString('utf8'); });
    const watchdog = setTimeout(() => child.kill('SIGKILL'), probeDeadlineMs);
    child.on('error', (error) => { clearTimeout(watchdog); reject(error); });
    child.on('exit', (exitCode) => {
      clearTimeout(watchdog);
      resolve({ output: output.trim(), errorOutput: errorOutput.trim(), exitCode });
    });
  });
}
