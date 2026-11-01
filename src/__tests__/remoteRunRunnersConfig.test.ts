/**
 * @description `remoteRun/runnersConfig.ts`: the hand-made `~/.config/charness/runners.json` — strict validation that names the
 * field and echoes no value, the location (per OS user, beside the global env file, whatever `ENV_FILE` says), the stamp-cached loader
 * and the "is any runner listed" question the bot MCP asks.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { checkIsRemoteRunOffered } from '../remoteRun/runnersCatalog';
import { formatGroupLimits, getRunnersConfigPath, loadRunnersConfig, resetRunnersConfigCache } from '../remoteRun/runnersConfig';

const validRunner = { name: 'box1', ssh: 'runner@runner.example', workDir: '/home/runner/charness-runner' };

let homeDir = '';

function writeRunnersFile(content: object | string): void {
  const filePath = getRunnersConfigPath(homeDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, typeof content === 'string' ? content : JSON.stringify(content));
}

describe('runners.json', () => {
  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runners-config-'));
    resetRunnersConfigCache();
  });
  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it('lives beside the user\'s global env file, whatever ENV_FILE says', () => {
    const previousEnvFile = process.env.ENV_FILE;
    process.env.ENV_FILE = '/somewhere/else/.env';
    try {
      assert.equal(getRunnersConfigPath(homeDir), path.join(homeDir, '.config', 'charness', 'runners.json'));
    } finally {
      if (previousEnvFile === undefined) delete process.env.ENV_FILE;
      else process.env.ENV_FILE = previousEnvFile;
    }
  });

  it('a missing file is "no runners" and nothing is offered', () => {
    const load = loadRunnersConfig(homeDir);
    assert.equal(load.status, 'missing');
    assert.deepEqual(load.config?.runners, []);
    assert.equal(checkIsRemoteRunOffered(homeDir), false);
  });

  it('a valid file is read with every optional part, and offers remote-run', () => {
    writeRunnersFile({ runners: [{ ...validRunner, sshOptions: ['-p', '2222'], pueue: { bin: '/x/pueue', config: '/x/pueue.yml' }, groups: { default: 2, emulator: 1 } }] });
    const load = loadRunnersConfig(homeDir);
    assert.equal(load.status, 'ok');
    assert.deepEqual(load.config?.runners[0].groups, { default: 2, emulator: 1 });
    assert.equal(checkIsRemoteRunOffered(homeDir), true);
    assert.equal(formatGroupLimits(load.config?.runners[0].groups), 'default=2,emulator=1');
    assert.equal(formatGroupLimits(undefined), '');
  });

  it('an empty list offers nothing', () => {
    writeRunnersFile({ runners: [] });
    assert.equal(checkIsRemoteRunOffered(homeDir), false);
  });

  it('a change of the file is picked up by the next call (stamp-cached, not frozen)', () => {
    writeRunnersFile({ runners: [] });
    assert.equal(checkIsRemoteRunOffered(homeDir), false);
    writeRunnersFile({ runners: [validRunner, { ...validRunner, name: 'box2' }] });
    assert.equal(checkIsRemoteRunOffered(homeDir), true);
  });

  it('errors name the field and never echo a value', () => {
    const secretLooking = 'sk-live-0123456789';
    writeRunnersFile({ runners: [{ ...validRunner, name: 'Bad Name', ssh: `-oProxyCommand=${secretLooking}`, workDir: 'relative/dir', groups: { 'bad group': 0 }, extra: secretLooking }] });
    const load = loadRunnersConfig(homeDir);
    assert.equal(load.status, 'invalid');
    const text = load.status === 'invalid' ? load.errors.join('\n') : '';
    assert.match(text, /runners\.json runners\.0\.name:/);
    assert.match(text, /runners\.json runners\.0\.ssh: must be an ssh destination/);
    assert.match(text, /runners\.json runners\.0\.workDir:/);
    assert.match(text, /runners\.json runners\.0\.groups/);
    assert.ok(!text.includes(secretLooking), 'no value of the file appears in the errors');
  });

  it('duplicate names, unknown top-level keys and a non-object file are errors', () => {
    writeRunnersFile({ runners: [validRunner, validRunner] });
    const duplicates = loadRunnersConfig(homeDir);
    assert.equal(duplicates.status, 'invalid');
    assert.match(duplicates.status === 'invalid' ? duplicates.errors.join('') : '', /unique/);
    writeRunnersFile({ runners: [], other: 1 });
    assert.equal(loadRunnersConfig(homeDir).status, 'invalid');
    writeRunnersFile('[]');
    assert.equal(loadRunnersConfig(homeDir).status, 'invalid');
    writeRunnersFile('{not json');
    assert.equal(loadRunnersConfig(homeDir).status, 'invalid');
  });

  it('an invalid edit after a good one keeps the last good runners offered (the file is the operator\'s, a typo must not blind the agents)', () => {
    writeRunnersFile({ runners: [validRunner] });
    assert.equal(checkIsRemoteRunOffered(homeDir), true);
    writeRunnersFile('{oops');
    assert.equal(loadRunnersConfig(homeDir).status, 'invalid');
    assert.equal(checkIsRemoteRunOffered(homeDir), true);
  });
});
