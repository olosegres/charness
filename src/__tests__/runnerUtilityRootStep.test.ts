/**
 * @description The admin pairing line's ROOT step (`runnerUtility/rootServiceCli.ts`) runs from a root-owned copy of the package unpacked
 * under `/tmp`, which has no `node_modules`. A module that is not a Node built-in would then be searched up the tree — `/tmp/node_modules`
 * included, a folder any local user can write — and found: local root code execution, where a missing module should only crash. So the
 * step's COMPILED import graph (every file it reaches, transpiled with the PROJECT's own compiler options — `tsconfig.json`, so an emit
 * option that adds a `require` (`importHelpers` → `tslib`) is seen — type-only imports gone) may name nothing but built-ins and the step's
 * own files. Also what the step is not: it does not reach the account's program or the pairing code.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { builtinModules } from 'node:module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import ts from 'typescript';
import { parseInstallArguments, runInstallCommand, type RootStepIo } from '../runnerUtility/rootServiceCli';
import type { AdminServiceDeps } from '../runnerUtility/adminService';
import type { IsolatedCommandRunner } from '../runnerUtility/isolatedCommand';

const projectRoot = path.resolve(__dirname, '..', '..');
const rootStepEntry = path.resolve(__dirname, '..', 'runnerUtility', 'rootServiceCli.ts');
const requirePattern = /require\((["'])([^"']+)\1\)/g;
const nodeBuiltins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

/** The compiler options `yarn build` uses: `tsconfig.json` as `tsc` reads it (its `extends` and enums resolved). */
function readProjectCompilerOptions(): ts.CompilerOptions {
  const configPath = path.join(projectRoot, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(config.error, undefined, 'tsconfig.json can be read');
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, projectRoot);
  assert.deepEqual(parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n')), [], 'tsconfig.json can be parsed');
  return parsed.options;
}

/** The modules `file` requires once compiled with `options`, split into the step's own files (relative) and the rest. */
function readCompiledRequires(file: string, options: ts.CompilerOptions): { relative: string[]; other: string[] } {
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), { fileName: file, compilerOptions: options }).outputText;
  const specifiers = [...compiled.matchAll(requirePattern)].map((match) => match[2]);
  return { relative: specifiers.filter((specifier) => specifier.startsWith('.')), other: specifiers.filter((specifier) => !specifier.startsWith('.')) };
}

/** Every source file the entry reaches through relative imports, in the order found, and every non-relative specifier with the file that names it. */
function walkImportGraph(entry: string, options: ts.CompilerOptions): { files: string[]; others: Array<{ specifier: string; file: string }> } {
  const files: string[] = [];
  const others: Array<{ specifier: string; file: string }> = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift() ?? '';
    if (files.includes(file)) continue;
    files.push(file);
    const { relative, other } = readCompiledRequires(file, options);
    for (const specifier of other) others.push({ specifier, file });
    for (const specifier of relative) queue.push(`${path.resolve(path.dirname(file), specifier)}.ts`);
  }
  return { files, others };
}

