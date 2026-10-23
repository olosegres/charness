import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * `charness self-check [--expect <version>]` — what the updater runs on a NEW install before it switches to it: does this
 * install start at all? It reads the package version, loads `node-pty`'s native binding, imports the whole built module graph
 * (so a missing file or dependency fails here, not in the running bot) and syntax-checks the one module it cannot import —
 * `bot.js` reads its settings at module scope and exits the process without them. Hidden: it is not in `--help`.
 */

/** Entry points: importing one starts something (the CLI, the bot, the install job). */
const entryModules: ReadonlySet<string> = new Set(['cli.js', 'index.js', 'bot.js', 'cli/botEntry.js', 'stt/sttInstallEntry.js']);
const testsFolderName = '__tests__';
const botModule = 'bot.js';
const syntaxCheckTimeoutMs = 30 * 1000;

export interface SelfCheckResult {
  /** The package version, whatever else failed. */
  version: string;
  /** What is wrong; empty = the install is sound. */
  problems: string[];
}

/** @description The built modules a self-check imports: every `.js` under `dist/` except entry points and tests, relative paths. */
export function listImportableModules(distDirectory: string): string[] {
  return fs
    .readdirSync(distDirectory, { recursive: true, encoding: 'utf8' })
    .map((entry) => entry.split(path.sep).join('/'))
    .filter((entry) => entry.endsWith('.js') && !entry.split('/').includes(testsFolderName) && !entryModules.has(entry))
    .sort();
}

function readPackageVersion(packageRoot: string): string {
  const manifest: { version: string } = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  return manifest.version;
}

/**
 * @description Check the install at `packageRoot` (the folder holding `package.json` and `dist/`). Importing the modules
 * may resolve paths under `DATA_DIR` at import time, so the check runs with a throwaway one and removes it.
 * `loadNativeBinding` loads `node-pty` (a parameter so a test can make it fail).
 */
export async function runSelfCheck(
  packageRoot: string,
  expectVersion: string | null,
  loadNativeBinding: () => Promise<object> = () => import('node-pty'),
): Promise<SelfCheckResult> {
  const problems: string[] = [];
  const version = readPackageVersion(packageRoot);
  if (expectVersion !== null && version !== expectVersion) {
    problems.push(`the package says ${version}, expected ${expectVersion}`);
  }

  try {
    await loadNativeBinding();
  } catch (error) {
    problems.push(`node-pty does not load: ${error instanceof Error ? error.message : String(error)}`);
  }

  const distDirectory = path.join(packageRoot, 'dist');
  const botPath = path.join(distDirectory, botModule);
  try {
    execFileSync(process.execPath, ['--check', botPath], { stdio: 'pipe', timeout: syntaxCheckTimeoutMs });
  } catch (error) {
    problems.push(`${botModule} does not pass node --check: ${error instanceof Error ? error.message : String(error)}`);
  }

  const throwawayDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-selfcheck-'));
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = throwawayDataDir;
  try {
    for (const modulePath of listImportableModules(distDirectory)) {
      try {
        require(path.join(distDirectory, modulePath));
      } catch (error) {
        problems.push(`${modulePath} does not load: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    fs.rmSync(throwawayDataDir, { recursive: true, force: true });
  }
  return { version, problems };
}

/**
 * @description The CLI face: version on stdout, every problem on stderr, exit 1 when there is one. `packageRoot` is the
 * folder this module's own `dist/` belongs to.
 */
export async function runSelfCheckCli(args: string[], packageRoot: string): Promise<number> {
  const expectIndex = args.indexOf('--expect');
  const expectVersion = expectIndex === -1 ? null : (args[expectIndex + 1] ?? null);
  const result = await runSelfCheck(packageRoot, expectVersion);
  process.stdout.write(`${result.version}\n`);
  for (const problem of result.problems) process.stderr.write(`self-check: ${problem}\n`);
  return result.problems.length === 0 ? 0 : 1;
}
