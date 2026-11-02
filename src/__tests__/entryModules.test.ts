/**
 * @description The modules that are RUN as programs (`cli`, the `charness-runner` command line, the STT install job, the admin line's root step,
 * the bot's worker entry) against the self-check that IMPORTS every built module (`selfUpdate/selfCheck.ts`). Two lines of defence: an entry
 * module starts its work only `if (require.main === module)`, so importing it starts nothing (tested on the built files, with plain `node`); and
 * the self-check also skips the names in `entryModules`, a list a scan of the sources keeps honest — a module that runs `main()` or a promise
 * chain at module scope and is not on the list fails here, not in the update check of a running bot (where the first one that was forgotten
 * printed a usage error and set an exit code). The two modules that start the bot stay on the list for good: `bot.js` reads its settings at
 * module scope and exits without them, and the worker entry imports it.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { entryModules } from '../selfUpdate/selfCheck';

const sourceRoot = path.resolve(__dirname, '..');
const distRoot = path.resolve(sourceRoot, '..', 'dist');
const spawnTimeoutMs = 30_000;
/** Import the bot and it starts: these two are not safe to import, by design, and are skipped by the self-check for that reason. */
const startsTheBotWhenImported: readonly string[] = ['bot.js', 'cli/botEntry.js'];
const promiseChainMethods: readonly string[] = ['then', 'catch', 'finally'];
const mainFunctionName = 'main';
const runsAsMainCondition = 'require.main === module';

function listSourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' || entryPath === path.join(sourceRoot, 'release') ? [] : listSourceFiles(entryPath);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [entryPath] : [];
  });
}

/**
 * Is the statement what makes a module a PROGRAM: the `if (require.main === module)` guard it says so with, or something that RUNS for its effect
 * — `main()` or a promise chain (`x().then(…)`, `.catch(…)`) — at module scope or in another top-level `if`?
 */
function checkStartsWork(statement: ts.Statement): boolean {
  if (ts.isIfStatement(statement) && statement.expression.getText() === runsAsMainCondition) return true;
  if (ts.isIfStatement(statement) && ts.isBlock(statement.thenStatement)) return statement.thenStatement.statements.some(checkStartsWork);
  if (!ts.isExpressionStatement(statement)) return false;
  let expression = statement.expression;
  if (ts.isVoidExpression(expression)) expression = expression.expression;
  if (!ts.isCallExpression(expression)) return false;
  if (ts.isIdentifier(expression.expression) && expression.expression.text === mainFunctionName) return true;
  return ts.isPropertyAccessExpression(expression.expression) && promiseChainMethods.includes(expression.expression.name.text);
}

/** The built name (`runnerUtility/rootServiceCli.js`) of every source module that starts work when it runs. */
function findModulesThatStartWork(): string[] {
  return listSourceFiles(sourceRoot)
    .filter((file) => ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true).statements.some(checkStartsWork))
    .map((file) => path.relative(sourceRoot, file).split(path.sep).join('/').replace(/\.ts$/, '.js'))
    .sort();
}

function runBuiltModule(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-entry-'));
  try {
    const result = spawnSync(process.execPath, args, { cwd: home, env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8', timeout: spawnTimeoutMs });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe('the entry modules of the self-check', () => {
  it('a module that is a program (the `require.main` guard) or runs main() or a promise chain at module scope is on the list — the scan sees the real entries, and every one it finds is listed', () => {
    const found = findModulesThatStartWork();
    for (const known of ['cli.js', 'index.js', 'cli/botEntry.js', 'runnerUtility/runnerCli.js', 'runnerUtility/rootServiceCli.js', 'stt/sttInstallEntry.js']) {
      assert.ok(found.includes(known), `the scan does not see ${known}: ${found.join(', ')}`);
    }
    assert.deepEqual(found.filter((module) => !entryModules.has(module)), [], 'these start work when imported, so the self-check must not import them: add them to entryModules (and guard them with require.main)');
  });

  it('every name on the list is a source module that exists — a rename cannot leave a dead name behind', () => {
    assert.deepEqual([...entryModules].filter((module) => !fs.existsSync(path.join(sourceRoot, module.replace(/\.js$/, '.ts')))), []);
  });
});

describe('importing a built entry module starts nothing', () => {
  const importSafe = [...entryModules].filter((module) => !startsTheBotWhenImported.includes(module)).sort();

  it('the modules that are not import-safe are exactly the two that start the bot', () => {
    assert.deepEqual([...entryModules].filter((module) => startsTheBotWhenImported.includes(module)).sort(), [...startsTheBotWhenImported].sort());
  });

  for (const module of importSafe) {
    it(`${module}: no output, no exit code, no end of the process`, () => {
      assert.ok(fs.existsSync(path.join(distRoot, module)), `dist/${module} is missing — run \`yarn build\` before the tests`);
      const result = runBuiltModule(['-e', `require(${JSON.stringify(path.join(distRoot, module))})`]);
      assert.deepEqual([result.status, result.stdout, result.stderr], [0, '', ''], `${module} ran something when imported`);
    });
  }
});

describe('run as the program, each entry module still runs', () => {
  const cases: Array<{ module: string; args: string[]; status: number; stream: 'stdout' | 'stderr'; pattern: RegExp }> = [
    { module: 'cli.js', args: ['nonsense'], status: 2, stream: 'stderr', pattern: /Unknown command: nonsense/ },
    { module: 'index.js', args: ['nonsense'], status: 2, stream: 'stderr', pattern: /Unknown command: nonsense/ },
    { module: 'runnerUtility/runnerCli.js', args: ['help'], status: 0, stream: 'stdout', pattern: /^Usage:/ },
    { module: 'runnerUtility/rootServiceCli.js', args: [], status: 2, stream: 'stderr', pattern: /Usage: rootServiceCli\.js install <account>/ },
    { module: 'stt/sttInstallEntry.js', args: [], status: 2, stream: 'stdout', pattern: /^$/ },
  ];

  for (const { module, args, status, stream, pattern } of cases) {
    it(`node dist/${module} ${args.join(' ')}`.trim(), () => {
      const result = runBuiltModule([path.join(distRoot, module), ...args]);
      assert.equal(result.status, status, result.stderr);
      assert.match(result[stream], pattern);
    });
  }
});
