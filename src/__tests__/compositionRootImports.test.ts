/**
 * @description The decomposition of `bot.ts` only holds while the arrow points one way: `bot.ts` builds the
 * ports bag and calls the feature factories (`connectors/telegram/commands/`, `agentLogin/`); a feature module
 * never reaches back into `bot.ts`. Nothing else in the build would object to such an import — TypeScript
 * accepts the cycle, and because `bot.ts` runs `parseEnv()` at module scope, the module that imports it
 * also drags the whole boot into every test that imports the module. So the one legitimate loader of the
 * composition root, the CLI's startup, is pinned here and every other production module is policed.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

/** The composition root, as a resolved module path without its extension. */
const compositionRoot = path.posix.resolve('src/bot');

/** The only production module that may load the composition root (its `await import('../bot')` at boot). */
const allowedLoaders = new Set(['src/cli/bot.ts']);

/** Tests may import `bot.ts` behind their boot-env shim; they are not policed. */
const testDir = 'src/__tests__';

/** A static `from '…'` or a dynamic `import('…')` of a relative specifier. */
const relativeImportRe = /(?:from\s*|import\s*\(\s*)['"](\.[^'"]*)['"]/g;

function listSourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listSourceFiles(full));
    else if (entry.name.endsWith('.ts')) found.push(full);
  }
  return found;
}

/** @description The relative specifiers of `file` that resolve to the composition root. */
function getCompositionRootImports(file: string, source = fs.readFileSync(file, 'utf8')): string[] {
  return [...source.matchAll(relativeImportRe)]
    .map((match) => match[1])
    .filter((specifier) => path.posix.resolve(path.posix.dirname(file), specifier).replace(/\.(?:js|ts)$/, '') === compositionRoot);
}

function listPolicedFiles(): string[] {
  return listSourceFiles('src').filter((file) => !file.startsWith(`${testDir}/`) && file !== 'src/bot.ts');
}

test('no production module other than the CLI startup imports bot.ts', () => {
  const violations = listPolicedFiles()
    .filter((file) => !allowedLoaders.has(file))
    .flatMap((file) => getCompositionRootImports(file).map((specifier) => `${file} → ${specifier}`));

  assert.deepEqual(
    violations,
    [],
    `bot.ts was imported by a module it composes:\n  ${violations.join('\n  ')}\n` +
      'Pass what the module needs through its ports (`connectors/telegram/commands/botCore.ts`) instead.',
  );
});

test('the allowed loader still loads the composition root, and the detector sees it (proof it is not vacuous)', () => {
  for (const file of allowedLoaders) {
    assert.ok(fs.existsSync(file), `${file} no longer exists — move the allowance to the module that loads bot.ts`);
    assert.deepEqual(getCompositionRootImports(file), ['../bot'], `${file} was expected to load bot.ts; the detector may be broken`);
  }
  assert.ok(listPolicedFiles().length > 50, 'the policed set should cover the whole core');
});

test('the detector resolves a relative specifier, so a sibling module named bot is not a false hit', () => {
  // `src/cli/botEntry.ts` imports `./bot` — the CLI's own `src/cli/bot.ts`, not the composition root.
  assert.deepEqual(getCompositionRootImports('src/cli/botEntry.ts'), []);
  // A feature module reaching up to the root WOULD be caught.
  const plantedSource = "import { replyToThread } from '../../../bot';\n";
  assert.deepEqual(getCompositionRootImports('src/connectors/telegram/commands/reminders.ts', plantedSource), ['../../../bot']);
});
