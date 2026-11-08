/**
 * @description `remoteRun/projectConfig.ts`: the `.remote-run` file — every key, comments, repeated list keys, and an error that
 * names the line for an unknown key, a missing value, a bad pattern or a repeated single-value key (all of them reported, not the first).
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyProjectConfig, parseProjectConfig } from '../remoteRun/projectConfig';

describe('parseProjectConfig', () => {
  it('an empty file is the empty config', () => {
    assert.deepEqual(parseProjectConfig('\n  \n# only a comment\n'), { ok: true, config: createEmptyProjectConfig() });
  });

  it('reads every key', () => {
    const parsed = parseProjectConfig([
      'pull: e2e/artifacts test-results',
      'install: yarn install --immutable          # replaces the detected command',
      'install-key: yarn.lock package.json patches .yarnrc.yml',
      'exclude: fixtures/huge',
      'send: .env.test',
      'clean-after-success: ios/build/Intermediates.noindex projects/*/ios/build/**/Intermediates.noindex',
    ].join('\n'));
    assert.deepEqual(parsed, {
      ok: true,
      config: {
        pull: ['e2e/artifacts', 'test-results'],
        install: 'yarn install --immutable',
        installKey: ['yarn.lock', 'package.json', 'patches', '.yarnrc.yml'],
        exclude: ['fixtures/huge'],
        send: ['.env.test'],
        cleanAfterSuccess: ['ios/build/Intermediates.noindex', 'projects/*/ios/build/**/Intermediates.noindex'],
      },
    });
  });

  it('`clean-after-success` is off unless given, accumulates over lines like the other list keys, and is not mixed up with `pull`', () => {
    assert.deepEqual(createEmptyProjectConfig().cleanAfterSuccess, []);
    const parsed = parseProjectConfig('pull: results\nclean-after-success: a/b\nclean-after-success: c *.o');
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.ok && parsed.config.cleanAfterSuccess, ['a/b', 'c', '*.o']);
    assert.deepEqual(parsed.ok && parsed.config.pull, ['results']);
  });

  it('`clean-after-success` stays inside the copy and never names the whole project: `..`, absolute and `~` paths, and patterns made of wildcards alone, are refused with the line', () => {
    for (const pattern of ['../outside', '/abs/path', '~/x', 'a/../b', '**', '*', '**/*', '?', './**', '.*']) {
      const parsed = parseProjectConfig(`clean-after-success: ${pattern}`);
      assert.equal(parsed.ok, false, pattern);
      assert.match(parsed.ok ? '' : parsed.errors.join('\n'), /^\.remote-run line 1: "clean-after-success" pattern /, pattern);
    }
    const wholeProject = parseProjectConfig('clean-after-success: **');
    assert.match(wholeProject.ok ? '' : wholeProject.errors.join('\n'), /names the whole project/);
    for (const pattern of ['ios/build', '**/Intermediates.noindex', '*.o', 'a*', 'build/**']) {
      assert.equal(parseProjectConfig(`clean-after-success: ${pattern}`).ok, true, pattern);
    }
  });

  it('`clean-after-success` never goes into the repository or the dependencies: a pattern with `.git`, `node_modules` or `Pods` in its path is refused — their step does not put them back — while a name that merely contains one is fine', () => {
    for (const pattern of ['.git/hooks', 'a/.git/objects', '.git', 'node_modules/pkg/build', '**/node_modules', 'ios/Pods', 'Pods/**', './node_modules/x/']) {
      const parsed = parseProjectConfig(`clean-after-success: ${pattern}`);
      assert.equal(parsed.ok, false, pattern);
      assert.match(parsed.ok ? '' : parsed.errors.join('\n'), /^\.remote-run line 1: "clean-after-success" pattern names a path in "(\.git|node_modules|Pods)", which is never cleaned/, pattern);
    }
    for (const pattern of ['.github/workflows', 'ios/build/Pods.build', 'my_node_modules', 'gitignored/.gitkeep', '**/Intermediates.noindex']) {
      assert.equal(parseProjectConfig(`clean-after-success: ${pattern}`).ok, true, pattern);
    }
    assert.equal(parseProjectConfig('pull: node_modules/.cache').ok, true, 'and the other keys are not restricted by this');
  });

  it('the other list keys keep taking a wildcard-only pattern (`pull: **` is the whole tree on purpose)', () => {
    assert.equal(parseProjectConfig('pull: **').ok, true);
  });

  it('list keys may repeat and accumulate; `install: none` is kept as the word', () => {
    const parsed = parseProjectConfig('pull: a\npull: b c\nexclude: x\nexclude: y\ninstall: none');
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.ok && parsed.config.pull, ['a', 'b', 'c']);
    assert.deepEqual(parsed.ok && parsed.config.exclude, ['x', 'y']);
    assert.equal(parsed.ok && parsed.config.install, 'none');
  });

  it('a # starts a comment at the line start or after whitespace, not inside a word', () => {
    const parsed = parseProjectConfig('# top\npull: a#b c # tail\n');
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.ok && parsed.config.pull, ['a#b', 'c']);
  });

  it('CRLF files read like LF files', () => {
    const parsed = parseProjectConfig('pull: a\r\nsend: .env.test\r\n');
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.ok && parsed.config.send, ['.env.test']);
  });

  it('every problem is reported with its line number', () => {
    const parsed = parseProjectConfig([
      'pull: ok',
      'colour: red',
      'send:',
      'exclude: ../outside',
      'install: a',
      'install: b',
      'just words',
      'pull: /abs',
    ].join('\n'));
    assert.equal(parsed.ok, false);
    const errors = parsed.ok ? [] : parsed.errors;
    assert.equal(errors.length, 6);
    assert.match(errors[0], /^\.remote-run line 2: unknown key "colour"/);
    assert.match(errors[1], /^\.remote-run line 3: "send" has no value/);
    assert.match(errors[2], /^\.remote-run line 4: "exclude" pattern must stay inside the project/);
    assert.match(errors[3], /^\.remote-run line 6: "install" is given twice/);
    assert.match(errors[4], /^\.remote-run line 7: expected "key: value"/);
    assert.match(errors[5], /^\.remote-run line 8: "pull" pattern must be relative/);
  });
});