describe('the admin line\'s root step: built-ins only', () => {
  const options = readProjectCompilerOptions();
  const graph = walkImportGraph(rootStepEntry, options);
  const names = graph.files.map((file) => path.relative(path.resolve(__dirname, '..'), file).split(path.sep).join('/'));

  it('reaches only Node built-ins from outside its own files — nothing a `node_modules` could supply', () => {
    const notBuiltin = graph.others.filter(({ specifier }) => !nodeBuiltins.has(specifier));
    assert.deepEqual(notBuiltin.map(({ specifier, file }) => `${specifier} (from ${path.basename(file)})`), []);
  });

  it('is the small graph it is meant to be — and the walk really follows the imports (a deeper file would show here)', () => {
    assert.deepEqual([...names].sort(), [
      'runnerUtility/adminService.ts',
      'runnerUtility/homeFolders.ts',
      'runnerUtility/isolatedCommand.ts',
      'runnerUtility/pairArgs.ts',
      'runnerUtility/progress.ts',
      'runnerUtility/rootServiceCli.ts',
      'runnerUtility/runnerHome.ts',
      'runnerUtility/serviceCommon.ts',
      'runnerUtility/serviceUnits.ts',
      'selfUpdate/commandRunner.ts',
    ]);
  });

  it('the checker itself notices a package that is not a built-in — the account\'s own program (`runnerCommands.ts`) reaches some', () => {
    const accountProgram = walkImportGraph(path.resolve(__dirname, '..', 'runnerUtility', 'runnerCommands.ts'), options);
    const packages = new Set(accountProgram.others.map(({ specifier }) => specifier).filter((specifier) => !nodeBuiltins.has(specifier)));
    assert.ok(packages.has('zod') && packages.has('ssh2'), [...packages].join(', '));
  });
  it('uses the build\'s own compiler options: with `importHelpers` on, the same step would require `tslib` — and the walk sees it', () => {
    assert.equal(options.module, ts.ModuleKind.CommonJS, 'the options are the project\'s (commonjs), not defaults');
    assert.equal(options.importHelpers, undefined, 'the build adds no helper import today');
    // Down-levelled async code needs a helper (`__awaiter`): with helpers imported it comes from `tslib`.
    const withHelpers = walkImportGraph(rootStepEntry, { ...options, importHelpers: true, target: ts.ScriptTarget.ES2015 });
    assert.ok(withHelpers.others.some(({ specifier }) => specifier === 'tslib'), 'an emit option that adds a require is caught');
  });
});

describe('the root step\'s arguments', () => {
  it('takes `install <account>` alone (a service for an account that is paired) or with the pairing the admin line hands over: the package folder, the archive, the id and the code', () => {
    assert.deepEqual(parseInstallArguments(['install', 'runner']), { account: 'runner', pairRequest: null });
    assert.deepEqual(
      parseInstallArguments(['install', 'runner', '--bootstrap', '/tmp/x/pkg', '--archive', '/tmp/x/package.tgz', '--package-id', '0123456789abcdef', 'cr1.code']),
      { account: 'runner', pairRequest: { bootstrapDir: '/tmp/x/pkg', archivePath: '/tmp/x/package.tgz', packageId: '0123456789abcdef', code: 'cr1.code' } },
    );
  });

  it('refuses anything else — another command, no account, a half-given pairing, flags in another order or a stray word — so that nothing is guessed at as root', () => {
    for (const bad of [
      [],
      ['install'],
      ['uninstall', 'runner'],
      ['install', 'runner', '--bootstrap', '/tmp/x/pkg'],
      ['install', 'runner', '--archive', '/a', '--bootstrap', '/b', '--package-id', 'id', 'code'],
      ['install', 'runner', '--bootstrap', '/b', '--archive', '/a', '--package-id', 'id', 'code', 'extra'],
      ['install', 'runner', 'code'],
    ]) assert.equal(parseInstallArguments(bad), null, JSON.stringify(bad));
  });
});

