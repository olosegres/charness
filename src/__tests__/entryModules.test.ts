/**
 * @description The modules that are RUN as programs (`cli`, the `charness-runner` command line, the STT install job, the admin line's root step,
 * the bot's worker entry) against the self-check that IMPORTS every built module (`selfUpdate/selfCheck.ts`). Three lines of defence: an entry
 * module starts its work only `if (require.main === module)`, so importing it starts nothing (tested on the built files, with plain `node`);
 * the self-check also skips the names in `entryModules`, a list a scan of the sources keeps honest — a module that carries the guard, runs
 * `main()` or runs a promise chain at module scope and is not on the list fails here, not in the update check of a running bot (where the first
 * one that was forgotten printed a usage error and set an exit code); and, whatever shape a program is written in (`void run()`, an
 * async IIFE, a bare `start()`), a child `node` with a bare environment imports every module the self-check imports and must end by itself,
 * clean, within seconds — a module that prints, sets an exit code or holds the event loop open fails by name. The two modules that start the bot
 * stay on the list for good: `bot.js` reads its settings at module scope and exits without them, and the worker entry imports it.
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
import { entryModules, listImportableModules } from '../selfUpdate/selfCheck';

const sourceRoot = path.resolve(__dirname, '..');
const distRoot = path.resolve(sourceRoot, '..', 'dist');
const spawnTimeoutMs = 30_000;
/** How long a child that imports the WHOLE package may take before it counts as one that holds the event loop open (loading takes seconds, not tens). */
const importAllTimeoutMs = 30_000;
/** The same for a child that imports ONE module, used to name the culprit once the whole-package child has failed. */
const importOneTimeoutMs = 10_000;
const fakeTreeTimeoutMs = 3_000;
/** Import the bot and it starts: these two are not safe to import, by design, and are skipped by the self-check for that reason. */
const startsTheBotWhenImported: readonly string[] = ['bot.js', 'cli/botEntry.js'];
const promiseChainMethods: readonly string[] = ['then', 'catch', 'finally'];
const mainFunctionName = 'main';

function listSourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' || entryPath === path.join(sourceRoot, 'release') ? [] : listSourceFiles(entryPath);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [entryPath] : [];
  });
}

function checkIsRequireMain(node: ts.Expression): boolean {
  return ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require' && node.name.text === 'main';
}

function checkIsModuleIdentifier(node: ts.Expression): boolean {
  return ts.isIdentifier(node) && node.text === 'module';
}

/** `require.main === module`, in either order, with `==` or `===`: the guard that says «this file is a program». */
function checkIsMainGuard(condition: ts.Expression): boolean {
  if (!ts.isBinaryExpression(condition)) return false;
  const operator = condition.operatorToken.kind;
  if (operator !== ts.SyntaxKind.EqualsEqualsEqualsToken && operator !== ts.SyntaxKind.EqualsEqualsToken) return false;
  return (checkIsRequireMain(condition.left) && checkIsModuleIdentifier(condition.right)) || (checkIsModuleIdentifier(condition.left) && checkIsRequireMain(condition.right));
}

/**
 * Is the statement what makes a module a PROGRAM: the `require.main` guard it says so with (the body may or may not have braces), or something
 * that RUNS for its effect — `main()` or a promise chain (`x().then(…)`, `.catch(…)`) — at module scope or in another top-level `if`?
 */
function checkStartsWork(statement: ts.Statement): boolean {
  if (ts.isIfStatement(statement) && checkIsMainGuard(statement.expression)) return true;
  if (ts.isIfStatement(statement) && ts.isBlock(statement.thenStatement)) return statement.thenStatement.statements.some(checkStartsWork);
  if (!ts.isExpressionStatement(statement)) return false;
  let expression = statement.expression;
  if (ts.isVoidExpression(expression)) expression = expression.expression;
  if (!ts.isCallExpression(expression)) return false;
  if (ts.isIdentifier(expression.expression) && expression.expression.text === mainFunctionName) return true;
  return ts.isPropertyAccessExpression(expression.expression) && promiseChainMethods.includes(expression.expression.name.text);
}

function checkSourceStartsWork(fileName: string, text: string): boolean {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true).statements.some(checkStartsWork);
}

