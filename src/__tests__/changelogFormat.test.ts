/**
 * @description The repository's own `CHANGELOG.md`: the `## Unreleased` section must follow the entry format
 * the release gate enforces (every top-level entry starts with a bold first sentence). The daily release fails
 * on a violating entry, so a commit that adds one fails here first, where the author sees it.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getChangelogFormatViolations, getUnreleasedSection, unreleasedHeading } from '../release/releasePlan';

test('every entry under ## Unreleased starts with a bold first sentence', () => {
  const section = getUnreleasedSection(fs.readFileSync(path.resolve(__dirname, '..', '..', 'CHANGELOG.md'), 'utf8'));
  assert.notEqual(section, null, `CHANGELOG.md has no "${unreleasedHeading}" heading`);
  assert.deepEqual(getChangelogFormatViolations(section ?? ''), []);
});
