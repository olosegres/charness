/**
 * @description Coverage for the flag files that carry `/compact_self_review` into the compactions the bot does not issue (the
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
  applyCompactSelfReviewOffFlag,
  checkIsFlagSessionId,
  getClaudeCompactSelfReviewOffDir,
  getCompactSelfReviewFlagDirs,
  getOpenCodeCompactSelfReviewOffDir,
  openCodeCompactSelfReviewOffDirName,
  pruneStaleClaudeCompactSelfReviewFlags,
  syncCompactSelfReviewFlags,
} from '../utils/compactSelfReviewFlags';

function withTempDir(run: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-self-review-flags-'));
  try {
    run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('flag folders: Claude\'s sit in DATA_DIR, OpenCode\'s beside its plugin folder — where the plugin finds them from its own location', () => {
  assert.equal(getClaudeCompactSelfReviewOffDir('/data/x'), '/data/x/compact-self-review-off');
  assert.equal(getOpenCodeCompactSelfReviewOffDir('/cfg/opencode/plugins'), `/cfg/opencode/${openCodeCompactSelfReviewOffDirName}`);
  assert.deepEqual(getCompactSelfReviewFlagDirs('/data/x', '/cfg/opencode/plugins'), {
    claudeOffDir: '/data/x/compact-self-review-off',
    openCodeOffDir: `/cfg/opencode/${openCodeCompactSelfReviewOffDirName}`,
  });
});

test('checkIsFlagSessionId: the ids of both backends fit, anything that could leave the folder or run in a shell does not', () => {
  for (const id of ['4f0c1c1e-8a2b-4c53-9d0e-5b6f7a8b9c0d', 'ses_2a1b3c4d5e6fAbCdEf', 'a', 'A-b_9']) assert.equal(checkIsFlagSessionId(id), true, id);
  for (const id of ['', '..', '../x', 'a/b', 'a b', 'a.b', '$(x)', 'a;b', 'x'.repeat(129)]) assert.equal(checkIsFlagSessionId(id), false, JSON.stringify(id));
});

test('applyCompactSelfReviewOffFlag: the flag exists exactly while the setting is OFF, and the calls are idempotent', () => {
  withTempDir((dir) => {
    const flagDir = path.join(dir, 'flags');
    const flagPath = path.join(flagDir, 'ses_1');
    applyCompactSelfReviewOffFlag(flagDir, 'ses_1', true);
    assert.equal(fs.existsSync(flagPath), false, 'ON with no flag: nothing is created, not even the folder');
    assert.equal(fs.existsSync(flagDir), false);

    applyCompactSelfReviewOffFlag(flagDir, 'ses_1', false);
    applyCompactSelfReviewOffFlag(flagDir, 'ses_1', false);
    assert.equal(fs.readFileSync(flagPath, 'utf8'), '', 'OFF: an empty flag file');

    applyCompactSelfReviewOffFlag(flagDir, 'ses_1', true);
    applyCompactSelfReviewOffFlag(flagDir, 'ses_1', true);
    assert.equal(fs.existsSync(flagPath), false, 'ON again: the flag is gone');
  });
});

test('applyCompactSelfReviewOffFlag: an id that cannot name a flag writes nothing, and a failing disk is logged instead of thrown', () => {
  withTempDir((dir) => {
    const flagDir = path.join(dir, 'flags');
    applyCompactSelfReviewOffFlag(flagDir, '../escape', false);
    assert.equal(fs.existsSync(path.join(dir, 'escape')), false);
    assert.equal(fs.existsSync(flagDir), false);

    const blocker = path.join(dir, 'file');
    fs.writeFileSync(blocker, '');
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      applyCompactSelfReviewOffFlag(path.join(blocker, 'flags'), 'ses_1', false);
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warnings.length, 1, 'the failure is reported once');
    assert.match(String(warnings[0][0]), /compact-self-review/);
  });
});

test('syncCompactSelfReviewFlags: each backend\'s ids — a parked one among them — go into its own folder, and only the sessions it was given are touched', () => {
  withTempDir((dir) => {
    const dirs = { claudeOffDir: path.join(dir, 'claude'), openCodeOffDir: path.join(dir, 'opencode') };
    // A flag of a session this instance does not know — the OpenCode folder is shared by every instance of the account.
    fs.mkdirSync(dirs.openCodeOffDir, { recursive: true });
    fs.writeFileSync(path.join(dirs.openCodeOffDir, 'ses_foreign'), '');

    syncCompactSelfReviewFlags([
      { claudeSessionIds: ['claude-off', 'claude-off-parked'], opencodeSessionIds: ['ses_off'], isEnabled: false },
      { claudeSessionIds: ['claude-on'], opencodeSessionIds: [], isEnabled: true },
      { claudeSessionIds: [], opencodeSessionIds: [], isEnabled: false },
    ], dirs);
    assert.deepEqual(fs.readdirSync(dirs.claudeOffDir).sort(), ['claude-off', 'claude-off-parked']);
    assert.deepEqual(fs.readdirSync(dirs.openCodeOffDir).sort(), ['ses_foreign', 'ses_off']);

    // The setting flips: the flag follows, for the sessions it names only.
    syncCompactSelfReviewFlags([
      { claudeSessionIds: ['claude-off', 'claude-off-parked'], opencodeSessionIds: ['ses_off'], isEnabled: true },
      { claudeSessionIds: ['claude-on'], opencodeSessionIds: [], isEnabled: false },
    ], dirs);
    assert.deepEqual(fs.readdirSync(dirs.claudeOffDir), ['claude-on']);
    assert.deepEqual(fs.readdirSync(dirs.openCodeOffDir), ['ses_foreign']);
  });
});

test('pruneStaleClaudeCompactSelfReviewFlags: a flag no OFF topic owns any more is removed — current and parked ids of an OFF topic stay, nothing that is not a session flag goes', () => {
  withTempDir((dir) => {
    const claudeOffDir = path.join(dir, 'claude');
    fs.mkdirSync(path.join(claudeOffDir, 'a-folder'), { recursive: true });
    for (const name of ['owned-current', 'owned-parked', 'left-by-new', 'topic-is-on-again', 'not.an.id']) fs.writeFileSync(path.join(claudeOffDir, name), '');

    pruneStaleClaudeCompactSelfReviewFlags([
      { claudeSessionIds: ['owned-current', 'owned-parked'], opencodeSessionIds: ['ses_x'], isEnabled: false },
      { claudeSessionIds: ['topic-is-on-again'], opencodeSessionIds: [], isEnabled: true },
    ], claudeOffDir);

    assert.deepEqual(fs.readdirSync(claudeOffDir).sort(), ['a-folder', 'not.an.id', 'owned-current', 'owned-parked'], 'the id a topic left and the one of a topic that is ON again are gone');
  });
});

test('pruneStaleClaudeCompactSelfReviewFlags: a missing folder is nothing to do (silently), an unreadable one is logged instead of thrown', () => {
  withTempDir((dir) => {
    pruneStaleClaudeCompactSelfReviewFlags([], path.join(dir, 'never-made'));
    assert.equal(fs.existsSync(path.join(dir, 'never-made')), false, 'and it is not created');
    const blocker = path.join(dir, 'file');
    fs.writeFileSync(blocker, '');
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      pruneStaleClaudeCompactSelfReviewFlags([], path.join(blocker, 'flags'));
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warnings.length, 1, 'a folder that cannot be read is reported once');
    assert.match(String(warnings[0][0]), /compact-self-review/);
  });
});
