/**
 * @description Process-level coverage for `globalTestSetup.ts`: the throwaway `DATA_DIR` it creates
 * for a test process must be gone once that process exits, however the process exits normally.
 * Every case runs a FRESH child with the setup preloaded and a private `TMPDIR`: this test's own
 * process already has the setup loaded, and its dir cannot be observed from the inside.
 *
 * Test case: N/A - TelegramCode has no Jira tracker.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { pathToFileURL } from 'url';

const repoRoot = path.join(__dirname, '..', '..');
const globalTestSetupUrl = pathToFileURL(path.join(__dirname, 'globalTestSetup.ts')).href;
const setupChildTimeoutMs = 30_000;
const failureExitCode = 3;
/** Node's documented exit code for an exception nobody caught. */
const uncaughtExceptionExitCode = 1;

/** Fills the dir like a real test would (a diagnostic log) and reports where it lives. */
const childPrologue = [
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "fs.writeFileSync(path.join(process.env.DATA_DIR, 'agent-diag.log'), 'written by the test process');",
  'process.stdout.write(process.env.DATA_DIR);',
].join('\n');

const exitPaths = [
  { name: 'the event loop drains', childEpilogue: '', expectedStatus: 0 },
  { name: 'process.exit() with a failure code', childEpilogue: `process.exit(${failureExitCode});`, expectedStatus: failureExitCode },
  {
    name: 'an uncaught exception',
    childEpilogue: "throw new Error('uncaught in the child');",
    expectedStatus: uncaughtExceptionExitCode,
  },
];

interface SetupChildResult {
  status: number | null;
  stderr: string;
  /** The `DATA_DIR` the child saw. */
  dataDir: string;
  /** The `TMPDIR` handed to the child. */
  childTmpDir: string;
  /** Whether `dataDir` still exists after the child exited. */
  isDataDirLeft: boolean;
}

function runSetupChild(childScript: string): SetupChildResult {
  const childTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'globalTestSetup-'));
  try {
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--import', globalTestSetupUrl, '--eval', childScript],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: setupChildTimeoutMs,
        env: { ...process.env, TMPDIR: childTmpDir },
      },
    );
    assert.equal(child.error, undefined, child.error?.message);
    return {
      status: child.status,
      stderr: child.stderr,
      dataDir: child.stdout,
      childTmpDir,
      isDataDirLeft: fs.existsSync(child.stdout),
    };
  } finally {
    fs.rmSync(childTmpDir, { recursive: true, force: true });
  }
}

for (const { name, childEpilogue, expectedStatus } of exitPaths) {
  test(`globalTestSetup: the process DATA_DIR is removed when ${name}`, () => {
    const result = runSetupChild(`${childPrologue}\n${childEpilogue}`);

    assert.equal(result.status, expectedStatus, `the cleanup must not change the exit code; stderr: ${result.stderr}`);
    assert.equal(
      path.dirname(result.dataDir),
      result.childTmpDir,
      'the setup must have redirected DATA_DIR into the temp dir (otherwise the check below is vacuous)',
    );
    assert.equal(result.isDataDirLeft, false, `${result.dataDir} must not outlive the process that created it`);
  });
}
