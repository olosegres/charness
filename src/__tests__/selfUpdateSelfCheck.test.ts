/**
 * @description Coverage for `charness self-check` (`src/selfUpdate/selfCheck.ts`) — the probe the updater runs on a NEW
 * install before it switches to it: the version, `node-pty`'s native binding, every built module importable (entry points
 * and tests left out), `bot.js` syntactically sound. A fake package tree proves each failure is named and each entry point
 * is skipped; the built CLI proves the real install passes and a wrong expected version fails.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { listImportableModules, runSelfCheck } from '../selfUpdate/selfCheck';

const repoRoot = path.resolve(__dirname, '..', '..');
const builtCliPath = path.join(repoRoot, 'dist', 'cli.js');

let packageRoot: string;

function writePackageFile(relativePath: string, content: string): void {
  const filePath = path.join(packageRoot, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

beforeEach(() => {
  packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-selfcheck-test-'));
  writePackageFile('package.json', '{"name":"demo","version":"3.5.0"}\n');
  writePackageFile('dist/bot.js', 'module.exports = {};\n');
});

afterEach(() => {
  fs.rmSync(packageRoot, { recursive: true, force: true });
});

describe('the modules a self-check imports', () => {
  test('every built .js except the entry points, tests and non-js files, sorted, with forward slashes', () => {
    for (const entry of ['cli.js', 'index.js', 'cli/botEntry.js', 'stt/sttInstallEntry.js']) writePackageFile(`dist/${entry}`, 'throw new Error("an entry point was imported");\n');
    writePackageFile('dist/__tests__/some.test.js', 'throw new Error("a test was imported");\n');
    writePackageFile('dist/utils/b.js', 'module.exports = 1;\n');
    writePackageFile('dist/a.js', 'module.exports = 1;\n');
    writePackageFile('dist/a.d.ts', 'export {};\n');
    writePackageFile('dist/a.js.map', '{}\n');
    assert.deepEqual(listImportableModules(path.join(packageRoot, 'dist')), ['a.js', 'utils/b.js']);
  });
});

describe('a package tree', () => {
  test('a sound one has no problems and reports its version; no entry point or test of it is imported', async () => {
    writePackageFile('dist/cli.js', 'throw new Error("an entry point was imported");\n');
    writePackageFile('dist/__tests__/t.js', 'throw new Error("a test was imported");\n');
    writePackageFile('dist/ok.js', 'module.exports = 1;\n');
    assert.deepEqual(await runSelfCheck(packageRoot, '3.5.0'), { version: '3.5.0', problems: [] });
    assert.deepEqual(await runSelfCheck(packageRoot, null), { version: '3.5.0', problems: [] });
  });

  test('a different version than expected is a problem — and the version is still reported', async () => {
    const result = await runSelfCheck(packageRoot, '3.6.0');
    assert.equal(result.version, '3.5.0');
    assert.deepEqual(result.problems, ['the package says 3.5.0, expected 3.6.0']);
  });

  test('a native binding that does not load is named', async () => {
    const result = await runSelfCheck(packageRoot, null, () => Promise.reject(new Error('pty.node: invalid ELF header')));
    assert.deepEqual(result.problems, ['node-pty does not load: pty.node: invalid ELF header']);
  });

  test('a module that does not load (a missing dependency) is named', async () => {
    writePackageFile('dist/needsMissing.js', 'require("a-package-nobody-installed");\n');
    const result = await runSelfCheck(packageRoot, null);
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /^needsMissing\.js does not load: .*a-package-nobody-installed/);
  });

  test('a bot.js with a syntax error fails node --check, and is never imported', async () => {
    writePackageFile('dist/bot.js', 'const = ;\n');
    const result = await runSelfCheck(packageRoot, null);
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /^bot\.js does not pass node --check/);
  });

  test('the check leaves DATA_DIR as it found it', async () => {
    process.env.DATA_DIR = '/tmp/charness-selfcheck-before';
    writePackageFile('dist/seesDataDir.js', 'require("fs").writeFileSync(require("path").join(process.env.DATA_DIR, "touched"), "x");\n');
    try {
      assert.deepEqual((await runSelfCheck(packageRoot, null)).problems, []);
      assert.equal(process.env.DATA_DIR, '/tmp/charness-selfcheck-before');
    } finally {
      delete process.env.DATA_DIR;
    }
  });
});

describe('the built CLI', () => {
  const manifest: { version: string } = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const { version } = manifest;

  function runBuiltCli(...args: string[]): { status: number | null; stdout: string; stderr: string } {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-selfcheck-home-'));
    try {
      const result = spawnSync(process.execPath, [builtCliPath, 'self-check', ...args], {
        cwd: home,
        env: { PATH: process.env.PATH, HOME: home },
        encoding: 'utf8',
        timeout: 60_000,
      });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  test('this very install passes: its version on stdout, exit 0', () => {
    assert.ok(fs.existsSync(builtCliPath), 'dist/cli.js is missing — run `yarn build` before the tests');
    const result = runBuiltCli('--expect', version);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${version}\n`);
    assert.equal(result.stderr, '');
  });

  test('another expected version fails with the reason on stderr', () => {
    const result = runBuiltCli('--expect', '0.0.1');
    assert.equal(result.status, 1);
    assert.equal(result.stdout, `${version}\n`);
    assert.match(result.stderr, /self-check: the package says .*, expected 0\.0\.1/);
  });
});
