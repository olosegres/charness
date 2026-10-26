/**
 * @description The local engine's Python sidecar logic as part of `yarn test`: `stt/test_gigaam_sidecar.py` covers the
 * pause cuts, the arrival-order pool, the queue report, the drop of a voice whose client hung up and the HTTP
 * handler, and the decoding of every audio format the engine accepts. It needs numpy, soundfile and av (ffmpeg's
 * libraries) only, never the model: it runs through `uv` (an ephemeral environment with the pinned packages; the first
 * run downloads them), or else under a `python3` that already has all three.
 *
 * Setting the environment up is a step of its own. Where it cannot be done — no `uv` and no such `python3`, or `uv`
 * cannot reach the package index (offline, a firewall) — a local run is SKIPPED with the reason, while CI (`CI` is
 * `true` or `1`) fails: there the suite must run. Once the environment is up, any failure of the suite fails the test
 * everywhere.
 * CI installs uv (`.github/workflows/test.yml`); the live test runs the same file under the engine's own venv.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as path from 'path';
import { getSidecarScriptPath, gigaamPinnedRequirements } from '../stt/sttInstall';
import { getTestFileTimeoutMs } from './e2e/isolatedCharness';

const pythonTestsPath = path.join(path.dirname(getSidecarScriptPath()), 'test_gigaam_sidecar.py');
/**
 * The suite's own work is ~10 s of CPU plus ~10 s of real waits (the in-flight windows of the handler tests), so its time
 * scales with the load of the machine and no fixed number fits every box. The run therefore gets the whole file limit
 * (`--test-timeout`, the unit runner's 2 minutes unless the file is run by hand without one) less the setup's actual
 * time and a reserve to report: a slow or loaded box has the time its limit allows, and a hang still fails by name with
 * the test it stuck in, before the runner's bare "timed out".
 */
const defaultFileLimitMs = 2 * 60 * 1000;
const reportReserveMs = 5_000;
/** A first `uv` run downloads numpy and soundfile; a dropped connection must end in time, not take the whole file limit. */
const setupTimeoutMs = 45_000;
const probeTimeoutMs = 5_000;
const processStartMs = Date.now() - process.uptime() * 1000;
const fileDeadlineMs = processStartMs + (getTestFileTimeoutMs() ?? defaultFileLimitMs) - reportReserveMs;
/** Fewer tests than this means the file did not really run (an import that broke half of it), not a pass. */
const minimumPythonTests = 85;
const outputTailLength = 3000;
const isCi = process.env.CI === 'true' || process.env.CI === '1';
const soundfileRequirement = gigaamPinnedRequirements.find((requirement) => requirement.startsWith('soundfile'));
const avRequirement = gigaamPinnedRequirements.find((requirement) => requirement.startsWith('av=='));
const importCheck = 'import numpy, soundfile, av';

/** @description How to start a Python that has numpy, soundfile and av: the command and the arguments before the script's. */
interface PythonRunner {
  command: string;
  prefixArgs: string[];
}

function checkIsCommandWorking(command: string, args: string[]): boolean {
  return spawnSync(command, args, { stdio: 'ignore', timeout: probeTimeoutMs }).status === 0;
}

function findPythonRunner(): PythonRunner | null {
  if (soundfileRequirement && avRequirement && checkIsCommandWorking('uv', ['--version'])) {
    return {
      command: 'uv',
      prefixArgs: ['run', '--no-project', '--quiet', '--with', 'numpy', '--with', soundfileRequirement, '--with', avRequirement, 'python'],
    };
  }
  if (checkIsCommandWorking('python3', ['-c', importCheck])) return { command: 'python3', prefixArgs: [] };
  return null;
}

function getOutputTail(run: ReturnType<typeof spawnSync>): string {
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();
  return output ? output.slice(-outputTailLength) : `exit ${run.status ?? 'none'}${run.error ? `, ${run.error.message}` : ''}`;
}

const runner = findPythonRunner();
const missingRunnerReason = 'needs uv, or a python3 with numpy, soundfile and av';

test('the sidecar\'s Python unit tests pass', { skip: !runner && !isCi ? missingRunnerReason : undefined }, (context) => {
  assert.ok(runner, missingRunnerReason);
  const setup = spawnSync(runner.command, [...runner.prefixArgs, '-I', '-c', importCheck], { encoding: 'utf8', timeout: setupTimeoutMs });
  if (setup.status !== 0) {
    const reason = `the Python environment could not be set up: ${getOutputTail(setup)}`;
    assert.ok(!isCi, reason);
    context.skip(reason);
    return;
  }
  const runBudgetMs = Math.floor(fileDeadlineMs - Date.now());
  assert.ok(runBudgetMs > 0, 'no time of the file limit is left for the Python tests after the environment was set up');
  // `-v` names each test as it starts, so a run that stops at the deadline says which one it was in.
  const run = spawnSync(runner.command, [...runner.prefixArgs, '-I', pythonTestsPath, '-v'], { encoding: 'utf8', timeout: runBudgetMs });
  const output = getOutputTail(run);
  assert.ok(run.error === undefined, `the Python tests did not finish within the ${Math.round(runBudgetMs / 1000)} s left of the file limit (${run.error?.message}); the last of their output:\n${output}`);
  const ranCount = Number(/^Ran (\d+) tests?/m.exec(output)?.[1] ?? '0');
  assert.ok(ranCount >= minimumPythonTests, `only ${ranCount} Python tests ran (exit ${run.status}):\n${output}`);
  assert.equal(run.status, 0, output);
});
