/**
 * @description The admin pairing line's ROOT step (`runnerUtility/rootServiceCli.ts`) runs from a root-owned copy of the package unpacked
 * under `/tmp`, which has no `node_modules`. A module that is not a Node built-in would then be searched up the tree — `/tmp/node_modules`
 * included, a folder any local user can write — and found: local root code execution, where a missing module should only crash. So the
 * step's COMPILED import graph (every file it reaches, transpiled the way `tsc` does, type-only imports gone) may name nothing but
 * built-ins and the step's own files. Also what the step is not: it does not reach the account's program or the pairing code.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { builtinModules } from 'node:module';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const rootStepEntry = path.resolve(__dirname, '..', 'runnerUtility', 'rootServiceCli.ts');
const requirePattern = /require\((["'])([^"']+)\1\)/g;
const nodeBuiltins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

/** The modules `file` requires once compiled, split into the step's own files (relative) and the rest. */
function readCompiledRequires(file: string): { relative: string[]; other: string[] } {
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), { fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const specifiers = [...compiled.matchAll(requirePattern)].map((match) => match[2]);
  return { relative: specifiers.filter((specifier) => specifier.startsWith('.')), other: specifiers.filter((specifier) => !specifier.startsWith('.')) };
}

/** Every source file the entry reaches through relative imports, in the order found, and every non-relative specifier with the file that names it. */
function walkImportGraph(entry: string): { files: string[]; others: Array<{ specifier: string; file: string }> } {
  const files: string[] = [];
  const others: Array<{ specifier: string; file: string }> = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift() ?? '';
    if (files.includes(file)) continue;
    files.push(file);
    const { relative, other } = readCompiledRequires(file);
    for (const specifier of other) others.push({ specifier, file });
    for (const specifier of relative) queue.push(`${path.resolve(path.dirname(file), specifier)}.ts`);
  }
  return { files, others };
}

describe('the admin line\'s root step: built-ins only', () => {
  const graph = walkImportGraph(rootStepEntry);
  const names = graph.files.map((file) => path.relative(path.resolve(__dirname, '..'), file).split(path.sep).join('/'));

  it('reaches only Node built-ins from outside its own files — nothing a `node_modules` could supply', () => {
    const notBuiltin = graph.others.filter(({ specifier }) => !nodeBuiltins.has(specifier));
    assert.deepEqual(notBuiltin.map(({ specifier, file }) => `${specifier} (from ${path.basename(file)})`), []);
  });

  it('is the small graph it is meant to be — and the walk really follows the imports (a deeper file would show here)', () => {
    assert.deepEqual([...names].sort(), [
      'runnerUtility/adminService.ts',
      'runnerUtility/rootServiceCli.ts',
      'runnerUtility/runnerHome.ts',
      'runnerUtility/serviceCommon.ts',
      'runnerUtility/serviceUnits.ts',
      'selfUpdate/commandRunner.ts',
    ]);
  });

  it('the checker itself notices a package that is not a built-in — the account\'s own program (`runnerCommands.ts`) reaches some', () => {
    const accountProgram = walkImportGraph(path.resolve(__dirname, '..', 'runnerUtility', 'runnerCommands.ts'));
    const packages = new Set(accountProgram.others.map(({ specifier }) => specifier).filter((specifier) => !nodeBuiltins.has(specifier)));
    assert.ok(packages.has('zod') && packages.has('ssh2'), [...packages].join(', '));
  });
});
