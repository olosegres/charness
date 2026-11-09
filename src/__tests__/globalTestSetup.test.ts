/**
 * @description Process-level coverage for `globalTestSetup.ts`: the throwaway `DATA_DIR` it creates
 * for a test process must be writable even when a stale dir named after the pid already sits in the
 * temp dir, and must be gone once that process exits, however the process exits normally.
 * Every case runs a FRESH child with the setup preloaded and a private `TMPDIR`: this test's own
 * process already has the setup loaded, and its dir cannot be observed from the inside.
 *
 * The same for OpenCode's config home: `XDG_CONFIG_HOME` must be a private temp folder, because `ensureOpenCodeServer()` fills
 * `$XDG_CONFIG_HOME/opencode/plugins` with the bot's compaction plugin and clears it of every other version — with the
 * variable unset that is the real account's folder, and one suite run replaced the live bot's plugin file with the tree's own.
 *
 * Test case: N/A - Charness has no Jira tracker.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { pathToFileURL } from 'url';
import {
  installOpenCodeCompactPlugin,
  openCodeCompactPluginFileName,
  openCodeCompactPluginId,
  resolveOpenCodeGlobalPluginDir,
} from '../utils/openCodeCompactPlugin';

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
  'const foreignDir = path.join(os.tmpdir(), `charness-test-${process.pid}`);',
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
    result.leftTmpEntries.filter((entryName) => entryName.startsWith('charness-test-')),
    [path.basename(foreignDir)],
    'the foreign dir is not ours to delete and must be the only one left',
  );
  assert.equal(result.isForeignDirMarkerLeft, true, 'the foreign dir must be left untouched');
});

interface ConfigHomeChildResult {
  status: number | null;
  stderr: string;
  /** The `XDG_CONFIG_HOME` the child saw. */
  configHome: string;
  childTmpDir: string;
  /** Whether `configHome` still exists after the child exited. */
  isConfigHomeLeft: boolean;
}

/** A fresh child with the setup preloaded that reports its `XDG_CONFIG_HOME`; `inheritedConfigHome` is what its parent shell exports (`undefined`: nothing). */
function runConfigHomeChild(inheritedConfigHome: string | undefined): ConfigHomeChildResult {
  const childTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'globalTestSetup-'));
  try {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, TMPDIR: childTmpDir };
    if (inheritedConfigHome === undefined) delete childEnv.XDG_CONFIG_HOME;
    else childEnv.XDG_CONFIG_HOME = inheritedConfigHome;
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--import', globalTestSetupUrl, '--eval', "process.stdout.write(process.env.XDG_CONFIG_HOME ?? '')"],
      { cwd: repoRoot, encoding: 'utf8', timeout: setupChildTimeoutMs, env: childEnv },
    );
    assert.equal(child.error, undefined, child.error?.message);
    return { status: child.status, stderr: child.stderr, configHome: child.stdout, childTmpDir, isConfigHomeLeft: fs.existsSync(child.stdout) };
  } finally {
    fs.rmSync(childTmpDir, { recursive: true, force: true });
  }
}

for (const { name, inheritedConfigHome } of [
  { name: 'the shell exports none', inheritedConfigHome: undefined },
  { name: 'the shell exports one of its own', inheritedConfigHome: path.join(os.homedir(), '.config') },
]) {
  test(`globalTestSetup: XDG_CONFIG_HOME is a private temp folder when ${name}, and is removed when the process exits`, () => {
    const result = runConfigHomeChild(inheritedConfigHome);

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.equal(path.dirname(result.configHome), result.childTmpDir, 'the setup must have put the config home into the temp dir');
    assert.notEqual(result.configHome, inheritedConfigHome, 'whatever the shell exports is not honoured');
    assert.equal(result.isConfigHomeLeft, false, `${result.configHome} must not outlive the process that created it`);
  });
}

function checkIsInside(folder: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(folder));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

test('globalTestSetup: this process\'s default OpenCode plugin folder is inside the temp dir, never the account\'s own ~/.config', () => {
  const pluginDir = resolveOpenCodeGlobalPluginDir(process.env);
  assert.ok(checkIsInside(pluginDir, os.tmpdir()), `the default plugin folder is a temp folder: ${pluginDir}`);
  assert.ok(!checkIsInside(pluginDir, path.join(os.homedir(), '.config')), `and not under the account's own ~/.config: ${pluginDir}`);
});

test('globalTestSetup: the default plugin install goes to that private folder — a decoy older version there is replaced, nothing outside it is touched', () => {
  // The check above comes first: were the redirect missing, this test stops before the install could reach the real folder.
  const pluginDir = resolveOpenCodeGlobalPluginDir(process.env);
  assert.ok(checkIsInside(pluginDir, os.tmpdir()), `the default plugin folder is a temp folder: ${pluginDir}`);
  fs.mkdirSync(pluginDir, { recursive: true });
  const decoyPath = path.join(pluginDir, 'charness-compaction-00000000.js');
  fs.writeFileSync(decoyPath, `export default { id: ${JSON.stringify(openCodeCompactPluginId)}, server: async () => ({}) };\n`);

  installOpenCodeCompactPlugin();

  assert.equal(fs.existsSync(decoyPath), false, 'the older version in the default folder was removed');
  assert.deepEqual(fs.readdirSync(pluginDir), [openCodeCompactPluginFileName], 'and the current one is the only file there');
});
