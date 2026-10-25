/**
 * @description The local engine's Python sidecar logic as part of `yarn test`: `stt/test_gigaam_sidecar.py` covers the
 * pause cuts, the arrival-order pool, the queue report, the drop of a voice whose client hung up and the HTTP
 * handler. It needs numpy and soundfile only, never the model: it runs through `uv` (an ephemeral environment with
 * the pinned soundfile), or else under a `python3` that already has both. Only where neither exists is it skipped,
 * saying so; CI installs uv (`.github/workflows/test.yml`), and the live test runs the same file under the engine's
 * own venv.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as path from 'path';
import { getSidecarScriptPath, gigaamPinnedRequirements } from '../stt/sttInstall';

const pythonTestsPath = path.join(path.dirname(getSidecarScriptPath()), 'test_gigaam_sidecar.py');
/** The file's own run takes a few seconds; a first `uv` run also fetches numpy and soundfile into its cache. */
const pythonRunTimeoutMs = 100_000;
const probeTimeoutMs = 10_000;
/** Fewer tests than this means the file did not really run (an import that broke half of it), not a pass. */
const minimumPythonTests = 60;
const soundfileRequirement = gigaamPinnedRequirements.find((requirement) => requirement.startsWith('soundfile'));

interface PythonRunner {
  command: string;
  args: string[];
}

function checkIsCommandWorking(command: string, args: string[]): boolean {
  return spawnSync(command, args, { stdio: 'ignore', timeout: probeTimeoutMs }).status === 0;
}

function findPythonRunner(): PythonRunner | null {
  if (soundfileRequirement && checkIsCommandWorking('uv', ['--version'])) {
    return {
      command: 'uv',
      args: ['run', '--no-project', '--quiet', '--with', 'numpy', '--with', soundfileRequirement, 'python', '-I', pythonTestsPath],
    };
  }
  if (checkIsCommandWorking('python3', ['-c', 'import numpy, soundfile'])) return { command: 'python3', args: ['-I', pythonTestsPath] };
  return null;
}

const runner = findPythonRunner();

test('the sidecar\'s Python unit tests pass', { skip: runner ? undefined : 'needs uv, or a python3 with numpy and soundfile', timeout: pythonRunTimeoutMs + probeTimeoutMs }, () => {
  assert.ok(runner);
  const run = spawnSync(runner.command, runner.args, { encoding: 'utf8', timeout: pythonRunTimeoutMs });
  const output = `${run.stdout}${run.stderr}`;
  const ranCount = Number(/^Ran (\d+) tests?/m.exec(output)?.[1] ?? '0');
  assert.ok(ranCount >= minimumPythonTests, `only ${ranCount} Python tests ran (exit ${run.status}):\n${output.slice(-3000)}`);
  assert.equal(run.status, 0, output.slice(-3000));
});
