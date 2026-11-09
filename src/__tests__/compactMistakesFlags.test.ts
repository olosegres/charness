/**
 * @description Coverage for the flag files that carry `/compact_mistakes` into the compactions the bot does not issue (the
 * Claude `PreCompact` hook and the OpenCode plugin read them inside the agent's process): where they live, which session
 * ids may name one, that the flag follows the setting both ways and that a sync touches only the sessions it was given.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  applyCompactMistakesOffFlag,
  checkIsFlagSessionId,
  getClaudeCompactMistakesOffDir,
  getCompactMistakesFlagDirs,
  getOpenCodeCompactMistakesOffDir,
  openCodeCompactMistakesOffDirName,
  syncCompactMistakesFlags,
} from '../utils/compactMistakesFlags';

function withTempDir(run: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-mistakes-flags-'));
  try {
    run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('flag folders: Claude\'s sit in DATA_DIR, OpenCode\'s beside its plugin folder — where the plugin finds them from its own location', () => {
  assert.equal(getClaudeCompactMistakesOffDir('/data/x'), '/data/x/compact-mistakes-off');
  assert.equal(getOpenCodeCompactMistakesOffDir('/cfg/opencode/plugins'), `/cfg/opencode/${openCodeCompactMistakesOffDirName}`);
  assert.deepEqual(getCompactMistakesFlagDirs('/data/x', '/cfg/opencode/plugins'), {
    claudeOffDir: '/data/x/compact-mistakes-off',
    openCodeOffDir: `/cfg/opencode/${openCodeCompactMistakesOffDirName}`,
  });
});

test('checkIsFlagSessionId: the ids of both backends fit, anything that could leave the folder or run in a shell does not', () => {
  for (const id of ['4f0c1c1e-8a2b-4c53-9d0e-5b6f7a8b9c0d', 'ses_2a1b3c4d5e6fAbCdEf', 'a', 'A-b_9']) assert.equal(checkIsFlagSessionId(id), true, id);
  for (const id of ['', '..', '../x', 'a/b', 'a b', 'a.b', '$(x)', 'a;b', 'x'.repeat(129)]) assert.equal(checkIsFlagSessionId(id), false, JSON.stringify(id));
});

test('applyCompactMistakesOffFlag: the flag exists exactly while the setting is OFF, and the calls are idempotent', () => {
  withTempDir((dir) => {
    const flagDir = path.join(dir, 'flags');
    const flagPath = path.join(flagDir, 'ses_1');
    applyCompactMistakesOffFlag(flagDir, 'ses_1', true);
    assert.equal(fs.existsSync(flagPath), false, 'ON with no flag: nothing is created, not even the folder');
    assert.equal(fs.existsSync(flagDir), false);

    applyCompactMistakesOffFlag(flagDir, 'ses_1', false);
    applyCompactMistakesOffFlag(flagDir, 'ses_1', false);
    assert.equal(fs.readFileSync(flagPath, 'utf8'), '', 'OFF: an empty flag file');

    applyCompactMistakesOffFlag(flagDir, 'ses_1', true);
    applyCompactMistakesOffFlag(flagDir, 'ses_1', true);
    assert.equal(fs.existsSync(flagPath), false, 'ON again: the flag is gone');
  });
});

test('applyCompactMistakesOffFlag: an id that cannot name a flag writes nothing, and a failing disk is logged instead of thrown', () => {
  withTempDir((dir) => {
    const flagDir = path.join(dir, 'flags');
    applyCompactMistakesOffFlag(flagDir, '../escape', false);
    assert.equal(fs.existsSync(path.join(dir, 'escape')), false);
    assert.equal(fs.existsSync(flagDir), false);

    const blocker = path.join(dir, 'file');
    fs.writeFileSync(blocker, '');
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      applyCompactMistakesOffFlag(path.join(blocker, 'flags'), 'ses_1', false);
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warnings.length, 1, 'the failure is reported once');
    assert.match(String(warnings[0][0]), /compact-mistakes/);
  });
});

test('syncCompactMistakesFlags: each backend\'s id goes into its own folder, and only the sessions it was given are touched', () => {
  withTempDir((dir) => {
    const dirs = { claudeOffDir: path.join(dir, 'claude'), openCodeOffDir: path.join(dir, 'opencode') };
    // A flag of a session this instance does not know — the OpenCode folder is shared by every instance of the account.
    fs.mkdirSync(dirs.openCodeOffDir, { recursive: true });
    fs.writeFileSync(path.join(dirs.openCodeOffDir, 'ses_foreign'), '');

    syncCompactMistakesFlags([
      { claudeSessionId: 'claude-off', opencodeSessionId: 'ses_off', isEnabled: false },
      { claudeSessionId: 'claude-on', opencodeSessionId: null, isEnabled: true },
      { claudeSessionId: null, opencodeSessionId: null, isEnabled: false },
    ], dirs);
    assert.deepEqual(fs.readdirSync(dirs.claudeOffDir), ['claude-off']);
    assert.deepEqual(fs.readdirSync(dirs.openCodeOffDir).sort(), ['ses_foreign', 'ses_off']);

    // The setting flips: the flag follows, for the session it names only.
    syncCompactMistakesFlags([
      { claudeSessionId: 'claude-off', opencodeSessionId: 'ses_off', isEnabled: true },
      { claudeSessionId: 'claude-on', opencodeSessionId: null, isEnabled: false },
    ], dirs);
    assert.deepEqual(fs.readdirSync(dirs.claudeOffDir), ['claude-on']);
    assert.deepEqual(fs.readdirSync(dirs.openCodeOffDir), ['ses_foreign']);
  });
});
