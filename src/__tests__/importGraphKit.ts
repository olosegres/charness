/**
 * @description The compiled import graph of a program: what a source file requires once transpiled with the PROJECT's own compiler options
 * (`tsconfig.json`, so an emit option that adds a `require` — `importHelpers` → `tslib` — is seen, and type-only imports are gone), followed through
 * its own relative imports. Tests use it to say what a program that runs from a copy of the package can reach: the root step may reach nothing
 * but Node built-ins, the runner program only the packages its lock holds.
 */

import { builtinModules } from 'node:module';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import assert from 'node:assert/strict';

export const projectRoot = path.resolve(__dirname, '..', '..');
const requirePattern = /require\((["'])([^"']+)\1\)/g;
export const nodeBuiltins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

/** The compiler options `yarn build` uses: `tsconfig.json` as `tsc` reads it (its `extends` and enums resolved). */
export function readProjectCompilerOptions(): ts.CompilerOptions {
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
export function walkImportGraph(entry: string, options: ts.CompilerOptions): { files: string[]; others: Array<{ specifier: string; file: string }> } {
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

/** @description The package a bare specifier names: `zod/v4` is `zod`, `@scope/pkg/sub` is `@scope/pkg`. */
export function getPackageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}
