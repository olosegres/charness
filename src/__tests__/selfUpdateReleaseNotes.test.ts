/**
 * @description Coverage for `src/selfUpdate/releaseNotes.ts` — the what's-new summary: the bold first sentence of each
 * entry, grouped by version, `### Upgrading` first as "to do", at most 8 items then a count of the rest, links reduced
 * to their text; for a checkout, only the ADDED entries of a `git diff` of the CHANGELOG.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { getCheckoutReleaseNotes, getEntryHeadline, getNpmReleaseNotes } from '../selfUpdate/releaseNotes';

const changelog = [
  '# Changelog',
  '',
  '## Unreleased',
  '',
  '**Not released yet.** Must never show.',
  '',
  '## 3.4.0 — 2026-10-20',
  '',
  '**`/limits` is a switch board: every account and provider with its usage.** More detail',
  'on a second line.',
  '',
  '### Upgrading',
  '- **Rename the `TELEGRAMCODE_*` variables before 4.0.** See [the guide](MIGRATION_RENAME_TO_CHARNESS.md).',
  '',
  '### Added',
  '- **A new board.** Details.',
  '',
  '## 3.3.0 — 2026-10-18',
  '',
  '**A conversation whose transcript was cleaned up no longer kills the topic\'s agent.** Details.',
  '',
  '### Fixed',
  '- Plain old entry without a bold lead. Second sentence.',
  '',
  '## 3.2.0 — 2026-10-16',
  '',
  '**Renamed.** Old news.',
  '',
  '## Earlier changes, shipped in the 2.0.x packages',
  '',
  '**Ancient.** Not a version section.',
  '',
].join('\n');

describe('the headline of an entry', () => {
  test('is its bold first sentence, links reduced to their text, code marks dropped', () => {
    assert.equal(getEntryHeadline('**`/limits` is a switch board.** More.'), '/limits is a switch board.');
    assert.equal(getEntryHeadline('**See [the guide](a.md) first.** More.'), 'See the guide first.');
    assert.equal(getEntryHeadline('**Wrapped over\ntwo lines.** More.'), 'Wrapped over two lines.');
  });

  test('without a bold lead it is the first sentence, cut at 200 characters', () => {
    assert.equal(getEntryHeadline('Plain old entry. Second sentence.'), 'Plain old entry.');
    assert.equal(getEntryHeadline('No full stop here'), 'No full stop here');
    const long = getEntryHeadline(`${'word '.repeat(80)}end`);
    assert.equal(long.length, 200);
    assert.ok(long.endsWith('…'));
  });
});

describe('npm: the versions between from and to', () => {
  test('lists every skipped version\'s headlines oldest first, Upgrading entries first as the to-do', () => {
    const notes = getNpmReleaseNotes(changelog, '3.2.0', '3.4.0');
    assert.deepEqual(notes, {
      todo: ['Rename the TELEGRAMCODE_* variables before 4.0.'],
      groups: [
        { version: '3.3.0', headlines: ["A conversation whose transcript was cleaned up no longer kills the topic's agent.", 'Plain old entry without a bold lead.'] },
        { version: '3.4.0', headlines: ['/limits is a switch board: every account and provider with its usage.', 'A new board.'] },
      ],
      moreCount: 0,
    });
  });

  test('from is exclusive, to is inclusive, Unreleased and non-version headings never count', () => {
    const notes = getNpmReleaseNotes(changelog, '3.3.0', '3.4.0');
    assert.deepEqual(
      notes?.groups.map((group) => group.version),
      ['3.4.0'],
    );
    assert.equal(getNpmReleaseNotes(changelog, '3.2.0', '3.3.0')?.todo.length, 0);
    assert.ok(!JSON.stringify(getNpmReleaseNotes(changelog, '0.0.1', '9.9.9')).includes('Not released yet'));
    assert.ok(!JSON.stringify(getNpmReleaseNotes(changelog, '0.0.1', '9.9.9')).includes('Ancient'));
  });

  test('at most 8 items, to-do first, then the rest of the count', () => {
    // The to-do entry comes LAST in the file: only a to-do-first order keeps it inside the cap.
    const many = ['## 3.4.0 — x', '', '### Added', ...Array.from({ length: 12 }, (_, index) => `- **Item ${index + 1}.** x`), '', '### Upgrading', '- **Do this.** x'].join('\n');
    const notes = getNpmReleaseNotes(many, '3.3.0', '3.4.0');
    assert.deepEqual(notes?.todo, ['Do this.']);
    assert.equal(notes?.groups[0].headlines.length, 7);
    assert.equal(notes?.groups[0].headlines[0], 'Item 1.');
    assert.equal(notes?.moreCount, 5);
  });

  test('no CHANGELOG text, no section in range, or nothing in it → no list', () => {
    assert.equal(getNpmReleaseNotes('', '3.2.0', '3.4.0'), null);
    assert.equal(getNpmReleaseNotes(changelog, '3.4.0', '3.4.0'), null);
    assert.equal(getNpmReleaseNotes('## 3.4.0 — x\n\n', '3.3.0', '3.4.0'), null);
  });
});

describe('a checkout: the lines a git diff of CHANGELOG.md added', () => {
  const header = ['diff --git a/CHANGELOG.md b/CHANGELOG.md', 'index 1111111..2222222 100644', '--- a/CHANGELOG.md', '+++ b/CHANGELOG.md', '@@ -1,12 +1,16 @@'];

  test('only entries whose first line is added count; an Upgrading entry added under an existing heading is still a to-do', () => {
    const diff = [
      ...header,
      ' # Changelog',
      ' ',
      ' ## Unreleased',
      ' ',
      ' **Already known.** Was in the checkout before.',
      ' ',
      '+**A new headline.** Details',
      '+on a second line.',
      '+',
      ' ### Upgrading',
      '+- **Run the migration.** Then restart.',
      ' - **An older to-do.** Known.',
      ' ',
      ' ### Fixed',
      '+- **A new fix.** Details.',
      '-- old line removed',
      '\\ No newline at end of file',
    ].join('\n');
    assert.deepEqual(getCheckoutReleaseNotes(diff), {
      todo: ['Run the migration.'],
      groups: [{ version: null, headlines: ['A new headline.', 'A new fix.'] }],
      moreCount: 0,
    });
  });

  test('a diff that adds no entry, or an empty one, gives no list', () => {
    assert.equal(getCheckoutReleaseNotes(''), null);
    assert.equal(getCheckoutReleaseNotes([...header, ' ## Unreleased', '+', ' **Known.** x'].join('\n')), null);
  });

  test('capped like the npm list', () => {
    const added = Array.from({ length: 10 }, (_, index) => `+**Item ${index + 1}.** x\n+`);
    const notes = getCheckoutReleaseNotes([...header, ' ## Unreleased', ' ', ...added.join('\n').split('\n')].join('\n'));
    assert.equal(notes?.groups[0].headlines.length, 8);
    assert.equal(notes?.moreCount, 2);
  });
});
