/**
 * @description `selfUpdate/emittedSource.ts` names the sources `tsc` compiles — by a list of excluded `src/` directories that
 * DUPLICATES `tsconfig.json`'s `exclude`. The list now drives the hot supervisor's decision to restart its watcher
 * (`cli/tscWatchGuard.ts`), so a directory excluded in one place and not the other would keep a source "newer than its output" for
 * ever. This test keeps the two equal: every `src/…/**` entry of the real `exclude` is a prefix of the list, and the list holds
 * nothing else.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkIsEmittedSource, unemittedSourcePrefixes } from '../selfUpdate/emittedSource';

interface TsConfigExclusions {
  exclude?: string[];
}

const wildcardSuffix = '/**';
const sourceRoot = 'src/';

describe('the compiled-source rule against tsconfig.json', () => {
  const tsconfig: TsConfigExclusions = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'tsconfig.json'), 'utf8'));
  const excludedSourceDirectories = (tsconfig.exclude ?? [])
    .filter((pattern) => pattern.startsWith(sourceRoot) && pattern.endsWith(wildcardSuffix))
    .map((pattern) => `${pattern.slice(0, -wildcardSuffix.length)}/`);

  test('the excluded src/ directories of tsconfig.json are exactly the ones the rule skips', () => {
    assert.ok(excludedSourceDirectories.length > 0, 'the walk is not vacuous');
    assert.deepEqual([...unemittedSourcePrefixes].sort(), excludedSourceDirectories.sort());
  });

  test('a source in an excluded directory is not compiled, any other .ts under src/ is', () => {
    for (const directory of excludedSourceDirectories) assert.equal(checkIsEmittedSource(`${directory}anything.ts`), false, directory);
    assert.equal(checkIsEmittedSource('src/bot.ts'), true);
    assert.equal(checkIsEmittedSource('src/cli/hot.ts'), true);
  });
});
