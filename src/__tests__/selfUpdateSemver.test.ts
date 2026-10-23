/**
 * @description Coverage for `src/selfUpdate/semver.ts` — the small semver the update decisions rest on: parsing, ordering
 * (a prerelease below its release) and the `engines.node` range forms. An unreadable range is "unknown", never "no".
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { checkIsPrerelease, checkSatisfiesRange, compareSemVer, compareVersionTexts, parseSemVer } from '../selfUpdate/semver';

function satisfies(version: string, range: string): boolean | null {
  const parsed = parseSemVer(version);
  assert.ok(parsed, `${version} must parse`);
  return checkSatisfiesRange(parsed, range);
}

test('parses plain, v-prefixed, prerelease and build versions; refuses anything else', () => {
  assert.deepEqual(parseSemVer('3.4.0'), { major: 3, minor: 4, patch: 0, prerelease: [] });
  assert.deepEqual(parseSemVer('v3.4.0'), { major: 3, minor: 4, patch: 0, prerelease: [] });
  assert.deepEqual(parseSemVer('3.5.0-beta.1+build.7'), { major: 3, minor: 5, patch: 0, prerelease: ['beta', '1'] });
  assert.equal(parseSemVer('3.4'), null);
  assert.equal(parseSemVer('latest'), null);
  assert.equal(parseSemVer(''), null);
  assert.equal(checkIsPrerelease(parseSemVer('3.5.0-rc.1') ?? { major: 0, minor: 0, patch: 0, prerelease: [] }), true);
  assert.equal(checkIsPrerelease(parseSemVer('3.5.0') ?? { major: 0, minor: 0, patch: 0, prerelease: ['x'] }), false);
});

test('orders by major, minor, patch; a prerelease sorts below its release and its identifiers compare as semver says', () => {
  assert.equal(compareVersionTexts('3.4.0', '3.4.0'), 0);
  assert.equal(compareVersionTexts('3.4.1', '3.4.0'), 1);
  assert.equal(compareVersionTexts('3.10.0', '3.9.0'), 1);
  assert.equal(compareVersionTexts('4.0.0', '3.99.99'), 1);
  assert.equal(compareVersionTexts('3.4.0-rc.1', '3.4.0'), -1);
  assert.equal(compareVersionTexts('3.4.0-rc.2', '3.4.0-rc.10'), -1);
  assert.equal(compareVersionTexts('3.4.0-alpha', '3.4.0-alpha.1'), -1);
  assert.equal(compareVersionTexts('3.4.0-1', '3.4.0-alpha'), -1);
  assert.equal(compareVersionTexts('3.4', '3.4.0'), null);
  const left = parseSemVer('1.0.0');
  const right = parseSemVer('1.0.1');
  assert.ok(left && right);
  assert.equal(compareSemVer(left, right), -1);
});

test('engines.node forms: comparators, ranges, caret, tilde, x-ranges and ||', () => {
  assert.equal(satisfies('22.12.0', '>=22.12'), true);
  assert.equal(satisfies('22.11.9', '>=22.12'), false);
  assert.equal(satisfies('22.12.0', '>=22.12.0 <25'), true);
  assert.equal(satisfies('25.0.0', '>=22.12.0 <25'), false);
  assert.equal(satisfies('22.12.0', '>= 22.12 < 25'), true);
  assert.equal(satisfies('20.17.0', '^20.17 || >=22.9'), true);
  assert.equal(satisfies('21.0.0', '^20.17 || >=22.9'), false);
  assert.equal(satisfies('22.9.0', '^20.17 || >=22.9'), true);
  assert.equal(satisfies('22.5.1', '22.x'), true);
  assert.equal(satisfies('23.0.0', '22.x'), false);
  assert.equal(satisfies('22.5.9', '~22.5.1'), true);
  assert.equal(satisfies('22.6.0', '~22.5.1'), false);
  assert.equal(satisfies('0.2.9', '^0.2.3'), true);
  assert.equal(satisfies('0.3.0', '^0.2.3'), false);
  assert.equal(satisfies('0.0.4', '^0.0.3'), false);
  assert.equal(satisfies('22.0.0', '22.0.0'), true);
  assert.equal(satisfies('22.0.1', '22.0.0'), false);
  assert.equal(satisfies('22.0.1', '>22.0.0'), true);
  assert.equal(satisfies('22.0.0', '<=22.0.0'), true);
  assert.equal(satisfies('22.0.0', '*'), true);
  assert.equal(satisfies('22.0.0', ''), true);
});

test('a range that cannot be read is unknown (null), not a refusal', () => {
  assert.equal(satisfies('22.0.0', 'lts/*'), null);
  assert.equal(satisfies('22.0.0', '>=22 banana'), null);
  assert.equal(satisfies('22.0.0', '>=23 || banana'), null);
  assert.equal(satisfies('22.0.0', '>=22 || banana'), true);
});
