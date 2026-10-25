/**
 * @description The local engine's Python sidecar logic as part of `yarn test`: `stt/test_gigaam_sidecar.py` covers the
 * pause cuts, the arrival-order pool, the queue report, the drop of a voice whose client hung up and the HTTP
 * handler. It needs numpy and soundfile only, never the model: it runs through `uv` (an ephemeral environment with
 * the pinned soundfile; the first run downloads them), or else under a `python3` that already has both.
 *
 * Setting the environment up is a step of its own. Where it cannot be done — no `uv` and no such `python3`, or `uv`
 * cannot reach the package index (offline, a firewall) — a local run is SKIPPED with the reason, while CI (`CI` set)
 * fails: there the suite must run. Once the environment is up, any failure of the suite fails the test everywhere.
 * CI installs uv (`.github/workflows/test.yml`); the live test runs the same file under the engine's own venv.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as path from 'path';
import { getSidecarScriptPath, gigaamPinnedRequirements } from '../stt/sttInstall';

const pythonTestsPath = path.join(path.dirname(getSidecarScriptPath()), 'test_gigaam_sidecar.py');
/** Setting up the environment: a first `uv` run downloads numpy and soundfile; a dropped connection must end in time. */
const setupTimeoutMs = 60_000;
/** The suite itself takes a few seconds. */
const pythonRunTimeoutMs = 50_000;
const probeTimeoutMs = 10_000;
/** Fewer tests than this means the file did not really run (an import that broke half of it), not a pass. */
const minimumPythonTests = 60;
const outputTailLength = 3000;
const isCi = Boolean(process.env.CI);
const soundfileRequirement = gigaamPinnedRequirements.find((requirement) => requirement.startsWith('soundfile'));
const importCheck = 'import numpy, soundfile';

/** @description How to start a Python that has numpy and soundfile: the command and the arguments before the script's. */
interface PythonRunner {
  command: string;
  prefixArgs: string[];
}

function checkIsCommandWorking(command: string, args: string[]): boolean {
  return spawnSync(command, args, { stdio: 'ignore', timeout: probeTimeoutMs }).status === 0;
}

function findPythonRunner(): PythonRunner | null {
  if (soundfileRequirement && checkIsCommandWorking('uv', ['--version'])) {
    return { command: 'uv', prefixArgs: ['run', '--no-project', '--quiet', '--with', 'numpy', '--with', soundfileRequirement, 'python'] };
  }
  if (checkIsCommandWorking('python3', ['-c', importCheck])) return { command: 'python3', prefixArgs: [] };
  return null;
}

function getOutputTail(run: ReturnType<typeof spawnSync>): string {
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();
  return output ? output.slice(-outputTailLength) : `exit ${run.status ?? 'none'}${run.error ? `, ${run.error.message}` : ''}`;
}

const runner = findPythonRunner();
const missingRunnerReason = 'needs uv, or a python3 with numpy and soundfile';

test('the sidecar\'s Python unit tests pass', { skip: !runner && !isCi ? missingRunnerReason : undefined, timeout: setupTimeoutMs + pythonRunTimeoutMs + probeTimeoutMs }, (context) => {
  assert.ok(runner, missingRunnerReason);
  const setup = spawnSync(runner.command, [...runner.prefixArgs, '-I', '-c', importCheck], { encoding: 'utf8', timeout: setupTimeoutMs });
  if (setup.status !== 0) {
    const reason = `the Python environment could not be set up: ${getOutputTail(setup)}`;
    assert.ok(!isCi, reason);
    context.skip(reason);
    return;
  }
  const run = spawnSync(runner.command, [...runner.prefixArgs, '-I', pythonTestsPath], { encoding: 'utf8', timeout: pythonRunTimeoutMs });
  const output = getOutputTail(run);
  const ranCount = Number(/^Ran (\d+) tests?/m.exec(output)?.[1] ?? '0');
  assert.ok(ranCount >= minimumPythonTests, `only ${ranCount} Python tests ran (exit ${run.status}):\n${output}`);
  assert.equal(run.status, 0, output);
});
