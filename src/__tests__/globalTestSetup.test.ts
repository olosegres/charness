/**
 * @description Process-level coverage for `globalTestSetup.ts`: the throwaway `DATA_DIR` it creates
 * for a test process must be writable even when a stale dir named after the pid already sits in the
 * temp dir, and must be gone once that process exits, however the process exits normally.
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
/** Read-only for everyone, like another account's leftover dir looks to us. */
const foreignDirMode = 0o555;
const ownDirMode = 0o755;
const foreignDirMarker = 'foreign-dir.txt';

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

/**
 * Runs in the child BEFORE the setup and plants what a pid wrap leaves behind: a dir named after
 * THIS pid in the temp dir, owned by somebody else, so unwritable. A pid-named setup would adopt it.
 */
const foreignPidDirPreload = [
  "const fs = require('node:fs');",
  "const os = require('node:os');",
  "const path = require('node:path');",
  'const foreignDir = path.join(os.tmpdir(), `telegramcode-test-${process.pid}`);',
  'fs.mkdirSync(foreignDir);',
  `fs.writeFileSync(path.join(foreignDir, '${foreignDirMarker}'), 'left by another account');`,
  `fs.chmodSync(foreignDir, ${foreignDirMode});`,
  'process.stderr.write(`${foreignDir}\\n`);',
].join('\n');

interface SetupChildResult {
  status: number | null;
  stderr: string;
  /** The `DATA_DIR` the child saw. */
  dataDir: string;
  /** The `TMPDIR` handed to the child. */
  childTmpDir: string;
  /** Whether `dataDir` still exists after the child exited. */
  isDataDirLeft: boolean;
  /** Entries left in the child's temp dir after it exited, by name. */
  leftTmpEntries: string[];
  /** Whether the planted foreign dir still holds its marker file after the child exited. */
  isForeignDirMarkerLeft: boolean;
}

function runSetupChild(childScript: string, isForeignPidDirPlanted = false): SetupChildResult {
  const childTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'globalTestSetup-'));
  try {
    const preloadImports: string[] = [];
    if (isForeignPidDirPlanted) {
      const preloadFile = path.join(childTmpDir, 'plantForeignPidDir.cjs');
      fs.writeFileSync(preloadFile, foreignPidDirPreload);
      preloadImports.push('--import', pathToFileURL(preloadFile).href);
    }
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', ...preloadImports, '--import', globalTestSetupUrl, '--eval', childScript],
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
      leftTmpEntries: fs.readdirSync(childTmpDir),
      isForeignDirMarkerLeft: fs.existsSync(path.join(child.stderr.trim(), foreignDirMarker)),
    };
  } finally {
    // A planted foreign dir is read-only, which blocks the removal of its contents.
    for (const entryName of fs.readdirSync(childTmpDir)) {
      fs.chmodSync(path.join(childTmpDir, entryName), ownDirMode);
    }
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

test('globalTestSetup: a stale unwritable dir named after the pid is neither adopted nor removed', () => {
  const result = runSetupChild(childPrologue, true);
  const foreignDir = result.stderr.trim();

  assert.equal(result.status, 0, `the child must write into its DATA_DIR; stderr: ${result.stderr}`);
  assert.equal(path.dirname(foreignDir), result.childTmpDir, 'the preload must have planted the foreign dir');
  assert.notEqual(result.dataDir, foreignDir, 'the setup must not hand out the stale foreign dir as DATA_DIR');
  assert.equal(result.isDataDirLeft, false, `${result.dataDir} must not outlive the process that created it`);
  assert.deepEqual(
    result.leftTmpEntries.filter((entryName) => entryName.startsWith('telegramcode-test-')),
    [path.basename(foreignDir)],
    'the foreign dir is not ours to delete and must be the only one left',
  );
  assert.equal(result.isForeignDirMarkerLeft, true, 'the foreign dir must be left untouched');
});
