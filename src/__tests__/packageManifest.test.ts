/**
 * @description The repository's own `package.json`: the `bin` targets are written without a leading "./". npm >= 11.10 drops a
 * "./dist/…" entry from the manifest it publishes — only a warning, exit 0 — and 3.3.0 reached the registry with no command at
 * all. The release refuses the same thing at publish time (`check-pack`, `check-publish`); this fails first, where the author sees it.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getInvalidBinPaths, type PackageManifest } from '../release/releasePlan';

test('package.json declares at least one command and no bin path starts with "./"', () => {
  const manifest: PackageManifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8'));
  assert.ok(manifest.bin !== undefined && Object.keys(manifest.bin).length > 0, 'package.json has a bin entry');
  assert.deepEqual(getInvalidBinPaths(manifest.bin), []);
});