describe('the root step\'s whole run', () => {
  interface Run { code: number; out: string; err: string; calls: string[] }

  /** `args` run against a root step whose account calls are answered by `answerFor` (by the call's text), and whose homes the account can read are `readableHomes`. */
  async function run(args: readonly string[], answerFor: (call: string) => boolean = () => true, readableHomes: readonly string[] = []): Promise<Run> {
    const calls: string[] = [];
    let out = '';
    let err = '';
    const runner: IsolatedCommandRunner = async (file, callArgs) => {
      const call = `${file} ${callArgs.join(' ')}`;
      calls.push(call);
      const isHomeCheck = call.includes(' test -r ');
      const isOk = isHomeCheck ? readableHomes.some((home) => call.includes(`test -r ${home} `)) : answerFor(call);
      return { ok: isOk, exitCode: isOk ? 0 : 1, stdout: call.includes('system-step prepare') ? '{"ok":true,"hadService":false}\n' : '', stderr: '', isTimedOut: false };
    };
    const deps: AdminServiceDeps = {
      runner,
      write: (stream, text) => { if (stream === 'stdout') out += text; else err += text; },
      nodePath: '/opt/homebrew/bin/node',
      runnerCliPath: '/tmp/charness-runner.x/pkg/dist/runnerUtility/runnerCli.js',
      platform: 'darwin',
      uid: 0,
      nodeDir: '/opt/homebrew/bin',
      launchDaemonsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rs-')),
      giveToRoot: () => undefined,
      resolveAccount: async (name) => ({ name, uid: 501, gid: 20, homeDir: `/Users/${name}` }),
      sleep: async () => undefined,
      listFolders: (parent) => (parent === '/Users' ? ['alice', 'runner'] : []),
    };
    const io: RootStepIo = { stdout: (text) => { out += text; }, stderr: (text) => { err += text; }, runStep: async (_label, work) => work() };
    try {
      const code = await runInstallCommand(args, deps, io);
      return { code, out, err, calls };
    } finally {
      fs.rmSync(deps.launchDaemonsDir, { recursive: true, force: true });
    }
  }

  const pairingArgs = ['install', 'runner', '--bootstrap', '/tmp/x/pkg', '--archive', '/tmp/x/package.tgz', '--package-id', '0123456789abcdef', 'cr1.code'];

  it('prints the usage and exits 2 for arguments it does not know — and runs nothing', async () => {
    const result = await run(['install']);
    assert.equal(result.code, 2);
    assert.match(result.err, /^Usage: rootServiceCli\.js install <account>/);
    assert.deepEqual(result.calls, []);
  });

  it('pairs first, then installs the service, then — last — warns about the homes of other users that the account can read, naming them with the fix', async () => {
    const result = await run(pairingArgs, () => true, ['/Users/alice']);
    assert.equal(result.code, 0, result.err);
    const pairing = result.calls.findIndex((call) => call.includes('runnerCli.js pair'));
    const service = result.calls.findIndex((call) => call.includes('system-step prepare'));
    const homes = result.calls.findIndex((call) => call.includes(' test -r '));
    assert.ok(pairing === 0 && service > pairing && homes > service, result.calls.join('\n'));
    assert.match(result.out, /\nWarning: the account runner can read the home folders of other users on this machine: \/Users\/alice\.[^]*sudo chmod 700 \/Users\/alice\n$/);
  });

  it('says nothing about homes when the account can read none', async () => {
    const result = await run(pairingArgs, () => true, []);
    assert.equal(result.code, 0);
    assert.doesNotMatch(result.out + result.err, /Warning/);
  });

  it('a failed pairing ends the step: no service, no warning, exit 1', async () => {
    const result = await run(pairingArgs, (call) => !call.includes('runnerCli.js pair'), ['/Users/alice']);
    assert.equal(result.code, 1);
    assert.match(result.err, /The pairing of runner failed \(exit 1\); see above\./);
    assert.deepEqual(result.calls.filter((call) => call.includes('system-step') || call.includes('launchctl') || call.includes(' test -r ')), []);
    assert.doesNotMatch(result.out, /Warning/);
  });

  it('a failed service after a pairing says the account is paired and what to do — and still warns about the homes: the account is paired and can read them', async () => {
    const result = await run(pairingArgs, (call) => !call.includes('launchctl'), ['/Users/alice']);
    assert.equal(result.code, 1);
    assert.match(result.err, /charness-runner: runner is paired, but has no service: fix the above and paste a fresh admin line\n$/m);
    assert.match(result.out, /Warning: the account runner can read/);
  });

  it('without the pairing arguments it only installs the service of an account that is paired, and says no «paired, but» about it', async () => {
    const result = await run(['install', 'runner'], (call) => !call.includes('launchctl'));
    assert.equal(result.code, 1);
    assert.ok(!result.calls.some((call) => call.includes('runnerCli.js pair')));
    assert.doesNotMatch(result.err, /is paired, but has no service/);
  });
});

