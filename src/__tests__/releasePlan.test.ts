/**
 * @description Coverage for `src/release/releasePlan.ts` — the pure decisions of the daily npm release:
 * the version rule, the skip rules, the breaking-change guard, what ships, the CHANGELOG rewrite and the
 * pack check. Each case is a row of the release plan's VERIFICATION table.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  ReleaseError,
  checkHasShippedChange,
  checkIsShippedManifestChange,
  checkIsShippedPath,
  createChangelogRelease,
  createReleasePlan,
  getChangelogFallback,
  getChangelogFormatViolations,
  getInvalidBinPaths,
  getNextVersion,
  getPackViolations,
  getPublishDryRunProblems,
  getReleaseBump,
  getReleaseDate,
  getReleaseNotes,
  getUnreleasedSection,
  requiredPackFiles,
  type ChangelogFallback,
  type PackListing,
  type ReleaseChangeSet,
  type ReleaseCommit,
  type ReleaseRequest,
} from '../release/releasePlan';

const lastTag = 'v3.2.0';
const autoRequest: ReleaseRequest = { bump: 'auto', force: false };
const noFallback: ChangelogFallback = { added: [], fixed: [] };
const shippedPaths = ['src/bot.ts'];
let commitCounter = 0;

function createCommit(subject: string, paths: string[] = shippedPaths, overrides: Partial<ReleaseCommit> = {}): ReleaseCommit {
  commitCounter += 1;
  return {
    hash: commitCounter.toString(16).padStart(40, '0'),
    subject,
    body: '',
    paths,
    changesShippedManifest: false,
    ...overrides,
  };
}

function createNetDiff(paths: string[], changesShippedManifest = false): ReleaseChangeSet {
  return { paths, changesShippedManifest };
}

function plan(commits: ReleaseCommit[], overrides: Partial<Parameters<typeof createReleasePlan>[0]> = {}) {
  return createReleasePlan({
    lastTag,
    commitsSinceTag: commits,
    netDiff: createNetDiff(commits.flatMap((commit) => commit.paths)),
    isHeadTagged: false,
    input: autoRequest,
    ...overrides,
  });
}

describe('what ships', () => {
  test('source, the STT sidecar and nothing else under the shipped roots', () => {
    assert.equal(checkIsShippedPath('src/bot.ts'), true);
    assert.equal(checkIsShippedPath('src/adapters/claudeCliAdapter.ts'), true);
    assert.equal(checkIsShippedPath('stt/gigaam_sidecar.py'), true);
    assert.equal(checkIsShippedPath('src/__tests__/bot.test.ts'), false);
    assert.equal(checkIsShippedPath('src/release/releasePlan.ts'), false);
    assert.equal(checkIsShippedPath('src/platform/README.md'), false);
    assert.equal(checkIsShippedPath('README.md'), false);
    assert.equal(checkIsShippedPath('SETUP.md'), false);
    assert.equal(checkIsShippedPath('CHANGELOG.md'), false);
    assert.equal(checkIsShippedPath('package.json'), false);
    assert.equal(checkIsShippedPath('scripts/self-update.sh'), false);
    assert.equal(checkIsShippedPath('.github/workflows/publish.yml'), false);
  });

  test('package.json ships only when dependencies, bin, engines, files or main differ', () => {
    const base = { dependencies: { zod: '^4.0.0' }, bin: { charness: './dist/cli.js' }, engines: { node: '>=22' }, files: ['dist/'], main: 'dist/cli.js' };
    assert.equal(checkIsShippedManifestChange(base, { ...base }), false);
    assert.equal(checkIsShippedManifestChange(base, { ...base, dependencies: { zod: '^4.1.0' } }), true);
    assert.equal(checkIsShippedManifestChange(base, { ...base, bin: { charness: './dist/other.js' } }), true);
    assert.equal(checkIsShippedManifestChange(base, { ...base, engines: { node: '>=24' } }), true);
    assert.equal(checkIsShippedManifestChange(base, { ...base, files: ['dist/', 'CHANGELOG.md'] }), true);
    assert.equal(checkIsShippedManifestChange(base, { ...base, main: 'dist/index.js' }), true);
    assert.equal(checkIsShippedManifestChange(base, null), true);
  });

  test('a change set ships through a shipped path or a shipped manifest change', () => {
    assert.equal(checkHasShippedChange(createNetDiff(['README.md', 'src/__tests__/a.test.ts'])), false);
    assert.equal(checkHasShippedChange(createNetDiff(['README.md', 'src/bot.ts'])), true);
    assert.equal(checkHasShippedChange(createNetDiff(['package.json'], true)), true);
    assert.equal(checkHasShippedChange(createNetDiff(['package.json'], false)), false);
  });
});

describe('the version rule', () => {
  test('a feat that changes shipped code is a minor', () => {
    assert.deepEqual(getReleaseBump([createCommit('fix: a'), createCommit('feat(limits): b')]), { kind: 'bump', level: 'minor' });
  });

  test('fix, perf, refactor, revert and chore are a patch', () => {
    const commits = ['fix: a', 'perf: b', 'refactor(x): c', 'revert: d', 'chore: e', 'not conventional at all'].map((subject) => createCommit(subject));
    assert.deepEqual(getReleaseBump(commits), { kind: 'bump', level: 'patch' });
  });

  test('a feat that touches no shipped path does not make a minor', () => {
    assert.deepEqual(getReleaseBump([createCommit('feat(release): the workflow', ['.github/workflows/publish.yml', 'src/release/cli.ts'])]), {
      kind: 'bump',
      level: 'patch',
    });
  });

  test('a feat that changes the shipped manifest makes a minor', () => {
    const commit = createCommit('feat: a dependency', ['package.json'], { changesShippedManifest: true });
    assert.deepEqual(getReleaseBump([commit]), { kind: 'bump', level: 'minor' });
  });

  test('chore(release) commits never count — not as a feat, not as breaking', () => {
    const commits = [createCommit('chore(release): 3.3.0', ['package.json', 'CHANGELOG.md']), createCommit('chore(release)!: odd', [], { body: 'BREAKING CHANGE: x' })];
    assert.deepEqual(getReleaseBump(commits), { kind: 'bump', level: 'patch' });
  });

  test('a `!` after the type or scope marks a breaking commit, whatever its type', () => {
    const feature = createCommit('feat!: drop the old command');
    const scoped = createCommit('fix(limits)!: new reset rule');
    const docs = createCommit('docs!: reword', ['README.md']);
    assert.deepEqual(getReleaseBump([createCommit('fix: ok'), feature, scoped, docs]), { kind: 'breaking', commits: [feature, scoped, docs] });
  });

  test('a BREAKING CHANGE footer in any commit marks it breaking; the text mid-line does not', () => {
    const footer = createCommit('refactor: move it', shippedPaths, { body: 'Moved.\n\nBREAKING CHANGE: the config key is gone' });
    const hyphen = createCommit('fix: x', shippedPaths, { body: 'BREAKING-CHANGE: also a footer' });
    const midLine = createCommit('fix: y', shippedPaths, { body: 'this is not a BREAKING CHANGE: footer' });
    assert.deepEqual(getReleaseBump([footer, hyphen, midLine]), { kind: 'breaking', commits: [footer, hyphen] });
  });

  test('versions step by level and refuse a non-plain version', () => {
    assert.equal(getNextVersion('3.2.0', 'patch'), '3.2.1');
    assert.equal(getNextVersion('3.2.9', 'minor'), '3.3.0');
    assert.equal(getNextVersion('3.2.9', 'major'), '4.0.0');
    assert.equal(getNextVersion('3.2', 'patch'), null);
    assert.equal(getNextVersion('3.2.0-beta.1', 'patch'), null);
  });
});

describe('the plan of a run', () => {
  test('a feat touching src since v3.2.0 → minor 3.3.0', () => {
    assert.deepEqual(plan([createCommit('fix: a'), createCommit('feat: b')]), { kind: 'release', version: '3.3.0', bump: 'minor' });
  });

  test('only fixes and refactors touching src → patch 3.2.1', () => {
    assert.deepEqual(plan([createCommit('fix: a'), createCommit('refactor: b')]), { kind: 'release', version: '3.2.1', bump: 'patch' });
  });

  test('docs-only and tests-only commits → skip', () => {
    const commits = [createCommit('docs: a', ['README.md']), createCommit('test: b', ['src/__tests__/x.test.ts']), createCommit('docs: c', ['SETUP.md', 'CHANGELOG.md'])];
    const result = plan(commits);
    assert.equal(result.kind, 'skip');
    assert.match(result.kind === 'skip' ? result.reason : '', /Nothing shipped changed since v3\.2\.0/);
  });

  test('a change and its revert leave an empty net diff → skip', () => {
    const commits = [createCommit('feat: a'), createCommit('revert: a')];
    assert.equal(plan(commits, { netDiff: createNetDiff([]) }).kind, 'skip');
  });

  test('package.json changed only in scripts or devDependencies → skip; a dependencies change → patch', () => {
    const scriptsOnly = createCommit('chore: scripts', ['package.json']);
    assert.equal(plan([scriptsOnly], { netDiff: createNetDiff(['package.json'], false) }).kind, 'skip');
    const withDependency = createCommit('chore: bump a dependency', ['package.json'], { changesShippedManifest: true });
    assert.deepEqual(plan([withDependency], { netDiff: createNetDiff(['package.json'], true) }), { kind: 'release', version: '3.2.1', bump: 'patch' });
  });

  test('a feat!: commit, bump auto → fail naming the commit; nothing to tag', () => {
    const breaking = createCommit('feat!: drop it');
    const result = plan([createCommit('fix: a'), breaking]);
    assert.equal(result.kind, 'fail');
    const message = result.kind === 'fail' ? result.message : '';
    assert.ok(message.includes(breaking.hash.slice(0, 7)));
    assert.ok(message.includes('feat!: drop it'));
    assert.ok(message.includes('bump=major'));
  });

  test('force does not override the breaking-change guard of an automatic bump', () => {
    const result = plan([createCommit('fix!: x')], { input: { bump: 'auto', force: true } });
    assert.equal(result.kind, 'fail');
  });

  test('bump=major releases 4.0.0, breaking commits or not', () => {
    assert.deepEqual(plan([createCommit('fix: a')], { input: { bump: 'major', force: false } }), { kind: 'release', version: '4.0.0', bump: 'major' });
    assert.deepEqual(plan([createCommit('feat!: a')], { input: { bump: 'major', force: false } }), { kind: 'release', version: '4.0.0', bump: 'major' });
  });

  test('an explicit patch or minor releases as asked, even over a breaking marker', () => {
    const commits = [createCommit('feat!: a')];
    assert.deepEqual(plan(commits, { input: { bump: 'patch', force: false } }), { kind: 'release', version: '3.2.1', bump: 'patch' });
    assert.deepEqual(plan(commits, { input: { bump: 'minor', force: false } }), { kind: 'release', version: '3.3.0', bump: 'minor' });
  });

  test('an explicit bump still obeys the skip rules without force', () => {
    const result = plan([createCommit('docs: a', ['README.md'])], { input: { bump: 'minor', force: false } });
    assert.equal(result.kind, 'skip');
  });

  test('HEAD already carrying a release tag → skip', () => {
    const result = plan([], { isHeadTagged: true });
    assert.deepEqual(result, { kind: 'skip', reason: 'HEAD already carries a release tag (v3.2.0).' });
  });

  test('no commits since the last tag, or only release commits → skip', () => {
    assert.deepEqual(plan([]), { kind: 'skip', reason: 'No commits since v3.2.0.' });
    const releaseOnly = [createCommit('chore(release): 3.2.0', ['package.json'])];
    assert.equal(plan(releaseOnly).kind, 'skip');
  });

  test('force on a docs-only day → a patch release', () => {
    const commits = [createCommit('docs: a', ['README.md'])];
    assert.deepEqual(plan(commits, { input: { bump: 'auto', force: true } }), { kind: 'release', version: '3.2.1', bump: 'patch' });
  });

  test('force releases even with HEAD tagged', () => {
    assert.deepEqual(plan([], { isHeadTagged: true, input: { bump: 'auto', force: true } }), { kind: 'release', version: '3.2.1', bump: 'patch' });
  });

  test('no release tag in the history, or one that is not X.Y.Z → fail', () => {
    assert.equal(plan([createCommit('fix: a')], { lastTag: null }).kind, 'fail');
    assert.equal(plan([createCommit('fix: a')], { lastTag: 'v3.2' }).kind, 'fail');
  });
});

describe('the release date', () => {
  test('is the Tbilisi calendar day, not the UTC one', () => {
    assert.equal(getReleaseDate(new Date('2026-10-22T21:00:00Z')), '2026-10-23');
    assert.equal(getReleaseDate(new Date('2026-10-22T19:59:59Z')), '2026-10-22');
  });
});

describe('the CHANGELOG rewrite', () => {
  const changelog = [
    '# Changelog',
    '',
    '## Unreleased',
    '',
    '**A hand-written headline.** Its details.',
    '',
    '### Fixed',
    '- **A fix.** Details.',
    '',
    '## 3.2.0 — 2026-10-16',
    '',
    '**Older.** Not checked, even if it breaks the rule:',
    '- not bold',
    '',
  ].join('\n');

  test('the Unreleased entries become the dated version section with a fresh empty Unreleased above', () => {
    const { changelog: rewritten, notes } = createChangelogRelease(changelog, '3.3.0', '2026-10-23', noFallback);
    assert.equal(
      rewritten,
      [
        '# Changelog',
        '',
        '## Unreleased',
        '',
        '## 3.3.0 — 2026-10-23',
        '',
        '**A hand-written headline.** Its details.',
        '',
        '### Fixed',
        '- **A fix.** Details.',
        '',
        '## 3.2.0 — 2026-10-16',
        '',
        '**Older.** Not checked, even if it breaks the rule:',
        '- not bold',
        '',
      ].join('\n'),
    );
    assert.equal(notes, '**A hand-written headline.** Its details.\n\n### Fixed\n- **A fix.** Details.');
  });

  test('the notes of the rewritten file are the section the release was built from', () => {
    const { changelog: rewritten, notes } = createChangelogRelease(changelog, '3.3.0', '2026-10-23', noFallback);
    assert.equal(getReleaseNotes(rewritten, '3.3.0'), notes);
  });

  test('an empty Unreleased is filled with bold feat / fix subjects', () => {
    const fallback = getChangelogFallback([
      createCommit('feat(limits): a switch board for accounts'),
      createCommit('fix: a restart lost the wait.'),
      createCommit('docs: ignored'),
      createCommit('chore(release): 3.2.1'),
      createCommit('fix(x): with **stars** inside'),
    ]);
    const { changelog: rewritten, notes } = createChangelogRelease('# Changelog\n\n## Unreleased\n\n## 3.2.0 — 2026-10-16\n\nOlder.\n', '3.3.0', '2026-10-23', fallback);
    assert.equal(
      notes,
      [
        '### Added',
        '- **A switch board for accounts.**',
        '',
        '### Fixed',
        '- **A restart lost the wait.**',
        '- **With stars inside.**',
      ].join('\n'),
    );
    assert.match(rewritten, /## Unreleased\n\n## 3\.3\.0 — 2026-10-23\n\n### Added/);
    assert.equal(getChangelogFormatViolations(notes).length, 0);
  });

  test('an empty Unreleased with nothing to list gets a single bold maintenance line', () => {
    const { notes } = createChangelogRelease('## Unreleased\n\n## 3.2.0 — x\n', '3.2.1', '2026-10-23', noFallback);
    assert.equal(notes, '**No user-visible changes in this release.**');
  });

  test('Unreleased as the last section keeps one trailing newline', () => {
    const { changelog: rewritten } = createChangelogRelease('# Changelog\n\n## Unreleased\n\n**Only.** Entry.\n\n\n', '3.3.0', '2026-10-23', noFallback);
    assert.equal(rewritten, '# Changelog\n\n## Unreleased\n\n## 3.3.0 — 2026-10-23\n\n**Only.** Entry.\n');
  });

  test('a missing Unreleased heading fails the run', () => {
    assert.throws(() => createChangelogRelease('# Changelog\n\n## 3.2.0 — x\n', '3.3.0', '2026-10-23', noFallback), (error: Error) => {
      assert.ok(error instanceof ReleaseError);
      assert.match(error.message, /no "## Unreleased" heading/);
      return true;
    });
  });

  test('a version that already has a section fails the run', () => {
    assert.throws(() => createChangelogRelease(changelog, '3.2.0', '2026-10-23', noFallback), /already has a section for 3\.2\.0/);
  });

  test('an entry without a bold first sentence fails the run, quoting the line', () => {
    const broken = '## Unreleased\n\n**Fine.** Entry.\n\n### Fixed\n- Not bold at all, and long enough to quote\n  with a second line.\n';
    assert.throws(() => createChangelogRelease(broken, '3.3.0', '2026-10-23', noFallback), (error: Error) => {
      assert.ok(error instanceof ReleaseError);
      assert.ok(error.message.includes('- Not bold at all, and long enough to quote'));
      assert.ok(!error.message.includes('Fine.'));
      return true;
    });
  });

  test('violations: paragraphs and top-level bullets in any ### subsection; wrapped lines and sub-bullets are not entries', () => {
    const section = [
      '**Ok paragraph.** Wrapped',
      'onto a second line.',
      '',
      'Plain paragraph.',
      '',
      '### Added',
      '- **Ok bullet.** Text',
      '  - sub-bullet is part of the entry',
      '- plain bullet',
      '',
      '### Upgrading',
      '- **Ok.** x',
      '* starred plain',
    ].join('\n');
    assert.deepEqual(getChangelogFormatViolations(section), ['Plain paragraph.', '- plain bullet', '* starred plain']);
  });

  test('the Unreleased body is returned with its blank edges trimmed; null without the heading', () => {
    assert.equal(getUnreleasedSection(changelog), '**A hand-written headline.** Its details.\n\n### Fixed\n- **A fix.** Details.');
    assert.equal(getUnreleasedSection('# Changelog\n\n## Unreleased\n\n## 3.2.0 — x\n'), '');
    assert.equal(getUnreleasedSection('# Changelog\n\n## 3.2.0 — x\n'), null);
  });

  test('release notes: the body of the version section, null when missing or empty', () => {
    const text = '# Changelog\n\n## Unreleased\n\n## 3.3.0 — 2026-10-23\n\n**One.** Two.\n\n## 3.2.0 — x\n\n## 3.1.0 — y\n\n**Old.**\n';
    assert.equal(getReleaseNotes(text, '3.3.0'), '**One.** Two.');
    assert.equal(getReleaseNotes(text, '3.2.0'), null);
    assert.equal(getReleaseNotes(text, '9.9.9'), null);
    assert.equal(getReleaseNotes(text, '3.3'), null);
  });
});

describe('the pack check', () => {
  const goodFiles = [...requiredPackFiles, 'dist/bot.js', 'dist/bot.d.ts', 'SETUP.md', 'examples/docker-compose.yml', '.env.example'];

  function createListing(paths: string[], version = '3.3.0'): PackListing {
    return { version, files: paths.map((path) => ({ path })) };
  }

  test('a sound package has no violations', () => {
    assert.deepEqual(getPackViolations(createListing(goodFiles), '3.3.0'), []);
  });

  test('every missing required file is named', () => {
    const paths = goodFiles.filter((path) => path !== 'CHANGELOG.md' && path !== 'stt/gigaam_sidecar.py');
    assert.deepEqual(getPackViolations(createListing(paths), '3.3.0'), [
      'missing from the package: stt/gigaam_sidecar.py',
      'missing from the package: CHANGELOG.md',
    ]);
  });

  test('sources, tests and the release tooling must not ship', () => {
    const paths = [...goodFiles, 'src/bot.ts', 'dist/__tests__/bot.test.js', 'dist/release/cli.js'];
    assert.deepEqual(getPackViolations(createListing(paths), '3.3.0'), [
      'must not ship: src/bot.ts',
      'must not ship: dist/__tests__/bot.test.js',
      'must not ship: dist/release/cli.js',
    ]);
  });

  test('the packed version must be the new one', () => {
    assert.deepEqual(getPackViolations(createListing(goodFiles, '3.2.0'), '3.3.0'), ['the package version is 3.2.0, expected 3.3.0']);
  });
});

describe('getInvalidBinPaths', () => {
  test('bin targets without a leading "./" are fine, in the object and the string form', () => {
    assert.deepEqual(getInvalidBinPaths({ charness: 'dist/cli.js', telegramcode: 'dist/cli.js' }), []);
    assert.deepEqual(getInvalidBinPaths('dist/cli.js'), []);
    assert.deepEqual(getInvalidBinPaths(undefined), []);
  });

  test('every "./"-prefixed target is named by its command', () => {
    assert.deepEqual(getInvalidBinPaths({ charness: './dist/cli.js', telegramcode: 'dist/cli.js', telegramCode: './dist/cli.js' }), [
      'bin.charness: ./dist/cli.js',
      'bin.telegramCode: ./dist/cli.js',
    ]);
    assert.deepEqual(getInvalidBinPaths('./dist/cli.js'), ['bin: ./dist/cli.js']);
  });
});

describe('getPublishDryRunProblems', () => {
  /** What npm 11.10 printed for a package whose bin was written "./dist/cli.js" (exit 0, a warning only). */
  const droppedBinOutput = [
    'npm warn publish npm auto-corrected some errors in your package.json when publishing.  Please run "npm pkg fix" to address these errors.',
    'npm warn publish errors corrected:',
    'npm warn publish "bin[probe]" script name dist/cli.js was invalid and removed',
    'npm notice',
    'npm notice 📦  probe@1.0.0',
    '+ probe@1.0.0',
  ].join('\n');

  test('a dry run that dropped a field is named line by line', () => {
    assert.deepEqual(getPublishDryRunProblems(droppedBinOutput), [
      'npm warn publish npm auto-corrected some errors in your package.json when publishing.  Please run "npm pkg fix" to address these errors.',
      'npm warn publish "bin[probe]" script name dist/cli.js was invalid and removed',
    ]);
  });

  test('a clean dry run (notices only) has no problems', () => {
    assert.deepEqual(getPublishDryRunProblems(['npm notice', 'npm notice 📦  probe@1.0.0', '+ probe@1.0.0'].join('\n')), []);
  });
});
