/**
 * @description `runnerUtility/execEnv.ts`: the clean environment of a command that runs over the link — nothing of the utility's own
 * environment leaks in, the PATH carries the runner's tools, the operator's `env` file wins, and a malformed line is reported by its
 * number and never by its text (a value may be a secret).
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildExecEnv, findAndroidSdk, parseEnvFile } from '../runnerUtility/execEnv';
import { getRunnerHomePaths } from '../runnerUtility/runnerHome';

const paths = getRunnerHomePaths('/home/runner');

// The cases that need a real tool are skipped through the `skip` option, decided when the file is read: `context.skip()` called in the body only MARKS the case and the body goes on (it ran `nvm use undefined` on a CI
// image that has nvm but no installed Node, and failed «not ok … # SKIP»).
const npmBesideNode = path.join(path.dirname(process.execPath), 'npm');
const realNpmSkip = fs.existsSync(npmBesideNode) ? false : 'no npm beside the Node that runs the tests';
const nvmDir = process.env.NVM_DIR ?? path.join(os.homedir(), '.nvm');
const nvmNodeVersionsDir = path.join(nvmDir, 'versions', 'node');
const installedNvmNodeVersions = fs.existsSync(nvmNodeVersionsDir) ? fs.readdirSync(nvmNodeVersionsDir) : [];
const realNvmSkip = fs.existsSync(path.join(nvmDir, 'nvm.sh')) && installedNvmNodeVersions.length > 0 ? false : 'no nvm with an installed Node here';

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
    assert.equal(dirs[1], '/home/runner/.charness-runner/npm/bin', 'the bin of the jobs\' own npm prefix, before the Node\'s folder');
    assert.equal(dirs[2], '/usr/local/bin');
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

  it('sends what a job installs into the runner\'s state folder — `npm i -g` and Corepack\'s downloads — never into the Node\'s own (root-owned) folder', () => {
    const env = buildExecEnv({ ...base, nodeDir: '/usr/local/lib/charness-runner/node/v22.23.4/bin' });
    assert.equal(env.NPM_CONFIG_PREFIX, '/home/runner/.charness-runner/npm');
    assert.equal(env.COREPACK_HOME, '/home/runner/.charness-runner/corepack');
    assert.deepEqual(Object.keys(env).filter((name) => /^(NPM|COREPACK)_/.test(name)).sort(), ['COREPACK_HOME', 'NPM_CONFIG_PREFIX']);
  });

  it('lets the operator\'s own lines change them', () => {
    const env = buildExecEnv({ ...base, operatorEnv: { NPM_CONFIG_PREFIX: '/elsewhere', COREPACK_HOME: '/cache' } });
    assert.equal(env.NPM_CONFIG_PREFIX, '/elsewhere');
    assert.equal(env.COREPACK_HOME, '/cache');
  });

  it('an EMPTY line (`NPM_CONFIG_PREFIX=`) takes the variable away from the job instead of leaving it set to nothing — and an empty value of any other variable stays as the operator wrote it', () => {
    const { values } = parseEnvFile('NPM_CONFIG_PREFIX=\nCOREPACK_HOME=""\nKEEP_EMPTY=\n');
    const env = buildExecEnv({ ...base, operatorEnv: values });
    assert.equal('NPM_CONFIG_PREFIX' in env, false);
    assert.equal('COREPACK_HOME' in env, false);
    assert.equal(env.KEEP_EMPTY, '');
    assert.equal('NPM_CONFIG_PREFIX' in buildExecEnv(base), true, 'while the operator says nothing, it is set');
  });

  it('with the REAL npm: a job gets the runner\'s own global prefix by default, and — with the empty line — npm\'s own default again', { skip: realNpmSkip }, () => {
    const nodeDir = path.dirname(process.execPath);
    const npm = npmBesideNode;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'env-npm-'));
    try {
      const homePaths = getRunnerHomePaths(home);
      const readPrefix = (operatorEnv: Record<string, string>): string => spawnSync(npm, ['config', 'get', 'prefix'], {
        encoding: 'utf8',
        env: { ...buildExecEnv({ paths: homePaths, accountName: 'runner', environment: {}, nodeDir, operatorEnv, androidSdk: null }), HOME: home },
      }).stdout.trim();
      assert.equal(readPrefix({}), homePaths.npmPrefix);
      assert.equal(readPrefix(parseEnvFile('NPM_CONFIG_PREFIX=\n').values), path.dirname(nodeDir), 'the prefix of the Node\'s own install');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('with the REAL nvm: `nvm use` refuses while NPM_CONFIG_PREFIX is set (the default job environment) and works once the operator\'s empty line took it away', { skip: realNvmSkip }, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'env-nvm-'));
    try {
      const homePaths = getRunnerHomePaths(home);
      const nvmUse = (operatorEnv: Record<string, string>): { status: number | null; output: string } => {
        const result = spawnSync('bash', ['-c', `. "${nvmDir}/nvm.sh" >/dev/null 2>&1; nvm use ${installedNvmNodeVersions[0]} 2>&1`], {
          encoding: 'utf8',
          env: { ...buildExecEnv({ paths: homePaths, accountName: 'runner', environment: {}, nodeDir: '/usr/bin', operatorEnv, androidSdk: null }), HOME: home, NVM_DIR: nvmDir },
        });
        return { status: result.status, output: result.stdout };
      };
      const byDefault = nvmUse({});
      assert.notEqual(byDefault.status, 0, byDefault.output);
      assert.match(byDefault.output, /nvm is not compatible with the "NPM_CONFIG_PREFIX" environment variable/);
      const withEmptyLine = nvmUse(parseEnvFile('NPM_CONFIG_PREFIX=\n').values);
      assert.equal(withEmptyLine.status, 0, withEmptyLine.output);
      assert.match(withEmptyLine.output, /Now using node/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('falls back to a UTF-8 locale', () => {
    assert.equal(buildExecEnv(base).LANG, 'en_US.UTF-8');
  });
});
