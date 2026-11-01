/**
 * @description `runnerUtility/execEnv.ts`: the clean environment of a command that runs over the link — nothing of the utility's own
 * environment leaks in, the PATH carries the runner's tools, the operator's `env` file wins, and a malformed line is reported by its
 * number and never by its text (a value may be a secret).
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildExecEnv, findAndroidSdk, parseEnvFile } from '../runnerUtility/execEnv';
import { getRunnerHomePaths } from '../runnerUtility/runnerHome';

const paths = getRunnerHomePaths('/home/runner');

describe('parseEnvFile', () => {
  it('reads KEY=VALUE lines, skipping blanks and comments, allowing export and one pair of quotes', () => {
    const { values, rejected } = parseEnvFile('# comment\n\nA=1\nexport B = two words \nC="quoted value"\nD=\'single\'\nE=\n');
    assert.deepEqual(values, { A: '1', B: 'two words', C: 'quoted value', D: 'single', E: '' });
    assert.deepEqual(rejected, []);
  });

  it('reports a bad line by its number only', () => {
    const { values, rejected } = parseEnvFile('GOOD=1\nno equals sign here SECRET=hunter2\n=novalue\n1BAD=x\n');
    assert.deepEqual(values, { GOOD: '1' });
    assert.deepEqual(rejected, [2, 3, 4]);
  });

  it('keeps an equals sign inside a value', () => {
    assert.deepEqual(parseEnvFile('URL=https://host.example/?a=b\n').values, { URL: 'https://host.example/?a=b' });
  });
});

describe('findAndroidSdk', () => {
  it('prefers the environment, then the places installers use', () => {
    const exists = (candidate: string): boolean => candidate === '/custom/sdk' || candidate === '/home/runner/Android/Sdk';
    assert.equal(findAndroidSdk('/home/runner', { ANDROID_HOME: '/custom/sdk' }, exists), '/custom/sdk');
    assert.equal(findAndroidSdk('/home/runner', {}, exists), '/home/runner/Android/Sdk');
    assert.equal(findAndroidSdk('/home/runner', {}, () => false), null);
  });
});

describe('buildExecEnv', () => {
  const base = { paths, accountName: 'runner', environment: {}, nodeDir: '/opt/node/bin', operatorEnv: {}, androidSdk: null };

  it('sets the account, a PATH with the runner\'s tools first, and no duplicates', () => {
    const env = buildExecEnv({ ...base, nodeDir: '/usr/local/bin' });
    assert.equal(env.HOME, '/home/runner');
    assert.equal(env.USER, 'runner');
    assert.equal(env.LOGNAME, 'runner');
    const dirs = (env.PATH ?? '').split(':');
    assert.equal(dirs[0], '/home/runner/.charness-runner/bin');
    assert.equal(dirs[1], '/usr/local/bin');
    assert.equal(new Set(dirs).size, dirs.length);
    for (const system of ['/opt/homebrew/bin', '/usr/bin', '/bin']) assert.ok(dirs.includes(system), system);
  });

  it('leaks nothing from the utility\'s own environment except LANG and TMPDIR', () => {
    const env = buildExecEnv({ ...base, environment: { LANG: 'C.UTF-8', TMPDIR: '/var/tmp', SECRET_TOKEN: 'x', SSH_AUTH_SOCK: '/agent', HOME: '/root' } });
    assert.equal(env.LANG, 'C.UTF-8');
    assert.equal(env.TMPDIR, '/var/tmp');
    assert.equal(env.SECRET_TOKEN, undefined);
    assert.equal(env.SSH_AUTH_SOCK, undefined);
    assert.equal(env.HOME, '/home/runner');
  });

  it('adds the Android SDK when there is one, and the operator\'s lines win over everything', () => {
    const env = buildExecEnv({ ...base, androidSdk: '/sdk', operatorEnv: { ANDROID_HOME: '/override', EXTRA: '1', PATH: '/only' } });
    assert.equal(env.ANDROID_SDK_ROOT, '/sdk');
    assert.equal(env.ANDROID_HOME, '/override');
    assert.equal(env.EXTRA, '1');
    assert.equal(env.PATH, '/only');
    assert.equal(buildExecEnv(base).ANDROID_HOME, undefined);
  });

  it('falls back to a UTF-8 locale', () => {
    assert.equal(buildExecEnv(base).LANG, 'en_US.UTF-8');
  });
});
