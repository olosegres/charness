/**
 * @description `remoteRun/pathPatterns.ts`: what a path pattern of `.remote-run` names, as extended regular expressions — and the
 * claim the module exists for, proven with the REAL tools: the main box applies the expressions with `RegExp`, the runner script with
 * `grep -E` / bash `=~` over the same strings, so for every sample here all three must say the same.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { compilePathPattern, compilePathPatterns, createPathMatcher, getPathPatternProblem, getPathPatternSearchRoot, getPathPatternSearchRoots } from '../remoteRun/pathPatterns';

/** [pattern, path, is it named]: the semantics, one line each. */
const samples: Array<[string, string, boolean]> = [
  ['test-results', 'test-results', true],
  ['test-results', 'test-results/a/b.png', true],
  ['test-results', 'sub/test-results/a.png', false],
  ['test-results', 'test-results-old/a.png', false],
  ['e2e/artifacts', 'e2e/artifacts/shot.png', true],
  ['e2e/artifacts', 'e2e/artifact', false],
  ['**/__snapshots__', 'a/b/__snapshots__/x.snap', true],
  ['**/__snapshots__', '__snapshots__/x.snap', true],
  ['**/__snapshots__', 'a/__snapshots__x/y', false],
  ['**/*.snap', 'a/b/c.snap', true],
  ['**/*.snap', 'c.snap', true],
  ['**/*.snap', 'a/c.snapx', false],
  ['*.log', 'build.log', true],
  ['*.log', 'logs/build.log', false],
  ['a/**', 'a/b/c', true],
  ['a/**', 'a', false],
  ['a/**/z', 'a/z', true],
  ['a/**/z', 'a/b/c/z', true],
  ['a/**/z', 'a/b/c/y', false],
  ['file?.txt', 'file1.txt', true],
  ['file?.txt', 'file12.txt', false],
  ['file?.txt', 'file/.txt', false],
  ['dots.in.name', 'dots.in.name', true],
  ['dots.in.name', 'dotsXinXname', false],
  ['paren(1)', 'paren(1)/x', true],
  ['plus+and[brackets]', 'plus+and[brackets]', true],
  ['./leading/dot', 'leading/dot/x', true],
  ['trailing/slash/', 'trailing/slash/x', true],
];

describe('compilePathPattern', () => {
  for (const [pattern, candidate, isNamed] of samples) {
    it(`${pattern} ${isNamed ? 'names' : 'does not name'} ${candidate}`, () => {
      assert.equal(createPathMatcher([pattern])(candidate), isNamed);
    });
  }

  it('no pattern names nothing', () => {
    assert.equal(createPathMatcher([])('anything'), false);
  });

  it('several patterns: any of them names it', () => {
    const matcher = createPathMatcher(['a', 'b/c']);
    assert.deepEqual(['a/x', 'b/c', 'b/d', 'c'].map((candidate) => matcher(candidate)), [true, true, false, false]);
  });

  it('refuses what cannot be a project-relative pattern, with the reason', () => {
    assert.match(getPathPatternProblem('') ?? '', /empty/);
    assert.match(getPathPatternProblem('/etc') ?? '', /relative/);
    assert.match(getPathPatternProblem('~/x') ?? '', /~/);
    assert.match(getPathPatternProblem('a/../b') ?? '', /inside the project/);
    assert.match(getPathPatternProblem('a\nb') ?? '', /control character/);
    assert.match(getPathPatternProblem('.') ?? '', /names no path/);
    assert.match(getPathPatternProblem('./') ?? '', /names no path/);
    assert.match(getPathPatternProblem('//') ?? '', /absolute|names no path/);
    assert.equal(getPathPatternProblem('e2e/artifacts'), null);
    assert.throws(() => compilePathPattern('../x'), /inside the project/);
  });
});

describe('the expressions mean the same to RegExp, grep -E and bash =~', () => {
  it('for every sample all three agree (the runner script applies grep/bash, the main box RegExp)', () => {
    assert.ok(samples.length > 20, 'the walk is not vacuous');
    const disagreements: string[] = [];
    for (const [pattern, candidate, isNamed] of samples) {
      const expression = compilePathPattern(pattern);
      const grep = spawnSync('grep', ['-E', '-e', expression], { input: `${candidate}\n`, env: { ...process.env, LC_ALL: 'C' }, encoding: 'utf8' });
      const bash = spawnSync('bash', ['-c', '[[ $1 =~ $2 ]]', 'bash', candidate, expression], { env: { ...process.env, LC_ALL: 'C' } });
      const viaGrep = grep.status === 0;
      const viaBash = bash.status === 0;
      const viaRegExp = new RegExp(expression).test(candidate);
      if (viaGrep !== isNamed || viaBash !== isNamed || viaRegExp !== isNamed) {
        disagreements.push(`${pattern} vs ${candidate}: expected ${isNamed}, grep ${viaGrep}, bash ${viaBash}, RegExp ${viaRegExp}`);
      }
    }
    assert.deepEqual(disagreements, []);
  });

  it('repeated any-depth parts collapse to one: the same meaning without nested backtracking', () => {
    assert.equal(compilePathPattern('**/**/**/x'), compilePathPattern('**/x'));
    const started = Date.now();
    const hostile = createPathMatcher(['**/**/**/**/**/**/**/**/**/**/needle']);
    assert.equal(hostile(`${'a/'.repeat(60)}not-it`), false);
    assert.ok(Date.now() - started < 1000, 'a pathological pattern does not hang the matcher');
  });

  it('compilePathPatterns keeps the order the runner script reads them in', () => {
    assert.deepEqual(compilePathPatterns(['b', 'a']), [compilePathPattern('b'), compilePathPattern('a')]);
  });
});

describe('the folders a walk for a pattern must start from', () => {
  it('a pattern\'s root is its leading segments without a wildcard; a pattern that starts with one needs the whole tree', () => {
    const roots: Array<[string, string]> = [
      ['e2e/artifacts', 'e2e/artifacts'],
      ['test-results', 'test-results'],
      ['./test-results/', 'test-results'],
      ['test-results/snap.txt', 'test-results/snap.txt'],
      ['test-results/**/*.xml', 'test-results'],
      ['build/*/outputs', 'build'],
      ['a/b?/c', 'a'],
      ['**/__snapshots__', '.'],
      ['*.log', '.'],
      ['**', '.'],
    ];
    for (const [pattern, root] of roots) assert.equal(getPathPatternSearchRoot(pattern), root, pattern);
  });

  it('a walk of the root finds every path the pattern names: each sample the pattern names lies under its root', () => {
    for (const [pattern, samplePath, isNamed] of samples) {
      if (!isNamed) continue;
      const root = getPathPatternSearchRoot(pattern);
      assert.ok(root === '.' || samplePath === root || samplePath.startsWith(`${root}/`), `${samplePath} is named by ${pattern} but is not under ${root}`);
    }
  });

  it('the roots of several patterns: duplicates and roots inside another root are dropped, and one wildcard-first pattern makes it the whole tree', () => {
    assert.deepEqual(getPathPatternSearchRoots(['e2e/artifacts', 'test-results', 'e2e/artifacts/shots', 'test-results/**/*.xml']), ['e2e/artifacts', 'test-results']);
    assert.deepEqual(getPathPatternSearchRoots(['e2e/artifacts', '**/*.snap']), ['.']);
    assert.deepEqual(getPathPatternSearchRoots([]), []);
    assert.deepEqual(getPathPatternSearchRoots(['e2e', 'e2e-old']), ['e2e', 'e2e-old'], 'a root that only starts with the same letters is not inside the other');
  });
});
