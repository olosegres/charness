/**
 * @description Platform-seam S4 — the regression guard that keeps the boundary
 * from rotting.
 *
 * The seam is worth nothing without this test. Every one of the ~150 modules
 * outside `src/connectors/telegram/` is one `import { Markup } from 'telegraf'`
 * away from re-fusing the core to Telegram, and nothing else in the build would
 * object: it typechecks, it runs, and the next surface discovers it months
 * later.
 *
 * So: the Telegram LIBRARY may only be imported from inside the Telegram
 * connector. The exemptions below are explicit and are meant to shrink to zero;
 * a new file may never join them.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

/** The directory that owns the Telegram surface — the only place telegraf belongs. */
const connectorDir = 'src/connectors/telegram';

/**
 * Modules still awaiting relocation, with the reason each one is not moved yet.
 * This list is a DEBT LEDGER, not a configuration knob: adding an entry means
 * admitting a new platform leak, which is what this test exists to prevent.
 *
 * - `src/bot.ts` — composes the telegraf instance and still holds the command
 *   handlers' UI code. Moving it wholesale would drag the platform-neutral
 *   orchestration (session lifecycle, scheduling, MCP wiring) into the
 *   connector; splitting it is the follow-up decomposition plan's job.
 */
const exemptFiles = new Set(['src/bot.ts']);

/** Tests legitimately construct telegraf-shaped fixtures to feed the connector. */
const testDir = 'src/__tests__';

const telegramImportRe = /(?:from|import\(?)\s*['"](telegraf[^'"]*)['"]/g;

function listSourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listSourceFiles(full));
    else if (entry.name.endsWith('.ts')) found.push(full);
  }
  return found;
}

/** Every file the guard actually polices: source, outside the connector and outside tests. */
function listPolicedFiles(): string[] {
  return listSourceFiles('src').filter(
    (file) => !file.startsWith(`${connectorDir}/`) && !file.startsWith(`${testDir}/`),
  );
}

function getTelegramImports(file: string): string[] {
  const source = fs.readFileSync(file, 'utf8');
  return [...source.matchAll(telegramImportRe)].map((match) => match[1]);
}

test('no module outside the Telegram connector imports the Telegram library', () => {
  const violations = listPolicedFiles()
    .filter((file) => !exemptFiles.has(file))
    .flatMap((file) => getTelegramImports(file).map((specifier) => `${file} → ${specifier}`));

  assert.deepEqual(
    violations,
    [],
    `Telegram library imports leaked outside ${connectorDir}/:\n  ${violations.join('\n  ')}\n` +
      'Move the code into the connector, or route it through the platform seam ' +
      '(`src/platform/inbound.ts` / `src/platform/outbound.ts`).',
  );
});

test('the guard actually detects a violation (proof it is not vacuous)', () => {
  // A guard that silently matches nothing is worse than no guard. Prove the
  // detector fires by running it over a file that really does import telegraf.
  const connectorFile = `${connectorDir}/inbound.ts`;
  assert.ok(
    getTelegramImports(connectorFile).length > 0,
    `${connectorFile} was expected to import telegraf; the detector may be broken`,
  );
  // ...and that the policed set is the part of the tree that excludes it.
  assert.equal(listPolicedFiles().includes(connectorFile), false);
  assert.ok(listPolicedFiles().length > 50, 'the policed set should cover the whole core');
});

test('the exemption ledger only holds files that still exist and still need it', () => {
  for (const file of exemptFiles) {
    assert.ok(fs.existsSync(file), `exempt file ${file} no longer exists — drop it from the ledger`);
    assert.ok(
      getTelegramImports(file).length > 0,
      `exempt file ${file} no longer imports telegraf — drop it from the ledger`,
    );
  }
});
