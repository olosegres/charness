/**
 * @description Coverage for `src/changelogEntries.ts` — how a CHANGELOG section body splits into entries
 * (top-level paragraphs and list items, under their `###` subsection) and what counts as a bold lead.
 * Both the release gate and the what's-new summary read entries through it.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { checkHasBoldLead, getChangelogEntries } from '../changelogEntries';

test('a paragraph, wrapped lines included, is one entry', () => {
  const entries = getChangelogEntries(['**Headline.** First line of the', 'wrapped paragraph.', '', '**Second.** Alone.'].join('\n'));
  assert.deepEqual(
    entries.map((entry) => entry.text),
    ['**Headline.** First line of the wrapped paragraph.', '**Second.** Alone.'],
  );
});

test('a list item with indented continuation lines is one entry; its sub-bullet is not another', () => {
  const entries = getChangelogEntries(
    ['- **First.** Text that goes on', '  on the next line,', '  - a sub-bullet', '- **Second.** Short.'].join('\n'),
  );
  assert.equal(entries.length, 2);
  assert.equal(entries[0].text, '**First.** Text that goes on on the next line, - a sub-bullet');
  assert.equal(entries[1].text, '**Second.** Short.');
});

test('an indented paragraph after a blank line belongs to the list item above, not to a new entry', () => {
  const entries = getChangelogEntries(['- **Loose.** Opening.', '', '  More of the same item.', '', '- **Next.** Item.'].join('\n'));
  assert.deepEqual(
    entries.map((entry) => entry.text),
    ['**Loose.** Opening.', '**Next.** Item.'],
  );
});

test('every entry carries the ### subsection in force, null before the first heading', () => {
  const entries = getChangelogEntries(
    ['**Intro.** Before any subsection.', '', '### Upgrading', '- **Rename it.** Before 4.0.', '', '### Added', '- **New.** Thing.'].join('\n'),
  );
  assert.deepEqual(
    entries.map((entry) => entry.subsection),
    [null, 'Upgrading', 'Added'],
  );
});

test('a heading ends the entry above it and a fenced block at column 0 holds no entry', () => {
  const entries = getChangelogEntries(
    ['**Before.** Text.', '```', 'not an entry', '- not a bullet either', '```', '**After.** Text.', '### Fixed', 'Plain line.'].join('\n'),
  );
  assert.deepEqual(
    entries.map((entry) => entry.text),
    ['**Before.** Text.', '**After.** Text.', 'Plain line.'],
  );
});

test('numbered and starred list items are entries; the lead line is kept as written', () => {
  const entries = getChangelogEntries(['1. **One.** First.', '* **Two.** Second.'].join('\n'));
  assert.deepEqual(
    entries.map((entry) => [entry.leadLine, entry.text]),
    [
      ['1. **One.** First.', '**One.** First.'],
      ['* **Two.** Second.', '**Two.** Second.'],
    ],
  );
});

test('a bold lead is `**…**` opening the text, closing anywhere after, with no space inside the marks', () => {
  assert.equal(checkHasBoldLead('**Headline.** The rest.'), true);
  assert.equal(checkHasBoldLead('**A headline that wraps onto the next line.** The rest.'), true);
  assert.equal(checkHasBoldLead('**`/limits` is a board** now'), true);
  assert.equal(checkHasBoldLead('Plain start with **bold** later.'), false);
  assert.equal(checkHasBoldLead('**Never closed. The rest.'), false);
  assert.equal(checkHasBoldLead('** spaced **'), false);
  assert.equal(checkHasBoldLead(''), false);
});
