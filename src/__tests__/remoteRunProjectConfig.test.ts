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
    ].join('\n'));
    assert.deepEqual(parsed, {
      ok: true,
      config: {
        pull: ['e2e/artifacts', 'test-results'],
        install: 'yarn install --immutable',
        installKey: ['yarn.lock', 'package.json', 'patches', '.yarnrc.yml'],
        exclude: ['fixtures/huge'],
        send: ['.env.test'],
      },
    });
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