/** The built name (`runnerUtility/rootServiceCli.js`) of every source module that starts work when it runs. */
function findModulesThatStartWork(): string[] {
  return listSourceFiles(sourceRoot)
    .filter((file) => checkSourceStartsWork(file, fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(sourceRoot, file).split(path.sep).join('/').replace(/\.ts$/, '.js'))
    .sort();
}

function runNode(args: string[], timeoutMs: number = spawnTimeoutMs): { status: number | null; stdout: string; stderr: string; isTimedOut: boolean } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-entry-'));
  try {
    const result = spawnSync(process.execPath, args, { cwd: home, env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8', timeout: timeoutMs });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, isTimedOut: result.error !== undefined };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function describeMisbehaviour(result: ReturnType<typeof runNode>): string | null {
  if (result.isTimedOut) return 'does not end by itself (holds the event loop open)';
  if (result.status !== 0) return `ends with status ${result.status}`;
  if (result.stdout !== '' || result.stderr !== '') return `prints «${(result.stdout + result.stderr).trim().slice(0, 80)}»`;
  return null;
}

/**
 * Import every module of `modules` (relative to `distDirectory`) in ONE child with a bare environment: it must end by itself, with status 0 and
 * no output. When it does not, each module is imported in a child of its own to say WHICH ones misbehave and how. Shape-independent: whatever
 * a module does at import — a `void run()`, an async IIFE, a stray timer — shows here.
 */
function findModulesThatMisbehaveWhenImported(distDirectory: string, modules: readonly string[], timeouts: { all: number; one: number }): string[] {
  const requireAll = `for (const module of ${JSON.stringify(modules.map((module) => path.join(distDirectory, module)))}) require(module);`;
  if (describeMisbehaviour(runNode(['-e', requireAll], timeouts.all)) === null) return [];
  return modules
    .map((module) => ({ module, problem: describeMisbehaviour(runNode(['-e', `require(${JSON.stringify(path.join(distDirectory, module))})`], timeouts.one)) }))
    .filter(({ problem }) => problem !== null)
    .map(({ module, problem }) => `${module}: ${problem}`);
}

describe('the scan for programs', () => {
  const recognised: Array<[string, string]> = [
    ['the guard, braces', "if (require.main === module) { main(); }"],
    ['the guard, no braces', "if (require.main === module) runCli();"],
    ['the guard reversed', "if (module === require.main) runCli();"],
    ['the guard with ==', "if (require.main == module) runCli();"],
    ['the guard reversed with ==', "if (module == require.main) { runCli(); }"],
    ['a bare main()', "main();"],
    ['a promise chain', "run().then(() => undefined, () => undefined);"],
    ['a promise chain after void', "void run().catch(() => undefined);"],
    ['a chain inside another top-level if', "if (process.argv.length > 2) { run().then(() => undefined); }"],
  ];
  const ignored: Array<[string, string]> = [
    ['a function that only exists', "export function runCli(): void { main().catch(() => undefined); }"],
    ['a registration', "registerCodec(codec);"],
    ['a condition on something else', "if (process.argv.length > 2) runCli();"],
    ['a comparison that is not the guard', "if (require.main !== module) runCli();"],
    ['a comparison with another module', "if (require.main === other) runCli();"],
  ];

  for (const [name, source] of recognised) it(`sees a program: ${name}`, () => assert.equal(checkSourceStartsWork('x.ts', source), true));
  for (const [name, source] of ignored) it(`does not take for a program: ${name}`, () => assert.equal(checkSourceStartsWork('x.ts', source), false));
});

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
      const result = runNode(['-e', `require(${JSON.stringify(path.join(distRoot, module))})`]);
      assert.deepEqual([result.status, result.stdout, result.stderr], [0, '', ''], `${module} ran something when imported`);
    });
  }
});

describe('every module the self-check imports is quiet and ends by itself', () => {
  it('the built package: one child imports them all with a bare environment and ends by itself, clean', () => {
    assert.ok(fs.existsSync(path.join(distRoot, 'cli.js')), 'dist/cli.js is missing — run `yarn build` before the tests');
    const modules = listImportableModules(distRoot);
    assert.ok(modules.length > 100, `only ${modules.length} importable modules: the list is not the package`);
    assert.deepEqual(findModulesThatMisbehaveWhenImported(distRoot, modules, { all: importAllTimeoutMs, one: importOneTimeoutMs }), []);
  });

  it('a fake package: it names a module that prints, sets an exit code, runs `void run()` or an async IIFE — whatever its shape — and none that is quiet', () => {
    const fakeDist = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-importall-'));
    try {
      const files: Record<string, string> = {
        'quiet.js': 'module.exports = 1;\n',
        'unref.js': 'setTimeout(() => undefined, 60000).unref();\n',
        'loud.js': 'process.stdout.write("hello\\n");\n',
        'exits.js': 'process.exitCode = 3;\n',
        'holds.js': 'async function run() { await new Promise(() => setInterval(() => undefined, 1000)); }\nvoid run();\n',
        'iife.js': '(async () => { await new Promise((resolve) => setTimeout(resolve, 60000)); })();\n',
      };
      for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(fakeDist, name), content);
      const names = findModulesThatMisbehaveWhenImported(fakeDist, Object.keys(files).sort(), { all: fakeTreeTimeoutMs, one: fakeTreeTimeoutMs }).map((line) => line.split(':')[0]);
      assert.deepEqual(names, ['exits.js', 'holds.js', 'iife.js', 'loud.js']);
    } finally {
      fs.rmSync(fakeDist, { recursive: true, force: true });
    }
  });
});

describe('run as the program, each entry module still runs', () => {
  const cases: Array<{ module: string; args: string[]; status: number; stdout: RegExp; stderr: RegExp }> = [
    { module: 'cli.js', args: ['nonsense'], status: 2, stdout: /^$/, stderr: /Unknown command: nonsense/ },
    { module: 'index.js', args: ['nonsense'], status: 2, stdout: /^$/, stderr: /Unknown command: nonsense/ },
    { module: 'runnerUtility/runnerCli.js', args: ['help'], status: 0, stdout: /^Usage:/, stderr: /^$/ },
    { module: 'runnerUtility/rootServiceCli.js', args: [], status: 2, stdout: /^$/, stderr: /Usage: rootServiceCli\.js install <account>/ },
    { module: 'stt/sttInstallEntry.js', args: [], status: 2, stdout: /^$/, stderr: /^$/ },
  ];

  for (const { module, args, status, stdout, stderr } of cases) {
    it(`node dist/${module} ${args.join(' ')}`.trim(), () => {
      const result = runNode([path.join(distRoot, module), ...args]);
      assert.equal(result.status, status, result.stderr);
      assert.match(result.stdout, stdout);
      assert.match(result.stderr, stderr);
    });
  }
});
