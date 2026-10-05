/**
 * @description R20 (Jira connector plan J4b): Jira code loads only when the Jira
 * connector is on. Nothing `bot.ts` imports statically — directly or through
 * any module it imports — may reach the Markdown → ADF stack (`marklassian`,
 * `marked`): a Telegram-only instance must not load it, and an older Node
 * cannot. The Jira connector is reached through a dynamic `import()` instead,
 * which this static walk does not follow.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const srcDir = path.join(__dirname, '..');
/** Value imports and re-exports; `import type` / `export type` are erased and load nothing. */
const staticImportRe = /^\s*(?:import|export)\s+(?!type\b)(?:[^;'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;
const jiraOnlyPackages = ['marklassian', 'marked'];

function getResolvedModule(fromFile: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(fromFile), specifier);
  return [`${base}.ts`, path.join(base, 'index.ts')].find((candidate) => fs.existsSync(candidate)) ?? null;
}

/** Every project module and package reachable from `entry` through static value imports. */
function getStaticClosure(entry: string): { modules: Set<string>; packages: Set<string> } {
  const modules = new Set<string>();
  const packages = new Set<string>();
  const pending = [path.join(srcDir, entry)];
  while (pending.length > 0) {
    const file = pending.pop() ?? '';
    if (modules.has(file)) continue;
    modules.add(file);
    for (const [, specifier] of fs.readFileSync(file, 'utf8').matchAll(staticImportRe)) {
      if (specifier.startsWith('.')) {
        const resolved = getResolvedModule(file, specifier);
        assert.ok(resolved, `${path.relative(srcDir, file)} imports ${specifier}, which does not resolve`);
        pending.push(resolved);
      } else {
        packages.add(specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]);
      }
    }
  }
  return { modules, packages };
}

describe('Jira code loads only with the Jira connector (R20)', () => {
  it('nothing bot.ts imports statically reaches marklassian or marked', () => {
    const { modules, packages } = getStaticClosure('bot.ts');
    assert.ok(modules.size > 50 && packages.has('telegraf'), 'the walk is not vacuous');
    assert.deepEqual(jiraOnlyPackages.filter((name) => packages.has(name)), []);
  });

  it('the walk sees through a module that does import them', () => {
    const { packages } = getStaticClosure('connectors/jira/client.ts');
    assert.ok(packages.has('marklassian'), 'client.ts → adf.ts → marklassian');
  });
});
